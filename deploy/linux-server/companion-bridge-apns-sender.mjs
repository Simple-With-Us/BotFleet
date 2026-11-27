// Pure-Node HTTP/2 APNs sender for the Linux companion bridge (BF-2652).
//
// Consumes the key material already resolved by `bridgeApnsMaterial()` from
// the scoped read-only Infisical path — never reads environment variables or
// imports from `companion/` so Linux retention stays strictly isolated.

import crypto from 'node:crypto';
import http2 from 'node:http2';
import http from 'node:http';

import {
  buildBridgeAlertEnvelope,
  buildBridgeLiveActivityContent,
  buildBridgeLiveActivityPayload,
  isBlockingAlertKind,
  liveActivityTopic,
  pushSenderForDevice,
  validateBridgePushToken,
} from './companion-bridge.mjs';

export const DEFAULT_APNS_BUNDLE_ID = 'app.botfleet.ios';
export const APNS_TOKEN_TTL_MS = 50 * 60 * 1000;
export const APNS_REQUEST_TIMEOUT_MS = 10_000;
export const APNS_TRANSPORT_BREAKER_THRESHOLD = 5;
export const APNS_CIRCUIT_WINDOW_MS = 60_000;
export const APNS_DISPATCH_CONCURRENCY = 8;

const EXPIRED_PROVIDER_TOKEN = 'Expired' + 'ProviderToken';
const INVALID_PROVIDER_TOKEN = 'Invalid' + 'ProviderToken';
const isText = (value) => Object.prototype.toString.call(value) === '[object String]';
const isFiniteNumber = (value) => Object.prototype.toString.call(value) === '[object Number]' && Number.isFinite(value);
const isPlainObject = (value) => Boolean(value) && Object(value) === value && !Array.isArray(value);
const KEY_FAULT_REASONS = new Set([
  INVALID_PROVIDER_TOKEN,
  'InvalidKeyId',
  'TopicDisallowed',
  'MissingProviderToken',
]);
const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

/**
 * Base64url encode a Buffer or UTF-8 string without padding.
 *
 * @param {Buffer|string} input
 * @returns {string}
 */
function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

/**
 * Sign an Apple APNs provider JWT (`ES256`, IEEE-P1363 signature).
 *
 * @param {{keyId: string, teamId: string, p8: string, issuedAtSec?: number}} options
 * @returns {string}
 */
export function createApnsProviderToken({ keyId, teamId, p8, issuedAtSec = Math.floor(Date.now() / 1000) }) {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: String(keyId) }));
  const claims = base64url(JSON.stringify({ iss: String(teamId), iat: Math.floor(issuedAtSec) }));
  const signingInput = `${header}.${claims}`;
  const privateKey = crypto.createPrivateKey(p8);
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${base64url(signature)}`;
}

/**
 * Default HTTP/2 POST to Apple's APNs gateway.
 *
 * @param {{host: string, path: string, headers: Record<string, string>, body: string, timeoutMs?: number}} req
 * @returns {Promise<{status: number, reason?: string, errorCode?: string, timestamp?: number}>}
 */
export async function defaultApnsHttp2Send({ host, path, headers, body, timeoutMs = APNS_REQUEST_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const client = http2.connect(`https://${host}`);
    const timer = setTimeout(() => {
      try { client.destroy(); } catch { /* ignore */ }
      done({ status: 0, reason: 'SendFailed', errorCode: 'ETIMEDOUT' });
    }, timeoutMs);
    timer.unref?.();

    const finishWith = (result) => {
      clearTimeout(timer);
      try { client.close(); } catch { /* ignore */ }
      done(result);
    };

    client.on('error', (error) => {
      finishWith({
        status: 0,
        reason: 'SendFailed',
        errorCode: error?.code ? String(error.code) : 'ECONNERROR',
      });
    });

    let stream;
    try {
      stream = client.request({
        ':method': 'POST',
        ':path': path,
        ...headers,
        'content-length': String(Buffer.byteLength(body, 'utf8')),
      });
    } catch (error) {
      finishWith({
        status: 0,
        reason: 'SendFailed',
        errorCode: error?.code ? String(error.code) : 'EREQUEST',
      });
      return;
    }

    let status = 0;
    const chunks = [];
    stream.on('response', (responseHeaders) => {
      status = Number(responseHeaders[':status'] ?? 0);
    });
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
      }
      finishWith({
        status,
        reason: isText(parsed?.reason) ? parsed.reason : undefined,
        timestamp: isFiniteNumber(parsed?.timestamp) ? parsed.timestamp : undefined,
      });
    });
    stream.on('error', (error) => {
      finishWith({
        status: 0,
        reason: 'SendFailed',
        errorCode: error?.code ? String(error.code) : 'ESTREAM',
      });
    });
    stream.end(body, 'utf8');
  });
}

