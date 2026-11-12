// Inbound microphone recordings are a saved WAV attachment plus the
// recognizer's original transcript.  Corrections are annotations on that
// pair; they never rewrite the audio or the original text.

const WAV_ATTACHMENT = /^\/api\/attachments\/[\w-]+\.wav$/;
const REVIEW_TEXT_MAX = 12_000;
const RECORDING_ENGINE = "apple-on-device" as const;

export type IncomingRecording = {
  path: string;
  mime: "audio/wav";
  transcript: string;
  engine: typeof RECORDING_ENGINE;
};

export type RecordingReview = {
  correction?: string;
  comment?: string;
  updatedAt: number;
};

function reviewText(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > REVIEW_TEXT_MAX) return null;
  return value;
}

/** Accept a client-supplied recording only when it names a saved WAV
 *  attachment and an on-device recognizer transcript. */
export function incomingRecording(value: unknown): IncomingRecording | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.path !== "string" || !WAV_ATTACHMENT.test(rec.path)) return null;
  if (rec.mime !== "audio/wav") return null;
  if (typeof rec.transcript !== "string") return null;
  if (rec.engine !== RECORDING_ENGINE) return null;
  return {
    path: rec.path,
    mime: "audio/wav",
    transcript: rec.transcript,
    engine: RECORDING_ENGINE,
  };
}

/** Merge a PATCH body onto an existing review.  Either field may be omitted;
 *  present fields must be text up to 12 000 characters. */
export function recordingReview(
  existing: RecordingReview | undefined,
  body: unknown,
): RecordingReview | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const rec = body as Record<string, unknown>;
  const correction = reviewText(rec.correction);
  const comment = reviewText(rec.comment);
  if (correction === null || comment === null) return null;
  if (correction === undefined && comment === undefined) return null;
  const next: RecordingReview = { updatedAt: Date.now() };
  const nextCorrection = correction !== undefined ? correction : existing?.correction;
  const nextComment = comment !== undefined ? comment : existing?.comment;
  if (nextCorrection !== undefined) next.correction = nextCorrection;
  if (nextComment !== undefined) next.comment = nextComment;
  return next;
}
