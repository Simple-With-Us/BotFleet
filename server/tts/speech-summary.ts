import { z } from "zod";
import { spokenReply, stripVoiceSummaryTags } from "../../shared/voice-summary.ts";
import { sanitizeForTTS } from "./minimax.ts";
import { speakable } from "./speech-text.ts";

export const DeepSeekChatMessageSchema = z.object({
  role: z.string().optional(),
  content: z.string().optional(),
});

export const DeepSeekChatChoiceSchema = z.object({
  index: z.number().optional(),
  message: DeepSeekChatMessageSchema.optional(),
  finish_reason: z.string().nullable().optional(),
});

export const DeepSeekChatResponseSchema = z.object({
  id: z.string().optional(),
  object: z.string().optional(),
  created: z.number().optional(),
  model: z.string().optional(),
  choices: z.array(DeepSeekChatChoiceSchema).optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
});

export type DeepSeekChatResponse = z.infer<typeof DeepSeekChatResponseSchema>;

const DEFAULT_DEEPSEEK_BASE = "https://api.deepseek.com";
const DEFAULT_TIMEOUT_MS = 15_000;

/** Explicit config key first, then DEEPSEEK_VOICE_API_KEY, then DEEPSEEK_API_KEY. */
export function resolveDeepSeekKey(providedKey?: string): string {
  const explicit = providedKey?.trim();
  if (explicit && explicit !== "undefined") return explicit;
  const voice = process.env.DEEPSEEK_VOICE_API_KEY?.trim();
  if (voice && voice !== "undefined") return voice;
  const general = process.env.DEEPSEEK_API_KEY?.trim();
  if (general && general !== "undefined") return general;
  return "";
}

export function completionsUrl(baseUrl?: string): string {
  return normalizeDeepSeekChatUrl(baseUrl);
}

export const DEEPSEEK_FLASH_TTS_PROMPT = `<system_prompt>
You are a highly efficient, specialized post-processing model designed to translate raw, agentic LLM responses into perfectly optimized, spoken-word text for real-time Text-to-Speech (TTS) engines (specifically MiniMax speech synthesis).
<core_directive>
Distill the incoming raw text into flowing, natural, and conversational prose. Strip out all visual artifacts, structure, and text that cannot or should not be read aloud. Do not add any conversational preamble (e.g., "Sure, here is the text..."). Output ONLY the final spoken-word text.
</core_directive>
<rules_for_spoken_prose>
1. NO MARKDOWN: Remove all asterisks (**), hashtags (#), headers, backticks, and visual delimiters.
2. NO BULLET POINTS: Convert lists or bullet points into complete, linked spoken sentences using conversational transitions (e.g., "First, ... Next, ... Finally, ...").
3. NO EMOJIS: Delete all emojis, icons, and special symbols entirely.
4. PARAGRAPH BREAKS & BREATHING: Keep sentences concise. Long, winding sentences leave voice engines breathless.
</rules_for_spoken_prose>
<pacing_and_punctuation>
The TTS engine interprets punctuation strictly:
1. NO DASHES (EM-DASH, EN-DASH, HYPHENS): NEVER use em-dashes (—), en-dashes (–), or floating hyphens ( - ) between clauses. The TTS engine drops pauses on dashes, running words together breathlessly. Always replace dashes with a comma, a period, or an inline pause tag.
2. NO ELLIPSES: NEVER use ellipses (...). They cause the speech engine to stall or draw out syllables awkwardly. End completed thoughts cleanly with a period.
3. INLINE PAUSES: Use natural commas and periods for standard cadence. When a distinct, deliberate breath or topical transition is needed between major thoughts or steps, insert a native pause tag: <#0.3#> (for a brief pause) or <#0.5#> (for a half-second topic shift).
4. NO PARENTHESES OR BRACKETS: Never put explanatory text inside parentheses ( ) or brackets [ ]. Parentheses are reserved by the voice engine for sound and IPA tags. Unpack parenthetical remarks into separate spoken sentences.
</pacing_and_punctuation>
<text_normalization>
You must explicitly write out how abbreviations, numbers, and symbols should sound when spoken:
- NUMBERS & CURRENCY: Convert "$50" to "fifty dollars". Convert "3.5" to "three point five".
- PHONE NUMBERS & CODES: Write out sequential individual numbers where necessary, or format them clearly (e.g., "one eight hundred, five five five, zero one two three").
- TIME & DATES: Convert "10:30 PM" to "ten thirty p m". Convert "10/24" to "October twenty-fourth".
- ACRONYMS & INITIALISMS: Spell out letters with spaces or periods (e.g., "A P I" or "A. P. I.", "U S A", "C P U"), never with hyphens.
- URLS & EMAILS: Convert "example.com" to "example dot com". Convert "info@site.com" to "info at site dot com".
- MATH SYMBOLS: Convert "+" to "plus", "=" to "equals", and "%" to "percent".
</text_normalization>
<negative_constraints>
- DO NOT use em-dashes (—), en-dashes (–), or isolated hyphens ( - ).
- DO NOT use ellipses (...).
- DO NOT use parentheses ( ) or brackets [ ] around normal text.
- DO NOT output any thinking blocks, \`<thought>\` tags, or step-by-step reasoning.
- DO NOT leave technical shorthand raw. If a TTS engine reads it, it must sound human.
- DO NOT read out raw git commit hashes, SHA fingerprints, or long hex strings. Omit them completely or summarize simply.
</negative_constraints>
<example_transformation>
INPUT: "Here are your options for the flight: * Flight AA2314 -> Departs at 3:15 PM ($250) — fastest option * Flight DL982 -> Departs at 6:00 PM ($310) Check details at https://jetblue.com..."
OUTPUT: "Here are your options for the flight. <#0.3#> First, American Airlines flight twenty-three fourteen departs at three fifteen p m, costing two hundred and fifty dollars, which is the fastest option. <#0.3#> Next, Delta flight nine eighty-two departs at six p m, costing three hundred and ten dollars. You can check the details at jet blue dot com slash status."
</example_transformation>
</system_prompt>`;

