// The Linux-server companion bridge core (BF-2652).
//
// Locked owner decision (Jay, Nov 22): the server is the locus for endpoints
// and for all things, so a sleeping Mac must not cut the phone off from
// server-owned jobs, waits, or approvals. This module is the bridge decision
// core: the route table the shipped iOS app pairs and syncs through, the
// per-route device digests, single-spend pairing windows with same-request
// replay, the body checks and the withheld-key scrubber the Mac companion
// sidecar applies on the phone's behalf, the one-sender push rule, and the
// native-mirrored alert payload shape. Every export is pure — no listener,
// no binding, no Infisical read, no push is ever sent — so the contract
// tests run with fakes and no network.
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
 * The harness routes a paired phone may reach through the bridge.
 *
 * This is the Mac companion sidecar's `ALLOWED` list
 * (`companion/src/routes.ts`) copied pattern for pattern and in the same
 * order, and it is a copy on purpose. The sidecar keeps that list private to
 * its module, it is TypeScript on a path the Linux host runs as plain `.mjs`,
 * and the sidecar's own `denyReason` answers with the Mac's statuses and its
 * pre-pairing rules, which are not the bridge's.  A copy can drift, so
 * `companion-bridge.node-test.mjs` reads the sidecar's source as text and
 * fails when the two lists disagree.
 *
 * Like the sidecar's list this one is default deny:  a route the harness
 * gains later stays closed to a phone until someone adds it here, in a diff
 * that can be read.  Each pattern is anchored at both ends and matched
 * against the UNDECODED path, so an id can only be `[\w-]+` and an encoded
 * traversal fails to match instead of being forwarded.
 *
 * One sidecar route is deliberately absent.  `POST /api/bots/:id/computer/join`
 * mints a bearer URL for a bot's cloud desktop, and the sidecar lets it
 * through only for a device the computer owner switched on, one by one.  The
 * bridge has no such per-device grant, so the route stays closed here rather
 * than open for every paired phone.
 *
 * Each row is the method, a readable path for logs and summaries, and the
 * pattern itself.  The order is the sidecar's.
 */
