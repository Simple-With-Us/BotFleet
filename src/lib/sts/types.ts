// Call-mode speech-to-speech (STS). A provider-agnostic interface so the call
// flow never branches on vendor, mirroring the STTSession seam in call-stt.ts.
//
// An STS provider replaces the whole chained loop — capture, understanding and
// speech are one duplex session with the model — so it is deliberately a
// different seam from STTProvider rather than a third value on it. The chained
// path stays available; STS is opt-in per bot.
//
// Two responsibilities sit on top of the vendor transport and are handled here
// rather than in each provider, because they are what make a BotFleet bot sound
// like a BotFleet bot:
//
//  * The bot's real engine is offered as a function tool.  A coding agent with a
//    workspace and tools is not a persona, so `botEngine` lets the model hand
//    real work to the engine that owns the bot.
//  * That engine is slower than the model expects.  EngineTool applies a
//    deadline and, on timeout or failure, tells the model to answer without the
//    engine for that turn and marks the line so the transcript shows the
//    degradation instead of silently inventing an answer.
//
// Credentials never reach the renderer: providers mint a short-lived token
// through the bridge and connect with that.

/** Providers that expose a duplex speech-to-speech session. */
export type StsProvider = "xai" | "gemini";

/** Why an STS session is or is not usable. */
export type StsUnavailableReason =
  | "no-provider"
  | "key-missing"
  | "not-supported";

/** A single spoken turn. */
export interface StsTranscriptLine {
  text: string;
  /** Which side said it. */
  from: "bot" | "user";
  final: boolean;
  /**
   * True when the bot answered this turn *without* its configured engine,
   * because the engine call failed or hit the deadline.  Surfaced in the
   * transcript rather than swallowed: a silent swap to a weaker answer is worse
   * than a visible one.
   */
  engineBypassed?: boolean;
}

export interface StsStartOptions {
  /** Bot persona / system prompt, already composed by the caller. */
  instructions: string;
  /** Invoke the bot's own engine.  Omitted when the engine is unavailable. */
  botEngine?: StsBotEngine;
  /** ISO language hint, e.g. "en".  Providers use it to pick a voice. */
  language?: string;
  /** Milliseconds before the engine call is abandoned and the model answers alone. */
  engineTimeoutMs?: number;
}

/**
 * The bot's own engine, as an STS function tool.
 *
 * `run` returns the engine's reply.  Rejecting is fine — EngineTool turns a
 * rejection into a bypass rather than a dead session.
 */
export interface StsBotEngine {
  name: string;
  description: string;
  /** JSON Schema for the tool's parameters. */
  parameters: Record<string, unknown>;
  run(input: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}

export interface StsSession {
  readonly provider: StsProvider;
  /**
   * Open the transport and complete the vendor handshake.  Resolves once the
   * session can accept audio, so callers can treat this as "ready".
   */
  start(opts: StsStartOptions): Promise<void>;
  /** Feed a chunk of 16 kHz mono PCM16 from the capture path. */
  sendAudio(pcm: ArrayBuffer): void;
  /** Stop capture and playback and tear the transport down. Idempotent. */
  stop(): Promise<void>;
  /** Listeners attach before start() so nothing is missed during handshake. */
  onLine(fn: (line: StsTranscriptLine) => void): () => void;
  /** Transport or vendor error, surfaced to the call view. */
  onError(fn: (error: Error) => void): () => void;
  /** Fires when the session is ending on its own (vendor goAway, expiry). */
  onClosed(fn: (reason: string) => void): () => void;
}

/**
 * Engine-call policy shared by every provider, so the timeout and bypass
 * behaviour cannot drift between them.
 */
export const DEFAULT_ENGINE_TIMEOUT_MS = 10_000;

/** Tool name used for the bot's own engine across all providers. */
export const BOT_ENGINE_TOOL = "bot_engine";

/**
 * Phrase the model is told to use while it waits, mirroring xAI's documented
 * preamble pattern ("Use preambles to mask latency").  Costs ~2s of the gap; the
 * deadline covers the rest.
 */
export const ENGINE_PREAMBLE_INSTRUCTION =
  'Before calling any tool, say one short line such as "Let me check that." and call the tool immediately.';

/**
 * The instruction given to the model when the engine could not be reached.  It
 * must be explicit that answering from its own knowledge is correct behaviour,
 * otherwise a model that was told to delegate will hedge or refuse.
 */
export const ENGINE_BYPASS_INSTRUCTION =
  "The bot's engine is unavailable right now. Answer this turn yourself, " +
  "from your own knowledge, without mentioning tools or the engine.";