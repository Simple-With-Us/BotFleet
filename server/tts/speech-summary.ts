import { spokenReply, stripVoiceSummaryTags } from "../../shared/voice-summary.ts";

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
You are a highly efficient, specialized post-processing model designed to translate raw, agentic LLM responses into perfectly optimized, spoken-word text for real-time Text-to-Speech (TTS) engines.
<core_directive>
Distill the incoming raw text into flowing, natural, and conversational prose. Strip out all visual artifacts, structure, and text that cannot or should not be read aloud. Do not add any conversational preamble (e.g., "Sure, here is the text..."). Output ONLY the final spoken-word text.
</core_directive>
<rules_for_spoken_prose>
1. NO MARKDOWN: Remove all asterisks (**), hashtags (#), headers, backticks, and visual delimiters.
2. NO BULLET POINTS: Convert lists or bullet points into complete, linked spoken sentences using conversational transitions (e.g., "First, ... Next, ... Finally, ...").
3. NO EMOJIS: Delete all emojis, icons, and special symbols entirely.
4. PARAGRAPH BREAKS: Keep sentences short and use standard paragraphs. Avoid long, winding sentences that leave a TTS voice agent with no room to "breathe."
</rules_for_spoken_prose>
<text_normalization>
You must explicitly write out how abbreviations, numbers, and symbols should sound when spoken:
- NUMBERS & CURRENCY: Convert "$50" to "fifty dollars". Convert "3.5" to "three point five".
- PHONE NUMBERS & CODES: Write out sequential individual numbers where necessary, or format them clearly (e.g., "one eight hundred, five five five, zero one two three").
- TIME & DATES: Convert "10:30 PM" to "ten thirty p m". Convert "10/24" to "October twenty-fourth".
- ACRONYMS & INITIALISMS: If an acronym should be spelled out, hyphenate it (e.g., "A-I", "A-P-I", "U-S-A").
- URLS & EMAILS: Convert "example.com" to "example dot com". Convert "info@site.com" to "info at site dot com".
- MATH SYMBOLS: Convert "+" to "plus", "=" to "equals", and "%" to "percent".
</text_normalization>
<negative_constraints>
- DO NOT output any thinking blocks, \`<thought>\` tags, or step-by-step reasoning.
- DO NOT use parenthesis or brackets; if information is inside them, integrate it naturally or remove it.
- DO NOT leave technical shorthand raw. If a TTS engine reads it, it must sound human.
- DO NOT read out raw git commit hashes, SHA fingerprints, or long hex strings. Omit them completely or summarize simply.
</negative_constraints>
<example_transformation>
INPUT: "Here are your options for the flight: * Flight AA2314 -> Departs at 3:15 PM ($250) * Flight DL982 -> Departs at 6:00 PM ($310) Check details at ://jetblue.com."
OUTPUT: "Here are your options for the flight. First, American Airlines flight twenty-three fourteen departs at three fifteen p m, and costs two hundred and fifty dollars. Next, Delta flight nine eighty-two departs at six p m, costing three hundred and ten dollars. You can check the details at jet blue dot com slash status."
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
    return cleanInput;
  }

  const options: SummarizeVoiceOptions =
    typeof optionsOrKey === "string"
      ? { key: optionsOrKey, signal: legacySignal }
      : (optionsOrKey ?? {});

  const key = resolveDeepSeekKey(options.key);
  if (!key) {
    return spokenReply(rawText);
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
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const summary = data?.choices?.[0]?.message?.content?.trim();
      if (summary) {
        // Strip any accidental brackets or tags
        return summary.replace(/\[\/?(?:voice_summary|written_answer)\]/gi, "").trim();
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
      const fbData = (await fallbackResponse.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const fbSummary = fbData?.choices?.[0]?.message?.content?.trim();
      if (fbSummary) {
        return fbSummary.replace(/\[\/?(?:voice_summary|written_answer)\]/gi, "").trim();
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

  return spokenReply(rawText);
}
