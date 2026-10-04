import { z } from "zod";
import { spokenReply, stripVoiceSummaryTags } from "../../shared/voice-summary.ts";
import { sanitizeForTTS } from "./minimax.ts";

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
}

export function normalizeDeepSeekChatUrl(baseUrl?: string): string {
  let base = (baseUrl || "").trim();
  if (!base) return `${DEFAULT_DEEPSEEK_BASE}/chat/completions`;
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  base = base.replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) return base;
  return `${base}/chat/completions`;
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
  const cleanInput = stripVoiceSummaryTags(rawText);
  if (!cleanInput.trim()) return "";

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
    return sanitizeForTTS(cleanInput);
  }

  const options: SummarizeVoiceOptions =
    typeof optionsOrKey === "string"
      ? { key: optionsOrKey, signal: legacySignal }
      : (optionsOrKey ?? {});

  const key = resolveDeepSeekKey(options.key);
  if (!key) {
    return sanitizeForTTS(spokenReply(rawText));
  }

  const endpoint = completionsUrl(options.baseUrl || options.url || extraOptions.url);
  const timeoutMs = options.timeoutMs ?? extraOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
        max_tokens: 500,
        temperature: 0.3,
        thinking: { type: "disabled" },
      }),
      signal: timeoutController.signal,
    });

    if (response.ok) {
      const rawData: unknown = await response.json();
      const parsed = DeepSeekChatResponseSchema.safeParse(rawData);
      if (parsed.success) {
        const summary = parsed.data.choices?.[0]?.message?.content?.trim();
        if (summary) {
          // Strip any accidental brackets or tags
          return sanitizeForTTS(summary.replace(/\[\/?(?:voice_summary|written_answer)\]/gi, ""));
        }
      }
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
        max_tokens: 300,
        temperature: 0.3,
      }),
      signal: timeoutController.signal,
    });

    if (fallbackResponse.ok) {
      const fbRawData: unknown = await fallbackResponse.json();
      const fbParsed = DeepSeekChatResponseSchema.safeParse(fbRawData);
      if (fbParsed.success) {
        const fbSummary = fbParsed.data.choices?.[0]?.message?.content?.trim();
        if (fbSummary) {
          return sanitizeForTTS(fbSummary.replace(/\[\/?(?:voice_summary|written_answer)\]/gi, ""));
        }
      }
    }
  } catch {
    // Graceful fallback to deterministic spoken text
  } finally {
    clearTimeout(timer);
    if (options.signal) {
      options.signal.removeEventListener("abort", onCallerAbort);
    }
  }

  return sanitizeForTTS(spokenReply(rawText));
}
