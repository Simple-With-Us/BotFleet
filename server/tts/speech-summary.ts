import { z } from "zod";
import type { Pronunciation } from "../../shared/pronunciations.ts";
import { utterancesWithSpans } from "../../shared/speech-spans.ts";
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
You are a specialized post-processing model that prepares agent replies for Apple Personal Voice (on-device AVSpeechSynthesizer).  BotFleet also plays the same script through other engines; the app adapts pause markers per voice.
<core_directive>
Prepare the incoming text for spoken delivery.  Keep every word from the input in the same order.  Do not paraphrase, summarize, shorten, expand, or add facts.  Do not retell lists as narrative prose (no "First," "Next," or "Finally,").  Do not spell out numbers, acronyms, URLs, paths, or codes unless they already appear as words in the input.  Output ONLY the adjusted text, with no preamble.
</core_directive>
<allowed_changes>
1. MARKDOWN DELIMITERS ONLY: Remove markdown syntax characters (asterisks, backticks, heading hashes, list markers, table pipes) while keeping the underlying words.  Do not replace a code block or link with a description; leave the words that remain after stripping delimiters.
2. PUNCTUATION: Fix punctuation so Personal Voice pauses naturally.  Replace em-dashes (—), en-dashes (–), and floating clause hyphens with a comma or a period.  Replace ellipses (...) with a period.  You may end a run-on with a period and capitalize the next word only when splitting an existing sentence, without changing any words.
3. PAUSE MARKERS: Insert <#0.3#> (brief breath) or <#0.5#> (topic shift) only between two complete sentences, never at the start or end, never two in a row.  The app strips these for on-device voices and turns them into silence; hosted voices may honor them.
4. PROSODY TAGS: You may insert MiniMax sound tags (breath), (chuckle), or (sighs) at most once per paragraph, only when the input clearly calls for it, written exactly in that form.  Never use other parentheses or brackets.
5. EMOJI: Delete emoji and pictographic symbols only; do not delete words.
</allowed_changes>
<pacing_and_punctuation>
Apple Personal Voice pauses on punctuation and utterance boundaries, not on dashes:
1. NO DASHES: Never leave em-dashes, en-dashes, or isolated hyphens between clauses.
2. NO ELLIPSES: Never leave ellipses in the output.
3. NO RAW URL SCHEMES: Do not add https:// or new domains.  Leave hostnames and paths that are already in the input.
</pacing_and_punctuation>
<negative_constraints>
- DO NOT paraphrase, summarize, or omit sentences, list items, paths, hashes, or identifiers.
- DO NOT spell out numbers, currency, times, dates, acronyms, or URLs.
- DO NOT convert bullet or numbered lists into flowing prose.
- DO NOT use parentheses or brackets except the allowed MiniMax sound tags above.
- DO NOT output thinking blocks, \`<thought>\` tags, or step-by-step reasoning.
</negative_constraints>
<example_transformation>
INPUT: "Here are your options for the flight:\n* Flight AA2314 -> Departs at 3:15 PM ($250) — fastest option\n* Flight DL982 -> Departs at 6:00 PM ($310)\nCheck details at https://jetblue.com/status"
OUTPUT: "Here are your options for the flight. <#0.3#> Flight AA2314 departs at 3:15 PM ($250), fastest option. <#0.3#> Flight DL982 departs at 6:00 PM ($310). Check details at https://jetblue.com/status"
</example_transformation>
</system_prompt>`;

/**
 * The system prompt with the workspace pronunciation list appended, so a
 * distilled script made after the list changes already says each term the
 * way the owner asked ("sequel" for SQL).  Scripts stored before the change
 * are reused as they are, with their clips (server/index.ts voiceSummaryFor),
 * so the list reaches them only through the engine-side pass in
 * server/tts/index.ts speak.  Kept deliberately small; the prompt itself is
 * rewritten separately.
 */
export function voiceSummarySystemPrompt(pronunciations: readonly Pronunciation[] = []): string {
  if (!pronunciations.length) return DEEPSEEK_FLASH_TTS_PROMPT;
  // JSON-quoted, so a term or a respelling can never close the block or
  // read as an instruction of its own.
  const pairs = pronunciations.map((p) => `- ${JSON.stringify(p.term)} is said ${JSON.stringify(p.say)}`).join("\n");
  return `${DEEPSEEK_FLASH_TTS_PROMPT}
<pronunciations>
Always say these terms exactly as given.  Write the respelling in place of the term, wherever the term appears as a whole word in the spoken text.  This overrides the acronym rule above: do not spell these terms out letter by letter.
${pairs}
</pronunciations>`;
}

/**
 * The deterministic spoken text for `text`: speakable()'s rules, split into
 * utterances and joined with single spaces.  This is exactly the written-mode
 * script (shared/speech-spans.ts utterancesWithSpans), so when the distiller
 * is skipped (a short plain reply) or falls back (no key, timeout, a cut-off
 * rewrite), server/tts/message-audio.ts can recognize the
 * text it stored and hand clients the source spans that guide the karaoke
 * highlight.  MiniMax still gets its acoustic pass: synthesize() runs
 * sanitizeForTTS on every utterance.
 */
