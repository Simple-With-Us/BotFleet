// The call side of a speech-to-speech session: which mode a call runs in, the
// microphone that feeds it, and the bot engine the model may call.
//
// Three decisions live here rather than in the call view, because each of them
// is a question with a right answer that does not need a component to state it.
//
//  * Which mode a call runs in.  Chained is the default and the shipped path,
//    so STS is chosen only when `pickStsProvider` actually names a provider and
//    the microphone can be captured.  Everything else falls back silently: a
//    call that quietly degrades is far better than a call that refuses.
//  * How transcript lines are folded.  A user turn arrives twice — a running
//    transcript and then the final one — so the view keeps one open user line
//    rather than stacking a second copy of the same sentence.
//  * What the bot's engine is, as a tool.  A coding agent with a workspace is
//    not a persona, so the model is handed a `bot_engine` function that runs a
//    real turn and resolves with its reply.  The deadline and the bypass belong
//    to the frozen provider layer; this file only supplies the tool.
//
// The capture half mirrors `assemblyai-transcription.ts` exactly — the same
// `getUserMedia` constraints, the same ScriptProcessor into a zeroed gain node,
// the same `pcm16FromFloat32` resample.  Both providers own playback
// themselves, so nothing here plays audio: capture goes up, nothing comes back
// down this path.

import { z } from "zod";

import { pcm16FromFloat32 } from "../assemblyai-transcription";
import {
  BOT_ENGINE_TOOL,
  pickStsProvider,
  type StsBotEngine,
  type StsCapability,
  type StsProvider,
  type StsSession,
  type StsTranscriptLine,
} from "./index";

// The call view imports this module directly — the frozen index cannot be
// extended to re-export it — so the provider-facing types travel with it.
export type { StsCapability, StsProvider, StsSession, StsTranscriptLine } from "./index";

/** What every provider's input contract expects: 16 kHz mono PCM16. */
export const STS_INPUT_SAMPLE_RATE = 16_000;

/** Frames per forwarded chunk, matching the existing streaming dictation path. */
const CAPTURE_FRAME = 4096;

/** How the call runs. "chained" is the shipped default and never regresses. */
export type CallMode = "sts" | "chained";

export interface CallModeDecision {
  mode: CallMode;
  /** The provider taking the call.  Present only when `mode` is "sts". */
  provider?: StsProvider;
  /**
   * Why this mode.  The chained fallbacks are deliberately quiet: nothing here
   * is worth interrupting a user over, and the view only narrates an STS call
   * that actually started.
   */
  reason: "provider-selected" | "no-bridge" | "no-key" | "no-microphone";
}

/** The bridge facts one STS decision needs, read once per call. */
export interface StsEnvironment {
  platform: string;
  /** Whether the preload can mint an STS session token at all. */
  bridgeAvailable: boolean;
  /** Which providers hold a credential; absent means "no credential". */
  keys?: { xai?: boolean; gemini?: boolean };
  /** `null` or absent means Auto. */
  preference?: StsProvider | null;
}

/** Narrow bridge facts to the capability shape `pickStsProvider` takes. */
export function stsCapability(env: StsEnvironment): StsCapability {
  // Built field by field rather than spread: a conditional spread is the
  // shape that quietly carries an `xai: undefined` into a per-provider map,
  // and this map is the whole reason the picker can name a missing key.
  const keys: Partial<Record<StsProvider, boolean>> = {};
  if (env.keys?.xai !== undefined) keys.xai = env.keys.xai;
  if (env.keys?.gemini !== undefined) keys.gemini = env.keys.gemini;
  return {
    platform: env.platform,
    keys,
    explicitPreference: env.preference ?? null,
    bridgeAvailable: env.bridgeAvailable,
  };
}

/**
 * Choose the mode for a call.
 *
 * STS needs the microphone, and the chained path does not necessarily: Apple
 * dictation captures through the native speech helper and never calls
 * `getUserMedia`.  So a missing microphone disqualifies STS alone, and the
 * call continues on the path that can still work.
 */
