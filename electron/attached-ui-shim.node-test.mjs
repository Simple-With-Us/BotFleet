import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";

import { isApiPath, parseHostAuthority, resolveStaticFile, shimOriginGuard, startUiShim } from "./attached-ui-shim.mjs";

function makeUiDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bf-ui-shim-"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>BotFleet</title>");
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "assets", "app.js"), "console.log('ui')");
  return dir;
}

// A stand-in harness: echoes what it received for /api/*, streams one SSE
// event for /api/events, and answers WebSocket-style upgrades with 101.
function startFakeHarness() {
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    requestCount += 1;
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url === "/api/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ app: "botfleet", pid: 4242, static: false }));
        return;
      }
      if (req.url === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write("event: hello\ndata: {}\n\n");
        // never ends on its own — the client is expected to close
        req.on("close", () => res.destroy());
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "x-upstream": "harness" });
      res.end(JSON.stringify({ method: req.method, url: req.url, host: req.headers.host, body }));
    });
  });
  const upgraded = new Set();
  let upgradeCount = 0;
  server.on("upgrade", (req, socket) => {
    upgradeCount += 1;
    upgraded.add(socket);
    socket.on("close", () => upgraded.delete(socket));
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (chunk) => socket.write(`echo:${chunk}`));
    socket.on("end", () => socket.end());
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        upgradeCount: () => upgradeCount,
        requestCount: () => requestCount,
        close: () =>
          new Promise((r) => {
            for (const socket of upgraded) socket.destroy();
            server.closeAllConnections();
            server.close(() => r());
          }),
      }),
    );
  });
}

test("isApiPath only matches the /api subtree", () => {
  assert.equal(isApiPath("/api"), true);
  assert.equal(isApiPath("/api/health"), true);
  assert.equal(isApiPath("/apiary"), false);
  assert.equal(isApiPath("/"), false);
});

test("resolveStaticFile refuses paths that escape the ui dir", () => {
  const root = path.resolve("/tmp/ui");
  assert.equal(resolveStaticFile(root, "/"), path.join(root, "index.html"));
  assert.equal(resolveStaticFile(root, "/assets/app.js"), path.join(root, "assets", "app.js"));
  assert.equal(resolveStaticFile(root, "/../../etc/passwd"), null);
  assert.equal(resolveStaticFile(root, "/%2e%2e/%2e%2e/etc/passwd"), null);
  assert.equal(resolveStaticFile(root, "/%zz"), null);
});

test("serves the bundled UI and streams /api through to the harness", async () => {
  const harness = await startFakeHarness();
  const uiDir = makeUiDir();
  const shim = await startUiShim({ uiDir, harnessPort: harness.port });
  try {
    const base = `http://127.0.0.1:${shim.port}`;

    const malformed = await fetch(`${base}//`);
    assert.equal(malformed.status, 400);
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type"), /text\/html/);
    assert.match(await index.text(), /BotFleet/);

    const asset = await fetch(`${base}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("content-type"), "text/javascript");

    // SPA fallback for client-side routes
    const route = await fetch(`${base}/rooms/abc`);
    assert.equal(route.status, 200);
    assert.match(await route.text(), /BotFleet/);

    // /api goes to the harness, path and body intact
    const health = await fetch(`${base}/api/health`);
    assert.deepEqual(await health.json(), { app: "botfleet", pid: 4242, static: false });

    const post = await fetch(`${base}/api/rooms?x=1`, { method: "POST", body: '{"hi":1}', headers: { "content-type": "application/json" } });
    assert.equal(post.headers.get("x-upstream"), "harness");
    const echoed = await post.json();
    assert.equal(echoed.method, "POST");
    assert.equal(echoed.url, "/api/rooms?x=1");
    assert.equal(echoed.body, '{"hi":1}');
    assert.equal(echoed.host, `127.0.0.1:${harness.port}`);

    // HEAD on a static file carries the length, no body
    const head = await fetch(`${base}/assets/app.js`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String("console.log('ui')".length));
  } finally {
    await shim.close();
    await harness.close();
  }
});

test("server-sent events reach the client before the stream ends", async () => {
  const harness = await startFakeHarness();
  const shim = await startUiShim({ uiDir: makeUiDir(), harnessPort: harness.port });
  try {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${shim.port}/api/events`, { signal: controller.signal });
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const reader = res.body.getReader();
    const { value } = await reader.read();
    assert.match(Buffer.from(value).toString(), /event: hello/);
    controller.abort();
  } finally {
    await shim.close();
    await harness.close();
  }
});

test("a harness that is gone yields 502, not a hang", async () => {
  const harness = await startFakeHarness();
  const deadPort = harness.port;
  await harness.close();
  const shim = await startUiShim({ uiDir: makeUiDir(), harnessPort: deadPort });
  try {
    const res = await fetch(`http://127.0.0.1:${shim.port}/api/health`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /not reachable/);
    // the UI itself still serves — the renderer can show its own error state
    const index = await fetch(`http://127.0.0.1:${shim.port}/`);
    assert.equal(index.status, 200);
  } finally {
    await shim.close();
  }
});

