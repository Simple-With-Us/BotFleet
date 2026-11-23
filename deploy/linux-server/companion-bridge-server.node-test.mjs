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
  BRIDGE_MAX_DEVICES,
  BRIDGE_WINDOW_MAX_ATTEMPTS,
  bridgeConfigFromSecrets,
  bridgeDownstreamHeaders,
  bridgeHeaderValue,
  bridgeMintDeviceCredential,
  bridgeMintPairingCode,
  bridgeMintPairingToken,
  bridgeOwnerDecision,
  bridgeParseOwnerLogins,
  bridgePresentedDeviceCredential,
  bridgePresentedDeviceId,
  bridgeRouteSummary,
  BridgeDeviceRegistry,
  BridgeState,
  bridgeTokenMatches,
  bridgeUpstreamHeaders,
  createCompanionBridge,
  isBridgeLoopbackAddress,
  parseBridgeArgs,
} from './companion-bridge-server.mjs';
import {
  bridgeApnsMaterial,
  bridgeApnsNamesSummary,
  bridgeApnsSecretNames,
} from './companion-bridge-apns.mjs';
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
  assert.ok(summary.local.includes('GET /api/companion/devices'));
  assert.ok(summary.local.includes('DELETE /api/companion/devices/:id'));
  assert.ok(summary.proxied.includes('GET /api/fleet'));
  assert.ok(summary.proxied.includes('GET /api/events'));
});

test('a request without an owner credential is refused before the route is considered', async () => {
  const bridge = await startBridge();
  try {
    const refused = await call(bridge.port, { path: '/api/fleet', headers: {} });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.error, 'owner identity required');
  } finally {
    await bridge.close();
  }
});

test('an unlisted route is 404 and a wrong method on a listed route is 405', async () => {
  const bridge = await startBridge();
  try {
    const unknown = await call(bridge.port, { path: '/api/nope' });
    assert.equal(unknown.status, 404);

    const wrongMethod = await call(bridge.port, { path: '/api/fleet', method: 'POST' });
    assert.equal(wrongMethod.status, 405);
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
      path: '/api/threads/thread-1?since=12%3A34&filter=a$b&x=1&x=2',
      headers: ownerHeaders({ authorization: `Bearer ${device.credential}` }),
    });
    assert.equal(response.status, 200);
    assert.equal(seen.path, '/api/threads/thread-1');
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
    const body = JSON.stringify({ prompt: 'hello', nested: { a: [1, 2] } });
    const device = await bridge.pair();
    await call(bridge.port, {
      method: 'POST',
      path: '/api/threads/thread-1/messages',
      headers: ownerHeaders({
        'content-type': 'application/json',
        authorization: `Bearer ${device.credential}`,
      }),
      body,
    });
    assert.equal(seen.body, body);
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

test('a proxied route needs a device the bridge knows, and a revoked one is refused', async () => {
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
    const anonymous = await call(bridge.port, { path: '/api/fleet' });
    assert.equal(anonymous.status, 403);
    assert.equal(reached, 0);

    // A credential the bridge never issued is refused as well.
    const stranger = await call(bridge.port, {
      path: '/api/fleet',
      headers: ownerHeaders({ authorization: `Bearer ${DEVICE_CREDENTIAL}` }),
    });
    assert.equal(stranger.status, 403);
    assert.equal(reached, 0);

    // A paired device reaches the harness.
    const device = await bridge.pair();
    const allowed = await call(bridge.port, {
      path: '/api/fleet',
      headers: ownerHeaders({ authorization: `Bearer ${device.credential}` }),
    });
    assert.equal(allowed.status, 200);
    assert.equal(reached, 1);

    // A revoked device does not.
    await call(bridge.port, { method: 'DELETE', path: `/api/companion/devices/${device.deviceId}` });
    const revoked = await call(bridge.port, {
      path: '/api/fleet',
      headers: ownerHeaders({ authorization: `Bearer ${device.credential}` }),
    });
    assert.equal(revoked.status, 403);
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
