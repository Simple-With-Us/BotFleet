// The Linux-server companion bridge core (BF-2652).
//
// Locked owner decision (Jay, Nov 22): the server is the locus for endpoints
// and for all things, so a sleeping Mac must not cut the phone off from
// server-owned jobs, waits, or approvals. This module is the bridge's
// decision core: which companion routes the server answers, whose device
// credential opens each one, how pairing windows open and spend exactly
// once, and which side sends a push for a device. Every export is pure —
// no listener, no binding, no Infisical read, no push is ever sent from
// here — so the contract tests run with fakes and no network.
//
// What this file is NOT: the listener wiring, the systemd unit, the
// retained-source manifest entry, and the Infisical key binding all land
// separately after review. Until then the bridge answers nothing live.

import crypto from 'node:crypto';

/**
 * The companion subset the bridge serves, in advertisement order. A route
 * marked local is answered from the bridge's own registry (pairing and
 * devices live per route, so no secret is shared with the Mac); any other
 * route is a transparent proxy to the same harness path.
 */
export const BRIDGE_ALLOWED_ROUTES = [
  { method: 'GET', path: '/api/companion/endpoints', local: true, description: 'route advertisement, served locally' },
  { method: 'POST', path: '/api/companion/pairing/open', local: true, description: 'open a pairing window' },
  { method: 'POST', path: '/api/companion/pairing/redeem', local: true, description: 'redeem a pairing code or token once' },
  { method: 'GET', path: '/api/companion/devices', local: true, description: 'public device list' },
  { method: 'DELETE', path: '/api/companion/devices/:id', local: true, description: 'revoke one device' },
  { method: 'GET', path: '/api/fleet', local: false, description: 'roster and fleet state hydration' },
  { method: 'GET', path: '/api/threads/:id', local: false, description: 'thread hydration' },
  { method: 'POST', path: '/api/threads/:id/messages', local: false, description: 'message and approval actions' },
  { method: 'POST', path: '/api/threads/:id/interrupt', local: false, description: 'interrupt a running turn' },
  { method: 'GET', path: '/api/events', local: false, description: 'SSE stream; cursor params pass through untouched' },
];

/**
 * Decide a bridge request from its method and URL. Path parameters match
 * one non-empty segment with no slashes; `..` never matches. The query
 * string is stripped for matching and preserved verbatim for the upstream.
 *
 * @param {string} method
 * @param {string} url
 * @returns {{ok: true, upstream: string, local: boolean} | {ok: false, status: number, reason: string}}
 */
