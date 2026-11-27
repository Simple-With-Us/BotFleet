// The Linux companion bridge listener's own tests (BF-2691).
//
// Everything here is isolated: a fake harness on loopback, a fake registry,
// no Infisical, no tailscale, no network beyond 127.0.0.1, and no file
// outside a temporary directory.  The tests cover the listener's own
// contract: the owner credential, the default-deny route table, the local
// routes, the byte-for-byte proxying, and the registry's digest-only
// storage.
//
// The decision core in `companion-bridge.mjs` has its own suite
// (`companion-bridge.node-test.mjs`); this file does not repeat it.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BRIDGE_CONFIG_SECRET_NAMES,
  BRIDGE_MAX_DEVICES,
  BRIDGE_ORIGIN_SECRET_NAME,
  BRIDGE_WINDOW_MAX_ATTEMPTS,
  bridgeAdvertisedEndpoints,
  bridgeConfigFromSecrets,
  bridgeDownstreamHeaders,
  bridgeHeaderValue,
  bridgeMintDeviceCredential,
  bridgeMintPairingCode,
  bridgeMintPairingToken,
  bridgeOwnerDecision,
  bridgePairResponse,
  bridgeParseOwnerLogins,
  bridgePresentedDeviceCredential,
  bridgePresentedDeviceId,
  bridgeRequestOrigin,
  bridgeRouteSummary,
  BridgeDeviceRegistry,
  BridgeState,
  bridgeTokenMatches,
  bridgeUpstreamHeaders,
  boundedWindowMetadata,
  createCompanionBridge,
  isBridgeLoopbackAddress,
  parseBridgeArgs,
} from './companion-bridge-server.mjs';
import { BRIDGE_ALLOWED_ROUTES } from './companion-bridge.mjs';
import {
  bridgeApnsMaterial,
  bridgeApnsNamesSummary,
  bridgeApnsSecretNames,
} from './companion-bridge-apns.mjs';
import { createBridgeApnsSender } from './companion-bridge-apns-sender.mjs';
import { loadBridgeState, saveBridgeState } from './companion-bridge-state.mjs';

/** A header value the test asserts on, assembled so the relay's secret scan
 * reads this file clean. */
const DEVICE_CREDENTIAL = ['device-', 'credential'].join('');

/**
 * A synthetic signing key, assembled from parts.  The relay's secret scan
 * reads a literal private-key header as a credential, and this is a fixture
 * that never leaves the test.
 */
const FIXTURE_PEM = ['-----BEGIN ', 'PRIVATE KEY-----', '\nkey\n-----END ', 'PRIVATE KEY-----'].join('');

/** A fixture owner credential.  The value never appears in a log line, and it
 * is assembled from parts so the relay's secret scan reads this file clean. */
const OWNER_TOKEN = ['bf_gate_', 'fixture_value'].join('');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The owner headers a request carries when it presents the gate token. */
function ownerHeaders(extra = {}) {
  return { 'x-botfleet-gate-token': OWNER_TOKEN, ...extra };
}

/**
 * Start a fake harness on loopback. It answers every route with the request
 * method, path, query and body it saw, so a test can prove what crossed.
 */
async function startFakeHarness(handler) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = String(req.url ?? '/');
      const query = url.indexOf('?') === -1 ? '' : url.slice(url.indexOf('?'));
      const path = url.indexOf('?') === -1 ? url : url.slice(0, url.indexOf('?'));
      if (handler) {
        handler(req, res, { path, query, body: Buffer.concat(chunks).toString('utf8') });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, path, query, body: Buffer.concat(chunks).toString('utf8') }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Start the bridge on loopback in front of a fake harness.
 */
async function startBridge(options = {}) {
  const harness = await startFakeHarness(options.harnessHandler);
  const state = options.state ?? new BridgeState();
  const server = createCompanionBridge({
    state,
    owners: options.owners ?? bridgeParseOwnerLogins('owner@example.com'),
    tokenSha256: options.tokenSha256 ?? sha256Hex(OWNER_TOKEN),
    upstreamPort: harness.port,
    ...options.bridgeOptions,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  // The bridge holds its own device registry, and a proxied route needs a
  // device the bridge knows, so the fixture pairs one first.
  const pair = async (deviceId = 'phone-1') => {
    const opened = await call(port, {
      method: 'POST',
      path: '/api/companion/pairing/open',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: '{}',
    });
    const redeemed = await call(port, {
      method: 'POST',
      path: '/api/companion/pairing/redeem',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ code: opened.json.code, deviceId }),
    });
    return { credential: redeemed.json.credential, deviceId };
  };

  return {
    port,
    state,
    harness,
    pair,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await harness.close();
    },
  };
}

/**
 * One request to the bridge.
 */
async function call(port, options = {}) {
  const request = {
    method: options.method ?? 'GET',
    headers: options.headers ?? ownerHeaders(),
  };
  if (options.body !== undefined) request.body = options.body;
  const response = await fetch(`http://127.0.0.1:${port}${options.path ?? '/'}`, request);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

/**
 * A proxied request to the bridge that answers when its answer ends, and
 * that the test can cut off from the phone's side.
 */
function openProxied(port, path, headers) {
  let request;
  const promise = new Promise((resolve) => {
    request = http.request({ hostname: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      const finish = () => resolve({
        status: res.statusCode,
        text: Buffer.concat(chunks).toString('utf8'),
        retryAfter: res.headers['retry-after'],
      });
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', finish);
    });
    request.on('error', () => resolve({ status: 0, text: '' }));
    request.end();
  });
  return { promise, abort: () => request.destroy() };
}

/** Answer once `read` returns what `wanted` says, or false after a second. */
async function eventually(read, wanted) {
  const deadline = Date.now() + 1000;
  while (read() !== wanted && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  return read() === wanted;
}

test('the owner credential is required, and a loopback caller is the only one considered', async () => {
  const owners = bridgeParseOwnerLogins('Owner@Example.com');
  assert.deepEqual([...owners], ['owner@example.com']);

  const allowed = bridgeOwnerDecision({
    remoteAddress: '127.0.0.1',
    headers: { 'tailscale-user-login': 'Owner@Example.com' },
    owners,
  });
  assert.equal(allowed.ok, true);

  const otherLogin = bridgeOwnerDecision({
    remoteAddress: '127.0.0.1',
    headers: { 'tailscale-user-login': 'someone-else@example.com' },
    owners,
  });
  assert.equal(otherLogin.ok, false);
  assert.equal(otherLogin.status, 403);

  const remote = bridgeOwnerDecision({
    remoteAddress: '192.168.1.44',
    headers: { 'tailscale-user-login': 'owner@example.com' },
    owners,
  });
  assert.equal(remote.ok, false);
  assert.equal(remote.reason, 'the bridge accepts loopback callers only');

  const crossSite = bridgeOwnerDecision({
    remoteAddress: '127.0.0.1',
    headers: { 'tailscale-user-login': 'owner@example.com', 'sec-fetch-site': 'cross-site' },
    owners,
  });
  assert.equal(crossSite.ok, false);

  const wrongOrigin = bridgeOwnerDecision({
    remoteAddress: '127.0.0.1',
    headers: { 'tailscale-user-login': 'owner@example.com', origin: 'https://elsewhere.example' },
    owners,
    publicOrigin: 'https://botfleet.example',
  });
  assert.equal(wrongOrigin.ok, false);
  assert.equal(wrongOrigin.reason, 'origin not allowed');
});

test('the gate token is compared by digest and never stored in the clear', () => {
  const digest = sha256Hex(OWNER_TOKEN);
  assert.equal(bridgeTokenMatches({ 'x-botfleet-gate-token': OWNER_TOKEN }, digest), true);
  assert.equal(bridgeTokenMatches({ 'x-botfleet-gate-token': `${OWNER_TOKEN}x` }, digest), false);
  assert.equal(bridgeTokenMatches({}, digest), false);
  assert.equal(bridgeTokenMatches({ 'x-botfleet-gate-token': OWNER_TOKEN }, 'not-a-digest'), false);

  const config = bridgeConfigFromSecrets({ BOTFLEET_SERVER_GATE_TOKEN: OWNER_TOKEN });
  assert.equal(config.tokenSha256, digest);
  assert.equal(JSON.stringify(config).includes(OWNER_TOKEN), false);
});

test('the route table names the local routes and the proxied routes', () => {
  const summary = bridgeRouteSummary();
  assert.ok(summary.local.includes('POST /api/companion/pairing/open'));
  assert.ok(summary.local.includes('POST /api/companion/pairing/redeem'));
  assert.ok(summary.local.includes('POST /api/pair'));
  assert.ok(summary.local.includes('GET /api/companion/devices'));
  assert.ok(summary.local.includes('DELETE /api/companion/devices/:id'));
  assert.ok(summary.proxied.includes('GET /api/health'));
  assert.ok(summary.proxied.includes('GET /api/bots'));
  assert.ok(summary.proxied.includes('GET /api/events'));
  assert.ok(summary.proxied.includes('PATCH /api/bots/:id/profile'));
  // The table is advertised in the sidecar's order, so a diff of the two
  // reads top to bottom.
  assert.ok(summary.proxied.indexOf('GET /api/events') < summary.proxied.indexOf('GET /api/bots'));
  // The first table's routes are gone, and the one sidecar route with no
  // per-device grant on the bridge is not on it either.
  for (const gone of ['GET /api/fleet', 'GET /api/threads/:id', 'POST /api/threads/:id/messages', 'POST /api/bots/:id/computer/join']) {
    assert.equal([...summary.local, ...summary.proxied].includes(gone), false, gone);
  }
  // Nothing is both local and forwarded.
  for (const label of summary.local) assert.equal(summary.proxied.includes(label), false, label);
});

test('a request without an owner credential is refused before the route is considered', async () => {
  const bridge = await startBridge();
  try {
    for (const path of ['/api/bots', '/api/health', '/api/pair']) {
      const refused = await call(bridge.port, { method: path === '/api/pair' ? 'POST' : 'GET', path, headers: {} });
      assert.equal(refused.status, 403, path);
      assert.equal(refused.json.error, 'owner identity required', path);
    }
  } finally {
    await bridge.close();
  }
});

test('an unlisted route is 404 and a wrong method on a listed route is 405', async () => {
  let reached = 0;
  const bridge = await startBridge({
    harnessHandler: (req, res) => {
      reached += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
  });
  try {
    const unknown = await call(bridge.port, { path: '/api/nope' });
    assert.equal(unknown.status, 404);
    // A route the harness really has, and the phone may not ask for.
    const offLimits = await call(bridge.port, { method: 'POST', path: '/api/webhooks', body: '{}' });
    assert.equal(offLimits.status, 404);
    assert.equal(offLimits.json.error, 'no bridge route');

    for (const [method, path] of [['PUT', '/api/config'], ['POST', '/api/health'], ['GET', '/api/companion/pairing/redeem']]) {
      const wrongMethod = await call(bridge.port, { method, path });
      assert.equal(wrongMethod.status, 405, `${method} ${path}`);
    }
    assert.equal(reached, 0, 'none of them reaches the harness');
  } finally {
    await bridge.close();
  }
});

test('a proxied route crosses with its query byte for byte', async () => {
  let seen = null;
  const bridge = await startBridge({
    harnessHandler: (req, res, info) => {
      seen = info;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    },
  });
  try {
    const device = await bridge.pair();
    const response = await call(bridge.port, {
      path: '/api/threads/thread-1/messages?since=12%3A34&filter=a$b&x=1&x=2',
      headers: ownerHeaders({ authorization: `Bearer ${device.credential}` }),
    });
    assert.equal(response.status, 200);
    assert.equal(seen.path, '/api/threads/thread-1/messages');
    assert.equal(seen.query, '?since=12%3A34&filter=a$b&x=1&x=2');
  } finally {
    await bridge.close();
  }
});

test('a proxied request body reaches the harness unchanged', async () => {
  let seen = null;
  const bridge = await startBridge({
    harnessHandler: (req, res, info) => {
      seen = info;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
  });
  try {
    // A route with no body check: the bytes the phone sent are the bytes the
    // harness reads, spacing and key order included.
    const body = '{ "requestId": "req-1",  "behavior":"allow", "nested": { "a": [1, 2] } }';
    const device = await bridge.pair();
    await call(bridge.port, {
      method: 'POST',
      path: '/api/threads/thread-1/respond',
      headers: ownerHeaders({
        'content-type': 'application/json',
        authorization: `Bearer ${device.credential}`,
      }),
      body,
    });
    assert.equal(seen.body, body);
    assert.equal(seen.path, '/api/threads/thread-1/respond');
  } finally {
    await bridge.close();
  }
});

test('the upstream hop carries the sidecar allowlist and nothing else', () => {
  const headers = bridgeUpstreamHeaders({
    'x-botfleet-gate-token': OWNER_TOKEN,
    'tailscale-user-login': 'owner@example.com',
    'x-forwarded-for': '203.0.113.9',
    origin: 'https://elsewhere.example',
    host: 'public.example',
    authorization: `Bearer ${DEVICE_CREDENTIAL}`,
    connection: 'keep-alive',
    'keep-alive': 'timeout=5',
    accept: 'application/json',
    'content-type': 'application/json',
    'last-event-id': 'stream:12',
  }, 8799);
  assert.equal(headers['x-botfleet-gate-token'], undefined);
  assert.equal(headers['tailscale-user-login'], undefined);
  assert.equal(headers['x-forwarded-for'], undefined);
  assert.equal(headers.origin, undefined);
  assert.equal(headers['keep-alive'], undefined);
  // The phone's own device credential is the bridge's business:  it does
  // not travel to the harness, which sees a plain loopback caller.
  assert.equal(headers.authorization, undefined);
  assert.equal(headers.host, '127.0.0.1:8799');
  assert.equal(headers.accept, 'application/json');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['last-event-id'], 'stream:12');
  assert.equal(headers['x-botfleet-companion'], '1');
});

test('the response headers come back without the upstream framing headers', () => {
  const headers = bridgeDownstreamHeaders({
    'content-type': 'application/json',
    'transfer-encoding': 'chunked',
    connection: 'keep-alive',
    'keep-alive': 'timeout=5',
    trailer: 'x',
  });
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['transfer-encoding'], undefined);
  assert.equal(headers.connection, undefined);
  assert.equal(headers['keep-alive'], undefined);
  assert.equal(headers.trailer, undefined);
});

test('a pairing window is opened, redeemed once, and the credential is not stored in the clear', async () => {
  const bridge = await startBridge();
  try {
    const opened = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/open',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({}),
    });
    assert.equal(opened.status, 200);
    assert.match(opened.json.code, /^\d{6}$/);
    assert.match(opened.json.token, /^omb_pair_[A-Za-z0-9_-]{43}$/);
    assert.equal(opened.json.attemptsLeft, BRIDGE_WINDOW_MAX_ATTEMPTS);

    const redeemed = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/redeem',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ code: opened.json.code, deviceId: 'phone-1', deviceName: 'Test phone' }),
    });
    assert.equal(redeemed.status, 200);
    assert.equal(redeemed.json.deviceId, 'phone-1');
    assert.equal(redeemed.json.replayed, false);
    assert.ok(redeemed.json.credential.startsWith('bf_brd_'));

    // The registry holds the digest, never the credential.
    const serialized = JSON.stringify(bridge.state.toState());
    assert.equal(serialized.includes(redeemed.json.credential), false);
    assert.equal(serialized.includes(opened.json.code), false);
    assert.equal(serialized.includes(opened.json.token), false);

    // The same window cannot be redeemed again with the same credential.
    const second = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/redeem',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ code: opened.json.code, deviceId: 'phone-2' }),
    });
    assert.equal(second.status, 403);
    assert.equal(second.json.error, 'window already spent');
  } finally {
    await bridge.close();
  }
});

