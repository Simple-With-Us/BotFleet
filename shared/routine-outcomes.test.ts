import { describe, expect, it } from "vitest";
import { routineFailureCode, routineOutcomeCode, routineOutcomeSummary, type RoutineOutcomeRecord } from "./routine-outcomes";

describe("routine execution outcomes", () => {
  it("keeps cancellation, denied capability, setup, and execution failure separate", () => {
    expect(routineFailureCode("interrupted")).toBe("cancelled");
    expect(routineFailureCode("resume_failed", true)).toBe("resume_failed");
    expect(routineFailureCode("prompt_timeout")).toBe("timeout");
    expect(routineFailureCode("prompt_stall")).toBe("timeout");
    expect(routineFailureCode("arbitrary text containing secrets", true)).toBe("auth_required");
    expect(routineFailureCode(null, false, true)).toBe("capability_denied");
    expect(routineFailureCode("arbitrary upstream error")).toBe("execution_failed");
  });

  it("excludes combined receipts and expected stops without rewriting legacy history", () => {
    const now = 10 * 86_400_000;
    const base = { routineId: "routine", createdAt: now - 1000, finishedAt: now - 500 };
    const oldCombined: RoutineOutcomeRecord = { ...base, status: "completed", startedAt: now - 500, output: "Handled together with Fixture" };
    const rows: RoutineOutcomeRecord[] = [
      { ...base, status: "completed" }, { ...base, status: "failed", outcomeCode: "timeout" },
      { ...base, status: "cancelled" }, { ...base, status: "failed", outcomeCode: "capability_denied" },
      { ...base, status: "missed" }, { ...base, status: "running" },
      { ...base, status: "completed", coalescedInto: "owner", outcomeCode: "completed" }, oldCombined,
      { ...base, status: "failed", createdAt: now - 8 * 86_400_000, finishedAt: now - 8 * 86_400_000 },
    ];
    const before = JSON.stringify(rows);
    expect(routineOutcomeCode(oldCombined)).toBe("combined_unverified");
    expect(routineOutcomeSummary(rows, now)).toEqual({ completed: 1, failed: 1, cancelled: 1, denied: 1, missed: 1,
      pending: 1, combined: 2, successRate: 0.5, lastSuccessAt: now - 500, lastFailureAt: now - 500 });
    expect(JSON.stringify(rows)).toBe(before);
    expect(routineOutcomeSummary([], now).successRate).toBeNull();
  });
  it("uses terminal time for the rolling window and excludes future or invalid receipts", () => {
    const now = 10 * 86_400_000;
    const base = { routineId: "routine", status: "completed", createdAt: 1 };
    const summary = routineOutcomeSummary([
      { ...base, finishedAt: now - 1 },
      { ...base, finishedAt: now + 1 },
      { ...base, finishedAt: Number.NaN },
      { ...base, status: "running" },
    ], now);
    expect(summary.completed).toBe(1);
    expect(summary.pending).toBe(0);
    expect(summary.lastSuccessAt).toBe(now - 1);
  });

});
