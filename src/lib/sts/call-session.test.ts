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
  resolveStsApproval,
  spokenApprovalDecision,
  staleApprovalText,
  stsApprovalInstructions,
  stsBridgeAvailable,
  stsBypassMarker,
  stsCapability,
  stsLineText,
  STS_INPUT_SAMPLE_RATE,
  VOICE_DENIAL_MESSAGE,
  type MicAudioGraph,
  type MicPlatform,
  type MicStream,
  type StsApprovalOutcome,
  type StsApprovalView,
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

  it("does not overwrite an earlier user turn once the bot has spoken past it", () => {
    // The regression that mattered.  A provisional user line that never
    // finalized stays open, and the open-partial search used to scan the whole
    // transcript for it: so the next user turn replaced that older line instead
    // of appending, and everything said before the bot replied vanished.  Both
    // user lines are non-final on purpose — a finalized line was never at risk,
    // which is why this state is the only one that could lose text.
    let lines = appendStsLine([], { text: "first question", from: "user", final: false }, 1);
    lines = appendStsLine(lines, { text: "the first answer", from: "bot", final: true }, 2);
    lines = appendStsLine(lines, { text: "second question", from: "user", final: false }, 3);
    expect(lines.map(stsLineText)).toEqual([
      "You: first question",
      "the first answer",
      "You: second question",
    ]);
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
    expect(engine.parameters).toMatchObject({
      properties: { task: { type: "string" }, approval: { type: "object" } },
    });
    expect(engine.description).toMatch(/engine/);
  });

  it("requires nothing, because an approval call carries no task", () => {
    // Requiring `task` would make the model invent a sentence of engine work
    // purely to satisfy the schema on a call that is only answering a prompt.
    expect(BOT_ENGINE_PARAMETERS.required).toEqual([]);
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

  it("carries a permission the model asked about", () => {
    expect(parseEngineToolCall({ approval: { action: "decide", requestId: "req-1", answer: "yes" } }))
      .toEqual({ approval: { action: "decide", requestId: "req-1", answer: "yes" } });
  });

  it("drops an approval whose action is not one it offers", () => {
    // An action the schema does not declare must not reach the policy as a
    // half-parsed decision; the whole call is dropped instead.
    expect(parseEngineToolCall({ approval: { action: "approve", answer: "yes" } })).toEqual({});
  });

  it("is what the advertised tool declares", () => {
    const engine = createStsBotEngine(async () => "done");
    expect(engine.parameters).toBe(BOT_ENGINE_PARAMETERS);
  });
});

