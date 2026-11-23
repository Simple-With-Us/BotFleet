#!/usr/bin/env node
/**
 * The Linux-server companion bridge listener (BF-2691).
 *
 * This is the packaging half of `companion-bridge.mjs`: the decision core
 * there is pure (routes, digests, windows, one-sender, payload shape) and
 * this file is the process around it.  The listener binds loopback only,
 * owns every piece of state the bridge has (the pairing window, the device
 * registry, the advertisement), and forwards the proxied routes to the
 * harness on 127.0.0.1:8799 byte for byte, so a cursor parameter or a
 * query string never changes shape on the way through.
 *
 * Two layers of default-off, and neither is optional:
 *
 *  1. The installer only writes and enables the unit when the host asks for
 *     it (BF_COMPANION_BRIDGE=1).  Without that, `install.sh`, `update.sh`
 *     and `uninstall.sh` behave exactly as they do on main.
 *  2. This process refuses to start without an owner credential and a
 *     registry it can write, so an installed-but-unconfigured unit fails
 *     loudly instead of serving an open route.
 *
 * Credentials.  Every request needs an owner credential, exactly like the
 * owner gate: a Tailscale login on the allowlist (a user-owned device, where
 * `tailscale serve` adds `Tailscale-User-Login`) or the desktop gate token
 * in `x-botfleet-gate-token` (a tagged device, where that header is never
 * added).  The gate token is compared by digest and never stored in
 * cleartext, and the token header is dropped before a proxied request
 * reaches the harness, so the harness sees a plain loopback caller.
 *
 * The bridge's device registry holds digests only.  A redeemed credential
 * is stored as its sha256, compared with a timing-safe comparison, and a
 * malformed entry is skipped rather than trusted.  The credential itself is
 * returned to the phone once, at redeem time, and never again.
 *
 * What this file is NOT: it does not send push notifications, it does not
 * bind anything but loopback, it does not retire the Node `:8810`
 * sidecar, and it does not change any route on the harness.  The APNs
 * material the Linux sender would use is resolved by
 * `companion-bridge-apns.mjs` through the scoped read-only Infisical
 * binding, and nothing here sends it anywhere.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';

import {
  BRIDGE_ALLOWED_ROUTES,
  bridgeDeviceDecision,
  bridgeRouteDecision,
  OMB_PAIR_TOKEN,
  openBridgePairingWindow,
  redeemBridgePairingWindow,
  replayableRequestId,
  sha256Hex,
} from './companion-bridge.mjs';
import {
  readBootstrapTokenFile,
  readInfisicalSecrets,
} from '../../electron/infisical-read.mjs';
import { bridgeApnsMaterial } from './companion-bridge-apns.mjs';
import { loadBridgeState, saveBridgeState } from './companion-bridge-state.mjs';

/** The loopback address the listener binds.  Never a routable address. */
export const BRIDGE_HOST = '127.0.0.1';

/** The loopback port the listener binds.  0 lets the system pick one. */
export const BRIDGE_PORT = 8797;

/** The harness the proxied routes reach.  Loopback, like the gate's. */
export const BRIDGE_UPSTREAM_HOST = '127.0.0.1';
export const BRIDGE_UPSTREAM_PORT = 8799;

/** How long a pairing window stays open, and how many wrong tries it takes. */
export const BRIDGE_WINDOW_TTL_SECONDS = 300;
export const BRIDGE_WINDOW_MAX_ATTEMPTS = 5;

/** The most devices one bridge holds. */
export const BRIDGE_MAX_DEVICES = 32;

/** The header the phone presents its device credential in. */
const DEVICE_AUTHORIZATION_HEADER = 'authorization';
/** The header the owner gate token travels in. */
const OWNER_TOKEN_HEADER = 'x-botfleet-gate-token';
/** The header `tailscale serve` adds for a user-owned device. */
const OWNER_LOGIN_HEADER = 'tailscale-user-login';

/** The route the listener answers for itself, without touching the harness. */
const BRIDGE_HEALTH_PATH = '/__bridge/health';

/**
 * True when the value is a string.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isText(value) {
  return Object.prototype.toString.call(value) === '[object String]';
}

/**
 * True when the value is an object rather than a primitive.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isObject(value) {
  return Object(value) === value && !(value instanceof Function);
}

/**
 * True when the value can be called.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isCallable(value) {
  if (value === null || value === undefined) return false;
  return Object.prototype.toString.call(value).endsWith('Function]');
}

/**
 * Read one header, case-insensitively.
 *
 * @param {Record<string, string|string[]|undefined>|undefined} headers
 * @param {string} name
 * @returns {string|undefined}
 */
export function bridgeHeaderValue(headers, name) {
  if (!headers || !isObject(headers)) return undefined;
  const wanted = String(name).toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = headers[key];
    if (Array.isArray(value)) return value.length ? String(value[0]) : undefined;
    if (value === undefined || value === null) continue;
    return String(value);
  }
  return undefined;
}

/**
 * True when the address is a loopback address.
 *
 * @param {string|undefined|null} address
 * @returns {boolean}
 */
export function isBridgeLoopbackAddress(address) {
  if (!address) return false;
  let value = String(address).trim().toLowerCase();
  if (!value) return false;
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length);
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

/**
 * The owner login `tailscale serve` added, lowercased.
 *
 * @param {Record<string, string|string[]|undefined>|undefined} headers
 * @returns {string}
 */
