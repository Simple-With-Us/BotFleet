// The timing rules of a one-file animated avatar.
//
// These are the rules the player is built on, and they are checked here
// rather than through the DOM: the frame that belongs on screen at a given
// moment, the plan moving from a transition to a hold, and the branch that
// decides whether the avatar animates at all.  A change to any of them
// changes what a user sees, and the only cheap way to notice is to say what
// the rule is in a test.

import { describe, expect, it } from "vitest";

import type { AvatarStep } from "../../../shared/avatar-manifest";
import {
  AvatarPlayback,
  fitFrame,
  frameForStep,
  isSettledStep,
  playbackModeFor,
  stepDurationMs,
  stepFrameCount,
} from "./playback";

/** A transition that plays once, three frames long. */
const ENTER: AvatarStep = { range: { from: 4, to: 6 }, mode: "once", reason: "enter" };
/** A transition that lands on a single pose, one frame long. */
const ENTER_ONE: AvatarStep = { range: { from: 4, to: 4 }, mode: "once", reason: "enter" };
/** A hold that loops forever, four frames long. */
const HOLD: AvatarStep = { range: { from: 0, to: 3 }, mode: "loop", reason: "hold" };
/** The static resting frame a plan falls back to. */
const RESTING: AvatarStep = { range: { from: 2, to: 2 }, mode: "loop", reason: "resting" };

describe("frameForStep", () => {
  it("shows the first frame of a transition at the start", () => {
    expect(frameForStep(ENTER, 0, 100)).toBe(4);
  });

  it("advances one frame per delay", () => {
    expect(frameForStep(ENTER, 100, 100)).toBe(5);
    expect(frameForStep(ENTER, 199, 100)).toBe(5);
    expect(frameForStep(ENTER, 200, 100)).toBe(6);
  });

  it("holds the last frame of a transition that has run out", () => {
    // The transition ends on its final pose instead of snapping back to the
    // first one, which is what makes an enter read as an enter.
    expect(frameForStep(ENTER, 5000, 100)).toBe(6);
  });

  it("wraps a looping range back to its first frame", () => {
    expect(frameForStep(HOLD, 0, 100)).toBe(0);
    expect(frameForStep(HOLD, 300, 100)).toBe(3);
    expect(frameForStep(HOLD, 400, 100)).toBe(0);
    expect(frameForStep(HOLD, 750, 100)).toBe(3);
  });

  it("keeps a single-frame range on that frame", () => {
    expect(frameForStep(RESTING, 0, 100)).toBe(2);
    expect(frameForStep(RESTING, 5000, 100)).toBe(2);
  });
});

describe("step measurements", () => {
  it("counts the frames of an inclusive range", () => {
    expect(stepFrameCount(ENTER)).toBe(3);
    expect(stepFrameCount(HOLD)).toBe(4);
    expect(stepFrameCount(RESTING)).toBe(1);
  });

  it("times a step by its frame count and the manifest's delay", () => {
    expect(stepDurationMs(ENTER, 100)).toBe(300);
    expect(stepDurationMs(HOLD, 40)).toBe(160);
  });

  it("knows which steps have nothing to animate", () => {
    // The resting step is the one that matters: a player that kept a frame
    // loop alive for it would burn CPU on a picture that never changes.
    expect(isSettledStep(RESTING)).toBe(true);
    expect(isSettledStep(HOLD)).toBe(false);
  });

  it("does not call a one-frame transition settled", () => {
    // A transition that lands on a single pose is still a transition: the
    // plan has to move past it and on to the hold behind it.  Calling it
    // settled stops the loop on its first frame.
    expect(isSettledStep(ENTER_ONE)).toBe(false);
    const playback = new AvatarPlayback([ENTER_ONE, HOLD], 100);
    expect(playback.settled).toBe(false);
    playback.advance(100);
    expect(playback.step?.reason).toBe("hold");
    expect(playback.settled).toBe(false);
  });
});

