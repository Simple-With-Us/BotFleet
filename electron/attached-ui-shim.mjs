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
        headers: { ...req.headers, host: `${harnessHost}:${harnessPort}` },
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
  const upstream = net.connect(harnessPort, harnessHost, () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
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
  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("bad request");
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
  server.on("upgrade", (req, socket, head) => proxyUpgrade(target, req, socket, head));
  server.keepAliveTimeout = 5_000;
  // A preferred port keeps the renderer origin (and its localStorage) stable
  // across launches; 0 is the last resort.
  await listenOnFirstFree(server, host, [...listenPorts, 0]);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
