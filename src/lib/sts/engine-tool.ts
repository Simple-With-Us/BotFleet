// Engine-tool policy, shared by every STS provider.
//
// The decision this encodes: the model should hand real work to the bot's own
// engine, but a coding engine that takes 10-30s is far slower than a voice
// model expects, and a silent silence reads as a dropped call. So an engine call
// is bounded by a deadline, and on timeout the turn degrades to the model
// answering alone — visibly, not silently.
//
// "Visibly" is the part that matters. If the engine is down and the model just
// answers confidently, nothing in the transcript says the bot's actual brain
// never ran. `engineBypassed` is carried on the transcript line for exactly
// that reason: the user should be able to tell the difference between "my bot
// answered" and "the voice model answered because my bot was unreachable".
//
// Provider-agnostic on purpose. xAI and Gemini have incompatible transports, but
// the deadline, the bypass and the marking are one behaviour, so they live here
// and both providers call in.

import { z } from "zod";
import {
  BOT_ENGINE_TOOL,
  DEFAULT_ENGINE_TIMEOUT_MS,
  ENGINE_BYPASS_INSTRUCTION,
  ENGINE_PREAMBLE_INSTRUCTION,
  type StsBotEngine,
} from "./types";

export type EngineBypassReason =
  | "timeout"
  | "engine-error"
  | "engine-unavailable";

export interface EngineCallOutcome {
  /** True when the engine answered and its text should be handed to the model. */
  ok: boolean;
  /** Engine reply, or the fallback prompt for the model when `ok` is false. */
  text: string;
  /** True when the model must answer this turn itself. */
  bypassed: boolean;
  /** Present only when `bypassed`. */
  reason?: EngineBypassReason;
  durationMs: number;
}

/** Ceiling on any single engine call, regardless of configuration. */
const MAX_ENGINE_TIMEOUT_MS = 120_000;

/** Knob values arrive from config as parsed scalars; validate at the boundary.
 *  Deliberately not `.int()`: rounding is this function's job, and rejecting a
 *  fractional value here would silently swap it for the default. */
const timeoutSchema = z.number().positive();

/** An engine reply is only usable if it parses to non-blank text. */
const replySchema = z.string();

export function normalizeEngineTimeout(ms: number | undefined): number {
  const parsed = timeoutSchema.safeParse(ms);
  if (!parsed.success) return DEFAULT_ENGINE_TIMEOUT_MS;
  return Math.min(MAX_ENGINE_TIMEOUT_MS, Math.round(parsed.data));
}

/**
 * Run the bot's engine under a deadline.
 *
 * Never rejects. A failed engine is a degraded turn, not a broken session — the
 * whole point of the fallback is that the call keeps going.
 */
export async function callBotEngine(
  engine: StsBotEngine,
  input: Record<string, unknown>,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<EngineCallOutcome> {
  const started = Date.now();
  const timeoutMs = normalizeEngineTimeout(opts.timeoutMs);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  // If the caller already aborted (session torn down), do not start work.
  if (opts.signal?.aborted) {
    clearTimeout(timer);
    return {
      ok: false,
      text: ENGINE_BYPASS_INSTRUCTION,
      bypassed: true,
      reason: "engine-unavailable",
      durationMs: 0,
    };
  }
  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });

  try {
    const text = await engine.run(input, controller.signal);
    clearTimeout(timer);
    const parsed = replySchema.safeParse(text);
    const answer = parsed.success ? parsed.data.trim() : "";
    if (!answer) {
      // An empty reply is not an answer. Treat it as a bypass rather than
      // handing the model a blank result it will try to speak.
      return {
        ok: false,
        text: ENGINE_BYPASS_INSTRUCTION,
        bypassed: true,
        reason: "engine-error",
        durationMs: Date.now() - started,
      };
    }
    return { ok: true, text: answer, bypassed: false, durationMs: Date.now() - started };
  } catch {
    clearTimeout(timer);
    return {
      ok: false,
      text: ENGINE_BYPASS_INSTRUCTION,
      bypassed: true,
      reason: timedOut ? "timeout" : "engine-error",
      durationMs: Date.now() - started,
    };
  } finally {
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * Compose the session instructions: persona, then the latency preamble, then
 * how to behave when the engine is missing.
 *
 * The preamble is here rather than in each provider because it is a property of
 * the tool being slow, not of the transport.
 */
export function composeStsInstructions(
  persona: string,
  opts: { engineAvailable: boolean; language?: string },
): string {
  const parts: string[] = [persona.trim()];

  if (opts.engineAvailable) {
    parts.push(
      `You have one tool, \`${BOT_ENGINE_TOOL}\`, which runs the bot's own coding ` +
        `engine. Use it for anything real: reading or changing code, running ` +
        `commands, working in the workspace, or anything you would otherwise have ` +
        `to guess at. Do not answer from memory when the tool can answer properly.`,
      ENGINE_PREAMBLE_INSTRUCTION,
      `If \`${BOT_ENGINE_TOOL}\` fails, times out, or returns nothing useful, ` +
        `answer that turn yourself from your own knowledge. Never mention the ` +
        `tool, the engine, or the failure to the user.`,
    );
  } else {
    parts.push(ENGINE_BYPASS_INSTRUCTION);
  }

  if (opts.language) parts.push(`Speak in ${opts.language}.`);
  return parts.filter(Boolean).join("\n\n");
}

/** Tool declaration in xAI/OpenAI-realtime function form. */
export function engineToolDefinition(engine: StsBotEngine) {
  return {
    type: "function" as const,
    name: engine.name || BOT_ENGINE_TOOL,
    description: engine.description,
    parameters: engine.parameters,
  };
}

/** Tool declaration in Gemini's function-declaration form. */
export function engineGeminiToolDefinition(engine: StsBotEngine) {
  return [
    {
      name: engine.name || BOT_ENGINE_TOOL,
      description: engine.description,
      parameters: engine.parameters,
    },
  ];
}