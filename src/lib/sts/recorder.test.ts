import { describe, expect, it, vi } from "vitest";
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
    const recorder = createStsCallRecorder({ now: () => 0 });
    // Interleaved the way a real call arrives them, not one side then the other.
    for (let frame = 0; frame < 5; frame += 1) {
      recorder.write("user", pcm(160, 1000 + frame), RECORDING_SAMPLE_RATE);
      recorder.write("bot", pcm(160, -2000 - frame), RECORDING_SAMPLE_RATE);
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
    const recorder = createStsCallRecorder({ now: () => 0 });
    const reused = new ArrayBuffer(160 * 2);
    const reusedView = new DataView(reused);
    reusedView.setInt16(0, 111, true);
    recorder.write("user", reused, RECORDING_SAMPLE_RATE);
    for (let index = 1; index < 160; index += 1) reusedView.setInt16(index * 2, 222, true);
    recorder.write("bot", pcm(160, 333), RECORDING_SAMPLE_RATE);

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
    expect(createStsCallRecorder({ now: () => 0 }).stop()).toBeNull();
  });

  it("keeps the whole samples in a truncated frame and drops the half one", () => {
    // A frame cut mid-sample means the sender's buffer was reused under it.
    // The three complete samples are audio; the trailing byte is not a sample
    // and must not be padded into one.
    const recorder = createStsCallRecorder({ now: () => 0 });
    const truncated = new ArrayBuffer(7);
    const view = new DataView(truncated);
    for (let index = 0; index < 3; index += 1) view.setInt16(index * 2, index + 1, true);
    recorder.write("user", truncated, RECORDING_SAMPLE_RATE);
    const recording = recorder.stop();
    expect(readWavHeader(recording!.wav).dataSize).toBe(3 * 4);
    expect(recorder.elapsedSeconds).toBeCloseTo(3 / RECORDING_SAMPLE_RATE, 6);
  });

  it("ignores a completely empty frame", () => {
    const recorder = createStsCallRecorder({ now: () => 0 });
    recorder.write("user", new ArrayBuffer(0), RECORDING_SAMPLE_RATE);
    expect(recorder.stop()).toBeNull();
  });

  it("is frozen once stopped, so a late frame cannot rewrite the file", () => {
    const recorder = createStsCallRecorder({ now: () => 0 });
    recorder.write("user", pcm(160, 5), RECORDING_SAMPLE_RATE);
    const first = recorder.stop();
    recorder.write("bot", pcm(160, 9), RECORDING_SAMPLE_RATE);
    const second = recorder.stop();
    // Same object, same bytes: the call view may stop a call more than once.
    expect(second).toBe(first);
    expect(readWavHeader(second!.wav).dataSize).toBe(160 * 4);
  });

  it("never throws into the call when a frame is not a buffer", () => {
    const recorder = createStsCallRecorder({ now: () => 0 });
    recorder.write("user", pcm(160, 1), RECORDING_SAMPLE_RATE);
    // A null frame is exactly the bad input this test feeds the recorder, and the type check must still reject it.
    // @ts-expect-error null is not an ArrayBuffer; the runtime guard is what is under test
    expect(() => recorder.write("bot", null, RECORDING_SAMPLE_RATE)).not.toThrow();
    // The rest of the recording survives the bad frame.
    expect(recorder.stop()).not.toBeNull();
  });

  it("counts elapsed seconds as the longer of the two tracks", () => {
    // The microphone streams continuously, so its track is what measures the
    // call; the bot only writes while it speaks.  The longer of the two is
    // both the file's real length and the honest elapsed time.
    const recorder = createStsCallRecorder({ now: () => 0 });
    expect(recorder.elapsedSeconds).toBe(0);
    recorder.write("user", pcm(RECORDING_SAMPLE_RATE, 0), RECORDING_SAMPLE_RATE); // one second
    expect(recorder.elapsedSeconds).toBeCloseTo(1, 6);
    // Half a second of bot does not shorten the call, and does not lengthen it.
    recorder.write("bot", pcm(RECORDING_SAMPLE_RATE / 2, 0), RECORDING_SAMPLE_RATE);
    expect(recorder.elapsedSeconds).toBeCloseTo(1, 6);
    // A second and a half of microphone is a second and a half.
    recorder.write("user", pcm(RECORDING_SAMPLE_RATE / 2, 0), RECORDING_SAMPLE_RATE);
    expect(recorder.elapsedSeconds).toBeCloseTo(1.5, 6);
  });

  it("names the channels so the UI can say which speaker is which", () => {
    const recording = createStsCallRecorder({ now: () => 0 });
    recording.write("user", pcm(160, 1), RECORDING_SAMPLE_RATE);
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
    const recorder = createStsCallRecorder({ now: () => 0 });
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
    const recorder = createStsCallRecorder({ now: () => 0 });
    recorder.write("bot", pcm(24_000, 0), 24_000);
    expect(recorder.elapsedSeconds).toBeCloseTo(1, 6);
  });
});

