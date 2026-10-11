import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGeminiSetupMessage,
  buildGeminiLiveUrl,
  createGeminiLiveSession,
  type GeminiResumeHandle,
} from "./gemini-live";
import {
  BOT_ENGINE_TOOL,
  DEFAULT_ENGINE_TIMEOUT_MS,
  ENGINE_BYPASS_INSTRUCTION,
  ENGINE_PREAMBLE_INSTRUCTION,
  type StsBotEngine,
  type StsSession,
  type StsTranscriptLine,
} from "./types";

type Listener = (event: { data?: unknown; code?: number }) => void;

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code: 1000 });
  });
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {
    sockets.push(this);
  }

  addEventListener(type: string, fn: Listener) {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(fn);
    this.listeners.set(type, set);
  }

  send(data: string) {
    this.sent.push(data);
  }

  emit(type: string, event: { data?: unknown; code?: number } = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", {});
  }

  receive(payload: unknown) {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

/** 24 kHz mono PCM16 silence, as the server would send it. */
function pcmBase64(bytes = 480) {
  return Buffer.alloc(bytes).toString("base64");
}

let sockets: MockWebSocket[] = [];
const geminiToken = vi.fn().mockResolvedValue({ token: "ephemeral-token" });

/** Boot a session to the point where audio is accepted. */
async function startReady(opts?: { botEngine?: StsBotEngine; engineTimeoutMs?: number }) {
  const session = createGeminiLiveSession();
  const lines: StsTranscriptLine[] = [];
  const errors: Error[] = [];
  const closes: string[] = [];
  session.onLine((line) => lines.push(line));
  session.onError((error) => errors.push(error));
  session.onClosed((reason) => closes.push(reason));
  const opening = session.start({
    instructions: "You are Skippy.",
    ...opts,
  });
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  sockets[0]!.open();
  sockets[0]!.receive({ setupComplete: {} });
  await opening;
  return { session, lines, errors, closes, socket: sockets[0]! };
}

beforeEach(() => {
  sockets = [];
  geminiToken.mockClear();
  geminiToken.mockResolvedValue({ token: "ephemeral-token" });
  // The bridge mints the ephemeral token; the renderer never holds the key.
  vi.stubGlobal("window", { ogb: { sts: { geminiToken } } });
  vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("gemini live handshake", () => {
  it("sends the setup frame alone and resolves only on setupComplete", async () => {
    const session = createGeminiLiveSession();
    const errors: Error[] = [];
    session.onError((error) => errors.push(error));
    let settled = false;
    const opening = session
      .start({
        instructions: "You are Skippy.",
        botEngine: {
          name: "claude",
          description: "Run a task.",
          parameters: { type: "object" },
          run: vi.fn().mockResolvedValue("ok"),
        },
      })
      .then(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0]!;

    // Minted through the bridge, connected with the ephemeral token, and the
    // permanent key is nowhere in the URL or the file.
    expect(geminiToken).toHaveBeenCalledOnce();
    expect(socket.url).toBe(buildGeminiLiveUrl("ephemeral-token"));
    expect(socket.url).toContain("access_token=ephemeral-token");

    // Nothing is sent before the socket opens.
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(socket.frames()).toHaveLength(1);
    const [setup] = socket.frames() as [{ setup: Record<string, unknown> }];
    expect(Object.keys(setup!)).toEqual(["setup"]);
    expect(setup!.setup).toMatchObject({
      model: "models/gemini-3.8-live",
      responseModalities: ["AUDIO"],
      sessionResumption: {},
      contextWindowCompression: {
        triggerTokens: expect.any(Number),
        slidingWindow: { targetTokens: expect.any(Number) },
      },
    });
    expect(setup!.setup.systemInstruction).toMatchObject({
      parts: [{ text: `You are Skippy.\n\n${ENGINE_PREAMBLE_INSTRUCTION}` }],
    });
    expect(setup!.setup.tools).toEqual([
      {
        functionDeclarations: [
          { name: BOT_ENGINE_TOOL, description: "Run a task.", parameters: { type: "object" } },
        ],
      },
    ]);

    // Still pending: audio stays gated until setupComplete.
    expect(settled).toBe(false);
    session.sendAudio(new ArrayBuffer(320));
    expect(socket.sent).toHaveLength(1);

    socket.receive({ setupComplete: {} });
    await opening;
    expect(settled).toBe(true);

    session.sendAudio(new ArrayBuffer(320));
    expect(socket.frames()[1]).toEqual({
      realtimeInput: {
        mediaChunks: [
          { mimeType: "audio/pcm;rate=16000", data: Buffer.alloc(320).toString("base64") },
        ],
      },
    });
    expect(errors).toEqual([]);
    await session.stop();
  });

  it("fails clearly when the bridge cannot mint a token", async () => {
    vi.stubGlobal("window", { ogb: {} });
    const session = createGeminiLiveSession();
    await expect(session.start({ instructions: "You are Skippy." })).rejects.toThrow(
      /bridge is unavailable/i,
    );
    expect(sockets).toEqual([]);
    // Still safe to stop a session that never opened.
    await session.stop();
  });

it("rejects a start whose socket never opens", async () => {
    const session = createGeminiLiveSession();
    const opening = session.start({ instructions: "You are Skippy." });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.emit("error", {});
    await expect(opening).rejects.toThrow(/could not open/i);
  });

  it("shares one session across overlapping starts", async () => {
    const session = createGeminiLiveSession();
    const first = session.start({ instructions: "You are Skippy." });
    const second = session.start({ instructions: "You are Skippy." });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(geminiToken).toHaveBeenCalledOnce();
    sockets[0]!.open();
    sockets[0]!.receive({ setupComplete: {} });
    await Promise.all([first, second]);
    expect(sockets[0]!.frames()).toHaveLength(1);
    await session.stop();
  });

  it("builds a setup frame without engine tools or preamble when no engine is wired", () => {
    const setup = buildGeminiSetupMessage({ instructions: "Be brief." }) as {
      setup: Record<string, unknown>;
    };
    expect(setup.setup).not.toHaveProperty("tools");
    expect(setup.setup.systemInstruction).toEqual({ parts: [{ text: "Be brief." }] });
    // inputTranscription is the config that makes the caller's speech visible.
    expect(setup.setup.inputTranscription).toEqual({});
  });
});

describe("gemini live tool calls", () => {
  it("runs the bot engine and answers the call with a toolResponse", async () => {
    const run = vi.fn().mockResolvedValue("Deployed bot GROK-9.");
    const botEngine: StsBotEngine = {
      name: "claude",
      description: "Run a task.",
      parameters: { type: "object", properties: { task: { type: "string" } } },
      run,
    };
    const { session, socket, errors } = await startReady({ botEngine });

    socket.receive({
      toolCall: {
        functionCalls: [{ id: "call-1", name: BOT_ENGINE_TOOL, args: { task: "deploy" } }],
      },
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(run.mock.calls[0]![0]).toEqual({ task: "deploy" });
    expect(run.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);

    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(JSON.parse(socket.sent[1]!)).toEqual({
      toolResponse: {
        functionResponses: [
          { id: "call-1", name: BOT_ENGINE_TOOL, response: { result: "Deployed bot GROK-9." } },
        ],
      },
    });
    expect(errors).toEqual([]);
    await session.stop();
  });

  it("answers a tool call it never offered instead of stalling the turn", async () => {
    const { session, socket } = await startReady();
    socket.receive({
      toolCall: { functionCalls: [{ id: "call-2", name: "some_other_tool", args: {} }] },
    });
    // One frame is the setup; this is the only reply to the unknown call.
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(JSON.parse(socket.sent[1]!)).toEqual({
      toolResponse: {
        functionResponses: [
          { id: "call-2", name: BOT_ENGINE_TOOL, response: { error: "No such tool: some_other_tool" } },
        ],
      },
    });
    await session.stop();
  });

  it("keeps the call alive and marks the line when the engine times out", async () => {
    vi.useFakeTimers();
    const run = vi.fn(
      (_input: Record<string, unknown>, signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("engine timed out")));
        }),
    );
    const botEngine: StsBotEngine = {
      name: "claude",
      description: "Run a task.",
      parameters: { type: "object" },
      run,
    };
    const session = createGeminiLiveSession();
    const lines: StsTranscriptLine[] = [];
    const errors: Error[] = [];
    const closes: string[] = [];
    session.onLine((line) => lines.push(line));
    session.onError((error) => errors.push(error));
    session.onClosed((reason) => closes.push(reason));
    const opening = session.start({ instructions: "You are Skippy.", botEngine });
    // The deadline itself is the default, so the clock is driven by hand.
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    const socket = sockets[0]!;
    socket.open();
    socket.receive({ setupComplete: {} });
    await opening;

    socket.receive({
      toolCall: { functionCalls: [{ id: "call-3", name: BOT_ENGINE_TOOL, args: {} }] },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(DEFAULT_ENGINE_TIMEOUT_MS + 10);

    // The deadline degrades the turn; it does not fail the session.
    expect(socket.readyState).toBe(MockWebSocket.OPEN);
    expect(errors).toEqual([]);
    expect(closes).toEqual([]);
    expect(socket.frames()[1]).toEqual({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: ENGINE_BYPASS_INSTRUCTION }] }],
        turnComplete: true,
      },
    });

    // The model's own answer is what the transcript shows, flagged.
    socket.receive({ outputTranscription: { text: "Your bot" } });
    socket.receive({ outputTranscription: { text: " is already deployed." } });
    socket.receive({ serverContent: { modelTurn: { finished: true } } });
    expect(lines).toEqual([
      { text: "Your bot", from: "bot", final: false, engineBypassed: true },
      { text: "Your bot is already deployed.", from: "bot", final: false, engineBypassed: true },
      { text: "Your bot is already deployed.", from: "bot", final: true, engineBypassed: true },
    ]);

    // The session still takes audio afterwards.
    session.sendAudio(new ArrayBuffer(320));
    expect(socket.frames()).toHaveLength(3);
    await session.stop();
  });

  it("bypasses the engine when it rejects, and honours a custom deadline", async () => {
    const run = vi.fn().mockRejectedValue(new Error("engine exploded"));
    const botEngine: StsBotEngine = {
      name: "claude",
      description: "Run a task.",
      parameters: { type: "object" },
      run,
    };
    const { session, socket, errors } = await startReady({ botEngine, engineTimeoutMs: 2_000 });
    socket.receive({
      toolCall: { functionCalls: [{ id: "call-4", name: BOT_ENGINE_TOOL, args: {} }] },
    });
    await vi.waitFor(() => expect(socket.frames()).toHaveLength(2));
    expect(socket.frames()[1]!.clientContent).toBeDefined();
    expect(errors).toEqual([]);
    await session.stop();
  });
});

