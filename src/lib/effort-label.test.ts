import { describe, expect, it } from "vitest";

import { EFFORT_LEVELS } from "../../server/contracts.ts";
import { effortLabel } from "./model-effort";

describe("effortLabel", () => {
  it("calls no level Default", () => {
    expect(effortLabel(undefined)).toBe("Default");
  });

  it("spells xhigh as X-High, not Xhigh", () => {
    expect(effortLabel("xhigh")).toBe("X-High");
  });

  it("capitalizes every other level", () => {
    expect(EFFORT_LEVELS.filter((level) => level !== "xhigh").map(effortLabel)).toEqual([
      "None",
      "Low",
      "Medium",
      "High",
      "Max",
    ]);
  });
});
