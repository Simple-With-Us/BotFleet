// Grok quota poller tests.  The CLI does not expose a quota subcommand
// today (2026-09-23), so the poller returns a no-source stub.  These
// tests pin the contract: same snapshot shape the antigravity-quota
// poller exposes, so the future swap to a real reader is a single-file
// change.
import { describe, expect, it, vi } from "vitest";

import {
  GROK_NO_SOURCE_REASON,
  buildNoSourceSnapshot,
  createGrokQuotaPoller,
  findGrokBin,
  lastGrokQuotaSnapshot,
  quotaModelsFromSnapshot,
  setLastGrokQuotaSnapshot,
} from "./grok-quota.ts";

describe("grok-quota", () => {
  it("returns a no-source snapshot every tick", async () => {
    const poller = createGrokQuotaPoller();
    const first = await poller.tick();
    const second = await poller.tick();
    expect(first?.method).toBe("no-source");
    expect(second?.method).toBe("no-source");
    expect(first?.noSourceReason).toBe(GROK_NO_SOURCE_REASON);
    expect(first?.models.length).toBe(0);
  });

  it("quotaModelsFromSnapshot returns the no-source sentinel", () => {
    const snapshot = buildNoSourceSnapshot();
    const models = quotaModelsFromSnapshot(snapshot);
    expect(models["*"]).toBeDefined();
    expect(models["*"].noSource).toBe(true);
    expect(models["*"].noSourceReason).toBe(GROK_NO_SOURCE_REASON);
    expect(models["*"].capped).toBe(false);
  });

  it("buildNoSourceSnapshot carries a populated reason string", () => {
    const snapshot = buildNoSourceSnapshot(1_700_000_000_000);
    expect(snapshot.timestamp).toBe(new Date(1_700_000_000_000).toISOString());
    expect(snapshot.noSourceReason).toContain("grok");
    expect(snapshot.noSourceReason).toContain("quota");
  });

  it("exposes the last snapshot via lastGrokQuotaSnapshot", () => {
    const poller = createGrokQuotaPoller();
    return poller.tick().then(() => {
      const snapshot = lastGrokQuotaSnapshot();
      expect(snapshot).not.toBeNull();
      expect(snapshot?.method).toBe("no-source");
    });
  });

  it("setLastGrokQuotaSnapshot lets a custom reader inject a snapshot", () => {
    setLastGrokQuotaSnapshot({
      timestamp: new Date().toISOString(),
      method: "http-api",
      models: [
        {
          label: "Grok 4.6",
          modelId: "grok-4.6",
          remainingPercentage: 0.7,
          isExhausted: false,
        },
      ],
    });
    const snapshot = lastGrokQuotaSnapshot();
    expect(snapshot?.method).toBe("http-api");
    expect(snapshot?.models.length).toBe(1);
    const models = quotaModelsFromSnapshot(snapshot);
    expect(models["grok-4.6"]).toBeDefined();
    expect(models["grok-4.6"].capped).toBe(false);
    // Pass-through: grok-quota stores remainingPercentage as-is, so a
    // 0–1 fraction shows up on the wire as 0.7 (not 70).  The
    // percentage-display conversion happens in quota-display.ts the
    // same way antigravity-quota.ts does it.  Pin the raw value here.
    expect(models["grok-4.6"].remainingPercent).toBe(0.7);
    // Restore the stub so a later test sees the no-source state.
    setLastGrokQuotaSnapshot(null);
  });

  it("findGrokBin returns a sensible default when the local CLI is absent", () => {
    const bin = findGrokBin({ HOME: "/nonexistent" }, () => false);
    expect(bin).toBe("grok");
  });

  // HS14: ticking every 5 minutes to return the same documented constant
  // bought nothing but a timer.  start() now computes it once.
  it("start() computes the snapshot once and does not arm a recurring timer", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const poller = createGrokQuotaPoller({
        exec: {
          snapshot: async () => {
            calls += 1;
            return buildNoSourceSnapshot();
          },
        },
      });

      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(calls).toBe(1);
      poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});