export function bridgePresentedLogin(headers) {
  return (bridgeHeaderValue(headers, OWNER_LOGIN_HEADER) ?? '').trim().toLowerCase();
}

/**
 * Parse the owner allowlist.
 *
 * @param {string|undefined|null} value
 * @returns {Set<string>}
 */
export function bridgeParseOwnerLogins(value) {
  const owners = new Set();
  for (const part of String(value ?? '').split(',')) {
    const login = part.trim().toLowerCase();
    if (login) owners.add(login);
  }
  return owners;
}

/**
 * Does the request carry the owner gate token?
 *
 * The token is hashed and compared against the configured digest with a
 * timing-safe comparison, so the comparison leaks neither the token nor how
 * much of it matched.
 *
 * @param {Record<string, string|string[]|undefined>|undefined} headers
 * @param {string|null|undefined} tokenSha256
 * @returns {boolean}
 */
export function bridgeTokenMatches(headers, tokenSha256) {
  if (!tokenSha256 || !/^[0-9a-f]{64}$/.test(String(tokenSha256))) return false;
  const presented = bridgeHeaderValue(headers, OWNER_TOKEN_HEADER);
  if (!presented) return false;
  const digest = crypto.createHash('sha256').update(presented, 'utf8').digest();
  const expected = Buffer.from(String(tokenSha256), 'hex');
  if (expected.length !== digest.length) return false;
  return crypto.timingSafeEqual(digest, expected);
}

/**
 * Decide whether a request carries an owner credential.
 *
 * The rules run in a fixed order: the caller must be loopback, then it must
 * present an owner credential, then the browser Origin must match the one
 * allowed public origin, then the request must not be cross-site.
 *
 * @param {{remoteAddress?: string, headers?: Record<string, string|string[]|undefined>, owners?: Set<string>|string, publicOrigin?: string, tokenSha256?: string|null}} input
 * @returns {{ok: true} | {ok: false, status: number, reason: string}}
 */
export function bridgeOwnerDecision({ remoteAddress, headers, owners, publicOrigin, tokenSha256 } = {}) {
  if (!isBridgeLoopbackAddress(remoteAddress)) {
    return { ok: false, status: 403, reason: 'the bridge accepts loopback callers only' };
  }
  const allowlist = owners instanceof Set ? owners : bridgeParseOwnerLogins(owners);
  const login = bridgePresentedLogin(headers);
  const ownerByLogin = Boolean(login) && allowlist.has(login);
  const ownerByToken = bridgeTokenMatches(headers, tokenSha256);
  if (!ownerByLogin && !ownerByToken) {
    return { ok: false, status: 403, reason: 'owner identity required' };
  }
  const originHeader = bridgeHeaderValue(headers, 'origin');
  if (originHeader !== undefined) {
    const allowed = isText(publicOrigin) ? publicOrigin.trim() : '';
    if (!allowed || originHeader.trim() !== allowed) {
      return { ok: false, status: 403, reason: 'origin not allowed' };
    }
  }
  const fetchSite = (bridgeHeaderValue(headers, 'sec-fetch-site') ?? '').trim().toLowerCase();
  if (fetchSite === 'cross-site') {
    return { ok: false, status: 403, reason: 'cross-site request blocked' };
  }
  return { ok: true };
}

/**
 * The device credential the request presented, if any.
 *
 * @param {Record<string, string|string[]|undefined>|undefined} headers
 * @returns {string}
 */
export function bridgePresentedDeviceCredential(headers) {
  const raw = bridgeHeaderValue(headers, DEVICE_AUTHORIZATION_HEADER);
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!/^Bearer\s+/i.test(trimmed)) return '';
  return trimmed.replace(/^Bearer\s+/i, '').trim();
}

/**
 * The device id the request named, from the `x-botfleet-device` header.
 *
 * The bridge mints the device id when a pairing is redeemed, and the phone
 * sends it back on every later request, so a revoked device can be refused
 * before its credential is even compared.
 *
 * @param {Record<string, string|string[]|undefined>|undefined} headers
 * @returns {string}
 */
export function bridgePresentedDeviceId(headers) {
  return (bridgeHeaderValue(headers, 'x-botfleet-device') ?? '').trim();
}

/**
 * Mint one device credential.  It is shown to the phone once and only its
 * digest is kept.
 *
 * @returns {string}
 */
export function bridgeMintDeviceCredential() {
  return `bf_brd_${crypto.randomBytes(32).toString('base64url')}`;
}

/**
 * Mint one pairing code: six digits, the shape the phone accepts.
 *
 * @returns {string}
 */
export function bridgeMintPairingCode() {
  const value = crypto.randomInt(0, 1_000_000);
  return String(value).padStart(6, '0');
}

/**
 * Mint one pairing token: the `omb_pair_` shape the phone's parser
 * accepts, and the only shape it accepts.
 *
 * @returns {string}
 */
export function bridgeMintPairingToken() {
  return `omb_pair_${crypto.randomBytes(32).toString('base64url').slice(0, 43)}`;
}

/**
 * The pairing-open body.
 *
 * The window carries whatever the operator attached to it, so the open
 * route takes the metadata as it is; the four fields the bridge itself
 * reads are named here, and the schema is strict, so an unknown key is a
 * refusal rather than a silent ride along.
 */
const PairingOpenSchema = z.strictObject({
  code: z.string().max(64).optional(),
  token: z.string().max(256).optional(),
  deviceId: z.string().max(64).optional(),
  deviceName: z.string().max(120).optional(),
  requestId: z.string().max(128).optional(),
  // The operator's own metadata for the window, under one named field:  an
  // unknown top-level key is refused rather than riding along, and the
  // window core bounds what the metadata may hold.
  metadata: z.record(z.string().max(64), z.unknown()).optional(),
});