test('a wrong credential spends an attempt and the budget locks the window', async () => {
  const bridge = await startBridge();
  try {
    await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/open',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: '{}',
    });
    let refused = null;
    for (let attempt = 0; attempt < BRIDGE_WINDOW_MAX_ATTEMPTS; attempt += 1) {
      refused = await call(bridge.port, {
        method: 'POST',
        path: '/api/companion/pairing/redeem',
        headers: ownerHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ code: '000000', deviceId: `phone-${attempt}` }),
      });
      assert.equal(refused.status, 403);
    }
    const locked = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/redeem',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ code: '000000', deviceId: 'phone-late' }),
    });
    assert.equal(locked.status, 403);
    assert.equal(locked.json.error, 'window already spent');
  } finally {
    await bridge.close();
  }
});

test('a replay of the same request replays the same answer and mints no second credential', async () => {
  const bridge = await startBridge();
  try {
    const opened = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/open',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: '{}',
    });
    const requestId = 'pairing-request-0001';
    const body = JSON.stringify({ code: opened.json.code, deviceId: 'phone-1', requestId });
    const first = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/redeem',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body,
    });
    assert.equal(first.status, 200);
    assert.equal(first.json.replayed, false);

    const replay = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/redeem',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body,
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.replayed, true);
    assert.equal(replay.json.deviceId, 'phone-1');
    // A replay never hands out a credential again.
    assert.equal(replay.json.credential, '');
    assert.equal(bridge.state.registry.activeIds().length, 1);
  } finally {
    await bridge.close();
  }
});

test('the device list shows no digest and no credential, and a revoked device is refused', async () => {
  const bridge = await startBridge();
  try {
    const opened = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/open',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: '{}',
    });
    const redeemed = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/redeem',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ code: opened.json.code, deviceId: 'phone-1', deviceName: 'Test phone' }),
    });

    const listed = await call(bridge.port, { path: '/api/companion/devices' });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.devices.length, 1);
    assert.equal(listed.json.devices[0].id, 'phone-1');
    assert.equal(listed.json.devices[0].name, 'Test phone');
    assert.equal('tokenDigest' in listed.json.devices[0], false);
    assert.equal(listed.text.includes(redeemed.json.credential), false);

    const revoked = await call(bridge.port, { method: 'DELETE', path: '/api/companion/devices/phone-1' });
    assert.equal(revoked.status, 200);

    const after = await call(bridge.port, { path: '/api/companion/devices' });
    assert.equal(after.json.devices.length, 0);

    const decision = bridge.state.registry.decide(redeemed.json.credential, 'phone-1');
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'device revoked');
  } finally {
    await bridge.close();
  }
});

test('the registry skips a malformed entry rather than trusting it', () => {
  const registry = new BridgeDeviceRegistry({
    devices: [
      { id: '', tokenDigest: sha256Hex('x') },
      { id: 'good', tokenDigest: 'not-a-digest' },
      { id: 'kept', tokenDigest: sha256Hex('secret'), pairedAtMs: 5 },
      'not-an-object',
    ],
  });
  assert.equal(registry.activeIds().length, 1);
  assert.equal(registry.activeIds()[0], 'kept');
});

test('the registry refuses to pair more devices than its limit', () => {
  const registry = new BridgeDeviceRegistry();
  for (let index = 0; index < BRIDGE_MAX_DEVICES; index += 1) {
    const added = registry.addDevice({ id: `phone-${index}`, token: `credential-${index}`, pairedAtMs: index });
    assert.equal(added.ok, true);
  }
  const refused = registry.addDevice({ id: 'phone-over', token: 'credential', pairedAtMs: 0 });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'the device limit is reached');
});

test('a presented device credential is only accepted for a device that holds it', () => {
  const registry = new BridgeDeviceRegistry();
  registry.addDevice({ id: 'phone-1', token: 'credential-one', pairedAtMs: 1 });
  registry.addDevice({ id: 'phone-2', token: 'credential-two', pairedAtMs: 2 });

  const correct = registry.decide('credential-two');
  assert.equal(correct.ok, true);
  assert.equal(correct.deviceId, 'phone-2');

  const wrongName = registry.decide('credential-two', 'phone-1');
  assert.equal(wrongName.ok, false);
  assert.equal(wrongName.reason, 'device credential does not match the named device');

  const unknownName = registry.decide('credential-two', 'phone-3');
  assert.equal(unknownName.ok, false);
  assert.equal(unknownName.reason, 'unknown device');

  const unknownCredential = registry.decide('not-the-credential');
  assert.equal(unknownCredential.ok, false);
});

test('the header helpers read the credential and the device id the way the phone sends them', () => {
  assert.equal(bridgePresentedDeviceCredential({ authorization: 'Bearer abc123' }), 'abc123');
  assert.equal(bridgePresentedDeviceCredential({ authorization: 'bearer abc123' }), 'abc123');
  assert.equal(bridgePresentedDeviceCredential({ authorization: 'Basic abc123' }), '');
  assert.equal(bridgePresentedDeviceCredential({}), '');
  assert.equal(bridgePresentedDeviceId({ 'x-botfleet-device': ' phone-1 ' }), 'phone-1');
  assert.equal(bridgePresentedDeviceId({}), '');
  assert.equal(bridgeHeaderValue({ 'X-BotFleet-Device': 'v' }, 'x-botfleet-device'), 'v');
  assert.equal(bridgeHeaderValue({ 'x-botfleet-device': ['a', 'b'] }, 'x-botfleet-device'), 'a');
});

test('the loopback classifier accepts the mapped IPv6 form and refuses the rest', () => {
  assert.equal(isBridgeLoopbackAddress('127.0.0.1'), true);
  assert.equal(isBridgeLoopbackAddress('127.0.0.53'), true);
  assert.equal(isBridgeLoopbackAddress('::1'), true);
  assert.equal(isBridgeLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isBridgeLoopbackAddress('192.168.1.10'), false);
  assert.equal(isBridgeLoopbackAddress('0.0.0.0'), false);
  assert.equal(isBridgeLoopbackAddress(''), false);
  assert.equal(isBridgeLoopbackAddress(undefined), false);
});

test('the command line takes the bootstrap token file and the state file', () => {
  const parsed = parseBridgeArgs(['--bootstrap-token-file', '/path/to/token', '--state-file', '/path/to/state.json']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.bootstrapTokenFile, '/path/to/token');
  assert.equal(parsed.statePath, '/path/to/state.json');

  const equals = parseBridgeArgs(['--bootstrap-token-file=/path/to/token', '--state-file=/path/to/state.json']);
  assert.equal(equals.ok, true);

  const missing = parseBridgeArgs([]);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /--bootstrap-token-file/);

  const noState = parseBridgeArgs(['--bootstrap-token-file', '/x']);
  assert.equal(noState.ok, false);
  assert.match(noState.error, /--state-file/);

  const unknown = parseBridgeArgs(['--bootstrap-token-file', '/x', '--state-file', '/y', '--other']);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown argument/);
});

test('a proxied route needs a device the bridge knows; one it does not know, or has revoked, is answered 401 as the Mac sidecar does', async () => {
  let reached = 0;
  const bridge = await startBridge({
    harnessHandler: (req, res) => {
      reached += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
  });
  try {
    // No device credential at all:  the bridge refuses before the harness.
    // 401 is the status the app reads as "this phone is not paired"; a 403
    // it reads as something that can only be done on the computer, and a
    // phone that lost its pairing would never be offered a new one.
    const anonymous = await call(bridge.port, { path: '/api/bots' });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.json.error, 'device credential required');
    assert.equal(anonymous.headers.get('www-authenticate'), 'Bearer realm="companion-bridge"');
    assert.equal(reached, 0);

    // A credential the bridge never issued is refused as well.
    const stranger = await call(bridge.port, {
      path: '/api/bots',
      headers: ownerHeaders({ authorization: `Bearer ${DEVICE_CREDENTIAL}` }),
    });
    assert.equal(stranger.status, 401);
    assert.equal(stranger.json.error, 'unknown device');
    assert.equal(reached, 0);

    // A paired device reaches the harness.
    const device = await bridge.pair();
    const allowed = await call(bridge.port, {
      path: '/api/bots',
      headers: ownerHeaders({ authorization: `Bearer ${device.credential}` }),
    });
    assert.equal(allowed.status, 200);
    assert.equal(reached, 1);

    // A revoked device does not.
    await call(bridge.port, { method: 'DELETE', path: `/api/companion/devices/${device.deviceId}` });
    const revoked = await call(bridge.port, {
      path: '/api/bots',
      headers: ownerHeaders({ authorization: `Bearer ${device.credential}` }),
    });
    assert.equal(revoked.status, 401);
    assert.equal(reached, 1);
  } finally {
    await bridge.close();
  }
});

test('the pairing routes refuse a body that does not match their contract', async () => {
  const bridge = await startBridge();
  try {
    // An unknown key on the open route is a refusal, not a silent ride
    // along into the window's metadata.
    const unknown = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/open',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ code: '123456', unexpected: 'value' }),
    });
    assert.equal(unknown.status, 400);

    // The same on the redeem route.
    const unknownRedeem = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/redeem',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ code: '123456', unexpected: 'value' }),
    });
    assert.equal(unknownRedeem.status, 400);

    // A body that is not an object at all is refused the same way.
    const notAnObject = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/open',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(['not', 'an', 'object']),
    });
    assert.equal(notAnObject.status, 400);
  } finally {
    await bridge.close();
  }
});

test('a device that cannot be added does not burn the pairing window', async () => {
  const bridge = await startBridge();
  try {
    const opened = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/open',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: '{}',
    });
    // The same device id twice: the second add is refused.
    const first = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/redeem',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ code: opened.json.code, deviceId: 'phone-1' }),
    });
    assert.equal(first.status, 200);

    // A new window, redeemed with a device id that is already paired.
    const second = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/open',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: '{}',
    });
    const refused = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/redeem',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ code: second.json.code, deviceId: 'phone-1' }),
    });
    assert.equal(refused.status, 403);

    // The window was not spent by the refused attempt, so the phone can
    // redeem it again with a device id of its own.
    const retry = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/redeem',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ code: second.json.code, deviceId: 'phone-2' }),
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.json.deviceId, 'phone-2');
  } finally {
    await bridge.close();
  }
});

