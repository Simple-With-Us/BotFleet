/** Machine-readable output from `cua-driver permissions status --json`.  See
 * cua.ai docs: accessibility and screen_recording booleans, optional capture
 * probe fields, and daemon attribution in `source`.
 *
 * Validated at the native-process trust boundary with strict Zod schemas.
 * Zod is vendored under electron/vendor/ so the packaged app.asar never needs
 * node_modules (electron-builder excludes them). */

import { z } from "./vendor/zod.mjs";

const SourceSchema = z
  .object({
    attribution: z.string(),
  })
  .strict();

const DirectCaptureVerificationSchema = z
  .object({
    source: z.string(),
    verified_at: z.string(),
    bundle_id: z.string(),
  })
  .strict();

const CuaPermissionsStatusSchema = z
  .object({
    accessibility: z.boolean(),
    screen_recording: z.boolean(),
    screen_recording_capturable: z.boolean().nullable().optional(),
    direct_capture_status: z.string().optional(),
    source: SourceSchema.optional(),
    direct_capture_verification: DirectCaptureVerificationSchema.optional(),
  })
  .strict();

/** @returns {{ ok: true, data: object } | { ok: false }} */
export function parseCuaPermissionsStdout(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return { ok: false };

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false };
  }

  const parsed = CuaPermissionsStatusSchema.safeParse(json);
  if (!parsed.success) return { ok: false };
  return { ok: true, data: parsed.data };
}
