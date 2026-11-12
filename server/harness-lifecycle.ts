// Taking the always-on harness down on purpose, and leaving a note that says
// it was on purpose.
//
// The problem this exists to solve: the harness runs under a launchd agent
// with `KeepAlive.SuccessfulExit=false` and `StartInterval=300`.  A clean exit
// does not bring it back on its own, but the five-minute tick does run the
// wrapper, and unless something tells that wrapper the stop was deliberate it
// sees a closed port, concludes the harness crashed, and starts it again.  So
// "shut it down" from inside the app is not a thing you can do today: the only
// way to stop it is to stop launchd noticing, which means editing the plist.
//
// The marker is that note.  The wrapper reads it before probing and exits 0
// without starting anything, so the periodic run stays a health check and a
// deliberate stop stays stopped until the owner deletes the file or launches
// the app, which clears it on the way up.
//
// Exiting 0 rather than non-zero is load-bearing twice over: it is what makes
// `KeepAlive.SuccessfulExit=false` hold, and it is what stops the wrapper's
// own logs filling with what looks like a crash loop.
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";

import { DATA_DIR } from "./config.ts";

/** Where the "stopped on purpose" note lives.
 *
 *  Inside the existing data dir rather than a new one, so it inherits whatever
 *  the harness already does about that directory being absent. */
export const SHUTDOWN_MARKER_PATH = join(DATA_DIR, "stopped.marker");

/** Write the marker so launchd's next tick leaves the harness alone.
 *
 *  The body is not parsed by anything — the wrapper only tests for existence —
 *  but it is worth writing something a person can read if they ever `cat` it
 *  while wondering why the server is not coming back. */
export function writeShutdownMarker(now: Date = new Date()): string {
  mkdirSync(DATA_DIR, { recursive: true });
  const body = [
    "BotFleet was shut down on purpose.",
    "",
    `Written: ${now.toISOString()}`,
    "",
    "The launchd wrapper (StartInterval=300) starts nothing while this file",
    "exists, so the harness stays down instead of being treated as a crash.",
    "Delete this file, or launch the BotFleet app, to let it come back.",
    "",
  ].join("\n");
  writeFileSync(SHUTDOWN_MARKER_PATH, body, { encoding: "utf8", mode: 0o600 });
  return SHUTDOWN_MARKER_PATH;
}

/** Remove the marker.  Called on the deliberate-start path. */
export function clearShutdownMarker(): void {
  rmSync(SHUTDOWN_MARKER_PATH, { force: true });
}

export function shutdownMarkerExists(): boolean {
  return existsSync(SHUTDOWN_MARKER_PATH);
}

/** What a shutdown attempt actually managed to do, for the HTTP reply. */
export interface ShutdownReport {
  ok: boolean;
  error?: string;
  detail: {
    markerWritten: boolean;
    localVmStop: "stopped" | "not-running" | "failed";
    localVmNote?: string;
  };
}

/**
 * Stop the harness.
 *
 * Order matters.  The marker goes down FIRST, before anything that can fail:
 * if the Local VM stop then throws, the harness is still correctly marked as
 * deliberately stopped, and a retry is a no-op rather than a resurrection.  A
 * shutdown that half-works by starting the server back up is worse than one
 * that reports what it could not do.
 *
 * The exit is scheduled rather than immediate so the 200 that tells the caller
 * it worked actually leaves the socket first.  Without the gap the client sees
 * a connection reset and cannot tell a successful shutdown from a crash.
 */
export async function requestHarnessShutdown(options: {
  /** Stops the Local VM.  Injected so a test never shells out to a runtime. */
  stopLocalVm?: () => Promise<{ stopped: boolean; note?: string }>;
  /** Ends this process.  Injected for the same reason. */
  exit?: (code: number) => void;
  /** How long to let the reply flush first. */
  flushMs?: number;
} = {}): Promise<ShutdownReport> {
  const stopLocalVm: () => Promise<{ stopped: boolean; note?: string }> =
    options.stopLocalVm ?? (async () => ({ stopped: false }));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const flushMs = options.flushMs ?? 250;

  let markerWritten = false;
  try {
    writeShutdownMarker();
    markerWritten = true;
  } catch (err) {
    // Without the marker the next launchd tick resurrects the harness, so this
    // is the one failure that makes a shutdown a no-op.  Say so plainly.
    return {
      ok: false,
      error: `could not write the shutdown marker at ${SHUTDOWN_MARKER_PATH}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      detail: { markerWritten: false, localVmStop: "not-running" },
    };
  }

  let localVmStop: ShutdownReport["detail"]["localVmStop"] = "not-running";
  let localVmNote: string | undefined;
  try {
    const result = await stopLocalVm();
    localVmStop = result.stopped ? "stopped" : "not-running";
    localVmNote = result.note;
  } catch (err) {
    // The container refusing to stop does not un-stop the harness, and the
    // owner can stop it by hand.  Report it, do not fail the shutdown.
    localVmStop = "failed";
    localVmNote = err instanceof Error ? err.message : String(err);
  }

  setTimeout(() => exit(0), flushMs).unref?.();

  return { ok: true, detail: { markerWritten, localVmStop, localVmNote } };
}