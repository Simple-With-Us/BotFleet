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

/**
 * A side that has been silent for longer than this is padded with silence up to
 * the moment its next frame arrived.  Smaller gaps are timing jitter between
 * frames and are left alone, so the audio is not chopped up; the two sides can
 * therefore differ by up to this much in the file.
 */
const MAX_UNPADDED_GAP_SECONDS = 0.1;

/** Whether this machine stores a 16-bit sample low byte first, as a WAV file does. */
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

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
   * `sampleRate` is required and is the rate of *that frame*, which differs per
   * side and per provider (the microphone is 16 kHz, Gemini speaks at 24 kHz).
   * The first frame sets the track's rate; a later frame at another rate is
   * refused and counted in `droppedFrames`, because it would be mixed in at the
   * wrong speed.  Frames are placed on a shared clock (see
   * `createStsCallRecorder`): the bot track, which only has frames while the
   * provider speaks, is padded with silence after a pause so it does not slide
   * earlier than the always-on microphone track.
   */
  write(side: RecordingSide, pcm: ArrayBuffer, sampleRate: number): void;
  /** Close both tracks and produce the file. Idempotent. */
  stop(): StsRecording | null;
  /** Every frame refused: a bad or disagreeing sample rate, or a track at its cap. */
  readonly droppedFrames: number;
  /** The part of `droppedFrames` refused because the track had reached its cap. */
  readonly cappedFrames: number;
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

/** Longest a single track may grow: one hour, about 115 MB at 16 kHz and 173 MB at 24 kHz. */
export const MAX_TRACK_SECONDS = 3600;

type AppendResult = "ok" | "rate" | "cap";

/**
 * One side of the call, buffered as it arrives.
 *
 * Frames are kept as copies rather than references because the caller reuses
 * its decode buffer between chunks; holding the reference would record
 * whatever the buffer holds later.
 */
class Track {
  /**
   * `padGaps` is true for a track that only has frames while someone is
   * speaking (the provider's audio).  The microphone forwards every captured
   * frame, so it is continuous and is never padded: padding it would split the
   * person's speech on rounding jitter.
   */
  constructor(
    private readonly maxSeconds: number,
    private readonly padGaps: boolean,
  ) {}

  /** Audio frames, or a number of silent samples that is never materialised. */
  private chunks: Array<ArrayBuffer | number> = [];

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

  /**
   * Add one frame that arrived `atSeconds` after the recording started.
   * Returns false when the frame was refused for disagreeing with the track's
   * rate.  Silence is inserted first when the frame arrives well after the
   * audio already held ends, so the track stays on the shared clock; a frame
   * that arrives early (a provider sending faster than real time) simply
   * queues behind what is there, the way playback does.
   */
  append(pcm: ArrayBuffer, sampleRate: number, atSeconds: number): AppendResult {
    if (pcm.byteLength === 0) return "ok";
    // An odd trailing byte is a truncated frame, not a half sample to guess at.
    const usable = pcm.byteLength - (pcm.byteLength % 2);
    if (usable <= 0) return "ok";
    if (!(sampleRate > 0)) return "rate";
    // The first frame decides the rate.  A frame at another rate would be
    // resampled against the wrong denominator, so it is refused, not mixed in.
    if (this.rate !== 0 && sampleRate !== this.rate) return "rate";
    const rate = this.rate === 0 ? sampleRate : this.rate;
    const target = Math.round(Math.max(0, atSeconds) * rate);
    const gap = target - this.samples;
    const padding = this.padGaps && gap > rate * MAX_UNPADDED_GAP_SECONDS ? gap : 0;
    // Bounded memory: past the cap the frame is refused (and counted), so a call
    // that never ends cannot grow the recording without limit.
    if ((this.samples + padding + usable / 2) / rate > this.maxSeconds) return "cap";
    const copy = new ArrayBuffer(usable);
    new Uint8Array(copy).set(new Uint8Array(pcm, 0, usable));
    if (this.rate === 0) this.rate = sampleRate;
    if (padding > 0) {
      // Silence is a count, not a buffer: a long pause costs nothing until the file is built.
      this.chunks.push(padding);
      this.samples += padding;
    }
    this.chunks.push(copy);
    this.samples += usable / 2;
    return "ok";
  }

