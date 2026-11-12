import { describe, expect, it } from "vitest";
import { isRoutineRunOn, normalizeRunOn } from "./run-on.ts";

describe("normalizeRunOn", () => {
  it("keeps bot and cloud", () => {
    expect(normalizeRunOn("bot")).toBe("bot");
    expect(normalizeRunOn("cloud")).toBe("cloud");
  });

  it("maps legacy maus to bot", () => {
    expect(normalizeRunOn("maus")).toBe("bot");
  });

  it("falls back for missing or junk values", () => {
    expect(normalizeRunOn(undefined)).toBe("bot");
    expect(normalizeRunOn(null)).toBe("bot");
    expect(normalizeRunOn("")).toBe("bot");
    expect(normalizeRunOn("laptop")).toBe("bot");
    expect(normalizeRunOn("laptop", "cloud")).toBe("cloud");
  });

  it("type guard only accepts canonical values", () => {
    expect(isRoutineRunOn("bot")).toBe(true);
    expect(isRoutineRunOn("cloud")).toBe(true);
    expect(isRoutineRunOn("maus")).toBe(false);
  });
});
