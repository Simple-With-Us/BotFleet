// The player behind a one-file animated avatar.
//
// It owns the whole life of the file: read the bytes, look for the manifest
// inside them, decode frames, follow the plan, and ask for the frame that
// belongs on screen.  React is not involved: the component hands the player a
// surface to paint on and a clock to run on, and the player does the rest.
// That split is what makes the timing rules testable without a browser.
//
// The player never assumes the file is an animated avatar.  A file with no
// manifest, or a browser that cannot hand out single frames, leaves the
// player in the `plain-image` mode, and the component then draws the
// ordinary `<img>` that every existing avatar already uses.

import { extractAvatarManifest, planAvatarSteps, type AvatarManifest } from "../../../shared/avatar-manifest";
import { toManifestBytes } from "./bytes";
import {
  AvatarPlayback,
  fitFrame,
  playbackModeFor,
  type AvatarPlaybackMode,
  type FrameBox,
} from "./playback";

/** One decoded frame, ready to be drawn. */
export interface AvatarFrame {
  /** Which frame of the animation this is. */
  readonly index: number;
  /** Draw this frame into the given box of the 2D context. */
  draw(ctx: CanvasRenderingContext2D, box: FrameBox): void;
  /** Release the frame.  The player closes every frame it hands out. */
  close(): void;
}

/** The frame source: something that can hand out the animation's frames. */
export interface AvatarFrameDecoder {
  /** How many frames the animation has. */
  readonly frameCount: number;
  decode(frameIndex: number): Promise<AvatarFrame>;
  close(): void;
}

/** Where the frames go. */
export interface AvatarFrameSink {
  /** The width of the drawing surface, in device pixels. */
  width(): number;
  /** The height of the drawing surface, in device pixels. */
  height(): number;
  /** Draw one frame.  The player closes it afterwards. */
  paint(frame: AvatarFrame, box: FrameBox): void;
}

export interface AvatarFilePlayerOptions {
  /** Read the file's bytes. */
  loadBytes(src: string): Promise<Uint8Array>;
  /** Make a frame decoder for those bytes, or null when the browser has none. */
  createDecoder(bytes: Uint8Array): Promise<AvatarFrameDecoder | null>;
  /** Where the frames are drawn. */
  sink: AvatarFrameSink;
  /** The clock the player runs on, in milliseconds. */
  now(): number;
  /** Ask for the next tick. */
  schedule(tick: (time: number) => void): number;
  /** Cancel a tick that will not be needed. */
  cancel(handle: number): void;
  /** Told whenever the rendering mode changes. */
  onMode?(mode: AvatarPlaybackMode): void;
  /** Whether the user asked for less motion. */
  reducedMotion?: boolean;
  /** Whether the caller wants the avatar to move at all. */
  animated?: boolean;
}

/**
 * Read the bytes of an avatar file.
 *
 * The avatar is served from the app's own attachment store, so this is a
 * same-origin request for a file the page is allowed to see.
 */
