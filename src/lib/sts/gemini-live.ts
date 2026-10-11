// Google Gemini Live duplex speech provider, mirroring the STTSession seam in
// call-stt.ts. One socket carries audio in and audio out: the model hears the
// caller and speaks back on the same connection, so there is no chained
// transcribe-then-synthesize loop and no turn latency between them.
//
// Credentials never reach this file. The permanent API key stays in the
// Electron main process; the renderer asks the bridge for a short-lived
// ephemeral token and connects with that. The token is minted with
// newSessionExpireTime defaulting to 60 seconds, which is why the socket is
// opened the moment the mint resolves and nothing else is awaited in between.
//
// Every handler here is written so a late async result cannot revive a session
// that has already been stopped: each start() takes a generation number and
// every callback checks it, the same way call-stt.ts invalidates a capture
// attempt that finishes after stop(). The token is never logged, never stored
// and never included in an error message, because the socket URL carries it and
// errors here reach the transcript.

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

const LIVE_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
const LIVE_MODEL = "models/gemini-3.8-live";
/** What the capture path already produces: 16 kHz mono PCM16. */
const INPUT_MIME_TYPE = "audio/pcm;rate=16000";
/** What the model speaks back at. */
const OUTPUT_SAMPLE_RATE = 24_000;
const CONNECT_TIMEOUT_MS = 10_000;
const SETUP_TIMEOUT_MS = 15_000;
/**
 * Context compression keeps a call alive past the 15 minute audio-only cap: the
 * server compacts once the window passes the trigger, keeping the most recent
 * targetTokens of history. Both numbers are vendor-side policy, not client
 * throughput, so they are tuned here rather than exposed per call.
 */
const COMPRESSION_TRIGGER_TOKENS = 30_000;
const COMPRESSION_TARGET_TOKENS = 20_000;

