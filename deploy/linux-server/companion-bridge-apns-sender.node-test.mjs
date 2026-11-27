// Pure-Node Linux companion bridge APNs sender tests (BF-2652).
//
// Everything runs offline with an ephemeral EC P-256 key generated at runtime
// and an injected `sendImpl` fake — zero real APNs traffic and zero literal
// private-key fixtures.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  APNS_CIRCUIT_WINDOW_MS,
  APNS_DISPATCH_CONCURRENCY,
  APNS_TOKEN_TTL_MS,
  APNS_TRANSPORT_BREAKER_THRESHOLD,
  createApnsProviderToken,
  createBridgeApnsSender,
  DEFAULT_APNS_BUNDLE_ID,
} from './companion-bridge-apns-sender.mjs';

function makeEphemeralEcPrivateKeyPem() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    p8: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey,
  };
}

test('createApnsProviderToken signs a valid ES256 JWT verifiable with the EC public key', () => {
  const { p8, publicKey } = makeEphemeralEcPrivateKeyPem();
  const jwt = createApnsProviderToken({
    keyId: 'ABC1234567',
    teamId: 'CC8UTF7ATG',
    p8,
    issuedAtSec: 1_700_000_000,
  });
  const [headerB64, claimsB64, sigB64] = jwt.split('.');
  assert.ok(headerB64 && claimsB64 && sigB64);
  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(claimsB64, 'base64url').toString('utf8'));
  assert.deepEqual(header, { alg: 'ES256', kid: 'ABC1234567' });
  assert.deepEqual(claims, { iss: 'CC8UTF7ATG', iat: 1_700_000_000 });
  const verified = crypto.verify(
    'sha256',
    Buffer.from(`${headerB64}.${claimsB64}`, 'utf8'),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(sigB64, 'base64url'),
  );
  assert.equal(verified, true);
});

test('sendAlert and sendLiveActivity enforce the one-sender rule and APNs headers', async () => {
  const { p8 } = makeEphemeralEcPrivateKeyPem();
  const sent = [];
  let clock = 1_700_000_000_000;
  const sender = createBridgeApnsSender({
    material: { available: true, keyId: 'KEYID12345', teamId: 'CC8UTF7ATG', p8, reason: '' },
    now: () => clock,
    sendImpl: async (req) => {
      sent.push(req);
      return { status: 200 };
    },
  });

  const macOwned = await sender.sendAlert({
    deviceId: 'd-1',
    token: 'a'.repeat(64),
    title: 'Approval',
    body: 'Allow?',
    serverOwnsPairing: false,
    macOwnsPairing: true,
  });
  assert.equal(macOwned.skipped, true);
  assert.equal(sent.length, 0);

  const okAlert = await sender.sendAlert({
    deviceId: 'd-1',
    token: 'a'.repeat(64),
    title: 'Approval',
    body: 'Allow?',
    threadId: 't-1',
    botId: 'b-1',
    kind: 'approval',
    requestId: 'req-1',
    seq: 42,
  });
  assert.equal(okAlert.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].host, 'api.push.apple.com');
  assert.equal(sent[0].path, `/3/device/${'a'.repeat(64)}`);
  assert.equal(sent[0].headers['apns-topic'], DEFAULT_APNS_BUNDLE_ID);
  assert.equal(sent[0].headers['apns-push-type'], 'alert');
  assert.equal(sent[0].headers['apns-priority'], '10');
  const alertBody = JSON.parse(sent[0].body);
  assert.equal(alertBody.aps.category, 'BOTFLEET_APPROVAL');
  assert.equal(alertBody.seq, 42);

  const okLive = await sender.sendLiveActivity({
    deviceId: 'd-1',
    token: 'b'.repeat(64),
    event: 'start',
    attributes: { botId: 'b-1', threadId: 't-1', name: 'Bot', color: 'blue' },
    state: { face: 'thinking', kind: 'needsYou', headline: 'Bot needs you', line: 'Allow?', options: ['Allow', 'Deny'], isPermission: true, since: 100 },
    timestamp: 1_700_000_001,
  });
  assert.equal(okLive.ok, true);
  assert.equal(sent[1].headers['apns-topic'], `${DEFAULT_APNS_BUNDLE_ID}.push-type.liveactivity`);
  assert.equal(sent[1].headers['apns-push-type'], 'liveactivity');
  assert.equal(sent[1].headers['apns-priority'], '10');
  const liveBody = JSON.parse(sent[1].body);
  assert.equal(liveBody.aps['attributes-type'], 'BotActivityAttributes');
  assert.equal(liveBody.aps.event, 'start');

  // Cached token is reused before TTL and refreshed after TTL.
  const firstAuth = sent[0].headers.authorization;
  assert.equal(sent[1].headers.authorization, firstAuth);
  clock += APNS_TOKEN_TTL_MS + 1000;
  await sender.sendAlert({ deviceId: 'd-1', token: 'a'.repeat(64), title: 'Next', body: 'Ping', kind: 'done' });
  assert.notEqual(sent[2].headers.authorization, firstAuth);

  const health = sender.health(1);
  assert.equal(health.configured, true);
  assert.equal(health.production, true);
  assert.equal(health.tokensRegistered, 1);
  assert.equal(health.sent, 3);
  assert.equal(health.failed, 0);
  assert.equal(JSON.stringify(health).includes('KEYID12345'), false);
  assert.equal(JSON.stringify(health).includes('CC8UTF7ATG'), false);
});