/**
 * The pairing-redeem body.
 *
 * The credential is either the QR token or the typed code, the device id
 * names the device the phone asked for, and the request id is what makes
 * a lost response replayable instead of a lock-out.
 */
const PairingRedeemSchema = z.strictObject({
  code: z.string().max(64).optional(),
  token: z.string().max(256).optional(),
  credential: z.string().max(256).optional(),
  deviceId: z.string().max(64).optional(),
  deviceName: z.string().max(120).optional(),
  requestId: z.string().max(128).optional(),
});

/**
 * The bridge's device registry: digests only, and never a cleartext
 * credential.
 *
 * The registry is the whole of the bridge's device state.  A revoked device
 * keeps its row, marked revoked, so a replayed redeem cannot mint a fresh
 * credential for it.
 */
export class BridgeDeviceRegistry {
  /**
   * @param {{devices?: Array<Record<string, unknown>>}} [state]
   */
  constructor(state = {}) {
    this.devices = [];
    for (const entry of Array.isArray(state.devices) ? state.devices : []) {
      if (!entry || !isObject(entry)) continue;
      const id = String(entry.id ?? '');
      const tokenDigest = String(entry.tokenDigest ?? '');
      if (!id || !/^[0-9a-f]{64}$/.test(tokenDigest)) continue;
      const pairedAtMs = Number(entry.pairedAtMs);
      // A device that is not revoked carries no revocation stamp.  The
      // stamp is a number when there is one and null when there is not, so
      // the check is on the raw value: a null stamp read as a number would
      // be zero, and zero is a stamp.
      const rawRevoked = entry.revokedAtMs;
      const revokedAtMs = rawRevoked === null || rawRevoked === undefined ? null : Number(rawRevoked);
      this.devices.push({
        id,
        name: String(entry.name ?? ''),
        tokenDigest,
        pairedAtMs: Number.isFinite(pairedAtMs) ? pairedAtMs : 0,
        revokedAtMs: revokedAtMs !== null && Number.isFinite(revokedAtMs) ? revokedAtMs : null,
      });
    }
  }

  /** The rows the registry holds, for persistence. */
  toState() {
    return { devices: this.devices.map((entry) => ({ ...entry })) };
  }

  /** The devices that are paired and not revoked. */
  active() {
    return this.devices.filter((entry) => entry.revokedAtMs === null);
  }

  /** The ids of the active devices. */
  activeIds() {
    return this.active().map((entry) => entry.id);
  }

  /**
   * Decide a presented credential against the registry.
   *
   * @param {string} presentedToken
   * @param {string} [presentedDeviceId]
   * @returns {{ok: true, deviceId: string} | {ok: false, reason: string}}
   */
  decide(presentedToken, presentedDeviceId = '') {
    const named = String(presentedDeviceId ?? '').trim();
    if (named) {
      const row = this.devices.find((entry) => entry.id === named);
      if (!row) return { ok: false, reason: 'unknown device' };
      if (row.revokedAtMs !== null) return { ok: false, reason: 'device revoked' };
    }
    const decision = bridgeDeviceDecision({
      presentedToken,
      devices: this.active().map((entry) => ({ id: entry.id, tokenDigest: entry.tokenDigest })),
    });
    if (!decision.ok) return { ok: false, reason: decision.reason };
    if (named && decision.deviceId !== named) return { ok: false, reason: 'device credential does not match the named device' };
    return { ok: true, deviceId: decision.deviceId };
  }

  /**
   * Add a paired device, keeping its digest only.
   *
   * @param {{id: string, name?: string, token: string, pairedAtMs: number}} input
   * @returns {{ok: true, deviceId: string} | {ok: false, reason: string}}
   */
  addDevice({ id, name = '', token, pairedAtMs }) {
    const deviceId = String(id ?? '').trim();
    if (!deviceId) return { ok: false, reason: 'device id required' };
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) return { ok: false, reason: 'device id has an unusable shape' };
    if (this.devices.some((entry) => entry.id === deviceId)) return { ok: false, reason: 'device id already paired' };
    if (this.active().length >= BRIDGE_MAX_DEVICES) return { ok: false, reason: 'the device limit is reached' };
    this.devices.push({
      id: deviceId,
      name: String(name ?? '').slice(0, 120),
      tokenDigest: sha256Hex(String(token ?? '')),
      pairedAtMs: Number(pairedAtMs ?? 0),
      revokedAtMs: null,
    });
    return { ok: true, deviceId };
  }

  /**
   * Revoke a device.  A revoked device keeps its row so a replayed redeem
   * cannot mint a fresh credential for it.
   *
   * @param {string} id
   * @param {number} atMs
   * @returns {boolean}
   */
  revokeDevice(id, atMs) {
    const row = this.devices.find((entry) => entry.id === String(id ?? ''));
    if (!row) return false;
    if (row.revokedAtMs === null) row.revokedAtMs = Number(atMs ?? 0);
    return true;
  }

  /** The public rows: no digest and no credential. */
  publicDevices() {
    return this.active().map((entry) => ({
      id: entry.id,
      name: entry.name,
      pairedAtMs: entry.pairedAtMs,
    }));
  }
}

/**
 * The bridge's pairing window, held with the device registry so a redeem's
 * spend and the device it mints are written in one step.
 */
