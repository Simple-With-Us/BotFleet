// How the two stop routes are wired to the graceful stop.
//
// The stop itself lives in server/graceful-shutdown.ts and is exercised
// there, with the clock, the wait and the counts injected.  What is checked
// here is the wiring around it:  the two facts a change to the routes can
// quietly undo, and that no fixture of the module can see.
//
//   * The stop hands its own control lock to the counts.  The lock is the
//     stop's own reservation, and counting it as work in flight means the
//     count the wait watches can never reach zero, so every stop waits out
//     the whole window even when the bots are done.
//
//   * The fence comes back down when the stop fails.  A fence that stays up
//     refuses every route of a server that is still running, which is worse
//     than the failure that caused it.
//
// The guard reads the source rather than driving a server:  a stop that
// worked ends the server, so a fixture could not ask it questions afterwards.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_SOURCE = readFileSync(join(ROOT, "server/index.ts"), "utf8");

/** The source of one route, from its marker to the next route's marker. */
function branch(start: string, end: string): string {
  const from = SERVER_SOURCE.indexOf(start);
  expect(from, `the route ${start} is not in server/index.ts`).toBeGreaterThan(-1);
  const to = SERVER_SOURCE.indexOf(end, from);
  expect(to, `the route after ${start} is not in server/index.ts`).toBeGreaterThan(from);
  return SERVER_SOURCE.slice(from, to);
}

const shutdownBranch = branch('path === "/api/system/shutdown"', 'path === "/api/system/control"');
const controlStopBranch = branch('path === "/api/system/control/stop"', 'path === "/api/bots"');

describe("the control stop route", () => {
  it("counts the work in flight without its own control lock", () => {
    // The lock is taken by the fence the stop itself raises, so counting it
    // would leave the wait watching a count of one that never fell to zero.
    expect(controlStopBranch).toContain("gracefulStopWorkCounts(ownAdmissionActive, ownControlLock)");
    expect(controlStopBranch).toContain("gracefulStopAllowed(ownAdmissionActive, ownControlLock)");
    expect(controlStopBranch).toMatch(/runGracefulStop\("control-stop", \{[^}]*ownControlLock/);
  });

  it("releases the reservation when the stop fails", () => {
    // The reservation is what holds the fence up.  A stop that throws without
    // releasing it leaves a server that refuses every route and goes on
    // running.
    expect(controlStopBranch).toMatch(/catch \(error\) \{[\s\S]{0,200}reservation\.release\(\)/);
    expect(controlStopBranch).toContain("onFailure: () => reservation.release()");
  });
});

describe("the legacy shutdown route", () => {
  it("lowers its fence when the stop fails", () => {
    expect(shutdownBranch).toMatch(/catch \(error\) \{[\s\S]{0,200}lowerTheFence\(\)/);
    expect(shutdownBranch).toContain("onFailure: lowerTheFence");
  });

  it("lowers its fence when the stop refuses", () => {
    // The refusal means the server stays up, so the fence has to come back
    // down with it:  a server that stays up and refuses every other route is
    // worse than a server that stays up and serves them.
    expect(shutdownBranch).toMatch(/if \(!report\.ok\) \{[\s\S]{0,200}lowerTheFence\(\)/);
  });
});
