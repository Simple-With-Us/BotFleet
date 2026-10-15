import { describe, expect, it } from "vitest";

import { encodeWavFromAudioBuffer, VOICE_CLONE_MIN_SECONDS } from "./voice-clone-recording";

describe("voice-clone-recording", () => {
  it("encodes a short mono buffer as a WAV blob", () => {
    const samples = new Float32Array(800);
    for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin(i / 40);
    const buffer = {
      numberOfChannels: 1,
      length: samples.length,
      sampleRate: 16_000,
      getChannelData: (channel: number) => {
        if (channel !== 0) throw new Error("expected mono");
        return samples;
      },
    } as AudioBuffer;
    const wav = encodeWavFromAudioBuffer(buffer);
    expect(wav.type).toBe("audio/wav");
    expect(wav.size).toBeGreaterThan(44);
  });

  it("documents the minimum clone clip length", () => {
    expect(VOICE_CLONE_MIN_SECONDS).toBe(10);
  });
});