describe("a shared clock for both sides", () => {
  const clock = () => {
    let ms = 0;
    return { now: () => ms, at: (value: number) => void (ms = value) };
  };

  it("pads a late bot reply with silence so it lands after the speech it answers", () => {
    const time = clock();
    const recorder = createStsCallRecorder({ now: time.now });
    // The person speaks for one second from the start; the bot first answers at 1.5 s.
    time.at(0);
    recorder.write("user", pcm(RECORDING_SAMPLE_RATE, 1000), RECORDING_SAMPLE_RATE);
    time.at(1500);
    recorder.write("bot", pcm(1600, -2000), RECORDING_SAMPLE_RATE);
    const recording = recorder.stop();
    const view = new DataView(recording!.wav);
    // The bot channel is silent for the first 1.5 s and then carries the reply.
    expect(view.getInt16(frameOffset(0) + 2, true)).toBe(0);
    expect(view.getInt16(frameOffset(24_000 - 1) + 2, true)).toBe(0);
    expect(view.getInt16(frameOffset(24_000) + 2, true)).toBe(-2000);
    // The person's channel ends at one second, the bot's reply at 1.6 s.
    expect(view.getInt16(frameOffset(15_999), true)).toBe(1000);
    expect(view.getInt16(frameOffset(16_000), true)).toBe(0);
    expect(recording!.durationSeconds).toBeCloseTo(1.6, 6);
  });

  it("leaves small timing jitter alone and queues early frames behind what is there", () => {
    const time = clock();
    const recorder = createStsCallRecorder({ now: time.now });
    time.at(0);
    recorder.write("bot", pcm(1600, 5), RECORDING_SAMPLE_RATE); // 0.1 s
    // The next frame arrives 30 ms late (inside the tolerance) and another arrives early.
    time.at(130);
    recorder.write("bot", pcm(1600, 6), RECORDING_SAMPLE_RATE);
    time.at(10);
    recorder.write("bot", pcm(1600, 7), RECORDING_SAMPLE_RATE);
    const view = new DataView(recorder.stop()!.wav);
    expect(view.getInt16(frameOffset(1600) + 2, true)).toBe(6);
    expect(view.getInt16(frameOffset(3200) + 2, true)).toBe(7);
  });

  it("refuses a frame whose rate disagrees with its track and counts it", () => {
    const recorder = createStsCallRecorder({ now: () => 0 });
    recorder.write("bot", pcm(2400, 1), 24_000);
    recorder.write("bot", pcm(1600, 9), 16_000); // would be mixed in at the wrong speed
    expect(recorder.droppedFrames).toBe(1);
    const recording = recorder.stop();
    // Only the 24 kHz frame (0.1 s) is in the file.
    expect(recording!.durationSeconds).toBeCloseTo(0.1, 3);
  });
});

describe("bounded memory", () => {
  it("refuses frames past the track cap and counts them, keeping what fit", () => {
    const recorder = createStsCallRecorder({ now: () => 0, maxTrackSeconds: 1 });
    recorder.write("user", pcm(RECORDING_SAMPLE_RATE, 1), RECORDING_SAMPLE_RATE); // exactly 1 s
    recorder.write("user", pcm(160, 2), RECORDING_SAMPLE_RATE); // over the cap
    expect(recorder.droppedFrames).toBe(1);
    expect(recorder.stop()!.durationSeconds).toBeCloseTo(1, 6);
  });

  it("does not let a huge clock jump allocate a huge silence block", () => {
    let ms = 0;
    const recorder = createStsCallRecorder({ now: () => ms, maxTrackSeconds: 5 });
    ms = 10 * 60 * 60 * 1000;
    recorder.write("bot", pcm(160, 3), RECORDING_SAMPLE_RATE);
    expect(recorder.droppedFrames).toBe(1);
    expect(recorder.stop()).toBeNull();
  });
});

