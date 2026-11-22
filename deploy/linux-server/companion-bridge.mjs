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
 * How many top-level keys one window scan looks at, kept and skipped
 * alike. A legitimate window carries the reserved keys plus at most eight
 * kept keys, so forty visited keys leaves ample room for the handful of
 * skipped keys a real window holds, while an attacker-influenced window
 * cannot buy unbounded work: the scan stops at the cap instead of walking
 * every key the caller wrote.
 */
const MAX_WINDOW_METADATA_VISITED = MAX_WINDOW_METADATA_KEYS * 4 + 8;

/**
 * The credential vocabulary. A caller field name is read two ways, and both
 * readings use this vocabulary.
 *
 * Read as words, a name is split on camel-case edges, acronym edges, digit
 * edges and separators, and a name that carries a credential word at one of
 * those edges drops the field. That is what catches deviceToken, APIToken,
 * SMSCode, PIN and sms_code.
 *
 * Read as one unbroken run, a name that carries a credential word anywhere
 * drops the field. That is what catches the names written as a single
 * lowercase run, where there is no edge to split on: pairingtoken, token123
 * and smscode.
 *
 * Two words sit in only one reading. The word "code" is too generic as a
 * word, because a bare Code suffix would strip a benign statusCode, so it is
 * read only as an unbroken run and the benign names are rescued by the
 * allowlist below. The word "pin" is too ambiguous as a raw run, because a
 * raw match would strip ordinary words such as shipping and mapping, so it
 * is read at a word edge instead.
 */
const CREDENTIAL_FIELD_WORDS = new Set([
  'token',
  'secret',
  'password',
  'passcode',
  'passphrase',
  'credential',
  'otp',
  'jwt',
  'apikey',
  'pin',
]);

/**
 * The credential words that are safe to look for anywhere in a name. The
 * word "pin" is missing here, because a raw match would strip ordinary
 * words such as shipping, mapping and coping.
 */
const CREDENTIAL_FIELD_SUBSTRINGS = new Set([
  'token',
  'secret',
  'password',
  'passcode',
  'passphrase',
  'credential',
  'otp',
  'jwt',
  'apikey',
  'code',
]);

/**
 * The credential words that are matched only at a word edge, because a raw
 * match would strip ordinary words that merely contain them.
 */
const CREDENTIAL_EDGE_FIELD_WORDS = new Set(['pin']);

/**
 * The benign field names the credential rule keeps. The trade leans this
 * way because the module's contract is digests only, never the value: a
 * benign field that is dropped costs a caller one piece of metadata, while
 * a credential that survives costs the cleartext itself. The list is exact
 * and finite on purpose, so a name is either listed here or it is not, and
 * a prefixed variant such as httpStatusCode is not listed, so it is
 * dropped. The allowlist rescues a name and never rescues a credential
 * value: a field on this list still drops when its value is a credential,
 * because the value check runs on every value the bridge keeps.
 */
const BENIGN_FIELD_NAMES = new Set([
  'statuscode',
  'exitcode',
  'errorcode',
  'httpcode',
  'postcode',
  'zipcode',
  'countrycode',
  'areacode',
  'languagecode',
  'unicode',
  'codepoint',
  'encode',
  'decode',
  'encoded',
  'decoded',
  'barcode',
]);

/**
 * Split one field name into its words. A camel-case edge, an acronym edge
 * and a digit edge each end a word, and so does any non-alphanumeric
 * character. The acronym edge is what keeps APIToken and SMSCode from
 * reading as one word.
 */
function splitFieldWords(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== '');
}

/**
 * Whether the name carries an edge-matched credential word: the word sits
 * at the start of the name, at the end of it, or beside a non-letter. This
 * is how pinValue and pinvalue drop the field while shipping and mapping
 * keep their value.
 */
function hasEdgeCredentialWord(lowered) {
  for (const needle of CREDENTIAL_EDGE_FIELD_WORDS) {
    let at = lowered.indexOf(needle);
    while (at !== -1) {
      const before = at === 0 ? '' : lowered.charAt(at - 1);
      const after = lowered.charAt(at + needle.length);
      if (before === '' || after === '' || !/[a-z]/.test(before) || !/[a-z]/.test(after)) return true;
      at = lowered.indexOf(needle, at + 1);
    }
  }
  return false;
}

/**
 * Whether one caller field name carries a credential. The benign allowlist
 * is read first, so a listed name always keeps its value, and the two
 * readings of the name follow: the credential words at the edges of the
 * name, and the credential words anywhere in the run. A cleartext value
 * therefore cannot ride back out of a stored window under any name.
 *
 * The allowlist rescues a name and never rescues a credential value, so
 * this answer is only half of the decision: the value check runs on the
 * value as well, whatever the name says.
 */
function isCredentialFieldName(key) {
  const name = String(key ?? '');
  const lowered = name.toLowerCase();
  if (BENIGN_FIELD_NAMES.has(lowered)) return false;
  for (const word of splitFieldWords(name)) {
    if (CREDENTIAL_FIELD_WORDS.has(word.toLowerCase())) return true;
  }
  for (const needle of CREDENTIAL_FIELD_SUBSTRINGS) {
    if (lowered.includes(needle)) return true;
  }
  return hasEdgeCredentialWord(lowered);
}

