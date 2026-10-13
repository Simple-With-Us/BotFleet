// xAI realtime speech-to-speech for a voice call.
//
// One duplex socket replaces the chained capture/understand/speak loop: audio
// goes up as PCM16, audio and transcript come back down, and the model may call
// the bot's own engine as a function tool.  The wire protocol is
// OpenAI-Realtime-compatible, so the event names below are the OpenAI ones.
//
// The permanent API key never comes near this file.  The socket is opened with
// a short-lived ephemeral token minted over the Electron bridge, which keeps the
// credential in the harness where it belongs.
//
// Two things are handled here rather than by the caller because they are
// protocol requirements, not UX choices:
//
//  * Barge-in.  When the user speaks over the bot, playback is cancelled
//    locally and the session is told to drop the audio the user never heard
//    (`conversation.item.truncate`, carrying the played duration).  Without the
//    truncate the model keeps generating the tail of an utterance the user cut
//    off, and the bot talks over itself for the rest of the turn.
//  * Engine degradation.  The engine is slower than the model expects, so every
//    call runs under a deadline; on timeout or rejection the session survives
//    and the model is told, via a session instructions update, to answer that
//    turn itself.  The transcript line carries engineBypassed so the call view
//    shows the weaker answer instead of inventing one.

import { z } from "zod";

import {
  BOT_ENGINE_TOOL,
  DEFAULT_ENGINE_TIMEOUT_MS,
  ENGINE_BYPASS_INSTRUCTION,
  ENGINE_PREAMBLE_INSTRUCTION,
  type StsBotEngine,
  type StsSession,
  type StsStartOptions,
  type StsTranscriptLine,
} from "./types";

const XAI_REALTIME_ENDPOINT = "wss://api.x.ai/v1/realtime";
const XAI_REALTIME_MODEL = "grok-voice-latest";
/** How long the handshake may take before the call view is told it failed. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Vendor events are parsed loosely: an event we do not model must not fail the
 * whole frame, and a field we care about must still be validated before use.
 */
const realtimeEventSchema = z.looseObject({
  type: z.string(),
  item_id: z.string().optional(),
  call_id: z.string().optional(),
  name: z.string().optional(),
  arguments: z.string().optional(),
  delta: z.string().optional(),
  transcript: z.string().optional(),
  audio: z.string().optional(),
  error: z.looseObject({
    message: z.string().optional(),
    type: z.string().optional(),
  }).optional(),
  item: z.looseObject({
    id: z.string().optional(),
  }).optional(),
});

/** Tool arguments are a JSON object whose fields the engine owns. */
const toolArgumentsSchema = z.looseObject({});

/** An outbound protocol frame: the wire shape is open-ended by design. */
type RealtimeFrame = z.infer<ReturnType<typeof buildFrameSchema>>;

const buildFrameSchema = () => z.looseObject({ type: z.string() });

/**
 * Decode a JSON body against a schema.  Both halves of the protocol are
 * untrusted, so a malformed body and a well-formed body of the wrong shape
 * both land on null rather than on an exception in the message handler.
 */
function parseJson<S extends z.ZodType>(schema: S, raw: string): z.output<S> | null {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    console.warn("parseJson: vendor frame was not JSON", { error });
    return null;
  }
  const result = schema.safeParse(parsedJson);
  if (!result.success) {
    console.warn("parseJson: vendor frame failed schema", { issues: result.error.issues });
    return null;
  }
  return result.data;
}

type XaiStsBridge = {
  xaiToken(): Promise<{ token: string; expiresInSeconds: number }>;
};

/**
 * The bridge call that mints the ephemeral token.  Returned bound to the bridge
 * so the caller never has to know the shape, and optional: a build without the
 * STS bridge must fail with a clear message at start() rather than a TypeError
 * deep in the handshake.
 */
function xaiTokenMint(): XaiStsBridge["xaiToken"] | undefined {
  const bridge = globalThis.window?.ogb;
  if (!bridge) return undefined;
  // SAFETY: the preload owns the bridge's declared shape; this provider reads
  // the one member it needs through a narrow local type, so a preload that
  // lacks it yields undefined instead of a TypeError at call time.
  const sts = (bridge as { sts?: Partial<XaiStsBridge> }).sts;
  return sts?.xaiToken?.bind(sts);
}

function encodeBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!);
  }
  return btoa(binary);
}

function decodeBase64(value: string): ArrayBuffer | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  } catch {
    return null;
  }
}

/** One decoded delta waiting on the speaker. */
interface QueuedAudio {
  source: AudioBufferSourceNode;
  durationMs: number;
  /** AudioContext time this chunk starts playing. */
  startAt: number;
}

/**
 * Playback for the bot's own audio.
 *
 * The session owns playback rather than the call view because interruption
 * needs the played duration: the truncate event tells the model how much of its
 * audio the user actually heard, and only the thing doing the playing knows
 * that.
 */
class XaiAudioOutbox {
  private context: AudioContext | null = null;
  private queue: QueuedAudio[] = [];
  private nextStartAt = 0;
  /** Decoding is async, so appends are chained to preserve vendor order. */
  private chain: Promise<void> = Promise.resolve();

  async append(itemId: string, bytes: ArrayBuffer): Promise<void> {
    this.chain = this.chain.then(async () => {
      const context = this.ensureContext();
      if (!context) return;
      const buffer = await context.decodeAudioData(bytes).catch(() => null);
      if (!buffer || buffer.duration <= 0) return;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const startAt = Math.max(this.nextStartAt, context.currentTime);
      source.start(startAt);
      this.nextStartAt = startAt + buffer.duration;
      this.queue.push({
        source,
        durationMs: buffer.duration * 1000,
        startAt,
      });
      this.reap();
      // A delta for a previous item can land after the user barged in; dropping
      // it is what makes the interrupt stick.
      if (this.queue.length > 64) this.stopPlayback();
      void itemId;
    });
    await this.chain;
  }

  /**
   * Milliseconds of the bot's audio the listener actually heard, counting a
   * partially played chunk up to the current position.
   */
  playedMs(): number {
    const context = this.context;
    if (!context) return 0;
    let played = 0;
    for (const chunk of this.queue) {
      if (context.currentTime >= chunk.startAt + chunk.durationMs / 1000) {
        played += chunk.durationMs;
      } else if (context.currentTime > chunk.startAt) {
        played += (context.currentTime - chunk.startAt) * 1000;
        break;
      } else {
        break;
      }
    }
    return Math.max(0, Math.round(played));
  }

  /** Cancel playback now and discard everything still queued. */
  stopPlayback(): void {
    for (const chunk of this.queue) {
      try {
        chunk.source.stop();
      } catch {
        // Already finished or never started; nothing to cancel.
      }
      chunk.source.disconnect();
    }
    this.queue = [];
    if (this.context) this.nextStartAt = this.context.currentTime;
  }

  /** Drop finished chunks so a long call does not grow the queue forever. */
  private reap(): void {
    const context = this.context;
    if (!context) return;
    this.queue = this.queue.filter(
      (chunk) => context.currentTime < chunk.startAt + chunk.durationMs / 1000,
    );
  }

  private ensureContext(): AudioContext | null {
    if (this.context) return this.context;
    try {
      // SAFETY: an AudioContext is missing when the build has no output device
      // or autoplay policy blocks it; the constructor throws in both cases and
      // the caller degrades to a session with no playback.
      this.context = new AudioContext();
      if (this.context.state === "suspended") void this.context.resume();
      return this.context;
    } catch {
      // No output device, or the context is blocked by autoplay policy.
      return null;
    }
  }

  reset(): void {
    this.stopPlayback();
    this.chain = Promise.resolve();
    const context = this.context;
    this.context = null;
    this.nextStartAt = 0;
    if (context) void context.close().catch(() => {});
  }
}

