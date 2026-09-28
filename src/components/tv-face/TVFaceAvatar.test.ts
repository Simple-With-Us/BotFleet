// The TV-Face frame decides when the avatar owes a fresh GIF. The asset
// path embeds the skin directory, so "same expression, new color" is still
// a new frame — the regression Sentry flagged on #695, where a color-only
// change left the old skin's GIF on screen.
import { describe, expect, it } from "vitest";

import { tvFaceFrameChanged } from "./TVFaceAvatar";

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
