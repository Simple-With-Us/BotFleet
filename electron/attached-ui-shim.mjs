// UI shim for an ATTACHED harness (harness-ops, 2026-09-02).
//
// When the packaged app joins a BotFleet harness that is already running
// (the always-on launchd job, a dev `pnpm dev:server`) instead of forking its
// own child, that harness usually runs headless: its /api/health reports
// `static: false` because nobody handed it OMB_STATIC_DIR. The window still
// needs the built UI from one origin that also answers `/api/...` — the
// renderer fetches relative paths and opens `EventSource("/api/events")`.
//
// So the app serves its bundled `Resources/ui` here and streams everything
// under /api through to the harness on loopback. This is the same shape the
// dev workflow has always used (vite serves the UI, proxies /api to :8799),
// just without vite. Bodies are piped in both directions as they arrive, so
// server-sent events reach the renderer as the harness emits them, and a
// client that goes away tears down its upstream request so the harness does
// not keep streaming to nobody.

import http from "node:http";
import net from "node:net";
import { createReadStream, promises as fsp } from "node:fs";
import path from "node:path";

export const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

export function isApiPath(pathname) {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * Split a `Host` header (or the host part of a URL) into its hostname and
 * port.  Returns null for anything malformed so a caller can treat the value
 * as "not our host" instead of guessing at it.
 */
export function parseHostAuthority(value) {
  // This function is itself the shim's input boundary, and a rebound page is
  // free to put anything at all in a `Host` header — so `value` is untrusted
  // by contract and no narrower named type would be honest here.  The guard is
  // the decode, and everything after it branches on the decoded string.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  const portDigits = (digits) => (/^\d{1,5}$/.test(digits) ? Number(digits) : null);
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end < 0 || raw[end + 1] !== ":") return null;
    return { hostname: raw.slice(0, end + 1), port: portDigits(raw.slice(end + 2)) };
  }
  const colon = raw.lastIndexOf(":");
  if (colon < 0) return { hostname: raw, port: null };
  // A colon that does not introduce a port is a malformed authority, not a
  // host with a missing port.
  const port = portDigits(raw.slice(colon + 1));
  return port === null ? null : { hostname: raw.slice(0, colon), port };
}

/**
 * The shim's own DNS-rebinding boundary.  It serves exactly one authority —
 * the host it bound and the port it actually got — so a request whose `Host`
 * is anything else came from a page that resolved its own name at us (the
 * attacker's browser sends the attacker's hostname, not ours) and must not
 * reach the UI bundle, the transcript, or the live event stream.
 *
 * `Origin` is checked the same way, and it is the only thing standing between
 * a rebound page and a WebSocket: a rebound page opening `ws://127.0.0.1:8799`
 * sends our address as `Host`, so `Host` alone would wave it through.  A
 * same-origin GET carries no `Origin` at all, and a same-origin POST carries
 * ours, so both legitimate shapes pass.
 *
 * @returns {(headers: { host?: string, origin?: string }) => string | null}
 *   the rejected header ("host" / "origin"), or null when the request is ours.
 */
export function shimOriginGuard(host, port) {
  // A wildcard bind still answers on the loopback literals the renderer uses.
  const hostnames = new Set(host === "0.0.0.0" || host === "::" ? ["127.0.0.1", "[::1]"] : [host]);
  const isOwnAuthority = (authority) =>
    Boolean(authority) && authority.port === port && hostnames.has(authority.hostname);
  return (headers = {}) => {
    if (!isOwnAuthority(parseHostAuthority(headers.host))) return "host";
    const origin = headers.origin;
    if (origin === undefined || origin === null || origin === "") return null;
    let url;
    try {
      url = new URL(origin);
    } catch {
      return "origin";
    }
    if (url.protocol !== "http:" || !isOwnAuthority(parseHostAuthority(url.host))) return "origin";
    return null;
  };
}