test("does not retry an idempotent upstream request after its downstream closes", async () => {
  let attempts = 0;
  const harness = http.createServer((req) => {
    attempts += 1;
    setTimeout(() => req.socket.destroy(), 25);
  });
  await new Promise((resolve) => harness.listen(0, "127.0.0.1", resolve));
  const port = harness.address().port;
  const shim = await startUiShim({ uiDir: makeUiDir(), harnessPort: port });
  try {
    const request = http.get(`http://127.0.0.1:${shim.port}/api/slow`);
    request.on("error", () => {});
    // Close the downstream only once the shim has actually opened the
    // upstream request.  Destroying it on a timer right after the socket is
    // assigned races the request flush: on Windows loopback the downstream
    // can be gone before the shim ever sees the request, which fails the
    // assertion with 0 attempts instead of exercising the retry path.
    const deadline = Date.now() + 5_000;
    while (attempts === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(attempts, 1, "shim never opened the upstream request");
    request.destroy();
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(attempts, 1);
  } finally {
    await shim.close();
    await new Promise((resolve) => harness.close(resolve));
  }
});

test("upgrade requests are tunnelled to the harness", async () => {
  const harness = await startFakeHarness();
  const shim = await startUiShim({ uiDir: makeUiDir(), harnessPort: harness.port });
  try {
    const echoed = await new Promise((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port: shim.port,
        path: "/api/ws",
        headers: { connection: "Upgrade", upgrade: "websocket" },
      });
      req.on("upgrade", (res, socket) => {
        assert.equal(res.statusCode, 101);
        socket.once("data", (chunk) => {
          socket.destroy();
          resolve(String(chunk));
        });
        socket.write("ping");
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(echoed, "echo:ping");
  } finally {
    await shim.close();
    await harness.close();
  }
});

test("prefers the first free port from the list and falls back past busy ones", async () => {
  const harness = await startFakeHarness();
  // occupy a port so the shim has to skip it
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  const busy = blocker.address().port;
  const shim = await startUiShim({ uiDir: makeUiDir(), harnessPort: harness.port, listenPorts: [busy] });
  try {
    assert.notEqual(shim.port, busy);
    assert.ok(shim.port > 0);
  } finally {
    await shim.close();
    await harness.close();
    await new Promise((r) => blocker.close(r));
  }
});

// ── S5: the shim's own DNS-rebinding boundary ──────────────────────────────
// A rebound page keeps the attacker's hostname in `Host` and sends its own
// `Origin`, so both must be refused before anything reaches the harness.

function rawRequest({ port, path: requestPath, method = "GET", headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: requestPath, method, headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

// Counts every request that actually reached the harness, so a test can prove
// the shim refused rather than forwarded and got lucky.
function startCountingHarness() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, host: req.headers.host, origin: req.headers.origin ?? null });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ app: "botfleet", secret: "transcript" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        seen,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      }),
    );
  });
}

test("parseHostAuthority splits host and port, and refuses malformed values", () => {
  assert.deepEqual(parseHostAuthority("127.0.0.1:8799"), { hostname: "127.0.0.1", port: 8799 });
  assert.deepEqual(parseHostAuthority("Evil.Example:80"), { hostname: "evil.example", port: 80 });
  assert.deepEqual(parseHostAuthority("[::1]:8799"), { hostname: "[::1]", port: 8799 });
  assert.deepEqual(parseHostAuthority("127.0.0.1"), { hostname: "127.0.0.1", port: null });
  assert.equal(parseHostAuthority("127.0.0.1:notaport"), null);
  assert.equal(parseHostAuthority("[::1]8799"), null);
  assert.equal(parseHostAuthority(""), null);
  assert.equal(parseHostAuthority(undefined), null);
});

test("the guard accepts our own authority and refuses everything else", () => {
  const guard = shimOriginGuard("127.0.0.1", 8799);
  // A same-origin GET carries no Origin; a same-origin POST carries ours.
  assert.equal(guard({ host: "127.0.0.1:8799" }), null);
  assert.equal(guard({ host: "127.0.0.1:8799", origin: "http://127.0.0.1:8799" }), null);
  assert.equal(guard({ host: "evil.example", origin: "http://evil.example" }), "host");
  assert.equal(guard({ host: "127.0.0.1:9999" }), "host");
  assert.equal(guard({}), "host");
  assert.equal(guard({ host: "127.0.0.1:8799", origin: "http://evil.example" }), "origin");
  assert.equal(guard({ host: "127.0.0.1:8799", origin: "null" }), "origin");
  // A wildcard bind still answers the loopback literals the renderer uses.
  const wildcard = shimOriginGuard("0.0.0.0", 8799);
  assert.equal(wildcard({ host: "127.0.0.1:8799" }), null);
  assert.equal(wildcard({ host: "evil.example" }), "host");
});

