// Fake of the OpenAI chat-completions wire shape, for driver tests
// (minimax.ts, openai-compat.ts). The HTTP-lane peer of fake-claude-cli.ts:
// instead of a scripted stdio subprocess, this is a real http.createServer
// answering a scripted `POST /v1/chat/completions` (and `GET /v1/models`),
// so a driver test can assert on the exact wire shape — including a
// two-round tool exchange's exact request bodies — without a real
// MiniMax/OpenRouter/Groq key or network access.
//
// Responses are scripted FIFO per endpoint: each request shifts the next
// queued entry. An unscripted request gets a loud 500 rather than hanging,
// so a forgotten `queueCompletion` fails the test instead of timing out.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { freePortBlock } from "./ports.ts";

/** One scripted reply to the next `POST /v1/chat/completions`. */
export type ScriptedCompletion =
  | { kind: "json"; status?: number; body: unknown }
  /** Accept the request, record it, and never answer — the provider that
   *  simply stops talking. A caller's own abort (an interrupt, a room turn's
   *  deadline) is then the only thing that ends it, which is exactly what a
   *  timeout test needs to observe. `close()` destroys any socket still held
   *  this way, so a forgotten hang cannot wedge teardown. */
  | { kind: "hang" }
  /** Send the 200 SSE head, then destroy the socket before a single frame —
   *  the provider that accepts the request, opens a stream and vanishes.
   *  Node's own fetch surfaces this as `TypeError: terminated` with a
   *  `SocketError: other side closed` (`UND_ERR_SOCKET`) cause, which is
   *  the exact shape `isPrematureCloseError` exists to recognise.  A clean
   *  `res.end()` would not do: that is a finished empty stream, not a
   *  premature close. */
  | { kind: "close" }
  | {
      kind: "sse";
      status?: number;
      /** Each entry becomes one `data: <entry>\n\n` frame, in the given
       *  order. Pass the literal string `"[DONE]"` to send the sentinel
       *  frame the OpenAI wire shape terminates a stream with. */
      frames: string[];
      /** Drop the trailing blank-line terminator after the last frame, so a
       *  test can assert the driver still flushes it. A real provider's
       *  final frame — often the one carrying `usage` — can arrive with no
       *  trailing newline right before the connection closes. */
      omitTrailingNewline?: boolean;
    };

export interface RecordedRequest {
  method: string;
  url: string;
  /** Header names lower-cased. `authorization`'s VALUE is never recorded —
   *  only whether one was sent — so a leaked fixture dump can never leak a
   *  key. */
  headers: Record<string, string>;
  /** Parsed JSON when the body was valid JSON, else the raw text. */
  body: unknown;
}

export interface FakeOpenAiServer {
  /** Base URL already ending in `/v1`, matching what a driver's config
   *  normalizes to (e.g. `${url}/chat/completions`). */
  url: string;
  /** Every request received so far, in order. */
  requests: RecordedRequest[];
  /** Queue one scripted reply for the next matching `POST
   *  /v1/chat/completions`. FIFO — call it once per expected round. */
  queueCompletion(response: ScriptedCompletion): void;
  /** Queue one scripted reply for the next `GET /v1/models`. Defaults to a
   *  small fixed catalog when nothing is queued. */
  queueModels(body: unknown): void;
  close(): Promise<void>;
}

const DEFAULT_MODELS_BODY = { data: [{ id: "fake-model", object: "model" }] };

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function recordHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value !== "string") continue;
    const name = key.toLowerCase();
    headers[name] = name === "authorization" ? "[present]" : value;
  }
  return headers;
}

function sendSse(res: ServerResponse, script: Extract<ScriptedCompletion, { kind: "sse" }>): void {
  res.writeHead(script.status ?? 200, { "content-type": "text/event-stream" });
  const frames = script.frames;
  for (let i = 0; i < frames.length; i++) {
    const isLast = i === frames.length - 1;
    const terminator = isLast && script.omitTrailingNewline ? "" : "\n\n";
    res.write(`data: ${frames[i]}${terminator}`);
  }
  res.end();
}

/** Start a scripted OpenAI-compatible endpoint on a free local port. */
export async function startFakeOpenAiServer(): Promise<FakeOpenAiServer> {
  const completionQueue: ScriptedCompletion[] = [];
  const modelsQueue: unknown[] = [];
  const requests: RecordedRequest[] = [];
  const hung = new Set<ServerResponse>();

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "";
      const method = req.method ?? "GET";

      if (method === "GET" && url.startsWith("/v1/models")) {
        requests.push({ method, url, headers: recordHeaders(req), body: undefined });
        const body = modelsQueue.shift() ?? DEFAULT_MODELS_BODY;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }

      if (method === "POST" && url.startsWith("/v1/chat/completions")) {
        const raw = await readRequestBody(req);
        let parsed: unknown = raw;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // keep the raw text — a malformed-body test wants to see it too
        }
        requests.push({ method, url, headers: recordHeaders(req), body: parsed });

        const script = completionQueue.shift();
        if (!script) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "fake-openai-server: no scripted response queued for this request" }));
          return;
        }
        if (script.kind === "json") {
          res.writeHead(script.status ?? 200, { "content-type": "application/json" });
          res.end(JSON.stringify(script.body));
          return;
        }
        if (script.kind === "hang") {
          hung.add(res);
          res.on("close", () => hung.delete(res));
          return;
        }
        if (script.kind === "close") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          // Flush the head so the client has a real 200 in hand, then kill
          // the socket on the next tick with no frame and no terminator.
          res.flushHeaders();
          setImmediate(() => res.destroy());
          return;
        }
        sendSse(res, script);
        return;
      }

      requests.push({ method, url, headers: recordHeaders(req), body: undefined });
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `fake-openai-server: no route for ${method} ${url}` }));
    })().catch((error) => {
      // A thrown error inside the async handler must still answer the
      // socket, or the test hangs on the response instead of failing fast.
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: `fake-openai-server: handler threw: ${String(error)}` }));
    });
  });

  const port = await freePortBlock([0]);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    queueCompletion: (response) => completionQueue.push(response),
    queueModels: (body) => modelsQueue.push(body),
    close: () =>
      new Promise<void>((resolve, reject) => {
        // A hung response is a socket `server.close()` would wait on
        // forever.  Drop those first, then let close() settle normally.
        for (const res of hung) res.destroy();
        hung.clear();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