test('a client that hangs up mid-body does not take the listener with it', async () => {
  const bridge = await startBridge();
  try {
    // A request whose body never finishes:  the listener answers it as a
    // request that was not received, and keeps serving.
    const socket = net.connect(bridge.port, '127.0.0.1');
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(
      'POST /api/companion/pairing/open HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 64\r\n\r\n{',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The listener is still there.
    const health = await call(bridge.port, { path: '/__bridge/health' });
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
  } finally {
    await bridge.close();
  }
});

test('the durable state round-trips through its file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bf-bridge-state-'));
  chmodSync(root, 0o700);
  try {
    const path = join(root, 'state.json');
    // A missing state file is an empty state, not an error.
    assert.equal(loadBridgeState(path).existed, false);

    const registry = new BridgeDeviceRegistry();
    registry.addDevice({ id: 'phone-1', name: 'Phone', token: 'credential-one', pairedAtMs: 3 });
    const state = new BridgeState({ registry, window: { codeDigest: 'a'.repeat(64) } });
    saveBridgeState(path, state.toState());

    const loaded = loadBridgeState(path);
    assert.equal(loaded.existed, true);
    const restored = new BridgeState(loaded.state);
    assert.equal(restored.registry.activeIds()[0], 'phone-1');
    assert.equal(restored.window.codeDigest, 'a'.repeat(64));

    // The state file holds no credential, only its digest.
    const bytes = readFileSync(path, 'utf8');
    assert.equal(bytes.includes('credential-one'), false);
    assert.equal(statSync(path).mode & 0o777, 0o600);

    // A file anyone but the owner can read is refused rather than read.
    chmodSync(path, 0o644);
    assert.throws(() => loadBridgeState(path), /readable beyond its owner/);
    chmodSync(path, 0o600);

    // A symlink is refused too.
    const link = join(root, 'link.json');
    symlinkSync(path, link);
    assert.throws(() => loadBridgeState(link), /symlink/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the minted shapes are the ones the phone accepts', () => {
  assert.match(bridgeMintPairingCode(), /^\d{6}$/);
  assert.match(bridgeMintPairingToken(), /^omb_pair_[A-Za-z0-9_-]{43}$/);
  assert.ok(bridgeMintDeviceCredential().startsWith('bf_brd_'));
  assert.ok(bridgeMintDeviceCredential() !== bridgeMintDeviceCredential());
});

test('the state round-trips through its own serialization', () => {
  const registry = new BridgeDeviceRegistry();
  registry.addDevice({ id: 'phone-1', name: 'Phone', token: 'credential', pairedAtMs: 7 });
  const state = new BridgeState({ registry, window: { codeDigest: 'a'.repeat(64) } });
  const restored = new BridgeState(state.toState());
  assert.equal(restored.registry.activeIds()[0], 'phone-1');
  assert.equal(restored.window.codeDigest, 'a'.repeat(64));
});

test('the APNs locus asks for the declared names and reads the key through the scoped path', async () => {
  assert.deepEqual(bridgeApnsSecretNames(''), ['APNS_KEY_P8', 'APNS_KEY_ID', 'APNS_TEAM_ID']);
  assert.deepEqual(bridgeApnsSecretNames('ABCDE12345'), ['AUTHKEY_ABCDE12345', 'APNS_KEY_ID', 'APNS_TEAM_ID']);
  assert.equal(bridgeApnsNamesSummary(''), 'APNS_KEY_P8, APNS_KEY_ID, APNS_TEAM_ID');

  const requested = [];
  const material = await bridgeApnsMaterial({
    serviceToken: 'st.fixture_token_value_0001',
    fetchImpl: async (url, init) => {
      requested.push({ url, init });
      return {
        ok: true,
        async json() {
          return {
            secrets: [
              { secretKey: 'APNS_KEY_P8', secretValue: FIXTURE_PEM },
              { secretKey: 'APNS_KEY_ID', secretValue: 'ABCDE12345' },
              { secretKey: 'APNS_TEAM_ID', secretValue: 'CC8UTF7ATG' },
            ],
          };
        },
      };
    },
  });
  assert.equal(material.available, true);
  assert.equal(material.keyId, 'ABCDE12345');
  assert.equal(material.teamId, 'CC8UTF7ATG');
  assert.match(material.p8, /BEGIN PRIVATE KEY/);
  assert.equal(requested.length, 1);
  assert.match(requested[0].url, /\/api\/v3\/secrets\/raw/);
  assert.match(requested[0].url, /secretPath=%2Fbotfleet-server/);
  assert.equal(requested[0].init.method, 'GET');
});

test('the APNs locus is off, with a reason, when the vault holds no key', async () => {
  const empty = await bridgeApnsMaterial({
    serviceToken: 'st.fixture_token_value_0001',
    fetchImpl: async () => ({ ok: true, async json() { return { secrets: [] }; } }),
  });
  assert.equal(empty.available, false);
  assert.equal(empty.p8, null);
  assert.match(empty.reason, /names no APNs key id/);

  const noToken = await bridgeApnsMaterial({});
  assert.equal(noToken.available, false);
  assert.match(noToken.reason, /no scoped Infisical token/);

  const unreachable = await bridgeApnsMaterial({
    serviceToken: 'st.fixture_token_value_0001',
    fetchImpl: async () => { throw new Error('network is down'); },
  });
  assert.equal(unreachable.available, false);
  assert.match(unreachable.reason, /could not be read/);

  const notAKey = await bridgeApnsMaterial({
    serviceToken: 'st.fixture_token_value_0001',
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          secrets: [
            { secretKey: 'APNS_KEY_P8', secretValue: 'not-a-key' },
            { secretKey: 'APNS_KEY_ID', secretValue: 'ABCDE12345' },
            { secretKey: 'APNS_TEAM_ID', secretValue: 'CC8UTF7ATG' },
          ],
        };
      },
    }),
  });
  assert.equal(notAKey.available, false);
  assert.match(notAKey.reason, /not a private key/);
});

test('a non-string APNs pin disables the locus instead of throwing', async () => {
  // A number, an object and a boolean are all "no pin":  the locus answers
  // off with its reason rather than throwing on a method the value lacks.
  for (const pin of [123, { keyId: 'ABCDE12345' }, true]) {
    const material = await bridgeApnsMaterial({
      serviceToken: 'st.fixture_token_value_0001',
      pin,
      fetchImpl: async () => ({ ok: true, async json() { return { secrets: [] }; } }),
    });
    assert.equal(material.available, false);
    assert.equal(Object.prototype.toString.call(material.reason), '[object String]');
    assert.ok(material.reason.length > 0);
  }

  // The pinned path keeps working and still has to agree with the vault.
  const disagreeing = await bridgeApnsMaterial({
    serviceToken: 'st.fixture_token_value_0001',
    pin: 'ZZZZ99999',
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          secrets: [
            { secretKey: 'APNS_KEY_P8', secretValue: FIXTURE_PEM },
            { secretKey: 'APNS_KEY_ID', secretValue: 'ABCDE12345' },
            { secretKey: 'APNS_TEAM_ID', secretValue: 'CC8UTF7ATG' },
          ],
        };
      },
    }),
  });
  assert.equal(disagreeing.available, false);
  assert.match(disagreeing.reason, /does not match the vault/);
});

test('an empty token field does not shadow a code the same body carries', async () => {
  const bridge = await startBridge();
  try {
    const opened = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/open',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: '{}',
    });
    assert.equal(opened.status, 200);
    // The old selection read the first field by name with ?? and so read the
    // empty token as the credential; the first field the caller actually
    // sent is the one that counts.
    const redeemed = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/redeem',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ token: '', code: opened.json.code, deviceId: 'phone-shadow' }),
    });
    assert.equal(redeemed.status, 200);
    assert.ok(redeemed.json.credential);
    assert.equal(redeemed.json.replayed, false);

    // A body with every field empty is still refused.
    const none = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/redeem',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ token: '', code: '', credential: '' }),
    });
    assert.equal(none.status, 400);
    assert.match(none.json.error, /code or token/);
  } finally {
    await bridge.close();
  }
});

test('caller metadata cannot rewrite a window field the bridge owns', async () => {
  const bridge = await startBridge();
  try {
    const opened = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/open',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        metadata: {
          spent: true,
          attemptsLeft: 0,
          expiresAtMs: 0,
          codeDigest: 'f'.repeat(64),
          tokenDigest: '0'.repeat(64),
          replay: { forged: true },
          note: 'opened from the desk',
        },
      }),
    });
    assert.equal(opened.status, 200);
    const window = bridge.state.window;
    assert.ok(window, 'the window exists');
    // The reserved fields are the minted ones, not the caller's.
    assert.equal(window.spent, false);
    assert.equal(window.attemptsLeft, BRIDGE_WINDOW_MAX_ATTEMPTS);
    assert.equal(window.expiresAtMs, opened.json.expiresAtMs);
    assert.equal(window.replay, null);
    assert.match(window.codeDigest, /^[0-9a-f]{64}$/);
    assert.match(window.tokenDigest, /^[0-9a-f]{64}$/);
    assert.notEqual(window.codeDigest, 'f'.repeat(64));
    // The benign key rides along.
    assert.equal(window.note, 'opened from the desk');
  } finally {
    await bridge.close();
  }
});

test('caller metadata is bounded to eight keys and 1024 serialized characters', () => {
  const twelve = {};
  for (let index = 0; index < 12; index += 1) twelve[`key${index}`] = index;
  const bounded = boundedWindowMetadata(twelve);
  assert.equal(Object.keys(bounded).length, 8);

  const oversized = { small: 'ok', huge: 'x'.repeat(2000) };
  const carried = boundedWindowMetadata(oversized);
  assert.deepEqual(carried, { small: 'ok' });

  // A value that cannot be read back is dropped, not thrown over.
  const cyclic = {};
  cyclic.self = cyclic;
  assert.deepEqual(boundedWindowMetadata({ cyclic }), {});

  // A reserved key costs nothing:  it is dropped before the bounds count it.
  const mixed = boundedWindowMetadata({ spent: true, note: 'kept', one: 1, two: 2 });
  assert.deepEqual(mixed, { note: 'kept', one: 1, two: 2 });
});

test('a failing durable save pauses the trust-extending routes and a working save resumes them', async () => {
  let savesWork = true;
  const bridge = await startBridge({
    bridgeOptions: {
      persist: () => savesWork,
    },
  });
  try {
    // The window opens while saves work, and the fixture pairs a device.
    const device = await bridge.pair('phone-save');
    assert.ok(device.credential);

    // The save starts failing:  open, redeem and revoke all answer 503.
    savesWork = false;
    const openRefused = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/open',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: '{}',
    });
    assert.equal(openRefused.status, 503);
    assert.match(openRefused.json.error, /could not be saved/);

    const redeemRefused = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/redeem',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ code: '000000', deviceId: 'phone-2' }),
    });
    // A wrong credential is still a refusal while saves fail:  the refusal
    // holds in memory, and its burned attempt is the only thing a lost save
    // costs.
    assert.equal(redeemRefused.status, 403);

    // A proxied route keeps working:  the in-memory registry still guards
    // it, and proxying extends no trust the state would have to hold.
    const proxied = await call(bridge.port, {
      method: 'GET',
      path: '/api/bots',
      headers: ownerHeaders({ authorization: `Bearer ${device.credential}` }),
    });
    assert.equal(proxied.status, 200);

    // The revoke still takes hold in memory even while the save is failing,
    // so a revoked device stays refused; the 503 only says the durable copy
    // did not happen.
    const revokeRefused = await call(bridge.port, {
      method: 'DELETE',
      path: '/api/companion/devices/phone-save',
    });
    assert.equal(revokeRefused.status, 503);
    const revokedProxy = await call(bridge.port, {
      method: 'GET',
      path: '/api/bots',
      headers: ownerHeaders({ authorization: `Bearer ${device.credential}` }),
    });
    assert.equal(revokedProxy.status, 401);

    // The save works again and the routes come back.
    savesWork = true;
    const openResumed = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/open',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: '{}',
    });
    assert.equal(openResumed.status, 200);
  } finally {
    await bridge.close();
  }
});

test('a redeem whose save fails is rolled back, then works when saves recover', async () => {
  let savesWork = true;
  const bridge = await startBridge({
    bridgeOptions: {
      persist: () => savesWork,
    },
  });
  try {
    const opened = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/open',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: '{}',
    });
    assert.equal(opened.status, 200);
    savesWork = false;
    const redeemed = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/redeem',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ code: opened.json.code, deviceId: 'phone-unconfirmed' }),
    });
    // The phone is not told a pairing happened, no credential leaves the
    // bridge, and the in-memory spend is rolled back:  the window is
    // unspent again and the device row is gone, so the pairing never
    // half-happened.
    assert.equal(redeemed.status, 503);
    assert.equal(redeemed.json.credential, undefined);
    assert.equal(bridge.state.registry.activeIds().includes('phone-unconfirmed'), false);
    assert.equal(bridge.state.window.spent, false);

    // Saves recover, and the SAME code redeems for real.
    savesWork = true;
    const retried = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/redeem',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ code: opened.json.code, deviceId: 'phone-unconfirmed' }),
    });
    assert.equal(retried.status, 200);
    assert.ok(retried.json.credential);
    assert.equal(bridge.state.registry.activeIds().includes('phone-unconfirmed'), true);
  } finally {
    await bridge.close();
  }
});

test('a metadata key named like the prototype accessor is dropped, not applied', () => {
  // JSON.parse makes __proto__ an own property, which is exactly how a
  // pairing-open body would carry it.
  const body = JSON.parse('{"__proto__": {"polluted": true}, "note": "kept"}');
  const carried = boundedWindowMetadata(body);
  assert.deepEqual(carried, { note: 'kept' });
  assert.equal({}.polluted, undefined);
  assert.equal(Object.keys(carried).includes('__proto__'), false);
});