export interface SummarizeVoiceOptions {
  key?: string;
  baseUrl?: string;
  url?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** The caller asked for a condensed summary, so a result much shorter than
   * the reply is expected rather than a sign the model dropped content. */
  condense?: boolean;
}

/** Where the speech text came from.  "summary" is the model's rewrite;
 * "short" is the deterministic pass for a short, plain reply; "fallback" is
 * the deterministic pass standing in for a rewrite that was not usable. */
export type VoiceSummarySource = "summary" | "short" | "fallback";

/** Why a rewrite was not used.  "unavailable" is transient (timeout, network,
 * non-200, empty answer) and worth retrying later; the others reproduce on a
 * retry, so the deterministic text can be stored in place of the rewrite. */
export type VoiceSummaryFallbackReason = "no-key" | "truncated" | "incomplete" | "too-short" | "unavailable";

export interface VoiceSummaryResult {
  text: string;
  source: VoiceSummarySource;
  reason?: VoiceSummaryFallbackReason;
}

export const SUMMARY_MIN_TOKENS = 500;
/** Roughly the 12,000-character spoken cap (server/tts/message-audio.ts) at
 * about three characters a token.  The 15-second request timeout still
 * applies, so a reply that would need more simply falls back to the full
 * deterministic text instead of being cut. */
export const SUMMARY_MAX_TOKENS = 4_000;

/** The completion budget for a reply of `inputChars` characters.  The prompt
 * asks for a spoken rewrite, not a digest, so output tracks input length and
 * spelled-out numbers make it longer; a fixed 500 cut long replies short. */
export function voiceSummaryMaxTokens(inputChars: number): number {
  return Math.min(SUMMARY_MAX_TOKENS, Math.max(SUMMARY_MIN_TOKENS, Math.ceil(inputChars / 3)));
}

/** A rewrite shorter than this share of the deterministic speech text, on a
 * reply at least SUMMARY_RATIO_MIN_CHARS long, is treated as dropped
 * content.  The deterministic text already removes code, links, and paths,
 * so an honest rewrite of the same prose stays well above it. */
export const SUMMARY_MIN_RATIO = 0.35;
export const SUMMARY_RATIO_MIN_CHARS = 400;

/** Whether voiceSummaryFor should store this result as message.voiceText.
 * A transient provider failure is not stored, so the next play can still get
 * the rewrite.  A cut-off rewrite is never returned as text (the full
 * deterministic text stands in), and that stand-in is stored, because asking
 * again would only be cut off again and billed again. */
export function voiceSummaryWorthStoring(result: VoiceSummaryResult): boolean {
  return !(result.source === "fallback" && result.reason === "unavailable");
}

export function summaryLooksTruncated(summary: string, deterministic: string): boolean {
  if (deterministic.length < SUMMARY_RATIO_MIN_CHARS) return false;
  return summary.length < deterministic.length * SUMMARY_MIN_RATIO;
}

export function normalizeDeepSeekChatUrl(baseUrl?: string): string {
  let base = (baseUrl || "").trim();
  if (!base) return `${DEFAULT_DEEPSEEK_BASE}/chat/completions`;
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  base = base.replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) return base;
  return `${base}/chat/completions`;
}