const serverMessageSchema = z.object({
  setupComplete: z.object({}).optional(),
  goAway: z.object({ timeLeftMs: z.number().optional() }).optional(),
  sessionResumptionUpdate: z.object({
    newSession: z.string().optional(),
    resumable: z.boolean().optional(),
    sessionResumptionToken: z.string().optional(),
  }).optional(),
  inputTranscription: z.object({ text: z.string().optional() }).optional(),
  outputTranscription: z.object({ text: z.string().optional() }).optional(),
  serverContent: z
    .object({
      interrupted: z.boolean().optional(),
      turnComplete: z.boolean().optional(),
      modelTurn: z
        .object({
          finished: z.boolean().optional(),
          parts: z
            .array(
              z.object({
                text: z.string().optional(),
                inlineData: z
                  .object({ data: z.string(), mimeType: z.string().optional() })
                  .optional(),
              }),
            )
            .optional(),
        })
        .optional(),
    })
    .optional(),
  toolCall: z
    .object({
      functionCalls: z
        .array(
          z.object({
            id: z.string().optional(),
            name: z.string().optional(),
            args: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

type GeminiServerMessage = z.infer<typeof serverMessageSchema>;
type GeminiFunctionCall = NonNullable<
  NonNullable<GeminiServerMessage["toolCall"]>["functionCalls"]
>[number];

/** Handle for resuming a dropped session instead of restarting it. */
export interface GeminiResumeHandle {
  /** Opaque session id the token belongs to. */
  sessionId?: string;
  /** Short-lived resumption token; never logged or surfaced to the transcript. */
  token: string;
}

/**
 * Build the live socket URL.  Exported for testability, like
 * buildAssemblyAIStreamingUrl: callers go through createGeminiLiveSession, which
 * mints the token and opens the socket.  The returned URL contains the token,
 * so it must never be logged.
 */
export function buildGeminiLiveUrl(token: string): string {
  return `${LIVE_ENDPOINT}?access_token=${encodeURIComponent(token)}`;
}

/** Build the setup frame — the first and only frame until setupComplete. */
export function buildGeminiSetupMessage(opts: StsStartOptions): Record<string, unknown> {
  const systemInstruction = opts.botEngine
    ? `${opts.instructions}\n\n${ENGINE_PREAMBLE_INSTRUCTION}`
    : opts.instructions;
  return {
    setup: {
      model: LIVE_MODEL,
      responseModalities: ["AUDIO"],
      systemInstruction: { parts: [{ text: systemInstruction }] },
      // The model speaks; these two make it also *write* both sides of the call
      // so the transcript exists without a second speech recognizer.
      inputTranscription: {},
      outputTranscription: {},
      // Yields SessionResumptionUpdate frames, so a dropped socket can resume
      // rather than restart a call mid-sentence.
      sessionResumption: {},
      contextWindowCompression: {
        triggerTokens: COMPRESSION_TRIGGER_TOKENS,
        slidingWindow: { targetTokens: COMPRESSION_TARGET_TOKENS },
      },
      ...(opts.botEngine
        ? {
            tools: [
              {
                functionDeclarations: [
                  {
                    name: BOT_ENGINE_TOOL,
                    description: opts.botEngine.description,
                    parameters: opts.botEngine.parameters,
                  },
                ],
              },
            ],
          }
        : {}),
    },
  };
}

/** PCM16 bytes to base64 for a realtimeInput media chunk. */
function toBase64(pcm: ArrayBuffer): string {
  const bytes = new Uint8Array(pcm);
  let binary = "";
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

/** Base64 from the server back to PCM16 bytes. */
function fromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Playback for the model's audio, which is scheduled ahead of the listener by
 * design: chunks are queued back to back so the reply does not gap between
 * frames.  That is also what makes interruption mandatory — the audio the
 * caller is talking over is often still queued, not yet heard, so stop() has to
 * cancel scheduled sources and not just mute the destination.
 */
class LivePlayback {
  private context: AudioContext | null = null;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private nextStart = 0;

  private ensureContext(): AudioContext | null {
    if (this.context) return this.context;
    // Headless and test environments have no output device; the transcript and
    // the engine still work, so audio is dropped rather than failing the call.
    if (typeof AudioContext === "undefined") return null;
    try {
      const context = new AudioContext();
      if (context.state === "suspended") void context.resume();
      this.context = context;
      return context;
    } catch {
      return null;
    }
  }

  enqueue(pcm: Uint8Array): void {
    const context = this.ensureContext();
    if (!context || pcm.byteLength < 2) return;
    const samples = new Float32Array(pcm.byteLength / 2);
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = view.getInt16(index * 2, true) / 0x8000;
    }
    try {
      const buffer = context.createBuffer(1, samples.length, OUTPUT_SAMPLE_RATE);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const at = Math.max(context.currentTime, this.nextStart);
      source.start(at);
      this.nextStart = at + buffer.duration;
      this.sources.add(source);
      source.onended = () => {
        this.sources.delete(source);
        source.disconnect();
      };
    } catch {
      // A playback hiccup must not take the call down with it.
    }
  }

  /** Drop everything queued and stop what is already scheduled. */
  stop(): void {
    for (const source of this.sources) {
      try {
        source.onended = null;
        source.stop();
        source.disconnect();
      } catch {
        // A source that already ended throws here; nothing left to cancel.
      }
    }
    this.sources.clear();
    this.nextStart = 0;
  }

  dispose(): void {
    this.stop();
    void this.context?.close().catch(() => {});
    this.context = null;
  }
}

/** Read the bridge's token mint without depending on a type that may not
 *  exist yet: ogb.d.ts gains the sts namespace with the sibling bridge work. */
function readTokenMint(): (() => Promise<{ token: string }>) | undefined {
  const bridge = typeof window !== "undefined" ? window.ogb : undefined;
  // SAFETY:  every field is optional, so the cast describes a bridge that carries no `sts`
  // namespace as well as one that does, and the `typeof mint === "function"` check below is
  // what actually decides.  A host that puts something else at `sts` reads as absent.
  const mint = (bridge as { sts?: { geminiToken?: () => Promise<{ token: string }> } } | undefined)?.sts
    ?.geminiToken;
  return typeof mint === "function" ? mint : undefined;
}

export function createGeminiLiveSession(): StsSession {
  const lineListeners = new Set<(line: StsTranscriptLine) => void>();
  const errorListeners = new Set<(error: Error) => void>();
  const closedListeners = new Set<(reason: string) => void>();
  const inFlight = new Set<AbortController>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  let socket: WebSocket | null = null;
  let playback: LivePlayback | null = null;
  let engine: StsBotEngine | null = null;
  let engineTimeoutMs = DEFAULT_ENGINE_TIMEOUT_MS;
  let generation = 0;
  let stopping = false;
  let ended = false;
  /** True once setupComplete landed; audio is dropped until then. */
  let ready = false;
  let startPromise: Promise<void> | null = null;
  let pendingSetup: (() => void) | null = null;
  let resume: GeminiResumeHandle | null = null;
  /** Set by an engine bypass; consumed by the bot line that answers it. */
  let bypassPending = false;
  let userText = "";
  let botText = "";
  /** Which stream the bot's text arrives on, so it is never counted twice. */
  let botSource: "text" | "transcript" | null = null;

  const later = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
    return timer;
  };

  const emitLine = (line: StsTranscriptLine) => {
    for (const cb of lineListeners) cb(line);
  };
  const emitError = (message: string) => {
    for (const cb of errorListeners) cb(new Error(message));
  };
  const emitClosed = (reason: string) => {
    if (ended) return;
    ended = true;
    for (const cb of closedListeners) cb(reason);
  };

  /** Close everything without notifying listeners: a stop the caller asked for. */
  const release = () => {
    const active = socket;
    socket = null;
    for (const controller of inFlight) {
      controller.abort(new Error("The call ended."));
    }
    inFlight.clear();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    playback?.dispose();
    playback = null;
    pendingSetup = null;
    ready = false;
    if (!active) return;
    try {
      if (active.readyState === WebSocket.OPEN || active.readyState === WebSocket.CONNECTING) {
        active.close();
      }
    } catch {
      // Already closed by the server.
    }
  };

  /** End the session on its own terms and tell the call view why. */
  const tearDown = (reason: string) => {
    if (stopping) return;
    stopping = true;
    generation += 1;
    release();
    emitClosed(reason);
  };

  const send = (payload: Record<string, unknown>, attempt: number) => {
    const active = socket;
    if (!active || active.readyState !== WebSocket.OPEN) {
      if (!stopping && generation === attempt) {
        tearDown("The Gemini live connection closed while the call was in progress.");
      }
      return;
    }
    try {
      active.send(JSON.stringify(payload));
    } catch {
      // The socket died between the readyState check and the write.
      if (generation === attempt) {
        tearDown("The Gemini live connection failed while sending to the model.");
      }
    }
  };

  const flushBotTurn = (consumeBypass: boolean) => {
    const text = botText.trim();
    botText = "";
    botSource = null;
    if (!text) return;
    emitLine({
      text,
      from: "bot",
      final: true,
      ...(consumeBypass && bypassPending ? { engineBypassed: true } : {}),
    });
    if (consumeBypass) bypassPending = false;
  };

  const flushUserTurn = () => {
    const text = userText.trim();
    userText = "";
    if (text) emitLine({ text, from: "user", final: true });
  };

  /** Append bot text from one of its two streams, whichever speaks first. */
  const appendBotText = (text: string, source: "text" | "transcript") => {
    if (!text.trim()) return;
    if (botSource && botSource !== source) return;
    botSource = source;
    botText += text;
    emitLine({
      text: botText.trim(),
      from: "bot",
      final: false,
      ...(bypassPending ? { engineBypassed: true } : {}),
    });
  };

  /**
   * The engine could not be reached.  Tell the model to answer this turn itself
   * and mark the answer, because a bot that silently loses its engine looks
   * like a bot that quietly invents things.
   */
  const bypassEngine = (attempt: number) => {
    if (generation !== attempt || stopping) return;
    bypassPending = true;
    send(
      {
        clientContent: {
          turns: [{ role: "user", parts: [{ text: ENGINE_BYPASS_INSTRUCTION }] }],
          turnComplete: true,
        },
      },
      attempt,
    );
  };

  const respondToTool = (call: GeminiFunctionCall, response: Record<string, unknown>, attempt: number) => {
    send(
      {
        toolResponse: {
          functionResponses: [{ id: call.id, name: BOT_ENGINE_TOOL, response }],
        },
      },
      attempt,
    );
  };

  const runToolCall = async (call: GeminiFunctionCall, attempt: number) => {
    if (generation !== attempt || stopping) return;
    // A tool the model invented is answered with an error it can read, rather
    // than left hanging: an unanswered call stalls the whole turn.
    if (call.name !== BOT_ENGINE_TOOL) {
      respondToTool(call, { error: `No such tool: ${call.name ?? "unnamed"}` }, attempt);
      return;
    }
    const active = engine;
    if (!active) {
      bypassEngine(attempt);
      return;
    }
    const controller = new AbortController();
    inFlight.add(controller);
    const timer = later(
      () => controller.abort(new Error("The bot engine took too long to answer.")),
      engineTimeoutMs,
    );
    try {
      const reply = await active.run(call.args ?? {}, controller.signal);
      if (generation !== attempt || stopping) return;
      respondToTool(call, { result: reply }, attempt);
    } catch {
      // Timeout or rejection: degrade this turn, keep the call up.
      if (generation !== attempt || stopping) return;
      bypassEngine(attempt);
    } finally {
      clearTimeout(timer);
      timers.delete(timer);
      inFlight.delete(controller);
    }
  };

  const handleServerMessage = (raw: unknown, attempt: number) => {
    if (generation !== attempt || stopping) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(String(raw));
    } catch (error) {
      console.warn("gemini-live: vendor frame was not JSON", { error });
      emitError("Gemini live sent a frame this build could not read.");
      return;
    }
    const parsed = serverMessageSchema.safeParse(decoded);
    if (!parsed.success) {
      console.warn("gemini-live: vendor frame failed schema", { issues: parsed.error.issues });
      emitError("Gemini live sent a message this build does not understand.");
      return;
    }
    const message = parsed.data;

    if (message.setupComplete) {
      ready = true;
      const settle = pendingSetup;
      pendingSetup = null;
      settle?.();
      return;
    }

    if (message.goAway) {
      const seconds = typeof message.goAway.timeLeftMs === "number"
        ? Math.max(0, Math.round(message.goAway.timeLeftMs / 1000))
        : null;
      // The server ends the session shortly; the call view reconnects.
      tearDown(
        seconds === null
          ? "Gemini is closing this live session; reconnect to continue the call."
          : `Gemini is closing this live session in about ${seconds} second${seconds === 1 ? "" : "s"}; reconnect to continue the call.`,
      );
      return;
    }

    if (message.sessionResumptionUpdate?.sessionResumptionToken) {
      resume = {
        sessionId: message.sessionResumptionUpdate.newSession,
        token: message.sessionResumptionUpdate.sessionResumptionToken,
      };
    }

    const transcription = message.inputTranscription;
    if (transcription?.text) {
      userText += transcription.text;
      emitLine({ text: userText.trim(), from: "user", final: false });
    }

    const output = message.outputTranscription;
    if (output?.text) appendBotText(output.text, "transcript");

    const content = message.serverContent;
    if (content) {
      if (content.interrupted === true) {
        // The caller talked over the bot.  Silence first, transcript second:
        // queued audio is what they are interrupting, and it is often ahead of
        // the speaker.
        playback?.stop();
        // The cut-off reply still belongs in the transcript, but it is not the
        // answer to the bypass, so that marker survives to the next turn.
        flushBotTurn(false);
      }
      for (const part of content.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) {
          playback ??= new LivePlayback();
          playback.enqueue(fromBase64(part.inlineData.data));
        }
        if (part.text) appendBotText(part.text, "text");
      }
      if (content.modelTurn?.finished === true) flushBotTurn(true);
      if (content.turnComplete === true) flushUserTurn();
    }

    for (const call of message.toolCall?.functionCalls ?? []) {
      void runToolCall(call, attempt);
    }
  };

  const session: StsSession = {
    provider: "gemini",
    async start(opts) {
      // Overlapping starts share one session rather than opening two sockets
      // and two engine lanes for the same call.
      if (startPromise) return startPromise;
      const mint = readTokenMint();
      if (!mint) {
        throw new Error("Gemini live bridge is unavailable in this build.");
      }
      const pending = (async () => {
        const attempt = ++generation;
        stopping = false;
        ended = false;
        ready = false;
        bypassPending = false;
        userText = "";
        botText = "";
        botSource = null;
        engine = opts.botEngine ?? null;
        engineTimeoutMs = opts.engineTimeoutMs ?? DEFAULT_ENGINE_TIMEOUT_MS;

        // The minted token is valid for about a minute, so the socket opens
        // directly from it: no other await is allowed to sit in between.
        const { token } = await mint();
        if (generation !== attempt || stopping) return;

        const active = new WebSocket(buildGeminiLiveUrl(token));
        socket = active;

        let connectTimer: ReturnType<typeof setTimeout> | undefined;
        let setupTimer: ReturnType<typeof setTimeout> | undefined;
        const clearHandshake = () => {
          if (connectTimer) {
            clearTimeout(connectTimer);
            timers.delete(connectTimer);
            connectTimer = undefined;
          }
          if (setupTimer) {
            clearTimeout(setupTimer);
            timers.delete(setupTimer);
            setupTimer = undefined;
          }
        };
        let resolveSetup!: () => void;
        let rejectSetup!: (error: Error) => void;
        const handshake = new Promise<void>((resolve, reject) => {
          resolveSetup = resolve;
          rejectSetup = reject;
        });
        const fail = (message: string) => {
          clearHandshake();
          rejectSetup(new Error(message));
        };
        connectTimer = later(() => fail("Gemini live took too long to connect."), CONNECT_TIMEOUT_MS);

        // Three shapes of trouble are kept apart: a socket that never opens or
        // dies mid-handshake fails start(), a socket that errors later reports
        // through onError, and a socket that closes ends the session through
        // onClosed so the call view can reconnect.
        active.addEventListener(
          "open",
          () => {
            if (generation !== attempt || stopping) {
              fail("The Gemini live connection opened after the call ended.");
              return;
            }
            if (connectTimer) {
              clearTimeout(connectTimer);
              timers.delete(connectTimer);
              connectTimer = undefined;
            }
            setupTimer = later(
              () => fail("Gemini live did not finish its setup handshake in time."),
              SETUP_TIMEOUT_MS,
            );
            pendingSetup = () => {
              clearHandshake();
              resolveSetup();
            };
            // The setup frame must be first and must be alone; every other
            // outbound message waits for setupComplete.
            send(buildGeminiSetupMessage(opts), attempt);
          },
          { once: true },
        );
        active.addEventListener("error", () => {
          if (!ready) {
            fail("Could not open the Gemini live connection.");
            return;
          }
          if (generation === attempt && !stopping) {
            emitError("The Gemini live connection reported a transport error.");
          }
        });
        active.addEventListener("close", () => {
          if (!ready) fail("The Gemini live connection closed during setup.");
          if (generation === attempt && !stopping) {
            tearDown("The Gemini live connection closed; reconnect to continue the call.");
          }
        });
        active.addEventListener("message", (event) => handleServerMessage(event.data, attempt));

        try {
          await handshake;
        } catch (error) {
          clearHandshake();
          if (generation === attempt) {
            stopping = true;
            generation += 1;
            release();
            emitClosed(error instanceof Error ? error.message : "Gemini live could not start.");
          }
          throw error;
        }
      })();
      startPromise = pending;
      // Only in-flight starts are deduped.  A rejected promise must not pin
      // retries to the first network blip, expired token, or goAway.  Attach
      // after assignment so TypeScript can see `pending` is initialized.
      void pending.catch(() => {
        if (startPromise === pending) startPromise = null;
      });
      return pending;
    },

    sendAudio(pcm) {
      if (stopping || !ready) return;
      const active = socket;
      if (!active || active.readyState !== WebSocket.OPEN) {
        // Never throw into the capture path; end the session instead so the
        // call view can reconnect.
        tearDown("The Gemini live connection dropped before the audio stream ended.");
        return;
      }
      if (!pcm.byteLength) return;
      send(
        {
          realtimeInput: {
            mediaChunks: [{ mimeType: INPUT_MIME_TYPE, data: toBase64(pcm) }],
          },
        },
        generation,
      );
    },

    async stop() {
      if (stopping) return;
      stopping = true;
      generation += 1;
      startPromise = null;
      release();
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

  // The resumption token is vendor state with no home on StsSession, so it is
  // reached the same way call-stt.ts reaches its raw IPC teardown.
  // SAFETY:  the added field is written here and read only back through this same
  // intersection, so the assertion cannot contradict a checked field -- StsSession itself
  // declares no `__resume`, and nothing outside this file sets one.
  (session as StsSession & { __resume?: () => GeminiResumeHandle | null }).__resume = () => resume;
  return session;
}