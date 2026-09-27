import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("./assemblyai-transcription", () => ({ startAssemblyAITranscription: mocks.start }));
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
    const turn = mocks.start.mock.calls[0]![0].onTurn as (value: { text: string; final: boolean }) => void;
    const finish = session.finish();
    expect(track.stop).toHaveBeenCalledOnce();
    turn({ text: "last words", final: true });
    expect(transcript).toHaveBeenCalledWith({ text: "last words", partial: false });
    draining.resolve();
    await finish;
    turn({ text: "too late", final: true });
    expect(transcript).toHaveBeenCalledTimes(1);
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