export class BridgeState {
  /**
   * @param {{registry?: BridgeDeviceRegistry, window?: Record<string, unknown>|null}} [state]
   */
  constructor(state = {}) {
    this.registry = state.registry instanceof BridgeDeviceRegistry
      ? state.registry
      : new BridgeDeviceRegistry(state);
    this.window = state.window && isObject(state.window) ? state.window : null;
  }

  /** The whole state, for persistence. */
  toState() {
    return { devices: this.registry.toState().devices, window: this.window ?? null };
  }
}

/**
 * The window fields the bridge itself reads.  Caller metadata never takes
 * one of these names:  a metadata entry called `spent` or `tokenDigest`
 * would rewrite the spend state, the attempt budget or a digest, which is
 * the caller changing a security field the window owns.
 */
const RESERVED_WINDOW_KEYS = new Set([
  'codeDigest',
  'tokenDigest',
  'expiresAtMs',
  'attemptsLeft',
  'spent',
  'replay',
]);

/** The most caller metadata entries one window carries. */
const BRIDGE_WINDOW_METADATA_MAX_KEYS = 8;

/** The most serialized characters caller metadata takes across all entries. */
const BRIDGE_WINDOW_METADATA_MAX_CHARS = 1024;

/**
 * The caller metadata a window carries, bounded and stripped of its own
 * field names.
 *
 * A reserved key is dropped, a value that cannot be read back is dropped,
 * and the copy stops at eight keys or 1024 serialized characters, so an
 * open call cannot hand the window an unbounded appendix.
 *
 * @param {Record<string, unknown>} metadata
 * @returns {Record<string, unknown>}
 */
export function boundedWindowMetadata(metadata) {
  const carried = {};
  let characters = 0;
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (Object.keys(carried).length >= BRIDGE_WINDOW_METADATA_MAX_KEYS) break;
    if (RESERVED_WINDOW_KEYS.has(key)) continue;
    let serialized;
    try {
      serialized = JSON.stringify(value);
    } catch {
      continue;
    }
    if (serialized === undefined) continue;
    if (characters + serialized.length > BRIDGE_WINDOW_METADATA_MAX_CHARS) break;
    characters += serialized.length;
    carried[key] = value;
  }
  return carried;
}

/**
 * Open a pairing window.
 *
 * The code and the token are handed back to the caller once, in the clear:
 * the phone needs them, and the state keeps only their digests.
 *
 * @param {{state: BridgeState, nowMs: number, ttlSeconds?: number, maxAttempts?: number, metadata?: Record<string, unknown>}} input
 * @returns {{ok: true, code: string, token: string, expiresAtMs: number, attemptsLeft: number} | {ok: false, reason: string}}
 */
export function bridgeOpenPairingWindow({ state, nowMs, ttlSeconds = BRIDGE_WINDOW_TTL_SECONDS, maxAttempts = BRIDGE_WINDOW_MAX_ATTEMPTS, metadata = {} }) {
  const code = bridgeMintPairingCode();
  const pairingToken = bridgeMintPairingToken();
  if (!OMB_PAIR_TOKEN.test(pairingToken)) return { ok: false, reason: 'the minted pairing token has an unusable shape' };
  let window;
  try {
    window = openBridgePairingWindow({ code, token: pairingToken, ttlSeconds, maxAttempts, nowMs });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'the pairing window could not be opened' };
  }
  // Caller metadata rides along on the window, so a redeem answer can carry
  // what the operator attached to the window it opened, but only under a
  // name the window does not own and within the bounds above.
  state.window = { ...window, ...boundedWindowMetadata(metadata) };
  return { ok: true, code, token: pairingToken, expiresAtMs: window.expiresAtMs, attemptsLeft: window.attemptsLeft };
}

/**
 * Redeem one pairing credential.
 *
 * The spend and the device it mints are returned together, so the caller
 * writes them in one atomic step: a spend that is written without its
 * device would lock the phone out after a lost response.
 *
 * @param {{state: BridgeState, presented: string, requestId?: string, replayDeviceId?: string, deviceName?: string, nowMs: number}} input
 * @returns {{ok: true, replayed: boolean, deviceId: string, credential: string, expiresAtMs: number} | {ok: false, reason: string}}
 */
export function bridgeRedeemPairing({ state, presented, requestId = '', replayDeviceId = '', deviceName = '', nowMs }) {
  const window = state.window;
  if (!window) return { ok: false, reason: 'no pairing window is open' };
  const result = redeemBridgePairingWindow({
    window,
    presented,
    requestId: replayableRequestId(requestId) ?? undefined,
    replayDeviceId: replayDeviceId || undefined,
    pairedDeviceIds: state.registry.activeIds(),
    nowMs,
  });
  if (!result.ok) {
    state.window = result.window;
    return { ok: false, reason: result.reason };
  }
  const deviceId = result.deviceId;
  if (!deviceId) return { ok: false, reason: 'the redeem named no device' };
  if (result.replayed) {
    // The credential was handed out the first time; a replay reports the
    // same device and never mints a second credential.
    state.window = result.window;
    return { ok: true, replayed: true, deviceId, credential: '', expiresAtMs: result.window.expiresAtMs };
  }
  const credential = bridgeMintDeviceCredential();
  const added = state.registry.addDevice({ id: deviceId, name: deviceName, token: credential, pairedAtMs: nowMs });
  if (!added.ok) {
    // The device could not be added, so the window was not spent:  a phone
    // that is refused here would otherwise be left with no device and no
    // retry, which is the lock-out the single-spend rule exists to avoid.
    state.window = window;
    return { ok: false, reason: added.reason };
  }
  state.window = result.window;
  return { ok: true, replayed: false, deviceId, credential, expiresAtMs: result.window.expiresAtMs };
}

