import { z } from "zod";

/**
 * Trust boundaries for the two responses the Personal Voice path reads.
 *
 * The harness speaks NDJSON over HTTP and the Electron main process speaks the
 * same shape over IPC; neither is type-checked at runtime, so a field the
 * renderer then destructures can be missing, null, or the wrong type. Parsing
 * at the boundary turns a silent `undefined` — which used to read as "no
 * clips, speak the caption" — into a reported error.
 */

/** `POST /api/threads/:id/messages/:id/audio` as `Speaker.speak` consumes it. */
export const TtsAudioBodySchema = z.object({
  audio: z.array(z.object({ path: z.string(), mime: z.string() }).strict()),
  voiceText: z.string().optional(),
  utterances: z.array(z.string()).optional(),
  onDevice: z.boolean().optional(),
  personalVoice: z.boolean().optional(),
});

export type TtsAudioBody = z.infer<typeof TtsAudioBodySchema>;

/** One entry from `window.ogb.personalVoice.list()`. */
export const PersonalVoiceInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  locale: z.string().optional(),
}).strict();

export const PersonalVoiceListSchema = z.array(PersonalVoiceInfoSchema);

export type PersonalVoiceInfo = z.infer<typeof PersonalVoiceInfoSchema>;

/** `GET /api/tts/voices` — the renderer's per-bot voice picker. */
export const TtsVoicesResponseSchema = z.object({
  voices: z.array(z.object({
    id: z.string(),
    label: z.string(),
    description: z.string().optional(),
  }).strict()).optional(),
  error: z.string().optional(),
});

export type TtsVoicesResponse = z.infer<typeof TtsVoicesResponseSchema>;

/** `POST /api/tts/custom-voice` — the Add Voice ID response.
 *
 * The renderer builds a destructive DELETE URL from this body, so the
 * id that the picker commits and the id the URL encodes have to come
 * from a parsed, schema-checked value, not a cast field.  The server
 * success body is { ok: true, voice: { id, label, description: "Custom" } }
 * and the error body is { error: string }.  Existing fixtures and the
 * Playwright route mock often omit `description`, so a successful voice
 * without `description` is accepted.  A success body whose id is
 * missing, empty, or not a string, or that carries an unexpected extra
 * field, is rejected. */
export const CustomVoiceVoiceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
}).strict();

export const CustomVoiceSuccessResponseSchema = z.object({
  ok: z.literal(true),
  voice: CustomVoiceVoiceSchema,
}).strict();

export const CustomVoiceErrorResponseSchema = z.object({
  error: z.string().min(1),
}).strict();

export const CustomVoiceResponseSchema = z.union([
  CustomVoiceErrorResponseSchema,
  CustomVoiceSuccessResponseSchema,
]);

export type CustomVoiceResponse = z.infer<typeof CustomVoiceResponseSchema>;
export type CustomVoiceVoice = z.infer<typeof CustomVoiceVoiceSchema>;

/**
 * The IPC voice list is best-effort: a Mac that cannot build the speech
 * helper resolves `[]` rather than rejecting, and an older helper that returns
 * a different shape must not take the voice picker down with it. A malformed
 * list is therefore empty, not fatal — the caller's own `.catch(() => [])`
 * path already treats "no personal voices" as the normal case.
 */
export function parsePersonalVoiceList(value: unknown): PersonalVoiceInfo[] {
  const parsed = PersonalVoiceListSchema.safeParse(value);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}

/** Same contract for the harness voice list. */
export function parseTtsVoicesResponse(value: unknown): TtsVoicesResponse {
  const parsed = TtsVoicesResponseSchema.safeParse(value);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}
