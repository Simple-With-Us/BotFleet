// The LaunchAgent that runs the always-on harness, read as a value rather
// than as a description.  Its whole job is to answer one question — is
// there a harness on :8799? — and every failure here is a Mac left with no
// harness and nothing that notices.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// scripts/launchd -> scripts -> repo root
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLIST = path.join(root, "scripts/launchd/app.botfleet.server.plist");
const plist = readFileSync(PLIST, "utf8");

test("the agent watches, rather than only restarting after a failure", () => {
  // KeepAlive.SuccessfulExit=false restarts the harness only when it dies
  // unsuccessfully.  A clean SIGTERM — the desktop app killing the fork it
  // started when nothing was answering on 8799 — is a *successful* exit, so
  // without an interval launchd does nothing at all and the Mac stays dark.
  // Every paired phone then fails to send, with nothing in the logs saying
  // why.  This assertion exists so the watchdog cannot be dropped again as
  // "redundant with KeepAlive": it is not redundant, it is the only thing
  // that checks at all.
  assert.match(
    plist,
    /<key>StartInterval<\/key>\s*<integer>\d+<\/integer>/,
    "app.botfleet.server needs a StartInterval to be a watchdog",
  );
});

test("the interval is long enough not to be a restart loop", () => {
  // The start script probes :8799 and exits 0 when healthy, so a short
  // interval would still be cheap — but a sub-minute one turns a transient
  // bind failure into a launchd throttle fight with no upside.
  const match = plist.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
  assert.ok(match, "StartInterval must be an integer so launchd accepts it");
  const seconds = Number(match[1]);
  assert.ok(seconds >= 60, `StartInterval of ${seconds}s would poll too fast`);
});

test("KeepAlive still restarts a crash, and is not left on unconditional", () => {
  // Unconditional KeepAlive would fight the interval and the "already
  // healthy" exit: the script deliberately returns 0 when a harness is
  // serving, and launchd must not treat that as a failure to retry.
  assert.match(
    plist,
    /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/,
    "KeepAlive must stay keyed on SuccessfulExit=false",
  );
});

test("the deployed paths the agent runs are the ones the repo documents", () => {
  // A watchdog pointed at a path nobody builds is worse than no watchdog: it
  // looks healthy and does nothing.
  assert.match(plist, /<string>\/Users\/jay\/apps\/botfleet-server-start\.sh<\/string>/);
  assert.match(plist, /<string>\/Users\/jay\/apps\/botfleet-server<\/string>/);
});

test("the script the agent runs does exit cleanly when a harness is healthy", () => {
  // The interval above is only safe because of this branch.  If it is ever
  // removed, every periodic run would try to start a second harness on a
  // port that is already bound.
  const script = readFileSync(path.join(root, "scripts/botfleet-server-start.sh"), "utf8");
  assert.match(script, /if \[ "\$HEAL_ONLY" != true \] && health; then/);
  assert.match(script, /already healthy; not starting a second harness/);
});