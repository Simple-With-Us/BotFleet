import { describe, expect, it } from "vitest";

import { contextWindowFor } from "./model-context-windows.ts";

describe("contextWindowFor", () => {
  it("matches a published model id, ignoring case and surrounding space", () => {
    expect(contextWindowFor("MiniMax-M2.7")).toBe(204_800);
    expect(contextWindowFor("  minimax-m3.1-flash-preview ")).toBe(1_000_000);
  });

  it("gives a -thinking variant the same window as its base model", () => {
    expect(contextWindowFor("MiniMax-M3.1-Flash-Preview-thinking")).toBe(1_000_000);
    expect(contextWindowFor("MiniMax-M2.7-highspeed-thinking")).toBe(204_800);
    expect(contextWindowFor("minimax-m2.7-HIGHSPEED-Thinking")).toBe(204_800);
  });

  it("returns undefined for an unknown, empty or missing model", () => {
    expect(contextWindowFor("some-other-model")).toBeUndefined();
    expect(contextWindowFor("some-other-model-thinking")).toBeUndefined();
    expect(contextWindowFor("-thinking")).toBeUndefined();
    expect(contextWindowFor("")).toBeUndefined();
    expect(contextWindowFor(undefined)).toBeUndefined();
    expect(contextWindowFor(null)).toBeUndefined();
  });
});