const PAIRED_PHONE_HARNESS_ROUTE_GROUPS = [
  {
    description: 'config status, and the narrow settings routes that keep /api/config write-closed to a phone',
    routes: [
      ['GET', '/api/config', /^\/api\/config$/],
      ['PATCH', '/api/terminology', /^\/api\/terminology$/],
      ['PATCH', '/api/conversation-mode', /^\/api\/conversation-mode$/],
      ['PATCH', '/api/busy-send-default', /^\/api\/busy-send-default$/],
      ['PATCH', '/api/features', /^\/api\/features$/],
      ['PATCH', '/api/room-turn-timeout', /^\/api\/room-turn-timeout$/],
      ['PATCH', '/api/auto-update', /^\/api\/auto-update$/],
      ['PATCH', '/api/profile', /^\/api\/profile$/],
    ],
  },
  {
    description: 'live event stream; cursor params pass through untouched',
    routes: [['GET', '/api/events', /^\/api\/events$/]],
  },
  {
    description: 'engine instance roster',
    routes: [['GET', '/api/instances', /^\/api\/instances$/]],
  },
  {
    description: 'speech-to-speech call status, and one rate-limited short-lived call token',
    routes: [
      ['GET', '/api/sts/status', /^\/api\/sts\/status$/],
      ['POST', '/api/sts/token', /^\/api\/sts\/token$/],
    ],
  },
  {
    description: 'roster read, bot creation, and raising the desktop app',
    routes: [
      ['GET', '/api/bots', /^\/api\/bots$/],
      ['POST', '/api/bots', /^\/api\/bots$/],
      ['POST', '/api/desktop/open', /^\/api\/desktop\/open$/],
    ],
  },
  {
    description: 'messaging a bot: send, cancel, interrupt, mark read, edit, switch branch',
    routes: [
      ['POST', '/api/bots/:id/messages', /^\/api\/bots\/[\w-]+\/messages$/],
      ['DELETE', '/api/bots/:id/queue/:id', /^\/api\/bots\/[\w-]+\/queue\/[\w-]+$/],
      ['POST', '/api/bots/:id/interrupt', /^\/api\/bots\/[\w-]+\/interrupt$/],
      ['POST', '/api/bots/:id/read', /^\/api\/bots\/[\w-]+\/read$/],
      ['POST', '/api/bots/:id/messages/:id/edit', /^\/api\/bots\/[\w-]+\/messages\/[\w-]+\/edit$/],
      ['POST', '/api/bots/:id/active-branch', /^\/api\/bots\/[\w-]+\/active-branch$/],
    ],
  },
  {
    description: "a bot's tasks: create, switch, rename, snooze, delete",
    routes: [
      ['POST', '/api/bots/:id/tasks', /^\/api\/bots\/[\w-]+\/tasks$/],
      ['POST', '/api/bots/:id/tasks/:id', /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/],
      ['PATCH', '/api/bots/:id/tasks/:id', /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/],
      ['DELETE', '/api/bots/:id/tasks/:id', /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/],
    ],
  },
  {
    // The body is checked against a field allowlist before it is forwarded
    // (`bridgeProfilePatchDenial`), because the harness route behind it is
    // the desktop's general bot editor.
    description: 'paired-safe bot profile subset; the bridge checks the body before forwarding',
    routes: [['PATCH', '/api/bots/:id/profile', /^\/api\/bots\/[\w-]+\/profile$/]],
  },
  {
    // Archive, Restore, Pin, Mark As Unread, Make Chief Of Staff, Move To
    // Section and Pin Message.  The body may carry those six fields and
    // nothing else (`bridgeBotOrganizeDenial`).
    description: 'roster organization through the bot PATCH; the bridge checks the body before forwarding',
    routes: [['PATCH', '/api/bots/:id', /^\/api\/bots\/[\w-]+$/]],
  },
  {
    description: 'delete a bot, apply the model defaults to every bot, generate a bot avatar',
    routes: [
      ['DELETE', '/api/bots/:id', /^\/api\/bots\/[\w-]+$/],
      ['POST', '/api/bots/apply-model-defaults', /^\/api\/bots\/apply-model-defaults$/],
      ['POST', '/api/bots/:id/avatar/generate', /^\/api\/bots\/[\w-]+\/avatar\/generate$/],
    ],
  },
  {
    description: 'rooms: create, edit, delete, message, interrupt, mark read',
    routes: [
      ['POST', '/api/groups', /^\/api\/groups$/],
      ['PATCH', '/api/groups/:id', /^\/api\/groups\/[\w-]+$/],
      ['DELETE', '/api/groups/:id', /^\/api\/groups\/[\w-]+$/],
      ['POST', '/api/groups/:id/messages', /^\/api\/groups\/[\w-]+\/messages$/],
      ['POST', '/api/groups/:id/interrupt', /^\/api\/groups\/[\w-]+\/interrupt$/],
      ['POST', '/api/groups/:id/read', /^\/api\/groups\/[\w-]+\/read$/],
    ],
  },
  {
    description: "a room's tasks: create, switch, rename, delete",
    routes: [
      ['POST', '/api/groups/:id/tasks', /^\/api\/groups\/[\w-]+\/tasks$/],
      ['POST', '/api/groups/:id/tasks/:id', /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+$/],
      ['PATCH', '/api/groups/:id/tasks/:id', /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+$/],
      ['DELETE', '/api/groups/:id/tasks/:id', /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+$/],
    ],
  },
  {
    description: 'a transcript, its images, and answering an approval',
    routes: [
      ['GET', '/api/threads/:id/messages', /^\/api\/threads\/[\w-]+\/messages$/],
      ['GET', '/api/threads/:id/messages/:id/image', /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/image$/],
      ['POST', '/api/threads/:id/messages/:id/reactions', /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/reactions$/],
      ['GET', '/api/threads/:id/export', /^\/api\/threads\/[\w-]+\/export$/],
      ['POST', '/api/threads/:id/respond', /^\/api\/threads\/[\w-]+\/respond$/],
      ['POST', '/api/threads/:id/approve-all', /^\/api\/threads\/[\w-]+\/approve-all$/],
      ['GET', '/api/search', /^\/api\/search$/],
    ],
  },
  {
    // Upload is image-or-file and capped by the harness; the GET is one bare
    // generated filename with an image extension, never a path.
    description: 'app-owned attachments and profile images',
    routes: [
      ['POST', '/api/attachments', /^\/api\/attachments$/],
      ['GET', '/api/attachments/:file', /^\/api\/attachments\/[\w-]+\.(?:png|jpe?g|gif|webp)$/i],
    ],
  },
  {
    description: 'voice: voices, speech, the default voice, pronunciations, reply audio, and the phone\'s own recordings',
    routes: [
      ['GET', '/api/tts/voices', /^\/api\/tts\/voices$/],
      ['POST', '/api/tts/speak', /^\/api\/tts\/speak$/],
      ['PATCH', '/api/tts/default-voice', /^\/api\/tts\/default-voice$/],
      ['PATCH', '/api/tts/pronunciations', /^\/api\/tts\/pronunciations$/],
      ['POST', '/api/threads/:id/messages/:id/audio', /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/audio$/],
      ['GET', '/api/threads/:id/messages/:id/audio/:n', /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/audio\/\d+$/],
      ['GET', '/api/threads/:id/messages/:id/recording', /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/recording$/],
      ['PATCH', '/api/threads/:id/messages/:id/recording-review', /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/recording-review$/],
    ],
  },
  {
    description: 'routines, and stopping or acknowledging a run',
    routes: [
      ['GET', '/api/routines', /^\/api\/routines$/],
      ['POST', '/api/routines', /^\/api\/routines$/],
      ['PATCH', '/api/routines/:id', /^\/api\/routines\/[\w-]+$/],
      ['DELETE', '/api/routines/:id', /^\/api\/routines\/[\w-]+$/],
      ['POST', '/api/routines/:id/run', /^\/api\/routines\/[\w-]+\/run$/],
      ['POST', '/api/routine-runs/:id/cancel-or-seen', /^\/api\/routine-runs\/[\w-]+\/(?:cancel|seen)$/],
      ['POST', '/api/routine-runs/seen', /^\/api\/routine-runs\/seen$/],
    ],
  },
  {
    // Read-only.  The sidecar also allows `POST /api/update/check` and
    // `POST /api/update/run`, which stop and replace the harness to install
    // an update.  Those two are deliberately absent here: on this host the
    // harness is a production service, the updater is macOS-only today and
    // refuses on Linux, and a route whose purpose is to stop the harness
    // stays closed to a phone rather than open on the strength of that
    // refusal.
    description: 'update status, read-only; the two update actions stay closed on the bridge',
    routes: [['GET', '/api/update/status', /^\/api\/update\/status$/]],
  },
  {
    description: 'connected apps: the catalog, what is connected, one account added, one account detached',
    routes: [
      ['GET', '/api/connectors/catalog', /^\/api\/connectors\/catalog$/],
      ['GET', '/api/connectors/connected', /^\/api\/connectors\/connected$/],
      ['GET', '/api/connectors', /^\/api\/connectors$/],
      ['POST', '/api/connectors/:id/authorize', /^\/api\/connectors\/[\w-]+\/authorize$/],
      ['DELETE', '/api/connectors/:id/accounts/:account', /^\/api\/connectors\/[\w-]+\/accounts\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/],
    ],
  },
  {
    description: 'usage and cost, read-only; shared memory status; background jobs',
    routes: [
      ['GET', '/api/quotas', /^\/api\/quotas$/],
      ['GET', '/api/tts/usage', /^\/api\/tts\/usage$/],
      ['GET', '/api/qdrant/status', /^\/api\/qdrant\/status$/],
      ['GET', '/api/jobs', /^\/api\/jobs$/],
      ['GET', '/api/jobs/:id/output', /^\/api\/jobs\/[\w-]+\/output$/],
      ['POST', '/api/jobs/:id/stop', /^\/api\/jobs\/[\w-]+\/stop$/],
      ['POST', '/api/jobs/stop', /^\/api\/jobs\/stop$/],
    ],
  },
  {
    // Listing, reading and switching only.  Importing reads a folder off the
    // host's own disk, so it is not on the sidecar's list and not here.
    description: "a bot's imported skills: list, read one, switch one on or off",
    routes: [
      ['GET', '/api/bots/:id/skills', /^\/api\/bots\/[\w-]+\/skills$/],
      ['GET', '/api/bots/:id/skills/:name', /^\/api\/bots\/[\w-]+\/skills\/[a-z0-9-]+$/],
      ['PATCH', '/api/bots/:id/skills/:name', /^\/api\/bots\/[\w-]+\/skills\/[a-z0-9-]+$/],
    ],
  },
];