describe("gemini live call flow", () => {
  it("emits both sides of the call from the transcriptions", async () => {
    const { session, socket, lines } = await startReady();
    socket.receive({ inputTranscription: { text: "Deploy " } });
    socket.receive({ inputTranscription: { text: "Skippy." } });
    socket.receive({ serverContent: { turnComplete: true } });
    socket.receive({ outputTranscription: { text: "On it." } });
    socket.receive({ serverContent: { modelTurn: { finished: true } } });
    expect(lines).toEqual([
      { text: "Deploy", from: "user", final: false },
      { text: "Deploy Skippy.", from: "user", final: false },
      { text: "Deploy Skippy.", from: "user", final: true },
      { text: "On it.", from: "bot", final: false },
      { text: "On it.", from: "bot", final: true },
    ]);
    await session.stop();
  });

  it("stops queued playback the moment the caller interrupts", async () => {
    const sources: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
    class FakeSource {
      buffer: unknown = null;
      onended: (() => void) | null = null;
      readonly stop = vi.fn();
      connect = vi.fn();
      disconnect = vi.fn();
      start = vi.fn();
    }
    class FakeAudioContext {
      state = "running";
      currentTime = 0;
      destination = {};
      resume = vi.fn().mockResolvedValue(undefined);
      close = vi.fn().mockResolvedValue(undefined);
      createBuffer(_channels: number, length: number, sampleRate: number) {
        return { duration: length / sampleRate, copyToChannel: vi.fn() };
      }
      createBufferSource() {
        const source = new FakeSource();
        sources.push(source);
        return source as unknown as AudioBufferSourceNode;
      }
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const { session, socket, lines } = await startReady();
    socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: pcmBase64() } }] } } });
    socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: pcmBase64() } }] } } });
    expect(sources).toHaveLength(2);

    socket.receive({ serverContent: { interrupted: true } });
    expect(sources[0]!.stop).toHaveBeenCalledOnce();
    expect(sources[1]!.stop).toHaveBeenCalledOnce();

    // The cut-off reply still reaches the transcript as a finished line.
    socket.receive({ outputTranscription: { text: "Your bot is " } });
    socket.receive({ serverContent: { interrupted: true } });
    expect(lines).toEqual([
      { text: "Your bot is", from: "bot", final: false },
      { text: "Your bot is", from: "bot", final: true },
    ]);
    await session.stop();
  });

  it("surfaces goAway through onClosed so the call view can reconnect", async () => {
    const { session, socket, closes } = await startReady();
    socket.receive({ goAway: { timeLeftMs: 60_000 } });
    expect(closes).toEqual([
      "Gemini is closing this live session in about 60 seconds; reconnect to continue the call.",
    ]);
    expect(socket.close).toHaveBeenCalledOnce();
    // A second goAway is not reported twice.
    socket.receive({ goAway: { timeLeftMs: 59_000 } });
    expect(closes).toHaveLength(1);
    await session.stop();
  });

  it("ends the session when the socket closes and reports unreadable frames", async () => {
    const { session, socket, errors, closes } = await startReady();
    socket.emit("message", { data: "not json" });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/could not read/i);

    socket.emit("close", { code: 1006 });
    expect(closes).toEqual([
      "The Gemini live connection closed; reconnect to continue the call.",
    ]);
    // Audio after the close tears down rather than throwing at the capture path.
    expect(() => session.sendAudio(new ArrayBuffer(320))).not.toThrow();
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  });

  it("keeps the resumption token for a reconnect without logging it", async () => {
    const { session, socket } = await startReady();
    socket.receive({
      sessionResumptionUpdate: { newSession: "session-1", sessionResumptionToken: "resume-secret" },
    });
    const resume = (session as StsSession & { __resume?: () => GeminiResumeHandle | null }).__resume?.();
    expect(resume).toEqual({ sessionId: "session-1", token: "resume-secret" });
    await session.stop();
  });

  it("stops once, aborting an in-flight engine call", async () => {
    let aborted = false;
    const run = vi.fn(
      (_input: Record<string, unknown>, signal: AbortSignal) =>
        new Promise<string>(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    );
    const { session, socket, closes } = await startReady({
      botEngine: {
        name: "claude",
        description: "Run a task.",
        parameters: { type: "object" },
        run,
      },
    });
    socket.receive({
      toolCall: { functionCalls: [{ id: "call-5", name: BOT_ENGINE_TOOL, args: {} }] },
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(aborted).toBe(false);

    await session.stop();
    await session.stop();
    expect(aborted).toBe(true);
    expect(socket.close).toHaveBeenCalledOnce();
    // A caller-requested stop is not an "ended on its own" event.
    expect(closes).toEqual([]);
  });
});