import { describe, expect, it } from "vitest";

import { telemetryBadge } from "./telemetry-status";

describe("telemetryBadge", () => {
  it("prefers a live error over a prior ack", () => {
    expect(
      telemetryBadge({
        enabled: true,
        lastError: "HTTP 401",
        lastAckAt: "2026-09-01T00:00:00.000Z",
        totalSent: 4,
      }),
    ).toEqual({ label: "Error", tone: "error" });
  });

  it("is Active only after a successful post", () => {
    expect(
      telemetryBadge({ enabled: true, lastError: null, lastAckAt: "2026-09-01T00:00:00.000Z", totalSent: 1 }),
    ).toEqual({ label: "Active Telemetry", tone: "active" });
    expect(
      telemetryBadge({ enabled: true, lastError: null, lastAckAt: null, totalSent: 2 }),
    ).toEqual({ label: "Active Telemetry", tone: "active" });
  });

  it("says Not configured when no ingest token is present", () => {
    expect(
      telemetryBadge({ enabled: false, lastError: null, lastAckAt: null, totalSent: 0 }),
    ).toEqual({ label: "Not configured", tone: "off" });
  });

  it("says Waiting when enabled but nothing has posted yet", () => {
    expect(telemetryBadge(null)).toEqual({ label: "Waiting", tone: "waiting" });
    expect(
      telemetryBadge({ enabled: true, lastError: null, lastAckAt: null, totalSent: 0 }),
    ).toEqual({ label: "Waiting", tone: "waiting" });
  });

  it("surfaces a status fetch failure", () => {
    expect(telemetryBadge(null, "Failed to fetch telemetry status")).toEqual({
      label: "Error",
      tone: "error",
    });
  });
});