const pairedPhoneHarnessRoutes = PAIRED_PHONE_HARNESS_ROUTE_GROUPS.flatMap((group) =>
  group.routes.map(([method, path, pattern]) => ({
    method,
    path,
    pattern,
    local: false,
    requiresDevice: true,
    description: group.description,
  })),
);

/**
 * The companion subset the bridge serves, in advertisement order. A route
 * marked local is answered by the bridge itself, from its own registry
 * (pairing and devices live per route, so no secret is shared with the Mac);
 * any other route is a transparent proxy to the same harness path.
 *
 * A row with a `pattern` is matched against the raw, undecoded path.  A row
 * without one is a template whose `:param` segment is any single segment the
 * traversal check let through.  `requiresDevice` is read per row:  a local
 * route that extends a device's reach needs the device credential, every
 * proxied route needs it, and the two exceptions are the routes a phone calls
 * while it is not paired yet, `GET /api/health` and `POST /api/pair`, plus
 * the advertisement, which is the owner's to read.
 */
export const BRIDGE_ALLOWED_ROUTES = [
  { method: 'GET', path: '/api/companion/endpoints', local: true, requiresDevice: false, description: 'route advertisement, served locally' },
  { method: 'POST', path: '/api/pair', local: true, requiresDevice: false, description: 'pair a phone: redeem a code or QR token for a device credential, in the shape the iOS app decodes' },
  { method: 'POST', path: '/api/companion/pairing/open', local: true, requiresDevice: false, description: 'open a pairing window' },
  { method: 'POST', path: '/api/companion/pairing/redeem', local: true, requiresDevice: false, description: 'redeem a pairing code or token once' },
  { method: 'GET', path: '/api/companion/devices', local: true, requiresDevice: false, description: 'public device list' },
  { method: 'DELETE', path: '/api/companion/devices/:id', local: true, requiresDevice: false, description: 'revoke one device' },
  { method: 'POST', path: '/api/companion/push-token', local: true, requiresDevice: true, description: 'register device APNs alert token' },
  { method: 'POST', path: '/api/companion/live-activity-token', local: true, requiresDevice: true, description: 'register device Live Activity push-to-start token' },
  { method: 'GET', path: '/api/companion/push-health', local: true, requiresDevice: true, description: 'APNs sender health without key material' },
  // The first thing the iOS app does on a route is probe this, before it has
  // a device credential, so it is forwarded without one.  It is still behind
  // the owner credential like every other route.
  { method: 'GET', path: '/api/health', pattern: /^\/api\/health$/, local: false, requiresDevice: false, description: 'harness liveness and readiness, forwarded; the one proxied route a phone may call before it is paired' },
  ...pairedPhoneHarnessRoutes,
];

/**
 * Whether a local bridge route requires an authenticated paired device.
 * Kept separate from `bridgeRouteDecision` so existing callers and tests
 * continue to observe the exact `{ ok, upstream, local }` decision shape.
 *
 * @param {string} method
 * @param {string} url
 * @returns {boolean}
 */
export function bridgeLocalRouteRequiresDevice(method, url) {
  const decision = bridgeRouteDecision(method, url);
  return decision.ok === true && decision.local === true && decision.route.requiresDevice === true;
}

/**
 * Whether one route's path matches the request. A `pattern` row is tested
 * against the raw, undecoded path, exactly as the sidecar tests its own
 * patterns. A template row compares each literal segment in decoded form and
 * lets a `:param` segment stand for any one segment the traversal check
 * already let through.
 *
 * @param {{path: string, pattern?: RegExp}} route
 * @param {string} path
 * @param {string[]} decoded
 * @returns {boolean}
 */
