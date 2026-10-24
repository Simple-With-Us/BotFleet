// Tests for the BotFleet Linux server owner gate.
//
// Run with:  node --test deploy/linux-server/owner-gate.node-test.mjs
// No dependencies, no network, no harness: the integration test stands up a
// fake upstream on an ephemeral port and points the gate at it.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import net from "node:net";

import {
  createOwnerGate,
  gateDecision,
  isLoopbackAddress,
  parseOwnerLogins,
  parseTokenSha256,
  upstreamHeaders,
} from "./owner-gate.mjs";

const OWNER = "owner@example.com";
const PUBLIC_ORIGIN = "https://botfleet-host.tailnet.ts.net:8799";

const ownerSet = () => parseOwnerLogins(OWNER);

// A websocket handshake key, built at runtime: a literal one looks like a
// secret to the scanner and is not one.
const WS_KEY = crypto.randomBytes(16).toString("base64");

// The desktop gate token.  The gate only ever stores the sha256, so the
// test does the same: the token itself is the secret, the hash is what the
// gate is configured with.
const DESKTOP_TOKEN = crypto.randomBytes(32).toString("hex");
const tokenSha256 = crypto.createHash("sha256").update(DESKTOP_TOKEN, "utf8").digest("hex");

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function close(server) {
  if (!server) return;
  // Keep-alive sockets would hold close() open forever, and an upgraded socket
  // is not tracked by the server at all, so this never waits on one.
  if (server.closeAllConnections) server.closeAllConnections();
  try {
    server.close();
  } catch {
    // Already closed.
  }
  // A server handle that is still open must not keep the test process alive.
  if (server.unref) server.unref();
  await Promise.race([
    new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    }),
    sleep(250),
  ]);
}

// ---------------------------------------------------------------------------
// parseOwnerLogins
// ---------------------------------------------------------------------------

test("parseOwnerLogins lowercases, trims and drops blank entries", () => {
  const owners = parseOwnerLogins("  Owner@Example.com , second@example.com ,,  ");
  assert.deepEqual([...owners].sort(), ["owner@example.com", "second@example.com"]);
  assert.equal(owners.size, 2);
});

test("parseOwnerLogins tolerates an empty or missing value", () => {
  assert.equal(parseOwnerLogins("").size, 0);
  assert.equal(parseOwnerLogins("   ").size, 0);
  assert.equal(parseOwnerLogins(undefined).size, 0);
  assert.equal(parseOwnerLogins(null).size, 0);
});

// ---------------------------------------------------------------------------
// isLoopbackAddress
// ---------------------------------------------------------------------------

test("isLoopbackAddress accepts loopback in every spelling", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("127.1.2.3"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::FFFF:127.0.0.1"), true);
});