export function bridgeRouteDecision(method, url) {
  const verb = String(method ?? '').toUpperCase();
  const raw = String(url ?? '');
  const queryIndex = raw.indexOf('?');
  const path = (queryIndex === -1 ? raw : raw.slice(0, queryIndex)) || '/';
  const query = queryIndex === -1 ? '' : raw.slice(queryIndex);
  const segments = path.split('/').slice(1);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return { ok: false, status: 404, reason: 'no bridge route' };
  }
  let methodSeen = false;
  for (const route of BRIDGE_ALLOWED_ROUTES) {
    const pattern = route.path.split('/').slice(1);
    if (pattern.length !== segments.length) continue;
    const params = {};
    let matches = true;
    for (let index = 0; index < pattern.length; index += 1) {
      const part = pattern[index];
      if (part.startsWith(':')) {
        params[part.slice(1)] = segments[index];
      } else if (part !== segments[index]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    methodSeen = true;
    if (route.method !== verb) continue;
    let upstream = route.path;
    for (const [name, value] of Object.entries(params)) {
      upstream = upstream.replace(`:${name}`, value);
    }
    return { ok: true, upstream: upstream + query, local: route.local };
  }
  if (methodSeen) return { ok: false, status: 405, reason: 'method not allowed on this bridge route' };
  return { ok: false, status: 404, reason: 'no bridge route' };
}

/**
 * Open a pairing window: a manual code and a high-entropy token that each
 * spend exactly once. The clock is injected (`nowMs`) so tests run on a
 * fake clock and production passes `Date.now()`.
 */
export function openBridgePairingWindow({ code, token, ttlSeconds, maxAttempts, nowMs }) {
  const cleanCode = String(code ?? '');
  const cleanToken = String(token ?? '');
  const ttl = Number(ttlSeconds);
  const attempts = Math.max(1, Math.floor(Number(maxAttempts) || 1));
  const now = Number(nowMs);
  if (!/^\d{6}$/.test(cleanCode) || !cleanToken || !(ttl > 0) || !(now >= 0)) {
    throw new Error('openBridgePairingWindow requires a 6-digit code, a token, a positive TTL, and a clock');
  }
  return {
    code: cleanCode,
    tokenDigest: sha256Hex(cleanToken),
    expiresAtMs: now + ttl * 1000,
    attemptsLeft: attempts,
    spent: false,
  };
}

/**
 * Redeem one credential against a window. Returns the updated window with
 * every call, so the caller persists the spend: a redeemed or expired
 * window stays spent, and a wrong credential costs one attempt.
 */
export function redeemBridgePairingWindow({ window, presented, nowMs }) {
  const current = { ...(window ?? {}), spent: Boolean(window?.spent) };
  const now = Number(nowMs);
  if (current.spent) return { ok: false, reason: 'window already spent', window: current };
  if (!(now >= 0) || now >= current.expiresAtMs) {
    return { ok: false, reason: 'window expired', window: { ...current, spent: true } };
  }
  if (current.attemptsLeft <= 0) {
    return { ok: false, reason: 'no attempts left', window: { ...current, spent: true } };
  }
  const presentedDigest = sha256Hex(String(presented ?? ''));
  const expected = Buffer.from(String(current.tokenDigest ?? ''), 'hex');
  const actual = Buffer.from(presentedDigest, 'hex');
  const tokenHolds = expected.length === 64 / 2 && actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  const codeHolds = String(presented ?? '') === current.code;
  if (!tokenHolds && !codeHolds) {
    const left = current.attemptsLeft - 1;
    return { ok: false, reason: 'bad credential', window: { ...current, attemptsLeft: left, spent: left <= 0 } };
  }
  return { ok: true, window: { ...current, spent: true } };
}

/** sha256 of one value, lowercase hex. Digests only, never the value. */
export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

/**
 * Decide a device credential against the bridge's own registry: entries
 * carry digests, never tokens. Malformed entries are skipped, never
 * trusted.
 */
export function bridgeDeviceDecision({ presentedToken, devices }) {
  const presented = String(presentedToken ?? '');
  if (!presented || !Array.isArray(devices)) return { ok: false, reason: 'device credential required' };
  const actual = Buffer.from(sha256Hex(presented), 'hex');
  for (const entry of devices) {
    const digest = entry && typeof entry.tokenDigest === 'string' ? entry.tokenDigest : '';
    if (!/^[0-9a-f]{64}$/.test(digest)) continue;
    const expected = Buffer.from(digest, 'hex');
    if (expected.length === actual.length && crypto.timingSafeEqual(actual, expected)) {
      return { ok: true, deviceId: entry.id };
    }
  }
  return { ok: false, reason: 'unknown device' };
}

/**
 * Which side sends a push for a device. The server sends when it owns the
 * device's current pairing; one device never has two senders, and the
 * seam is decided here rather than raced at send time.
 */
export function pushSenderForDevice({ serverOwnsPairing, macOwnsPairing } = {}) {
  if (serverOwnsPairing) return 'server';
  if (macOwnsPairing) return 'mac';
  return 'none';
}

/**
 * The alert payload shape, mirroring the native provider's keys so one
 * device sees one shape whichever side sends. Shape only: nothing here
 * sends anything.
 */
export function buildBridgeAlertPayload({ title, body, threadId, kind, timeSensitive } = {}) {
  const scores = { approval: 1.0, question: 0.9, takeover: 0.7, 'routine-failed': 0.6, done: 0.4 };
  const aps = {
    alert: { title: String(title ?? ''), body: String(body ?? '') },
    sound: 'default',
    category: String(kind ?? 'message'),
    'interruption-level': timeSensitive ? 'time-sensitive' : 'active',
    'relevance-score': scores[kind] ?? 0.3,
    'mutable-content': 1,
    'content-available': 1,
  };
  if (String(threadId ?? '')) aps['thread-id'] = String(threadId);
  return { aps };
}