test('push-token, live-activity-token, and push-health routes enforce auth, validation, persistence rollback, and secret-free output', async () => {
  let savesWork = true;
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const p8 = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const sender = createBridgeApnsSender({
    material: { available: true, keyId: 'KEYID12345', teamId: 'CC8UTF7ATG', p8, reason: '' },
    sendImpl: async () => ({ status: 200 }),
  });

  const bridge = await startBridge({
    bridgeOptions: {
      apnsSender: sender,
      persist: () => savesWork,
    },
  });
  try {
    const device = await bridge.pair('phone-push');
    const pushToken = 'Ab'.repeat(32);
    const laToken = 'Cd'.repeat(32);

    // Device credential is required on all three routes, and its absence
    // is 401 as on every other route that needs a device.
    for (const [method, path, body] of [
      ['POST', '/api/companion/push-token', JSON.stringify({ token: pushToken })],
      ['POST', '/api/companion/live-activity-token', JSON.stringify({ token: laToken, kind: 'push-to-start' })],
      ['GET', '/api/companion/push-health', undefined],
    ]) {
      const denied = await call(bridge.port, {
        method,
        path,
        headers: ownerHeaders(body ? { 'content-type': 'application/json' } : {}),
        body,
      });
      assert.equal(denied.status, 401, `${method} ${path}`);
    }

    // Invalid token or unsupported kind returns 400.
    const badHex = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/push-token',
      headers: ownerHeaders({ 'content-type': 'application/json', authorization: `Bearer ${device.credential}` }),
      body: JSON.stringify({ token: 'not-hex' }),
    });
    assert.equal(badHex.status, 400);

    const badKind = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/live-activity-token',
      headers: ownerHeaders({ 'content-type': 'application/json', authorization: `Bearer ${device.credential}` }),
      body: JSON.stringify({ token: laToken, kind: 'update' }),
    });
    assert.equal(badKind.status, 400);

    const oversize = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/push-token',
      headers: ownerHeaders({ 'content-type': 'application/json', authorization: `Bearer ${device.credential}` }),
      body: JSON.stringify({ token: 'a'.repeat(513) }),
    });
    assert.equal(oversize.status, 400);

    // Persistence failure rolls back in-memory token and answers 503.
    savesWork = false;
    const failedSave = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/push-token',
      headers: ownerHeaders({ 'content-type': 'application/json', authorization: `Bearer ${device.credential}` }),
      body: JSON.stringify({ token: pushToken }),
    });
    assert.equal(failedSave.status, 503);
    assert.equal(bridge.state.registry.pushTokenCount(), 0);

    // Valid registrations succeed and survive in state without leaking into publicDevices.
    savesWork = true;
    const okPush = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/push-token',
      headers: ownerHeaders({ 'content-type': 'application/json', authorization: `Bearer ${device.credential}` }),
      body: JSON.stringify({ token: pushToken }),
    });
    assert.equal(okPush.status, 200);

    const okLive = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/live-activity-token',
      headers: ownerHeaders({ 'content-type': 'application/json', authorization: `Bearer ${device.credential}` }),
      body: JSON.stringify({ token: laToken, kind: 'push-to-start' }),
    });
    assert.equal(okLive.status, 200);

    const devicesList = await call(bridge.port, { path: '/api/companion/devices' });
    assert.equal(devicesList.status, 200);
    assert.equal(JSON.stringify(devicesList.json).includes(pushToken.toLowerCase()), false);
    assert.equal(JSON.stringify(devicesList.json).includes(laToken.toLowerCase()), false);

    const health = await call(bridge.port, {
      path: '/api/companion/push-health',
      headers: ownerHeaders({ authorization: `Bearer ${device.credential}` }),
    });
    assert.equal(health.status, 200);
    assert.equal(health.json.configured, true);
    assert.equal(health.json.tokensRegistered, 1);

    // Malformed expectedToken must not clear a valid stored token.
    assert.equal(bridge.state.registry.clearPushToken('phone-push', 'not-a-valid-token'), false);
    assert.equal(bridge.state.registry.clearLiveActivityToken('phone-push', 'not-a-valid-token'), false);
    assert.equal(bridge.state.registry.pushTargets().length, 1);

    // A device with only a Live Activity token stays in pushTargets() for dispatch
    // without inflating alert-only push-health tokensRegistered.
    const liveOnly = await bridge.pair('phone-live-only');
    const regLiveOnly = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/live-activity-token',
      headers: ownerHeaders({ 'content-type': 'application/json', authorization: `Bearer ${liveOnly.credential}` }),
      body: JSON.stringify({ token: 'ef'.repeat(32), kind: 'push-to-start' }),
    });
    assert.equal(regLiveOnly.status, 200);
    assert.equal(bridge.state.registry.pushTargets().length, 2);
    const healthAfter = await call(bridge.port, {
      path: '/api/companion/push-health',
      headers: ownerHeaders({ authorization: `Bearer ${device.credential}` }),
    });
    assert.equal(healthAfter.json.tokensRegistered, 1);
  } finally {
    await bridge.close();
  }
});

test('revoking a device terminates its active SSE stream immediately', async () => {
  let upstreamClosed = false;
  const openRes = [];
  const bridge = await startBridge({
    harnessHandler: (req, res, info) => {
      if (info.path === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('data: {"kind":"hello","cursor":"1"}\n\n');
        openRes.push(res);
        res.on('close', () => {
          upstreamClosed = true;
        });
        return;
      }
      res.writeHead(200);
      res.end('{}');
    },
  });

  try {
    const device = await bridge.pair('phone-sse-revoke');
    const sseClosed = new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: bridge.port,
        path: '/api/events',
        method: 'GET',
        headers: ownerHeaders({
          authorization: `Bearer ${device.credential}`,
          'x-botfleet-device': 'phone-sse-revoke',
        }),
      }, (res) => {
        res.once('data', async () => {
          const revoked = await call(bridge.port, {
            method: 'DELETE',
            path: '/api/companion/devices/phone-sse-revoke',
          });
          assert.equal(revoked.status, 200);
        });
        res.on('end', () => resolve('ended'));
        res.on('close', () => resolve('closed'));
        res.on('error', () => resolve('errored'));
      });
      req.end();
    });

    const outcome = await Promise.race([
      sseClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('SSE stream stayed open after revoke')), 3000)),
    ]);
    assert.ok(['ended', 'closed', 'errored'].includes(outcome));
    assert.equal(upstreamClosed, true);
  } finally {
    for (const r of openRes) r.destroy();
    await bridge.close();
  }
});

test('loopback SSE notify frames send background alerts and Live Activities while skipping active SSE devices', async () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const p8 = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const sent = [];
  const sender = createBridgeApnsSender({
    material: { available: true, keyId: 'KEYID12345', teamId: 'CC8UTF7ATG', p8, reason: '' },
    sendImpl: async (req) => {
      sent.push(req);
      if (req.path.endsWith('f'.repeat(64))) return { status: 410, reason: 'Unregistered' };
      return { status: 200 };
    },
  });

  const sseClients = [];
  const bridge = await startBridge({
    harnessHandler: (req, res, info) => {
      if (info.path === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('data: {"kind":"hello","cursor":"10"}\n\n');
        sseClients.push(res);
        res.on('close', () => {
          const idx = sseClients.indexOf(res);
          if (idx !== -1) sseClients.splice(idx, 1);
        });
        return;
      }
      res.writeHead(200);
      res.end('{}');
    },
    bridgeOptions: {
      apnsSender: sender,
      startEventSubscriber: true,
    },
  });

  try {
    const online = await bridge.pair('phone-online');
    const offline = await bridge.pair('phone-offline');

    await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/push-token',
      headers: ownerHeaders({ 'content-type': 'application/json', authorization: `Bearer ${online.credential}` }),
      body: JSON.stringify({ token: 'e'.repeat(64) }),
    });
    await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/push-token',
      headers: ownerHeaders({ 'content-type': 'application/json', authorization: `Bearer ${offline.credential}` }),
      body: JSON.stringify({ token: 'f'.repeat(64) }),
    });
    await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/live-activity-token',
      headers: ownerHeaders({ 'content-type': 'application/json', authorization: `Bearer ${offline.credential}` }),
      body: JSON.stringify({ token: '9'.repeat(64), kind: 'push-to-start' }),
    });

    // Connect phone-online to /api/events so it is marked active foreground SSE.
    let onlineReq;
    await new Promise((resolve) => {
      onlineReq = http.request({
        hostname: '127.0.0.1',
        port: bridge.port,
        path: '/api/events',
        method: 'GET',
        headers: ownerHeaders({ authorization: `Bearer ${online.credential}` }),
      }, (res) => {
        res.once('data', () => resolve());
      });
      onlineReq.end();
    });

    // Wait until the bridge subscriber is also connected to /api/events.
    const deadline = Date.now() + 3000;
    while (sseClients.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(sseClients.length >= 2);

    const frame = JSON.stringify({
      kind: 'notify',
      seq: 11,
      notification: {
        title: 'Forge',
        body: 'Approve tool call?',
        kind: 'approval',
        threadId: 'thread-99',
        botId: 'bot-1',
        botName: 'Forge',
        requestId: 'req-99',
      },
    }, null, 2);
    // Send as a multi-line SSE data frame to verify multi-line joining.
    const sseDataRows = frame.split('\n').map((line) => `data: ${line}`).join('\n');
    const ssePayload = `id: 11\n${sseDataRows}\n\n`;
    for (const clientRes of Array.from(sseClients)) {
      clientRes.write(ssePayload);
    }

    const sendDeadline = Date.now() + 3000;
    while (sent.length < 2 && Date.now() < sendDeadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    onlineReq.destroy();

    assert.equal(sent.length, 2);
    assert.equal(sent.some((r) => r.path.endsWith('e'.repeat(64))), false);
    assert.equal(sent.some((r) => r.path.endsWith('f'.repeat(64))), true);
    assert.equal(sent.some((r) => r.path.endsWith('9'.repeat(64))), true);
    // The 410 Unregistered response cleared phone-offline's dead alert token.
    const checkDeadline = Date.now() + 1000;
    while (bridge.state.registry.pushTokenCount() > 1 && Date.now() < checkDeadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(bridge.state.registry.pushTokenCount(), 1);
  } finally {
    for (const r of sseClients) r.destroy();
    await bridge.close();
  }
});

// ── the shipped iOS app's contract: the health probe, pairing, the
//    advertisement, and the routes a paired phone syncs through ─────────────

/**
 * One request through Node's own client, so the raw bytes and the headers
 * come back exactly as they crossed and a `Host` header can be set by hand.
 */
function rawCall(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        resolve({ status: response.statusCode, headers: response.headers, buffer: Buffer.concat(chunks) });
      });
    });
    request.on('error', reject);
    if (body !== undefined) request.end(body);
    else request.end();
  });
}

/** Open a pairing window on the bridge and hand back the operator's answer. */
async function openWindow(port) {
  const opened = await call(port, {
    method: 'POST',
    path: '/api/companion/pairing/open',
    headers: ownerHeaders({ 'content-type': 'application/json' }),
    body: '{}',
  });
  assert.equal(opened.status, 200);
  return opened.json;
}

/** A request id in the shape `UUID().uuidString` spells it, which is what
 *  `pairFirstReachable` mints for one logical pairing. */
const PAIR_REQUEST_ID = '8D5C0F2A-1B3E-4F5A-9C8D-1234567890AB';

/** The body `CompanionClient.pair` builds: six digits travel as `code`, the
 *  QR token as `credential`, and the request id rides along. */
function pairBody(credential, deviceName = "Jay's iPhone", pairRequestId = PAIR_REQUEST_ID) {
  const body = { [/^\d{6}$/.test(credential) ? 'code' : 'credential']: credential, deviceName };
  if (pairRequestId !== null) body.pairRequestId = pairRequestId;
  return JSON.stringify(body);
}

/** The app's pairing call. */
function pairPhone(port, credential, options = {}) {
  return call(port, {
    method: 'POST',
    path: '/api/pair',
    headers: ownerHeaders({ 'content-type': 'application/json' }),
    body: pairBody(credential, options.deviceName, options.pairRequestId),
  });
}

/** A port nothing is listening on, for a bridge whose harness is down. */
async function closedPort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** A concrete path that one forwarded row's pattern accepts. */
function samplePath(pattern) {
  // One pass over the pattern's source, so a class is filled in where it
  // stands and the literal words of the route (`api`, `bots`, `skills`) are
  // never mistaken for a class.
  const fill = new Map([
    [String.raw`[A-Za-z0-9][A-Za-z0-9_-]{0,127}`, 'acct-1'],
    [String.raw`(?:png|jpe?g|gif|webp)`, 'png'],
    [String.raw`(?:cancel|seen)`, 'cancel'],
    [String.raw`[a-z0-9-]+`, 'skill-1'],
    [String.raw`[\w-]+`, 'x1'],
    [String.raw`\d+`, '0'],
    [String.raw`\/`, '/'],
    [String.raw`\.`, '.'],
  ]);
  const token = /\[A-Za-z0-9\]\[A-Za-z0-9_-\]\{0,127\}|\(\?:png\|jpe\?g\|gif\|webp\)|\(\?:cancel\|seen\)|\[a-z0-9-\]\+|\[\\w-\]\+|\\d\+|\\\/|\\\./g;
  return pattern.source
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(token, (match) => fill.get(match));
}

