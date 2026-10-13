// What the speaker publishes about the reply it is reading, so the message
// on screen can follow along word by word (src/lib/karaoke-session.ts).
//
// It is deliberately not part of the speaker's React snapshot: timing moves
// every frame, and a snapshot change re-renders every useSpeech consumer.
// The feed is imperative instead.  A bubble subscribes once, and the
// highlighter reads the clock from its own requestAnimationFrame loop.
//
// Two shapes, one per engine:
// - "clips" (a hosted voice, one audio clip per utterance): `clips` are the
//   utterances' playback windows on one continuous audio timeline, and
//   `clock()` is the position on it.  A window's duration is an estimate until
//   its clip's metadata arrives, then the real length; later windows shift.
// - "live" (Apple Personal Voice, spoken by the helper): the helper reports
//   each word as it starts, so the feed passes those on as offsets into the
//   spoken text with the time the word started (performance.now() based).
// Either way the feed keeps enough state for a highlighter that attaches
// late (the row mounted mid-reply) to pick up where the voice is.

import type { KaraokeScript } from "../../../shared/spoken-script";

export interface KaraokeClipWindow {
  /** Where the clip's utterance sits in `script.spokenText`. */
  spokenStart: number;
  spokenEnd: number;
  /** When it plays on the clip timeline, in ms. */
  startMs: number;
  durationMs: number;
}

export type KaraokeEndReason = "finished" | "stopped";

export type KaraokeFeedEvent =
  | { type: "clips" }
  | { type: "range"; offset: number; atMs: number }
  | { type: "end"; reason: KaraokeEndReason };

interface FeedBase {
  readonly messageId: string;
  readonly script: KaraokeScript;
  readonly ended: KaraokeEndReason | null;
  subscribe(listener: (event: KaraokeFeedEvent) => void): () => void;
}

export interface KaraokeClipsFeed extends FeedBase {
  readonly mode: "clips";
  readonly clips: readonly KaraokeClipWindow[];
  /** Position on the clip timeline, in ms. */
  clock(): number;
}

export interface KaraokeLiveFeed extends FeedBase {
  readonly mode: "live";
  /** The newest word reported, for a highlighter attaching late. */
  readonly lastRange: { offset: number; atMs: number } | null;
}

export type KaraokeFeed = KaraokeClipsFeed | KaraokeLiveFeed;

class Emitter {
  private readonly listeners = new Set<(event: KaraokeFeedEvent) => void>();
  ended: KaraokeEndReason | null = null;

  subscribe(listener: (event: KaraokeFeedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: KaraokeFeedEvent): void {
    if (this.ended) return;
    if (event.type === "end") this.ended = event.reason;
    // A listener may unsubscribe itself; deleting from a Set mid-iteration
    // is safe.
    for (const listener of this.listeners) listener(event);
  }
}

/** The clips feed and the handle the speaker drives it with. */
export class ClipsKaraoke implements KaraokeClipsFeed {
  readonly mode = "clips" as const;
  readonly messageId: string;
  readonly script: KaraokeScript;
  readonly clips: KaraokeClipWindow[];
  private readonly emitter = new Emitter();
  private audio: { currentTime: number } | null = null;
  private index = -1;
  private held = 0;
  /** Windows whose duration is the clip's real length, not an estimate. */
  private readonly measured = new Set<number>();

  constructor(messageId: string, script: KaraokeScript, clips: KaraokeClipWindow[]) {
    this.messageId = messageId;
    this.script = script;
    this.clips = clips;
  }

  get ended(): KaraokeEndReason | null {
    return this.emitter.ended;
  }

  subscribe(listener: (event: KaraokeFeedEvent) => void): () => void {
    return this.emitter.subscribe(listener);
  }

  clock = (): number => {
    const window = this.clips[this.index];
    if (this.audio && window) {
      const seconds = this.audio.currentTime;
      if (Number.isFinite(seconds) && seconds >= 0) {
        let at = window.startMs + seconds * 1000;
        if (this.measured.has(this.index)) at = Math.min(at, window.startMs + window.durationMs);
        // Never backwards: a seek or a decoder hiccup would replay words.
        if (at > this.held) this.held = at;
      }
    }
    return this.held;
  };

  /** Clip `index` is now the audible one. */
  attach(index: number, audio: { currentTime: number; duration: number }): void {
    this.index = index;
    this.audio = audio;
    const window = this.clips[index];
    if (window && window.startMs > this.held) this.held = window.startMs;
    this.measure(index, audio.duration);
  }

  /** The real length of clip `index` (seconds, as HTMLMediaElement reports
   * it).  Later windows move so each starts where the one before ends. */
  measure(index: number, seconds: number): void {
    const window = this.clips[index];
    if (!window || !Number.isFinite(seconds) || seconds <= 0) return;
    const durationMs = seconds * 1000;
    if (this.measured.has(index) && Math.abs(window.durationMs - durationMs) < 1) return;
    window.durationMs = durationMs;
    this.measured.add(index);
    for (let i = index + 1; i < this.clips.length; i += 1) {
      this.clips[i].startMs = this.clips[i - 1].startMs + this.clips[i - 1].durationMs;
    }
    this.emitter.emit({ type: "clips" });
  }

  /** Clip `index` stopped being audible; the clock holds at its end until
   * the next clip starts. */
  detach(index: number, finished: boolean): void {
    if (index !== this.index) return;
    const window = this.clips[index];
    this.audio = null;
    if (finished && window) this.held = Math.max(this.held, window.startMs + window.durationMs);
  }

  end(reason: KaraokeEndReason): void {
    this.audio = null;
    this.emitter.emit({ type: "end", reason });
  }
}

/** The live feed and the handle the speaker drives it with. */
export class LiveKaraoke implements KaraokeLiveFeed {
  readonly mode = "live" as const;
  readonly messageId: string;
  readonly script: KaraokeScript;
  private readonly emitter = new Emitter();
  private last: { offset: number; atMs: number } | null = null;

  constructor(messageId: string, script: KaraokeScript) {
    this.messageId = messageId;
    this.script = script;
  }

  get ended(): KaraokeEndReason | null {
    return this.emitter.ended;
  }

  get lastRange(): { offset: number; atMs: number } | null {
    return this.last;
  }

  subscribe(listener: (event: KaraokeFeedEvent) => void): () => void {
    return this.emitter.subscribe(listener);
  }

  /** A word starting at `offset` in `script.spokenText`, at `atMs`. */
  range(offset: number, atMs: number): void {
    if (this.emitter.ended || !Number.isFinite(offset) || offset < 0) return;
    this.last = { offset, atMs };
    this.emitter.emit({ type: "range", offset, atMs });
  }

  end(reason: KaraokeEndReason): void {
    this.emitter.emit({ type: "end", reason });
  }
}
