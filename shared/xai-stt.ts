// xAI speech-to-text: REST and streaming URL builders, pricing, and
// vocabulary cleanup.  The permanent API key never lives in this file —
// callers pass it to the harness-side client in server/stt/xai.ts.
import { z } from "zod";

export const XAI_STT_MODEL = "grok-voice-transcribe-2.0";
export const XAI_STT_REST_URL = "https://api.x.ai/v1/stt";
export const XAI_STT_STREAM_URL = "wss://api.x.ai/v1/stt";
export const XAI_STT_SAMPLE_RATE = 16_000;
export const XAI_STT_REST_USD_PER_HOUR = 0.10;
export const XAI_STT_STREAM_USD_PER_HOUR = 0.20;
export const XAI_STT_MAX_KEYTERMS = 100;
export const XAI_STT_KEYTERM_MAX_CHARS = 50;
export const XAI_STT_DEFAULT_ENDPOINTING_MS = 850;
export const XAI_STT_ENCODING = "pcm";

/** Language codes grok-voice-transcribe-2.0 documents, plus the regional
 *  Spanish, Portuguese, and Arabic variants the docs also accept. */
export const XAI_STT_LANGUAGE_CODES = [
  "ar", "ar-AE", "ar-EG", "ar-SA",
  "bg", "bs", "ca", "cs", "da", "de", "el", "en",
  "es", "es-ES", "es-MX",
  "fa", "fi", "fil", "fr", "hi", "hr", "hu", "id", "it", "ja", "ko",
  "mk", "ms", "nb", "nl",
  "pt", "pt-BR", "pt-PT",
  "pl", "ro", "ru", "sk", "sv", "th", "tr", "uk", "ur", "vi", "yue", "zh",
] as const;

const LANGUAGE_SET = new Set<string>(XAI_STT_LANGUAGE_CODES.map((code) => code.toLowerCase()));

export type XaiSttMode = "rest" | "streaming";

export interface XaiSttStreamingParams {
  language?: string;
  keyterms?: readonly string[];
  /** Silence in ms before an utterance-final event. 0 leaves the vendor default. */
  endpointingMs?: number;
  interimResults?: boolean;
  format?: boolean;
  model?: string;
  sampleRate?: number;
  encoding?: "pcm" | "mulaw" | "alaw" | "opus";
}

export function cleanXaiKeyterms(terms?: readonly string[]): string[] {
  if (!terms?.length) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of terms) {
    const term = raw.trim().slice(0, XAI_STT_KEYTERM_MAX_CHARS);
    if (!term || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
    if (out.length >= XAI_STT_MAX_KEYTERMS) break;
  }
  return out;
}

/** Map a BCP-47 tag like "en-US" onto a code the STT API accepts, or
 *  return undefined so the model detects the language itself. */
export function normalizeXaiSttLanguage(value?: string | null): string | undefined {
  const raw = (value ?? "").trim();
  if (!raw) return undefined;
  const folded = raw.replace(/_/g, "-");
  if (LANGUAGE_SET.has(folded.toLowerCase())) {
    const exact = XAI_STT_LANGUAGE_CODES.find((code) => code.toLowerCase() === folded.toLowerCase());
    return exact ?? folded;
  }
  const base = folded.split("-")[0]?.toLowerCase() ?? "";
  if (LANGUAGE_SET.has(base)) return base;
  return undefined;
}

export function clampEndpointingMs(value?: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded <= 0) return 0;
  return Math.min(5_000, rounded);
}

export function sttCostUsd(durationSeconds: number, mode: XaiSttMode): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  const rate = mode === "streaming" ? XAI_STT_STREAM_USD_PER_HOUR : XAI_STT_REST_USD_PER_HOUR;
  return (durationSeconds / 3600) * rate;
}

export function buildXaiSttStreamingUrl(params: XaiSttStreamingParams = {}): string {
  const query = new URLSearchParams();
  query.set("model", params.model?.trim() || XAI_STT_MODEL);
  query.set("sample_rate", String(params.sampleRate && params.sampleRate > 0 ? Math.round(params.sampleRate) : XAI_STT_SAMPLE_RATE));
  query.set("encoding", params.encoding ?? XAI_STT_ENCODING);
  query.set("interim_results", params.interimResults === false ? "false" : "true");
  const endpointing = clampEndpointingMs(params.endpointingMs);
  if (endpointing !== undefined) query.set("endpointing", String(endpointing));
  const language = normalizeXaiSttLanguage(params.language);
  if (language) {
    query.set("language", language);
    if (params.format !== false) query.set("format", "true");
  }
  for (const term of cleanXaiKeyterms(params.keyterms)) {
    query.append("keyterm", term);
  }
  return `${XAI_STT_STREAM_URL}?${query.toString()}`;
}

export const XaiSttCreatedEventSchema = z.object({ type: z.literal("transcript.created") });
export const XaiSttPartialEventSchema = z.object({
  type: z.literal("transcript.partial"),
  text: z.string().optional(),
  is_final: z.boolean().optional(),
  speech_final: z.boolean().optional(),
  start: z.number().optional(),
  duration: z.number().optional(),
});
export const XaiSttDoneEventSchema = z.object({
  type: z.literal("transcript.done"),
  text: z.string().optional(),
  duration: z.number().optional(),
});
export const XaiSttErrorEventSchema = z.object({
  type: z.literal("error"),
  message: z.string().optional(),
});
export const XaiSttServerEventSchema = z.discriminatedUnion("type", [
  XaiSttCreatedEventSchema,
  XaiSttPartialEventSchema,
  XaiSttDoneEventSchema,
  XaiSttErrorEventSchema,
]);

export type XaiSttPartialEvent = z.infer<typeof XaiSttPartialEventSchema>;
export type XaiSttDoneEvent = z.infer<typeof XaiSttDoneEventSchema>;
export type XaiSttCreatedEvent = z.infer<typeof XaiSttCreatedEventSchema>;
export type XaiSttErrorEvent = z.infer<typeof XaiSttErrorEventSchema>;
export type XaiSttServerEvent = z.infer<typeof XaiSttServerEventSchema>;

export const XaiSttFileResultSchema = z.object({
  text: z.string().optional(),
  duration: z.number().optional(),
});
export const XaiSttHttpErrorSchema = z.object({
  message: z.string().optional(),
  error: z.string().optional(),
});

export const XaiSttWireEventSchema = z.object({
  type: z.string().optional(),
  text: z.string().optional(),
  message: z.string().optional(),
  is_final: z.boolean().optional(),
  speech_final: z.boolean().optional(),
  start: z.number().optional(),
  duration: z.number().optional(),
}).passthrough();
export type XaiSttWireEvent = z.infer<typeof XaiSttWireEventSchema>;

export function parseXaiSttEvent(value: XaiSttWireEvent): XaiSttServerEvent | null {
  const parsed = XaiSttServerEventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Turn a streaming partial into the same { text, final } shape call-stt uses. */
export function xaiPartialToTurn(event: XaiSttPartialEvent): { text: string; final: boolean } | null {
  const text = (event.text ?? "").trim();
  if (!text) return null;
  return { text, final: event.speech_final === true };
}