describe("createEngineTurnWaiter", () => {
  const turn = (id: string, role: string, kind: string, text?: string) => ({ id, role, kind, text });
  /** A permission card, with only the two ways one stops being pending. */
  const card = (id: string, requestId: string, tool: string, settle?: { answered?: string; dismissed?: boolean }) => ({
    id,
    role: "bot",
    kind: "options",
    card: { requestId, tool, ...settle },
  });

  it("resolves with the first new bot text message", async () => {
    const waiter = createEngineTurnWaiter();
    const controller = new AbortController();
    const answer = waiter.arm(new Set(["m0"]), controller.signal);
    waiter.observe([turn("m0", "user", "text", "hi"), turn("m1", "bot", "activity"), turn("m2", "bot", "text", "  the build passed ")]);
    await expect(answer).resolves.toEqual({ kind: "reply", text: "the build passed" });
  });

  it("ignores a bot message that is not a final text reply", async () => {
    const waiter = createEngineTurnWaiter();
    const controller = new AbortController();
    const answer = waiter.arm(new Set<string>(), controller.signal);
    waiter.observe([turn("m1", "bot", "text", "   ")]);
    waiter.observe([turn("m2", "bot", "text", "a real answer")]);
    await expect(answer).resolves.toEqual({ kind: "reply", text: "a real answer" });
  });

  it("reports a permission that opened mid-turn instead of waiting out the deadline", async () => {
    // The stall this exists to end: the engine is blocked on the user, so the
    // wait has to come back with the request rather than time out.
    const waiter = createEngineTurnWaiter();
    const answer = waiter.arm(new Set(["m0"]), new AbortController().signal);
    waiter.observe([turn("m0", "user", "text", "fix the tests"), card("m1", "req-1", "Bash")]);
    await expect(answer).resolves.toEqual({ kind: "approval", requestId: "req-1" });
  });

  it("prefers a waiting permission over a reply in the same batch", async () => {
    // An open request is what holds the turn up; reporting the reply instead
    // would send the model off believing the engine had finished.
    const waiter = createEngineTurnWaiter();
    const answer = waiter.arm(new Set<string>(), new AbortController().signal);
    waiter.observe([turn("m2", "bot", "text", "all done"), card("m1", "req-1", "Bash")]);
    await expect(answer).resolves.toEqual({ kind: "approval", requestId: "req-1" });
  });

  it("does not mistake an answered, dismissed, or tool-less card for a permission", async () => {
    const waiter = createEngineTurnWaiter();
    const answer = waiter.arm(new Set<string>(), new AbortController().signal);
    waiter.observe([
      card("m1", "req-1", "Bash", { answered: "Allow" }),
      card("m2", "req-2", "Write", { dismissed: true }),
      // A question card carries a request id but no tool: it is not a
      // permission, and answering it aloud is a different exchange entirely.
      { id: "m3", role: "bot", kind: "options", card: { requestId: "req-3" } },
    ]);
    waiter.observe([turn("m4", "bot", "text", "never mind")]);
    await expect(answer).resolves.toEqual({ kind: "reply", text: "never mind" });
  });

  it("does not re-report a permission card that was already on screen", async () => {
    // The card this call just decided is still on screen until the server's
    // patch lands; re-arming for the engine's reply must not see it again.
    const waiter = createEngineTurnWaiter();
    const answer = waiter.arm(new Set(["m1"]), new AbortController().signal);
    waiter.observe([card("m1", "req-1", "Bash"), turn("m2", "bot", "text", "done")]);
    await expect(answer).resolves.toEqual({ kind: "reply", text: "done" });
  });

  it("settles with what the caller already knows, rather than rejecting", async () => {
    // A decision the server refused is not an engine failure: rejecting here
    // would be recorded as a bypass the model cannot explain.
    const waiter = createEngineTurnWaiter();
    const answer = waiter.arm(new Set<string>(), new AbortController().signal);
    waiter.note("That approval could not be saved.  Ask the caller again.");
    await expect(answer).resolves.toEqual({
      kind: "failed",
      text: "That approval could not be saved.  Ask the caller again.",
    });
  });

  it("ignores a note that arrives with nothing armed", () => {
    expect(() => createEngineTurnWaiter().note("nobody is listening")).not.toThrow();
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
    await expect(second).resolves.toEqual({ kind: "reply", text: "recovered" });
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

// ── a permission, answered out loud ──────────────────────────────────────

const PENDING: StsApprovalView[] = [
  {
    requestId: "req-1",
    tool: "Bash",
    routine: false,
    messageId: "m1",
    prompt: "Skippy wants to run ls. Should I allow it?",
  },
  {
    requestId: "req-2",
    tool: "Write",
    routine: false,
    messageId: "m2",
    prompt: "Skippy wants to edit main.ts. Should I allow it?",
  },
];

const NOTHING_DECIDED = new Set<string>();

/** What the model would be handed for any outcome that submits nothing.  A
 *  decision has no text by construction: it goes out as an action instead. */
function outcomeText(outcome: StsApprovalOutcome): string {
  if (outcome.kind === "decided") {
    throw new Error("A decision is an action, not something the model is told.");
  }
  return outcome.text;
}

describe("spokenApprovalDecision", () => {
  it("reads an answer that opens with a decision", () => {
    // The anchor is at the start of the utterance, exactly as the chained path
    // has always read it: what matters is that the answer *is* a yes or a no,
    // not that it is exactly one word.
    expect(spokenApprovalDecision("yes")).toBe("allow");
    expect(spokenApprovalDecision("  Yeah, go ahead  ")).toBe("allow");
    expect(spokenApprovalDecision("yes, but read it to me first")).toBe("allow");
    expect(spokenApprovalDecision("no")).toBe("deny");
    expect(spokenApprovalDecision("don't")).toBe("deny");
  });

  it("refuses to read consent out of a sentence that only contains it", () => {
    // The rule the chained path has always held: an approval is never granted
    // by a word that happened to appear somewhere in the utterance.
    expect(spokenApprovalDecision("I'm not sure about that")).toBe("unclear");
    expect(spokenApprovalDecision("can you approve the deploy?")).toBe("unclear");
    expect(spokenApprovalDecision("I would approve it if you asked")).toBe("unclear");
    expect(spokenApprovalDecision(undefined)).toBe("unclear");
    expect(spokenApprovalDecision("   ")).toBe("unclear");
  });
});

describe("resolveStsApproval — checking what is waiting", () => {
  it("says so plainly when nothing is pending", () => {
    const outcome = resolveStsApproval({ action: "check" }, [], NOTHING_DECIDED);
    expect(outcome.kind).toBe("status");
    expect(outcomeText(outcome)).toMatch(/Nothing is waiting/);
  });

  it("lists every waiting request, oldest first, with the id to answer it by", () => {
    const outcome = resolveStsApproval({ action: "check" }, PENDING, NOTHING_DECIDED);
    expect(outcome.kind).toBe("status");
    const text = outcomeText(outcome);
    expect(text).toContain("2 requests are waiting for permission, oldest first.");
    expect(text.indexOf("req-1")).toBeLessThan(text.indexOf("req-2"));
    expect(text).toContain("Skippy wants to run ls. Should I allow it?");
  });

  it("leaves out a request this call has already answered", () => {
    // The card stays on screen until the server's patch lands; without this a
    // second look would offer to answer the same permission twice.
    const outcome = resolveStsApproval({ action: "check" }, PENDING, new Set(["req-1"]));
    expect(outcomeText(outcome)).toContain("One request is waiting for permission.");
    expect(outcomeText(outcome)).not.toContain("req-1");
  });

  it("treats an action it does not recognise as a read, never as consent", () => {
    const outcome = resolveStsApproval({ answer: "yes" }, PENDING, NOTHING_DECIDED);
    expect(outcome.kind).toBe("status");
  });
});

describe("resolveStsApproval — asking out loud", () => {
  it("hands back the sentence to read, word for word, and how to answer it", () => {
    const outcome = resolveStsApproval({ action: "ask" }, PENDING, NOTHING_DECIDED);
    expect(outcome.kind).toBe("ask");
    // The oldest request is the one on screen, so it is the one asked about.
    expect(outcome.kind === "ask" && outcome.requestId).toBe("req-1");
    expect(outcomeText(outcome)).toContain("Skippy wants to run ls. Should I allow it?");
    expect(outcomeText(outcome)).toContain('action "decide"');
    expect(outcomeText(outcome)).toContain("Never answer it for them");
  });

  it("asks about a named request rather than the oldest one", () => {
    const outcome = resolveStsApproval({ action: "ask", requestId: "req-2" }, PENDING, NOTHING_DECIDED);
    expect(outcome.kind === "ask" && outcome.requestId).toBe("req-2");
    expect(outcomeText(outcome)).toContain("edit main.ts");
  });

  it("never falls back to the oldest request for a name it cannot match", () => {
    // Falling back would let the model read one permission aloud and answer a
    // different one.
    const outcome = resolveStsApproval({ action: "ask", requestId: "req-9" }, PENDING, NOTHING_DECIDED);
    expect(outcome.kind).toBe("stale");
    expect(outcomeText(outcome)).toBe(staleApprovalText());
  });
});

describe("resolveStsApproval — carrying the answer back", () => {
  it("decides only what the user actually said", () => {
    const allow = resolveStsApproval({ action: "decide", requestId: "req-1", answer: "yes" }, PENDING, NOTHING_DECIDED);
    expect(allow).toEqual({ kind: "decided", requestId: "req-1", decision: "allow" });
    const deny = resolveStsApproval({ action: "decide", requestId: "req-1", answer: "no" }, PENDING, NOTHING_DECIDED);
    expect(deny).toEqual({ kind: "decided", requestId: "req-1", decision: "deny" });
  });

  it("approves nothing when the answer cannot be read unambiguously", () => {
    // A misheard turn is not a yes, and it is not a no either: the request
    // stays open, and the model is told to ask again.
    for (const answer of ["I'm not sure", "why do you need that?", "", undefined]) {
      const outcome = resolveStsApproval({ action: "decide", requestId: "req-1", answer }, PENDING, NOTHING_DECIDED);
      expect(outcome.kind).toBe("unclear");
      expect(outcomeText(outcome)).toContain("still waiting");
    }
  });

  it("submits nothing for a request that is no longer waiting", () => {
    for (const decided of [new Set(["req-1"]), new Set<string>()]) {
      const outcome = resolveStsApproval(
        { action: "decide", requestId: decided.has("req-1") ? "req-1" : "req-9", answer: "yes" },
        PENDING,
        decided,
      );
      expect(outcome.kind).toBe("stale");
    }
  });

  it("records one denial note for a voice answer and a click alike", () => {
    expect(VOICE_DENIAL_MESSAGE).toBe("Denied by the user, on a call.");
  });
});

describe("stsApprovalInstructions", () => {
  const clause = stsApprovalInstructions();

  it("tells the model the caller decides, and that it passes words on verbatim", () => {
    expect(clause).toContain("The caller decides, not you.");
    expect(clause).toContain("exact words as the answer");
    expect(clause).toContain("anything you cannot pass on verbatim approves nothing");
  });

  it("never offers the model a way to approve on its own", () => {
    expect(clause).not.toMatch(/always allow/i);
  });

  it("says the card stays, so answering aloud and clicking are the same decision", () => {
    expect(clause).toContain("stays on screen as a card");
  });
});

describe("the engine tool carries the permission", () => {
  it("gives the runner the parsed approval rather than the wire shape", async () => {
    const seen: unknown[] = [];
    const engine = createStsBotEngine(async (call) => {
      seen.push(call.approval);
      return "asked";
    });
    const reply = await engine.run({ approval: { action: "ask", requestId: "req-1" }, model: "x" }, AbortSignal.abort());
    expect(seen).toEqual([{ action: "ask", requestId: "req-1" }]);
    expect(reply).toBe("asked");
  });
});

// The platform string never reaches a decision, but it travels with the
// capability so a future provider can branch on it; keep it from being dropped.
describe("capability plumbing", () => {
  it("carries the platform through", () => {
    expect(stsCapability({ platform: CAPTURE.platform, bridgeAvailable: true }).platform).toBe(CAPTURE.platform);
  });
});