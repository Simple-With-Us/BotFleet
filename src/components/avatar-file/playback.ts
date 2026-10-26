// The timing rules of a one-file animated avatar.
//
// The manifest says which frame ranges are the enter transition, the looping
// hold and the return transition, and `planAvatarSteps` turns a state change
// into an ordered list of steps.  This module owns the other half: which
// frame of the current step belongs on screen at a given moment, and when the
// plan moves on to the next step.
//
// It is deliberately free of React, the DOM and WebCodecs, so the rules can be
// read and tested by hand.  The player that draws frames asks this module
// what to draw and does nothing else.

import type { AvatarStep } from "../../../shared/avatar-manifest";

/**
 * How the avatar renders.
 *
 * `plain-image` is the ordinary `<img>` path: a file with no manifest, or a
 * browser that cannot hand out single frames.  `still-frame` is a manifest
 * avatar held on its resting frame, which is what reduced motion and an idle
 * caller ask for.  `animated` is the frame-by-frame player.
 */
export type AvatarPlaybackMode = "plain-image" | "still-frame" | "animated";

/** Where a frame lands on the surface it is drawn on, in device pixels. */
export interface FrameBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How many frames a step covers.  Ranges are inclusive on both ends. */
export function stepFrameCount(step: AvatarStep): number {
  return Math.max(1, step.range.to - step.range.from + 1);
}

/** How long one pass of a step lasts, in milliseconds. */
export function stepDurationMs(step: AvatarStep, delayMs: number): number {
  return stepFrameCount(step) * Math.max(1, delayMs);
}

/**
 * The frame a step shows `elapsedMs` into it.
 *
 * A `once` step holds its last frame when it runs out, so the transition ends
 * on its final pose instead of snapping back.  A `loop` step wraps around to
 * its first frame.
 */
export function frameForStep(step: AvatarStep, elapsedMs: number, delayMs: number): number {
  const count = stepFrameCount(step);
  if (count <= 1) return step.range.from;
  const tick = Math.floor(Math.max(0, elapsedMs) / Math.max(1, delayMs));
  if (step.mode === "once") return step.range.from + Math.min(tick, count - 1);
  return step.range.from + (tick % count);
}

/**
 * A step with a single frame has nothing to animate.
 *
 * The plan's resting step is exactly this: the manifest's resting frame, on
 * its own.  A player that keeps a requestAnimationFrame loop alive for it
 * would burn a frame of CPU per avatar for a picture that never changes.
 */
export function isSettledStep(step: AvatarStep): boolean {
  return stepFrameCount(step) <= 1;
}

/**
 * Which way the avatar renders, given what is known about the file and the
 * caller.
 *
 * The order matters: a file with no manifest is not an animated avatar at
 * all, and a browser that cannot decode single frames cannot animate one
 * however good the manifest is.  Both fall back to the plain image, which is
 * exactly what every existing animated GIF or WebP avatar does today.
 */
export function playbackModeFor(input: {
  hasManifest: boolean;
  hasDecoder: boolean;
  reducedMotion: boolean;
  animated: boolean;
}): AvatarPlaybackMode {
  if (!input.hasManifest || !input.hasDecoder) return "plain-image";
  if (input.reducedMotion || !input.animated) return "still-frame";
  return "animated";
}

/**
 * Fit an animation's own frame size into the square the avatar is drawn in.
 *
 * The fit is "contain": the whole frame is visible and the leftover space is
 * left empty, because cropping a character's arms off is worse than a little
 * empty margin.
 */
export function fitFrame(
  frameWidth: number,
  frameHeight: number,
  boxWidth: number,
  boxHeight: number,
): FrameBox {
  if (frameWidth <= 0 || frameHeight <= 0 || boxWidth <= 0 || boxHeight <= 0) {
    return { x: 0, y: 0, width: Math.max(0, boxWidth), height: Math.max(0, boxHeight) };
  }
  const scale = Math.min(boxWidth / frameWidth, boxHeight / frameHeight);
  const width = frameWidth * scale;
  const height = frameHeight * scale;
  return {
    x: (boxWidth - width) / 2,
    y: (boxHeight - height) / 2,
    width,
    height,
  };
}

/**
 * The playback cursor: where in the plan we are, and which frame is up.
 *
 * The cursor owns the clock.  It is told the time, it moves through the
 * plan's `once` steps as they finish, and it reports the frame that belongs
 * on screen.  Keeping it separate from the drawing code is what makes the
 * transition timing testable without a browser.
 */
export class AvatarPlayback {
  private index = 0;
  private startedAt: number;

  constructor(
    private readonly steps: AvatarStep[],
    private readonly delayMs: number,
    startAt = 0,
  ) {
    this.startedAt = startAt;
  }

  /** The step that is playing right now, or null once the plan is spent. */
  get step(): AvatarStep | null {
    return this.steps[this.index] ?? null;
  }

  /** How far into the step we are, in milliseconds. */
  elapsed(now: number): number {
    return Math.max(0, now - this.startedAt);
  }

  /**
   * True when the current step cannot animate any further.
   *
   * A single-frame step is settled, and so is the end of the plan: there is
   * nothing left to draw, and the caller can stop asking for frames.
   */
  get settled(): boolean {
    const step = this.step;
    return step === null || isSettledStep(step);
  }

  /**
   * Move to `now`, crossing the `once` steps that finished on the way.
   *
   * The step's own start time moves with it, so the time that passed inside a
   * step is not lost when the plan moves to the next one.
   */
  advance(now: number): void {
    // The plan is short (a return, an enter and a hold), so a bounded walk
    // is enough and keeps a malformed plan from spinning here.
    for (let guard = 0; guard <= this.steps.length; guard += 1) {
      const step = this.step;
      if (!step || step.mode !== "once") return;
      const duration = stepDurationMs(step, this.delayMs);
      if (now - this.startedAt < duration) return;
      this.startedAt += duration;
      this.index += 1;
    }
  }

  /**
   * The frame that belongs on screen at `now`.
   *
   * A spent plan holds on its last frame, so a plan that ends does not blank
   * the avatar.
   */
  frame(now: number): number {
    const step = this.step;
    if (!step) {
      const last = this.steps[this.steps.length - 1];
      if (!last) return 0;
      return frameForStep(last, stepDurationMs(last, this.delayMs), this.delayMs);
    }
    return frameForStep(step, this.elapsed(now), this.delayMs);
  }

  /**
   * Push the clock forward without playing.
   *
   * An avatar that scrolls out of view stops being animated, and when it
   * comes back it must not have jumped forward by however long it was gone.
   */
  skip(ms: number): void {
    if (ms > 0) this.startedAt += ms;
  }
}
