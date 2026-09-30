// The TV-Face frame decides when the avatar owes a fresh GIF. The asset
// path embeds the skin directory, so "same expression, new color" is still
// a new frame — the regression Sentry flagged on #695, where a color-only
// change left the old skin's GIF on screen.
import { describe, expect, it } from "vitest";

import { planFrame, tvFaceFrameChanged, tvFaceSkinDir } from "./TVFaceAvatar";
import { TVFACE_TRANSITION_MS } from "./manifest";

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
    // Only public/tv-face/skins/default ships. Named skins without assets
    // must fall back to it, not 404 (the BF-Designer finding on #700).
    expect(tvFaceSkinDir("orange")).toBe("default");
    for (const color of ["blue", "green", "purple", "pink", "red", "yellow"] as const) {
      expect(tvFaceSkinDir(color)).toBe("default");
    }
    // Unknown and "default" itself take the same safe path.
    expect(tvFaceSkinDir("default")).toBe("default");
    expect(tvFaceSkinDir("chartreuse" as never)).toBe("default");
  });
});

describe("planFrame", () => {
  it("plays enter then hold when leaving rest", () => {
    expect(planFrame("resting", "working")).toEqual([
      { expression: "working", kind: "enter", delayAfterMs: TVFACE_TRANSITION_MS },
      { expression: "working", kind: "hold", delayAfterMs: 0 },
    ]);
  });

  it("plays return then the resting still when going back to rest", () => {
    expect(planFrame("working", "resting")).toEqual([
      { expression: "working", kind: "return", delayAfterMs: TVFACE_TRANSITION_MS },
      { expression: "resting", kind: "still", delayAfterMs: 0 },
    ]);
  });

  it("cuts straight to the new hold between two active states - no enter", () => {
    // This is the pop fix. Every `_enter` is anchored to resting.png while the
    // previous `_hold` ends wherever it ends, so playing an enter here jumped
    // on every single state-to-state transition.
    expect(planFrame("thinking", "working")).toEqual([
      { expression: "working", kind: "hold", delayAfterMs: 0 },
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
      ["resting", "working"],
      ["working", "resting"],
      ["thinking", "speaking"],
      ["resting", "resting"],
    ] as const) {
      const steps = planFrame(from, to);
      expect(steps[steps.length - 1].delayAfterMs).toBe(0);
    }
  });

  it("only ever emits an enter when coming from rest", () => {
    const actives = ["working", "thinking", "searching", "speaking", "waiting", "error"] as const;
    for (const from of actives) {
      for (const to of actives) {
        if (from === to) continue;
        const steps = planFrame(from, to);
        expect(steps.some((s) => s.kind === "enter")).toBe(false);
      }
    }
  });

  it("only ever emits a return when going to rest", () => {
    const actives = ["working", "thinking", "searching", "speaking", "waiting", "error"] as const;
    for (const from of actives) {
      const steps = planFrame(from, "resting");
      expect(steps.filter((s) => s.kind === "return")).toHaveLength(1);
      expect(steps[steps.length - 1].expression).toBe("resting");
    }
  });
});
