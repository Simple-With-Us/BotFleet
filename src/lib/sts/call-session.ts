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
//  * How a permission is answered out loud.  On a speech-to-speech call the
//    user's speech reaches the model, not the app, so there is no second
//    dictation channel to route "yes" through: the chained path's spoken answer
//    cannot exist here.  The same tool therefore carries the approval — the
//    model learns one is waiting, reads the request out loud, and hands the
//    user's own words back for the app to map.  The app decides, never the
//    model, and it decides with the same anchored rules the chained path uses.
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
    approval: {
      type: "object",
      description:
        "A permission the caller has to give, instead of engine work. Use " +
        '"check" to see what is waiting, "ask" to get the exact sentence to read ' +
        'aloud, and "decide" to hand back the caller\'s own answer.',
      properties: {
        action: {
          type: "string",
          enum: ["check", "ask", "decide"],
          description: "Which half of the exchange this call is.",
        },
        requestId: {
          type: "string",
          description: "Which request. Left out, it means the oldest waiting one.",
        },
        answer: {
          type: "string",
          description:
            'For "decide" only: the words the caller actually said. You do not ' +
            "interpret them; the app decides what they mean.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  // Deliberately nothing required. An approval call carries no task, and
  // requiring one would hand the engine a sentence the model invented only to
  // satisfy the schema.
  required: [],
  additionalProperties: false,
} as const;

/** What the model is allowed to send the tool, after parsing. */
export interface EngineToolCall {
  task?: string;
  context?: string;
  approval?: StsApprovalCall;
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

// Both strip.  These decode what a language model sent us, and the contract is
// that only the fields named here reach the turn: an unexpected key is dropped
// rather than carried into text the bot would read back as though the caller had
// asked for it.  Strip rather than strict because strict refuses the whole call
// over a stray key, and rather than passthrough because that keeps the very
// fields this adapter exists to drop.  Stated explicitly so the intent is not
// read as an accident of the default.
const approvalCallSchema = z
  .object({
    action: z.enum(["check", "ask", "decide"]).optional(),
    requestId: z.string().optional(),
    answer: z.string().optional(),
  })
  .strip();

const engineToolCallSchema = z
  .object({
    task: z.string().optional(),
    context: z.string().optional(),
    approval: approvalCallSchema.optional(),
  })
  .strip();

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

// ── a permission, answered out loud ──────────────────────────────────────
//
// The rule this encodes, unchanged from the chained path: an approval is the
// user's decision, not the model's.  The model may carry the user's words back
// and nothing else.  It never chooses an outcome, never paraphrases an answer
// into one, and an answer that cannot be read unambiguously approves nothing.
// The word "always allow" is deliberately unreachable from here: that grant is
// durable, and a voice decision must not be able to create one.

/** Spoken answers to a permission card. Anything else is read as a reply to
 * the bot, not as consent — an approval must never be granted by a sentence
 * that merely contained the word "sure". */
const YES = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|allow|approve|approved|fine|please do)\b/i;
const NO = /^(no|nope|don'?t|do not|stop|deny|denied|cancel|never|skip it)\b/i;

/** How a spoken answer was understood. "unclear" is the safe default: the
 * request stays open and nothing was decided. */
export type SpokenApproval = "allow" | "deny" | "unclear";

/**
 * Read a spoken answer as a decision.
 *
 * Anchored at the start of the utterance, so only an answer that *is* a yes or
 * a no counts.  "I'm not sure" contains "sure" and is not consent; "no" wins
 * over nothing because the two patterns cannot both match.
 */
export function spokenApprovalDecision(answer: string | undefined): SpokenApproval {
  const said = answer?.trim() ?? "";
  if (YES.test(said)) return "allow";
  if (NO.test(said)) return "deny";
  return "unclear";
}

/** The denial note a spoken "no" records. Shared with the chained path so a
 * voice denial and a clicked denial leave the same audit record. */
export const VOICE_DENIAL_MESSAGE = "Denied by the user, on a call.";

/**
 * A permission the app is holding, in the shape this file reasons about.
 *
 * Built by the call view from the same pending list the card renders, so the
 * thing the model is told out loud and the thing on screen are one request.
 * `prompt` is the sentence the shared prompt builder already produces for the
 * chained path: the model reads it rather than inventing its own summary of
 * what is being asked.
 */
export interface StsApprovalView {
  requestId: string;
  /** The provider-authored tool name, for the model's own bookkeeping. */
  tool: string;
  /** A routine confirmation rather than a tool approval. */
  routine: boolean;
  /** The card's message id, so a voice decision can name what it answered. */
  messageId: string;
  prompt: string;
}

/** Which half of the exchange the model is calling for. */
export type StsApprovalAction = "check" | "ask" | "decide";

export interface StsApprovalCall {
  action?: StsApprovalAction;
  requestId?: string;
  answer?: string;
}

interface StsApprovalText {
  /** What the model is told, and may read aloud. */
  text: string;
}

export type StsApprovalOutcome =
  | (StsApprovalText & { kind: "status" })
  | (StsApprovalText & { kind: "ask"; requestId: string })
  | (StsApprovalText & { kind: "unclear"; requestId: string })
  | (StsApprovalText & { kind: "stale" })
  | { kind: "decided"; requestId: string; decision: "allow" | "deny" };

/** Requests this call has already submitted, however they were answered. */
export type StsDecided = ReadonlySet<string>;

/**
 * What the model is told when it names a request that is no longer waiting.
 *
 * Reachable and harmless: the model can be a turn behind, the card can be
 * clicked on another device, or the call can outlive the request.  Nothing is
 * submitted, because a decision for a request that is gone cannot be undone.
 */
export function staleApprovalText(): string {
  return (
    "That request is no longer waiting for permission, so nothing was submitted.  " +
    "Do not answer it again.  If the work is still needed, call the engine for it."
  );
}

/** Requests still open, oldest first — the one the card is showing is first. */
function waitingApprovals(pending: readonly StsApprovalView[], decided: StsDecided): StsApprovalView[] {
  return pending.filter((approval) => !decided.has(approval.requestId));
}

/**
 * The request an action names.
 *
 * A named request that is not waiting resolves to nothing rather than to the
 * oldest one: falling back would let the model answer a different permission
 * than the one it read out.  No name at all means the oldest, which is what the
 * chained path asks about and what the card is showing.
 */
function targetApproval(
  waiting: readonly StsApprovalView[],
  requestId: string | undefined,
): StsApprovalView | undefined {
  if (!requestId) return waiting[0];
  return waiting.find((approval) => approval.requestId === requestId);
}

function statusText(waiting: readonly StsApprovalView[]): string {
  if (!waiting.length) {
    return "Nothing is waiting for permission right now.  Carry on with the call.";
  }
  const lines = waiting.map(
    (approval, index) => `${index + 1}. ${approval.prompt}  Request id: ${approval.requestId}.`,
  );
  return [
    waiting.length === 1
      ? "One request is waiting for permission."
      : `${waiting.length} requests are waiting for permission, oldest first.`,
    ...lines,
    `Ask for them one at a time, oldest first, and call \`${BOT_ENGINE_TOOL}\` again with the answer.`,
  ].join("\n");
}

function askText(approval: StsApprovalView): string {
  return (
    `Read this to the caller word for word, then wait for their answer:\n${approval.prompt}\n` +
    `When they answer, call \`${BOT_ENGINE_TOOL}\` again with approval action "decide", ` +
    `request id ${approval.requestId}, and their exact words as the answer.  Never answer it for them.`
  );
}

function unclearText(approval: StsApprovalView): string {
  return (
    "That was not a clear yes or no, so nothing was submitted and this request is still waiting.  " +
    `Ask the caller again, and tell them the approval for ${approval.tool} is also on screen if they ` +
    "would rather press the buttons."
  );
}

/**
 * Decide what an approval action means.
 *
 * Pure, and the whole of the policy: it is the only place that can answer a
 * request, so a decision the app cannot read unambiguously comes back as
 * "unclear" with nothing to submit.  Anything unrecognised — a missing action, a
 * request that is gone — degrades to the read-only status rather than guessing.
 */
export function resolveStsApproval(
  request: StsApprovalCall,
  pending: readonly StsApprovalView[],
  decided: StsDecided,
): StsApprovalOutcome {
  const waiting = waitingApprovals(pending, decided);
  const action = request.action;

  if (action === "decide") {
    const target = targetApproval(waiting, request.requestId);
    if (!target) return { kind: "stale", text: staleApprovalText() };
    const decision = spokenApprovalDecision(request.answer);
    if (decision === "unclear") return { kind: "unclear", requestId: target.requestId, text: unclearText(target) };
    return { kind: "decided", requestId: target.requestId, decision };
  }

  if (action === "ask") {
    const target = targetApproval(waiting, request.requestId);
    if (!target) return { kind: "stale", text: staleApprovalText() };
    return { kind: "ask", requestId: target.requestId, text: askText(target) };
  }

  // "check", and anything the model made up: reading what is waiting can
  // never submit anything, so an unrecognised action is safe to answer.
  return { kind: "status", text: statusText(waiting) };
}

/**
 * The clause that tells the model how to ask out loud and carry the answer
 * back.
 *
 * Appended to the composed instructions by the caller rather than written into
 * `composeStsInstructions`, which is frozen and has no place for it: the persona
 * it composes is the first section, so a clause added there would sit above the
 * tool it talks about.  Last in the instructions is where the model reads a
 * rule best, and appending leaves that function untouched.
 */
export function stsApprovalInstructions(): string {
  return [
    "Permissions can stop you mid-turn.  When the engine asks for one, the tool result says what " +
      "is being asked and gives you its request id.",
    "Ask for it out loud: read the request to the caller word for word, wait for their answer, then " +
      `call \`${BOT_ENGINE_TOOL}\` again with approval action "decide", that request id, and their ` +
      "exact words as the answer.",
    "The caller decides, not you.  Pass on what they actually said and let the app read it.  Never " +
      "approve anything yourself, never invent an answer, and never treat silence, a guess, or an " +
      "unclear reply as a yes: anything you cannot pass on verbatim approves nothing.",
    "The approval also stays on screen as a card, so answering out loud and pressing the card are " +
      "the same decision, recorded the same way.",
    `If a turn did not tell you one is waiting, or the caller asks why you stopped, call ` +
      `\`${BOT_ENGINE_TOOL}\` with approval action "check" before you answer.`,
  ].join("\n\n");
}

// ── waiting for the engine's reply ───────────────────────────────────────

export interface EngineTurnMessage {
  id: string;
  role?: string;
  kind?: string;
  text?: string | null;
  /** Just enough of a permission card to tell a waiting request from a
   *  resolved or dismissed one. */
  card?: {
    requestId?: string;
    tool?: string;
    answered?: string;
    dismissed?: boolean;
  };
}

/**
 * How an engine turn ended.
 *
 * `approval` is not a failure: the engine is waiting on the user, which is the
 * one thing this call cannot answer for itself.  It is reported as its own
 * outcome so the model can ask out loud, rather than as silence the deadline
 * would eventually turn into a bypass.
 */
export type EngineTurnResult =
  | { kind: "reply"; text: string }
  | { kind: "approval"; requestId: string }
  | { kind: "failed"; text: string };

export interface EngineTurnWaiter {
  /**
   * Start waiting for the reply to a turn that is about to be dispatched.
   * `before` is the set of message ids already on screen.
   */
  arm(before: ReadonlySet<string>, signal: AbortSignal): Promise<EngineTurnResult>;
  /** Feed the current messages; settles the wait when the reply lands. */
  observe(messages: readonly EngineTurnMessage[]): void;
  /**
   * Settle an armed wait with something the caller already knows — a decision
   * that could not be saved, say.  Resolves rather than rejects because the
   * engine did run: the model should hear what happened, not be handed a
   * bypass it cannot explain.
   */
  note(text: string): void;
  /** Give up on the wait and reject it. */
  cancel(): void;
}

/**
 * Resolve a bot turn's outcome.
 *
 * A tool call has to answer inside the deadline, so it cannot watch React state
 * itself: it arms, dispatches, and this — driven from the call view's existing
 * message effect — settles when a permission card or the first new bot text
 * message appears.  A turn that ends without either leaves the promise
 * unsettled, which is deliberate: the provider's own deadline then fires,
 * `callBotEngine` records the bypass, and the model answers that turn instead.
 *
 * A permission card wins over a reply in the same batch, because an open
 * request is the state that holds the turn up: reporting the reply instead
 * would send the model off believing the engine finished.
 */
export function createEngineTurnWaiter(): EngineTurnWaiter {
  interface Token {
    before: ReadonlySet<string>;
    resolve: (result: EngineTurnResult) => void;
    reject: (error: Error) => void;
    detach: () => void;
  }
  let pending: Token | null = null;

  const clear = () => {
    const live = pending;
    pending = null;
    live?.detach();
  };

  /** A request still waiting for an answer, or nothing. */
  const waitingApproval = (message: EngineTurnMessage): string | undefined => {
    if (!message.card?.requestId || !message.card.tool) return undefined;
    if (message.card.answered || message.card.dismissed) return undefined;
    return message.card.requestId;
  };

  return {
    arm(before, signal) {
      clear();
      return new Promise<EngineTurnResult>((resolve, reject) => {
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
      const fresh = messages.filter((message) => !live.before.has(message.id));

      for (const message of fresh) {
        const requestId = waitingApproval(message);
        if (!requestId) continue;
        clear();
        live.resolve({ kind: "approval", requestId });
        return;
      }

      for (const message of fresh) {
        if (message.role !== "bot" || message.kind !== "text") continue;
        const text = message.text?.trim();
        if (!text) continue;
        clear();
        live.resolve({ kind: "reply", text });
        return;
      }
    },
    note(text) {
      const live = pending;
      if (!live) return;
      clear();
      live.resolve({ kind: "failed", text });
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