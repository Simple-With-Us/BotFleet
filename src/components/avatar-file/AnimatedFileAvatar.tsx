// The avatar that plays a one-file animated file.
//
// A bot's avatar used to be either the mascot, a TV-Face pack, or an image.
// The new third shape is ONE animated file that carries its own manifest
// inside it, saying which frame ranges are the enter transition, the looping
// hold and the return transition.  This component is the client half of that:
// it reads the file, and if the file carries a manifest it plays the manifest.
//
// The manifest is an upgrade, never a requirement.  Every animated GIF and
// WebP avatar that exists today has no manifest, so the default path here is
// the plain `<img>` the app has always drawn, and it stays that way until the
// file proves it is something more.

import { useEffect, useRef, useState } from "react";

import type { AvatarPlaybackMode } from "./playback";
import {
  AvatarFilePlayer,
  fetchAvatarBytes,
  openImageDecoder,
  type AvatarFrameDecoder,
} from "./player";

/**
 * Whether the system asked for less motion.
 *
 * Read once, the way the SVG mascot reads it: the setting is an operating
 * system preference, and a user who turns it on expects the app to have
 * noticed by the next avatar they look at, not on every re-render.
 */
function defaultPrefersReducedMotion(): boolean {
  return globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export interface AnimatedFileAvatarProps {
  /** The attachment URL of the avatar file. */
  src: string;
  /** The bot's live state.  The manifest names the frames for each state. */
  state?: string;
  /** The size of the avatar in CSS pixels. */
  size: number;
  /** The accessible name of the avatar. */
  alt: string;
  /** The corner radius, matching the other crops. */
  radius?: string;
  /** False when the caller wants a still, which is what an idle row asks for. */
  animated?: boolean;
  /** Called when the file cannot be loaded at all. */
  onError?: () => void;
  /** How the file's bytes are read.  A seam, so the tests need no network. */
  loadBytes?: (src: string) => Promise<Uint8Array>;
  /** How the frames are decoded.  A seam, so the tests need no browser. */
  createDecoder?: (bytes: Uint8Array) => Promise<AvatarFrameDecoder | null>;
  /** Whether the user asked for less motion. */
  prefersReducedMotion?: () => boolean;
}

export function AnimatedFileAvatar({
  src,
  state = "idle",
  size,
  alt,
  radius = "0",
  animated = true,
  onError,
  loadBytes = fetchAvatarBytes,
  createDecoder = openImageDecoder,
  prefersReducedMotion = defaultPrefersReducedMotion,
}: AnimatedFileAvatarProps) {
  const [mode, setMode] = useState<AvatarPlaybackMode>("plain-image");
  const playerRef = useRef<AvatarFilePlayer | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // The state and the animation flag change while the avatar is on screen,
  // and neither should reload the file.  They are read through refs so the
  // file is fetched once and the changes are pushed into the player instead.
  const stateRef = useRef(state);
  stateRef.current = state;
  const animatedRef = useRef(animated);
  animatedRef.current = animated;
  const loadBytesRef = useRef(loadBytes);
  loadBytesRef.current = loadBytes;
  const createDecoderRef = useRef(createDecoder);
  createDecoderRef.current = createDecoder;

  // Reduced motion is a setting, not a value that changes under the avatar.
  const reducedMotionRef = useRef<boolean | null>(null);
  if (reducedMotionRef.current === null) reducedMotionRef.current = prefersReducedMotion();
  const reducedMotion = reducedMotionRef.current;

  useEffect(() => {
    const player = new AvatarFilePlayer({
      loadBytes: (url) => loadBytesRef.current(url),
      createDecoder: (bytes) => createDecoderRef.current(bytes),
      reducedMotion,
      animated: animatedRef.current,
      sink: {
        width: () => canvasRef.current?.width ?? 0,
        height: () => canvasRef.current?.height ?? 0,
        paint: (frame, box) => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          frame.draw(ctx, box);
        },
      },
      now: () => globalThis.performance?.now() ?? Date.now(),
      schedule: (tick) => requestAnimationFrame(tick),
      cancel: (handle) => cancelAnimationFrame(handle),
      onMode: (next) => setMode(next),
    });
    playerRef.current = player;
    player.setState(stateRef.current);
    void player.load(src);
    return () => {
      player.dispose();
      if (playerRef.current === player) playerRef.current = null;
    };
  }, [src, reducedMotion]);

  useEffect(() => {
    playerRef.current?.setState(state);
  }, [state]);

  useEffect(() => {
    playerRef.current?.setAnimated(animated);
  }, [animated]);

  // The canvas is a new surface, so the frame that belongs on it has to be
  // drawn again: the still frame and the first frame of a plan are both
  // painted before this canvas existed.
  useEffect(() => {
    if (mode === "plain-image") return;
    playerRef.current?.repaint();
  }, [mode]);

  // An avatar that is not on screen is not animated.  This is the oldest
  // performance scar in the app: a list of rows that all animate at once
  // burns visible-idle CPU, which is why the sidebar's rows already pass
  // `animated={isWorking}`.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // A browser without IntersectionObserver cannot tell when the avatar is
    // off screen, so it stays animated: the caller still decides whether the
    // avatar moves at all.
    const Observer = globalThis.IntersectionObserver;
    if (!Observer) return;
    const observer = new Observer((entries) => {
      for (const entry of entries) playerRef.current?.setVisible(entry.isIntersecting);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [mode]);

  if (mode === "plain-image") {
    // The ordinary image path, exactly as the app has always drawn it.  A
    // file with no manifest, and a browser that cannot decode single frames,
    // both land here and both keep working.
    return (
      <img
        src={src}
        alt={alt}
        width={size}
        height={size}
        draggable={false}
        onError={onError}
        className="block shrink-0 bg-raised object-cover"
        style={{ width: size, height: size, borderRadius: radius }}
      />
    );
  }

  // The canvas is drawn in device pixels and sized in CSS pixels, so the
  // avatar stays sharp on a retina screen without changing its layout.
  const scale = Math.min(globalThis.devicePixelRatio ?? 1, 2);
  const pixels = Math.max(1, Math.round(size * scale));
  return (
    <canvas
      ref={canvasRef}
      width={pixels}
      height={pixels}
      role="img"
      aria-label={alt}
      draggable={false}
      className="block shrink-0 bg-raised"
      style={{ width: size, height: size, borderRadius: radius }}
    />
  );
}