export function decideCallMode(input: {
  capability: StsCapability;
  microphoneAvailable: boolean;
}): CallModeDecision {
  if (!input.microphoneAvailable) return { mode: "chained", reason: "no-microphone" };
  const choice = pickStsProvider(input.capability);
  if (choice.provider === null) {
    return { mode: "chained", reason: choice.missing === "bridge" ? "no-bridge" : "no-key" };
  }
  return { mode: "sts", provider: choice.provider, reason: "provider-selected" };
}

/** Whether this host can capture a microphone through the web path at all. */
export function microphoneAvailable(): boolean {
  if (!globalThis.navigator) return false;
  if (!navigator.mediaDevices?.getUserMedia) return false;
  return "AudioContext" in globalThis;
}

/** The bridge members the STS layer reads, optional so an old build is a
 * structural match rather than a special case at every call site. */
export interface StsBridgeLike {
  sts?: {
    status?: () => Promise<{ xai: boolean; gemini: boolean }>;
    xaiToken?: () => Promise<{ token: string; expiresInSeconds: number }>;
    geminiToken?: () => Promise<{ token: string; expiresInSeconds: number }>;
  };
}

/**
 * The bridge's own view of whether an STS token can be minted.
 *
 * The token minters are what matter, not the status probe: `status` answers a
 * question for the settings panel, while a call needs one of these two.
 */
export function stsBridgeAvailable(bridge: StsBridgeLike | undefined): boolean {
  const sts = bridge?.sts;
  return Boolean(sts?.xaiToken) || Boolean(sts?.geminiToken);
}

/**
 * Which providers hold a credential.
 *
 * `undefined` means the answer is not known — no bridge, a build without it, or
 * a probe that failed — and never "no key".  The distinction matters: a failed
 * probe must leave the call on the chained path without telling the user their
 * keys are missing.
 */
export async function readStsKeys(
  bridge: StsBridgeLike | undefined,
): Promise<{ xai: boolean; gemini: boolean } | undefined> {
  try {
    return await bridge?.sts?.status?.();
  } catch {
    return undefined;
  }
}

// ── the microphone ──────────────────────────────────────────────────────

/**
 * The microphone constraints this capture asks for, as a value so they can be
 * asserted.  Identical to the streaming dictation path: the providers play the
 * bot's own voice on this machine, so a tail of that voice leaking into the
 * captured stream is the failure mode to design against.
 */
export const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/** An open microphone, reduced to the one thing teardown needs. */
export interface MicStream {
  release(): void;
  /** The device stream the audio graph attaches to, when there is one. */
  readonly device?: MediaStream;
}

/** A wired tap over one microphone, reduced to disposal. */
export interface MicFrameTap {
  dispose(): void;
}

/** The slice of the audio graph this capture drives. */
export interface MicAudioGraph {
  readonly sampleRate: number;
  /** True when the context is not running yet and must be resumed. */
  readonly suspended: boolean;
  resume(): Promise<void>;
  close(): Promise<void>;
  /** Wire the stream, calling `onFrame` with each mono frame. */
  capture(stream: MicStream, onFrame: (frame: Float32Array) => void): MicFrameTap;
}

/** The web pieces the capture needs, injected so the driver is testable. */
export interface MicPlatform {
  getUserMedia(constraints: MediaTrackConstraints): Promise<MicStream>;
  createAudioGraph: () => MicAudioGraph;
}

export interface MicCapture {
  /** Begin delivering 16 kHz mono PCM16 frames. */
  start(onFrame: (pcm: ArrayBuffer) => void): Promise<void>;
  /** Release the microphone and the audio graph.  Idempotent. */
  stop(): Promise<void>;
}