test('410 dead token purges token, 403 key fault latches sending off, and ExpiredProviderToken retries once', async () => {
  const { p8 } = makeEphemeralEcPrivateKeyPem();
  const expiredToken = 'Expired' + 'ProviderToken';
  const invalidToken = 'Invalid' + 'ProviderToken';
  let mode = 'expired-once';
  let calls = 0;
  const forgotten = [];

  const sender = createBridgeApnsSender({
    material: { available: true, keyId: 'KEYID12345', teamId: 'CC8UTF7ATG', p8, reason: '' },
    sendImpl: async () => {
      calls += 1;
      if (mode === 'expired-once' && calls === 1) return { status: 403, reason: expiredToken };
      if (mode === 'expired-once') return { status: 200 };
      if (mode === 'dead-token') return { status: 410, reason: 'Unregistered' };
      if (mode === 'key-fault') return { status: 403, reason: invalidToken };
      return { status: 0, reason: 'SendFailed', errorCode: 'ECONNRESET' };
    },
  });

  const retried = await sender.sendAlert({ deviceId: 'd-1', token: 'c'.repeat(64), title: 'T', body: 'B' });
  assert.equal(retried.ok, true);
  assert.equal(calls, 2);

  mode = 'dead-token';
  const dead = await sender.sendAlert({
    deviceId: 'd-1',
    token: 'c'.repeat(64),
    title: 'T',
    body: 'B',
    onInvalidToken: (id, tok) => forgotten.push([id, tok]),
  });
  assert.equal(dead.ok, false);
  assert.equal(dead.status, 410);
  assert.deepEqual(forgotten, [['d-1', 'c'.repeat(64)]]);

  mode = 'transport';
  const netErr = await sender.sendAlert({ deviceId: 'd-2', token: 'd'.repeat(64), title: 'T', body: 'B' });
  assert.equal(netErr.ok, false);
  assert.equal(sender.health(1).consecutiveTransportFailures, 1);
  assert.equal(sender.health(1).lastErrorCode, 'ECONNRESET');

  mode = 'key-fault';
  const keyErr = await sender.sendAlert({ deviceId: 'd-2', token: 'd'.repeat(64), title: 'T', body: 'B' });
  assert.equal(keyErr.ok, false);
  assert.equal(sender.health(1).keyRejected, `403 ${invalidToken}`);
  const blockedAfterFault = await sender.sendAlert({ deviceId: 'd-2', token: 'd'.repeat(64), title: 'T', body: 'B' });
  assert.equal(blockedAfterFault.skipped, true);
});

test('dispatchHarnessNotification skips foreground SSE devices and sends Live Activity on blocking notifications', async () => {
  const { p8 } = makeEphemeralEcPrivateKeyPem();
  const sent = [];
  const sender = createBridgeApnsSender({
    material: { available: true, keyId: 'KEYID12345', teamId: 'CC8UTF7ATG', p8, reason: '' },
    sendImpl: async (req) => {
      sent.push(req);
      return { status: 200 };
    },
  });

  const targets = [
    { deviceId: 'online-phone', pushToken: '1'.repeat(64), liveActivityToken: '2'.repeat(64) },
    { deviceId: 'bg-phone', pushToken: '3'.repeat(64), liveActivityToken: '4'.repeat(64) },
  ];

  const outcomes = await sender.dispatchHarnessNotification({
    notification: {
      title: 'Forge',
      body: 'Approve bash command?',
      kind: 'approval',
      threadId: 'thread-7',
      botId: 'bot-1',
      botName: 'Forge',
      requestId: 'req-9',
    },
    seq: 88,
    targets,
    activeDeviceIds: ['online-phone'],
  });

  assert.equal(outcomes.length, 2);
  assert.deepEqual(outcomes.map((o) => [o.channel, o.deviceId, o.ok]), [
    ['alert', 'bg-phone', true],
    ['liveactivity', 'bg-phone', true],
  ]);
  assert.equal(sent.length, 2);
});

