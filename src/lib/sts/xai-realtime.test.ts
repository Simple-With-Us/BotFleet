import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ENGINE_BYPASS_INSTRUCTION,
  ENGINE_PREAMBLE_INSTRUCTION,
  type StsBotEngine,
  type StsStartOptions,
  type StsTranscriptLine,
} from "./types";
import { createXaiStsSession } from "./xai-realtime";

type DecodedAudio = { duration: number; byteLength: number };

/** A protocol frame, matching the open-ended shape the provider sends. */
type RealtimeFrame = z.infer<typeof realtimeFrameSchema>;

const realtimeFrameSchema = z.looseObject({ type: z.string() });

/** The session configuration the provider sends in a session.update. */
type SessionConfig = z.infer<typeof sessionConfigSchema>;

const sessionConfigSchema = z.looseObject({
  instructions: z.string().optional(),
  tools: z.array(z.looseObject({ type: z.string() })).optional(),
  turn_detection: z.looseObject({ type: z.string() }).optional(),
});

class MockSource {
  buffer: DecodedAudio | null = null;
  startedAt = 0;
  stopped = false;
  connect() {}
  disconnect() {}
  start(at: number) {
    this.startedAt = at;
  }
  stop() {
    this.stopped = true;
  }
}

class MockAudioContext {
  currentTime = 0;
  state = "running";
  destination = {};
  sources: MockSource[] = [];
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
  decodeAudioData(bytes: ArrayBuffer) {
    return Promise.resolve({ duration: 0.2, byteLength: bytes.byteLength } satisfies DecodedAudio);
  }
  createBufferSource() {
    const source = new MockSource();
    this.sources.push(source);
    return source;
  }
}

/** Records each context so a test can inspect what was scheduled to play. */
class RecordingAudioContext extends MockAudioContext {
  constructor() {
    super();
    contexts.push(this);
  }
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  closeCount = 0;
  readonly listeners = new Map<string, Set<(event: Event) => void>>();
  constructor(
    readonly url: string,
    // Captured because asserting the URL alone never caught the shipped bug:
    // the socket was opened with no credentials at all.
    readonly protocols?: string | string[],
  ) {
    sockets.push(this);
  }
  addEventListener(type: string, fn: (event: Event) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: (event: Event) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closeCount += 1;
    this.readyState = MockWebSocket.CLOSED;
    this.dispatch("close");
  }
  open() {
    this.readyState = MockWebSocket.OPEN;
    this.dispatch("open");
  }
  dispatch(type: string, event: Event = new Event(type)) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  receive(payload: RealtimeFrame) {
    this.dispatch("message", new MessageEvent("message", { data: JSON.stringify(payload) }));
  }
  frames(): RealtimeFrame[] {
    return this.sent.map((raw) => JSON.parse(raw) satisfies RealtimeFrame);
  }
  framesOfType(type: string) {
    return this.frames().filter((frame) => frame.type === type);
  }
  /** The nested `session` payload, parsed rather than asserted. */
  sessionConfig(frame: RealtimeFrame): SessionConfig {
    return sessionConfigSchema.parse(frame.session);
  }
}

const PERSONA = "You are BotFleet's support bot.";

let sockets: MockWebSocket[] = [];
let contexts: MockAudioContext[] = [];

function engine(overrides: Partial<StsBotEngine> = {}): StsBotEngine {
  return {
    name: "bot_engine",
    description: "Run the bot's own engine.",
    parameters: { type: "object", properties: { prompt: { type: "string" } } },
    run: async () => "engine reply",
    ...overrides,
  };
}

function setup() {
  sockets = [];
  contexts = [];
  const xaiToken = vi.fn().mockResolvedValue({ token: "ephemeral-abc", expiresInSeconds: 60 });
  vi.stubGlobal("window", { ogb: { sts: { xaiToken } } });
  // The doubles are deliberately partial: they carry readyState, the static
  // OPEN/CLOSED constants, send, close and the four listeners, which is all
  // the provider touches. stubGlobal takes unknown, so no cast is needed.
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal("AudioContext", RecordingAudioContext);
  const session = createXaiStsSession();
  const lines: StsTranscriptLine[] = [];
  const errors: Error[] = [];
  const closed: string[] = [];
  // Listeners register before start(), the way the call view wires them.
  session.onLine((line) => lines.push(line));
  session.onError((error) => errors.push(error));
  session.onClosed((reason) => closed.push(reason));
  return { session, lines, errors, closed, xaiToken };
}

