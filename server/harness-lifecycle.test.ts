// The deliberate-shutdown sentinel, tested without ever exiting a process or
// shelling out to a container runtime.
//
// The behavior that has to hold: on a Mac under
// `KeepAlive.SuccessfulExit=false` + `StartInterval=300`, a harness that exits
// cleanly is still run again five minutes later and a closed port still reads
// as a crash. So a stop has to leave a file behind, and it has to leave that
// file behind FIRST — a shutdown that fails halfway after un-stopping the
// server is worse than one that admits it did nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";

import {
  SHUTDOWN_MARKER_PATH,
  clearShutdownMarker,
  requestHarnessShutdown,
  shutdownMarkerExists,
  writeShutdownMarker,
} from "./harness-lifecycle.ts";

// The marker path is whatever the module resolved, and this suite works on
// that path directly rather than trying to redirect it.
//
// server/testing/setup.ts already points HOME at a throwaway directory and
// deletes OMB_DATA_DIR before any module loads, so SHUTDOWN_MARKER_PATH is
// inside a temp tree. Setting the variable here does not move it: config.ts
// captures DATA_DIR at import time and the setup has already imported it — a
// vi.hoisted block runs after that too, which is exactly how an earlier draft
// of this file ended up writing to the real ~/.botfleet/stopped.marker.
// "sandboxed" is asserted below rather than assumed.
const markerPath = SHUTDOWN_MARKER_PATH;
const markerDir = dirname(markerPath);

// The exit is deliberately scheduled rather than immediate so the 200 that
// tells the caller the shutdown worked actually leaves the socket first. Every
// test therefore runs on fake timers and advances them explicitly: asserting
// synchronously after an await would test the timer, not the shutdown.
beforeEach(() => {
  // Recursive first: the refusal test leaves a DIRECTORY at the marker path,
  // and clearShutdownMarker() is a non-recursive rm that would throw on it.
  rmSync(markerPath, { recursive: true, force: true });
  mkdirSync(markerDir, { recursive: true });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(markerDir, { recursive: true, force: true });
});

/** Run a shutdown and let the scheduled exit fire. */
async function shutDown(
  stopLocalVm: () => Promise<{ stopped: boolean; note?: string }> = async () => ({ stopped: false }),
) {
  const exit = vi.fn();
  const report = await requestHarnessShutdown({ exit, stopLocalVm, flushMs: 250 });
  return { exit, report, atCall: () => vi.advanceTimersByTime(250) };
}

describe("the shutdown marker", () => {
  it("is sandboxed away from the real ~/.botfleet, so these tests cannot stop a live harness", () => {
    // The whole suite creates and removes a real shutdown sentinel. This is
    // the one test that notices, before a run leaves the owner's server
    // switched off: server/testing/setup.ts redirects HOME to a throwaway
    // tree under the system temp dir, so a path outside tmpdir() would mean
    // that redirection stopped applying.
    expect(markerPath.startsWith(tmpdir())).toBe(true);
    expect(markerPath.endsWith("/stopped.marker")).toBe(true);
  });

  it("does not exist until something asks for it", () => {
    expect(shutdownMarkerExists()).toBe(false);
  });

  it("is readable by a person wondering why the server stayed down", () => {
    writeShutdownMarker();
    expect(existsSync(markerPath)).toBe(true);
    const body = readFileSync(markerPath, "utf8");
    // Nothing parses it, but a bare marker file is a bad thing to leave lying
    // around for whoever goes looking.
    expect(body).toContain("shut down on purpose");
    expect(body).toContain("Delete this file");
  });

  it("clears on request, which is how a deliberate start comes back", () => {
    writeShutdownMarker();
    expect(shutdownMarkerExists()).toBe(true);
    clearShutdownMarker();
    expect(shutdownMarkerExists()).toBe(false);
  });

  it("clearing a marker that was never written is not an error", () => {
    expect(() => clearShutdownMarker()).not.toThrow();
  });
});

describe("requestHarnessShutdown", () => {
  it("writes the marker, then exits cleanly, which is what launchd reads as deliberate", async () => {
    const { exit, report, atCall } = await shutDown();
    expect(report.ok).toBe(true);
    expect(report.detail.markerWritten).toBe(true);
    expect(shutdownMarkerExists()).toBe(true);

    atCall();
    // Zero, not a failure code: `KeepAlive.SuccessfulExit=false` only leaves a
    // clean exit alone.
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("writes the marker BEFORE it tries to stop anything that can fail", async () => {
    let markerPresentWhenAsked = false;
    const { atCall } = await shutDown(async () => {
      markerPresentWhenAsked = shutdownMarkerExists();
      return { stopped: false };
    });
    atCall();
    expect(markerPresentWhenAsked).toBe(true);
  });

  it("lets the reply flush before the process goes", async () => {
    const { exit, atCall } = await shutDown();
    // Without the delay the client sees a reset socket and cannot tell a
    // shutdown that worked from one that crashed.
    expect(exit).not.toHaveBeenCalled();
    atCall();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("refuses and exits nothing when the marker cannot be written", async () => {
    // A directory where the marker should be a file: writeFileSync fails EISDIR.
    mkdirSync(markerPath, { recursive: true });

    const exit = vi.fn();
    const report = await requestHarnessShutdown({
      exit,
      flushMs: 250,
      stopLocalVm: async () => ({ stopped: true }),
    });

    expect(report.ok).toBe(false);
    expect(report.error).toContain("shutdown marker");
    vi.advanceTimersByTime(250);
    // Exiting anyway would be the bug: without the marker the next launchd
    // tick resurrects the harness while the person believes it stayed down.
    expect(exit).not.toHaveBeenCalled();
  });

  it("still succeeds when the Local VM refuses to stop, and says so", async () => {
    const { exit, report, atCall } = await shutDown(async () => {
      throw new Error("the Local VM is in use by claude; left running");
    });

    expect(report.ok).toBe(true);
    expect(report.detail.localVmStop).toBe("failed");
    expect(report.detail.localVmNote).toContain("left running");
    // A container that will not stop must not stop the harness shutting down.
    expect(shutdownMarkerExists()).toBe(true);
    atCall();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("reports a skipped Local VM as not-running rather than failed", async () => {
    const { report, atCall } = await shutDown(async () => ({ stopped: false, note: "there was no Local VM" }));
    atCall();
    expect(report.detail.localVmStop).toBe("not-running");
    expect(report.detail.localVmNote).toBe("there was no Local VM");
  });

  it("reports a stopped Local VM as stopped", async () => {
    const { report, atCall } = await shutDown(async () => ({ stopped: true }));
    atCall();
    expect(report.detail.localVmStop).toBe("stopped");
  });
});