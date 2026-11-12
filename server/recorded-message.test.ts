import { afterEach, describe, expect, it, vi } from "vitest";

import { incomingRecording, recordingReview } from "./recorded-message.ts";

describe("incomingRecording", () => {
  it("accepts a saved WAV attachment with the on-device transcript", () => {
    expect(incomingRecording({
      path: "/api/attachments/one.wav",
      mime: "audio/wav",
      transcript: "hello",
      engine: "apple-on-device",
    })).toEqual({
      path: "/api/attachments/one.wav",
      mime: "audio/wav",
      transcript: "hello",
      engine: "apple-on-device",
    });
  });

  it("rejects anything that is not a saved WAV attachment", () => {
    const valid = {
      path: "/api/attachments/one.wav",
      mime: "audio/wav",
      transcript: "hello",
      engine: "apple-on-device",
    };
    expect(incomingRecording(undefined)).toBeNull();
    expect(incomingRecording("one.wav")).toBeNull();
    expect(incomingRecording({ ...valid, path: "/api/attachments/one.mp3" })).toBeNull();
    expect(incomingRecording({ ...valid, path: "/tmp/one.wav" })).toBeNull();
    expect(incomingRecording({ ...valid, mime: "audio/mpeg" })).toBeNull();
    expect(incomingRecording({ ...valid, engine: "cloud" })).toBeNull();
    expect(incomingRecording({ ...valid, transcript: 1 })).toBeNull();
  });
});

describe("recordingReview", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stamps a correction without rewriting omitted fields", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    expect(recordingReview(
      { comment: "keep me", updatedAt: 1 },
      { correction: "what I meant" },
    )).toEqual({
      correction: "what I meant",
      comment: "keep me",
      updatedAt: 1_000,
    });
  });

  it("rejects overlong or non-text fields", () => {
    expect(recordingReview(undefined, {})).toBeNull();
    expect(recordingReview(undefined, { correction: 1 })).toBeNull();
    expect(recordingReview(undefined, { comment: "x".repeat(12_001) })).toBeNull();
  });
});