test("a rebound Host is refused before the transcript is read", async () => {
  const harness = await startCountingHarness();
  const shim = await startUiShim({ uiDir: makeUiDir(), harnessPort: harness.port });
  try {
    // The shape a DNS-rebinding page produces: our port, the attacker's name.
    const res = await rawRequest({
      port: shim.port,
      path: "/api/rooms/abc/messages",
      headers: { host: "evil.example", origin: "http://evil.example" },
    });
    assert.equal(res.status, 403);
    assert.deepEqual(JSON.parse(res.body), { error: "Forbidden" });
    assert.doesNotMatch(res.body, /transcript/);
    assert.deepEqual(harness.seen, [], "the harness must never see a rebound request");

    // The UI bundle is refused too — no same-origin help from a rebind.
    const ui = await rawRequest({ port: shim.port, path: "/", headers: { host: "evil.example" } });
    assert.equal(ui.status, 403);
    assert.doesNotMatch(ui.body, /BotFleet/);

    // Same address, our name: the renderer's own request still proxies.
    const mine = await rawRequest({
      port: shim.port,
      path: "/api/rooms/abc/messages",
      headers: { host: `127.0.0.1:${shim.port}` },
    });
    assert.equal(mine.status, 200);
    assert.equal(JSON.parse(mine.body).secret, "transcript");
    assert.equal(harness.seen.length, 1);
    assert.equal(harness.seen[0].host, `127.0.0.1:${harness.port}`);
  } finally {
    await shim.close();
    await harness.close();
  }
});

test("a foreign Origin is refused, and a same-origin POST is not", async () => {
  const harness = await startCountingHarness();
  const shim = await startUiShim({ uiDir: makeUiDir(), harnessPort: harness.port });
  const host = { host: `127.0.0.1:${shim.port}` };
  try {
    const foreign = await rawRequest({
      port: shim.port,
      method: "POST",
      path: "/api/config",
      headers: { ...host, origin: "http://evil.example", "content-type": "application/json" },
    });
    assert.equal(foreign.status, 403);
    assert.deepEqual(harness.seen, []);

    const own = await rawRequest({
      port: shim.port,
      method: "POST",
      path: "/api/config",
      headers: { ...host, origin: `http://127.0.0.1:${shim.port}`, "content-type": "application/json" },
    });
    assert.equal(own.status, 200);
    assert.equal(harness.seen.length, 1);
    // Upstream it goes as the HARNESS's origin, not the shim's.  The shim
    // only trusts origins on its own port; the harness only trusts origins on
    // the ports it serves UI from, and those are different port sets — so
    // forwarding the renderer's real origin verbatim would have the harness
    // refuse the desktop's own mutating calls.
    assert.equal(harness.seen[0].origin, `http://127.0.0.1:${harness.port}`);
    assert.equal(harness.seen[0].host, `127.0.0.1:${harness.port}`);
  } finally {
    await shim.close();
    await harness.close();
  }
});

test("a same-origin GET keeps having no Origin, and a shim-origin one is rewritten", async () => {
  const harness = await startCountingHarness();
  const shim = await startUiShim({ uiDir: makeUiDir(), harnessPort: harness.port });
  const host = { host: `127.0.0.1:${shim.port}` };
  try {
    const bare = await rawRequest({ port: shim.port, method: "GET", path: "/api/events", headers: { ...host } });
    assert.equal(bare.status, 200);
    // Inventing an Origin where the browser sent none would make a non-browser
    // caller look like a browser, so it stays absent.
    assert.equal(harness.seen[0].origin, null);

    const fromElsewhere = await rawRequest({
      port: shim.port,
      method: "GET",
      path: "/api/bots",
      headers: { ...host, origin: `http://127.0.0.1:${shim.port}` },
    });
    assert.equal(fromElsewhere.status, 200);
    assert.equal(harness.seen[1].origin, `http://127.0.0.1:${harness.port}`);
  } finally {
    await shim.close();
    await harness.close();
  }
});

test("a rebound WebSocket handshake never reaches the harness", async () => {
  const harness = await startFakeHarness();
  const shim = await startUiShim({ uiDir: makeUiDir(), harnessPort: harness.port });
  try {
    // `Host` is our address here — only `Origin` can tell, so it must be
    // checked or the live stream stays readable.
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port: shim.port,
        path: "/api/ws",
        headers: {
          host: `127.0.0.1:${shim.port}`,
          origin: "http://evil.example",
          connection: "Upgrade",
          upgrade: "websocket",
        },
      });
      req.on("response", resolve);
      req.on("upgrade", () => reject(new Error("a foreign Origin was tunnelled to the harness")));
      req.on("error", reject);
      req.end();
    });
    assert.equal(res.statusCode, 403);
  } finally {
    await shim.close();
    await harness.close();
  }
});