test('invalid device tokens fail before HTTP/2, transport breaker sheds load and recovers, and dispatch fans out concurrently', async () => {
  const { p8 } = makeEphemeralEcPrivateKeyPem();
  let clock = 1_700_000_000_000;
  let transportDown = true;
  let sendCalls = 0;
  const invalidCalls = [];

  const sender = createBridgeApnsSender({
    material: { available: true, keyId: 'KEYID12345', teamId: 'CC8UTF7ATG', p8, reason: '' },
    now: () => clock,
    sendImpl: async () => {
      sendCalls += 1;
      if (transportDown) return { status: 0, reason: 'SendFailed', errorCode: 'ECONNREFUSED' };
      return { status: 200 };
    },
  });

  // Malformed device token is refused before sendImpl is invoked.
  const bad = await sender.sendAlert({
    deviceId: 'd-bad',
    token: '../evil?x=1',
    title: 'T',
    body: 'B',
    onInvalidToken: (id, tok) => invalidCalls.push([id, tok]),
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.reason, 'BadDeviceToken');
  assert.equal(sendCalls, 0);
  assert.deepEqual(invalidCalls, [['d-bad', '../evil?x=1']]);

  // Trip the transport breaker after APNS_TRANSPORT_BREAKER_THRESHOLD consecutive failures.
  for (let i = 0; i < APNS_TRANSPORT_BREAKER_THRESHOLD; i += 1) {
    const res = await sender.sendAlert({ deviceId: 'd-1', token: 'a'.repeat(64), title: 'T', body: 'B' });
    assert.equal(res.status, 0);
  }
  assert.equal(sendCalls, APNS_TRANSPORT_BREAKER_THRESHOLD);

  const shed = await sender.sendAlert({ deviceId: 'd-1', token: 'a'.repeat(64), title: 'T', body: 'B' });
  assert.equal(shed.skipped, true);
  assert.equal(shed.reason, 'apns-circuit-open');
  assert.equal(sendCalls, APNS_TRANSPORT_BREAKER_THRESHOLD);
  assert.equal(sender.health(1).circuitDropped, 1);
  assert.equal(sender.health(1).dropped, 1);

  // After the circuit window elapses and transport recovers, consecutive failures reset.
  clock += APNS_CIRCUIT_WINDOW_MS + 1;
  transportDown = false;
  const recovered = await sender.sendAlert({ deviceId: 'd-1', token: 'a'.repeat(64), title: 'T', body: 'B' });
  assert.equal(recovered.ok, true);
  assert.equal(sender.health(1).consecutiveTransportFailures, 0);

  // Concurrent dispatch starts both sends before either resolves.
  let inFlight = 0;
  let peakInFlight = 0;
  const concurrentSender = createBridgeApnsSender({
    material: { available: true, keyId: 'KEYID12345', teamId: 'CC8UTF7ATG', p8, reason: '' },
    sendImpl: async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
      return { status: 200 };
    },
  });
  const parallelOutcomes = await concurrentSender.dispatchHarnessNotification({
    notification: { title: 'Forge', body: 'Approve?', kind: 'approval', threadId: 't-1', botId: 'b-1' },
    targets: Array.from({ length: 12 }, (_, idx) => ({
      deviceId: `p-${idx}`,
      pushToken: `${(idx % 9) + 1}`.repeat(64),
    })),
    activeDeviceIds: [],
  });
  assert.equal(parallelOutcomes.length, 12);
  assert.ok(peakInFlight >= 2, 'dispatch runs targets concurrently');
  assert.ok(peakInFlight <= APNS_DISPATCH_CONCURRENCY, `peak ${peakInFlight} stays within pool limit`);

  // A synchronous throw on one target does not abort or orphan remaining targets.
  const isolatedSender = createBridgeApnsSender({
    material: { available: true, keyId: 'KEYID12345', teamId: 'CC8UTF7ATG', p8, reason: '' },
    sendImpl: async () => ({ status: 200 }),
  });
  let throwOnce = true;
  const origSendAlert = isolatedSender.sendAlert;
  isolatedSender.sendAlert = (opts) => {
    if (throwOnce) {
      throwOnce = false;
      throw new Error('sync fault');
    }
    return origSendAlert(opts);
  };
  const isolatedOutcomes = await isolatedSender.dispatchHarnessNotification({
    notification: { title: 'Forge', body: 'Ping', kind: 'done' },
    targets: [
      { deviceId: 'bad-sync', pushToken: '1'.repeat(64) },
      { deviceId: 'good-after', pushToken: '2'.repeat(64) },
    ],
    activeDeviceIds: [],
  });
  assert.equal(isolatedOutcomes.length, 2);
  assert.equal(isolatedOutcomes[0].ok, false);
  assert.equal(isolatedOutcomes[1].ok, true);
});
