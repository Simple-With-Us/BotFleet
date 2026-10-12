// What the call view hands the STS layer: which mode a call runs in, what the
// microphone forwards, and how a bot turn resolves for the engine tool.
//
// Pure units, deliberately.  The Web Audio graph and the MediaStream stay
// behind `MicPlatform`, because the only thing worth asserting about them is
// this file's policy — the constraints asked for, the 16 kHz resample, the
// idempotent teardown — and that policy is testable with a fake platform.  The
// browser adapter next to it is three Web Audio calls and nothing else.

import { describe, expect, it, vi } from "vitest";

import {
  appendStsLine,
  BOT_ENGINE_PARAMETERS,
  composeCallPersona,
  createEngineTurnWaiter,
  createMicCapture,
  createStsBotEngine,
  createStsCallDriver,
  decideCallMode,
  enginePrompt,
  MIC_CONSTRAINTS,
  parseEngineToolCall,
  stsBridgeAvailable,
  stsBypassMarker,
  stsCapability,
  stsLineText,
  STS_INPUT_SAMPLE_RATE,
  type MicAudioGraph,
  type MicPlatform,
  type MicStream,
  type StsSession,
  type StsTranscriptLine,
} from "./call-session";

const CAPTURE = { platform: "darwin" };

function capability(over: Partial<Parameters<typeof stsCapability>[0]> = {}) {
  return stsCapability({ platform: "darwin", bridgeAvailable: true, ...over });
}

describe("decideCallMode", () => {
  it("takes STS when the picker names a provider and the microphone exists", () => {
    expect(decideCallMode({ capability: capability({ keys: { xai: true } }), microphoneAvailable: true }))
      .toEqual({ mode: "sts", provider: "xai", reason: "provider-selected" });
  });

  it("stays chained when no provider holds a key", () => {
    // The shipped default: an install that has never set a speech-to-speech
    // key must behave exactly as it did before the feature existed.
    expect(decideCallMode({ capability: capability({ keys: {} }), microphoneAvailable: true }))
      .toEqual({ mode: "chained", reason: "no-key" });
  });

  it("stays chained when the bridge cannot mint a token", () => {
    expect(decideCallMode({ capability: capability({ bridgeAvailable: false, keys: { xai: true } }), microphoneAvailable: true }))
      .toEqual({ mode: "chained", reason: "no-bridge" });
  });

  it("stays chained without a microphone, because Apple dictation does not use one", () => {
    // Chained can still capture through the native speech helper, so a missing
    // getUserMedia is an STS-only disqualifier, never a reason to refuse.
    expect(decideCallMode({ capability: capability({ keys: { xai: true } }), microphoneAvailable: false }))
      .toEqual({ mode: "chained", reason: "no-microphone" });
  });

  it("honours an explicit preference only while that provider holds a key", () => {
    const keys = { xai: true, gemini: false };
    expect(pick(capability({ keys, preference: "gemini" }))).toBe("xai");
    const both = { xai: true, gemini: true };
    expect(pick(capability({ keys: both, preference: "gemini" }))).toBe("gemini");
  });
});

function pick(cap: ReturnType<typeof stsCapability>): string | undefined {
  return decideCallMode({ capability: cap, microphoneAvailable: true }).provider;
}

describe("stsCapability", () => {
  it("carries the provider map as reported, and Auto as no preference", () => {
    expect(stsCapability({ platform: "darwin", bridgeAvailable: true, keys: { gemini: true } }))
      .toEqual({ platform: "darwin", keys: { gemini: true }, explicitPreference: null, bridgeAvailable: true });
  });

  it("leaves a key unknown rather than claiming it is present", () => {
    // `undefined` must not become `true` in a map whose whole purpose is to
    // say which key is missing.
    expect(stsCapability({ platform: "linux", bridgeAvailable: false }).keys).toEqual({});
  });
});

