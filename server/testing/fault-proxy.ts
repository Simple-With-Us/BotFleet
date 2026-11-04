// An HTTP proxy that loses messages on purpose, for two-process placement
// fixtures (BF-2642).  The faults it models are the ones a lease protocol has
// to survive: a request that never arrives, an acknowledgement lost after the
// far side already acted, a link that drops, and a request delivered twice.
//
// This proves nothing about placement by itself.  It is test tooling, and no
// placement acceptance assertion depends on it.
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/** One request the proxy read in full, whatever became of it. */
export interface ProxiedExchange {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** The status the far side answered, or null when it never received the request. */
  upstreamStatus: number | null;
  /** The fault applied to this exchange, or null when it passed through. */
  fault: "request-dropped" | "response-dropped" | null;
}

export type FaultPhase = "request" | "response";

export interface FaultProxy {
  readonly port: number;
  /** Every request accepted so far, oldest first.  Replays are not listed. */
  exchanges(): readonly ProxiedExchange[];
  /**
   * Lose the next matching message.  `request` never reaches the far side.
   * `response` reaches it and is acted on, and only the answer is lost, which
   * is the dropped acknowledgement.  The client sees its connection close.
   */
  dropNext(phase: FaultPhase, matches?: (exchange: ProxiedExchange) => boolean): void;
  /** Close every open client connection now, leaving the proxy listening. */
  cutConnections(): void;
  /** While refusing, every new connection is closed at once:  the link is down. */
  setRefusing(refusing: boolean): void;
  /** Deliver an accepted request to the far side again, as a retry would. */
  replay(exchange: ProxiedExchange): Promise<{ status: number; body: Buffer }>;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;

/** The whole body, "too-large" past the limit, or "aborted" when the connection went first. */
function readBody(req: IncomingMessage): Promise<Buffer | "too-large" | "aborted"> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    let total = 0;
    req.on("data", (part: Buffer) => {
      total += part.length;
      if (total > MAX_BODY_BYTES) { parts.length = 0; resolve("too-large"); return; }
      parts.push(part);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    // A cut connection fires close with no end, and a promise settles only once.
    req.on("error", () => resolve("aborted"));
    req.on("close", () => resolve("aborted"));
  });
}

export async function startFaultProxy(options: { targetPort: number; targetHost?: string }): Promise<FaultProxy> {
  const targetHost = options.targetHost ?? "127.0.0.1";
  const exchanges: ProxiedExchange[] = [];
  const sockets = new Set<Socket>();
  const armed: { phase: FaultPhase; matches: (exchange: ProxiedExchange) => boolean }[] = [];
  let refusing = false;

  const take = (phase: FaultPhase, exchange: ProxiedExchange): boolean => {
    const index = armed.findIndex((fault) => fault.phase === phase && fault.matches(exchange));
    if (index < 0) return false;
    armed.splice(index, 1);
    return true;
  };

  const forward = (exchange: ProxiedExchange): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> =>
    new Promise((resolve, reject) => {
      const upstream = request(
        {
          host: targetHost, port: options.targetPort, method: exchange.method, path: exchange.path,
          headers: { ...exchange.headers, host: `${targetHost}:${options.targetPort}`, connection: "close" },
          agent: false,
        },
        (res) => {
          const parts: Buffer[] = [];
          let total = 0;
          res.on("data", (part: Buffer) => {
            total += part.length;
            if (total > MAX_BODY_BYTES) { res.destroy(new Error("upstream answer is too large")); return; }
            parts.push(part);
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }));
          res.on("error", reject);
        },
      );
      upstream.on("error", reject);
      upstream.end(exchange.body);
    });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req);
    if (body === "aborted") return;
    if (body === "too-large") { res.writeHead(413, { connection: "close" }).end(); return; }
    const exchange: ProxiedExchange = {
      method: req.method ?? "GET", path: req.url ?? "/", headers: req.headers, body, upstreamStatus: null, fault: null,
    };
    exchanges.push(exchange);
    if (take("request", exchange)) {
      exchange.fault = "request-dropped";
      req.socket.destroy();
      return;
    }
    const answer = await forward(exchange);
    exchange.upstreamStatus = answer.status;
    if (take("response", exchange)) {
      exchange.fault = "response-dropped";
      req.socket.destroy();
      return;
    }
    const { connection: _connection, "transfer-encoding": _encoding, ...headers } = answer.headers;
    res.writeHead(answer.status, headers).end(answer.body);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
  });
  server.on("connection", (socket) => {
    if (refusing) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });

  const cutConnections = (): void => { for (const socket of sockets) socket.destroy(); };
  return {
    // SAFETY: address() on a server listening on TCP is an AddressInfo, never a string or null.
    port: (server.address() as AddressInfo).port,
    exchanges: () => [...exchanges],
    dropNext: (phase, matches = () => true) => { armed.push({ phase, matches }); },
    cutConnections,
    setRefusing: (value) => { refusing = value; },
    replay: async (exchange) => {
      const answer = await forward(exchange);
      return { status: answer.status, body: answer.body };
    },
    close: () => new Promise((resolve) => {
      cutConnections();
      server.close(() => resolve());
    }),
  };
}