function routePathMatches(route, path, decoded) {
  if (route.pattern) return route.pattern.test(path);
  const pattern = route.path.split('/').slice(1);
  if (pattern.length !== decoded.length) return false;
  for (let index = 0; index < pattern.length; index += 1) {
    const part = pattern[index];
    if (!part.startsWith(':') && part !== decoded[index]) return false;
  }
  return true;
}

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
 * A path that matches a row under another method is a 405, and anything
 * else is a 404. The answer carries the matched row so the caller reads
 * `requiresDevice` from the table instead of a second list.
 *
 * @param {string} method
 * @param {string} url
 * @returns {{ok: true, upstream: string, local: boolean, route: {method: string, path: string, local: boolean, requiresDevice: boolean}} | {ok: false, status: number, reason: string}}
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
    if (!routePathMatches(route, path, decoded)) continue;
    if (route.method !== verb) {
      methodSeen = true;
      continue;
    }
    // The path is handed on exactly as it arrived, never rebuilt from the
    // row, so a `$` sequence in it can never be read as a replacement.
    return { ok: true, upstream: `${path}${query}`, local: route.local, route };
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
 * The caller hands this check the PARSED form of the value it read through
 * JSON, and that is the form the window keeps as well, so the value that is
 * checked and the value that is kept are the same value. Reading the
 * serialized form first is what makes that possible: a value with a custom
 * toJSON, or a getter that answers twice, would otherwise be checked as one
 * value and kept as another, and a cleartext credential could hide in the
 * difference.
 *
 * The parsed form is bounded by the length of the serialized text, because
 * the caller has already refused anything longer than the size gate. The
 * serialized length is therefore the only bound there is: there is no depth
 * limit and no node limit, so a credential nested at any depth is still a
 * leaf in that structure and is still found, while a benign value that is
 * merely wide or deep is kept, because nothing about it carries a
 * credential.
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
function isCredentialFieldValue(value, digests = {}) {
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
  return walk(value);
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
    // The value is read once and serialized once, and the structure that
    // text describes is what the check reads and what the window keeps, so
    // the checked value and the kept value can never be two different
    // values.
    const value = source[key];
    let serialized = null;
    try {
      serialized = JSON.stringify(value ?? null);
    } catch {
      continue;
    }
    const size = serialized?.length ?? 0;
    if (!Number.isFinite(size) || size > MAX_WINDOW_METADATA_CHARS) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      // A value that cannot be read back is not a value the window keeps.
      continue;
    }
    if (isCredentialFieldValue(parsed, { codeDigest: source.codeDigest, tokenDigest: source.tokenDigest })) continue;
    // A value the caller left absent stays absent: the key is skipped rather
    // than kept with an undefined value, so it is not a key of the window
    // and it does not spend one of the kept slots.
    if (value === undefined) continue;
    extra[key] = parsed;
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

const isStringValue = (value) => Object.prototype.toString.call(value) === '[object String]';
const isNumberValue = (value) => Object.prototype.toString.call(value) === '[object Number]' && Number.isFinite(value);
const isBooleanValue = (value) => value === true || value === false;

/**
 * Validate and normalize a hex APNs device or Live Activity token.
 * Matches `Client.swift` (>= 64 lowercase hex characters).
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function validateBridgePushToken(raw) {
  if (!isStringValue(raw)) return null;
  const normalized = String(raw).replace(/\s+/g, '').toLowerCase();
  if (!/^[0-9a-f]{64,512}$/.test(normalized)) return null;
  return normalized;
}

/** Literal Swift type name decoded by ActivityKit on iOS. */
export const LIVE_ACTIVITY_ATTRIBUTES_TYPE = 'BotActivityAttributes';

/** Seconds between Unix epoch and Apple's reference date (2001-01-01T00:00:00Z). */
export const APPLE_REFERENCE_DATE_OFFSET = 978_307_200;

/** Default Live Activity palette name when the notify frame carries none. */
export const DEFAULT_LIVE_ACTIVITY_COLOR = 'gray';

/**
 * Derive the Live Activity APNs topic from the bundle identifier.
 *
 * @param {string} bundleId
 * @returns {string}
 */
export function liveActivityTopic(bundleId) {
  return `${String(bundleId ?? '').trim()}.push-type.liveactivity`;
}

/**
 * True when an alert kind represents a blocking user prompt (approval or question).
 *
 * @param {unknown} kind
 * @returns {boolean}
 */
export function isBlockingAlertKind(kind) {
  return BLOCKING_KINDS.has(String(kind ?? ''));
}

/**
 * Full APNs alert envelope mirroring `companion/src/apns.ts` `apnsPayload`.
 *
 * @param {{title?: string, body?: string, threadId?: string, botId?: string, kind?: string, requestId?: string, tool?: string, seq?: number}} [input]
 * @returns {Record<string, unknown>}
 */
export function buildBridgeAlertEnvelope({ title, body, threadId, botId, kind, requestId, tool, seq } = {}) {
  const payload = buildBridgeAlertPayload({ title, body, threadId, kind });
  if (isStringValue(threadId) && threadId !== '') payload.threadId = threadId;
  if (isStringValue(botId) && botId !== '') payload.botId = botId;
  if (isStringValue(kind) && kind !== '') payload.kind = kind;
  if (isStringValue(requestId) && requestId !== '') payload.requestId = requestId;
  if (isStringValue(tool) && tool !== '') payload.tool = tool;
  if (Number.isFinite(seq)) payload.seq = seq;
  return payload;
}

/**
 * Map a harness notify object onto `BotActivityAttributes` and `ContentState`.
 * Returns null if `raw` is not a plain object or has malformed field types.
 *
 * @param {unknown} raw
 * @param {number} [nowMs]
 * @returns {{attributes: Record<string, unknown>, state: Record<string, unknown>, alert: {title: string, body: string}}|null}
 */