/** Start a session and complete the vendor handshake. Returns its socket. */
async function open(
  session: ReturnType<typeof createXaiStsSession>,
  opts: Partial<StsStartOptions> = {},
) {
  const opening = session.start({ instructions: PERSONA, ...opts });
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  sockets[0]!.open();
  sockets[0]!.receive({ type: "session.updated" });
  await opening;
  return sockets[0]!;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("xAI realtime session handshake", () => {
  it("authenticates the socket with the xAI client-secret subprotocol", async () => {
    const { session } = setup();
    const socket = await open(session);

    // The assertion that was missing.  The session minted a token and then
    // connected without it, which is indistinguishable from success: the socket
    // opens, session.updated arrives, audio flows up, and the vendor sends
    // nothing back.  Asserting the URL alone could never have caught this.
    expect(socket.protocols).toEqual(["xai-client-secret.ephemeral-abc"]);
    await session.stop();
  });

  it("opens the documented endpoint and sends the session config", async () => {
    const { session } = setup();
    const bot = engine();
    const socket = await open(session, { botEngine: bot, language: "en" });

    expect(socket.url).toContain("wss://api.x.ai/v1/realtime");
    expect(new URL(socket.url).searchParams.get("model")).toBe("grok-voice-latest");
    const config = socket.sessionConfig(socket.framesOfType("session.update")[0]!);
    expect(String(config.instructions)).toContain("You are BotFleet's support bot.");
    expect(String(config.instructions)).toContain(ENGINE_PREAMBLE_INSTRUCTION);
    expect(config.turn_detection).toEqual({ type: "server_vad" });
    expect(config.tools).toEqual([{
      type: "function",
      name: "bot_engine",
      description: "Run the bot's own engine.",
      parameters: bot.parameters,
    }]);
    await session.stop();
  });

  it("rejects a second start while one is already open", async () => {
    const { session } = setup();
    await open(session);
    await expect(session.start({ instructions: "again" })).rejects.toThrow(/already started/);
    await session.stop();
  });

  it("rejects the start when the bridge is missing instead of throwing a TypeError", async () => {
    vi.stubGlobal("window", { ogb: {} });
    const session = createXaiStsSession();
    await expect(session.start({ instructions: "hi" })).rejects.toThrow(/bridge is unavailable/);
  });

  it("rejects the start when the vendor reports an error", async () => {
    const { session, errors } = setup();
    const opening = session.start({ instructions: "hi" });
    const settled = opening.catch((error: Error) => error);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    sockets[0]!.receive({ type: "error", error: { message: "model unavailable" } });

    expect(await settled).toBeInstanceOf(Error);
    await expect(opening).rejects.toThrow(/model unavailable/);
    expect(errors[0]!.message).toMatch(/model unavailable/);
  });
});

describe("xAI realtime engine tool", () => {
  it("emits the preamble, runs the engine and returns its reply", async () => {
    const { session, lines } = setup();
    const run = vi.fn<StsBotEngine["run"]>(async () => "the build passed");
    const socket = await open(session, { botEngine: engine({ run }) });

    socket.receive({ type: "response.output_item.added", item: { id: "item_1" } });
    socket.receive({ type: "response.audio_transcript.delta", delta: "Let me check that." });
    socket.receive({
      type: "response.function_call_arguments.done",
      call_id: "call_1",
      name: "bot_engine",
      arguments: JSON.stringify({ prompt: "build status" }),
    });

    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(lines).toEqual([{ text: "Let me check that.", from: "bot", final: true }]);
    expect(run.mock.calls[0]![0]).toEqual({ prompt: "build status" });
    expect(run.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);

    await vi.waitFor(() =>
      expect(socket.framesOfType("response.function_call_output")).toEqual([
        { type: "response.function_call_output", call_id: "call_1", output: "the build passed" },
      ]),
    );
    await session.stop();
  });

  it("bypasses a timed-out engine instead of failing the session", async () => {
    const { session, lines, errors } = setup();
    // Never settles on its own; only the deadline can end the call.
    const run = vi.fn<StsBotEngine["run"]>((_input, signal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("engine timed out")));
      }));
    const socket = await open(session, { botEngine: engine({ run }), engineTimeoutMs: 5 });

    socket.receive({
      type: "response.function_call_arguments.done",
      call_id: "call_2",
      name: "bot_engine",
      arguments: "{}",
    });

    // The bypass pushes a second instructions update on top of the handshake one.
    await vi.waitFor(() => expect(socket.framesOfType("session.update")).toHaveLength(2));
    const updated = socket.sessionConfig(socket.framesOfType("session.update").at(-1)!);
    expect(String(updated.instructions)).toContain(ENGINE_BYPASS_INSTRUCTION);
    expect(socket.framesOfType("response.function_call_output")[0]).toMatchObject({ call_id: "call_2" });
    // A degraded turn is shown in the transcript, not raised as a call error.
    expect(errors).toEqual([]);

    socket.receive({ type: "response.audio_transcript.done", transcript: "It ships from main." });
    expect(lines).toEqual([
      { text: "It ships from main.", from: "bot", final: true, engineBypassed: true },
    ]);

    // The session is still live: audio still flows.
    session.sendAudio(new ArrayBuffer(320));
    expect(socket.framesOfType("input_audio_buffer.append")).toHaveLength(1);
    await session.stop();
  });
});