export function deterministicSpokenText(text: string): string {
  return utterancesWithSpans(text).map((u) => u.text).join(" ");
}

export interface SummarizeVoiceOptions {
  key?: string;
  baseUrl?: string;
  url?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** The workspace pronunciation list, appended to the prompt
   * (voiceSummarySystemPrompt).  The deterministic fallback leaves it to
   * the engine-side pass. */
  pronunciations?: readonly Pronunciation[];
}

/** Where the speech text came from.  "summary" is the model's rewrite;
 * "short" is the deterministic pass for a short, plain reply; "fallback" is
 * the deterministic pass standing in for a rewrite that was not usable. */
export type VoiceSummarySource = "summary" | "short" | "fallback";

/** Why a rewrite was not used.  "unavailable" is transient (network error,
 * non-200, empty answer) and worth retrying later.  The others reproduce on
 * a retry, so the deterministic text can be stored in place of the rewrite.
 * That includes "timeout": the same long reply at the same budget runs out of
 * time again, and each retry would cost the full deadline before speech. */
export type VoiceSummaryFallbackReason = "no-key" | "truncated" | "incomplete" | "timeout" | "unavailable";

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

/** Whether this result is worth keeping as message.voiceText.  A transient
 * provider failure (network error, non-200, empty answer) is not: the next
 * play asks the distiller again, on any device, and a hosted voice's clips of
 * the stand-in are stamped as the reply as written so they are reused if the
 * distiller is still down and replaced if it answers (server/tts/
 * message-audio.ts).  A cut-off rewrite is never returned as text (the full
 * deterministic text stands in), and that stand-in is kept, because asking
 * again would only be cut off again and billed again. */
export function voiceSummaryWorthStoring(result: VoiceSummaryResult): boolean {
  return !(result.source === "fallback" && result.reason === "unavailable");
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
  // Personal Voice distillation keeps the reply's words; acoustic cleanup only.
  return sanitizeForTTS(stripped.trim());
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
    // The deterministic script, span-aligned to the reply (see
    // deterministicSpokenText); its markdown and paragraph rules run on the
    // original text, before synthesize()'s acoustic pass collapses newlines.
    return { text: deterministicSpokenText(cleanInput), source: "short" };
  }

  const options: SummarizeVoiceOptions =
    typeof optionsOrKey === "string"
      ? { key: optionsOrKey, signal: legacySignal }
      : (optionsOrKey ?? {});

  const deterministic = () => deterministicSpokenText(spokenReply(rawText));
  const fallback = (reason: VoiceSummaryFallbackReason): VoiceSummaryResult => ({ text: deterministic(), source: "fallback", reason });

  const key = resolveDeepSeekKey(options.key);
  if (!key) return fallback("no-key");

  const endpoint = completionsUrl(options.baseUrl || options.url || extraOptions.url);
  const timeoutMs = options.timeoutMs ?? extraOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = voiceSummaryMaxTokens(cleanInput.length);
  const systemPrompt = voiceSummarySystemPrompt(options.pronunciations);
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
  const judge = (data: DeepSeekChatResponse | null): VoiceSummaryResult | null => {
    const choice = data?.choices?.[0];
    const content = choice?.message?.content?.trim();
    if (!content) return null;
    // finish_reason "length" means max_tokens cut the rewrite off mid-reply.
    // Anything but "stop" is an incomplete answer; asking a second model the
    // same question at the same budget would cut it again.
    const finish = choice?.finish_reason;
    if (finish === "length") return fallback("truncated");
    if (finish && finish !== "stop") return fallback("incomplete");
    // A finished rewrite may be shorter only when the model dropped markdown
    // delimiters; paraphrase or summary is a prompt violation, not expected.
    const cleaned = cleanSummaryForTTS(content);
    if (!cleaned) return null;
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
          { role: "system", content: systemPrompt },
          { role: "user", content: cleanInput },
        ],
        max_tokens: maxTokens,
        temperature: 0.3,
        thinking: { type: "disabled" },
      }),
      signal: timeoutController.signal,
    });

    if (response.ok) {
      const parsed = DeepSeekChatResponseSchema.safeParse(await response.json());
      const verdict = judge(parsed.success ? parsed.data : null);
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
          { role: "system", content: systemPrompt },
          { role: "user", content: cleanInput },
        ],
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
      signal: timeoutController.signal,
    });

    if (fallbackResponse.ok) {
      const parsed = DeepSeekChatResponseSchema.safeParse(await fallbackResponse.json());
      const verdict = judge(parsed.success ? parsed.data : null);
      if (verdict) return verdict;
    }
  } catch {
    // Graceful fallback to deterministic spoken text.  Our own deadline (not
    // the caller cancelling) is the one failure that will repeat.
    if (timeoutController.signal.aborted && !effectiveSignal?.aborted) return fallback("timeout");
  } finally {
    clearTimeout(timer);
    if (options.signal) {
      options.signal.removeEventListener("abort", onCallerAbort);
    }
  }

  return fallback("unavailable");
}
