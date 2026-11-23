// The Linux bridge's APNs sender locus (BF-2691).
//
// The bridge reads its APNs key material through a scoped read-only
// Infisical path and through nothing else.  The companion's own
// `companion/src/apns.ts` reads `APNS_P8` or `APNS_P8_PATH` from the
// environment first and falls back to a Python reader, so it is not used
// here: a Linux sender that took its key from the environment would be
// reading a machine-level secret instead of a scoped grant.  The companion's
// own scoped binding module (`companion/src/apns-scoped-binding.ts`) is not
// imported either, because the Linux deployment deliberately retains zero
// `companion/` files; the same two vault names are read here through the
// scoped reader the owner gate already uses, which reaches the same
// BotFleet prod `/botfleet-server` path with the same read-only service
// token.
//
// What this module does: it names the secrets the sender needs, reads them
// through that scoped path, and hands the caller the material.  What it does
// NOT do: it does not send anything, it does not create a key, it does not
// grant a token, and it does not cache the material.  With no key in the
// vault the locus is off, and the reason it is off names the missing
// material rather than pretending a key exists.

import { readInfisicalSecrets } from '../../electron/infisical-read.mjs';

/** The fleet's shared APNs key (Simple With Us team CC8UTF7ATG). */
export const BRIDGE_APNS_TEAM_ID = 'CC8UTF7ATG';

/** The shared key id, used when no other key is pinned. */
export const BRIDGE_APNS_SHARED_KEY_ID = 'HSJ98QN95V';

/** The vault name of the shared key material. */
export const BRIDGE_APNS_SHARED_P8_NAME = 'APNS_KEY_P8';

/** The vault name of the shared key id. */
export const BRIDGE_APNS_SHARED_KEY_ID_NAME = 'APNS_KEY_ID';

/**
 * The secret names the Linux sender asks for.
 *
 * With a pinned key id the vault name is `AUTHKEY_<KEY_ID>`, one per Apple
 * key; without one it is the shared `APNS_KEY_P8` plus the `APNS_KEY_ID`
 * that names it.
 *
 * @param {string} [pin]
 * @returns {string[]}
 */
export function bridgeApnsSecretNames(pin = '') {
  const keyId = String(pin ?? '').trim();
  if (!keyId) return [BRIDGE_APNS_SHARED_P8_NAME, BRIDGE_APNS_SHARED_KEY_ID_NAME];
  return [`AUTHKEY_${keyId}`];
}

/**
 * Read the APNs material for the Linux sender through the scoped path.
 *
 * The read is one request for the whole path, and only the requested names
 * come back.  A name the vault does not hold is simply absent, so a read
 * that finds no material returns "off" with the reason naming what is
 * missing: half a key is not a key.
 *
 * @param {{serviceToken: string, pin?: string, fetchImpl?: typeof fetch, timeoutMs?: number}} options
 * @returns {Promise<{available: boolean, keyId: string, p8: string|null, reason: string}>}
 */
export async function bridgeApnsMaterial({
  serviceToken,
  pin = '',
  fetchImpl,
  timeoutMs = 20_000,
} = {}) {
  if (!serviceToken) {
    return { available: false, keyId: '', p8: null, reason: 'no scoped Infisical token is configured' };
  }
  const names = bridgeApnsSecretNames(pin);
  let secrets;
  try {
    const read = { serviceToken, names, timeoutMs };
    if (fetchImpl) read.fetchImpl = fetchImpl;
    secrets = await readInfisicalSecrets(read);
  } catch {
    return { available: false, keyId: '', p8: null, reason: 'the scoped APNs path could not be read' };
  }
  const shared = secrets?.[BRIDGE_APNS_SHARED_P8_NAME];
  const p8 = Object.prototype.toString.call(shared) === '[object String]' ? shared : '';
  const pinned = names.length === 1 ? names[0] : '';
  const p8Value = p8 || (pinned ? String(secrets?.[pinned] ?? '') : '');
  const keyId = String(secrets?.[BRIDGE_APNS_SHARED_KEY_ID_NAME] ?? '').trim()
    || (pinned ? pin.trim() : BRIDGE_APNS_SHARED_KEY_ID);
  if (!p8Value) {
    return {
      available: false,
      keyId,
      p8: null,
      reason: 'the vault holds no APNs key material for this sender',
    };
  }
  if (!p8Value.includes('BEGIN PRIVATE KEY')) {
    return {
      available: false,
      keyId,
      p8: null,
      reason: 'the APNs key material is not a private key',
    };
  }
  return { available: true, keyId, p8: p8Value, reason: '' };
}

/**
 * The names the sender asks for, for a log line or a diagnostic.  The
 * values are never printed.
 *
 * @param {string} [pin]
 * @returns {string}
 */
export function bridgeApnsNamesSummary(pin = '') {
  return bridgeApnsSecretNames(pin).join(', ');
}