describe("playbackModeFor", () => {
  it("draws the ordinary image when the file carries no manifest", () => {
    expect(
      playbackModeFor({ hasManifest: false, hasDecoder: true, reducedMotion: false, animated: true }),
    ).toBe("plain-image");
  });

  it("draws the ordinary image when the browser cannot decode single frames", () => {
    // Without a frame decoder the transitions cannot be played, so the file
    // is drawn as the looping image it is.
    expect(
      playbackModeFor({ hasManifest: true, hasDecoder: false, reducedMotion: false, animated: true }),
    ).toBe("plain-image");
  });

  it("holds the resting frame when the user asked for less motion", () => {
    expect(
      playbackModeFor({ hasManifest: true, hasDecoder: true, reducedMotion: true, animated: true }),
    ).toBe("still-frame");
  });

  it("holds the resting frame when the caller does not want an animated avatar", () => {
    // The sidebar's idle rows pass animated={false}, which is how the app
    // keeps a list of rows from all animating at once.
    expect(
      playbackModeFor({ hasManifest: true, hasDecoder: true, reducedMotion: false, animated: false }),
    ).toBe("still-frame");
  });

  it("animates when there is a manifest, a decoder and motion is welcome", () => {
    expect(
      playbackModeFor({ hasManifest: true, hasDecoder: true, reducedMotion: false, animated: true }),
    ).toBe("animated");
  });
});

describe("fitFrame", () => {
  it("fills a square box with a square frame", () => {
    expect(fitFrame(32, 32, 44, 44)).toEqual({ x: 0, y: 0, width: 44, height: 44 });
  });

  it("keeps a wide frame whole and centres it", () => {
    // Cropping a character's arms off is worse than a little empty margin.
    expect(fitFrame(64, 32, 44, 44)).toEqual({ x: 0, y: 11, width: 44, height: 22 });
  });

  it("keeps a tall frame whole and centres it", () => {
    expect(fitFrame(32, 64, 44, 44)).toEqual({ x: 11, y: 0, width: 22, height: 44 });
  });
});

describe("AvatarPlayback", () => {
  it("walks through a transition and settles on the hold", () => {
    const playback = new AvatarPlayback([ENTER, HOLD], 100);
    expect(playback.frame(0)).toBe(4);
    expect(playback.frame(100)).toBe(5);
    playback.advance(300);
    // The transition is over, so the plan has moved on to the hold.
    expect(playback.step?.reason).toBe("hold");
    expect(playback.frame(300)).toBe(0);
  });

  it("keeps the time that passed inside a step when the plan moves on", () => {
    const playback = new AvatarPlayback([ENTER, HOLD], 100);
    // 250 ms into a 300 ms transition: 50 ms of the hold is already spent.
    playback.advance(350);
    expect(playback.frame(350)).toBe(0);
    expect(playback.frame(400)).toBe(1);
  });

  it("loops the hold forever", () => {
    const playback = new AvatarPlayback([HOLD], 100);
    playback.advance(1000);
    expect(playback.step?.reason).toBe("hold");
    expect(playback.frame(400)).toBe(0);
    expect(playback.frame(450)).toBe(0);
  });

  it("reports a static step as settled", () => {
    const playback = new AvatarPlayback([RESTING], 100);
    expect(playback.settled).toBe(true);
  });

  it("does not jump forward over time that passed while it was hidden", () => {
    const playback = new AvatarPlayback([HOLD], 100);
    expect(playback.frame(100)).toBe(1);
    // The avatar scrolled out of view for a second, and the clock kept
    // running the whole time it was away.
    playback.skip(1000);
    expect(playback.frame(1100)).toBe(1);
    expect(playback.frame(1200)).toBe(2);
  });

  it("does not freeze when the plan was rebuilt while it was hidden", () => {
    // The plan was rebuilt while the avatar was off screen, so the plan
    // begins after the moment the avatar was hidden.  Skipping the whole
    // hidden time from there would push the clock past the present, and the
    // avatar would sit on frame zero for ever.
    const playback = new AvatarPlayback([HOLD], 100, 500);
    playback.skipHidden(0, 1000);
    // The plan starts where the avatar comes back, and it moves on from there.
    expect(playback.frame(1000)).toBe(0);
    expect(playback.frame(1100)).toBe(1);
  });

  it("keeps the place it had reached when the plan was not rebuilt", () => {
    // The plan began before the avatar was hidden and was not rebuilt, so
    // the time it had already played is kept and only the hidden time goes.
    const playback = new AvatarPlayback([HOLD], 100, 0);
    playback.skipHidden(200, 1000);
    expect(playback.frame(1000)).toBe(2);
    expect(playback.frame(1100)).toBe(3);
  });
});
