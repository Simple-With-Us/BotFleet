import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("./assemblyai-transcription", async (importOriginal) => ({
  ...await importOriginal<typeof import("./assemblyai-transcription")>(),
  startAssemblyAITranscription: mocks.start,
}));
import { createAppleSTTSession, createAssemblyAISTTSession, disposeAppleSTTSession } from "./call-stt";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const track = { stop: vi.fn() };
  const media = { getTracks: () => [track] };
  const getUserMedia = vi.fn().mockResolvedValue(media);
  vi.stubGlobal("window", { ogb: { transcription: { streamingToken: vi.fn() } } });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  return { track, media, getUserMedia };
}

afterEach(() => {
  mocks.start.mockReset();
  vi.unstubAllGlobals();
});

describe("AssemblyAI STT lifecycle", () => {
  it("disposes a cloud session that finishes opening after stop", async () => {
    const { track } = setup();
    const pending = deferred<{ stop: () => Promise<void> }>();
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.start.mockReturnValue(pending.promise);
    const session = createAssemblyAISTTSession();
    const opening = session.start();
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    await session.stop();
    expect(track.stop).toHaveBeenCalledOnce();
    pending.resolve({ stop: close });
    await opening;
    expect(close).toHaveBeenCalledOnce();
    mocks.start.mockResolvedValue({ stop: vi.fn().mockResolvedValue(undefined) });
    await session.start();
    expect(mocks.start).toHaveBeenCalledTimes(2);
    await session.stop();
  });

  it("releases capture and permits a retry after an unexpected socket error", async () => {
    const { track } = setup();
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.start.mockResolvedValue({ stop: close });
    const session = createAssemblyAISTTSession();
    const ended = vi.fn();
    session.onEnd(ended);
    await session.start();
    const onError = mocks.start.mock.calls[0]![0].onError as (reason: string) => void;
    onError("Socket closed");
    await vi.waitFor(() => expect(ended).toHaveBeenCalledWith({ code: 1, reason: "Socket closed" }));
    expect(track.stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    await session.start();
    expect(mocks.start).toHaveBeenCalledTimes(2);
    await session.stop();
  });
});


describe("STT teardown", () => {
  it("delivers a final formatted turn while finish drains, then rejects late turns", async () => {
    const { track } = setup();
    const draining = deferred<void>();
    mocks.start.mockResolvedValue({ stop: vi.fn(() => draining.promise) });
    const session = createAssemblyAISTTSession();
    const transcript = vi.fn();
    session.onTranscript(transcript);
    await session.start();
    const turn = mocks.start.mock.calls[0]![0].onTurn as (value: { order: number; text: string; final: boolean }) => void;
    const finish = session.finish();
    expect(track.stop).toHaveBeenCalledOnce();
    turn({ order: 0, text: "last words", final: true });
    expect(transcript).toHaveBeenCalledWith({ text: "last words", partial: false });
    draining.resolve();
    await finish;
    turn({ order: 1, text: "too late", final: true });
    expect(transcript).toHaveBeenCalledTimes(1);
  });

  it("keeps earlier cloud turns and replaces a partial in its own turn", async () => {
    setup();
    mocks.start.mockResolvedValue({ stop: vi.fn().mockResolvedValue(undefined) });
    const session = createAssemblyAISTTSession();
    const transcript = vi.fn();
    session.onTranscript(transcript);
    await session.start();
    const turn = mocks.start.mock.calls[0]![0].onTurn as (value: { order: number; text: string; final: boolean }) => void;
    turn({ order: 0, text: "First sentence.", final: true });
    turn({ order: 1, text: "Second", final: false });
    turn({ order: 1, text: "Second sentence.", final: true });
    expect(transcript.mock.calls.map(([line]) => line.text)).toEqual([
      "First sentence.", "First sentence. Second", "First sentence. Second sentence.",
    ]);
    await session.stop();
    await session.start();
    const next = mocks.start.mock.calls[1]![0].onTurn as typeof turn;
    next({ order: 0, text: "New recording.", final: true });
    expect(transcript).toHaveBeenLastCalledWith({ text: "New recording.", partial: false });
    await session.stop();
  });

  it("detaches raw Apple IPC listeners when a session is disposed", () => {
    const offTranscript = vi.fn();
    const offEnd = vi.fn();
    vi.stubGlobal("window", { ogb: {
      speechStart: vi.fn(), speechStop: vi.fn(), speechFinish: vi.fn(),
      onSpeechTranscript: vi.fn(() => offTranscript),
      onSpeechEnd: vi.fn(() => offEnd),
    } });
    const session = createAppleSTTSession();
    disposeAppleSTTSession(session);
    expect(offTranscript).toHaveBeenCalledOnce();
    expect(offEnd).toHaveBeenCalledOnce();
  });
});