/**
 * The bridge's own route table: the local routes it answers and the proxied
 * routes it forwards, taken from the core so the two cannot drift.
 *
 * @returns {{local: string[], proxied: string[]}}
 */
export function bridgeRouteSummary() {
  const local = [];
  const proxied = [];
  for (const route of BRIDGE_ALLOWED_ROUTES) {
    const label = `${route.method} ${route.path}`;
    if (route.local) local.push(label);
    else proxied.push(label);
  }
  return { local, proxied };
}

/**
 * Write a JSON response.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function respondJson(res, status, payload) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * The headers a proxied request carries upstream.
 *
 * This is the same allowlist the Node companion sidecar uses
 * (`companion/src/proxy.ts`), because the bridge is in the same position:
 * it authenticates the phone itself, and the harness sees a plain loopback
 * caller.  An allowlist rather than a blocklist is the point: the phone's
 * own device credential is the bridge's business and means nothing to the
 * harness, so it does not travel, and neither does any other identity,
 * edge, forwarding or hop-by-hop header.
 *
 * @param {Record<string, string|string[]|undefined>|undefined} headers
 * @param {number|string} upstreamPort
 * @returns {Record<string, string|string[]>}
 */
export function bridgeUpstreamHeaders(headers, upstreamPort) {
  const out = {
    accept: String(bridgeHeaderValue(headers, 'accept') ?? '*/*'),
    // The stamp the harness reads as "a phone reached this through a
    // companion".  The phone cannot add it itself: the bridge sets it on
    // the way in.
    'x-botfleet-companion': '1',
  };
  const contentType = bridgeHeaderValue(headers, 'content-type');
  if (contentType) out['content-type'] = contentType;
  // Last-Event-ID is how a reconnecting phone asks for the gap.  Dropping
  // it would turn every resume into a full re-hydration, silently.
  const lastEventId = bridgeHeaderValue(headers, 'last-event-id');
  if (lastEventId) out['last-event-id'] = lastEventId;
  out.host = `127.0.0.1:${upstreamPort}`;
  return out;
}

/**
 * The headers a proxied response carries back to the phone.
 *
 * The body is passed through byte for byte, so the upstream framing
 * headers are dropped and Node frames the response itself.
 *
 * @param {Record<string, string|string[]|undefined>|undefined} headers
 * @returns {Record<string, string|string[]>}
 */
export function bridgeDownstreamHeaders(headers) {
  const out = {};
  for (const [rawName, rawValue] of Object.entries(headers || {})) {
    const name = rawName.toLowerCase();
    if (rawValue === undefined || rawValue === null) continue;
    if (name === 'transfer-encoding') continue;
    if (name === 'connection' || name === 'keep-alive' || name === 'proxy-connection') continue;
    if (name === 'trailer') continue;
    out[name] = rawValue;
  }
  return out;
}

/**
 * Parse the path out of a request URL.
 *
 * @param {string|undefined} url
 * @returns {string}
 */
function pathOf(url) {
  const raw = String(url ?? '');
  const query = raw.indexOf('?');
  const path = query === -1 ? raw : raw.slice(0, query);
  return path || '/';
}

/**
 * Read a small JSON request body.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<{ok: true, value: Record<string, unknown>} | {ok: false, reason: string}>}
 */
async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      total += chunk.length;
      if (total > limit) return { ok: false, reason: 'the request body is too large' };
      chunks.push(chunk);
    }
  } catch {
    // The client hung up mid-body.  That is a normal end to a request, and
    // it is answered as one rather than as a failure of the listener.
    return { ok: false, reason: 'the request body was not received' };
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || !isObject(parsed) || Array.isArray(parsed)) {
      return { ok: false, reason: 'the request body is not a JSON object' };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, reason: 'the request body is not valid JSON' };
  }
}

/**
 * Create the bridge listener.
 *
 * @param {{state: BridgeState, owners?: Set<string>|string, publicOrigin?: string, tokenSha256?: string|null, upstreamHost?: string, upstreamPort?: number|string, log?: (message: string) => void, now?: () => number, persist?: (state: BridgeState) => boolean}} options
 *   The persist callback answers whether the state reached durable storage.
 *   `false` (or a throw) fails every trust-extending route closed for that
 *   change:  a pairing or a revocation that only lives in memory is one a
 *   restart forgets, so the caller hears a 503 instead of an unearned 200.
 * @returns {import('node:http').Server}
 */