test("isLoopbackAddress rejects everything else", () => {
  assert.equal(isLoopbackAddress("10.0.0.4"), false);
  assert.equal(isLoopbackAddress("192.168.1.10"), false);
  assert.equal(isLoopbackAddress("100.64.0.7"), false);
  assert.equal(isLoopbackAddress("::ffff:10.0.0.4"), false);
  assert.equal(isLoopbackAddress("fe80::1"), false);
  assert.equal(isLoopbackAddress(""), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

// ---------------------------------------------------------------------------
// gateDecision
// ---------------------------------------------------------------------------

test("gateDecision refuses a caller that is not on loopback", () => {
  const decision = gateDecision({
    remoteAddress: "100.64.0.7",
    headers: { "tailscale-user-login": OWNER },
    owners: ownerSet(),
    publicOrigin: PUBLIC_ORIGIN,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 403);
  assert.match(String(decision.reason), /loopback/i);
});

test("gateDecision requires an owner login", () => {
  const missing = gateDecision({
    remoteAddress: "127.0.0.1",
    headers: {},
    owners: ownerSet(),
    publicOrigin: PUBLIC_ORIGIN,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 403);
  assert.equal(missing.reason, "owner identity required");

  const wrong = gateDecision({
    remoteAddress: "127.0.0.1",
    headers: { "Tailscale-User-Login": "someone-else@example.com" },
    owners: ownerSet(),
    publicOrigin: PUBLIC_ORIGIN,
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.status, 403);
  assert.equal(wrong.reason, "owner identity required");
});

test("gateDecision reads the login header case-insensitively and lowercases the value", () => {
  const decision = gateDecision({
    remoteAddress: "::ffff:127.0.0.1",
    headers: { "TAILSCALE-USER-LOGIN": "Owner@Example.COM" },
    owners: ownerSet(),
    publicOrigin: PUBLIC_ORIGIN,
  });
  assert.equal(decision.ok, true);
});

test("gateDecision accepts the owner with no Origin header", () => {
  const decision = gateDecision({
    remoteAddress: "127.0.0.1",
    headers: { "tailscale-user-login": OWNER },
    owners: ownerSet(),
    publicOrigin: PUBLIC_ORIGIN,
  });
  assert.equal(decision.ok, true);
});

test("gateDecision accepts exactly the configured public origin", () => {
  const allowed = gateDecision({
    remoteAddress: "127.0.0.1",
    headers: { "tailscale-user-login": OWNER, origin: PUBLIC_ORIGIN },
    owners: ownerSet(),
    publicOrigin: PUBLIC_ORIGIN,
  });
  assert.equal(allowed.ok, true);

  const wrong = gateDecision({
    remoteAddress: "127.0.0.1",
    headers: { "tailscale-user-login": OWNER, origin: "https://evil.example.com" },
    owners: ownerSet(),
    publicOrigin: PUBLIC_ORIGIN,
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.status, 403);
  assert.match(String(wrong.reason), /origin/i);
});

test("gateDecision refuses any Origin when no public origin is configured", () => {
  const decision = gateDecision({
    remoteAddress: "127.0.0.1",
    headers: { "tailscale-user-login": OWNER, origin: PUBLIC_ORIGIN },
    owners: ownerSet(),
    publicOrigin: "",
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 403);
  assert.match(String(decision.reason), /origin/i);
});

test("gateDecision refuses a cross-site fetch", () => {
  const decision = gateDecision({
    remoteAddress: "127.0.0.1",
    headers: { "tailscale-user-login": OWNER, "sec-fetch-site": "cross-site" },
    owners: ownerSet(),
    publicOrigin: PUBLIC_ORIGIN,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 403);
  assert.match(String(decision.reason), /cross-site/i);
});

test("gateDecision checks the owner before the origin", () => {
  const decision = gateDecision({
    remoteAddress: "127.0.0.1",
    headers: {
      "tailscale-user-login": "stranger@example.com",
      origin: "https://evil.example.com",
    },
    owners: ownerSet(),
    publicOrigin: PUBLIC_ORIGIN,
  });
  assert.equal(decision.reason, "owner identity required");
});

// ---------------------------------------------------------------------------
// upstreamHeaders
// ---------------------------------------------------------------------------

test("upstreamHeaders rewrites Host to the loopback harness", () => {
  const headers = upstreamHeaders({ host: "botfleet-host.tailnet.ts.net:8799" }, 8799);
  assert.equal(headers.host, "127.0.0.1:8799");
});

test("upstreamHeaders strips every header that could impersonate a browser or an edge", () => {
  const headers = upstreamHeaders(
    {
      host: "botfleet-host.tailnet.ts.net:8799",
      origin: PUBLIC_ORIGIN,
      referer: "https://botfleet-host.tailnet.ts.net:8799/",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "sec-fetch-dest": "empty",
      "tailscale-user-login": OWNER,
      "tailscale-user-name": "owner",
      forwarded: "for=100.64.0.7",
      "x-forwarded-for": "100.64.0.7",
      "x-forwarded-proto": "https",
      "cf-ray": "abc123",
      "cf-connecting-ip": "100.64.0.7",
      "cf-access-authenticated-user-email": OWNER,
      "cdn-loop": "cloudflare",
      connection: "keep-alive",
      "keep-alive": "timeout=5",
      "proxy-connection": "keep-alive",
      te: "trailers",
      trailer: "x-thing",
      "transfer-encoding": "chunked",
      upgrade: "h2c",
      "x-keep-me": "yes",
    },
    8799,
  );

  const banned = [
    "origin",
    "referer",
    "forwarded",
    "cdn-loop",
    "connection",
    "keep-alive",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ];
  for (const key of Object.keys(headers)) {
    assert.equal(key.startsWith("sec-fetch-"), false, `${key} must be stripped`);
    assert.equal(key.startsWith("tailscale-"), false, `${key} must be stripped`);
    assert.equal(key.startsWith("x-forwarded-"), false, `${key} must be stripped`);
    assert.equal(key.startsWith("cf-"), false, `${key} must be stripped`);
    assert.equal(banned.includes(key), false, `${key} must be stripped`);
  }
  assert.equal(headers["x-keep-me"], "yes");
  assert.equal(headers.host, "127.0.0.1:8799");
});

test("upstreamHeaders keeps the websocket handshake headers", () => {
  const headers = upstreamHeaders(
    {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": WS_KEY,
      "sec-websocket-version": "13",
      "sec-fetch-site": "cross-site",
    },
    8799,
    { websocket: true },
  );
  assert.equal(String(headers.connection).toLowerCase(), "upgrade");
  assert.equal(String(headers.upgrade).toLowerCase(), "websocket");
  assert.equal(headers["sec-websocket-key"], WS_KEY);
  assert.equal(headers["sec-websocket-version"], "13");
  assert.equal(headers["sec-fetch-site"], undefined);
  assert.equal(headers.host, "127.0.0.1:8799");
});

// ---------------------------------------------------------------------------
// parseTokenSha256
// ---------------------------------------------------------------------------

test("parseTokenSha256 accepts 64 lowercase hex characters", () => {
  const result = parseTokenSha256(tokenSha256);
  assert.equal(result.ok, true);
  assert.equal(result.sha256, tokenSha256);
});

test("parseTokenSha256 treats an absent value as no token", () => {
  for (const empty of ["", "   ", undefined, null]) {
    const result = parseTokenSha256(empty);
    assert.equal(result.ok, true);
    assert.equal(result.sha256, null);
  }
});

test("parseTokenSha256 refuses a malformed hash", () => {
  for (const bad of [
    "not-a-hash",
    tokenSha256.slice(0, 63),
    `${tokenSha256}0`,
    tokenSha256.toUpperCase(),
    "zz" + tokenSha256.slice(2),
  ]) {
    const result = parseTokenSha256(bad);
    assert.equal(result.ok, false, `${bad} should be refused`);
    assert.equal(Object.prototype.toString.call(result.error), "[object String]");
    assert.ok(result.error.length > 0);
  }
});

// ---------------------------------------------------------------------------
// gateDecision: the desktop gate token
// ---------------------------------------------------------------------------

test("gateDecision accepts the gate token with no login header", () => {
  const decision = gateDecision({
    remoteAddress: "127.0.0.1",
    headers: { "x-botfleet-gate-token": DESKTOP_TOKEN },
    owners: new Set(),
    publicOrigin: PUBLIC_ORIGIN,
    tokenSha256,
  });
  assert.equal(decision.ok, true);
});

test("gateDecision refuses a wrong gate token", () => {
  const decision = gateDecision({
    remoteAddress: "127.0.0.1",
    headers: { "x-botfleet-gate-token": `${DESKTOP_TOKEN.slice(0, -1)}0` },
    owners: new Set(),
    publicOrigin: PUBLIC_ORIGIN,
    tokenSha256,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 403);
  assert.equal(decision.reason, "owner identity required");
});

test("gateDecision refuses a request with no credential at all", () => {
  const decision = gateDecision({
    remoteAddress: "127.0.0.1",
    headers: {},
    owners: new Set(),
    publicOrigin: PUBLIC_ORIGIN,
    tokenSha256,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, "owner identity required");
});

test("gateDecision still refuses a token from a caller that is not on loopback", () => {
  const decision = gateDecision({
    remoteAddress: "100.64.0.7",
    headers: { "x-botfleet-gate-token": DESKTOP_TOKEN },
    owners: new Set(),
    publicOrigin: PUBLIC_ORIGIN,
    tokenSha256,
  });
  assert.equal(decision.ok, false);
  assert.match(String(decision.reason), /loopback/i);
});

test("the origin and cross-site rules still apply to a token request", () => {
  const wrongOrigin = gateDecision({
    remoteAddress: "127.0.0.1",
    headers: { "x-botfleet-gate-token": DESKTOP_TOKEN, origin: "https://evil.example.com" },
    owners: new Set(),
    publicOrigin: PUBLIC_ORIGIN,
    tokenSha256,
  });
  assert.equal(wrongOrigin.ok, false);
  assert.match(String(wrongOrigin.reason), /origin/i);

  const crossSite = gateDecision({
    remoteAddress: "127.0.0.1",
    headers: { "x-botfleet-gate-token": DESKTOP_TOKEN, "sec-fetch-site": "cross-site" },
    owners: new Set(),
    publicOrigin: PUBLIC_ORIGIN,
    tokenSha256,
  });
  assert.equal(crossSite.ok, false);
  assert.match(String(crossSite.reason), /cross-site/i);
});

test("a login on the allowlist still opens the gate when a token is configured", () => {
  const decision = gateDecision({
    remoteAddress: "127.0.0.1",
    headers: { "tailscale-user-login": OWNER },
    owners: ownerSet(),
    publicOrigin: PUBLIC_ORIGIN,
    tokenSha256,
  });
  assert.equal(decision.ok, true);
});

// ---------------------------------------------------------------------------
// upstreamHeaders: the token stops at the gate
// ---------------------------------------------------------------------------

test("upstreamHeaders strips the gate token but keeps the authorization header", () => {
  const headers = upstreamHeaders(
    {
      host: "botfleet-host.tailnet.ts.net:8799",
      "x-botfleet-gate-token": DESKTOP_TOKEN,
      authorization: "Bearer harness-token",
    },
    8799,
  );
  assert.equal(headers["x-botfleet-gate-token"], undefined);
  // The harness has its own bearer tokens, so its header is not ours to drop.
  assert.equal(headers.authorization, "Bearer harness-token");
});

// ---------------------------------------------------------------------------
// Integration: a fake upstream behind the gate
// ---------------------------------------------------------------------------

function createFakeUpstream() {
  const state = { requests: [], headers: [], sockets: [] };

  const upstream = http.createServer((req, res) => {
    state.requests.push(req.url);
    state.headers.push({ ...req.headers });

    if (req.url?.startsWith("/sse")) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      res.write("data: one\n\n");
      setTimeout(() => {
        res.write("data: two\n\n");
        res.end();
      }, 150);
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });

  upstream.on("upgrade", (req, socket) => {
    state.sockets.push(socket);
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        "\r\n",
    );
    socket.on("data", (chunk) => socket.write(chunk));
    socket.on("error", () => {});
  });

  return { upstream, state };
}

function gateRequest({ port, headers = {}, path = "/api/thing" }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers, agent: false },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// A raw upgrade request.  It never hangs: the promise settles on the first
// response bytes, or fails after a deadline.
function rawUpgrade({ port, headers = {}, path = "/ws" }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const seen = { text: "", resolved: false };

    const timer = setTimeout(() => {
      if (seen.resolved) return;
      seen.resolved = true;
      socket.destroy();
      reject(new Error("the upgrade request timed out"));
    }, 5000);

    socket.on("connect", () => {
      const lines = [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`];
      for (const [key, value] of Object.entries(headers)) lines.push(`${key}: ${value}`);
      lines.push(
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${WS_KEY}`,
        "",
        "",
      );
      socket.write(lines.join("\r\n"));
    });

    socket.on("data", (chunk) => {
      seen.text += chunk.toString("latin1");
      if (!seen.resolved && seen.text.includes("\r\n\r\n")) {
        seen.resolved = true;
        clearTimeout(timer);
        resolve({ socket, seen, head: seen.text.slice(0, seen.text.indexOf("\r\n\r\n")) });
      }
    });

    socket.on("error", (err) => {
      if (seen.resolved) return;
      seen.resolved = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  return false;
}

test("integration: the gate forwards the owner, strips identity headers and refuses others", async (t) => {
  const { upstream, state } = createFakeUpstream();
  const upstreamPort = await listen(upstream);

  const gate = createOwnerGate({
    owners: ownerSet(),
    publicOrigin: PUBLIC_ORIGIN,
    harnessPort: upstreamPort,
    harnessHost: "127.0.0.1",
    log: () => {},
  });
  const gatePort = await listen(gate);
  t.after(async () => {
    await close(gate);
    await close(upstream);
  });

  // The owner is forwarded, and the harness sees a loopback Host with every
  // identity header removed.
  const ok = await gateRequest({
    port: gatePort,
    headers: {
      "tailscale-user-login": OWNER,
      origin: PUBLIC_ORIGIN,
      referer: `${PUBLIC_ORIGIN}/`,
      "sec-fetch-site": "same-origin",
      "cf-ray": "abc123",
      "x-forwarded-for": "100.64.0.7",
    },
  });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).ok, true);
  assert.equal(state.requests.length, 1);

  const seen = state.headers[0];
  assert.equal(seen.host, `127.0.0.1:${upstreamPort}`);
  assert.equal(seen["tailscale-user-login"], undefined);
  assert.equal(seen.origin, undefined);
  assert.equal(seen.referer, undefined);
  assert.equal(seen["sec-fetch-site"], undefined);
  assert.equal(seen["cf-ray"], undefined);
  assert.equal(seen["x-forwarded-for"], undefined);

  // A non-owner is refused and never reaches the harness.
  const refused = await gateRequest({
    port: gatePort,
    headers: { "tailscale-user-login": "stranger@example.com" },
  });
  assert.equal(refused.status, 403);
  assert.equal(state.requests.length, 1);

  // A missing login is refused too.
  const anonymous = await gateRequest({ port: gatePort, headers: {} });
  assert.equal(anonymous.status, 403);
  assert.equal(state.requests.length, 1);

  // A wrong origin is refused and never reaches the harness.
  const wrongOrigin = await gateRequest({
    port: gatePort,
    headers: { "tailscale-user-login": OWNER, origin: "https://evil.example.com" },
  });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(state.requests.length, 1);

  // A cross-site fetch is refused.
  const crossSite = await gateRequest({
    port: gatePort,
    headers: { "tailscale-user-login": OWNER, "sec-fetch-site": "cross-site" },
  });
  assert.equal(crossSite.status, 403);
  assert.equal(state.requests.length, 1);

  // The gate health route answers without touching the harness.
  const health = await gateRequest({
    port: gatePort,
    path: "/__gate/health",
    headers: { "tailscale-user-login": OWNER },
  });
  assert.equal(health.status, 200);
  const healthBody = JSON.parse(health.body);
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.gate, "botfleet-owner-gate");
  assert.equal(state.requests.length, 1);

  // The gate health route still needs an owner.
  const healthAnon = await gateRequest({ port: gatePort, path: "/__gate/health", headers: {} });
  assert.equal(healthAnon.status, 403);
  assert.equal(state.requests.length, 1);
});

test("integration: server-sent events stream through the gate incrementally", async (t) => {
  const { upstream } = createFakeUpstream();
  const upstreamPort = await listen(upstream);

  const gate = createOwnerGate({
    owners: ownerSet(),
    publicOrigin: PUBLIC_ORIGIN,
    harnessPort: upstreamPort,
    log: () => {},
  });
  const gatePort = await listen(gate);
  t.after(async () => {
    await close(gate);
    await close(upstream);
  });

  const arrivals = [];
  await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: gatePort,
        path: "/sse",
        headers: { "tailscale-user-login": OWNER, accept: "text/event-stream" },
        agent: false,
      },
      (res) => {
        assert.equal(res.statusCode, 200);
        res.setEncoding("utf8");
        res.on("data", (chunk) => arrivals.push({ at: Date.now(), chunk }));
        res.on("end", resolve);
      },
    );
    req.on("error", reject);
    req.end();
  });

  assert.ok(arrivals.length >= 2, `expected at least two chunks, got ${arrivals.length}`);
  assert.match(arrivals[0].chunk, /data: one/);
  assert.match(arrivals[arrivals.length - 1].chunk, /data: two/);
  // The first event must arrive before the second, not in one buffered blob.
  const gap = arrivals[arrivals.length - 1].at - arrivals[0].at;
  assert.ok(gap >= 100, `expected incremental delivery, chunks arrived ${gap}ms apart`);
});

test("integration: a websocket upgrade reaches the harness for the owner and is refused otherwise", async (t) => {
  const { upstream, state } = createFakeUpstream();
  const upstreamPort = await listen(upstream);

  const gate = createOwnerGate({
    owners: ownerSet(),
    publicOrigin: PUBLIC_ORIGIN,
    harnessPort: upstreamPort,
    log: () => {},
  });
  const gatePort = await listen(gate);

  // The upgraded sockets are not tracked by the server, so they are destroyed
  // before the servers are closed.
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const socket of state.sockets) socket.destroy();
    await sleep(50);
    await close(gate);
    await close(upstream);
  });

  const allowed = await rawUpgrade({
    port: gatePort,
    headers: { "tailscale-user-login": OWNER, origin: PUBLIC_ORIGIN },
  });
  sockets.push(allowed.socket);
  assert.match(allowed.head, /^HTTP\/1\.1 101/);
  assert.match(allowed.head, /Sec-WebSocket-Accept:/i);

  allowed.socket.write("ping-bytes");
  const echoed = await waitFor(() => allowed.seen.text.includes("ping-bytes"));
  assert.equal(echoed, true, "the harness echo must travel back through the gate");

  const refused = await rawUpgrade({
    port: gatePort,
    headers: { "tailscale-user-login": "stranger@example.com" },
  });
  sockets.push(refused.socket);
  assert.match(refused.head, /^HTTP\/1\.1 403/);
});

test("integration: a harness that is down answers 502", async (t) => {
  // Bind and immediately release a port so the upstream is certainly closed.
  const probe = createFakeUpstream().upstream;
  const deadPort = await listen(probe);
  await close(probe);

  const gate = createOwnerGate({
    owners: ownerSet(),
    publicOrigin: PUBLIC_ORIGIN,
    harnessPort: deadPort,
    log: () => {},
  });
  const gatePort = await listen(gate);
  t.after(async () => {
    await close(gate);
  });

  const res = await gateRequest({
    port: gatePort,
    headers: { "tailscale-user-login": OWNER },
  });
  assert.equal(res.status, 502);
  const body = JSON.parse(res.body);
  assert.equal(Object.prototype.toString.call(body.error), "[object String]");
  assert.ok(body.error.length > 0);
});

test("integration: the gate token opens the gate and never reaches the harness", async (t) => {
  const { upstream, state } = createFakeUpstream();
  const upstreamPort = await listen(upstream);

  // No owner logins at all: the token is the only credential.
  const gate = createOwnerGate({
    owners: new Set(),
    publicOrigin: PUBLIC_ORIGIN,
    tokenSha256,
    harnessPort: upstreamPort,
    harnessHost: "127.0.0.1",
    log: () => {},
  });
  const gatePort = await listen(gate);
  t.after(async () => {
    await close(gate);
    await close(upstream);
  });

  // The token alone is enough, with no login header.
  const ok = await gateRequest({
    port: gatePort,
    headers: { "x-botfleet-gate-token": DESKTOP_TOKEN },
  });
  assert.equal(ok.status, 200);
  assert.equal(state.requests.length, 1);

  // The harness never sees the token, and it still sees its own bearer token.
  const seen = state.headers[0];
  assert.equal(seen["x-botfleet-gate-token"], undefined);
  assert.equal(seen.host, `127.0.0.1:${upstreamPort}`);

  // A wrong token is refused and never reaches the harness.
  const refused = await gateRequest({
    port: gatePort,
    headers: { "x-botfleet-gate-token": "not-the-token" },
  });
  assert.equal(refused.status, 403);
  assert.equal(JSON.parse(refused.body).error, "owner identity required");
  assert.equal(state.requests.length, 1);

  // No credential at all is refused too.
  const anonymous = await gateRequest({ port: gatePort, headers: {} });
  assert.equal(anonymous.status, 403);
  assert.equal(state.requests.length, 1);

  // The gate health route answers for a token holder and refuses an outsider.
  const health = await gateRequest({
    port: gatePort,
    path: "/__gate/health",
    headers: { "x-botfleet-gate-token": DESKTOP_TOKEN },
  });
  assert.equal(health.status, 200);
  const healthAnon = await gateRequest({ port: gatePort, path: "/__gate/health", headers: {} });
  assert.equal(healthAnon.status, 403);
  assert.equal(state.requests.length, 1);
});

test("integration: a websocket upgrade carries the gate token too", async (t) => {
  const { upstream } = createFakeUpstream();
  const upstreamPort = await listen(upstream);

  const gate = createOwnerGate({
    owners: new Set(),
    publicOrigin: PUBLIC_ORIGIN,
    tokenSha256,
    harnessPort: upstreamPort,
    harnessHost: "127.0.0.1",
    log: () => {},
  });
  const gatePort = await listen(gate);

  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await sleep(50);
    await close(gate);
    await close(upstream);
  });

  const allowed = await rawUpgrade({
    port: gatePort,
    headers: { "x-botfleet-gate-token": DESKTOP_TOKEN },
  });
  sockets.push(allowed.socket);
  assert.match(allowed.head, /^HTTP\/1\.1 101/);

  const refused = await rawUpgrade({
    port: gatePort,
    headers: { "x-botfleet-gate-token": "not-the-token" },
  });
  sockets.push(refused.socket);
  assert.match(refused.head, /^HTTP\/1\.1 403/);
});