export function buildBridgeLiveActivityContent(raw, nowMs = Date.now()) {
  if (!raw || Object(raw) !== raw || Array.isArray(raw)) return null;
  const str = (key) => {
    const val = raw[key];
    if (val === undefined || val === null) return undefined;
    return isStringValue(val) ? val : null;
  };
  const title = str('title');
  const body = str('body');
  const kind = str('kind');
  const threadId = str('threadId');
  const botId = str('botId');
  const requestId = str('requestId');
  const botName = str('botName');
  const color = str('color');
  if ([title, body, kind, threadId, botId, requestId, botName, color].includes(null)) return null;
  let options;
  if (raw.options !== undefined && raw.options !== null) {
    if (!Array.isArray(raw.options) || !raw.options.every((item) => isStringValue(item))) return null;
    options = [...raw.options];
  }
  let isPermission;
  if (raw.isPermission !== undefined && raw.isPermission !== null) {
    if (!isBooleanValue(raw.isPermission)) return null;
    isPermission = raw.isPermission;
  }
  let sinceMs = nowMs;
  if (raw.since !== undefined && raw.since !== null) {
    if (!isNumberValue(raw.since)) return null;
    sinceMs = raw.since;
  }

  const blocking = isBlockingAlertKind(kind);
  const name = botName ?? title ?? 'BotFleet';
  const resolvedPermission = isPermission ?? (kind === 'approval');
  const headline = blocking ? `${name} needs you` : `${name} is working`;
  const state = {
    face: blocking ? 'thinking' : 'idle',
    kind: blocking ? 'needsYou' : kind === 'done' ? 'toReview' : 'working',
    headline,
    line: body ?? '',
    options: options ?? (resolvedPermission ? ['Allow', 'Deny'] : []),
    isPermission: resolvedPermission,
    since: sinceMs / 1000 - APPLE_REFERENCE_DATE_OFFSET,
  };
  if (requestId !== undefined) state.requestId = requestId;
  return {
    attributes: {
      botId: botId ?? '',
      threadId: threadId ?? '',
      name,
      color: color ?? DEFAULT_LIVE_ACTIVITY_COLOR,
    },
    state,
    alert: { title: headline, body: body ?? '' },
  };
}

/**
 * Build the APNs payload for a Live Activity start, update, or end push.
 *
 * @param {{event: 'start'|'update'|'end', attributes: Record<string, unknown>, state: Record<string, unknown>, alert?: {title: string, body: string}, timestamp?: number, dismissalDate?: number}} input
 * @returns {{aps: Record<string, unknown>}}
 */
export function buildBridgeLiveActivityPayload({
  event,
  attributes,
  state,
  alert,
  timestamp,
  dismissalDate,
} = {}) {
  const ts = Number.isFinite(timestamp) ? Math.floor(timestamp) : Math.floor(Date.now() / 1000);
  const { requestId, ...restState } = state ?? {};
  const contentState = requestId === undefined ? { ...restState } : { ...restState, requestId };
  const aps = {
    timestamp: ts,
    event,
    'content-state': contentState,
  };
  if (event === 'start') {
    aps['attributes-type'] = LIVE_ACTIVITY_ATTRIBUTES_TYPE;
    aps.attributes = attributes;
    aps.alert = alert ?? { title: String(state?.headline ?? ''), body: String(state?.line ?? '') };
  }
  if (event === 'end' && Number.isFinite(dismissalDate)) {
    aps['dismissal-date'] = Math.floor(dismissalDate);
  }
  return { aps };
}

/**
 * The profile fields a paired phone owns, copied from the sidecar's
 * `COMPANION_PROFILE_PATCH_FIELDS`.
 *
 * The harness route behind `PATCH /api/bots/:id/profile` is the desktop's
 * general bot editor, and for a phone it enforces no field list of its own.
 * Unchecked, a paired phone could write a bot's own MCP servers, its
 * connected-app settings or its cloud backend through this one route, so the
 * bridge refuses the whole request when it names a field that is not here.
 * The harness still decides what each VALUE means, including its refusal to
 * turn Auto-Approve on for a bot that can use the computer.
 *
 * The copy is checked the same way the route list is: the parity test fails
 * when this drifts from the sidecar.
 */
export const BRIDGE_PROFILE_PATCH_FIELDS = Object.freeze([
  'name',
  'title',
  'description',
  'notifications',
  'avatarUrl',
  'avatarCrop',
  'voice',
  'voices',
  'speakReplies',
  'speechDevices',
  'modelSelection',
  'computers',
  'maxToolRounds',
  'cwd',
  'autoApprove',
  'autoReview',
  'approvePeerComms',
  'bypassPermissions',
  'bypassLocalComputer',
  'off',
]);

const BRIDGE_PROFILE_PATCH_FIELD_SET = new Set(BRIDGE_PROFILE_PATCH_FIELDS);

/** The one bot-level PATCH a paired phone may send, as the sidecar names it. */
export const BRIDGE_BOT_ORGANIZE_ROUTE_PATTERN = /^\/api\/bots\/[\w-]+$/;

/** The profile route, as the sidecar's `isCompanionProfilePatch` names it. */
export const BRIDGE_PROFILE_PATCH_ROUTE_PATTERN = /^\/api\/bots\/[\w-]+\/profile$/;

/**
 * The six roster-organization fields of `PATCH /api/bots/:id`, copied from
 * the sidecar's `COMPANION_BOT_ORGANIZE_FIELDS`. Each one changes where a
 * bot sits or how it is marked, never what it may do.
 */
export const BRIDGE_BOT_ORGANIZE_FIELDS = Object.freeze([
  'hidden',
  'pinned',
  'unread',
  'chiefOfStaff',
  'section',
  'pinnedMessageId',
]);

const BRIDGE_BOT_ORGANIZE_FIELD_SET = new Set(BRIDGE_BOT_ORGANIZE_FIELDS);
const BRIDGE_BOT_ORGANIZE_BOOLEAN_FIELDS = new Set(['hidden', 'pinned', 'unread', 'chiefOfStaff']);

/**
 * True for a string that came out of `JSON.parse`, which never yields a
 * boxed one, so the object tag is the same test as `typeof` without a
 * runtime typeof check.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isJsonString(value) {
  return Object.prototype.toString.call(value) === '[object String]';
}

/**
 * True for a JSON object, as `JSON.parse` produces one.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isJsonObject(value) {
  if (value === null || value === undefined || Array.isArray(value)) return false;
  return Object.prototype.toString.call(value) === '[object Object]';
}

/**
 * The refusal for a body that is not a JSON object, or null when it is one.
 * Every body check below starts here, so a check never reads keys off an
 * array, a string or a number.
 *
 * @param {unknown} body
 * @returns {{status: number, error: string}|null}
 */
