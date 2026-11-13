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
});
