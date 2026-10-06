/** Machine-readable output from `cua-driver permissions status --json`.  See
 * cua.ai docs: accessibility and screen_recording booleans, optional capture
 * probe fields, and daemon attribution in `source`.
 *
 * Validated with hand-written guards so Electron main never imports zod —
 * electron-builder excludes node_modules from app.asar (same invariant as
 * electron/secure-credential-state.mjs). */

const isPlainRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
  const keys = Reflect.ownKeys(value).filter((key) => typeof key === "string");
  if (keys.length !== 1 || keys[0] !== "attribution") return null;
  if (typeof value.attribution !== "string") return null;
  return { attribution: value.attribution };
}

function parseDirectCaptureVerification(value) {
  if (!isPlainRecord(value)) return null;
  const keys = Reflect.ownKeys(value).filter((key) => typeof key === "string");
  if (keys.length !== 3) return null;
  for (const key of ["source", "verified_at", "bundle_id"]) {
    if (!keys.includes(key) || typeof value[key] !== "string") return null;
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

  const keys = Reflect.ownKeys(parsed).filter((key) => typeof key === "string");
  for (const key of keys) {
    if (!OWNED_KEYS.has(key)) return { ok: false };
  }

  if (typeof parsed.accessibility !== "boolean") return { ok: false };
  if (typeof parsed.screen_recording !== "boolean") return { ok: false };

  /** @type {Record<string, unknown>} */
  const data = {
    accessibility: parsed.accessibility,
    screen_recording: parsed.screen_recording,
  };

  if ("screen_recording_capturable" in parsed) {
    const capturable = parsed.screen_recording_capturable;
    if (!(typeof capturable === "boolean" || capturable === null)) return { ok: false };
    data.screen_recording_capturable = capturable;
  }

  if ("direct_capture_status" in parsed) {
    if (typeof parsed.direct_capture_status !== "string") return { ok: false };
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