/** The dictation graph, written once over the Web Audio API. */
function browserAudioGraph(context: AudioContext): MicAudioGraph {
  return {
    sampleRate: context.sampleRate,
    suspended: context.state === "suspended",
    resume: () => context.resume(),
    close: () => context.close(),
    capture(stream, onFrame) {
      const device = stream.device;
      if (!device) throw new Error("This microphone cannot be attached to an audio graph.");
      const source = context.createMediaStreamSource(device);
      // A ScriptProcessor into a gain node at zero, connected to the
      // destination: the graph has to reach an output for the node to be pulled.
      const processor = context.createScriptProcessor(CAPTURE_FRAME, 1, 1);
      const output = context.createGain();
      output.gain.value = 0;
      processor.onaudioprocess = (event) => onFrame(event.inputBuffer.getChannelData(0));
      source.connect(processor);
      processor.connect(output);
      output.connect(context.destination);
      return {
        dispose() {
          processor.onaudioprocess = null;
          source.disconnect();
          processor.disconnect();
          output.disconnect();
        },
      };
    },
  };
}

function browserMicPlatform(): MicPlatform | null {
  if (!microphoneAvailable()) return null;
  return {
    getUserMedia: async (constraints) => {
      const media = await navigator.mediaDevices.getUserMedia({ audio: constraints });
      return {
        device: media,
        release() {
          for (const track of media.getTracks()) track.stop();
        },
      };
    },
    createAudioGraph: () => browserAudioGraph(new AudioContext()),
  };
}

/**
 * Capture the microphone and hand back 16 kHz mono PCM16.
 *
 * The browser microphone reports whatever rate the device runs at, so the
 * resample is not optional: a 48 kHz frame sent raw would play back an octave
 * down and desynchronise the model from the speaker.  Frames produced after a
 * stop are dropped rather than flushed, because the session they would feed is
 * already gone.
 */
export function createMicCapture(platform: MicPlatform | null = browserMicPlatform()): MicCapture {
  let stream: MicStream | null = null;
  let graph: MicAudioGraph | null = null;
  let tap: MicFrameTap | null = null;
  let stopping = false;

  return {
    async start(onFrame) {
      if (!platform) throw new Error("This environment cannot capture the microphone.");
      if (stream) return;
      stopping = false;
      let opened: MicStream;
      try {
        opened = await platform.getUserMedia(MIC_CONSTRAINTS);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`The microphone could not start: ${detail}`);
      }
      // A stop() that landed while the permission prompt was open releases the
      // stream it was handed instead of opening a graph nobody will tear down.
      if (stopping) {
        opened.release();
        return;
      }
      stream = opened;
      const live = platform.createAudioGraph();
      graph = live;
      if (live.suspended) await live.resume();
      tap = live.capture(stream, (frame) => {
        if (stopping) return;
        const pcm = pcm16FromFloat32(frame, live.sampleRate, STS_INPUT_SAMPLE_RATE);
        if (pcm.byteLength) onFrame(pcm);
      });
    },
    async stop() {
      if (stopping) return;
      stopping = true;
      tap?.dispose();
      tap = null;
      const live = graph;
      graph = null;
      const media = stream;
      stream = null;
      await live?.close().catch(() => {});
      media?.release();
    },
  };
}

// ── the session driver ───────────────────────────────────────────────────

export interface StsDriverHandlers {
  onLine?: (line: StsTranscriptLine) => void;
  onError?: (error: Error) => void;
  onClosed?: (reason: string) => void;
}