  /** The track as one contiguous Int16 view. */
  view(): Int16Array {
    const out = new Int16Array(this.samples);
    let offset = 0;
    for (const chunk of this.chunks) {
      if (typeof chunk === "number") {
        offset += chunk; // already zero
        continue;
      }
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

  /** Drop the buffered frames once the file exists; the counts stay for the readout. */
  release(): void {
    this.chunks = [];
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
  if (LITTLE_ENDIAN) {
    // The data starts at byte 44, which is 2-byte aligned, so a typed view fills it directly.
    const samples = new Int16Array(buffer, 44, frames * channelCount);
    for (let frame = 0; frame < frames; frame += 1) {
      samples[frame * 2] = frame < user.length ? user[frame]! : 0;
      samples[frame * 2 + 1] = frame < bot.length ? bot[frame]! : 0;
    }
  } else {
    let offset = 44;
    for (let frame = 0; frame < frames; frame += 1) {
      view.setInt16(offset, frame < user.length ? user[frame]! : 0, true);
      view.setInt16(offset + 2, frame < bot.length ? bot[frame]! : 0, true);
      offset += 4;
    }
  }
  return buffer;
}

/** Monotonic where available, so a system clock step cannot become silence or rejected audio. */
function defaultClock(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

/**
 * Start a stereo recording.
 *
 * Both tracks are placed on one clock that starts here, so the person's speech
 * and the bot's reply line up in the file the way they happened.  `now` is that
 * clock in milliseconds and exists so tests can drive it.
 */
export function createStsCallRecorder(options: { now?: () => number; maxTrackSeconds?: number } = {}): StsCallRecorder {
  const now = options.now ?? defaultClock;
  const origin = now();
  const requestedCap = options.maxTrackSeconds;
  // A NaN, zero or negative cap would either disable the limit or discard every frame.
  const maxTrackSeconds =
    requestedCap !== undefined && Number.isFinite(requestedCap) && requestedCap > 0 ? requestedCap : MAX_TRACK_SECONDS;
  const tracks: Record<RecordingSide, Track> = { user: new Track(maxTrackSeconds, false), bot: new Track(maxTrackSeconds, true) };
  let closed: StsRecording | null = null;
  let stopped = false;
  let dropped = 0;
  let capped = 0;

  return {
    write(side, pcm, sampleRate) {
      // After stop() the call is over, whether or not anything was recorded; a
      // late frame from a torn-down audio path must not reopen the recording.
      if (stopped) return;
      try {
        const result = tracks[side].append(pcm, sampleRate, (now() - origin) / 1000);
        if (result !== "ok") dropped += 1;
        if (result === "cap") capped += 1;
      } catch {
        // A recording is never worth failing a call over.
      }
    },
    stop() {
      if (stopped) return closed;
      stopped = true;
      try {
        // Both tracks come out at the file's rate, so the interleave is a
        // frame-for-frame alignment in time rather than a coincidence.
        const user = tracks.user.atRate(RECORDING_SAMPLE_RATE);
        const bot = tracks.bot.atRate(RECORDING_SAMPLE_RATE);
        // The raw chunks are no longer needed: view() and the resample made
        // independent copies.  Releasing them before the WAV is allocated keeps
        // the peak at the two tracks plus the file, not the raw chunks as well.
        tracks.user.release();
        tracks.bot.release();
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
      } catch {
        // A failed build (for example an allocation error) must not escape into
        // call teardown.  The raw audio is already released, so this recording
        // is lost; later stop() calls answer null rather than retrying.
        return null;
      }
    },
    get droppedFrames() {
      return dropped;
    },
    get cappedFrames() {
      return capped;
    },
    get elapsedSeconds() {
      return Math.max(tracks.user.seconds, tracks.bot.seconds);
    },
  };
}

/**
 * A file name for a recording, safe on every platform and stable enough to sort.
 *
 * The call is named for when it happened (to the second) rather than a random
 * id: the person looking for a call that went wrong at 2pm wants a 2pm file,
 * and a sortable name is what makes "find it" work without opening each one.
 * The call's own id ends the name, so two calls in the same second, or with bot
 * names that normalise to the same text, never share a file.  Only letters,
 * digits and dashes are used, which is what the attachment routes serve.
 */
export function recordingFileName(startedAt: Date, botName: string, callId: string): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const stamp =
    `${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}` +
    `-${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}${pad(startedAt.getSeconds())}`;
  // Anything that is not a letter, digit or dash could become a path separator
  // or an extension, and a bot name comes from a person.
  const clean = (value: string) => value.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const safeBot = clean(botName) || "bot";
  const safeId = clean(callId).slice(0, 24) || pad(startedAt.getMilliseconds(), 3);
  return `call-${stamp}-${safeBot}-${safeId}.wav`;
}

/** Whether a recording is old enough for BotFleet to delete it. */
export function isPastRetention(recordedAt: Date, now: Date = new Date()): boolean {
  const ageMs = now.getTime() - recordedAt.getTime();
  return ageMs >= RECORDING_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}