export async function fetchAvatarBytes(src: string): Promise<Uint8Array> {
  const response = await fetch(src);
  if (!response.ok) throw new Error(`avatar request failed with ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

interface ImageDecoderTrackLike {
  frameCount?: number;
}

/** A decoded frame as the browser hands it over: something to draw, and a
 * way to let it go again. */
type DecodedImage = CanvasImageSource & { close?: () => void };

interface ImageDecoderLike {
  tracks: { ready: Promise<void>; selectedTrack?: ImageDecoderTrackLike };
  decode(options: { frameIndex: number }): Promise<{ image: DecodedImage }>;
  close(): void;
}

interface ImageDecoderConstructorLike {
  new (init: { data: Uint8Array; type: string }): ImageDecoderLike;
}

/**
 * The browser's frame decoder.
 *
 * An `<img>` plays a whole animated file and gives no access to its frames,
 * so the only way to draw one frame at a time is WebCodecs' `ImageDecoder`.
 * Chromium has it, and so does Electron, which is the desktop app.  Safari
 * and Firefox do not, and there the avatar falls back to the plain image,
 * which still loops, just without the manifest's transitions.
 *
 * The decoder is created lazily and closed with the player, because a
 * decoder holds the decoded file in memory for as long as it is open.
 */
export async function openImageDecoder(bytes: Uint8Array): Promise<AvatarFrameDecoder | null> {
  // SAFETY: the WebCodecs decoder is a browser global that TypeScript's DOM
  // library does not describe, so the shape it is read through is declared
  // here and the global is read through that shape.
  const ctor = (globalThis as { ImageDecoder?: ImageDecoderConstructorLike }).ImageDecoder;
  if (!ctor) return null;
  let decoder: ImageDecoderLike;
  try {
    decoder = new ctor({ data: bytes, type: "image/webp" });
    await decoder.tracks.ready;
  } catch {
    // A file the decoder will not open is not an avatar this player can play.
    return null;
  }
  const frameCount = decoder.tracks.selectedTrack?.frameCount ?? 0;
  if (!frameCount) {
    try {
      decoder.close();
    } catch {
      // A decoder that is already closed is not a problem.
    }
    return null;
  }
  return {
    frameCount,
    async decode(frameIndex: number): Promise<AvatarFrame> {
      const { image } = await decoder.decode({ frameIndex });
      return {
        index: frameIndex,
        draw(ctx, box) {
          ctx.drawImage(image, box.x, box.y, box.width, box.height);
        },
        close() {
          image.close?.();
        },
      };
    },
    close() {
      try {
        decoder.close();
      } catch {
        // A decoder that is already closed is not a problem.
      }
    },
  };
}

/**
 * The player.
 *
 * The state machine is small on purpose:
 *
 *   plain-image  the file has no manifest, or the browser cannot decode
 *                frames: the component draws the ordinary image
 *   still-frame  a manifest avatar that must not move: the resting frame
 *   animated     the manifest's transitions and holds, frame by frame
 */
export class AvatarFilePlayer {
  private readonly options: AvatarFilePlayerOptions;
  private manifest: AvatarManifest | null = null;
  private decoder: AvatarFrameDecoder | null = null;
  /** Whether the browser can hand out frames, even while the decoder is closed. */
  private canDecode = false;
  /** The file's bytes, kept so the decoder can be opened again. */
  private bytes: Uint8Array | null = null;
  private mode: AvatarPlaybackMode = "plain-image";
  private reducedMotion: boolean;
  private animated: boolean;
  private state: string | null = null;
  private playback: AvatarPlayback | null = null;
  /** The state the current plan was built for, which is where a return goes. */
  private planState: string | null = null;
  private handle: number | null = null;
  private visible = true;
  private hiddenAt: number | null = null;
  private lastFrame = -1;
  private decoding = false;
  private pendingFrame: number | null = null;
  private disposed = false;

  constructor(options: AvatarFilePlayerOptions) {
    this.options = options;
    this.reducedMotion = options.reducedMotion ?? false;
    this.animated = options.animated ?? true;
  }

  /** The way the avatar is being rendered right now. */
  get currentMode(): AvatarPlaybackMode {
    return this.mode;
  }

  /**
   * Read the file and work out what it is.
   *
   * A file with no manifest is not an error: it is an ordinary image, and the
   * component keeps drawing it the way it always has.
   */
  async load(src: string): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = await this.options.loadBytes(src);
    } catch {
      // The file could not be read.  The plain image path reports the
      // failure through the image itself, so there is nothing to do here.
      return;
    }
    if (this.disposed) return;
    const manifest = extractAvatarManifest(toManifestBytes(bytes));
    if (!manifest) return;
    this.manifest = manifest;
    // The bytes are kept because they are far smaller than the decoded frames
    // and the decoder has to be opened again every time the avatar comes back
    // on screen.
    this.bytes = bytes;
    const decoder = await this.options.createDecoder(bytes);
    if (this.disposed) {
      decoder?.close();
      return;
    }
    if (!decoder) {
      // The browser cannot hand out single frames.  The file still plays, as
      // one looping image, which is the plain-image path.
      return;
    }
    this.decoder = decoder;
    this.canDecode = true;
    this.applyMode();
  }

  /** The bot's live state.  A change replays the plan for the new state. */
  setState(state: string): void {
    if (this.state === state) return;
    this.state = state;
    if (this.mode !== "animated") return;
    // The plan is rebuilt from the state it was playing, so the leaving
    // state's return transition plays before the arriving state's enter.
    this.rebuildPlan(this.planState);
  }

  /** Whether the caller wants the avatar to move at all. */
  setAnimated(animated: boolean): void {
    if (this.animated === animated) return;
    this.animated = animated;
    this.applyMode();
  }

  /** Whether the user asked for less motion. */
  setReducedMotion(reducedMotion: boolean): void {
    if (this.reducedMotion === reducedMotion) return;
    this.reducedMotion = reducedMotion;
    this.applyMode();
  }

  /**
   * Whether the avatar is on screen.
   *
   * An avatar that is not on screen is not animated, which is the point:
   * a list of rows that all animate at once is the app's oldest performance
   * scar, and the sidebar's rows already pass `animated={isWorking}` for
   * exactly that reason.
   */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (!visible) {
      this.hiddenAt = this.options.now();
      this.stopLoop();
      // The decoder holds the file in memory for as long as it is open, and
      // an avatar that is off screen is not drawing anything.  The bytes are
      // kept, so the decoder is cheap to open again when the avatar comes
      // back.
      this.releaseDecoder();
      return;
    }
    const hiddenAt = this.hiddenAt;
    this.hiddenAt = null;
    // The plan may have been rebuilt while the avatar was away, so the skip
    // starts at the later of the two moments and the clock cannot end up in
    // the future.
    if (hiddenAt !== null) this.playback?.skipHidden(hiddenAt, this.options.now());
    // A still avatar has nothing to animate, so it gets no loop.
    if (this.mode === "animated" && this.decoder) this.startLoop();
    void this.restoreDecoder();
  }

  /**
   * Open the decoder again after the avatar came back on screen.
   *
   * The decoder was given back when the avatar went off screen, so it has to
   * be opened again before anything can be drawn.  A browser that will not
   * hand out frames any more is the plain-image path, which is where the
   * file has always played when it cannot be taken apart.
   */
  private async restoreDecoder(): Promise<void> {
    if (this.disposed || this.decoder) return;
    const bytes = this.bytes;
    if (!bytes) return;
    const decoder = await this.options.createDecoder(bytes);
    if (this.disposed) {
      decoder?.close();
      return;
    }
    if (!decoder) {
      this.canDecode = false;
      this.applyMode();
      return;
    }
    this.decoder = decoder;
    this.canDecode = true;
    if (this.mode === "still-frame") {
      this.requestFrame(this.manifest?.restingFrame ?? 0);
      return;
    }
    if (this.mode === "animated") this.startLoop();
  }

  /** Give the decoder back, because it holds the file in memory while it is open. */
  private releaseDecoder(): void {
    const decoder = this.decoder;
    if (!decoder) return;
    this.decoder = null;
    decoder.close();
  }

  /** Draw the current frame again, after the surface changed. */
  repaint(): void {
    if (this.mode === "still-frame") {
      this.requestFrame(this.manifest?.restingFrame ?? 0);
      return;
    }
    const playback = this.playback;
    if (!playback) {
      this.lastFrame = -1;
      return;
    }
    // The frame is marked as drawn before it is asked for, so the tick that
    // follows does not decode the same frame a second time.
    const frame = playback.frame(this.options.now());
    this.lastFrame = frame;
    this.requestFrame(frame);
  }

  /** Stop everything and release the decoder. */
  dispose(): void {
    this.disposed = true;
    this.stopLoop();
    this.releaseDecoder();
    this.canDecode = false;
    this.bytes = null;
    this.manifest = null;
    this.playback = null;
  }

  private computeMode(): AvatarPlaybackMode {
    return playbackModeFor({
      hasManifest: this.manifest !== null,
      hasDecoder: this.canDecode,
      reducedMotion: this.reducedMotion,
      animated: this.animated,
    });
  }

  private applyMode(): void {
    const next = this.computeMode();
    if (next === this.mode) return;
    this.mode = next;
    this.options.onMode?.(next);
    if (next === "plain-image") {
      this.stopLoop();
      return;
    }
    if (next === "still-frame") {
      this.stopLoop();
      this.requestFrame(this.manifest?.restingFrame ?? 0);
      return;
    }
    this.rebuildPlan(null);
  }

  /**
   * Build the plan and start playing it.
   *
   * `from` is the state the plan starts from: the state the avatar is
   * leaving, so its return transition plays, or null for a fresh start.
   */
  private rebuildPlan(from: string | null): void {
    const manifest = this.manifest;
    if (!manifest) return;
    const steps = planAvatarSteps(manifest, from, this.state ?? "idle");
    this.playback = new AvatarPlayback(steps, manifest.frame.delayMs, this.options.now());
    this.planState = this.state;
    this.lastFrame = -1;
    this.startLoop();
  }

  private startLoop(): void {
    if (this.handle !== null || this.disposed) return;
    if (!this.visible) return;
    if (!this.playback) return;
    this.handle = this.options.schedule(this.tick);
  }

  private stopLoop(): void {
    if (this.handle === null) return;
    this.options.cancel(this.handle);
    this.handle = null;
  }

  private tick = (time: number): void => {
    this.handle = null;
    if (this.disposed) return;
    const playback = this.playback;
    if (!playback) return;
    playback.advance(time);
    const frame = playback.frame(time);
    if (frame !== this.lastFrame) {
      this.lastFrame = frame;
      this.requestFrame(frame);
    }
    // A settled step has nothing left to animate, so the loop stops rather
    // than asking for frames that would draw the same picture.
    if (playback.settled || !this.visible) {
      this.stopLoop();
      return;
    }
    this.handle = this.options.schedule(this.tick);
  };

  /**
   * Ask for a frame to be drawn.
   *
   * Decoding is asynchronous and the tick is not, so only one decode is in
   * flight at a time and the newest request wins.  A frame that takes longer
   * than its delay to decode is dropped rather than queued, because a queue
   * of stale frames is how an avatar ends up playing behind itself.
   */
  private requestFrame(frameIndex: number): void {
    this.pendingFrame = frameIndex;
    if (this.decoding) return;
    this.decoding = true;
    void (async () => {
      try {
        while (this.pendingFrame !== null && !this.disposed) {
          const next = this.pendingFrame;
          this.pendingFrame = null;
          await this.drawFrame(next);
        }
      } finally {
        this.decoding = false;
      }
    })().catch((error) => {
      // A decode that rejects must not become an unhandled rejection: the
      // avatar keeps the last frame it managed to draw, and the queue is
      // emptied so a later tick starts from a clean state.
      this.pendingFrame = null;
      console.warn("avatar frame could not be decoded", error);
    });
  }

  private async drawFrame(frameIndex: number): Promise<void> {
    const decoder = this.decoder;
    const manifest = this.manifest;
    if (!decoder || !manifest) return;
    try {
      // The decoder knows how many frames the file really has, and that is the
      // authority: the manifest says how many it should have, and a file that
      // was rebuilt or re-encoded can differ.  Asking for a frame past the
      // end is refused by the decoder, and the avatar would sit on the last
      // picture it managed to draw, so the request is clamped instead.
      const last = Math.max(0, decoder.frameCount - 1);
      const frame = await decoder.decode(Math.min(Math.max(0, frameIndex), last));
      try {
        const box = fitFrame(
          manifest.frame.width,
          manifest.frame.height,
          this.options.sink.width(),
          this.options.sink.height(),
        );
        this.options.sink.paint(frame, box);
      } finally {
        frame.close();
      }
    } catch {
      // A frame that will not decode leaves the last one on screen.  The
      // avatar is still an avatar; it just does not move.
    }
  }
}
