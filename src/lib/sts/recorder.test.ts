import { describe, expect, it } from "vitest";
import {
  RECORDING_RETENTION_DAYS,
  RECORDING_SAMPLE_RATE,
  buildStereoWav,
  createStsCallRecorder,
  isPastRetention,
  recordingFileName,
  resamplePcm16,
} from "./recorder";

/** One PCM16 frame with every sample set to `value`. */
function pcm(samples: number, value: number, frameRate = RECORDING_SAMPLE_RATE): ArrayBuffer {
  const buffer = new ArrayBuffer(samples * 2);
  const view = new DataView(buffer);
  for (let index = 0; index < samples; index += 1) view.setInt16(index * 2, value, true);
  void frameRate;
  return buffer;
}

function readWavHeader(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  const tag = (offset: number, length: number) =>
    Array.from({ length }, (_, index) => String.fromCharCode(view.getUint8(offset + index))).join("");
  return {
    riff: tag(0, 4),
    wave: tag(8, 4),
    fmt: tag(12, 4),
    data: tag(36, 4),
    audioFormat: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    riffSize: view.getUint32(4, true),
    dataSize: view.getUint32(40, true),
    byteLength: buffer.byteLength,
  };
}

// Frame N of the file starts at 44 + N * 4: an int16 left then an int16 right.
function frameOffset(frame: number): number {
  return 44 + frame * 4;
}

describe("buildStereoWav", () => {
  it("writes a header a player will accept", () => {
    const header = readWavHeader(buildStereoWav(new Int16Array(1600), new Int16Array(1600)));
    expect(header.riff).toBe("RIFF");
    expect(header.wave).toBe("WAVE");
    expect(header.fmt).toBe("fmt ");
    expect(header.data).toBe("data");
    // 1 = integer PCM.  Anything else and players fall back to a byte stream.
    expect(header.audioFormat).toBe(1);
    expect(header.channels).toBe(2);
    expect(header.sampleRate).toBe(RECORDING_SAMPLE_RATE);
    expect(header.bitsPerSample).toBe(16);
    expect(header.blockAlign).toBe(4);
    expect(header.byteRate).toBe(RECORDING_SAMPLE_RATE * 4);
    // The two size fields are what a player seeks on, so they have to agree
    // with the real length rather than merely with each other.
    expect(header.riffSize).toBe(header.byteLength - 8);
    expect(header.dataSize).toBe(header.byteLength - 44);
  });

  it("puts the person on the left and the bot on the right", () => {
    const user = Int16Array.from([100, 200, 300]);
    const bot = Int16Array.from([-100, -200, -300]);
    const buffer = buildStereoWav(user, bot);
    const view = new DataView(buffer);
    // Left is 44, then each frame is 4 bytes: left sample then right sample.
    expect(view.getInt16(44, true)).toBe(100);
    expect(view.getInt16(46, true)).toBe(-100);
    expect(view.getInt16(48, true)).toBe(200);
    expect(view.getInt16(50, true)).toBe(-200);
    expect(view.getInt16(52, true)).toBe(300);
    expect(view.getInt16(54, true)).toBe(-300);
  });

  it("pads the shorter track with silence instead of cutting the tail off", () => {
    const buffer = buildStereoWav(Int16Array.from([1, 2, 3]), Int16Array.from([9]));
    const view = new DataView(buffer);
    // Frame 0 is the only one the bot spoke on.
    expect(view.getInt16(44, true)).toBe(1);
    expect(view.getInt16(46, true)).toBe(9);
    // The person carries on alone for two more frames.
    expect(view.getInt16(48, true)).toBe(2);
    expect(view.getInt16(50, true)).toBe(0);
    expect(view.getInt16(52, true)).toBe(3);
    expect(view.getInt16(54, true)).toBe(0);
    // And the file is as long as the longer of the two.
    expect(readWavHeader(buffer).dataSize).toBe(3 * 4);
  });

  it("handles a call where only one side ever spoke", () => {
    const botOnly = readWavHeader(buildStereoWav(new Int16Array(0), new Int16Array(800)));
    expect(botOnly.channels).toBe(2);
    expect(botOnly.dataSize).toBe(800 * 4);
  });
});

