// The TV-Face frame decides when the avatar owes a fresh GIF. The asset
// path embeds the skin directory, so "same expression, new color" is still
// a new frame — the regression Sentry flagged on #695, where a color-only
// change left the old skin's GIF on screen.
import { describe, expect, it } from "vitest";

import { planFrame, tvFaceFrameChanged, tvFaceSkinDir, TVFACE_TRANSITION_MS } from "./TVFaceAvatar";

describe("tvFaceFrameChanged", () => {
  it("stays quiet when nothing about the frame changed", () => {
    expect(tvFaceFrameChanged({ expression: "resting", skin: "default" }, { expression: "resting", skin: "default" })).toBe(false);
  });

  it("replays on a new expression", () => {
    expect(tvFaceFrameChanged({ expression: "resting", skin: "default" }, { expression: "happy", skin: "default" })).toBe(true);
  });

  it("replays on a skin-only change - the GIF path embeds the skin", () => {
    // Regression pin for the #695 review finding: color change with an
    // unchanged expression must still refresh the displayed asset.
    expect(tvFaceFrameChanged({ expression: "resting", skin: "default" }, { expression: "resting", skin: "blue" })).toBe(true);
  });
});

describe("tvFaceSkinDir", () => {
  it("maps every color to a skins directory that actually ships", () => {
    // orange IS default; every other BotColor has its own pack under
    // public/tv-face/skins/{color}. Unknown colors fall back to default
    // rather than 404 (the BF-Designer finding on #700).
    expect(tvFaceSkinDir("orange")).toBe("default");
    for (const color of ["blue", "green", "purple", "pink", "red", "yellow", "cyan", "teal", "coral", "white", "black"] as const) {
      expect(tvFaceSkinDir(color)).toBe(color);
    }
    // Unknown and "default" itself take the same safe path.
    expect(tvFaceSkinDir("default")).toBe("default");
    expect(tvFaceSkinDir("chartreuse" as never)).toBe("default");
  });
});

describe("planFrame", () => {
  // Real shipped expression names, and deliberately drawn from the set that
  // actually has enter/return art on disk.
  // Every member below is in TVFACE_HAS_ENTER_RETURN, so each has enter AND
  // return art on disk. Picking an expression outside the set makes these
  // assertions meaningless, because such an expression has no return file.
  const withTransitions = [
    "listening", "thinking", "typing", "speaking", "computer", "memory",
  ] as const;

  it("plays enter then hold when leaving rest", () => {
    expect(planFrame("resting", "typing")).toEqual([
      { expression: "typing", kind: "enter", delayAfterMs: TVFACE_TRANSITION_MS },
      { expression: "typing", kind: "hold", delayAfterMs: 0 },
    ]);
  });

  it("plays return then the resting still when going back to rest", () => {
    // "typing" is in TVFACE_HAS_ENTER_RETURN, so it has a return on disk.
    expect(planFrame("typing", "resting")).toEqual([
      { expression: "typing", kind: "return", delayAfterMs: TVFACE_TRANSITION_MS },
      { expression: "resting", kind: "still", delayAfterMs: 0 },
    ]);
  });

  it("cuts straight to the new hold between two active states - no enter", () => {
    // The pop fix. Every `_enter` is anchored to resting.png while the
    // previous `_hold` ends wherever it ends, so playing an enter here jumped
    // on every state-to-state transition.
    expect(planFrame("thinking", "typing")).toEqual([
      { expression: "typing", kind: "hold", delayAfterMs: 0 },
    ]);
  });

  it("cuts between holds without a transition delay", () => {
    const steps = planFrame("speaking", "searching");
    expect(steps).toHaveLength(1);
    expect(steps[0].delayAfterMs).toBe(0);
  });

  it("holds in place when the expression is unchanged", () => {
    expect(planFrame("working", "working")).toEqual([
      { expression: "working", kind: "hold", delayAfterMs: 0 },
    ]);
  });

  it("never ends on a delay, so the last frame is terminal", () => {
    for (const [from, to] of [
      ["resting", "typing"],
      ["working", "resting"],
      ["thinking", "speaking"],
      ["resting", "resting"],
    ] as const) {
      const steps = planFrame(from, to);
      expect(steps[steps.length - 1].delayAfterMs).toBe(0);
    }
  });

  it("only ever emits an enter when coming from rest", () => {
    for (const from of withTransitions) {
      for (const to of withTransitions) {
        if (from === to) continue;
        expect(planFrame(from, to).some((s) => s.kind === "enter")).toBe(false);
      }
    }
  });

  it("only ever emits a return when going to rest", () => {
    for (const from of withTransitions) {  // every member has a return on disk
      const steps = planFrame(from, "resting");
      expect(steps.filter((s) => s.kind === "return")).toHaveLength(1);
      expect(steps[steps.length - 1].expression).toBe("resting");
    }
  });

  it("skips the return for an expression that has no transition art", () => {
    // happy has a hold but no return, so going home from it must land
    // directly on the resting still rather than requesting a 404.
    const steps = planFrame("happy", "resting");
    expect(steps).toEqual([{ expression: "resting", kind: "still", delayAfterMs: 0 }]);
  });

  it("cuts straight to hold for urgent expressions from rest — no enter dwell", () => {
    expect(planFrame("resting", "crash")).toEqual([
      { expression: "crash", kind: "hold", delayAfterMs: 0 },
    ]);
  });

  it("skips return when leaving an urgent expression for rest", () => {
    expect(planFrame("crash", "resting")).toEqual([
      { expression: "resting", kind: "still", delayAfterMs: 0 },
    ]);
  });

  it("honors explicit interrupt: false to play enter despite urgent target", () => {
    expect(planFrame("resting", "crash", { interrupt: false })).toEqual([
      { expression: "crash", kind: "enter", delayAfterMs: TVFACE_TRANSITION_MS },
      { expression: "crash", kind: "hold", delayAfterMs: 0 },
    ]);
  });
});