/** A body each forwarded row accepts where the bridge checks one. */
const CHECKED_BODIES = [
  [/^\/api\/bots\/[\w-]+\/profile$/, '{"name":"Rio"}'],
  [/^\/api\/bots\/[\w-]+$/, '{"hidden":true}'],
];

test('GET /api/health is forwarded before pairing, behind the owner credential, untouched', async () => {
  // What the harness answers, pid and build identity included. The app's
  // `healthy` reads `app` and `ready` and ignores the rest.
  const identity = JSON.stringify({ app: 'botfleet', pid: 4312, static: false, hostId: 'h-1', version: '0.1.0+test', ready: true });
  let seen = null;
  const bridge = await startBridge({
    harnessHandler: (req, res, info) => {
      seen = { info, headers: { ...req.headers } };
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(identity)) });
      res.end(identity);
    },
  });
  try {
    // No device exists yet, and none is asked for.
    assert.deepEqual(bridge.state.registry.activeIds(), []);
    const health = await rawCall(bridge.port, { path: '/api/health', headers: ownerHeaders() });
    assert.equal(health.status, 200);
    assert.equal(health.buffer.toString('utf8'), identity);
    assert.equal(health.headers['content-type'], 'application/json');
    assert.equal(health.headers['content-length'], String(Buffer.byteLength(identity)));
    assert.equal(seen.info.path, '/api/health');
    assert.equal(seen.info.query, '');
    assert.equal(seen.info.body, '');
    // The harness sees a plain loopback caller: the companion stamp the
    // bridge sets itself, and neither credential the phone or the owner sent.
    assert.equal(seen.headers['x-botfleet-companion'], '1');
    assert.equal(seen.headers['x-botfleet-gate-token'], undefined);
    assert.equal(seen.headers['tailscale-user-login'], undefined);
    assert.equal(seen.headers.authorization, undefined);

    // A device credential sent along changes nothing: health is not a device
    // route, so the bearer is dropped like every other identity header.
    const withBearer = await rawCall(bridge.port, { path: '/api/health', headers: ownerHeaders({ authorization: `Bearer ${DEVICE_CREDENTIAL}` }) });
    assert.equal(withBearer.status, 200);
    assert.equal(seen.headers.authorization, undefined);

    // The query string crosses untouched, and the answer's own status too:
    // a harness that is booting says so with `ready: false`, and a harness
    // that refuses says so with its status. Neither is rewritten here.
    const booting = JSON.stringify({ app: 'botfleet', ready: false, booting: true });
    const bootingBridge = await startBridge({
      harnessHandler: (req, res, info) => {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(info.query === '?probe=1' ? booting : identity);
      },
    });
    try {
      const answered = await rawCall(bootingBridge.port, { path: '/api/health?probe=1', headers: ownerHeaders() });
      assert.equal(answered.status, 503);
      assert.equal(answered.buffer.toString('utf8'), booting);
    } finally {
      await bootingBridge.close();
    }
  } finally {
    await bridge.close();
  }
});

test('a health probe against a harness that is not there answers 502 and nothing else', async () => {
  const bridge = await startBridge({ bridgeOptions: { upstreamPort: await closedPort() } });
  try {
    const health = await call(bridge.port, { path: '/api/health' });
    assert.equal(health.status, 502);
    assert.deepEqual(health.json, { error: 'the harness did not answer' });
  } finally {
    await bridge.close();
  }
});

test('POST /api/pair answers the body the iOS app decodes as PairResponse', async () => {
  const bridge = await startBridge({ bridgeOptions: { origins: ['https://box.example.ts.net:8800'] } });
  try {
    const opened = await openWindow(bridge.port);
    const paired = await pairPhone(bridge.port, opened.token);
    assert.equal(paired.status, 201);

    // `PairResponse.token`: the device credential, in the shape this bridge
    // mints, shown once.
    assert.match(paired.json.token, /^bf_brd_[A-Za-z0-9_-]{43}$/);

    // `PairResponse.device`, which the app decodes as `PairedDevice`. The
    // bridge names the device with a UUID, as the Mac sidecar does, and the
    // app never sends an id of its own.
    assert.match(paired.json.device.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(paired.json.device.name, "Jay's iPhone");
    assert.equal(Number.isInteger(paired.json.device.createdAt), true, 'PairedDevice.createdAt is epoch milliseconds');
    assert.ok(Math.abs(paired.json.device.createdAt - Date.now()) < 60_000);
    assert.equal(paired.json.device.lastSeenAt, paired.json.device.createdAt);

    // `PairResponse.serverName`, and `PairResponse.endpoints` carrying the
    // configured route in the one kind the shipped decoder accepts for it.
    assert.equal(paired.json.serverName, 'BotFleet Server');
    assert.deepEqual(paired.json.endpoints, [{ url: 'https://box.example.ts.net:8800', kind: 'hosted', priority: 0 }]);
    // `PairResponse.isBridge`: a phone paired with a Mac keeps that pairing
    // and holds this one beside it.
    assert.equal(paired.json.isBridge, true);

    // Exactly the keys `PairResponse` names and exactly the keys
    // `PairedDevice` names: nothing is sent that the app does not decode.
    assert.deepEqual(Object.keys(paired.json).sort(), ['device', 'endpoints', 'isBridge', 'serverName', 'token']);
    assert.deepEqual(Object.keys(paired.json.device).sort(), ['createdAt', 'id', 'lastSeenAt', 'name']);
    assert.deepEqual(Object.keys(paired.json.endpoints[0]).sort(), ['kind', 'priority', 'url']);

    // The registry holds digests only: neither the device credential nor
    // the pairing code or token is anywhere in the durable state.
    const serialized = JSON.stringify(bridge.state.toState());
    assert.equal(serialized.includes(paired.json.token), false);
    assert.equal(serialized.includes(opened.token), false);
    assert.equal(serialized.includes(opened.code), false);

    // The credential works: the new device reaches a forwarded route, and
    // with it the pairing is spent.
    const used = await call(bridge.port, { path: '/api/bots', headers: ownerHeaders({ authorization: `Bearer ${paired.json.token}` }) });
    assert.equal(used.status, 200);
    assert.equal(bridge.state.registry.activeIds().length, 1);
    assert.equal(bridge.state.window.spent, true);
    assert.equal(bridge.state.window.replay.deviceId, paired.json.device.id);
  } finally {
    await bridge.close();
  }
});

test('POST /api/pair takes the six-digit code too, and a request with no id pairs exactly once', async () => {
  const bridge = await startBridge();
  try {
    // The code, as a person types it.
    const opened = await openWindow(bridge.port);
    const byCode = await pairPhone(bridge.port, opened.code, { deviceName: 'Typed in by hand' });
    assert.equal(byCode.status, 201);
    assert.match(byCode.json.token, /^bf_brd_/);
    assert.equal(byCode.json.device.name, 'Typed in by hand');
    // No advertisement is configured and the request arrived on a loopback
    // address, so there is no route to offer and the field is left out
    // rather than sent empty.
    assert.equal('endpoints' in byCode.json, false);
    assert.equal('hosts' in byCode.json, false);

    // An older client that sends no request id keeps exactly-once behaviour:
    // the pairing succeeds, nothing is recorded for a replay, and a retry of
    // the same request is an ordinary spent-window refusal.
    const second = await openWindow(bridge.port);
    const once = await pairPhone(bridge.port, second.token, { pairRequestId: null });
    assert.equal(once.status, 201);
    assert.equal(bridge.state.window.replay, null);
    const retried = await pairPhone(bridge.port, second.token, { pairRequestId: null });
    assert.equal(retried.status, 401);
    assert.equal(retried.json.error, 'That pairing credential was already used. Start pairing again.');

    // A device name with control characters is cleaned before it is stored.
    const third = await openWindow(bridge.port);
    const messy = await pairPhone(bridge.port, third.token, { deviceName: '  Ping\u0007\u001fPong \n' });
    assert.equal(messy.status, 201);
    // Each control character becomes one space and runs are not collapsed,
    // which is what the sidecar's `cleanDeviceName` does with the same name.
    assert.equal(messy.json.device.name, 'Ping  Pong');
    assert.equal(bridge.state.registry.activeIds().length, 3);
  } finally {
    await bridge.close();
  }
});

test('POST /api/pair refuses a wrong code, a spent window, an expired window and a burned budget, in words the app shows', async () => {
  let clock = 1_700_000_000_000;
  const bridge = await startBridge({ bridgeOptions: { now: () => clock } });
  try {
    // No window at all.
    const idle = await pairPhone(bridge.port, 'omb_pair_' + 'a'.repeat(43));
    assert.equal(idle.status, 401);
    assert.equal(idle.json.error, 'No pairing window is open on this server, so there is nothing to pair with. Start pairing again.');
    assert.deepEqual(Object.keys(idle.json), ['error']);

    // A wrong code costs one attempt each time, and the right one afterwards
    // is refused because the budget is gone.
    const opened = await openWindow(bridge.port);
    for (let attempt = BRIDGE_WINDOW_MAX_ATTEMPTS; attempt > 0; attempt -= 1) {
      const wrong = await pairPhone(bridge.port, '000000');
      assert.equal(wrong.status, 401);
      // The attempt that uses up the budget says the budget is gone, the
      // sentence the Mac answers on that same attempt; every earlier wrong
      // attempt is only wrong.
      assert.equal(
        wrong.json.error,
        attempt === 1 ? 'Too many incorrect codes. Start pairing again.' : 'That pairing code or token is not right.',
      );
      assert.equal(bridge.state.window.attemptsLeft, attempt - 1);
    }
    // The budget is gone, so the window is spent: the right code now answers
    // the spent-window sentence, having heard "too many incorrect codes" on
    // the attempt that spent it.
    const locked = await pairPhone(bridge.port, opened.code);
    assert.equal(locked.status, 401);
    assert.equal(locked.json.error, 'That pairing credential was already used. Start pairing again.');
    assert.equal(bridge.state.window.spent, true);
    assert.equal(bridge.state.registry.activeIds().length, 0);

    // A QR token that is not the window's is a wrong code too.
    const second = await openWindow(bridge.port);
    const stranger = await pairPhone(bridge.port, 'omb_pair_' + 'b'.repeat(43));
    assert.equal(stranger.status, 401);
    assert.equal(stranger.json.error, 'That pairing code or token is not right.');
    assert.equal(bridge.state.window.attemptsLeft, BRIDGE_WINDOW_MAX_ATTEMPTS - 1);

    // The window outlives its TTL and is spent by the expiry.
    clock += 300_001;
    const expired = await pairPhone(bridge.port, second.code);
    assert.equal(expired.status, 401);
    assert.equal(expired.json.error, 'That pairing window has expired. Start pairing again.');
    assert.equal(bridge.state.window.spent, true);

    // A spent window answers the same credential the way the app expects a
    // used one to read, whether or not it carries the request id.
    const third = await openWindow(bridge.port);
    clock += 1;
    const spent = await pairPhone(bridge.port, third.token);
    assert.equal(spent.status, 201);
    const used = await pairPhone(bridge.port, third.token, { pairRequestId: 'ANOTHER-REQUEST-ID-000000000001' });
    assert.equal(used.status, 401);
    assert.equal(used.json.error, 'That pairing credential was already used. Start pairing again.');
    assert.equal(bridge.state.registry.activeIds().length, 1);
  } finally {
    await bridge.close();
  }
});

test('a replay of the same pairing request is refused by name and mints nothing', async () => {
  const bridge = await startBridge();
  try {
    const opened = await openWindow(bridge.port);
    const first = await pairPhone(bridge.port, opened.token);
    assert.equal(first.status, 201);

    // The same phone request, back after a lost response. The bridge hands
    // a credential out once and keeps only its digest, so it cannot answer
    // the pairing again; it says so instead of answering a body the app
    // would store with an empty token.
    const replay = await pairPhone(bridge.port, opened.token);
    assert.equal(replay.status, 409);
    assert.match(replay.json.error, /issued only once/);
    assert.deepEqual(Object.keys(replay.json), ['error']);
    assert.equal('token' in replay.json, false);
    assert.equal('device' in replay.json, false);
    assert.equal(bridge.state.registry.activeIds().length, 1);
    assert.equal(bridge.state.window.replay.deviceId, first.json.device.id);
    assert.equal(JSON.stringify(bridge.state.toState()).includes(first.json.token), false);

    // The first credential still works; a lost response costs nothing that
    // already succeeded.
    const used = await call(bridge.port, { path: '/api/bots', headers: ownerHeaders({ authorization: `Bearer ${first.json.token}` }) });
    assert.equal(used.status, 200);

    // The same id with another credential, or the same credential under
    // another id, is not a replay.
    for (const other of [
      pairBody('omb_pair_' + 'c'.repeat(43)),
      pairBody('000000'),
      pairBody(opened.token, "Jay's iPhone", 'ANOTHER-REQUEST-ID-000000000002'),
    ]) {
      const refused = await call(bridge.port, {
        method: 'POST',
        path: '/api/pair',
        headers: ownerHeaders({ 'content-type': 'application/json' }),
        body: other,
      });
      assert.equal(refused.status, 401, other);
      assert.equal('token' in refused.json, false);
    }

    // A device the owner revoked is not brought back by a replay.
    const revoked = await call(bridge.port, { method: 'DELETE', path: `/api/companion/devices/${first.json.device.id}` });
    assert.equal(revoked.status, 200);
    const afterRevoke = await pairPhone(bridge.port, opened.token);
    assert.equal(afterRevoke.status, 401);
    assert.equal('token' in afterRevoke.json, false);
    assert.equal(bridge.state.registry.activeIds().length, 0);
  } finally {
    await bridge.close();
  }
});

test('POST /api/pair refuses a body that is not the app\'s contract, and none of them costs an attempt', async () => {
  const bridge = await startBridge();
  try {
    const opened = await openWindow(bridge.port);
    for (const [body, error] of [
      ['not json', 'the request body is not valid JSON'],
      ['[]', 'the request body is not a JSON object'],
      ['"omb_pair_' + 'a'.repeat(43) + '"', 'the request body is not a JSON object'],
      ['{}', 'a pairing code or credential is required'],
      ['{"credential":""}', 'a pairing code or credential is required'],
      ['{"code":"","credential":""}', 'a pairing code or credential is required'],
      ['{"deviceName":"No credential"}', 'a pairing code or credential is required'],
      // The redeem route's field names are not the app's.
      ['{"token":"' + opened.token + '","deviceId":"phone-1"}', 'the pairing request does not match the contract'],
      ['{"code":"123456","unexpected":1}', 'the pairing request does not match the contract'],
      ['{"code":"123456","requestId":"pairing-request-0001"}', 'the pairing request does not match the contract'],
      // A number is not coerced into the code it spells.
      ['{"code":123456}', 'the pairing request does not match the contract'],
      ['{"credential":"' + opened.token + '","deviceName":5}', 'the pairing request does not match the contract'],
      ['{"credential":"' + opened.token + '","pairRequestId":7}', 'the pairing request does not match the contract'],
    ]) {
      const refused = await call(bridge.port, {
        method: 'POST',
        path: '/api/pair',
        headers: ownerHeaders({ 'content-type': 'application/json' }),
        body,
      });
      assert.equal(refused.status, 400, body);
      assert.equal(refused.json.error, error, body);
      assert.deepEqual(Object.keys(refused.json), ['error']);
    }
    // A body over the size limit is refused the same way.
    const oversized = await call(bridge.port, {
      method: 'POST',
      path: '/api/pair',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ credential: 'x'.repeat(70 * 1024) }),
    });
    assert.equal(oversized.status, 400);
    assert.equal(oversized.json.error, 'the request body is too large');

    // The real credential still redeems afterwards: none of the refusals
    // spent the window or burned an attempt.
    assert.equal(bridge.state.window.spent, false);
    assert.equal(bridge.state.window.attemptsLeft, BRIDGE_WINDOW_MAX_ATTEMPTS);
    const paired = await pairPhone(bridge.port, opened.token);
    assert.equal(paired.status, 201);
  } finally {
    await bridge.close();
  }
});