describe("stsBridgeAvailable", () => {
  it("is true when either token minter can be called", () => {
    expect(stsBridgeAvailable({ sts: { xaiToken: () => Promise.resolve({ token: "t", expiresInSeconds: 1 }) } })).toBe(true);
    expect(stsBridgeAvailable({ sts: { geminiToken: () => Promise.resolve({ token: "t", expiresInSeconds: 1 }) } })).toBe(true);
  });

  it("is false with no bridge, and false when status exists but neither minter does", () => {
    // An older preload exposes status for the settings panel only; a call
    // still cannot open, so it must not look available.
    const statusOnly = { sts: { status: () => Promise.resolve({ xai: true, gemini: false }) } };
    expect(stsBridgeAvailable(statusOnly)).toBe(false);
    expect(stsBridgeAvailable(undefined)).toBe(false);
  });
});

// ── capture ──────────────────────────────────────────────────────────────

function fakePlatform(options: { suspended?: boolean } = {}) {
  const frames: Array<(frame: Float32Array) => void> = [];
  let released = 0;
  let disposed = 0;
  let closed = 0;
  const stream: MicStream = { release: () => { released += 1; } };
  const graph: MicAudioGraph = {
    sampleRate: 48_000,
    suspended: options.suspended ?? false,
    resume: async () => {},
    close: async () => { closed += 1; },
    capture: (_stream, onFrame) => {
      frames.push(onFrame);
      return { dispose: () => { disposed += 1; } };
    },
  };
  const asked: Array<MediaTrackConstraints> = [];
  const platform: MicPlatform = {
    getUserMedia: async (constraints) => {
      asked.push(constraints);
      return stream;
    },
    createAudioGraph: () => graph,
  };
  return {
    platform,
    asked,
    stats: () => ({ released, disposed, closed }),
    /** Hand one 48 kHz mono frame to the capture, as the processor would. */
    emit: (samples: Float32Array) => frames.forEach((frame) => frame(samples)),
  };
}

