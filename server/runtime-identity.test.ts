import { describe, expect, it } from "vitest";
import { runtimeReadiness, sweepMapIfPresent } from "./runtime-identity.ts";

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

describe("sweepMapIfPresent", () => {
  it("returns 0 for non-Maps without throwing", () => {
    for (const bad of [undefined, null, 0, "x", {}, [], new Set()]) {
      expect(sweepMapIfPresent(bad, () => true)).toBe(0);
    }
  });

  it("deletes matching entries and returns the surviving size", () => {
    const pending = new Map<string, { threadId: string; botId: string }>([
      ["keep", { threadId: "t1", botId: "b1" }],
      ["drop", { threadId: "t2", botId: "b2" }],
    ]);
    expect(
      sweepMapIfPresent(pending, (_k: string, round: { threadId: string; botId: string }) => round.threadId === "t2"),
    ).toBe(1);
    expect([...pending.keys()]).toEqual(["keep"]);
  });
});

describe("restart readiness boot gate", () => {
  it("fails closed while boot is still in progress", () => {
    expect(runtimeReadiness({ boot: 1 })).toEqual({ safeToRestart: false, activeWorkCount: 1 });
  });
});