export interface StsCallDriver {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Own one STS session for the length of a call.
 *
 * Listeners attach before the capture opens, so nothing said during the
 * handshake is missed.  `stop()` is idempotent and shared between concurrent
 * callers: hangup, navigation and a vendor `goAway` can all arrive at once,
 * and a second `session.stop()` must not be a second teardown.
 */
export function createStsCallDriver(
  session: StsSession,
  handlers: StsDriverHandlers = {},
  capture: MicCapture = createMicCapture(),
): StsCallDriver {
  let started = false;
  let teardown: Promise<void> | null = null;
  let detach: Array<() => void> = [];

  return {
    async start() {
      if (started) return;
      started = true;
      // Detached before the teardown, not after: a deliberate stop must not
      // report itself to the call view as a vendor closing the session.
      if (handlers.onLine) detach.push(session.onLine(handlers.onLine));
      if (handlers.onError) detach.push(session.onError(handlers.onError));
      if (handlers.onClosed) detach.push(session.onClosed(handlers.onClosed));
      try {
        await capture.start((pcm) => session.sendAudio(pcm));
      } catch (error) {
        for (const off of detach.splice(0)) off();
        started = false;
        // The session is already listening, so a failed capture must not leave
        // an open socket behind a driver the caller believes never started.
        await session.stop().catch(() => {});
        throw error;
      }
    },
    async stop() {
      if (!teardown) {
        teardown = (async () => {
          started = false;
          for (const off of detach.splice(0)) off();
          // The session is stopped even if releasing the microphone fails: a
          // live provider socket costs money, and the caller asked to end the
          // call, not to end it if teardown was tidy.
          await capture.stop().catch(() => {});
          await session.stop().catch(() => {});
        })();
      }
      await teardown;
    },
  };
}

// ── the transcript the view draws ───────────────────────────────────────

export interface StsLineView {
  /** Stable identity for React, monotonic per call. */
  key: number;
  from: "bot" | "user";
  text: string;
  final: boolean;
  /** The bot answered without its engine on this turn. */
  engineBypassed: boolean;
}

/**
 * Fold one provider line into the call view's transcript.
 *
 * A user turn arrives twice — a running transcript and then the final text for
 * the same turn — so any user line that follows an open one replaces it.  A bot
 * line arrives once, already final, and may carry the `engineBypassed` mark the
 * provider sets when the engine failed or hit its deadline.
 */
export function appendStsLine(
  lines: readonly StsLineView[],
  line: StsTranscriptLine,
  key: number,
): StsLineView[] {
  const next = [...lines];
  const text = line.text.trim();
  if (!text) return next;
  const bypassed = line.engineBypassed === true;
  if (line.from === "user") {
    for (let index = next.length - 1; index >= 0; index -= 1) {
      const open = next[index];
      if (open?.from === "user" && !open.final) {
        next[index] = { ...open, text, final: line.final, engineBypassed: bypassed };
        return next;
      }
    }
  }
  next.push({ key, from: line.from, text, final: line.final, engineBypassed: bypassed });
  return next;
}

/**
 * The marker on a line the bot answered without its engine.
 *
 * Shown rather than hidden: a silent swap to a weaker answer is worse than a
 * visible one, because the user cannot otherwise tell "my bot answered" from
 * "the voice model answered because my bot was unreachable".
 */
export function stsBypassMarker(line: StsLineView): string {
  return line.engineBypassed ? " (answered without the bot's engine)" : "";
}

/** One transcript line as the call shows it, bypass marked rather than hidden. */
export function stsLineText(line: StsLineView): string {
  const spoken = line.from === "bot" ? line.text : `You: ${line.text}`;
  return `${spoken}${stsBypassMarker(line)}`;
}

// ── the bot's engine, as a tool ──────────────────────────────────────────

/** What the model is told `bot_engine` does. */
export const BOT_ENGINE_DESCRIPTION =
  "Run the bot's own coding engine and return its answer.  Use it for real work: " +
  "reading or changing files, running commands, checking a build, or anything you " +
  "would otherwise have to guess at.  It is slower than you expect, so say one " +
  "short line before calling it.";

export const BOT_ENGINE_PARAMETERS = {
  type: "object",
  properties: {
    task: {
      type: "string",
      description: "What the engine should do, in one or two sentences.",
    },
    context: {
      type: "string",
      description: "Optional extra detail: paths, names, errors, constraints.",
    },
  },
  required: ["task"],
  additionalProperties: false,
} as const;

/** What the model is allowed to send the tool, after parsing. */
export interface EngineToolCall {
  task?: string;
  context?: string;
}

/** A turn runner, in the tool's own vocabulary rather than the wire's. */
export type EngineToolRunner = (call: EngineToolCall, signal: AbortSignal) => Promise<string>;

/**
 * Tool arguments as they arrive: an open JSON object the engine owns.
 *
 * The same shape the frozen providers decode to before handing arguments over,
 * so this adapter is handed exactly what they were handed.
 */
const engineToolArguments = z.looseObject({});

const engineToolCallSchema = z.object({
  task: z.string().optional(),
  context: z.string().optional(),
});

/**
 * Decode what the model sent the tool.
 *
 * The provider hands the arguments over as they arrived on the wire, so this is
 * the boundary where they become something a turn can be built from.  A call
 * that does not match is empty rather than half-parsed: the model still gets a
 * turn, and it is the model that omitted the task.
 */
export function parseEngineToolCall(input: z.input<typeof engineToolArguments>): EngineToolCall {
  const parsed = engineToolCallSchema.safeParse(input);
  return parsed.success ? parsed.data : {};
}

/**
 * Wrap a turn runner as the tool the providers advertise.
 *
 * The decode happens here rather than in the runner, so every runner receives
 * the tool's own vocabulary and the wire shape stops at this boundary.
 */
export function createStsBotEngine(run: EngineToolRunner): StsBotEngine {
  return {
    name: BOT_ENGINE_TOOL,
    description: BOT_ENGINE_DESCRIPTION,
    parameters: BOT_ENGINE_PARAMETERS,
    run: (raw, signal) => run(parseEngineToolCall(raw), signal),
  };
}

/** The turn text for one tool call, built from the arguments the model sent. */
export function enginePrompt(call: EngineToolCall): string {
  const task = call.task?.trim();
  const context = call.context?.trim();
  const head = task || "Work on what the caller asked.";
  return context ? `${head}\n\nContext from the caller: ${context}` : head;
}

// ── waiting for the engine's reply ───────────────────────────────────────

export interface EngineTurnMessage {
  id: string;
  role?: string;
  kind?: string;
  text?: string | null;
}

export interface EngineTurnWaiter {
  /**
   * Start waiting for the reply to a turn that is about to be dispatched.
   * `before` is the set of message ids already on screen.
   */
  arm(before: ReadonlySet<string>, signal: AbortSignal): Promise<string>;
  /** Feed the current messages; settles the wait when the reply lands. */
  observe(messages: readonly EngineTurnMessage[]): void;
  /** Give up on the wait and reject it. */
  cancel(): void;
}

/**
 * Resolve a bot turn's reply text.
 *
 * A tool call has to answer inside the deadline, so it cannot watch React state
 * itself: it arms, dispatches, and this — driven from the call view's existing
 * message effect — settles when the first new bot text message appears.  A turn
 * that ends without one leaves the promise unsettled, which is deliberate: the
 * provider's own deadline then fires, `callBotEngine` records the bypass, and
 * the model answers that turn instead.
 */
export function createEngineTurnWaiter(): EngineTurnWaiter {
  interface Token {
    before: ReadonlySet<string>;
    resolve: (text: string) => void;
    reject: (error: Error) => void;
    detach: () => void;
  }
  let pending: Token | null = null;

  const clear = () => {
    const live = pending;
    pending = null;
    live?.detach();
  };

  return {
    arm(before, signal) {
      clear();
      return new Promise<string>((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error("The call ended before the engine turn started."));
          return;
        }
        const onAbort = () => {
          if (pending !== token) return;
          clear();
          reject(new Error("The call ended before the engine answered."));
        };
        const token: Token = { before, resolve, reject, detach: () => signal.removeEventListener("abort", onAbort) };
        pending = token;
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },
    observe(messages) {
      const live = pending;
      if (!live) return;
      for (const message of messages) {
        if (live.before.has(message.id)) continue;
        if (message.role !== "bot" || message.kind !== "text") continue;
        const text = message.text?.trim();
        if (!text) continue;
        clear();
        live.resolve(text);
        return;
      }
    },
    cancel() {
      const live = pending;
      if (!live) return;
      clear();
      live.reject(new Error("The engine turn was cancelled."));
    },
  };
}

/** What the model is told it is, spoken as a system prompt. */
export function composeCallPersona(bot: {
  name: string;
  title?: string;
  description?: string;
}): string {
  const parts = [`You are ${bot.name}, a BotFleet bot on a live voice call.`];
  const title = bot.title?.trim();
  const description = bot.description?.trim();
  if (title) parts.push(title);
  if (description) parts.push(description);
  parts.push(
    "You are speaking out loud with one person, not writing.  Keep replies short " +
      "and conversational unless they ask for detail, and never read code aloud.",
  );
  return parts.join(" ");
}