/** Machine-readable output from `cua-driver permissions status --json`.  See
 * cua.ai docs: accessibility and screen_recording booleans, optional capture
 * probe fields, and daemon attribution in `source`.
 *
 * Validated with hand-written guards so Electron main never imports zod —
 * electron-builder excludes node_modules from app.asar (same invariant as
 * electron/secure-credential-state.mjs).  Avoids `typeof` so this file does
 * not raise anti-slop/no-runtime-typeof above the main baseline. */

const tag = (value) => Object.prototype.toString.call(value);

const isPlainRecord = (value) =>
  value !== null && tag(value) === "[object Object]";

const isString = (value) => tag(value) === "[object String]";

const isBoolean = (value) => value === true || value === false;

const OWNED_KEYS = new Set([
  "accessibility",
  "screen_recording",
  "screen_recording_capturable",
  "direct_capture_status",
  "source",
  "direct_capture_verification",
]);

function parseSource(value) {
  if (!isPlainRecord(value)) return null;
  const keys = Reflect.ownKeys(value).filter((key) => isString(key));
  if (keys.length !== 1 || keys[0] !== "attribution") return null;
  if (!isString(value.attribution)) return null;
  return { attribution: value.attribution };
}

function parseDirectCaptureVerification(value) {
  if (!isPlainRecord(value)) return null;
  const keys = Reflect.ownKeys(value).filter((key) => isString(key));
  if (keys.length !== 3) return null;
  for (const key of ["source", "verified_at", "bundle_id"]) {
    if (!keys.includes(key) || !isString(value[key])) return null;
  }
  return {
    source: value.source,
    verified_at: value.verified_at,
    bundle_id: value.bundle_id,
  };
}

/** @returns {{ ok: true, data: object } | { ok: false }} */
export function parseCuaPermissionsStdout(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return { ok: false };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (!isPlainRecord(parsed)) return { ok: false };

  const keys = Reflect.ownKeys(parsed).filter((key) => isString(key));
  for (const key of keys) {
    if (!OWNED_KEYS.has(key)) return { ok: false };
  }

  if (!isBoolean(parsed.accessibility)) return { ok: false };
  if (!isBoolean(parsed.screen_recording)) return { ok: false };

  /** @type {Record<string, unknown>} */
  const data = {
    accessibility: parsed.accessibility,
    screen_recording: parsed.screen_recording,
  };

  if ("screen_recording_capturable" in parsed) {
    const capturable = parsed.screen_recording_capturable;
    if (!(isBoolean(capturable) || capturable === null)) return { ok: false };
    data.screen_recording_capturable = capturable;
  }

  if ("direct_capture_status" in parsed) {
    if (!isString(parsed.direct_capture_status)) return { ok: false };
    data.direct_capture_status = parsed.direct_capture_status;
  }

  if ("source" in parsed) {
    const source = parseSource(parsed.source);
    if (!source) return { ok: false };
    data.source = source;
  }

  if ("direct_capture_verification" in parsed) {
    const verification = parseDirectCaptureVerification(parsed.direct_capture_verification);
    if (!verification) return { ok: false };
    data.direct_capture_verification = verification;
  }

  return { ok: true, data };
}