describe("xAI realtime interruption", () => {
  it("stops playback and truncates the audio the user never heard", async () => {
    const { session } = setup();
    const socket = await open(session);

    socket.receive({ type: "response.output_item.added", item: { id: "item_9" } });
    socket.receive({ type: "response.audio.delta", item_id: "item_9", audio: btoa("aaaa") });
    socket.receive({ type: "response.audio.delta", item_id: "item_9", audio: btoa("bbbb") });
    await vi.waitFor(() => expect(contexts.at(-1)!.sources).toHaveLength(2));
    // The user hears 250ms of a 400ms reply before speaking over it.
    contexts.at(-1)!.currentTime = 0.25;

    socket.receive({ type: "input_audio_buffer.speech_started" });

    expect(contexts.at(-1)!.sources.every((source) => source.stopped)).toBe(true);
    expect(socket.framesOfType("conversation.item.truncate")).toEqual([{
      type: "conversation.item.truncate",
      item_id: "item_9",
      content_index: 0,
      audio_end_ms: 250,
    }]);
    expect(socket.framesOfType("response.cancel")).toHaveLength(1);
    await session.stop();
  });
});

describe("xAI realtime teardown", () => {
  it("stops idempotently and stays quiet after a close", async () => {
    const { session, errors } = setup();
    const socket = await open(session);

    await session.stop();
    await session.stop();
    expect(socket.closeCount).toBe(1);
    // A close caused by our own stop() is not a disconnect.
    expect(errors).toEqual([]);
    expect(() => session.sendAudio(new ArrayBuffer(64))).not.toThrow();
    expect(socket.framesOfType("input_audio_buffer.append")).toHaveLength(0);
  });

  it("aborts an in-flight engine call on stop", async () => {
    const { session } = setup();
    const signals: AbortSignal[] = [];
    const run = vi.fn<StsBotEngine["run"]>((_input, signal) => {
      signals.push(signal);
      return new Promise<string>(() => {});
    });
    const socket = await open(session, { botEngine: engine({ run }) });

    socket.receive({
      type: "response.function_call_arguments.done",
      call_id: "call_3",
      name: "bot_engine",
      arguments: "{}",
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());

    await session.stop();
    expect(signals[0]!.aborted).toBe(true);
  });

  it("reports an unexpected socket close as a disconnect", async () => {
    const { session, errors } = setup();
    const socket = await open(session);
    socket.dispatch("close");

    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]!.message).toMatch(/disconnected/);
  });
});