function bridgeBodyRefusal(body) {
  return isJsonObject(body) ? null : { status: 400, error: 'body must be a JSON object' };
}

/**
 * Validate a paired phone's bot profile body before it reaches the broader
 * harness route. Reject the whole request rather than silently stripping a
 * field the person expected to save.
 *
 * @param {unknown} body
 * @returns {{status: number, error: string}|null}
 */
export function bridgeProfilePatchDenial(body) {
  const shape = bridgeBodyShapeRefusal(body);
  if (shape) return shape;
  const unsupported = Object.keys(body).find((field) => !BRIDGE_PROFILE_PATCH_FIELD_SET.has(field));
  return unsupported
    ? { status: 403, error: `${unsupported} can only be changed in BotFleet on your computer` }
    : null;
}

/**
 * Validate the organize boundary before a body reaches the harness. The
 * harness copies `hidden`, `pinned` and `unread` into the stored bot, so the
 * types are checked here as well as the names. Whole-request rejection,
 * like the profile route. The harness stays the authority on length limits
 * and on rules that need the stored bot, such as refusing to archive the
 * Chief Of Staff.
 *
 * @param {unknown} body
 * @returns {{status: number, error: string}|null}
 */
export function bridgeBotOrganizeDenial(body) {
  const shape = bridgeBodyShapeRefusal(body);
  if (shape) return shape;
  const fields = Object.keys(body);
  if (fields.length === 0) return { status: 400, error: 'nothing to save' };
  const unsupported = fields.find((field) => !BRIDGE_BOT_ORGANIZE_FIELD_SET.has(field));
  if (unsupported) {
    return { status: 403, error: `${unsupported} can only be changed in BotFleet on your computer` };
  }
  for (const field of fields) {
    const value = body[field];
    if (BRIDGE_BOT_ORGANIZE_BOOLEAN_FIELDS.has(field)) {
      if (value !== true && value !== false) return { status: 400, error: `${field} must be true or false` };
    } else if (field === 'section') {
      if (value !== null && !isJsonString(value)) {
        return { status: 400, error: 'section must be a string or null' };
      }
    } else if (field === 'pinnedMessageId') {
      if (value !== null && !(isJsonString(value) && /^[\w-]*$/.test(value))) {
        return { status: 400, error: 'pinnedMessageId must be a message id or null' };
      }
    }
  }
  return null;
}

/**
 * The body check a forwarded request needs, or null when the route list
 * alone decides it. One lookup for the proxy, so a new checked route is one
 * line here rather than another branch there.
 *
 * @param {string} method
 * @param {string} path the raw, undecoded path
 * @returns {((body: unknown) => {status: number, error: string}|null)|null}
 */
export function bridgeBodyCheck(method, path) {
  const raw = String(path ?? '');
  if (method !== 'PATCH') return null;
  if (BRIDGE_PROFILE_PATCH_ROUTE_PATTERN.test(raw)) return bridgeProfilePatchDenial;
  if (BRIDGE_BOT_ORGANIZE_ROUTE_PATTERN.test(raw)) return bridgeBotOrganizeDenial;
  return null;
}

/**
 * The keys the harness may say and a phone has no business holding, copied
 * from the sidecar's `wire.ts`.
 *
 * `resumeCursors` is the harness's own bookkeeping, the native session id to
 * resume per instance per task. `sshAlias` is the self-hosted VPS label, a
 * name for one of the owner's servers, which the config status echoes in
 * `vps`. The phone renders configured-or-not and nothing more, so
 * `{configured: true}` survives and the label does not.
 *
 * The harness already drops `resumeCursors` at source today. The scrubber
 * stays, because it is the sidecar's rule and because a harness that carries
 * an older payload must not hand the phone anything the Mac withholds.
 */
export const BRIDGE_WITHHELD_RESPONSE_KEYS = Object.freeze(['resumeCursors', 'sshAlias']);

const BRIDGE_WITHHELD_RESPONSE_KEY_SET = new Set(BRIDGE_WITHHELD_RESPONSE_KEYS);

/**
 * Whether a serialized payload names a withheld key at all. This is the fast
 * path: a payload that names none is forwarded as the exact bytes that
 * arrived, with no parse and no re-serialization.
 *
 * @param {string} text
 * @returns {boolean}
 */
function holdsWithheldKey(text) {
  for (const key of BRIDGE_WITHHELD_RESPONSE_KEYS) {
    if (text.includes(key)) return true;
  }
  return false;
}

/**
 * Recursively drop the withheld keys, wherever they appear.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function bridgeScrub(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(bridgeScrub);
  if (!isJsonObject(value)) return value;
  // A null prototype, so a payload key spelled `__proto__` becomes an own
  // property of the copy instead of the copy's prototype.
  const out = Object.create(null);
  for (const [key, inner] of Object.entries(value)) {
    if (BRIDGE_WITHHELD_RESPONSE_KEY_SET.has(key)) continue;
    out[key] = bridgeScrub(inner);
  }
  return out;
}

/**
 * Scrub one serialized JSON payload.
 *
 * A payload that names no withheld key comes back as the same string. One
 * that does not parse comes back unchanged too: it was never JSON, so
 * there is nothing of ours in it to remove. One that parses but cannot be
 * scrubbed throws, because a deeply nested body can outlast the scrubber's
 * recursion while `JSON.parse` handles it, and forwarding that unscrubbed
 * would send exactly what the scrubber exists to withhold. The caller must
 * end the response rather than forward it.
 *
 * @param {string} jsonString
 * @returns {string}
 */