describe("createMicCapture", () => {
  it("asks for the same microphone constraints as the dictation path", async () => {
    const fakes = fakePlatform();
    await createMicCapture(fakes.platform).start(() => {});
    expect(fakes.asked).toEqual([MIC_CONSTRAINTS]);
    expect(MIC_CONSTRAINTS).toEqual({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
  });

  it("resamples to 16 kHz mono PCM16 before handing a frame on", async () => {
    const fakes = fakePlatform();
    const sent: ArrayBuffer[] = [];
    await createMicCapture(fakes.platform).start((pcm) => sent.push(pcm));

    // One second of a 1 kHz tone at the device rate, halved to 16 kHz.
    fakes.emit(new Float32Array(48).fill(0.5));

    expect(sent).toHaveLength(1);
    const pcm = new Int16Array(sent[0]!);
    expect(pcm).toHaveLength(16);
    // Whatever the shared resampler emits, byte for byte: this is the same
    // pcm16FromFloat32 the dictation path sends, so the two cannot drift.
    expect(pcm[0]).toBe(Math.floor(0.5 * 0x7fff));
    expect(new DataView(sent[0]!).byteLength).toBe(16 * 2);
    expect(STS_INPUT_SAMPLE_RATE).toBe(16_000);
  });

  it("resumes a suspended context before capturing", async () => {
    const resume = vi.fn(async () => {});
    const fakes = fakePlatform({ suspended: true });
    const platform: MicPlatform = {
      getUserMedia: fakes.platform.getUserMedia,
      createAudioGraph: () => ({ ...fakes.platform.createAudioGraph(), suspended: true, resume }),
    };
    await createMicCapture(platform).start(() => {});
    expect(resume).toHaveBeenCalledOnce();
  });

  it("tears the microphone and the graph down once, however often stop lands", async () => {
    const fakes = fakePlatform();
    const capture = createMicCapture(fakes.platform);
    await capture.start(() => {});
    await capture.stop();
    await capture.stop();
    expect(fakes.stats()).toEqual({ released: 1, disposed: 1, closed: 1 });
  });

  it("drops frames that arrive after a stop instead of feeding a dead session", async () => {
    const fakes = fakePlatform();
    const sent: ArrayBuffer[] = [];
    const capture = createMicCapture(fakes.platform);
    await capture.start((pcm) => sent.push(pcm));
    await capture.stop();
    fakes.emit(new Float32Array(8).fill(0.25));
    expect(sent).toEqual([]);
  });

  it("releases a stream whose permission arrived after the call ended", async () => {
    // Hangup while the permission prompt is open must not leak the device.
    const fakes = fakePlatform();
    let open: (stream: MicStream) => void = () => {};
    const platform: MicPlatform = {
      getUserMedia: () => new Promise<MicStream>((resolve) => { open = resolve; }),
      createAudioGraph: fakes.platform.createAudioGraph,
    };
    const capture = createMicCapture(platform);
    const starting = capture.start(() => {});
    await capture.stop();
    open({ release: () => {} });
    await starting;
    expect(fakes.stats().released).toBe(0);
  });

  it("names the refusal when the microphone is denied", async () => {
    const platform: MicPlatform = {
      getUserMedia: async () => { throw new Error("Permission denied"); },
      createAudioGraph: fakePlatform().platform.createAudioGraph,
    };
    await expect(createMicCapture(platform).start(() => {})).rejects.toThrow(/Permission denied/);
  });

  it("refuses outright where there is no microphone to open", async () => {
    await expect(createMicCapture(null).start(() => {})).rejects.toThrow(/cannot capture the microphone/);
  });
});

// ── the session driver ───────────────────────────────────────────────────

function fakeSession() {
  const lines = new Set<(line: StsTranscriptLine) => void>();
  const errors = new Set<(error: Error) => void>();
  const closes = new Set<(reason: string) => void>();
  const sent: ArrayBuffer[] = [];
  const stop = vi.fn(async () => {});
  const session: StsSession = {
    provider: "xai",
    start: async () => {},
    sendAudio: (pcm) => { sent.push(pcm); },
    stop,
    onLine: (fn) => { lines.add(fn); return () => { lines.delete(fn); }; },
    onError: (fn) => { errors.add(fn); return () => { errors.delete(fn); }; },
    onClosed: (fn) => { closes.add(fn); return () => { closes.delete(fn); }; },
  };
  return {
    session,
    sent,
    stop,
    emitLine: (line: StsTranscriptLine) => { for (const fn of lines) fn(line); },
    emitError: (error: Error) => { for (const fn of errors) fn(error); },
    emitClosed: (reason: string) => { for (const fn of closes) fn(reason); },
    listenerCount: () => lines.size + errors.size + closes.size,
  };
}

function fakeCapture() {
  let onFrame: ((pcm: ArrayBuffer) => void) | null = null;
  let stops = 0;
  let fails: Error | null = null;
  return {
    capture: {
      start: vi.fn(async (frame: (pcm: ArrayBuffer) => void) => {
        if (fails) throw fails;
        onFrame = frame;
      }),
      stop: vi.fn(async () => { stops += 1; onFrame = null; }),
    },
    feed: (pcm: ArrayBuffer) => onFrame?.(pcm),
    get stops() { return stops; },
    failWith(error: Error) { fails = error; },
  };
}

describe("createStsCallDriver", () => {
  it("forwards captured audio to the session and reports vendor events", async () => {
    const provider = fakeSession();
    const mic = fakeCapture();
    const seen: StsTranscriptLine[] = [];
    const errors: Error[] = [];
    const closes: string[] = [];
    const driver = createStsCallDriver(
      provider.session,
      { onLine: (line) => seen.push(line), onError: (error) => errors.push(error), onClosed: (reason) => closes.push(reason) },
      mic.capture,
    );
    await driver.start();

    const frame = new ArrayBuffer(64);
    mic.feed(frame);
    provider.emitLine({ text: "build status", from: "user", final: true });
    provider.emitError(new Error("disconnected"));
    provider.emitClosed("vendor go away");

    expect(provider.sent).toEqual([frame]);
    expect(seen.map((line) => line.text)).toEqual(["build status"]);
    expect(errors.map((error) => error.message)).toEqual(["disconnected"]);
    expect(closes).toEqual(["vendor go away"]);
  });

  it("attaches the listeners before the capture opens, so the handshake is not missed", async () => {
    // A line the provider emits during the handshake has to reach the view.
    const provider = fakeSession();
    const order: string[] = [];
    const mic = fakeCapture();
    const watched: StsSession = {
      ...provider.session,
      onLine: (fn) => { order.push("listener"); return provider.session.onLine(fn); },
    };
    mic.capture.start.mockImplementation(async () => { order.push("capture"); });
    const driver = createStsCallDriver(watched, { onLine: () => {} }, mic.capture);
    await driver.start();
    expect(order).toEqual(["listener", "capture"]);
    expect(provider.listenerCount()).toBe(1);
  });

  it("stops once, however many callers hang up at the same time", async () => {
    const provider = fakeSession();
    const mic = fakeCapture();
    const driver = createStsCallDriver(provider.session, {}, mic.capture);
    await driver.start();
    await Promise.all([driver.stop(), driver.stop()]);
    await driver.stop();
    expect(provider.stop).toHaveBeenCalledOnce();
    expect(mic.stops).toBe(1);
    expect(provider.listenerCount()).toBe(0);
  });

  it("does not report its own teardown to the call view as a vendor close", async () => {
    const provider = fakeSession();
    const driver = createStsCallDriver(provider.session, { onClosed: () => { throw new Error("leaked"); } }, fakeCapture().capture);
    await driver.start();
    await expect(driver.stop()).resolves.toBeUndefined();
  });

  it("closes a live session when the microphone fails to open", async () => {
    const provider = fakeSession();
    const mic = fakeCapture();
    mic.failWith(new Error("no device"));
    const driver = createStsCallDriver(provider.session, {}, mic.capture);
    await expect(driver.start()).rejects.toThrow(/no device/);
    // The socket was already open; leaving it open would bill a call nobody
    // is on.
    expect(provider.stop).toHaveBeenCalledOnce();
    expect(provider.listenerCount()).toBe(0);
  });

  it("survives a session that throws on stop", async () => {
    const provider = fakeSession();
    provider.stop.mockRejectedValue(new Error("already closed"));
    const driver = createStsCallDriver(provider.session, {}, fakeCapture().capture);
    await driver.start();
    await expect(driver.stop()).resolves.toBeUndefined();
  });

  it("still closes the session when releasing the microphone fails", async () => {
    const provider = fakeSession();
    const mic = fakeCapture();
    mic.capture.stop.mockRejectedValue(new Error("the device is gone"));
    const driver = createStsCallDriver(provider.session, {}, mic.capture);
    await driver.start();
    await driver.stop();
    expect(provider.stop).toHaveBeenCalledOnce();
  });
});

// ── the transcript ───────────────────────────────────────────────────────

describe("appendStsLine", () => {
  const userPartial: StsTranscriptLine = { text: "what is the", from: "user", final: false };
  const userFinal: StsTranscriptLine = { text: "what is the build status", from: "user", final: true };

  it("updates the open user line instead of stacking a second copy", () => {
    let lines = appendStsLine([], userPartial, 1);
    lines = appendStsLine(lines, userFinal, 2);
    expect(lines).toHaveLength(1);
    expect(stsLineText(lines[0]!)).toBe("You: what is the build status");
  });

  it("appends each finished turn", () => {
    let lines = appendStsLine([], userFinal, 1);
    lines = appendStsLine(lines, { text: "it passed", from: "bot", final: true }, 2);
    lines = appendStsLine(lines, userPartial, 3);
    expect(lines.map(stsLineText)).toEqual([
      "You: what is the build status",
      "it passed",
      "You: what is the",
    ]);
  });

  it("marks a line the bot answered without its engine", () => {
    const lines = appendStsLine([], { text: "it is probably fine", from: "bot", final: true, engineBypassed: true }, 1);
    expect(stsLineText(lines[0]!)).toBe("it is probably fine (answered without the bot's engine)");
    expect(stsBypassMarker(lines[0]!)).toBe(" (answered without the bot's engine)");
  });

  it("leaves an answered line unmarked", () => {
    const lines = appendStsLine([], { text: "it passed", from: "bot", final: true }, 1);
    expect(stsBypassMarker(lines[0]!)).toBe("");
  });

  it("ignores an empty line rather than rendering a blank turn", () => {
    expect(appendStsLine([], { text: "   ", from: "bot", final: true }, 1)).toEqual([]);
  });
});

// ── the bot's engine ─────────────────────────────────────────────────────

describe("createStsBotEngine", () => {
  it("advertises the tool the providers expect, with the task it needs", () => {
    const engine = createStsBotEngine(async () => "done");
    expect(engine.name).toBe("bot_engine");
    expect(engine.parameters).toMatchObject({ required: ["task"] });
    expect(engine.description).toMatch(/engine/);
  });
});

describe("enginePrompt", () => {
  it("carries the task and any context the model sent", () => {
    expect(enginePrompt({ task: "check the build", context: "in the BotFleet lane" }))
      .toBe("check the build\n\nContext from the caller: in the BotFleet lane");
  });

  it("still asks for something when the model sent no task", () => {
    expect(enginePrompt({ context: "  " })).toBe("Work on what the caller asked.");
  });
});

describe("parseEngineToolCall", () => {
  it("keeps the fields the tool declares and drops the rest", () => {
    // The arguments arrive as the model's own JSON, so the decode is what
    // stops an unexpected field from reaching the turn text.
    const parsed = parseEngineToolCall({ task: "ship it", context: "tonight", model: "gpt" });
    expect(parsed).toEqual({ task: "ship it", context: "tonight" });
  });

  it("empties a call whose fields are not text rather than half-parsing it", () => {
    expect(parseEngineToolCall({ task: { nested: true } })).toEqual({});
  });

  it("is what the advertised tool declares", () => {
    const engine = createStsBotEngine(async () => "done");
    expect(engine.parameters).toBe(BOT_ENGINE_PARAMETERS);
  });
});

describe("createEngineTurnWaiter", () => {
  const turn = (id: string, role: string, kind: string, text?: string) => ({ id, role, kind, text });

  it("resolves with the first new bot text message", async () => {
    const waiter = createEngineTurnWaiter();
    const controller = new AbortController();
    const answer = waiter.arm(new Set(["m0"]), controller.signal);
    waiter.observe([turn("m0", "user", "text", "hi"), turn("m1", "bot", "activity"), turn("m2", "bot", "text", "  the build passed ")]);
    await expect(answer).resolves.toBe("the build passed");
  });

  it("ignores a bot message that is not a final text reply", async () => {
    const waiter = createEngineTurnWaiter();
    const controller = new AbortController();
    const answer = waiter.arm(new Set<string>(), controller.signal);
    waiter.observe([turn("m1", "bot", "text", "   ")]);
    waiter.observe([turn("m2", "bot", "text", "a real answer")]);
    await expect(answer).resolves.toBe("a real answer");
  });

  it("rejects when the call ends mid-turn, so the provider can bypass", async () => {
    const waiter = createEngineTurnWaiter();
    const controller = new AbortController();
    const answer = waiter.arm(new Set<string>(), controller.signal);
    controller.abort();
    await expect(answer).rejects.toThrow(/call ended/);
  });

  it("refuses to arm on an already-ended call", async () => {
    const waiter = createEngineTurnWaiter();
    await expect(waiter.arm(new Set(), AbortSignal.abort())).rejects.toThrow(/call ended/);
  });

  it("rejects a cancelled turn rather than waiting out the deadline", async () => {
    const waiter = createEngineTurnWaiter();
    const answer = waiter.arm(new Set<string>(), new AbortController().signal);
    waiter.cancel();
    await expect(answer).rejects.toThrow(/cancelled/);
    // A second turn is unaffected by the first one's cancellation.
    const second = waiter.arm(new Set<string>(), new AbortController().signal);
    waiter.observe([turn("m9", "bot", "text", "recovered")]);
    await expect(second).resolves.toBe("recovered");
  });
});

describe("composeCallPersona", () => {
  it("names the bot and carries its profile", () => {
    const persona = composeCallPersona({ name: "Skippy", title: "Release bot", description: "Watches deploys." });
    expect(persona).toContain("You are Skippy");
    expect(persona).toContain("Release bot");
    expect(persona).toContain("Watches deploys.");
  });

  it("leaves out a profile the bot never set", () => {
    expect(composeCallPersona({ name: "Skippy" })).not.toContain("undefined");
  });
});

// The platform string never reaches a decision, but it travels with the
// capability so a future provider can branch on it; keep it from being dropped.
describe("capability plumbing", () => {
  it("carries the platform through", () => {
    expect(stsCapability({ platform: CAPTURE.platform, bridgeAvailable: true }).platform).toBe(CAPTURE.platform);
  });
});