describe("createStsCallRecorder", () => {
  it("records each side to its own channel across many frames", () => {
    const recorder = createStsCallRecorder();
    // Interleaved the way a real call arrives them, not one side then the other.
    for (let frame = 0; frame < 5; frame += 1) {
      recorder.write("user", pcm(160, 1000 + frame));
      recorder.write("bot", pcm(160, -2000 - frame));
    }
    const recording = recorder.stop();
    expect(recording).not.toBeNull();
    expect(recording!.durationSeconds).toBeCloseTo((5 * 160) / RECORDING_SAMPLE_RATE, 6);

    const view = new DataView(recording!.wav);
    const leftFirst = view.getInt16(frameOffset(0), true);
    const rightFirst = view.getInt16(frameOffset(0) + 2, true);
    expect(leftFirst).toBe(1000);
    expect(rightFirst).toBe(-2000);
    // The last of the five frames written, on both channels.
    expect(view.getInt16(frameOffset(4 * 160), true)).toBe(1004);
    expect(view.getInt16(frameOffset(4 * 160) + 2, true)).toBe(-2004);
  });

  it("does not let a reused decode buffer rewrite earlier audio", () => {
    // The audio paths reuse one buffer per chunk, so a recorder that kept the
    // reference would record the final contents of every frame.
    const recorder = createStsCallRecorder();
    const reused = new ArrayBuffer(160 * 2);
    const reusedView = new DataView(reused);
    reusedView.setInt16(0, 111, true);
    recorder.write("user", reused);
    for (let index = 1; index < 160; index += 1) reusedView.setInt16(index * 2, 222, true);
    recorder.write("bot", pcm(160, 333));

    const recording = recorder.stop();
    const view = new DataView(recording!.wav);
    // The one sample that was 111 when the frame was written...
    expect(view.getInt16(frameOffset(0), true)).toBe(111);
    // ...and the 159 that were zero, never the 222 the buffer was refilled
    // with a moment later.
    expect(view.getInt16(frameOffset(159), true)).toBe(0);
    expect(view.getInt16(frameOffset(0) + 2, true)).toBe(333);
  });

  it("reports a call where nobody spoke as no recording at all", () => {
    // An empty WAV is a silent file the person has to open to discover is
    // silent, which is worse than showing nothing.
    expect(createStsCallRecorder().stop()).toBeNull();
  });

  it("keeps the whole samples in a truncated frame and drops the half one", () => {
    // A frame cut mid-sample means the sender's buffer was reused under it.
    // The three complete samples are audio; the trailing byte is not a sample
    // and must not be padded into one.
    const recorder = createStsCallRecorder();
    const truncated = new ArrayBuffer(7);
    const view = new DataView(truncated);
    for (let index = 0; index < 3; index += 1) view.setInt16(index * 2, index + 1, true);
    recorder.write("user", truncated);
    const recording = recorder.stop();
    expect(readWavHeader(recording!.wav).dataSize).toBe(3 * 4);
    expect(recorder.elapsedSeconds).toBeCloseTo(3 / RECORDING_SAMPLE_RATE, 6);
  });

  it("ignores a completely empty frame", () => {
    const recorder = createStsCallRecorder();
    recorder.write("user", new ArrayBuffer(0));
    expect(recorder.stop()).toBeNull();
  });

  it("is frozen once stopped, so a late frame cannot rewrite the file", () => {
    const recorder = createStsCallRecorder();
    recorder.write("user", pcm(160, 5));
    const first = recorder.stop();
    recorder.write("bot", pcm(160, 9));
    const second = recorder.stop();
    // Same object, same bytes: the call view may stop a call more than once.
    expect(second).toBe(first);
    expect(readWavHeader(second!.wav).dataSize).toBe(160 * 4);
  });

  it("never throws into the call when a frame is not a buffer", () => {
    const recorder = createStsCallRecorder();
    recorder.write("user", pcm(160, 1));
    // SAFETY: a null frame is exactly the bad input this test feeds the recorder.
    expect(() => recorder.write("bot", null as never)).not.toThrow();
    // The rest of the recording survives the bad frame.
    expect(recorder.stop()).not.toBeNull();
  });

  it("counts elapsed seconds as the longer of the two tracks", () => {
    // The microphone streams continuously, so its track is what measures the
    // call; the bot only writes while it speaks.  The longer of the two is
    // both the file's real length and the honest elapsed time.
    const recorder = createStsCallRecorder();
    expect(recorder.elapsedSeconds).toBe(0);
    recorder.write("user", pcm(RECORDING_SAMPLE_RATE, 0)); // one second
    expect(recorder.elapsedSeconds).toBeCloseTo(1, 6);
    // Half a second of bot does not shorten the call, and does not lengthen it.
    recorder.write("bot", pcm(RECORDING_SAMPLE_RATE / 2, 0));
    expect(recorder.elapsedSeconds).toBeCloseTo(1, 6);
    // A second and a half of microphone is a second and a half.
    recorder.write("user", pcm(RECORDING_SAMPLE_RATE / 2, 0));
    expect(recorder.elapsedSeconds).toBeCloseTo(1.5, 6);
  });

  it("names the channels so the UI can say which speaker is which", () => {
    const recording = createStsCallRecorder();
    recording.write("user", pcm(160, 1));
    expect(recording.stop()!.channels).toEqual({ left: "user", right: "bot" });
  });
});