export function bridgeScrubWireJson(jsonString) {
  const text = String(jsonString ?? '');
  if (!holdsWithheldKey(text)) return text;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  return JSON.stringify(bridgeScrub(parsed));
}

/**
 * Whether a body is worth parsing at all, decided by its content type. An
 * image endpoint must never be parsed as JSON.
 *
 * The `+json` suffix counts: `application/problem+json` is JSON by every
 * measure that matters here, and the harness only has to answer one error
 * that way for a withheld key to reach a phone unscrubbed.
 *
 * @param {string|undefined} contentType
 * @returns {boolean}
 */
export function bridgeIsJson(contentType) {
  const media = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  return media === 'application/json' || media.endsWith('+json');
}

/**
 * How much of a single SSE event the scrubber holds while waiting for its
 * terminator. Generous, because the largest real frame is a bot payload,
 * orders of magnitude under this; the number only exists to be a ceiling.
 */
export const MAX_BRIDGE_SSE_EVENT_BYTES = 1024 * 1024;

/**
 * The first event terminator in `text`, whichever spelling it uses.
 *
 * A partial terminator at the end of a chunk, such as a CRLF pair missing
 * its last byte, matches neither and stays buffered: the rest is one chunk
 * away, and splitting an event across a scrub would corrupt it.
 *
 * @param {string} text
 * @returns {{index: number, terminator: string}|null}
 */
function nextEventBoundary(text) {
  let best = null;
  for (const terminator of ['\n\n', '\r\n\r\n', '\r\r']) {
    const index = text.indexOf(terminator);
    if (index < 0) continue;
    // Earliest wins, and on a tie the longer terminator does: an LF-only
    // match inside a CRLF pair would cut the event a byte short of its end.
    if (!best || index < best.index || (index === best.index && terminator.length > best.terminator.length)) {
      best = { index, terminator };
    }
  }
  return best;
}

/**
 * One complete SSE event, its `data:` payload scrubbed and everything else
 * kept. The ending the event arrived with is the one it leaves with, and
 * `id:` lines are never touched: they are the resume cursor.
 *
 * An event that names no withheld key is returned as the exact text that
 * arrived, so a keepalive comment or an ordinary frame crosses unchanged.
 *
 * @param {string} event
 * @returns {string}
 */
function scrubBridgeEvent(event) {
  if (!holdsWithheldKey(event)) return event;
  const eol = event.includes('\r\n') ? '\r\n' : event.includes('\r') ? '\r' : '\n';
  return event
    .split(/\r\n|\r|\n/)
    .map((line) => {
      // `: keepalive` comments, `id:`, `event:`, `retry:` are not ours to touch.
      if (!line.startsWith('data:')) return line;
      const raw = line.slice(5).trimStart();
      if (!raw) return line;
      return `data: ${bridgeScrubWireJson(raw)}`;
    })
    .join(eol);
}

/**
 * A scrubber for one SSE stream, fed one decoded chunk at a time.
 *
 * It must not swallow blank lines: the blank line IS the event terminator,
 * and a rewrite that normalizes it produces a stream that parses to nothing
 * while both ends look healthy. It must not wait for more than one event
 * either: buffering to a frame boundary is fine, and buffering for a size
 * or a timer turns a live stream into a batch one. Both line endings are
 * recognised, because a scrubber that knows only LF buffers a CRLF stream
 * forever waiting for a boundary that never comes.
 *
 * Buffering to a boundary is bounded by the sender's good behaviour, which
 * is not a bound. A stream that never sends a terminator grows the buffer
 * without limit, so passing the ceiling throws and the caller drops the
 * connection: there is no safe way to flush half an event.
 *
 * @returns {(chunk: string) => string}
 */
export function createBridgeSseScrubber() {
  let pending = '';
  return (chunk) => {
    pending += chunk;
    let out = '';
    for (;;) {
      const boundary = nextEventBoundary(pending);
      if (!boundary) break;
      const event = pending.slice(0, boundary.index);
      pending = pending.slice(boundary.index + boundary.terminator.length);
      out += scrubBridgeEvent(event) + boundary.terminator;
    }
    if (pending.length > MAX_BRIDGE_SSE_EVENT_BYTES) {
      throw new Error(`SSE event exceeded ${MAX_BRIDGE_SSE_EVENT_BYTES} bytes without a terminator`);
    }
    return out;
  };
}

/** The most routes one advertisement carries, the cap the iOS decoder accepts. */
export const BRIDGE_MAX_ENDPOINTS = 8;

/**
 * What the bridge calls itself in the phone's connection list. The bridge
 * is one process serving the whole server, so unlike a Mac it has no name of
 * its own to offer, and a fixed honest label beats an empty one that leaves
 * a typed address standing in for the server's name.
 */
export const BRIDGE_SERVER_NAME = 'BotFleet Server';

/**
 * A host in the form the kind rules compare: lowercase, without IPv6
 * brackets, and without the trailing dot a resolver accepts.
 *
 * @param {string} hostname
 * @returns {string}
 */
