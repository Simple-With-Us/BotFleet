// Settings → Resources tab: loading, error and saved-vs-applied mismatch
// display.  The view is pure props over static markup, so no harness is
// needed to see any of the three states.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HostResourcesReport } from "../../shared/placement.ts";
import { ResourcesSectionView } from "./ResourcesSection";

const GB = 1024 ** 3;

function fixture(): HostResourcesReport {
  return {
    hostId: "mac:12345678-1234-1234-1234-123456789012",
    version: "1.2.3",
    platform: "darwin",
    capabilities: ["shell", "macos", "desktop"],
    sample: {
      at: Date.UTC(2026, 9, 29, 19, 14, 0),
      cores: 10,
      loadPerCore: 1.5,
      ramTotalBytes: 16 * GB,
      ramAvailableBytes: 9 * GB,
      memoryPressure: null,
      memoryAvailablePercent: 56,
      swapTotalBytes: 2 * GB,
      swapUsedBytes: 1 * GB,
      diskTotalBytes: 100 * GB,
      diskFreeBytes: 60 * GB,
      inodesTotal: 6_000_000,
      inodesFree: 5_000_000,
      dataVolume: { device: "8:16", mountPoint: "/mnt/fleet-extra" },
      rootDiskFreeBytes: 10 * GB,
      storage: { online: true, dataDevice: "8:16", rootDevice: "8:1" },
    },
    storage: { online: true, dataDevice: "8:16", rootDevice: "8:1" },
    admission: {
      maxSwapPercent: 98,
      minFreeDiskBytes: 2 * GB,
      unknownReading: "admit",
    },
    enforcement: {
      cpu: { kind: "priorityOnly" },
      memory: { kind: "gateOnly" },
      swap: { kind: "gateOnly" },
      disk: { kind: "gateOnly" },
      inodes: { kind: "unsupported", reason: "No inode admission gate is active" },
      io: { kind: "unsupported", reason: "No I/O rate enforcement observed" },
    },
    observedLimits: {},
    limitations: ["Disk is an admission gate; no disk quota is observed"],
  };
}

function render(state: Parameters<typeof ResourcesSectionView>[0]["state"]): string {
  return renderToStaticMarkup(
    createElement(ResourcesSectionView, { state, onRefresh: () => {} }),
  );
}

describe("ResourcesSectionView", () => {
  it("renders loading without readings", () => {
    const html = render({ status: "loading" });
    expect(html).toContain("Loading host resources…");
    expect(html).not.toContain("Admission thresholds");
  });

  it("renders the error with its message and a retry", () => {
    const html = render({ status: "error", message: "HTTP 403" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("HTTP 403");
    expect(html).toContain("Refresh");
  });

  it("shows host readings with enforcement sentences, and unset knobs as Not set", () => {
    const html = render({ status: "ready", report: fixture() });
    expect(html).toContain("10 cores");
    expect(html).toContain("16.0 GB");
    expect(html).toContain("Full speed allowed.");
    expect(html).toContain("Checked before each job starts");
    expect(html).toContain("Not set");
    expect(html).toContain("Not set: no gate");
    expect(html).toContain("Saved and applied agree on every threshold.");
  });

  it("shows the saved-vs-applied mismatch with the not-applied reason", () => {
    const mismatched = fixture();
    mismatched.enforcement = {
      ...mismatched.enforcement,
      disk: {
        kind: "notApplied",
        reason: "Disk reading unavailable; admission permits unknown readings",
        restartRequired: false,
      },
    };
    const html = render({ status: "ready", report: mismatched });
    expect(html).toContain("Saved 2.0 GB");
    expect(html).toContain("Not applied: Disk reading unavailable; admission permits unknown readings");
    expect(html).not.toContain("Saved and applied agree on every threshold.");
  });

  it("disables headroom editing with the owner-sets-these note", () => {
    const html = render({ status: "ready", report: fixture() });
    expect(html).toContain("The owner sets these numbers");
    expect(html).toContain("editing is disabled here");
    expect(html).toContain("BOTFLEET_JOBS_RESERVED_CPU_CORES");
    expect(html).toContain("BOTFLEET_JOBS_RESERVED_RAM_MB");
    expect(html).toContain("BOTFLEET_JOBS_MIN_MEMORY_AVAILABLE_PERCENT");
    // All three headroom inputs render disabled: no numeric editing.
    const disabledInputs = html.match(/<input[^>]*disabled[^>]*>/g) ?? [];
    expect(disabledInputs.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps readings on screen with a spinning refresh button while refreshing", () => {
    const html = render({ status: "refreshing", report: fixture() });
    expect(html).toContain("10 cores");
    expect(html).toContain("16.0 GB");
    expect(html).toContain("Refreshing…");
    expect(html).not.toContain("Loading host resources…");
  });

  it("wires the refresh action", () => {
    const onRefresh = vi.fn();
    renderToStaticMarkup(createElement(ResourcesSectionView, { state: { status: "loading" }, onRefresh }));
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
