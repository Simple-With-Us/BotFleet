import { describe, expect, it } from "vitest";
import { runtimeReadiness } from "./runtime-identity.ts";

describe("restart readiness", () => {
  it("requires every known work source to be idle", () => {
    expect(runtimeReadiness({ turns: 0, queued: 0, lifecycle: 0 })).toEqual({ safeToRestart: true, activeWorkCount: 0 });
    expect(runtimeReadiness({ turns: 0, queued: 2, lifecycle: 1 })).toEqual({ safeToRestart: false, activeWorkCount: 3 });
  });
  it("fails closed when a work counter is unavailable or invalid", () => {
    for (const bad of [NaN, Infinity, -1, 0.5]) {
      expect(runtimeReadiness({ turns: 0, queued: bad })).toEqual({ safeToRestart: false, activeWorkCount: null });
    }
  });
});