/**
 * Map a request path onto a file inside `uiDir`, refusing anything that
 * resolves outside it. Returns null for paths that escape the root.
 */
export function resolveStaticFile(uiDir, pathname) {
  const root = path.resolve(uiDir);
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const target = path.resolve(root, `.${decoded === "/" ? "/index.html" : decoded}`);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

async function serveStatic(uiDir, pathname, req, res) {
  const candidate = resolveStaticFile(uiDir, pathname);
  let file = candidate;
  let stat = null;
  if (file) stat = await fsp.stat(file).catch(() => null);
  if (!stat?.isFile()) {
    // SPA fallback: unknown routes render index.html, like the harness's own
    // static handler does.
    file = path.join(path.resolve(uiDir), "index.html");
    stat = await fsp.stat(file).catch(() => null);
    if (!stat?.isFile()) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `no route: ${req.method} ${pathname}` }));
      return;
    }
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": String(stat.size),
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(file);
  stream.on("error", () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  stream.pipe(res);
}

/**
 * The headers to forward upstream: `Host` and a present `Origin` both become
 * the harness's own authority, so the harness sees a same-origin request from
 * the machine it serves.  Everything else passes through untouched.
 */
export function forwardedHeaders(req, harnessHost, harnessPort) {
  const authority = `${harnessHost}:${harnessPort}`;
  const headers = { ...req.headers, host: authority };
  const origin = req.headers.origin;
  // A multi-valued header arrives from Node as an array, which is not a usable
  // origin, and is dropped here exactly as an absent or empty one is.
  if (!Array.isArray(origin) && origin !== undefined && origin !== "") {
    headers.origin = `http://${authority}`;
  }
  return headers;
}

