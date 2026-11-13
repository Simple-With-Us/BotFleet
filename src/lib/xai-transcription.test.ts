import { afterEach, describe, expect, it, vi } from "vitest";

import { startXaiTranscription, type XaiCreateSessionBody, type SessionEvent } from "./xai-transcription";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("startXaiTranscription", () => {
  it("creates a harness session with language and keyterms, then maps turns", async () => {
    const collected = vi.fn();
    let send: ((event: SessionEvent) => void) | undefined;
    const createSession = vi.fn(async (body: XaiCreateSessionBody) => {
      expect(body.language).toBe("en-US");
      expect(body.keyterms).toEqual(["BotFleet"]);
      expect(body.endpointMs).toBe(850);
      return { sessionId: "sess-2" };
    });
    const stopSession = vi.fn().mockResolvedValue(undefined);
    const session = await startXaiTranscription({
      stream: { getTracks: () => [] },
      onTurn: collected,
      onError: vi.fn(),
      keyterms: ["BotFleet"],
      minTurnSilenceMs: 850,
      language: "en-US",
      deps: {
        createSession,
        postAudio: async () => {},
        stopSession,
        subscribe: (_id, listener) => {
          send = listener;
          return () => {};
        },
        attachCapture: async () => ({ stop: async () => {} }),
      },
    });
    send?.({ type: "partial", text: "Hello", final: false });
    send?.({ type: "partial", text: "Hello there", final: true });
    expect(collected.mock.calls.map(([line]) => line)).toEqual([
      { text: "Hello", final: false },
      { text: "Hello there", final: true },
    ]);
    await session.stop();
    expect(stopSession).toHaveBeenCalledWith("sess-2");
  });

  it("batches PCM posts and keeps the subscription open through stopSession", async () => {
    const posts: ArrayBuffer[] = [];
    const order: string[] = [];
    let onPcm: ((bytes: ArrayBuffer) => void) | undefined;
    const session = await startXaiTranscription({
      stream: { getTracks: () => [] },
      onTurn: vi.fn(),
      onError: vi.fn(),
      language: "en",
      deps: {
        createSession: async () => ({ sessionId: "sess-batch" }),
        postAudio: async (_id, bytes) => {
          posts.push(bytes);
          order.push("post");
        },
        stopSession: async () => {
          order.push("stop");
        },
        subscribe: () => {
          order.push("sub");
          return () => { order.push("unsub"); };
        },
        attachCapture: async (_stream, send) => {
          onPcm = send;
          return { stop: async () => { order.push("capture-stop"); } };
        },
      },
    });
    onPcm?.(new Uint8Array([1, 2]).buffer);
    onPcm?.(new Uint8Array([3, 4]).buffer);
    expect(posts).toHaveLength(0);
    await session.stop();
    expect(posts).toHaveLength(1);
    expect(Array.from(new Uint8Array(posts[0]!))).toEqual([1, 2, 3, 4]);
    expect(order).toEqual(["sub", "capture-stop", "post", "stop", "unsub"]);
  });
});