/**
 * The credential shapes a caller value can take, and the only shapes this
 * check knows. They are the shapes the module and its sibling handle: the
 * pairing token this module mints, the six digit pairing code, an
 * Infisical service token, an authorization header value, a JSON web
 * token, and a PEM private key block. A generic length test is not used,
 * because it would drop a benign value such as a sha256 digest, and the
 * point of the benign allowlist is to keep benign metadata. None of these
 * patterns carries the global flag, because a global pattern keeps its
 * lastIndex between calls.
 *
 * The six digit code is the widest net here, and it is deliberately not
 * scoped to a name: the pairing code this module accepts IS six digits, so
 * a code that has been renamed into a benign field would otherwise ride
 * back out in cleartext. A benign six digit value, a numeric count for
 * instance, is lost instead. That trade is the module's own: a dropped
 * field costs a caller one piece of metadata, while a surviving
 * credential costs the cleartext itself.
 */
const CREDENTIAL_VALUE_PATTERNS = [
  // The pairing token this module mints, matched as a SUBSTRING:  a token
  // written inside a longer note is still that token, and an anchored
  // match would let it ride back out inside the note.
  /omb_pair_[A-Za-z0-9_-]{43}/,
  // The six digit pairing code, matched as a standalone run of six digits.
  // The digit lookarounds keep a longer number from producing one, so a
  // count of 20261122 is not read as a code, while a code written inside a
  // longer note still is.
  /(?<!\d)\d{6}(?!\d)/,
  /\bst\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})*/,
  // The authorization schemes this module family handles, and no more:  a
  // generic "any word then a long token" pattern dropped benign metadata,
  // because an ordinary description can end in a twelve character word.
  /\b(?:Bearer|Basic|Token|ApiKey|HOBAuth|OAuth)\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/**
 * Whether one caller value carries a credential. A name can be guessed by
 * whoever persists the window; a value cannot be renamed out of the way, so
 * this check runs on every value the bridge is about to keep, under any
 * name at all.
 *
 * The value is read through its SERIALIZED form rather than through the
 * live object. The caller has already refused anything whose serialized
 * length passes the size gate, so the text handed here is bounded, and the
 * structure that text describes is bounded with it. The serialized length
 * is therefore the only bound there is: there is no depth limit and no node
 * limit, so a credential nested at any depth is still a leaf in that
 * structure and is still found, while a benign value that is merely wide or
 * deep is kept, because nothing about it carries a credential.
 *
 * The digests the window itself carries are the exact answer on top of the
 * shapes: a value whose digest is the stored code digest or the stored
 * token digest IS that credential, whatever it is written as and whatever
 * its name is. That reading does not depend on the value looking like a
 * credential, so a code or token written in a shape this list does not know
 * is still caught.
 *
 * The walk descends into objects and arrays, because a caller value that is
 * an object is kept as that object and a credential nested inside it would
 * otherwise ride back out untouched: the shapes are tested against every
 * string leaf, and a nested key whose NAME carries a credential drops the
 * whole value, the same rule the top level applies. A value that cannot be
 * serialized or parsed is dropped, which is the fail-closed direction.
 */
function isCredentialFieldValue(serialized, digests = {}) {
  const wanted = [digests.codeDigest, digests.tokenDigest]
    .map((held) => String(held ?? ''))
    .filter((digest) => digest !== '');
  const isCredentialText = (text) => {
    for (const pattern of CREDENTIAL_VALUE_PATTERNS) {
      if (pattern.test(text)) return true;
    }
    for (const digest of wanted) {
      if (sha256Hex(text) === digest) return true;
    }
    return false;
  };
  let parsed;
  try {
    parsed = JSON.parse(String(serialized ?? ''));
  } catch {
    // A value that cannot be read back is a credential: fail closed.
    return true;
  }
  const walk = (current) => {
    if (current === null || current === undefined) return false;
    // `Object(current) === current` is true for an object, an array or a
    // function and false for a primitive, which is the object test this
    // repo uses in place of a runtime typeof.
    if (Object(current) !== current) return isCredentialText(String(current));
    if (Array.isArray(current)) {
      for (const item of current) {
        if (walk(item)) return true;
      }
      return false;
    }
    for (const key of Object.keys(current)) {
      // A nested key that carries a credential drops the whole value, the
      // same rule the top level applies to a field name.
      if (isCredentialFieldName(key)) return true;
      if (walk(current[key])) return true;
    }
    return false;
  };
  return walk(parsed);
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
 * or code persisted on a window is dropped on the way out. The benign names
 * that keep their value are listed in the module, so the rule stays an
 * explicit finite list rather than a judgement call. That list rescues a
 * name only: a value that is one of the credential shapes the module
 * handles, or that is the window's own code or token by digest, is dropped
 * under any name, allowlisted or not.
 *
 * The scan itself is bounded too: at most MAX_WINDOW_METADATA_VISITED
 * top-level keys are looked at, kept or skipped, so a window carrying
 * thousands of keys cannot turn one redeem into thousands of value checks.
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
  let visited = 0;
  for (const key of Object.keys(source)) {
    // Every key the scan looks at counts, kept or skipped, and the cap is
    // checked before the expensive work below.
    visited += 1;
    if (visited > MAX_WINDOW_METADATA_VISITED) break;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (key === 'codeDigest' || key === 'tokenDigest' || key === 'expiresAtMs' || key === 'attemptsLeft' || key === 'spent' || key === 'replay') continue;
    if (isCredentialFieldName(key)) continue;
    if (kept >= MAX_WINDOW_METADATA_KEYS) break;
    // The value is serialized once: the size gate reads that text, and the
    // value check reads the structure the same text describes.
    let serialized = null;
    try {
      serialized = JSON.stringify(source[key] ?? null);
    } catch {
      continue;
    }
    const size = serialized?.length ?? 0;
    if (!Number.isFinite(size) || size > MAX_WINDOW_METADATA_CHARS) continue;
    if (isCredentialFieldValue(serialized, { codeDigest: source.codeDigest, tokenDigest: source.tokenDigest })) continue;
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
