// The TV-Face frame decides when the avatar owes a fresh GIF. The asset
// path embeds the skin directory, so "same expression, new color" is still
// a new frame — the regression Sentry flagged on #695, where a color-only
// change left the old skin's GIF on screen.
import { describe, expect, it } from "vitest";

import {
  planFrame,
  tvFaceFrameChanged,
  tvFaceSkinDir,
  transitionDelayMs,
  isUrgentExpression,
  TVFACE_TRANSITION_MS,
  TVFACE_URGENT,
  SHIPPED_SKINS,
} from "./TVFaceAvatar";

describe("tvFaceFrameChanged", () => {
  it("stays quiet when nothing about the frame changed", () => {
    expect(tvFaceFrameChanged({ expression: "resting", skin: "default" }, { expression: "resting", skin: "default" })).toBe(false);
  });

  it("replays on a new expression", () => {
    expect(tvFaceFrameChanged({ expression: "resting", skin: "default" }, { expression: "happy", skin: "default" })).toBe(true);
  });

  it("replays on a skin-only change - the GIF path embeds the skin", () => {
    expect(tvFaceFrameChanged({ expression: "resting", skin: "default" }, { expression: "resting", skin: "blue" })).toBe(true);
  });
});

describe("tvFaceSkinDir", () => {
  it("maps orange to the default pack directory", () => {
    expect(tvFaceSkinDir("orange")).toBe("default");
    expect(tvFaceSkinDir("default")).toBe("default");
  });

  it("maps every shipped BotColor to its own directory", () => {
    for (const color of ["blue", "green", "purple", "pink", "red", "yellow", "cyan", "teal", "coral"] as const) {
      expect(SHIPPED_SKINS.has(color), `${color} should be shipped`).toBe(true);
      expect(tvFaceSkinDir(color)).toBe(color);
    }
  });

  it("falls back to default for unshipped colors so they never 404", () => {
    // chartreuse is not a BotColor and is not shipped.
    expect(tvFaceSkinDir("chartreuse" as never)).toBe("default");
  });
});

describe("urgent interrupt", () => {
  it("names the approval/error/scare cues as urgent", () => {
    for (const e of ["alerting", "crash", "angry", "scared", "notifying"] as const) {
      expect(isUrgentExpression(e)).toBe(true);
      expect(TVFACE_URGENT.has(e)).toBe(true);
    }
  });

  it("does not treat everyday work as urgent", () => {
    for (const e of ["thinking", "typing", "speaking", "working", "listening"] as const) {
      expect(isUrgentExpression(e)).toBe(false);
    }
  });

  it("cuts straight to hold when the destination is urgent, even from rest", () => {
    // No enter wait — approval/error must land immediately.
    expect(planFrame("resting", "alerting")).toEqual([
      { expression: "alerting", kind: "hold", delayAfterMs: 0 },
    ]);
    expect(planFrame("thinking", "crash")).toEqual([
      { expression: "crash", kind: "hold", delayAfterMs: 0 },
    ]);
  });

  it("still plays a full return when going home from an urgent hold", () => {
    // Leaving crash back to rest can keep the return if crash has one.
    const steps = planFrame("crash", "resting");
    expect(steps[0].kind).toBe("return");
    expect(steps[0].expression).toBe("crash");
    expect(steps[steps.length - 1]).toEqual({ expression: "resting", kind: "still", delayAfterMs: 0 });
  });
});

describe("transitionDelayMs", () => {
  it("returns 0 for urgent enter targets", () => {
    expect(transitionDelayMs("enter", "alerting")).toBe(0);
  });

  it("matches TVFACE_TRANSITION_MS at speed 1 for normal enters", () => {
    expect(transitionDelayMs("enter", "thinking")).toBe(TVFACE_TRANSITION_MS);
  });

  it("halves the wait at speed 2 without re-encoding the GIF", () => {
    expect(transitionDelayMs("enter", "thinking", 2)).toBe(500);
  });
});

describe("planFrame", () => {
  const withTransitions = [
    "listening", "thinking", "typing", "speaking", "computer", "memory",
  ] as const;

  it("plays enter then hold when leaving rest for a non-urgent expression", () => {
    expect(planFrame("resting", "typing")).toEqual([
      { expression: "typing", kind: "enter", delayAfterMs: TVFACE_TRANSITION_MS },
      { expression: "typing", kind: "hold", delayAfterMs: 0 },
    ]);
  });

  it("plays return then the resting still when going back to rest", () => {
    expect(planFrame("typing", "resting")).toEqual([
      { expression: "typing", kind: "return", delayAfterMs: TVFACE_TRANSITION_MS },
      { expression: "resting", kind: "still", delayAfterMs: 0 },
    ]);
  });

  it("cuts straight to the new hold between two active states - no enter", () => {
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
      ["thinking", "alerting"],
    ] as const) {
      const steps = planFrame(from, to);
      expect(steps[steps.length - 1].delayAfterMs).toBe(0);
    }
  });

  it("only ever emits an enter when coming from rest (and not urgent)", () => {
    for (const from of withTransitions) {
      for (const to of withTransitions) {
        if (from === to) continue;
        expect(planFrame(from, to).some((s) => s.kind === "enter")).toBe(false);
      }
    }
  });

  it("only ever emits a return when going to rest", () => {
    for (const from of withTransitions) {
      const steps = planFrame(from, "resting");
      expect(steps.filter((s) => s.kind === "return")).toHaveLength(1);
      expect(steps[steps.length - 1].expression).toBe("resting");
    }
  });

  it("skips the return for an expression that has no transition art", () => {
    const steps = planFrame("happy", "resting");
    expect(steps).toEqual([{ expression: "resting", kind: "still", delayAfterMs: 0 }]);
  });

  it("honours transitionSpeed on enter waits", () => {
    const steps = planFrame("resting", "thinking", { speed: 2 });
    expect(steps[0]).toEqual({ expression: "thinking", kind: "enter", delayAfterMs: 500 });
    expect(steps[1]).toEqual({ expression: "thinking", kind: "hold", delayAfterMs: 0 });
  });
});