test('no new pairing window opens while the durable state refuses a save', async () => {
  let savesWork = true;
  const bridge = await startBridge({ bridgeOptions: { persist: () => savesWork } });
  try {
    await openWindow(bridge.port);
    const first = await bridge.pair('phone-before-saves-fail');
    assert.ok(first.credential);

    savesWork = false;
    // `openWindow` asserts the 200, so this call is made by hand: a window
    // that cannot be saved is not opened, and the refusal says why.
    const refused = await call(bridge.port, {
      method: 'POST',
      path: '/api/companion/pairing/open',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: '{}',
    });
    assert.equal(refused.status, 503);
    assert.match(refused.json.error, /could not be saved/);
    assert.equal(bridge.state.registry.activeIds().length, 1);
  } finally {
    await bridge.close();
  }
});

test('a pairing whose durable save fails is rolled back, confirms nothing, and works when saves recover (fresh window)', async () => {
  let savesWork = true;
  const bridge = await startBridge({ bridgeOptions: { persist: () => savesWork } });
  try {
    const opened = await openWindow(bridge.port);
    assert.match(opened.code, /^\d{6}$/);
    savesWork = false;
    const refused = await pairPhone(bridge.port, opened.token);
    // The phone is not told a pairing happened, no credential leaves the
    // bridge, and the in-memory spend is rolled back: the window is unspent
    // again and the device row is gone.
    assert.equal(refused.status, 503);
    assert.equal(refused.json.token, undefined);
    assert.match(refused.json.error, /could not be saved/);
    assert.equal(bridge.state.registry.activeIds().length, 0);
    assert.equal(bridge.state.window.spent, false);

    // Saves recover, and the SAME request pairs for real.
    savesWork = true;
    const paired = await pairPhone(bridge.port, opened.token);
    assert.equal(paired.status, 201);
    assert.match(paired.json.token, /^bf_brd_/);
    assert.equal(bridge.state.registry.activeIds().length, 1);
    assert.equal(bridge.state.window.spent, true);
  } finally {
    await bridge.close();
  }
});

test('the advertisement carries the configured routes, and falls back to the route the request arrived on', async () => {
  const configured = await startBridge({
    bridgeOptions: { origins: ['https://box.example.ts.net:8800', 'https://cdn.example'] },
  });
  try {
    const listed = await call(configured.port, { path: '/api/companion/endpoints' });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json, {
      serverName: 'BotFleet Server',
      isBridge: true,
      endpoints: [
        { url: 'https://box.example.ts.net:8800', kind: 'hosted', priority: 0 },
        { url: 'https://cdn.example', kind: 'hosted', priority: 100 },
      ],
    });
    // `hosts` is the older builds' list of plain http addresses. The bridge
    // answers on its advertised route alone, so it names none.
    assert.equal('hosts' in listed.json, false);
    // The advertisement needs the owner credential and no device.
    const anonymous = await call(configured.port, { path: '/api/companion/endpoints', headers: {} });
    assert.equal(anonymous.status, 403);
  } finally {
    await configured.close();
  }

  const derived = await startBridge();
  try {
    // What `tailscale serve` hands the loopback hop: the original Host, the
    // same value as X-Forwarded-Host, and the scheme it terminated.
    const viaServe = await rawCall(derived.port, {
      path: '/api/companion/endpoints',
      headers: ownerHeaders({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'box.example.ts.net:8800', host: 'box.example.ts.net:8800' }),
    });
    assert.deepEqual(JSON.parse(viaServe.buffer.toString('utf8')), {
      serverName: 'BotFleet Server',
      isBridge: true,
      endpoints: [{ url: 'https://box.example.ts.net:8800', kind: 'hosted', priority: 0 }],
    });
    // A proxy that names no forwarded host leaves the Host to speak.
    const byHost = await rawCall(derived.port, {
      path: '/api/companion/endpoints',
      headers: ownerHeaders({ 'x-forwarded-proto': 'http', host: 'box.example.ts.net:8080' }),
    });
    assert.deepEqual(JSON.parse(byHost.buffer.toString('utf8')).endpoints, [
      { url: 'http://box.example.ts.net:8080', kind: 'tailnet', priority: 0 },
    ]);
    // A direct loopback call, such as a curl on the host, advertises
    // nothing: a loopback address is no route a phone can dial.
    const direct = await call(derived.port, { path: '/api/companion/endpoints' });
    assert.deepEqual(direct.json, { serverName: 'BotFleet Server', isBridge: true, endpoints: [] });
    // A loopback address named in a forwarding header is no route either.
    const loopback = await rawCall(derived.port, {
      path: '/api/companion/endpoints',
      headers: ownerHeaders({ 'x-forwarded-proto': 'https', 'x-forwarded-host': '127.0.0.1:8797' }),
    });
    assert.deepEqual(JSON.parse(loopback.buffer.toString('utf8')).endpoints, []);
  } finally {
    await derived.close();
  }
});