describe("resamplePcm16", () => {
  it("halves the sample count when halving the rate", () => {
    const input = new Int16Array(24_000); // one second at 24 kHz
    expect(resamplePcm16(input, 24_000, 16_000).length).toBe(16_000);
  });

  it("keeps a ramp intact rather than playing it fast", () => {
    // A ramp is the cheapest way to see speed wrong: written at the wrong rate
    // it ends at a fraction of the value it should reach.  48 samples at
    // 24 kHz is 32 samples at 16 kHz, and on a linear ramp the k-th output
    // sample is the input at position k * 1.5.
    const input = Int16Array.from({ length: 48 }, (_, index) => index * 100);
    const out = resamplePcm16(input, 24_000, 16_000);
    expect(out.length).toBe(32);
    for (let index = 0; index < out.length; index += 1) {
      expect(out[index]).toBe(Math.round(index * 1.5 * 100));
    }
  });

  it("returns the input untouched when the rate already matches", () => {
    const input = Int16Array.from([1, 2, 3]);
    expect(resamplePcm16(input, 16_000, 16_000)).toBe(input);
  });

  it("never produces a sample outside full scale", () => {
    // Interpolating two full-scale values must not overflow the int16.
    const input = new Int16Array(64).fill(32_767);
    for (const sample of resamplePcm16(input, 24_000, 16_000)) {
      expect(sample).toBeLessThanOrEqual(32_767);
      expect(sample).toBeGreaterThanOrEqual(-32_768);
    }
    const negative = new Int16Array(64).fill(-32_768);
    for (const sample of resamplePcm16(negative, 24_000, 16_000)) {
      expect(sample).toBeGreaterThanOrEqual(-32_768);
    }
  });
});

describe("a call where the two sides run at different rates", () => {
  it("writes both into the file at one rate, so the bot is not sped up", () => {
    // Gemini speaks back at 24 kHz while the microphone is 16 kHz.  Writing
    // both raw would play the bot fast and an octave high.
    const recorder = createStsCallRecorder();
    recorder.write("user", pcm(16_000, 1000), 16_000); // one second
    recorder.write("bot", pcm(24_000, -2000), 24_000); // one second, 1.5x samples
    const recording = recorder.stop();
    expect(recording!.durationSeconds).toBeCloseTo(1, 3);

    const header = readWavHeader(recording!.wav);
    // 16_000 frames at 16 kHz stereo is one second of a two-channel file.
    expect(header.dataSize).toBe(16_000 * 4);
    expect(header.sampleRate).toBe(16_000);

    const view = new DataView(recording!.wav);
    // Both sides survive the resample, still on their own channel.
    expect(view.getInt16(frameOffset(0), true)).toBe(1000);
    expect(view.getInt16(frameOffset(0) + 2, true)).toBe(-2000);
  });

  it("counts a 24 kHz track in seconds, not in samples", () => {
    // 24_000 samples is one second at 24 kHz and one and a half at 16 kHz.
    const recorder = createStsCallRecorder();
    recorder.write("bot", pcm(24_000, 0), 24_000);
    expect(recorder.elapsedSeconds).toBeCloseTo(1, 6);
  });
});

describe("recordingFileName", () => {
  it("sorts by when the call happened", () => {
    const name = recordingFileName(new Date(2026, 9, 14, 14, 5), "Forge");
    expect(name).toBe("call-2026-10-14_1405-Forge.wav");
    const earlier = recordingFileName(new Date(2026, 9, 14, 9, 30), "Forge");
    expect(earlier < name).toBe(true);
  });

  it("strips anything in a bot name that could become a path", () => {
    // A bot name is set by a person, so it cannot be trusted as a file name.
    const name = recordingFileName(new Date(2026, 0, 2, 3, 4), "../../etc/passwd");
    expect(name).toBe("call-2026-01-02_0304-etc-passwd.wav");
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
  });

  it("falls back to a usable name when the bot name is only punctuation", () => {
    expect(recordingFileName(new Date(2026, 0, 2, 3, 4), "///")).toBe("call-2026-01-02_0304-bot.wav");
  });

  it("pads single-digit months, days, hours and minutes", () => {
    expect(recordingFileName(new Date(2026, 0, 2, 3, 4), "Bot")).toBe("call-2026-01-02_0304-Bot.wav");
  });
});

describe("isPastRetention", () => {
  const now = new Date(2026, 9, 14, 12, 0, 0);

  it("keeps a recording right up to the retention window", () => {
    const justInside = new Date(now.getTime() - (RECORDING_RETENTION_DAYS * 24 * 60 * 60 * 1000) + 1000);
    expect(isPastRetention(justInside, now)).toBe(false);
  });

  it("deletes one once the window has passed", () => {
    const justOutside = new Date(now.getTime() - (RECORDING_RETENTION_DAYS * 24 * 60 * 60 * 1000) - 1000);
    expect(isPastRetention(justOutside, now)).toBe(true);
  });

  it("keeps a recording dated in the future rather than deleting it", () => {
    // Clock skew must not eat someone's only copy of a call.
    expect(isPastRetention(new Date(now.getTime() + 60_000), now)).toBe(false);
  });
});