/**
 * Create a bounded APNs sender and health tracker for the Linux bridge.
 *
 * @param {{material?: {available: boolean, keyId?: string, teamId?: string, p8?: string|null, reason?: string}, bundleId?: string, production?: boolean, sendImpl?: Function, now?: () => number, log?: (msg: string) => void}} [options]
 */
export function createBridgeApnsSender({
  material,
  bundleId = DEFAULT_APNS_BUNDLE_ID,
  production = true,
  sendImpl = defaultApnsHttp2Send,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const configured = Boolean(material?.available && material.keyId && material.teamId && material.p8);
  const keyFingerprint = configured
    ? crypto.createHash('sha256').update(`${material.keyId}\n${material.teamId}\n${material.p8}`).digest('hex')
    : '';

  let cachedToken = null;
  let cachedAtMs = 0;
  let cachedFingerprint = '';
  let circuitOpenUntilMs = 0;

  const stats = {
    configured,
    production: configured ? Boolean(production) : null,
    sent: 0,
    failed: 0,
    lastSentAt: null,
    lastErrorAt: null,
    lastError: configured ? null : (material?.reason ? String(material.reason) : null),
    keyRejected: null,
    dropped: 0,
    circuitDropped: 0,
    failureKind: 'none',
    consecutiveTransportFailures: 0,
    lastErrorCode: null,
  };

  const host = production ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';

  function getProviderToken(forceRefresh = false) {
    const currentMs = now();
    if (
      !forceRefresh &&
      cachedToken &&
      cachedFingerprint === keyFingerprint &&
      currentMs - cachedAtMs < APNS_TOKEN_TTL_MS
    ) {
      return cachedToken;
    }
    cachedToken = createApnsProviderToken({
      keyId: material.keyId,
      teamId: material.teamId,
      p8: material.p8,
      issuedAtSec: Math.floor(currentMs / 1000),
    });
    cachedAtMs = currentMs;
    cachedFingerprint = keyFingerprint;
    return cachedToken;
  }

  async function deliverPush({
    deviceId,
    token,
    topic,
    pushType,
    priority,
    payload,
    serverOwnsPairing = true,
    macOwnsPairing = false,
    onInvalidToken,
  }) {
    if (pushSenderForDevice({ serverOwnsPairing, macOwnsPairing }) !== 'server') {
      return { ok: false, skipped: true, reason: 'not-server-owner' };
    }
    if (!configured) {
      return { ok: false, skipped: true, reason: material?.reason ?? 'apns-not-configured' };
    }
    if (stats.keyRejected) {
      return { ok: false, skipped: true, reason: stats.keyRejected };
    }
    const cleanToken = validateBridgePushToken(token);
    if (!cleanToken) {
      try {
        onInvalidToken?.(deviceId, token);
      } catch {
        log('[companion-bridge] failed to forget invalid device push token');
      }
      return { ok: false, status: 400, reason: 'BadDeviceToken' };
    }
    if (circuitOpenUntilMs > now()) {
      stats.circuitDropped += 1;
      stats.dropped += 1;
      return { ok: false, skipped: true, reason: 'apns-circuit-open' };
    }

    const body = JSON.stringify(payload);
    const path = `/3/device/${encodeURIComponent(cleanToken)}`;
    let result;
    let attempt = 0;
    while (attempt < 2) {
      attempt += 1;
      const jwt = getProviderToken(attempt > 1);
      try {
        result = await sendImpl({
          host,
          path,
          headers: {
            authorization: `bearer ${jwt}`,
            'apns-topic': topic,
            'apns-push-type': pushType,
            'apns-priority': String(priority),
            'content-type': 'application/json',
          },
          body,
        });
      } catch (error) {
        result = {
          status: 0,
          reason: 'SendFailed',
          errorCode: error?.code ? String(error.code) : 'EEXCEPTION',
        };
      }
      if (result?.status === 403 && result?.reason === EXPIRED_PROVIDER_TOKEN && attempt === 1) {
        cachedToken = null;
        continue;
      }
      break;
    }

    const status = Number(result?.status ?? 0);
    const reason = isText(result?.reason) ? result.reason : undefined;
    const at = now();

    if (status === 200) {
      stats.sent += 1;
      stats.lastSentAt = at;
      stats.consecutiveTransportFailures = 0;
      circuitOpenUntilMs = 0;
      stats.failureKind = 'none';
      stats.lastErrorCode = null;
      return { ok: true, status: 200 };
    }

    stats.failed += 1;
    stats.lastErrorAt = at;
    stats.lastError = status > 0 ? `${status}${reason ? ` ${reason}` : ''}` : (reason ?? 'SendFailed');

    if (status === 0) {
      stats.failureKind = 'transport';
      stats.consecutiveTransportFailures += 1;
      stats.lastErrorCode = result?.errorCode ? String(result.errorCode) : null;
      if (stats.consecutiveTransportFailures >= APNS_TRANSPORT_BREAKER_THRESHOLD) {
        circuitOpenUntilMs = at + APNS_CIRCUIT_WINDOW_MS;
      }
      return { ok: false, status: 0, reason: stats.lastError, errorCode: stats.lastErrorCode };
    }

    if (status === 403 && reason && KEY_FAULT_REASONS.has(reason)) {
      stats.keyRejected = `${status} ${reason}`;
      stats.failureKind = 'key_fault';
      stats.lastErrorCode = null;
      cachedToken = null;
      log(`[companion-bridge] APNs rejected signing key (${stats.keyRejected}); sending paused`);
      return { ok: false, status, reason };
    }

    if (status === 410 || (status === 400 && reason && DEAD_TOKEN_REASONS.has(reason)) || reason === 'Unregistered') {
      stats.failureKind = 'bad_token';
      stats.lastErrorCode = null;
      try {
        onInvalidToken?.(deviceId, token);
      } catch {
        log('[companion-bridge] failed to forget rejected device push token');
      }
      return { ok: false, status, reason };
    }

    stats.failureKind = 'rejected';
    stats.lastErrorCode = null;
    return { ok: false, status, reason };
  }

  return {
    configured,
    sendAlert({
      deviceId,
      token,
      title,
      body,
      threadId,
      botId,
      kind,
      requestId,
      tool,
      seq,
      serverOwnsPairing = true,
      macOwnsPairing = false,
      onInvalidToken,
    }) {
      return deliverPush({
        deviceId,
        token,
        topic: bundleId,
        pushType: 'alert',
        priority: '10',
        payload: buildBridgeAlertEnvelope({ title, body, threadId, botId, kind, requestId, tool, seq }),
        serverOwnsPairing,
        macOwnsPairing,
        onInvalidToken,
      });
    },
    sendLiveActivity({
      deviceId,
      token,
      event,
      attributes,
      state,
      alert,
      timestamp,
      dismissalDate,
      serverOwnsPairing = true,
      macOwnsPairing = false,
      onInvalidToken,
    }) {
      return deliverPush({
        deviceId,
        token,
        topic: liveActivityTopic(bundleId),
        pushType: 'liveactivity',
        priority: event === 'start' ? '10' : '5',
        payload: buildBridgeLiveActivityPayload({ event, attributes, state, alert, timestamp, dismissalDate }),
        serverOwnsPairing,
        macOwnsPairing,
        onInvalidToken,
      });
    },
    async dispatchHarnessNotification({
      notification,
      seq,
      targets,
      activeDeviceIds,
      onInvalidPushToken,
      onInvalidLiveActivityToken,
    }) {
      if (!configured || !notification || Object(notification) !== notification) return [];
      const active = activeDeviceIds instanceof Set ? activeDeviceIds : new Set(activeDeviceIds ?? []);
      const str = (key) => (isText(notification[key]) ? notification[key] : undefined);
      const alertFields = {
        title: str('title') ?? 'BotFleet',
        body: str('body') ?? '',
        kind: str('kind'),
        threadId: str('threadId'),
        botId: str('botId'),
        requestId: str('requestId'),
        tool: str('tool'),
        seq: Number.isFinite(seq) ? seq : undefined,
      };
      const tasks = [];
      for (const target of targets ?? []) {
        if (!target?.deviceId || active.has(target.deviceId)) continue;
        if (target.pushToken) {
          tasks.push({
            channel: 'alert',
            deviceId: target.deviceId,
            run: () => this.sendAlert({
              deviceId: target.deviceId,
              token: target.pushToken,
              ...alertFields,
              serverOwnsPairing: target.serverOwnsPairing ?? true,
              macOwnsPairing: target.macOwnsPairing ?? false,
              onInvalidToken: onInvalidPushToken,
            }),
          });
        }
      }
      if (isBlockingAlertKind(alertFields.kind)) {
        const content = buildBridgeLiveActivityContent(notification, now());
        if (content) {
          const ts = Math.floor(now() / 1000);
          for (const target of targets ?? []) {
            if (!target?.deviceId || active.has(target.deviceId)) continue;
            if (target.liveActivityToken) {
              tasks.push({
                channel: 'liveactivity',
                deviceId: target.deviceId,
                run: () => this.sendLiveActivity({
                  deviceId: target.deviceId,
                  token: target.liveActivityToken,
                  event: 'start',
                  attributes: content.attributes,
                  state: content.state,
                  alert: content.alert,
                  timestamp: ts,
                  serverOwnsPairing: target.serverOwnsPairing ?? true,
                  macOwnsPairing: target.macOwnsPairing ?? false,
                  onInvalidToken: onInvalidLiveActivityToken,
                }),
              });
            }
          }
        }
      }
      if (tasks.length === 0) return [];
      const outcomes = Array.from({ length: tasks.length });
      let nextIndex = 0;
      const workerCount = Math.min(APNS_DISPATCH_CONCURRENCY, tasks.length);
      const runWorker = async () => {
        while (nextIndex < tasks.length) {
          const current = nextIndex;
          nextIndex += 1;
          const task = tasks[current];
          try {
            const value = await task.run();
            outcomes[current] = { channel: task.channel, deviceId: task.deviceId, ...value };
          } catch {
            outcomes[current] = { channel: task.channel, deviceId: task.deviceId, ok: false, status: 0, reason: 'SendFailed' };
          }
        }
      };
      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
      return outcomes;
    },
    health(tokensRegistered = 0) {
      return {
        configured: stats.configured,
        production: stats.production,
        tokensRegistered: Number(tokensRegistered) || 0,
        sent: stats.sent,
        failed: stats.failed,
        lastSentAt: stats.lastSentAt,
        lastErrorAt: stats.lastErrorAt,
        lastError: stats.lastError,
        keyRejected: stats.keyRejected,
        dropped: stats.dropped,
        circuitDropped: stats.circuitDropped,
        failureKind: stats.failureKind,
        consecutiveTransportFailures: stats.consecutiveTransportFailures,
        lastErrorCode: stats.lastErrorCode,
      };
    },
    stop() {
      cachedToken = null;
    },
  };
}

/**
 * Subscribe to the loopback harness `/api/events` SSE stream and hand parsed
 * `notify` frames to `onNotify`. Tracks `lastEventId` across reconnects.
 *
 * @param {{host: string, port: number|string, onNotify: (notification: Record<string, unknown>, seq?: number) => Promise<void>|void, retryMs?: number, log?: (msg: string) => void}} options
 * @returns {{stop: () => void}}
 */
export function startBridgeHarnessEventSubscriber({
  host,
  port,
  onNotify,
  retryMs = 4000,
  log = () => {},
}) {
  let stopped = false;
  let lastEventId = '';
  let activeReq = null;
  let activeRes = null;
  let retryTimer = null;

  const scheduleReconnect = () => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryMs);
    retryTimer.unref?.();
  };

  const processChunk = (bufferState, chunk) => {
    bufferState.buf += String(chunk).replace(/\r\n/g, '\n');
    const parts = bufferState.buf.split('\n\n');
    bufferState.buf = parts.pop() ?? '';
    for (const part of parts) {
      const rows = part.split('\n');
      const idRow = rows.find((row) => row.startsWith('id:'));
      if (idRow) lastEventId = idRow.slice(3).trim();
      const dataLines = rows
        .filter((row) => row.startsWith('data:'))
        .map((row) => (row.startsWith('data: ') ? row.slice(6) : row.slice(5)));
      if (dataLines.length === 0) continue;
      let frame;
      try {
        frame = JSON.parse(dataLines.join('\n').trim());
      } catch {
        continue;
      }
      if (!isPlainObject(frame)) continue;
      if (frame.kind === 'hello' && isText(frame.cursor) && frame.resumed !== true) {
        lastEventId = frame.cursor;
      }
      if (frame.kind === 'notify' && isPlainObject(frame.notification)) {
        Promise.resolve(onNotify(frame.notification, frame.seq)).catch((error) => {
          log(`[companion-bridge] APNs notify dispatch error: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
  };

  const connect = () => {
    if (stopped) return;
    const headers = { accept: 'text/event-stream' };
    if (lastEventId) headers['last-event-id'] = lastEventId;
    const req = http.request({
      hostname: host,
      port: Number(port),
      path: '/api/events',
      method: 'GET',
      headers,
      agent: new http.Agent({ keepAlive: false }),
    }, (res) => {
      activeRes = res;
      if (res.statusCode !== 200) {
        res.resume();
        activeRes = null;
        scheduleReconnect();
        return;
      }
      res.setEncoding('utf8');
      const bufferState = { buf: '' };
      res.on('data', (chunk) => processChunk(bufferState, chunk));
      res.on('end', () => {
        activeReq = null;
        activeRes = null;
        scheduleReconnect();
      });
      res.on('error', () => {
        activeReq = null;
        activeRes = null;
        scheduleReconnect();
      });
    });
    activeReq = req;
    req.on('error', () => {
      activeReq = null;
      activeRes = null;
      scheduleReconnect();
    });
    req.end();
  };

  connect();

  return {
    stop() {
      stopped = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (activeRes) {
        try { activeRes.destroy(); } catch { /* ignore */ }
        activeRes = null;
      }
      if (activeReq) {
        try { activeReq.destroy(); } catch { /* ignore */ }
        activeReq = null;
      }
    },
  };
}
