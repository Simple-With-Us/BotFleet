import { describe, expect, it } from "vitest";

import { contextWindowFor } from "./model-context-windows.ts";

describe("contextWindowFor", () => {
  it("matches a published model id, ignoring case and surrounding space", () => {
    expect(contextWindowFor("MiniMax-M2.7")).toBe(204_800);
    expect(contextWindowFor("  minimax-m3.1-flash ")).toBe(1_000_000);
    expect(contextWindowFor("  minimax-m3.1-flash-1m ")).toBe(1_000_000);
  });

  it("gives a -thinking variant the same window as its base model", () => {
    expect(contextWindowFor("MiniMax-M3.1-Flash-thinking")).toBe(1_000_000);
    expect(contextWindowFor("MiniMax-M3.1-Flash-thinking-1M")).toBe(1_000_000);
    expect(contextWindowFor("MiniMax-M2.7-highspeed-thinking")).toBe(204_800);
    expect(contextWindowFor("minimax-m2.7-HIGHSPEED-Thinking")).toBe(204_800);
  });

  it("keeps the shared MiniMax-M3.1-Flash id at 1M, not the native row's 512K cap", () => {
    // The dsh catalog declares `MiniMax-M3.1-Flash` with a 1M window while
    // the native driver's own row caps that same id at 512K.  One id cannot
    // carry both, and this table is the clamp authority in
    // resolveAcpPromptBudget, so it must hold the published window or every
    // dsh turn loses about half its configured budget.
    expect(contextWindowFor("MiniMax-M3.1-Flash")).toBe(1_000_000);
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