describe("review follow-ups", () => {
  it("never pads the microphone track: its frames are continuous, so a late one is queued, not split", () => {
    let ms = 0;
    const recorder = createStsCallRecorder({ now: () => ms });
    recorder.write("user", pcm(1600, 1), RECORDING_SAMPLE_RATE);
    ms = 5000; // a late mic frame (scheduling stall)
    recorder.write("user", pcm(1600, 2), RECORDING_SAMPLE_RATE);
    expect(recorder.stop()!.durationSeconds).toBeCloseTo(0.2, 6);
  });

  it("falls back to the default cap for NaN, zero or negative values instead of disabling or discarding", () => {
    for (const bad of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      const recorder = createStsCallRecorder({ now: () => 0, maxTrackSeconds: bad });
      recorder.write("user", pcm(1600, 1), RECORDING_SAMPLE_RATE);
      expect(recorder.droppedFrames).toBe(0);
      expect(recorder.stop()!.durationSeconds).toBeCloseTo(0.1, 6);
    }
  });

  it("counts cap refusals separately from the rate refusals in droppedFrames", () => {
    const recorder = createStsCallRecorder({ now: () => 0, maxTrackSeconds: 1 });
    recorder.write("bot", pcm(24_000, 1), 24_000); // fills the cap
    recorder.write("bot", pcm(240, 1), 24_000); // over the cap
    recorder.write("bot", pcm(160, 1), 16_000); // wrong rate
    expect(recorder.droppedFrames).toBe(2);
    expect(recorder.cappedFrames).toBe(1);
  });

  it("keeps a long provider pause as a silence count and still builds the right file", () => {
    let ms = 0;
    const recorder = createStsCallRecorder({ now: () => ms });
    recorder.write("bot", pcm(160, 4), RECORDING_SAMPLE_RATE);
    ms = 120_000; // two minutes of provider silence
    recorder.write("bot", pcm(160, 9), RECORDING_SAMPLE_RATE);
    const recording = recorder.stop()!;
    expect(recording.durationSeconds).toBeCloseTo(120.01, 3);
    const view = new DataView(recording.wav);
    expect(view.getInt16(frameOffset(0) + 2, true)).toBe(4);
    expect(view.getInt16(frameOffset(160) + 2, true)).toBe(0);
    expect(view.getInt16(frameOffset(120 * RECORDING_SAMPLE_RATE) + 2, true)).toBe(9);
  });
  it("contains a WAV build failure: stop() returns null instead of throwing into teardown", () => {
    const recorder = createStsCallRecorder({
      now: () => 0,
      buildWav: () => {
        throw new RangeError("Array buffer allocation failed");
      },
    });
    recorder.write("user", pcm(1600, 1), RECORDING_SAMPLE_RATE);
    expect(() => recorder.stop()).not.toThrow();
    expect(recorder.stop()).toBeNull();
  });

  it("defaults to the monotonic clock: a wall-clock step does not change the recording", () => {
    const monotonic = vi.spyOn(performance, "now").mockReturnValue(1000);
    const wall = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const recorder = createStsCallRecorder();
      monotonic.mockReturnValue(1000);
      wall.mockReturnValue(10 * 60 * 1000); // the system clock steps forward ten minutes
      recorder.write("bot", pcm(160, 3), RECORDING_SAMPLE_RATE);
      expect(recorder.stop()!.durationSeconds).toBeCloseTo(0.01, 6);
    } finally {
      monotonic.mockRestore();
      wall.mockRestore();
    }
  });
});

describe("stopping", () => {
  it("freezes an empty recorder too, so a late frame cannot create a recording after the call ended", () => {
    const recorder = createStsCallRecorder({ now: () => 0 });
    expect(recorder.stop()).toBeNull();
    recorder.write("user", pcm(160, 5), RECORDING_SAMPLE_RATE);
    expect(recorder.stop()).toBeNull();
    expect(recorder.elapsedSeconds).toBe(0);
  });

  it("keeps reporting the call's length after the raw audio is released", () => {
    const recorder = createStsCallRecorder({ now: () => 0 });
    recorder.write("user", pcm(RECORDING_SAMPLE_RATE, 1), RECORDING_SAMPLE_RATE);
    const recording = recorder.stop();
    expect(recorder.elapsedSeconds).toBeCloseTo(1, 6);
    expect(recorder.stop()).toBe(recording);
  });
});

describe("recordingFileName", () => {
  it("sorts by when the call happened", () => {
    const name = recordingFileName(new Date(2026, 9, 14, 14, 5, 7), "Forge", "c1");
    expect(name).toBe("call-2026-10-14-140507-Forge-c1.wav");
    const earlier = recordingFileName(new Date(2026, 9, 14, 9, 30, 0), "Forge", "c1");
    expect(earlier < name).toBe(true);
  });

  it("strips anything in a bot name that could become a path", () => {
    // A bot name is set by a person, so it cannot be trusted as a file name.
    const name = recordingFileName(new Date(2026, 0, 2, 3, 4, 5), "../../etc/passwd", "c1");
    expect(name).toBe("call-2026-01-02-030405-etc-passwd-c1.wav");
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
  });

  it("falls back to a usable name when the bot name is only punctuation", () => {
    expect(recordingFileName(new Date(2026, 0, 2, 3, 4, 5), "///", "c1")).toBe("call-2026-01-02-030405-bot-c1.wav");
  });

  it("never gives two calls the same name: the call id ends it", () => {
    const at = new Date(2026, 0, 2, 3, 4, 5);
    expect(recordingFileName(at, "Bot", "a1")).not.toBe(recordingFileName(at, "Bot", "b2"));
    // Bot names that normalise to the same text are told apart by the id too.
    expect(recordingFileName(at, "A B", "a1")).not.toBe(recordingFileName(at, "A_B", "b2"));
  });

  it("only uses characters the attachment routes serve (no underscore)", () => {
    const name = recordingFileName(new Date(2026, 0, 2, 3, 4, 5), "Weird_Name!", "id_9");
    expect(name).toMatch(/^[A-Za-z0-9-]+\.[A-Za-z0-9]{1,8}$/);
  });

  it("pads single-digit months, days, hours, minutes and seconds", () => {
    expect(recordingFileName(new Date(2026, 0, 2, 3, 4, 5), "Bot", "c1")).toBe("call-2026-01-02-030405-Bot-c1.wav");
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