function normalizedHostName(hostname) {
  let host = String(hostname ?? '').trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  while (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

/**
 * A Tailscale MagicDNS name, by the rule the iOS decoder applies: longer
 * than the suffix and ending in `.ts.net`.
 *
 * @param {string} host
 * @returns {boolean}
 */
function isTailnetHostName(host) {
  return host.length > '.ts.net'.length && host.endsWith('.ts.net');
}

/**
 * Whether a host is one no phone can dial to reach this server: loopback,
 * the unspecified address, a link-local address, or a name that resolves to
 * loopback. Advertising one hands the phone a route that cannot work.
 *
 * @param {string} host a normalized host name
 * @returns {boolean}
 */
function isUnroutableHostName(host) {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0' || host === '::' || host === '::1') return true;
  if (/^127(\.\d{1,3}){3}$/.test(host)) return true;
  if (/^169\.254(\.\d{1,3}){2}$/.test(host)) return true;
  return /^fe[89ab]/.test(host);
}

/**
 * Read one configured or derived origin and answer it in normal form, or an
 * empty string when it is not a route a phone could dial.
 *
 * A hosted route is public internet infrastructure, so accepting a typo as
 * though it were a route is worse than refusing it. It has to be an absolute
 * `http` or `https` origin: paths, credentials, queries and fragments have
 * no place in a base URL and make request construction ambiguous.
 *
 * @param {string} text
 * @returns {string}
 */
export function bridgeCleanOrigin(text) {
  let parsed;
  try {
    parsed = new URL(String(text ?? '').trim());
  } catch {
    return '';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
  if (parsed.username !== '' || parsed.password !== '') return '';
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') return '';
  if (isUnroutableHostName(normalizedHostName(parsed.hostname))) return '';
  return parsed.origin;
}

/**
 * The endpoint kind the iOS `CompanionEndpoint` decoder will accept for a
 * route, or an empty string when it accepts none.
 *
 * The kind decides whether the phone will send its credential over the
 * route: `hosted` and `tailnet` are protected transports, `lan` and
 * `bonjour` are cleartext and need the person's explicit choice. The decoder
 * is strict about the pairing of scheme and kind. `tailnet` is accepted only
 * for plain `http` on a `.ts.net` name, which is how the Mac sidecar's own
 * tailnet route is published. `tailscale serve --https` terminates TLS, so
 * the bridge's tailnet route arrives as `https`, and for an `https` URL the
 * decoder accepts exactly one kind, `hosted`. That is therefore the label a
 * bridge route behind `tailscale serve` has to carry to be decodable at all.
 *
 * @param {string} url
 * @returns {'hosted'|'tailnet'|'lan'|''}
 */
export function bridgeEndpointKind(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ''));
  } catch {
    return '';
  }
  if (parsed.protocol === 'https:') return 'hosted';
  if (parsed.protocol !== 'http:') return '';
  return isTailnetHostName(normalizedHostName(parsed.hostname)) ? 'tailnet' : 'lan';
}

/**
 * The routes one advertisement carries, best first, as the iOS
 * `CompanionEndpoint` decodes them.
 *
 * @param {string[]|undefined} origins normalized origins, in preference order
 * @returns {Array<{url: string, kind: 'hosted'|'tailnet'|'lan', priority: number}>}
 */
export function bridgeEndpoints(origins) {
  const endpoints = [];
  const seen = new Set();
  for (const candidate of Array.isArray(origins) ? origins : []) {
    if (endpoints.length >= BRIDGE_MAX_ENDPOINTS) break;
    const origin = bridgeCleanOrigin(candidate);
    const kind = origin ? bridgeEndpointKind(origin) : '';
    if (!origin || !kind || seen.has(origin)) continue;
    seen.add(origin);
    endpoints.push({ url: origin, kind, priority: endpoints.length * 100 });
  }
  return endpoints;
}

/**
 * Parse the configured advertisement: one origin or a comma-separated list,
 * first entry first. An entry that is blank is ignored, a duplicate costs
 * nothing, and anything that is not a clean origin is refused loudly rather
 * than skipped, because a skipped entry is a route the owner believes is
 * advertised and is not.
 *
 * @param {string|undefined} value
 * @returns {{ok: true, origins: string[]} | {ok: false, reason: string}}
 */
export function bridgeParseOrigins(value) {
  const origins = [];
  for (const part of String(value ?? '').split(',')) {
    const origin = bridgeCleanOrigin(part);
    if (!origin) {
      if (part.trim() === '') continue;
      return {
        ok: false,
        reason:
          'every entry must be an absolute http or https origin with no path, credentials, query or fragment, ' +
          'and no loopback or link-local host',
      };
    }
    if (origins.includes(origin)) continue;
    origins.push(origin);
    if (origins.length > BRIDGE_MAX_ENDPOINTS) {
      return { ok: false, reason: `at most ${BRIDGE_MAX_ENDPOINTS} origins may be listed` };
    }
  }
  return { ok: true, origins };
}

/**
 * A device name comes from the phone, so it is untrusted display text:
 * clamp the length and drop control characters before it reaches a UI.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function bridgeCleanDeviceName(raw) {
  const name = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 60);
  return name || 'Companion';
}

/**
 * The pairing refusal a person reads, for one internal reason.
 *
 * The iOS app shows the server's own error text, so this is the sentence on
 * the pairing screen. A reason this does not know gets the general sentence
 * rather than the internal wording, which is written for a log.
 *
 * @param {string} reason
 * @returns {string}
 */
export function bridgePairRefusalSentence(reason) {
  switch (reason) {
    case 'no pairing window is open':
      return 'No pairing window is open on this server, so there is nothing to pair with. Start pairing again.';
    case 'window expired':
      return 'That pairing window has expired. Start pairing again.';
    case 'window already spent':
      return 'That pairing credential was already used. Start pairing again.';
    case 'no attempts left':
      return 'Too many incorrect codes. Start pairing again.';
    case 'bad credential':
      return 'That pairing code or token is not right.';
    case 'the device limit is reached':
      return 'Too many paired devices. Remove one first.';
    default:
      return 'This server could not complete the pairing. Start pairing again.';
  }
}

/**
 * The refusal for a retried pairing request. The bridge hands a device
 * credential out exactly once and keeps only its digest, so the same phone
 * request that arrives after a lost response cannot be answered with a
 * credential a second time, and a body shaped like a pairing success with
 * no credential would leave the phone holding an empty token.
 */
export const BRIDGE_PAIR_REPLAY_REFUSAL = Object.freeze({
  status: 409,
  error: 'That pairing request was already completed, and its credential is issued only once. Start pairing again.',
});