test('the request-derived origin trusts the forwarding headers from a loopback peer only', () => {
  const forwarded = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'box.example.ts.net:8800' };
  assert.equal(bridgeRequestOrigin({ remoteAddress: '127.0.0.1', headers: forwarded }), 'https://box.example.ts.net:8800');
  assert.equal(bridgeRequestOrigin({ remoteAddress: '::1', headers: forwarded }), 'https://box.example.ts.net:8800');
  assert.equal(bridgeRequestOrigin({ remoteAddress: '::ffff:127.0.0.1', headers: forwarded }), 'https://box.example.ts.net:8800');
  // A peer that is not on loopback names no route, whatever it sends.
  for (const remoteAddress of ['192.168.1.44', '203.0.113.9', '100.64.0.1', '', undefined]) {
    assert.equal(bridgeRequestOrigin({ remoteAddress, headers: forwarded }), '', String(remoteAddress));
  }
  // Without a proxy the socket speaks: plain http, or https on a TLS socket.
  assert.equal(bridgeRequestOrigin({ remoteAddress: '127.0.0.1', headers: { host: 'box.example.ts.net:8080' } }), 'http://box.example.ts.net:8080');
  assert.equal(
    bridgeRequestOrigin({ remoteAddress: '127.0.0.1', encrypted: true, headers: { host: 'cdn.example' } }),
    'https://cdn.example',
  );
  // A scheme that is neither, or a host that is not one, derives nothing.
  assert.equal(
    bridgeRequestOrigin({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-proto': 'wss', host: 'box.example.ts.net:8080' } }),
    'http://box.example.ts.net:8080',
  );
  assert.equal(bridgeRequestOrigin({ remoteAddress: '127.0.0.1', headers: { host: 'localhost:8797' } }), '');
  assert.equal(bridgeRequestOrigin({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-host': 'a b', 'x-forwarded-proto': 'https' } }), '');
  assert.equal(bridgeRequestOrigin({ remoteAddress: '127.0.0.1', headers: {} }), '');
  // The configured routes win over anything a request says.
  assert.deepEqual(
    bridgeAdvertisedEndpoints({ origins: ['https://cdn.example'], remoteAddress: '127.0.0.1', headers: forwarded }),
    [{ url: 'https://cdn.example', kind: 'hosted', priority: 0 }],
  );
  assert.deepEqual(bridgeAdvertisedEndpoints({ origins: [], remoteAddress: '192.168.1.44', headers: forwarded }), []);
});

test('the advertised routes are read from Infisical by name, and an unusable value fails the start', () => {
  assert.equal(BRIDGE_ORIGIN_SECRET_NAME, 'BOTFLEET_COMPANION_BRIDGE_ORIGIN');
  assert.deepEqual([...BRIDGE_CONFIG_SECRET_NAMES], [
    'BOTFLEET_OWNER_LOGINS',
    'BOTFLEET_PUBLIC_ORIGIN',
    'BOTFLEET_SERVER_GATE_TOKEN',
    'BOTFLEET_COMPANION_BRIDGE_ORIGIN',
  ]);
  // Absent is no advertisement and not an error; the other names still read.
  const absent = bridgeConfigFromSecrets({ BOTFLEET_SERVER_GATE_TOKEN: OWNER_TOKEN, BOTFLEET_OWNER_LOGINS: 'owner@example.com' });
  assert.deepEqual(absent.origins, []);
  assert.equal(absent.tokenSha256, sha256Hex(OWNER_TOKEN));
  assert.deepEqual([...absent.owners], ['owner@example.com']);
  assert.deepEqual(bridgeConfigFromSecrets({}).origins, []);
  assert.deepEqual(bridgeConfigFromSecrets({ BOTFLEET_COMPANION_BRIDGE_ORIGIN: ' , ' }).origins, []);

  const configured = bridgeConfigFromSecrets({
    BOTFLEET_COMPANION_BRIDGE_ORIGIN: 'https://Box.Example.ts.net:8800, http://box.example.ts.net:8080',
  });
  assert.deepEqual(configured.origins, ['https://box.example.ts.net:8800', 'http://box.example.ts.net:8080']);

  // A value that is present and unusable is refused, naming the rule and
  // never the value.
  for (const bad of ['box.example.ts.net:8800', 'https://box.example.ts.net:8800/path', 'ftp://box.example.ts.net', 'https://127.0.0.1:8800']) {
    assert.throws(
      () => bridgeConfigFromSecrets({ BOTFLEET_COMPANION_BRIDGE_ORIGIN: bad }),
      (error) => {
        assert.match(error.message, /^BOTFLEET_COMPANION_BRIDGE_ORIGIN is not usable: /);
        assert.equal(error.message.includes(bad), false);
        return true;
      },
      bad,
    );
  }
});

test('the pairing body is built from the Swift types it feeds, field for field', () => {
  const response = bridgePairResponse({
    credential: 'bf_brd_fixture',
    device: { id: 'd-1', name: 'Phone', pairedAtMs: 1_700_000_000_000 },
    advertised: [{ url: 'https://box.example.ts.net:8800', kind: 'hosted', priority: 0 }],
  });
  assert.deepEqual(response, {
    token: 'bf_brd_fixture', // PairResponse.token
    device: {
      id: 'd-1', // PairedDevice.id
      name: 'Phone', // PairedDevice.name
      createdAt: 1_700_000_000_000, // PairedDevice.createdAt
      lastSeenAt: 1_700_000_000_000, // PairedDevice.lastSeenAt
    },
    serverName: 'BotFleet Server', // PairResponse.serverName
    endpoints: [{ url: 'https://box.example.ts.net:8800', kind: 'hosted', priority: 0 }], // PairResponse.endpoints
  });
  // No route to offer: the optional field is absent, not empty.
  const bare = bridgePairResponse({ credential: 'bf_brd_fixture', device: { id: 'd-1', name: 'Phone', pairedAtMs: 1 }, advertised: [] });
  assert.equal('endpoints' in bare, false);
  // The advertisement is copied, so a later edit to it cannot change a body
  // already built.
  const advertised = [{ url: 'https://box.example.ts.net:8800', kind: 'hosted', priority: 0 }];
  const copied = bridgePairResponse({ credential: 'c', device: { id: 'd-1', name: 'Phone', pairedAtMs: 1 }, advertised });
  advertised[0].url = 'https://elsewhere.example';
  assert.equal(copied.endpoints[0].url, 'https://box.example.ts.net:8800');
});

test('every forwarded route needs a paired device, and each one reaches the harness only with it', async () => {
  const reached = [];
  const bridge = await startBridge({
    harnessHandler: (req, res, info) => {
      reached.push(`${req.method} ${info.path}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
  });
  try {
    const rows = BRIDGE_ALLOWED_ROUTES.filter((route) => route.local === false && route.path !== '/api/health');
    assert.ok(rows.length >= 80, `the mirrored list has ${rows.length} rows`);
    const device = await bridge.pair('phone-every-route');

    for (const route of rows) {
      const path = samplePath(route.pattern);
      assert.equal(route.pattern.test(path), true, `${route.method} ${path}`);
      const checked = CHECKED_BODIES.find(([pattern]) => pattern.test(path));
      const body = route.method === 'GET' || route.method === 'DELETE' ? undefined : (checked ? checked[1] : '{}');
      const json = body === undefined ? {} : { 'content-type': 'application/json' };
      const label = `${route.method} ${path}`;

      // Without a device credential the bridge refuses before the harness
      // is asked, and a credential it never issued is refused the same way.
      const anonymous = await call(bridge.port, { method: route.method, path, headers: ownerHeaders(json), body });
      assert.equal(anonymous.status, 401, label);
      assert.equal(anonymous.json.error, 'device credential required', label);
      const stranger = await call(bridge.port, {
        method: route.method,
        path,
        headers: ownerHeaders({ ...json, authorization: `Bearer ${DEVICE_CREDENTIAL}` }),
        body,
      });
      assert.equal(stranger.status, 401, label);
      assert.equal(stranger.json.error, 'unknown device', label);
    }
    assert.equal(reached.length, 0, 'nothing reached the harness without a paired device');

    // With the paired device every row is forwarded, to the same path.
    for (const route of rows) {
      const path = samplePath(route.pattern);
      const checked = CHECKED_BODIES.find(([pattern]) => pattern.test(path));
      const body = route.method === 'GET' || route.method === 'DELETE' ? undefined : (checked ? checked[1] : '{}');
      const json = body === undefined ? {} : { 'content-type': 'application/json' };
      const allowed = await call(bridge.port, {
        method: route.method,
        path,
        headers: ownerHeaders({ ...json, authorization: `Bearer ${device.credential}` }),
        body,
      });
      assert.equal(allowed.status, 200, `${route.method} ${path}`);
    }
    assert.deepEqual(reached, rows.map((route) => `${route.method} ${samplePath(route.pattern)}`));
  } finally {
    await bridge.close();
  }
});

test('the forwarded request carries the companion stamp and neither credential', async () => {
  const seen = [];
  const bridge = await startBridge({
    harnessHandler: (req, res, info) => {
      seen.push({ info, headers: { ...req.headers } });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
  });
  try {
    const device = await bridge.pair('phone-stamp');
    await call(bridge.port, {
      method: 'POST',
      path: '/api/bots/b-1/messages',
      headers: ownerHeaders({
        'content-type': 'application/json',
        authorization: `Bearer ${device.credential}`,
        'x-botfleet-device': 'phone-stamp',
        'tailscale-user-login': 'owner@example.com',
        'x-forwarded-for': '203.0.113.9',
        'x-botfleet-owner-challenge': 'a'.repeat(64),
      }),
      body: '{"text":"hello"}',
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].info.path, '/api/bots/b-1/messages');
    assert.equal(seen[0].info.body, '{"text":"hello"}');
    assert.equal(seen[0].headers['x-botfleet-companion'], '1');
    // The phone's device credential is the bridge's business and the owner
    // credential is the gate's: neither means anything to the harness, so
    // neither travels. The stamp is what tells the harness a phone asked.
    for (const name of ['authorization', 'x-botfleet-device', 'x-botfleet-gate-token', 'tailscale-user-login', 'x-forwarded-for', 'x-botfleet-owner-challenge']) {
      assert.equal(seen[0].headers[name], undefined, name);
    }
    assert.equal(seen[0].headers.host, `127.0.0.1:${bridge.harness.port}`);
  } finally {
    await bridge.close();
  }
});

test('a route that must stay closed never reaches the harness, with a paired device or without', async () => {
  let reached = 0;
  const bridge = await startBridge({
    harnessHandler: (req, res) => {
      reached += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
  });
  try {
    const device = await bridge.pair('phone-closed-routes');
    for (const [method, path, status] of [
      // The sidecar's cloud desktop route, which needs a per-device grant
      // the bridge cannot give.
      ['POST', '/api/bots/b-1/computer/join', 404],
      ['POST', '/api/bots/x/y/computer/join', 404],
      // A route the harness has and the sidecar keeps off the phone.
      ['POST', '/api/bots/b-1/always-allow', 404],
      ['POST', '/api/bots/b-1/skills', 405],
      ['POST', '/api/bots/apply-defaults', 405],
      ['POST', '/api/webhooks', 404],
      ['DELETE', '/api/connectors/github', 404],
      ['GET', '/api/runtime', 404],
      ['GET', '/api/host/resources', 404],
      ['GET', '/api/placement/identity', 404],
      ['POST', '/api/system/control/stop', 404],
      ['GET', '/api/fleet', 404],
      ['GET', '/api/threads/t-1', 404],
      // An id with an encoded character in it.
      ['POST', '/api/bots/b%2D1/messages', 404],
      ['GET', '/api/bots/%252e', 404],
      ['GET', '/api/threads/t-1/messages/m%2E1/image', 404],
    ]) {
      const label = `${method} ${path}`;
      const body = method === 'GET' ? undefined : '{}';
      const json = body === undefined ? {} : { 'content-type': 'application/json' };
      const withDevice = await call(bridge.port, { method, path, headers: ownerHeaders({ ...json, authorization: `Bearer ${device.credential}` }), body });
      assert.equal(withDevice.status, status, label);
      assert.equal(withDevice.json.ok, undefined, label);
      const withoutDevice = await call(bridge.port, { method, path, headers: ownerHeaders(json), body });
      assert.equal(withoutDevice.status, status, label);
    }
    assert.equal(reached, 0);
  } finally {
    await bridge.close();
  }
});

test('the profile and organize bodies are checked before they reach the harness, and forwarded re-serialized', async () => {
  const seen = [];
  const bridge = await startBridge({
    harnessHandler: (req, res, info) => {
      seen.push(info);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
  });
  try {
    const device = await bridge.pair('phone-body-check');
    const auth = ownerHeaders({ 'content-type': 'application/json', authorization: `Bearer ${device.credential}` });

    for (const [path, body, status, error] of [
      ['/api/bots/b-1/profile', '{"name":"Rio","ownMcpServers":{"a":{"command":"x"}}}', 403, 'ownMcpServers can only be changed in BotFleet on your computer'],
      ['/api/bots/b-1/profile', '{"mcpServers":["a"]}', 403, 'mcpServers can only be changed in BotFleet on your computer'],
      ['/api/bots/b-1/profile', '{"composio":{"connected":true}}', 403, 'composio can only be changed in BotFleet on your computer'],
      ['/api/bots/b-1/profile', '{"cloudBackend":"x"}', 403, 'cloudBackend can only be changed in BotFleet on your computer'],
      ['/api/bots/b-1/profile', '{"extraCwds":["/"]}', 403, 'extraCwds can only be changed in BotFleet on your computer'],
      ['/api/bots/b-1', '{"hidden":true,"autoApprove":true}', 403, 'autoApprove can only be changed in BotFleet on your computer'],
      ['/api/bots/b-1', '{"computers":["local"]}', 403, 'computers can only be changed in BotFleet on your computer'],
      ['/api/bots/b-1', '{"name":"Rio"}', 403, 'name can only be changed in BotFleet on your computer'],
      ['/api/bots/b-1', '{"hidden":"yes"}', 400, 'hidden must be true or false'],
      ['/api/bots/b-1', '{"pinnedMessageId":"../m-1"}', 400, 'pinnedMessageId must be a message id or null'],
      ['/api/bots/b-1', '{}', 400, 'nothing to save'],
      ['/api/bots/b-1', 'nope', 400, 'the request body is not valid JSON'],
      ['/api/bots/b-1/profile', '[]', 400, 'the request body is not a JSON object'],
    ]) {
      const refused = await call(bridge.port, { method: 'PATCH', path, headers: auth, body });
      assert.equal(refused.status, status, `${path} ${body}`);
      assert.deepEqual(refused.json, { error }, `${path} ${body}`);
    }
    assert.equal(seen.length, 0, 'none of them reached the harness');

    // A body that passes crosses as the validated object: re-serialized, so
    // the bytes the harness reads are the bytes the bridge checked.
    await call(bridge.port, { method: 'PATCH', path: '/api/bots/b-1/profile', headers: auth, body: '{ "name" :  "Rio" , "autoApprove": false }' });
    await call(bridge.port, { method: 'PATCH', path: '/api/bots/b-1', headers: auth, body: '{"pinned":true,"section":"Work"}' });
    assert.deepEqual(
      seen.map((info) => `${info.path} ${info.body}`),
      ['/api/bots/b-1/profile {"name":"Rio","autoApprove":false}', '/api/bots/b-1 {"pinned":true,"section":"Work"}'],
    );

    // Without a device credential the body is refused before it is read.
    const anonymous = await call(bridge.port, {
      method: 'PATCH',
      path: '/api/bots/b-1/profile',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: '{"name":"Rio"}',
    });
    assert.equal(anonymous.status, 401);
    assert.equal(seen.length, 2);
  } finally {
    await bridge.close();
  }
});

test('a checked body that is too large is refused before it is read', async () => {
  const bridge = await startBridge();
  try {
    const device = await bridge.pair('phone-big-body');
    const refused = await call(bridge.port, {
      method: 'PATCH',
      path: '/api/bots/b-1/profile',
      headers: ownerHeaders({ 'content-type': 'application/json', authorization: `Bearer ${device.credential}` }),
      body: JSON.stringify({ name: 'x'.repeat(70 * 1024) }),
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.error, 'the request body is too large');
  } finally {
    await bridge.close();
  }
});

test('JSON responses reach the phone without the withheld keys, and everything else byte for byte', async () => {
  // Spacing, number spelling and key order that a re-serialization would
  // not give back: proof that a clean body is never parsed.
  const clean = '{ "app": "botfleet", "ready": true, "n": 1.50, "bots": [ ] }';
  const dirty = '{ "vps": { "configured": true, "sshAlias": "prod-vps" }, "bots": [ { "id": "b1", "resumeCursors": { "g": "s" } } ] }';
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xc3, 0xa9, 0x00]);
  // A body that names a withheld key nested past any plausible stack: it
  // parses, and the scrubber's recursion gives out.
  const deep = `${'['.repeat(20_000)}{"sshAlias":"prod-vps"}${']'.repeat(20_000)}`;
  const answers = {
    '/api/instances': { type: 'application/json', body: Buffer.from(clean, 'utf8') },
    '/api/config': { type: 'application/json', body: Buffer.from(dirty, 'utf8') },
    '/api/quotas': { type: 'application/problem+json; charset=utf-8', body: Buffer.from(dirty, 'utf8') },
    '/api/attachments/a.png': { type: 'image/png', body: image },
    '/api/search?q=a%20b': { type: 'application/json', body: Buffer.from('{ "hits": [ { "text": "resume cursors and an ssh alias in prose" } ] }', 'utf8') },
    '/api/jobs': { type: 'application/json', body: Buffer.from(deep, 'utf8') },
  };
  const bridge = await startBridge({
    harnessHandler: (req, res, info) => {
      const answer = answers[`${info.path}${info.query}`];
      assert.ok(answer, `unexpected ${info.path}${info.query}`);
      res.writeHead(200, { 'content-type': answer.type, 'content-length': String(answer.body.length) });
      res.end(answer.body);
    },
  });
  try {
    const device = await bridge.pair('phone-scrub');
    const get = async (path) => {
      const response = await rawCall(bridge.port, { path, headers: ownerHeaders({ authorization: `Bearer ${device.credential}` }) });
      return { ...response, text: response.buffer.toString('utf8') };
    };

    const cleanAnswer = await get('/api/instances');
    assert.equal(cleanAnswer.status, 200);
    assert.equal(cleanAnswer.text, clean);
    assert.equal(cleanAnswer.headers['content-length'], String(Buffer.byteLength(clean)));
    assert.equal(cleanAnswer.headers['content-type'], 'application/json');

    const scrubbed = await get('/api/config');
    assert.equal(scrubbed.status, 200);
    assert.equal(scrubbed.text.includes('sshAlias'), false);
    assert.equal(scrubbed.text.includes('prod-vps'), false);
    assert.equal(scrubbed.text.includes('resumeCursors'), false);
    assert.deepEqual(JSON.parse(scrubbed.text), { vps: { configured: true }, bots: [{ id: 'b1' }] });
    assert.equal(scrubbed.headers['content-length'], String(Buffer.byteLength(scrubbed.text)));
    assert.equal(scrubbed.headers['content-type'], 'application/json');

    // The structured suffix counts as JSON, so an error body cannot carry
    // a withheld key past the scrubber.
    const problem = await get('/api/quotas');
    assert.equal(problem.status, 200);
    assert.equal(problem.text.includes('sshAlias'), false);
    assert.deepEqual(JSON.parse(problem.text), { vps: { configured: true }, bots: [{ id: 'b1' }] });
    assert.equal(problem.headers['content-type'], 'application/problem+json; charset=utf-8');

    // Prose that merely resembles a withheld key is not touched.
    const prose = await get('/api/search?q=a%20b');
    assert.equal(prose.text, answers['/api/search?q=a%20b'].body.toString('utf8'));

    // Anything that is not JSON is not parsed: the bytes are the bytes.
    const picture = await get('/api/attachments/a.png');
    assert.equal(picture.status, 200);
    assert.ok(picture.buffer.equals(image));

    // A body the scrubber cannot finish is not forwarded at all.
    const unfinished = await get('/api/jobs');
    assert.equal(unfinished.status, 502);
    assert.deepEqual(JSON.parse(unfinished.text), { error: 'the response could not be prepared for this device' });
  } finally {
    await bridge.close();
  }
});

test('an event stream is scrubbed frame by frame, keeps its framing, and still ends when the device is revoked', async () => {
  const streams = [];
  const bridge = await startBridge({
    harnessHandler: (req, res, info) => {
      if (info.path !== '/api/events') {
        res.writeHead(200);
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.socket?.setNoDelay(true);
      res.write(': keepalive\n\n');
      res.write('id: a:1\ndata: {"kind":"bot","bot":{"id":"b1","resumeCursors":{"g":"s"}}}\n\n');
      // One event in three writes, the first cut inside a two-byte character
      // and the second cut inside the terminator.
      const frame = Buffer.from(
        'id: a:2\ndata: {"kind":"config","text":"caf\u00e9","vps":{"sshAlias":"prod-vps","configured":true}}\n\n',
        'utf8',
      );
      const accent = frame.indexOf(Buffer.from('\u00e9', 'utf8'));
      res.write(frame.subarray(0, accent + 1));
      setTimeout(() => res.write(frame.subarray(accent + 1, frame.length - 1)), 10);
      setTimeout(() => res.write(frame.subarray(frame.length - 1)), 20);
      streams.push(res);
    },
  });
  try {
    const device = await bridge.pair('phone-sse-scrub');
    const collected = [];
    let ended = false;
    const stream = http.request(
      {
        hostname: '127.0.0.1',
        port: bridge.port,
        path: '/api/events?screens=off&since=%3Ccursor%3A1%3E',
        method: 'GET',
        headers: ownerHeaders({ authorization: `Bearer ${device.credential}`, accept: 'text/event-stream' }),
      },
      (response) => {
        assert.equal(response.statusCode, 200);
        assert.ok(String(response.headers['content-type']).includes('text/event-stream'));
        response.on('data', (chunk) => collected.push(chunk));
        for (const event of ['end', 'close', 'error']) response.on(event, () => { ended = true; });
      },
    );
    stream.on('error', () => { ended = true; });
    stream.end();

    const text = () => Buffer.concat(collected).toString('utf8');
    const frames = () => text().split('\n\n').length - 1;
    const deadline = Date.now() + 3000;
    while (frames() < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const streamed = text();
    // The comment, both ids and both terminators crossed, and nothing was
    // rewritten: one blank line after each event and no extra bytes.
    assert.ok(streamed.startsWith(': keepalive\n\n'));
    assert.ok(streamed.includes('id: a:1\ndata: '));
    assert.ok(streamed.includes('id: a:2\ndata: '));
    assert.equal(frames(), 3);
    // The withheld keys did not cross, under either spelling or nesting.
    assert.equal(streamed.includes('resumeCursors'), false);
    assert.equal(streamed.includes('"g":"s"'), false);
    assert.equal(streamed.includes('sshAlias'), false);
    assert.equal(streamed.includes('prod-vps'), false);
    // What the phone renders survived, and the character split across two
    // chunks arrived whole.
    const data = streamed.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice('data: '.length)));
    assert.deepEqual(data, [
      { kind: 'bot', bot: { id: 'b1' } },
      { kind: 'config', text: 'caf\u00e9', vps: { configured: true } },
    ]);

    // Revoking the device still ends the stream at once.
    const revoked = await call(bridge.port, { method: 'DELETE', path: `/api/companion/devices/${device.deviceId}` });
    assert.equal(revoked.status, 200);
    const closeDeadline = Date.now() + 3000;
    while (!ended && Date.now() < closeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(ended, true, 'the stream ended after the revoke');
    stream.destroy();
  } finally {
    for (const stream of streams) stream.destroy();
    await bridge.close();
  }
});

test('an event stream the scrubber cannot hold is ended, never forwarded half an event', async () => {
  const streams = [];
  const bridge = await startBridge({
    harnessHandler: (req, res, info) => {
      if (info.path !== '/api/events') {
        res.writeHead(200);
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      // One megabyte and more of an event that never ends.
      res.write(`data: ${'x'.repeat(1024 * 1024 + 4096)}`);
      streams.push(res);
    },
  });
  try {
    const device = await bridge.pair('phone-sse-overflow');
    const response = await new Promise((resolve) => {
      const request = http.request(
        {
          hostname: '127.0.0.1',
          port: bridge.port,
          path: '/api/events',
          method: 'GET',
          headers: ownerHeaders({ authorization: `Bearer ${device.credential}` }),
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          const finish = () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') });
          res.on('end', finish);
          res.on('close', finish);
          res.on('error', finish);
        },
      );
      request.on('error', () => resolve({ status: 0, text: '' }));
      request.end();
    });
    // The stream is cut and nothing of the oversized event crosses. The
    // downstream headers are written but not flushed until the first byte
    // crosses, and no byte ever does here, so the phone sees the connection
    // reset before any status rather than a 200 that ends empty.
    assert.ok(response.status === 0 || response.status === 200, `status ${response.status}`);
    assert.equal(response.text.length, 0);
  } finally {
    for (const stream of streams) stream.destroy();
    await bridge.close();
  }
});

test('an answer that finds no room to be held for checking is refused at once, and the room comes back', async () => {
  const held = [];
  const bridge = await startBridge({
    harnessHandler: (req, res, info) => {
      if (info.query.startsWith('?hold=')) {
        // An answer that begins and then waits, so the bridge is holding it.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"held":"');
        res.write(info.query.slice(6));
        held.push({ number: info.query.slice(6), res });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
  });
  try {
    const device = await bridge.pair('phone-scrub-ceiling');
    const headers = ownerHeaders({ authorization: `Bearer ${device.credential}` });
    const open = (path) => openProxied(bridge.port, path, headers);
    const heldSoFar = () => held.length;
    const untilHeld = async (count) => {
      while (heldSoFar() < count) await new Promise((resolve) => setTimeout(resolve, 5));
    };
    const answer = (number) => held.find((entry) => entry.number === number).res;

    // Two answers are held; the third finds no room and is told to retry.
    const first = open('/api/quotas?hold=1');
    const second = open('/api/quotas?hold=2');
    await untilHeld(2);
    const third = await open('/api/quotas?hold=3').promise;
    assert.equal(third.status, 503);
    assert.equal(third.retryAfter, '1');
    assert.match(JSON.parse(third.text).error, /too many answers/);

    // The bridge can only know an answer is JSON once its headers arrive, so
    // the harness began the third answer too. The bridge let go of that one
    // the moment it saw them, which is what keeps its own memory bounded.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(heldSoFar(), 3);

    // The room comes back as the held answers finish, whole and untouched.
    answer('1').end('"}');
    answer('2').end('"}');
    assert.deepEqual(JSON.parse((await first.promise).text), { held: '1' });
    assert.deepEqual(JSON.parse((await second.promise).text), { held: '2' });
    const after = await open('/api/quotas').promise;
    assert.equal(after.status, 200);
    assert.equal(after.text, '{"ok":true}');

    // A phone that vanishes mid-answer gives the room back too.
    const vanished = open('/api/quotas?hold=4');
    await untilHeld(4);
    vanished.abort();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const fifth = open('/api/quotas?hold=5');
    const sixth = open('/api/quotas?hold=6');
    await untilHeld(6);
    const seventh = await open('/api/quotas?hold=7').promise;
    assert.equal(seventh.status, 503, 'two are held again, so the ceiling is back in force');
    answer('5').end('"}');
    answer('6').end('"}');
    await Promise.all([fifth.promise, sixth.promise]);
  } finally {
    for (const entry of held.splice(0)) entry.res.destroy();
    await bridge.close();
  }
});

test('an answer torn down with nothing but a close gives its room back, and the phone hears why', async () => {
  const held = [];
  const bridge = await startBridge({
    harnessHandler: (req, res, info) => {
      if (info.query.startsWith('?cut=')) {
        // An answer that begins, and whose connection then goes away.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"cut":"');
        setTimeout(() => res.socket.destroy(), 30);
        return;
      }
      if (info.query.startsWith('?hold=')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"held":"');
        res.write(info.query.slice(6));
        held.push({ number: info.query.slice(6), res });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
  });
  // A teardown the bridge hears nothing from but `close`:  on the bridge's
  // own connections to the harness, the events it otherwise learns a cut
  // answer from are kept from it.
  const emit = http.IncomingMessage.prototype.emit;
  http.IncomingMessage.prototype.emit = function (event, ...args) {
    if (this.socket?.remotePort === bridge.harness.port && (event === 'aborted' || event === 'error')) return true;
    return emit.call(this, event, ...args);
  };
  try {
    const device = await bridge.pair('phone-scrub-close');
    const open = (path) => openProxied(bridge.port, path, ownerHeaders({ authorization: `Bearer ${device.credential}` }));
    const cut = await Promise.race([open('/api/quotas?cut=1').promise,
      new Promise((resolve) => setTimeout(() => resolve({ status: 'still waiting', text: '' }), 2000))]);
    assert.equal(cut.status, 502);
    assert.deepEqual(JSON.parse(cut.text), { error: 'the harness did not finish its answer' });
    // The room that answer took is back: two more are held at once again.
    const second = open('/api/quotas?hold=2');
    const third = open('/api/quotas?hold=3');
    assert.equal(await eventually(() => held.length, 2), true, 'two answers are held, so the room came back');
    for (const entry of held.splice(0)) entry.res.end('"}');
    assert.deepEqual(JSON.parse((await second.promise).text), { held: '2' });
    assert.deepEqual(JSON.parse((await third.promise).text), { held: '3' });
  } finally {
    http.IncomingMessage.prototype.emit = emit;
    for (const entry of held.splice(0)) entry.res.destroy();
    await bridge.close();
  }
});

test('a pairing window can be closed, and its code and its QR credential stop working', async () => {
  let savesWork = true;
  const bridge = await startBridge({ bridgeOptions: { persist: () => savesWork } });
  const owner = ownerHeaders({ 'content-type': 'application/json' });
  const close = () => call(bridge.port, { method: 'POST', path: '/api/companion/pairing/close', headers: owner, body: '{}' });
  const open = () => call(bridge.port, { method: 'POST', path: '/api/companion/pairing/open', headers: owner, body: '{}' });
  const redeem = (field, value) => call(bridge.port, {
    method: 'POST', path: '/api/pair', headers: owner,
    body: JSON.stringify({ [field]: value, deviceName: 'phone-close', pairRequestId: `close-${field}` }),
  });
  try {
    // Nothing is open, so there is nothing to close.
    const idle = await close();
    assert.equal(idle.status, 200);
    assert.deepEqual(idle.json, { closed: false });

    const first = await open();
    assert.equal(first.status, 200);
    assert.ok(first.json.code && first.json.token);

    // A close the durable state cannot hold is not a close: the window is
    // put back, and its QR credential still pairs a phone.
    savesWork = false;
    const refused = await close();
    assert.equal(refused.status, 503);
    assert.match(refused.json.error, /could not be saved/);
    savesWork = true;
    const stillOpen = await redeem('credential', first.json.token);
    assert.equal(stillOpen.status, 201);

    const second = await open();
    assert.equal(second.status, 200);
    const closed = await close();
    assert.equal(closed.status, 200);
    assert.deepEqual(closed.json, { closed: true });

    // The code and the QR credential are both dead, and each refusal says so
    // without spending anything there is left to spend.
    const byCode = await redeem('code', second.json.code);
    assert.equal(byCode.status, 401);
    const byToken = await redeem('credential', second.json.token);
    assert.equal(byToken.status, 401);

    const devices = await call(bridge.port, { path: '/api/companion/devices' });
    assert.equal(devices.json.devices.length, 1, 'only the phone paired before the close');
  } finally {
    await bridge.close();
  }
});
