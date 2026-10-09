import { describe, expect, it } from "vitest";

import { observabilityBadge, observabilityHost } from "./observability-status";

describe("observabilityBadge", () => {
  it("prefers a live error over any other state", () => {
    expect(
      observabilityBadge({ configured: true, enabled: true, lastError: "401 Unauthorized" }),
    ).toEqual({ label: "Error", tone: "error" });
  });

  it("surfaces a status fetch failure as Error even with no status yet", () => {
    expect(observabilityBadge(null, "Failed to fetch diagnostics status")).toEqual({
      label: "Error",
      tone: "error",
    });
  });

  it("says Sending diagnostics only when a DSN is on file and enabled", () => {
    expect(
      observabilityBadge({ configured: true, enabled: true, delivering: true, lastError: null }),
    ).toEqual({
      label: "Sending diagnostics",
      tone: "active",
    });
  });

  it("shows Starting client while configured but the harness SDK is between close and init", () => {
    expect(
      observabilityBadge({ configured: true, enabled: true, delivering: false, lastError: null }),
    ).toEqual({
      label: "Starting client",
      tone: "waiting",
    });
  });

  it("says Turned off when a DSN is on file but the kill switch is flipped", () => {
    expect(observabilityBadge({ configured: true, enabled: false, lastError: null })).toEqual({
      label: "Turned off",
      tone: "off",
    });
  });

  it("says Not configured when no DSN is on file", () => {
    expect(observabilityBadge({ configured: false, enabled: false, lastError: null })).toEqual({
      label: "Not configured",
      tone: "off",
    });
  });

  it("shows an explicit opt-out even when the harness has no runtime DSN", () => {
    expect(observabilityBadge({ configured: false, enabled: false, requestedEnabled: false })).toEqual({
      label: "Turned off",
      tone: "off",
    });
  });

  it("says Waiting before the first fetch resolves", () => {
    expect(observabilityBadge(null)).toEqual({ label: "Waiting", tone: "waiting" });
  });
});

describe("observabilityHost", () => {
  it("returns the resolved host", () => {
    expect(observabilityHost({ host: "o123.ingest.sentry.io" })).toBe("o123.ingest.sentry.io");
  });

  it("is null when unconfigured", () => {
    expect(observabilityHost(null)).toBeNull();
    expect(observabilityHost({ host: null })).toBeNull();
    expect(observabilityHost({ host: "" })).toBeNull();
  });

  it("never returns the full DSN even when the payload carries one", () => {
    const status = {
      host: "o123.ingest.sentry.io",
      dsn: "https://abc123@o0.ingest.sentry.io/1",
    };
    const host = observabilityHost(status);
    expect(host).toBe("o123.ingest.sentry.io");
    expect(host).not.toContain("abc123");
    expect(host).not.toMatch(/^https:\/\//);
  });
});