export function createXaiStsSession(): StsSession {
  const lineListeners = new Set<(line: StsTranscriptLine) => void>();
  const errorListeners = new Set<(error: Error) => void>();
  const closedListeners = new Set<(reason: string) => void>();

  const audio = new XaiAudioOutbox();
  /** Engine calls still awaiting a reply, so stop() can abort them. */
  const inflight = new Map<string, AbortController>();
  /** Tool calls already answered; a replayed event must not run the engine twice. */
  const handledCalls = new Set<string>();

  let socket: WebSocket | null = null;
  let handshake: { resolve: () => void; reject: (error: Error) => void } | null = null;
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let starting = false;
  let stopped = false;
  /** Bumped by every start/stop so late work from an old socket stays quiet. */
  let generation = 0;

  let engine: StsBotEngine | undefined;
  let engineTimeoutMs = DEFAULT_ENGINE_TIMEOUT_MS;
  /** The persona as given, before the engine preamble / bypass clauses. */
  let persona = "";
  let engineUnavailable = false;
  /** Item id of the response being received, for the interrupt truncate. */
  let currentItemId = "";
  /** Bot transcript held until the turn resolves, so a tool-call preamble can
   *  be emitted as its own line rather than as a stream of partials. */
  let botText = "";
  let userText = "";
  /** Set when the engine could not be reached; marks the next bot line. */
  let bypassNextLine = false;

  const emitLine = (line: StsTranscriptLine) => {
    for (const cb of lineListeners) cb(line);
  };

  const emitError = (message: string) => {
    const error = new Error(message);
    for (const cb of errorListeners) cb(error);
  };

  const emitClosed = (reason: string) => {
    for (const cb of closedListeners) cb(reason);
  };

  const send = (payload: RealtimeFrame): boolean => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  };

  const composedInstructions = (): string => {
    const sections = [persona.trim(), ENGINE_PREAMBLE_INSTRUCTION];
    if (engineUnavailable) sections.push(ENGINE_BYPASS_INSTRUCTION);
    return sections.filter((section) => section.length > 0).join("\n\n");
  };

  const pushInstructions = () => {
    send({ type: "session.update", session: { instructions: composedInstructions() } });
  };

  const teardown = (closedReason: string | null) => {
    if (stopped) return;
    stopped = true;
    started = false;
    generation += 1;
    if (handshakeTimer) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
    const pending = handshake;
    handshake = null;
    if (pending) pending.reject(new Error("The xAI speech session was stopped before it was ready."));
    for (const controller of inflight.values()) controller.abort();
    inflight.clear();
    handledCalls.clear();
    audio.reset();
    currentItemId = "";
    botText = "";
    userText = "";
    bypassNextLine = false;
    engine = undefined;
    const live = socket;
    if (live && live.readyState !== WebSocket.CLOSED) {
      // Best-effort courtesy cancel; the socket close is what ends the call.
      if (live.readyState === WebSocket.OPEN) {
        try {
          live.send(JSON.stringify({ type: "response.cancel" }));
        } catch {
          // The socket died between the check and the send; closing is enough.
        }
      }
      live.close();
    }
    socket = null;
    if (closedReason) emitClosed(closedReason);
  };

  const flushBotLine = () => {
    const text = botText.trim();
    botText = "";
    if (!text) return;
    const line: StsTranscriptLine = { text, from: "bot", final: true };
    if (bypassNextLine) {
      line.engineBypassed = true;
      bypassNextLine = false;
    }
    emitLine(line);
  };

  /**
   * The engine could not answer.  The session survives: the model is told, in
   * its instructions, to answer this turn itself, and the line it produces is
   * marked so the transcript shows the degradation.
   */
  const bypassEngine = (callId: string, reason: string) => {
    const changed = !engineUnavailable;
    engineUnavailable = true;
    if (changed) pushInstructions();
    bypassNextLine = true;
    // The item still needs an output or the response stalls waiting on it; the
    // text agrees with the instructions update rather than contradicting it.
    send({
      type: "response.function_call_output",
      call_id: callId,
      output: `${ENGINE_BYPASS_INSTRUCTION} (${reason})`,
    });
  };

  const runEngine = (callId: string, name: string, rawArguments: string) => {
    const bot = engine;
    if (!bot) {
      // No engine was advertised, so this call is a surprise; answer it the
      // same way a failed engine is answered rather than stall the item.
      bypassEngine(callId, "no engine configured");
      return;
    }
    if (name && name !== bot.name) {
      // A tool this session never offered. Answer it so the turn can proceed
      // instead of stalling on an item nobody will ever resolve.
      send({
        type: "response.function_call_output",
        call_id: callId,
        output: `Unknown tool: ${name}.`,
      });
      return;
    }
    // Tool arguments arrive as a JSON string of unknown shape; zod keeps the
    // narrowing at this boundary instead of asserting a dictionary. A
    // malformed body becomes an empty object, which the engine can refuse.
    const input = parseJson(toolArgumentsSchema, rawArguments || "{}") ?? {};
    const controller = new AbortController();
    inflight.set(callId, controller);
    const mine = generation;
    const timer = setTimeout(() => {
      controller.abort(new Error(`The bot's engine did not answer within ${engineTimeoutMs}ms.`));
    }, engineTimeoutMs);
    void (async () => {
      try {
        const reply = await bot.run(input, controller.signal);
        if (generation !== mine) return;
        if (engineUnavailable) {
          engineUnavailable = false;
          pushInstructions();
        }
        send({ type: "response.function_call_output", call_id: callId, output: reply });
      } catch (error) {
        if (generation !== mine) return;
        // A rejection reason is an Error from our own deadline, or whatever
        // the engine threw; both render usefully.
        const reason = error instanceof Error ? error.message : String(error);
        bypassEngine(callId, reason);
      } finally {
        clearTimeout(timer);
        inflight.delete(callId);
      }
    })();
  };

  const interrupt = () => {
    // (a) stop the speaker before anything else, so the tail of the bot's reply
    //     is not audible while the model catches up.
    const played = audio.playedMs();
    audio.stopPlayback();
    // The truncated utterance never finished, so its transcript would be a
    // sentence the user did not hear.
    botText = "";
    if (currentItemId) {
      // (b) drop the unplayed tail server-side. Without this the model goes on
      //     speaking a turn the user already interrupted.
      send({
        type: "conversation.item.truncate",
        item_id: currentItemId,
        content_index: 0,
        audio_end_ms: played,
      });
    }
    send({ type: "response.cancel" });
  };

  const onMessage = (raw: string, live: () => boolean) => {
    // A frame this protocol does not speak, or a body that is not JSON at all,
    // is dropped by the schema instead of failing the call.
    const event = parseJson(realtimeEventSchema, raw);
    if (!event) return;
    if (event.type === "error" || event.type === "session.error") {
      const detail = event.error?.message ?? event.error?.type ?? "unknown error";
      if (!live()) return;
      emitError(`xAI reported: ${detail}`);
      if (handshake) {
        const pending = handshake;
        handshake = null;
        if (handshakeTimer) clearTimeout(handshakeTimer);
        handshakeTimer = null;
        pending.reject(new Error(`xAI rejected the session: ${detail}`));
      }
      return;
    }
    if (event.type === "session.closed" || event.type === "session.expired" ||
        event.type === "session.go_away") {
      if (!live()) return;
      emitClosed(event.type === "session.expired" ? "The xAI session expired." : "The xAI session ended.");
      teardown("vendor-closed");
      return;
    }
    if (!live()) return;
    switch (event.type) {
      case "session.updated": {
        // The vendor's ack of our session config: this is "ready".
        if (!handshake) return;
        const pending = handshake;
        handshake = null;
        if (handshakeTimer) clearTimeout(handshakeTimer);
        handshakeTimer = null;
        pending.resolve();
        return;
      }
      case "response.output_item.added": {
        if (event.item?.id) currentItemId = event.item.id;
        return;
      }
      case "response.audio.delta":
      case "response.output_audio.delta": {
        if (event.item_id) currentItemId = event.item_id;
        if (!event.audio) return;
        const bytes = decodeBase64(event.audio);
        if (!bytes) return;
        void audio.append(currentItemId, bytes);
        return;
      }
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta": {
        if (event.delta) botText += event.delta;
        return;
      }
      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done": {
        botText = event.transcript ?? botText;
        flushBotLine();
        return;
      }
      case "response.done": {
        flushBotLine();
        currentItemId = "";
        return;
      }
      case "input_audio_buffer.speech_started": {
        interrupt();
        return;
      }
      case "conversation.item.input_audio_transcription.delta": {
        if (!event.delta) return;
        userText += event.delta;
        emitLine({ text: userText.trim(), from: "user", final: false });
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const text = (event.transcript ?? userText).trim();
        userText = "";
        if (text) emitLine({ text, from: "user", final: true });
        return;
      }
      case "response.function_call_arguments.done": {
        const callId = event.call_id;
        if (!callId || handledCalls.has(callId)) return;
        handledCalls.add(callId);
        // Any preamble the model sent before the call is its own line.
        flushBotLine();
        runEngine(callId, event.name ?? BOT_ENGINE_TOOL, event.arguments ?? "{}");
        return;
      }
      default:
        return;
    }
  };

  return {
    provider: "xai",

    async start(opts: StsStartOptions) {
      if (started || starting) {
        throw new Error("This xAI speech session is already started.");
      }
      starting = true;
      stopped = false;
      const mint = xaiTokenMint();
      if (!mint) {
        starting = false;
        throw new Error("The xAI speech bridge is unavailable in this build.");
      }
      engine = opts.botEngine;
      engineTimeoutMs = opts.engineTimeoutMs ?? DEFAULT_ENGINE_TIMEOUT_MS;
      persona = opts.instructions;
      engineUnavailable = false;
      bypassNextLine = false;
      botText = "";
      userText = "";
      currentItemId = "";
      const mine = ++generation;
      const live = () => generation === mine && !stopped;
      let token: string;
      try {
        // Only the ephemeral token crosses into the renderer.
        ({ token } = await mint());
      } catch (error) {
        starting = false;
        // The bridge rejects with a plain Error carrying the harness message.
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not mint an xAI session token: ${reason}`);
      }
      if (!live()) return;
      if (!token) {
        starting = false;
        throw new Error("The xAI bridge returned an empty session token.");
      }
      const url = new URL(XAI_REALTIME_ENDPOINT);
      url.searchParams.set("model", XAI_REALTIME_MODEL);
      const ws = new WebSocket(url.toString());
      socket = ws;
      const ready = new Promise<void>((resolve, reject) => {
        handshake = { resolve, reject };
      });
      handshakeTimer = setTimeout(() => {
        handshakeTimer = null;
        const pending = handshake;
        handshake = null;
        pending?.reject(new Error("xAI took too long to confirm the speech session."));
      }, HANDSHAKE_TIMEOUT_MS);

      ws.addEventListener("open", () => {
        if (!live()) return;
        const tools = engine
          ? [{
              type: "function",
              name: engine.name,
              description: engine.description,
              parameters: engine.parameters,
            }]
          : [];
        // opts.language is not sent: the realtime endpoint has no documented
        // language hint, and it picks the voice from the model's own setting.
        send({
          type: "session.update",
          session: {
            instructions: composedInstructions(),
            tools,
            turn_detection: { type: "server_vad" },
          },
        });
      });
      // SAFETY: the provider only ever receives text frames, and each handler
      // String()s anything else, so a stray binary frame is skipped downstream.
      ws.addEventListener("message", (event) => onMessage(String(event.data), live));
      ws.addEventListener("error", () => {
        if (!live()) return;
        emitError("The xAI speech connection failed.");
        if (handshake) {
          const pending = handshake;
          handshake = null;
          if (handshakeTimer) clearTimeout(handshakeTimer);
          handshakeTimer = null;
          pending.reject(new Error("Could not open the xAI speech session."));
        }
      });
      ws.addEventListener("close", () => {
        // An unexpected close is a disconnect, not a clean end: the call view
        // has to hear about it. A close after stop() is ours and stays quiet.
        if (stopped || !live()) return;
        const pending = handshake;
        handshake = null;
        if (handshakeTimer) clearTimeout(handshakeTimer);
        handshakeTimer = null;
        pending?.reject(new Error("The xAI speech session closed before it was ready."));
        emitError("The xAI speech session disconnected.");
      });

      starting = false;
      try {
        await ready;
      } catch (error) {
        teardown(null);
        throw error;
      }
      if (!live()) {
        teardown(null);
        return;
      }
      started = true;
    },

    sendAudio(pcm) {
      if (!pcm || pcm.byteLength === 0) return;
      if (!started) return;
      if (send({ type: "input_audio_buffer.append", audio: encodeBase64(pcm) })) return;
      // The transport is gone; audio cannot be delivered, so end the session
      // rather than throw into the capture loop.
      teardown(null);
    },

    async stop() {
      teardown(null);
    },

    onLine(fn) {
      lineListeners.add(fn);
      return () => lineListeners.delete(fn);
    },

    onError(fn) {
      errorListeners.add(fn);
      return () => errorListeners.delete(fn);
    },

    onClosed(fn) {
      closedListeners.add(fn);
      return () => closedListeners.delete(fn);
    },
  };
}