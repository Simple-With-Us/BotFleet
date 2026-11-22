// The Linux-server companion bridge core (BF-2652).
//
// Locked owner decision (Jay, Nov 22): the server is the locus for endpoints
// and for all things, so a sleeping Mac must not cut the phone off from
// server-owned jobs, waits, or approvals. This module is the bridge decision
// core: the restricted companion route table, per-route device digests,
// single-spend pairing windows with same-request replay, the one-sender
// push rule, and the native-mirrored alert payload shape. Every export is
// pure — no listener, no binding, no Infisical read, no push is ever sent —
// so the contract tests run with fakes and no network.
//
// Pairing mirrors `companion/src/devices.ts`: two credentials per window
// (QR token plus 6-digit code), both stored as digests only. Redeeming
// either burns the window, and the same phone request (same request id
// plus same credential) replays its prior result until expiry instead of
// locking the user out after a lost response. Older callers that omit a
// request id keep exactly-once behaviour.
//
// What this file is NOT: the listener, the systemd unit, the
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
 * Decode one path segment for the traversal check. Returns null when the
 * segment is not decodable, so undecodable forms are refused rather than
 * passed through to a later decoder.
 */
function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Decide a bridge request from its method and URL. Path parameters match
 * one non-empty segment with no slashes; the check runs on the decoded
 * segment so `%2e`, `%2F` and other encoded dot/slash forms cannot slip
 * past it, while the upstream keeps the raw bytes verbatim. The query
 * string is stripped for matching and preserved byte for byte.
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
  const decoded = [];
  for (const segment of segments) {
    const form = decodeSegment(segment);
    if (form === null || form === '' || form === '.' || form === '..' || form.includes('/')) {
      return { ok: false, status: 404, reason: 'no bridge route' };
    }
    decoded.push(form);
  }
  let methodSeen = false;
  for (const route of BRIDGE_ALLOWED_ROUTES) {
    const pattern = route.path.split('/').slice(1);
    if (pattern.length !== decoded.length) continue;
    const params = {};
    let matches = true;
    for (let index = 0; index < pattern.length; index += 1) {
      const part = pattern[index];
      if (part.startsWith(':')) {
        params[part.slice(1)] = segments[index];
      } else if (part !== decoded[index]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    methodSeen = true;
    if (route.method !== verb) continue;
    const built = pattern.map((part) => (part.startsWith(':') ? params[part.slice(1)] : part));
    return { ok: true, upstream: `/${built.join('/')}${query}`, local: route.local };
  }
  if (methodSeen) return { ok: false, status: 405, reason: 'method not allowed on this bridge route' };
  return { ok: false, status: 404, reason: 'no bridge route' };
}

/** sha256 of one value, lowercase hex. Digests only, never the value. */
export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

/**
 * Timing-safe equality for two hex digests. Lengths must already agree;
 * the caller compares digests, never cleartext, so both sides are always
 * 32 bytes after decoding.
 */
function digestsEqualHex(left, right) {
  if (!/^[0-9a-f]{64}$/.test(left ?? '') || !/^[0-9a-f]{64}$/.test(right ?? '')) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

/**
 * Open a pairing window: a manual code plus a high-entropy token, both
 * stored as digests only. The clock is injected (`nowMs`) so tests run on
 * a fake clock and production passes `Date.now()`.
 */
/**
 * The only token shape the bridge mints and accepts: `omb_pair_` plus 43
 * base64url characters (52 total), mirroring `devices.ts` and the native
 * parser, which rejects anything else as a bad credential before the
 * bridge would. A bridge-minted non-conforming token could never be
 * redeemed on the Mac side, so accepting one here would only ever produce
 * a confusing failure there. The code path stays the human fallback at six
 * digits with its own attempt budget and TTL.
 */
export const OMB_PAIR_TOKEN = /^omb_pair_[A-Za-z0-9_-]{43}$/;

/** Request ids that may key a replay, mirroring `devices.ts`. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{16,128}$/;

/**
 * A request id the bridge will replay for, or null when the caller sent
 * none or a malformed one. Malformed ids are treated as absent (older
 * clients keep exactly-once behaviour) rather than hashed into a
 * recoverable bearer the Mac sidecar would treat as exactly-once.
 */
export function replayableRequestId(value) {
  const text = String(value ?? '');
  return REQUEST_ID_PATTERN.test(text) ? text : null;
}

export function openBridgePairingWindow({ code, token, ttlSeconds, maxAttempts, nowMs }) {
  const cleanCode = String(code ?? '');
  const cleanToken = String(token ?? '');
  const ttl = Number(ttlSeconds);
  const attempts = Math.floor(Number(maxAttempts));
  const now = Number(nowMs);
  if (!/^\d{6}$/.test(cleanCode)) {
    throw new Error('openBridgePairingWindow requires a 6-digit code');
  }
  if (!OMB_PAIR_TOKEN.test(cleanToken)) {
    throw new Error('openBridgePairingWindow requires an omb_pair_ token');
  }
  if (!Number.isFinite(ttl) || !(ttl > 0) || !Number.isFinite(now) || !(now >= 0) || !Number.isFinite(attempts) || attempts < 1) {
    throw new Error('openBridgePairingWindow requires a positive finite TTL, a finite clock, and a positive attempt budget');
  }
  return {
    codeDigest: sha256Hex(cleanCode),
    tokenDigest: sha256Hex(cleanToken),
    expiresAtMs: now + ttl * 1000,
    attemptsLeft: attempts,
    spent: false,
    replay: null,
  };
}

/**
 * Normalize a persisted window into numbers the checks below can trust.
 * Anything missing or non-finite fails closed: a corrupt window spends
 * rather than guessing forever.
 */
/**
 * The most caller metadata a window may carry through. Unbounded copies
 * turn every redeem — including rejected ones — into O(N) copy work over
 * caller-controlled keys, so anything past eight small keys is dropped.
 */
const MAX_WINDOW_METADATA_KEYS = 8;
const MAX_WINDOW_METADATA_CHARS = 1024;

/**
 * The names that carry a credential value rather than a digest. A window
 * that persists one of these in cleartext must not hand it back on a redeem,
 * because the bridge keeps digests only, never the value.
 */
const CREDENTIAL_FIELD_NAMES = new Set([
  'token',
  'code',
  'credential',
  'credentialDigest',
]);

/**
 * The words that mark a caller field name as credential-bearing. The exact
 * names above cannot hold the digest-only invariant on their own, because a
 * caller may name a credential field anything; these words catch the usual
 * forms, and they are matched whole so an innocent name like "postcode"
 * keeps its value.
 */
const CREDENTIAL_FIELD_WORDS = new Set([
  'token',
  'code',
  'credential',
  'secret',
  'passcode',
  'passphrase',
  'password',
  'otp',
  'pin',
]);

/**
 * Whether one caller field name carries a credential. The module's own
 * credential names are listed outright, and any name whose words include a
 * credential word is refused as well, so a cleartext value cannot ride back
 * out of a stored window under a different name.
 */
function isCredentialFieldName(key) {
  if (CREDENTIAL_FIELD_NAMES.has(key)) return true;
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== '');
  return words.some((word) => CREDENTIAL_FIELD_WORDS.has(word.toLowerCase()));
}

/**
 * Normalize one stored window, preserving a bounded set of unknown caller
 * fields. Callers may attach small metadata to the object they persist;
 * dropping it on read would silently lose it the first time the bridge
 * touched the window. Only own enumerable string keys travel, never
 * __proto__, constructor or prototype, at most eight of them, and no
 * single value larger than 1KB once serialized. Anything that is not a
 * plain object fails closed to an empty shell that cannot verify. A field
 * whose name carries a credential never travels at all, so a cleartext token
 * or code persisted on a window is dropped on the way out.
 */
function normalizeWindow(window) {
  let source = window ?? {};
  if (Array.isArray(source)) source = {};
  const proto = Object.getPrototypeOf(source);
  if (proto !== Object.prototype && proto !== null) source = {};
  const expires = Number(source.expiresAtMs);
  const attempts = Number(source.attemptsLeft);
  const extra = {};
  let kept = 0;
  for (const key of Object.keys(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (key === 'codeDigest' || key === 'tokenDigest' || key === 'expiresAtMs' || key === 'attemptsLeft' || key === 'spent' || key === 'replay') continue;
    if (isCredentialFieldName(key)) continue;
    if (kept >= MAX_WINDOW_METADATA_KEYS) break;
    let size = 0;
    try {
      size = JSON.stringify(source[key] ?? null)?.length ?? 0;
    } catch {
      continue;
    }
    if (!Number.isFinite(size) || size > MAX_WINDOW_METADATA_CHARS) continue;
    extra[key] = source[key];
    kept += 1;
  }
  return {
    ...extra,
    codeDigest: String(source.codeDigest ?? ''),
    tokenDigest: String(source.tokenDigest ?? ''),
    expiresAtMs: Number.isFinite(expires) ? expires : NaN,
    attemptsLeft: Number.isFinite(attempts) ? Math.floor(attempts) : 0,
    spent: source.spent === true,
    replay: source.replay ?? null,
  };
}

/**
 * Redeem one credential against a window. Returns the updated window with
 * every call, so the caller persists the spend. A redeemed window answers
 * the SAME phone request (same request id plus same credential) with its
 * prior result until expiry — a retried request after a lost response
 * replays instead of locking the user out — and anything else on a spent
 * window is refused. Callers without a request id keep exactly-once
 * behaviour. `pairedDeviceIds` is the registry's current membership: a
 * replay for a revoked device is refused, because revocation must not
 * leave a recoverable bearer behind. A successful redeem reports the same
 * fields on both paths. Those fields are the device the caller named, the
 * digest of the accepted credential, and whether the answer was replayed.
 */
/**
 * Redeem one credential and, when the caller supplies the minted device
 * id, record the replay atomically in the same step that spends the
 * window. There is no separate record call, so no caller can persist the
 * spend without the replay and lock the phone out after a lost response.
 * Without `replayDeviceId` the window still spends exactly once; without
 * a valid request id there is no replay to record (older clients keep
 * exactly-once behaviour).
 */
export function redeemBridgePairingWindow({ window, presented, requestId, replayDeviceId, pairedDeviceIds, nowMs }) {
  const current = normalizeWindow(window);
  const now = Number(nowMs);
  const presentedDigest = sha256Hex(String(presented ?? ''));
  const validRequestId = replayableRequestId(requestId);
  const requestDigest = validRequestId === null ? '' : sha256Hex(validRequestId);

  if (!(now >= 0) || !Number.isFinite(current.expiresAtMs) || now >= current.expiresAtMs) {
    return { ok: false, reason: 'window expired', window: { ...current, spent: true, replay: null } };
  }
  if (current.spent) {
    const replay = current.replay;
    const paired = Array.isArray(pairedDeviceIds) ? pairedDeviceIds : [];
    if (
      replay &&
      validRequestId !== null &&
      digestsEqualHex(replay.requestDigest, requestDigest) &&
      replay.expiresAtMs > now &&
      digestsEqualHex(replay.credentialDigest, presentedDigest) &&
      paired.includes(replay.deviceId)
    ) {
      return { ok: true, replayed: true, deviceId: replay.deviceId, credentialDigest: replay.credentialDigest, window: current };
    }
    return { ok: false, reason: 'window already spent', window: current };
  }
  if (!(current.attemptsLeft > 0)) {
    return { ok: false, reason: 'no attempts left', window: { ...current, spent: true } };
  }
  const tokenHolds = digestsEqualHex(current.tokenDigest, presentedDigest);
  const codeHolds = digestsEqualHex(current.codeDigest, presentedDigest);
  if (!tokenHolds && !codeHolds) {
    const left = current.attemptsLeft - 1;
    return { ok: false, reason: 'bad credential', window: { ...current, attemptsLeft: left, spent: left <= 0 } };
  }
  const spent = { ...current, spent: true };
  // Any value is stringified so the check below is a plain string
  // comparison; a non-string id simply never matches the paired list.
  const replayFor = String(replayDeviceId ?? '');
  if (validRequestId !== null && replayFor !== '') {
    spent.replay = {
      requestDigest: sha256Hex(validRequestId),
      credentialDigest: presentedDigest,
      deviceId: replayFor,
      expiresAtMs: current.expiresAtMs,
    };
  }
  return { ok: true, replayed: false, deviceId: replayFor, credentialDigest: presentedDigest, window: spent };
}

/**
 * Decide a device credential against the bridge's own registry: entries
 * carry digests, never tokens, and an entry only authenticates under a
 * concrete non-empty id. Malformed entries are skipped, never trusted.
 */
export function bridgeDeviceDecision({ presentedToken, devices }) {
  const presented = String(presentedToken ?? '');
  if (!presented || !Array.isArray(devices)) return { ok: false, reason: 'device credential required' };
  const actual = sha256Hex(presented);
  for (const entry of devices) {
    const rawId = entry?.id;
    if (rawId === undefined || rawId === null) continue;
    const id = String(rawId);
    if (id === '') continue;
    const digest = String(entry?.tokenDigest ?? '');
    if (!/^[0-9a-f]{64}$/.test(digest)) continue;
    if (digestsEqualHex(digest, actual)) return { ok: true, deviceId: id };
  }
  return { ok: false, reason: 'unknown device' };
}

/**
 * Which side sends a push for a device. The server sends when it owns the
 * device's current pairing; one device never has two senders, and the seam
 * is decided here rather than raced at send time.
 */
export function pushSenderForDevice({ serverOwnsPairing, macOwnsPairing } = {}) {
  if (serverOwnsPairing) return 'server';
  if (macOwnsPairing) return 'mac';
  return 'none';
}

/** Relevance scores by notification kind, mirroring the native provider. */
const CATEGORY_FOR_KIND = {
  approval: 'BOTFLEET_APPROVAL',
  question: 'BOTFLEET_QUESTION',
};

const BLOCKING_KINDS = new Set(['approval', 'question']);

const RELEVANCE_SCORES = {
  approval: 1.0,
  question: 0.9,
  takeover: 0.7,
  'routine-failed': 0.6,
  done: 0.4,
};

/**
 * The alert payload shape, mirroring the native provider's keys so one
 * device sees one shape whichever side sends. Shape only: nothing here
 * sends anything.
 */
export function buildBridgeAlertPayload({ title, body, threadId, kind } = {}) {
  const kindName = String(kind ?? 'message');
  const aps = {
    alert: { title: String(title ?? ''), body: String(body ?? '') },
    sound: 'default',
    category: Object.hasOwn(CATEGORY_FOR_KIND, kindName) ? CATEGORY_FOR_KIND[kindName] : 'BOTFLEET_UPDATE',
    'interruption-level': BLOCKING_KINDS.has(kindName) ? 'time-sensitive' : 'active',
    'relevance-score': Object.hasOwn(RELEVANCE_SCORES, kindName) ? RELEVANCE_SCORES[kindName] : 0.3,
    'mutable-content': 1,
    'content-available': 1,
  };
  if (String(threadId ?? '') !== '') aps['thread-id'] = String(threadId);
  return { aps };
}
