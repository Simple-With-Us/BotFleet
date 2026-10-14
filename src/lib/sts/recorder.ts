// Stereo recording for an STS call.
//
// The two sides land on their own channel: **left is the person, right is the
// bot**.  A mono mix is worse than no recording at all for the one thing a
// call recording is actually for, which is working out afterwards who said
// what — and the bot's own audio already reaches the microphone through the
// room, so a mix cannot even tell the two apart reliably.
//
// Both sides arrive as mono PCM16, but **not at the same rate**: the capture
// path resamples the microphone to `STS_INPUT_SAMPLE_RATE` (16 kHz) while the
// providers speak back at their own rate (Gemini is 24 kHz).  One WAV has one
// sample rate, so each track is brought to the file's rate before they are
// interleaved — writing the 24 kHz track in beside 16 kHz audio would play
// the bot fast and an octave high, which is exactly the kind of defect that
// makes a recording useless for hearing what was actually said.
//
// The file is uncompressed WAV on purpose.  This is off by default and exists
// mainly for debugging a call that went wrong; lossless means the recording is
// evidence rather than a lossy copy of it.  It is also the only part of this
// that can be verified without a live microphone, which is worth a lot.  The
// seam below is the place to wrap the result in Opus/WebM later.
//
// Retention is 30 days (`RECORDING_RETENTION_DAYS`).  The person can always
// keep a copy somewhere they choose; this is what BotFleet forgets.

/** Left channel is the person, right channel is the bot. */
export type RecordingSide = "user" | "bot";

/** Sample rate of every frame handed to the recorder, matching the call path. */
export const RECORDING_SAMPLE_RATE = 16_000;

/** How long BotFleet keeps a recording before deleting it on its own. */
export const RECORDING_RETENTION_DAYS = 30;

/** What a finished recording is: a stereo WAV plus enough detail to name it. */
export interface StsRecording {
  /** A complete, playable stereo WAV file. */
  readonly wav: ArrayBuffer;
  /** Seconds of audio, from the frame count rather than a wall clock. */
  readonly durationSeconds: number;
  /** Which side of the file carries which speaker, for the UI to say out loud. */
  readonly channels: { left: RecordingSide; right: RecordingSide };
}

/**
 * A live two-track recording.
 *
 * `write` is called from the audio path, so it must not allocate unboundedly
 * and must never throw into the call: a recording failure degrades to no
 * recording, never to a dropped call.
 */
export interface StsCallRecorder {
  /**
   * Append one mono PCM16 frame to that side's track.
   *
   * `sampleRate` is the rate of *that frame*, which differs per side and per
   * provider; it is recorded so the track can be brought to the file's rate at
   * the end.
   */
  write(side: RecordingSide, pcm: ArrayBuffer, sampleRate?: number): void;
  /** Close both tracks and produce the file. Idempotent. */
  stop(): StsRecording | null;
  /** Seconds written so far, for the in-call readout. */
  readonly elapsedSeconds: number;
}

/**
 * Resample one PCM16 track to the file's rate.
 *
 * Linear interpolation, mirroring `pcm16FromFloat32` on the way in.  It is not
 * a high-quality resampler, and for a debugging recording that is the right
 * trade: a resampler that is wrong in an interesting way costs more than the
 * handful of aliasing artefacts a call about speech will ever show.
 */
export function resamplePcm16(input: Int16Array, from: number, to: number): Int16Array {
  if (from === to || input.length === 0 || from <= 0 || to <= 0) return input;
  const length = Math.max(1, Math.round((input.length * to) / from));
  const out = new Int16Array(length);
  const scale = input.length / length;
  for (let index = 0; index < length; index += 1) {
    const position = index * scale;
    const left = Math.min(input.length - 1, Math.floor(position));
    const right = Math.min(input.length - 1, left + 1);
    const amount = position - left;
    // Integer math so a 16-bit sample never passes through a float that could
    // round a full-scale value into the wrong one.
    out[index] = Math.round(input[left]! * (1 - amount) + input[right]! * amount);
  }
  return out;
}

/**
 * One side of the call, buffered as it arrives.
 *
 * Frames are kept as copies rather than references because the caller reuses
 * its decode buffer between chunks; holding the reference would record
 * whatever the buffer holds later.
 */
class Track {
  private chunks: ArrayBuffer[] = [];

  private samples = 0;

  /** The rate the first frame arrived at; the track's rate for the call. */
  private rate = 0;

  get sampleCount(): number {
    return this.samples;
  }

  /** Seconds of audio in this track, in its own sample rate. */
  get seconds(): number {
    return this.rate > 0 ? this.samples / this.rate : 0;
  }