function stripUnclosedFences(text: string): string {
  const fenceRegex = /(?:```|~~~)/g;
  const matches = [...text.matchAll(fenceRegex)];
  if (matches.length % 2 !== 0) {
    const lastMatch = matches[matches.length - 1];
    return text.slice(0, lastMatch.index).trimEnd();
  }
  return text;
}

function cleanSummaryForTTS(summary: string): string {
  const withoutTags = summary.replace(/\[\/?(?:voice_summary|written_answer)\]/gi, "");
  const stripped = stripUnclosedFences(withoutTags);
  return sanitizeForTTS(speakable(stripped));
}

/**
 * Summarize raw bot output into speech-optimized natural text using DeepSeek V4.1 Flash (deepseek-flash).
 * If the model call fails, times out, or no key is configured, falls back gracefully to deepseek-chat or spokenReply().
 */
export async function summarizeForVoice(
  rawText: string,
  optionsOrKey?: string | SummarizeVoiceOptions,
  legacySignal?: AbortSignal,
  extraOptions: { url?: string; timeoutMs?: number } = {},
): Promise<string> {
  return (await summarizeForVoiceDetailed(rawText, optionsOrKey, legacySignal, extraOptions)).text;
}

/** summarizeForVoice, plus where the text came from, so the caller can
 * decide whether it is worth storing. */
export async function summarizeForVoiceDetailed(
  rawText: string,
  optionsOrKey?: string | SummarizeVoiceOptions,
  legacySignal?: AbortSignal,
  extraOptions: { url?: string; timeoutMs?: number } = {},
): Promise<VoiceSummaryResult> {
  const cleanInput = stripVoiceSummaryTags(rawText);
  if (!cleanInput.trim()) return { text: "", source: "short" };

  // Short replies without technical artifacts don't need summarization
  const hasTechnicalContent =
    cleanInput.includes("```") ||
    cleanInput.includes("`") ||
    cleanInput.includes("http") ||
    /\b[0-9a-f]{7,40}\b/i.test(cleanInput) ||
    /[\w-]+\.[\w]{2,4}\b/.test(cleanInput) ||
    /^\s*[-*•]\s+/m.test(cleanInput) ||
    /[*#_\[\]]/.test(cleanInput);

  if (cleanInput.length <= 120 && !hasTechnicalContent) {
    // Normalize the markdown and paragraph structure *before* the acoustic
    // pass: sanitizeForTTS collapses newlines, and the line anchors that
    // strip list markers and add audible paragraph pauses only match on the
    // original text.
    return { text: sanitizeForTTS(speakable(cleanInput)), source: "short" };
  }

  const options: SummarizeVoiceOptions =
    typeof optionsOrKey === "string"
      ? { key: optionsOrKey, signal: legacySignal }
      : (optionsOrKey ?? {});

  const deterministic = () => sanitizeForTTS(speakable(spokenReply(rawText)));
  const fallback = (reason: VoiceSummaryFallbackReason): VoiceSummaryResult => ({ text: deterministic(), source: "fallback", reason });

  const key = resolveDeepSeekKey(options.key);
  if (!key) return fallback("no-key");

  const endpoint = completionsUrl(options.baseUrl || options.url || extraOptions.url);
  const timeoutMs = options.timeoutMs ?? extraOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = voiceSummaryMaxTokens(cleanInput.length);
  const timeoutController = new AbortController();
  const timer = setTimeout(() => {
    timeoutController.abort(new Error("Voice summary request timed out"));
  }, timeoutMs);

  const effectiveSignal = options.signal ?? legacySignal;
  const onCallerAbort = () => {
    timeoutController.abort(effectiveSignal?.reason);
  };

  if (effectiveSignal) {
    if (effectiveSignal.aborted) {
      timeoutController.abort(effectiveSignal.reason);
    } else {
      effectiveSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  /** A usable rewrite, a reason to stop with the deterministic text, or
   * null to try the next model. */
  const judge = (rawData: unknown): VoiceSummaryResult | null => {
    const parsed = DeepSeekChatResponseSchema.safeParse(rawData);
    if (!parsed.success) return null;
    const choice = parsed.data.choices?.[0];
    const content = choice?.message?.content?.trim();
    if (!content) return null;
    // finish_reason "length" means max_tokens cut the rewrite off mid-reply.
    // Anything but "stop" is an incomplete answer; asking a second model the
    // same question at the same budget would cut it again.
    const finish = choice?.finish_reason;
    if (finish === "length") return fallback("truncated");
    if (finish && finish !== "stop") return fallback("incomplete");
    const cleaned = cleanSummaryForTTS(content);
    if (!cleaned) return null;
    if (!options.condense && summaryLooksTruncated(cleaned, deterministic())) return fallback("too-short");
    return { text: cleaned, source: "summary" };
  };

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "deepseek-flash",
        messages: [
          { role: "system", content: DEEPSEEK_FLASH_TTS_PROMPT },
          { role: "user", content: cleanInput },
        ],
        max_tokens: maxTokens,
        temperature: 0.3,
        thinking: { type: "disabled" },
      }),
      signal: timeoutController.signal,
    });

    if (response.ok) {
      const verdict = judge(await response.json());
      if (verdict) return verdict;
    }

    // Fallback: try deepseek-chat if deepseek-flash returned empty or non-200
    const fallbackResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: DEEPSEEK_FLASH_TTS_PROMPT },
          { role: "user", content: cleanInput },
        ],
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
      signal: timeoutController.signal,
    });

    if (fallbackResponse.ok) {
      const verdict = judge(await fallbackResponse.json());
      if (verdict) return verdict;
    }
  } catch {
    // Graceful fallback to deterministic spoken text
  } finally {
    clearTimeout(timer);
    if (options.signal) {
      options.signal.removeEventListener("abort", onCallerAbort);
    }
  }

  return fallback("unavailable");
}
