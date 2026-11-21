import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";

/** The paths the webhook ingress owns: `/hooks/<endpoint>/<secret>` capability
 *  URLs and Zulip outgoing webhooks.  Keep these shapes in step with the
 *  receivers in server/webhook-ingress.ts — a path the ingress would not
 *  recognize is not worth proxying. */
const HOOKS_CAPABILITY_PATH = /^\/hooks\/wh_[A-Za-z0-9_-]+(?:\/[^/]+)?$/;
const ZULIP_OUTGOING_PATH = /^\/zulip\/outgoing\/[A-Z0-9][A-Z0-9_-]{0,47}$/;

/** True for a webhook delivery the named tunnel may carry to the local
 *  webhook ingress.  POST only: the ingress answers 405 to anything else, and
 *  matching here keeps read probes off the tunnel surface entirely. */
export function isTunnelWebhookPath(method: string, path: string): boolean {
  return method === "POST" && (HOOKS_CAPABILITY_PATH.test(path) || ZULIP_OUTGOING_PATH.test(path));
}

export interface TunnelWebhookProxyTarget {
  port: number;
  host?: string;
}

/** Hop-by-hop headers node manages on every response; forwarding the
 *  upstream's copies would double-chunk or pin a dead connection token. */
const SKIPPED_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding"]);

/** Stream one tunneled webhook delivery to the loopback webhook ingress.
 *
 *  The body is piped, never buffered: the ingress enforces its own 1 MB cap
 *  (MAX_WEBHOOK_BODY_BYTES) and still authenticates the capability secret or
 *  route signature, so this proxy adds reachability and nothing else.  The
 *  original query string rides along in `req.url`, and the Cloudflare edge
 *  markers stay on the forwarded headers as provenance. */
export function proxyTunnelWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  target: TunnelWebhookProxyTarget,
): Promise<void> {
  const host = target.host ?? "127.0.0.1";
  return new Promise((resolve) => {
    const upstream = httpRequest(
      {
        host,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `${host}:${target.port}` },
      },
      (up) => {
        const headers: Record<string, number | string | string[]> = {};
        for (const [name, value] of Object.entries(up.headers)) {
          if (value === undefined || SKIPPED_RESPONSE_HEADERS.has(name)) continue;
          headers[name] = value;
        }
        res.writeHead(up.statusCode ?? 502, headers);
        up.pipe(res);
        up.on("end", () => resolve());
        up.on("error", () => {
          res.destroy();
          resolve();
        });
      },
    );
    upstream.on("error", () => {
      // The ingress is down or never came up: answer plainly rather than hang
      // the delivery.  A sender can retry a 502; it cannot fix a silent drop.
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
      }
      res.end(JSON.stringify({ error: "webhook receiver unavailable" }));
      resolve();
    });
    req.on("error", () => {
      upstream.destroy();
      resolve();
    });
    req.pipe(upstream);
  });
}