export function createCompanionBridge({
  state,
  owners,
  publicOrigin,
  tokenSha256,
  upstreamHost = BRIDGE_UPSTREAM_HOST,
  upstreamPort = BRIDGE_UPSTREAM_PORT,
  log,
  now = () => Date.now(),
  persist = () => true,
} = {}) {
  if (!state || !isObject(state)) throw new Error('createCompanionBridge needs the bridge state');
  const logger = isCallable(log) ? log : () => {};
  const port = Number(upstreamPort) || BRIDGE_UPSTREAM_PORT;
  const host = String(upstreamHost || BRIDGE_UPSTREAM_HOST);
  const upstreamAgent = new http.Agent({ keepAlive: false });

  // The persist callback is normalized once:  a throw and a `false` answer
  // are the same fact, and neither may reach a caller as a success.  Every
  // route that extends trust checks its own save, so a failing durable
  // store fails those routes closed while proxying continues.
  const persistState = (current) => {
    try {
      return persist(current) !== false;
    } catch {
      return false;
    }
  };

  const server = http.createServer((req, res) => {
    // Every request runs on its own, so a failure in one may not take the
    // listener with it:  the backstop logs the reason and answers 500 if
    // nothing was written yet.
    void handleRequest({ req, res, state, owners, publicOrigin, tokenSha256, host, port, upstreamAgent, logger, now, persist: persistState }).catch((error) => {
      logger(`[companion-bridge] request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) respondJson(res, 500, { error: 'the request could not be handled' });
      else res.destroy();
    });
  });

  // A long server-sent event stream must never be cut short by a timeout.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.timeout = 0;
  server.keepAliveTimeout = 65_000;

  return server;
}

/**
 * Decide one request and answer it.
 *
 * @param {object} input
 * @returns {Promise<void>}
 */
async function handleRequest({
  req, res, state, owners, publicOrigin, tokenSha256,
  host, port, upstreamAgent, logger, now, persist,
}) {
  const method = String(req.method ?? 'GET').toUpperCase();
  const url = String(req.url ?? '/');

  if (pathOf(url) === BRIDGE_HEALTH_PATH && method === 'GET') {
    respondJson(res, 200, { ok: true, bridge: 'botfleet-companion-bridge' });
    return;
  }

  const owner = bridgeOwnerDecision({
    remoteAddress: req.socket?.remoteAddress,
    headers: req.headers,
    owners,
    publicOrigin,
    tokenSha256,
  });
  if (!owner.ok) {
    logger(`[companion-bridge] refused ${method} ${pathOf(url)}: ${owner.reason}`);
    respondJson(res, owner.status, { error: owner.reason });
    return;
  }

  const decision = bridgeRouteDecision(method, url);
  if (!decision.ok) {
    respondJson(res, decision.status, { error: decision.reason });
    return;
  }

  if (decision.local) {
    await handleLocalRoute({ req, res, method, url, decision, state, logger, now, persist });
    return;
  }

  // A proxied route is the harness's route, so the device credential that
  // reaches it is the harness's own.  The bridge still holds its own
  // registry, and a device the bridge revoked may not reach the harness
  // through the bridge at all:  the bridge checks its registry before it
  // forwards, so a revocation takes effect here and not only on the Mac.
  const device = state.registry.decide(
    bridgePresentedDeviceCredential(req.headers),
    bridgePresentedDeviceId(req.headers),
  );
  if (!device.ok) {
    logger(`[companion-bridge] refused ${method} ${pathOf(url)}: ${device.reason}`);
    respondJson(res, 403, { error: device.reason });
    return;
  }

  await proxyRequest({ req, res, method, url, decision, host, port, upstreamAgent, logger });
}

/**
 * Answer one of the bridge's own routes.
 *
 * Every route that extends trust checks its own save and fails closed:  a
 * window opened, a device paired or a revocation applied while the durable
 * store refuses writes answers 503 rather than a success the disk did not
 * earn, because a restart would drop what memory holds.  Proxying is not a
 * trust extension, so it continues on the registry the bridge holds.
 *
 * @param {object} input
 * @returns {Promise<void>}
 */
async function handleLocalRoute({ req, res, method, url, state, logger, now, persist }) {
  const path = pathOf(url);

  if (method === 'GET' && path === '/api/companion/endpoints') {
    respondJson(res, 200, { serverName: '', endpoints: [] });
    return;
  }

  const unsaved = () => {
    respondJson(res, 503, { error: 'the durable state could not be saved, so the change is not confirmed' });
  };

  if (method === 'POST' && path === '/api/companion/pairing/open') {
    const body = await readJsonBody(req);
    if (!body.ok) {
      respondJson(res, 400, { error: body.reason });
      return;
    }
    const parsed = PairingOpenSchema.safeParse(body.value);
    if (!parsed.success) {
      respondJson(res, 400, { error: 'the pairing request does not match the contract' });
      return;
    }
    // The window carries the operator's metadata, and the window core
    // bounds it:  it keeps at most eight small keys, drops a field whose
    // name or value looks like a credential, and drops a value it cannot
    // read back.
    const metadata = parsed.data.metadata ?? {};
    const opened = bridgeOpenPairingWindow({ state, nowMs: now(), metadata });
    if (!opened.ok) {
      respondJson(res, 500, { error: opened.reason });
      return;
    }
    if (!persist(state)) {
      logger('[companion-bridge] the durable state refused a save; the window is not confirmed');
      unsaved();
      return;
    }
    respondJson(res, 200, {
      code: opened.code,
      token: opened.token,
      expiresAtMs: opened.expiresAtMs,
      attemptsLeft: opened.attemptsLeft,
    });
    return;
  }

  if (method === 'POST' && path === '/api/companion/pairing/redeem') {
    const body = await readJsonBody(req);
    if (!body.ok) {
      respondJson(res, 400, { error: body.reason });
      return;
    }
    const parsed = PairingRedeemSchema.safeParse(body.value);
    if (!parsed.success) {
      respondJson(res, 400, { error: 'the pairing redeem does not match the contract' });
      return;
    }
    // The three fields are one credential in three shapes, so the first one
    // the caller actually sent is the credential:  an empty token field must
    // not shadow a code the same body carries.
    const presented = [parsed.data.token, parsed.data.code, parsed.data.credential]
      .map((value) => String(value ?? ''))
      .find((value) => value !== '') ?? '';
    if (!presented) {
      respondJson(res, 400, { error: 'a pairing code or token is required' });
      return;
    }
    const redeemed = bridgeRedeemPairing({
      state,
      presented,
      requestId: String(parsed.data.requestId ?? ''),
      replayDeviceId: String(parsed.data.deviceId ?? ''),
      deviceName: String(parsed.data.deviceName ?? ''),
      nowMs: now(),
    });
    if (!redeemed.ok) {
      logger(`[companion-bridge] refused a pairing redeem: ${redeemed.reason}`);
      // The refusal and its burned attempt are real in memory either way;
      // a save that fails here costs the operator one attempt count after a
      // restart, not the refusal itself.
      persist(state);
      respondJson(res, 403, { error: redeemed.reason });
      return;
    }
    if (!persist(state)) {
      // A pairing the durable state cannot hold is not confirmed to the
      // phone:  the minted credential never leaves the bridge, and a retry
      // after a save succeeds would answer as a replay with no credential,
      // so the operator opens a fresh window and pairs again.
      logger('[companion-bridge] the durable state refused a save; the redeem is not confirmed');
      unsaved();
      return;
    }
    respondJson(res, 200, {
      deviceId: redeemed.deviceId,
      credential: redeemed.credential,
      replayed: redeemed.replayed,
      expiresAtMs: redeemed.expiresAtMs,
    });
    return;
  }

  if (method === 'GET' && path === '/api/companion/devices') {
    respondJson(res, 200, { devices: state.registry.publicDevices() });
    return;
  }

  if (method === 'DELETE' && path.startsWith('/api/companion/devices/')) {
    const deviceId = decodeURIComponent(path.slice('/api/companion/devices/'.length));
    const revoked = state.registry.revokeDevice(deviceId, now());
    if (revoked && !persist(state)) {
      // A revocation the durable state cannot hold would be a revocation a
      // restart forgets, which is a revocation that does not exist.  The
      // in-memory revocation stays and keeps guarding, but the answer is an
      // honest 503 rather than a 200 the disk did not earn.
      logger('[companion-bridge] the durable state refused a save; the revocation is memory-only');
      unsaved();
      return;
    }
    respondJson(res, revoked ? 200 : 404, revoked ? { revoked: true, deviceId } : { error: 'unknown device' });
    return;
  }

  respondJson(res, 404, { error: 'no bridge route' });
}

/**
 * Forward one request to the harness, byte for byte.
 *
 * The URL keeps its raw query string, so a cursor parameter or a `$`-literal
 * path reaches the harness exactly as the phone wrote it, and the response
 * body is streamed, so an SSE frame arrives when the harness wrote it.
 *
 * @param {object} input
 * @returns {Promise<void>}
 */
function proxyRequest({ req, res, method, url, decision, host, port, upstreamAgent, logger }) {
  const target = new URL(decision.upstream, `http://${host}:${port}`);
  let upstreamResponse = null;
  const upstream = http.request({
    hostname: host,
    port,
    path: `${target.pathname}${target.search}`,
    method,
    headers: bridgeUpstreamHeaders(req.headers, port),
    agent: upstreamAgent,
  }, (response) => {
    upstreamResponse = response;
    res.writeHead(response.statusCode ?? 502, bridgeDownstreamHeaders(response.headers));
    response.pipe(res);
    response.on('error', () => res.destroy());
  });
  upstream.on('error', (error) => {
    logger(`[companion-bridge] upstream failed for ${method} ${pathOf(url)}: ${error.message}`);
    if (!res.headersSent) respondJson(res, 502, { error: 'the harness did not answer' });
    else res.destroy();
  });
  req.pipe(upstream);
  req.on('error', () => upstream.destroy());
  upstream.on('close', () => req.destroy());
  // A client that hangs up ends the whole hop, including a long-lived
  // event stream:  otherwise the upstream connection outlives the request
  // that opened it.
  res.on('close', () => {
    // Only a response that did not finish tears the upstream down:  a
    // finished one has already had its upstream end with it.
    if (!res.writableFinished) {
      upstream.destroy();
      upstreamResponse?.destroy();
    }
  });
}

/**
 * Read the command line.
 *
 * The bridge takes exactly one flag: the file that holds the read-only
 * Infisical service token, the same bootstrap the owner gate uses.
 *
 * @param {string[]} argv
 * @returns {{ok: true, bootstrapTokenFile: string} | {ok: false, error: string}}
 */
export function parseBridgeArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let bootstrapTokenFile = '';
  let statePath = '';
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === '--bootstrap-token-file') {
      const value = args[index + 1];
      if (!value || String(value).startsWith('--')) {
        return { ok: false, error: '--bootstrap-token-file needs a path' };
      }
      bootstrapTokenFile = String(value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--bootstrap-token-file=')) {
      bootstrapTokenFile = arg.slice('--bootstrap-token-file='.length);
      continue;
    }
    if (arg === '--state-file') {
      const value = args[index + 1];
      if (!value || String(value).startsWith('--')) {
        return { ok: false, error: '--state-file needs a path' };
      }
      statePath = String(value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--state-file=')) {
      statePath = arg.slice('--state-file='.length);
      continue;
    }
    return { ok: false, error: `unknown argument: ${arg}` };
  }
  if (!bootstrapTokenFile) {
    return {
      ok: false,
      error:
        '--bootstrap-token-file <path> is required: the bridge reads its ' +
        'configuration from Infisical, and the only local item is a read-only ' +
        'Infisical service token file',
    };
  }
  if (!statePath) {
    return {
      ok: false,
      error:
        '--state-file <path> is required: the bridge keeps its device ' +
        'registry and its pairing window there, so a restart does not forget ' +
        'a pairing or a revocation',
    };
  }
  return { ok: true, bootstrapTokenFile, statePath };
}

/**
 * The configuration the bridge reads from Infisical.
 *
 * @param {Record<string, string>|undefined} secrets
 * @returns {{owners: Set<string>, publicOrigin: string, tokenSha256: string|null}}
 */
export function bridgeConfigFromSecrets(secrets) {
  const ownerLogins = isText(secrets?.BOTFLEET_OWNER_LOGINS) ? secrets.BOTFLEET_OWNER_LOGINS : '';
  const publicOrigin = isText(secrets?.BOTFLEET_PUBLIC_ORIGIN) ? secrets.BOTFLEET_PUBLIC_ORIGIN.trim() : '';
  const gateToken = isText(secrets?.BOTFLEET_SERVER_GATE_TOKEN) ? secrets.BOTFLEET_SERVER_GATE_TOKEN : '';
  const tokenSha256 = gateToken
    ? crypto.createHash('sha256').update(gateToken, 'utf8').digest('hex')
    : null;
  return {
    owners: bridgeParseOwnerLogins(ownerLogins),
    publicOrigin,
    tokenSha256,
  };
}

/**
 * Write a fatal line and stop.  The message never carries a value.
 *
 * @param {string} message
 */
function fail(message) {
  process.stderr.write(`${new Date().toISOString()} ${message}\n`);
  process.exit(1);
}

const entry = process.argv[1];
if (entry) {
  let isDirectRun = false;
  try {
    isDirectRun = import.meta.url === pathToFileURL(entry).href;
  } catch {
    isDirectRun = false;
  }
  if (isDirectRun) {
    main().catch((error) => {
      fail(`companion bridge: ${error?.message ?? 'unknown error'}`);
    });
  }
}

/**
 * Read the configuration from Infisical, refuse an unsafe configuration, and
 * listen.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const args = parseBridgeArgs(process.argv.slice(2));
  if (!args.ok) {
    fail(`companion bridge: ${args.error}`);
    return;
  }
  const statePath = args.statePath;

  let serviceToken;
  try {
    serviceToken = readBootstrapTokenFile(args.bootstrapTokenFile);
  } catch (error) {
    fail(`companion bridge: cannot read the Infisical read token: ${error?.message ?? 'unknown error'}`);
    return;
  }

  let secrets;
  try {
    secrets = await readInfisicalSecrets({
      serviceToken,
      names: ['BOTFLEET_OWNER_LOGINS', 'BOTFLEET_PUBLIC_ORIGIN', 'BOTFLEET_SERVER_GATE_TOKEN'],
    });
  } catch (error) {
    fail(`companion bridge: cannot read its config from Infisical: ${error?.message ?? 'unreachable'}`);
    return;
  }

  const { owners, publicOrigin, tokenSha256 } = bridgeConfigFromSecrets(secrets);
  if (owners.size === 0 && !tokenSha256) {
    fail(
      'companion bridge: refusing to start: no owner credential in Infisical ' +
        '(BotFleet, prod, /botfleet-server): set BOTFLEET_OWNER_LOGINS or ' +
        'BOTFLEET_SERVER_GATE_TOKEN there.',
    );
    return;
  }

  // The APNs sender locus. It reads through the scoped read-only path and
  // nothing else, and it is off unless the vault holds key material. No
  // value is printed, and the key is not created here: a grant and a key
  // are the owner's.
  const apns = await bridgeApnsMaterial({ serviceToken });
  process.stdout.write(
    `${new Date().toISOString()} [companion-bridge] apns sender: ` +
      `${apns.available ? 'key material present' : `off (${apns.reason})`}\n`,
  );

  // The durable state:  a paired phone that forgets its pairing after a
  // restart is a phone the owner has to pair again, and a revocation a
  // restart forgets is a revocation that does not exist.
  let state;
  try {
    const loaded = loadBridgeState(statePath);
    state = new BridgeState(loaded.state ?? {});
  } catch (error) {
    fail(`companion bridge: the durable state could not be read: ${error?.message ?? 'unknown error'}`);
    return;
  }
  const server = createCompanionBridge({
    state,
    owners,
    publicOrigin,
    tokenSha256,
    persist: (current) => {
      try {
        saveBridgeState(statePath, current.toState());
        return true;
      } catch (error) {
        process.stderr.write(
          `${new Date().toISOString()} [companion-bridge] the durable state could not be written: ${error?.message ?? 'unknown error'}\n`,
        );
        return false;
      }
    },
  });

  server.on('error', (error) => {
    process.stderr.write(`${new Date().toISOString()} [companion-bridge] server error: ${error.message}\n`);
    process.exit(1);
  });

  server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
    const address = server.address();
    const boundPort = address && isObject(address) ? address.port : BRIDGE_PORT;
    process.stdout.write(
      `${new Date().toISOString()} [companion-bridge] listening on ${BRIDGE_HOST}:${boundPort} ` +
        `-> harness ${BRIDGE_UPSTREAM_HOST}:${BRIDGE_UPSTREAM_PORT} ` +
        `(owners: ${owners.size}, token: ${tokenSha256 ? 'yes' : 'no'})\n`,
    );
  });
}