function proxyHttp({ harnessHost, harnessPort, log }, req, res) {
  let attempts = 0;
  let current = null;
  let retryTimer = null;
  let downstreamClosed = false;
  const idempotent = req.method === "GET" || req.method === "HEAD";
  // The renderer's EventSource closes and reopens; each close must release
  // its upstream stream or the harness leaks one subscriber per reconnect.
  res.on("close", () => {
    downstreamClosed = true;
    if (retryTimer) clearTimeout(retryTimer);
    current?.destroy();
  });
  const send = () => {
    retryTimer = null;
    if (downstreamClosed || res.destroyed || res.writableEnded) return;
    attempts += 1;
    current?.destroy();
    const upstream = http.request(
      {
        host: harnessHost,
        port: harnessPort,
        method: req.method,
        path: req.url,
        // `Host` is rewritten because the harness trusts only its own
        // authority.  `Origin` is rewritten for the same reason and in the
        // same breath: the renderer here is served on THIS shim's port, so
        // its real origin is the shim's, and the harness's origin allowlist
        // is built from the ports it serves UI from — not from the shim's
        // port.  Forwarding ours verbatim would have the harness refuse the
        // desktop's own mutating calls.  The shim guard above has already
        // decided this request is ours, so by the time it reaches the
        // harness it is genuinely same-origin; saying so is the accurate
        // header, not a forged one.  A request that arrived with no `Origin`
        // (a same-origin GET) keeps having none.
        headers: forwardedHeaders(req, harnessHost, harnessPort),
      },
      (ures) => {
        res.writeHead(ures.statusCode ?? 502, ures.headers);
        ures.pipe(res);
      },
    );
    current = upstream;
    upstream.on("error", (error) => {
      if (idempotent && attempts < 2 && !res.headersSent && !downstreamClosed && !res.destroyed) {
        log(`proxy retry :${harnessPort} ${req.method} ${req.url}: ${error?.code ?? error?.message ?? error}`);
        retryTimer = setTimeout(send, 150);
        return;
      }
      if (downstreamClosed || res.destroyed || res.writableEnded) return;
      log(`proxy to harness :${harnessPort} failed for ${req.method} ${req.url}: ${error?.code ?? error?.message ?? error}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `BotFleet harness on port ${harnessPort} is not reachable` }));
    });
    if (idempotent) upstream.end();
    else req.pipe(upstream);
  };
  send();
}

function proxyUpgrade({ harnessHost, harnessPort }, req, socket, head) {
  const authority = `${harnessHost}:${harnessPort}`;
  // Same rewriting as `proxyHttp`, applied to the raw header list this path
  // replays: the browser sends this shim's origin on every upgrade, and the
  // harness only trusts its own ports.
  const rawHeaders = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i].toLowerCase();
    const value = name === "host"
      ? authority
      : name === "origin" && req.rawHeaders[i + 1] !== ""
        ? `http://${authority}`
        : req.rawHeaders[i + 1];
    rawHeaders.push(req.rawHeaders[i], value);
  }
  const upstream = net.connect(harnessPort, harnessHost, () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < rawHeaders.length; i += 2) {
      lines.push(`${rawHeaders[i]}: ${rawHeaders[i + 1]}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  // http servers run allowHalfOpen, so a plain pipe-driven end() would leave
  // the other leg half-open forever (and the harness counting a dead
  // subscriber). When either side goes, take the other down with it.
  upstream.on("error", () => socket.destroy());
  upstream.on("close", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
}

function listenOnFirstFree(server, host, ports) {
  return ports.reduce(
    (chain, port) =>
      chain.catch(async (previous) => {
        if (previous && previous.code !== "EADDRINUSE") throw previous;
        await new Promise((resolve, reject) => {
          const onError = (error) => {
            server.off("listening", onListening);
            reject(error);
          };
          const onListening = () => {
            server.off("error", onError);
            resolve();
          };
          server.once("error", onError);
          server.once("listening", onListening);
          server.listen(port, host);
        });
      }),
    Promise.reject(null),
  );
}

/**
 * @param {{
 *   uiDir: string,
 *   harnessPort: number,
 *   harnessHost?: string,
 *   host?: string,
 *   listenPorts?: number[],
 *   log?: (line: string) => void,
 * }} options
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export async function startUiShim({
  uiDir,
  harnessPort,
  harnessHost = "127.0.0.1",
  host = "127.0.0.1",
  listenPorts = [],
  log = () => {},
}) {
  const target = { harnessHost, harnessPort, log };
  const server = http.createServer();
  server.keepAliveTimeout = 5_000;
  // A preferred port keeps the renderer origin (and its localStorage) stable
  // across launches; 0 is the last resort.
  await listenOnFirstFree(server, host, [...listenPorts, 0]);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  // Only now is the served authority known: the check is against the port the
  // shim really got, not the one it asked for.  The listeners attach after
  // that so no request can be answered before the guard exists.
  const guard = shimOriginGuard(host, port);

  server.on("request", (req, res) => {
    const rejected = guard(req.headers);
    if (rejected) {
      // A name that resolves at us is a rebound page reading transcripts.
      // Say nothing about what is behind here.
      log(`rejected ${req.method} ${req.url}: untrusted ${rejected}`);
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }
    // A malformed request-target is the caller's error, not ours: parsing it
    // unguarded raised inside the request handler and took the whole shim
    // down.  Answer 400 and keep serving.
    let pathname;
    try {
      pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Bad request" }));
      return;
    }
    if (!isApiPath(pathname) && (req.method === "GET" || req.method === "HEAD")) {
      serveStatic(uiDir, pathname, req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
      return;
    }
    proxyHttp(target, req, res);
  });
  server.on("upgrade", (req, socket, head) => {
    const rejected = guard(req.headers);
    if (rejected) {
      // The browser sends the attacker's `Origin` on every WebSocket
      // handshake, so the event stream stays theirs-free here too.
      log(`rejected upgrade ${req.url}: untrusted ${rejected}`);
      socket.end("HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\nconnection: close\r\n\r\nForbidden");
      return;
    }
    proxyUpgrade(target, req, socket, head);
  });
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