  append(pcm: ArrayBuffer, sampleRate: number): void {
    if (pcm.byteLength === 0) return;
    // An odd trailing byte is a truncated frame, not a half sample to guess at.
    const usable = pcm.byteLength - (pcm.byteLength % 2);
    if (usable <= 0) return;
    const copy = new ArrayBuffer(usable);
    new Uint8Array(copy).set(new Uint8Array(pcm, 0, usable));
    // The first frame decides the rate.  A later frame at a different rate
    // would be resampled against the wrong denominator, and in practice the
    // provider cannot change rate mid-call, so this only ever records the truth.
    if (this.rate === 0 && sampleRate > 0) this.rate = sampleRate;
    this.chunks.push(copy);
    this.samples += usable / 2;
  }

  /** The track as one contiguous Int16 view. */
  view(): Int16Array {
    const out = new Int16Array(this.samples);
    let offset = 0;
    for (const chunk of this.chunks) {
      const view = new Int16Array(chunk);
      out.set(view, offset);
      offset += view.length;
    }
    return out;
  }

  /** The track at `rate`, brought there from whatever it was captured at. */
  atRate(rate: number): Int16Array {
    return resamplePcm16(this.view(), this.rate || rate, rate);
  }
}

/**
 * Build a stereo WAV from two tracks, padding the shorter one with silence.
 *
 * The tracks are written from separate capture paths, so they are *nearly* the
 * same length and never exactly: a frame can be dropped on either side.  The
 * file has one length, so the short track is padded with zeros at the end
 * rather than truncated — losing the tail of what someone said is worse than
 * a moment of silence, and the tail is the part a debugging recording is for.
 */
export function buildStereoWav(
  user: Int16Array,
  bot: Int16Array,
  sampleRate = RECORDING_SAMPLE_RATE,
): ArrayBuffer {
  const frames = Math.max(user.length, bot.length);
  const bytesPerSample = 2;
  const channelCount = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };

  text(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  // PCM header: 16 bytes of format, then the format itself.
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // 1 = integer PCM, which is what PCM16 is
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  text(36, "data");
  view.setUint32(40, dataBytes, true);

  // Interleaved, left then right, so a player pans each speaker apart.
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    const left = frame < user.length ? user[frame]! : 0;
    const right = frame < bot.length ? bot[frame]! : 0;
    view.setInt16(offset, left, true);
    view.setInt16(offset + 2, right, true);
    offset += 4;
  }
  return buffer;
}

/**
 * Start a stereo recording.  Returns null when there is nothing to record, so
 * the call view can hide the control rather than offer a toggle that does
 * nothing.
 */
export function createStsCallRecorder(): StsCallRecorder {
  const tracks: Record<RecordingSide, Track> = { user: new Track(), bot: new Track() };
  let closed: StsRecording | null = null;

  return {
    write(side, pcm, sampleRate = RECORDING_SAMPLE_RATE) {
      // After stop() the tracks are already frozen into a file; a late frame
      // from a torn-down audio path must not reopen or corrupt them.
      if (closed) return;
      try {
        tracks[side].append(pcm, sampleRate);
      } catch {
        // A recording is never worth failing a call over.
      }
    },
    stop() {
      if (closed) return closed;
      // Both tracks come out at the file's rate, so the interleave is a
      // frame-for-frame alignment in time rather than a coincidence.
      const user = tracks.user.atRate(RECORDING_SAMPLE_RATE);
      const bot = tracks.bot.atRate(RECORDING_SAMPLE_RATE);
      // A call where nobody spoke is not a recording, and an empty WAV would
      // only produce a silent file the person has to open to discover.
      if (user.length === 0 && bot.length === 0) return null;
      const frames = Math.max(user.length, bot.length);
      closed = {
        wav: buildStereoWav(user, bot),
        durationSeconds: frames / RECORDING_SAMPLE_RATE,
        channels: { left: "user", right: "bot" },
      };
      return closed;
    },
    get elapsedSeconds() {
      return Math.max(tracks.user.seconds, tracks.bot.seconds);
    },
  };
}

/**
 * A file name for a recording, safe on every platform and stable enough to sort.
 *
 * The call is named for when it happened rather than a random id: the person
 * looking for a call that went wrong at 2pm wants a 2pm file, and a sortable
 * name is what makes "find it" work without opening each one.
 */
export function recordingFileName(startedAt: Date, botName: string): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp =
    `${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}` +
    `_${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}`;
  // Anything that is not a letter, digit or dash could become a path separator
  // or an extension, and a bot name comes from a person.
  const safeBot = botName.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "bot";
  return `call-${stamp}-${safeBot}.wav`;
}

/** Whether a recording is old enough for BotFleet to delete it. */
export function isPastRetention(recordedAt: Date, now: Date = new Date()): boolean {
  const ageMs = now.getTime() - recordedAt.getTime();
  return ageMs >= RECORDING_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}