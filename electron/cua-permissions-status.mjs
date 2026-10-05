import { z } from "zod";

/** Machine-readable output from `cua-driver permissions status --json`.  See
 * cua.ai docs: accessibility and screen_recording booleans, optional capture
 * probe fields, and daemon attribution in `source`. */
export const CuaPermissionsStatusSchema = z
  .object({
    accessibility: z.boolean(),
    screen_recording: z.boolean(),
    screen_recording_capturable: z.boolean().nullable().optional(),
    direct_capture_status: z.string().optional(),
    source: z
      .object({
        attribution: z.string(),
      })
      .optional(),
    direct_capture_verification: z
      .object({
        source: z.string(),
        verified_at: z.string(),
        bundle_id: z.string(),
      })
      .optional(),
  })
  .strict();

export function parseCuaPermissionsStdout(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return { ok: false };
  try {
    const parsed = CuaPermissionsStatusSchema.safeParse(JSON.parse(text));
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
  } catch {
    return { ok: false };
  }
}
