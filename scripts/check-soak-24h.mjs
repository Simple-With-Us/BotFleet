// Turn the human-only 24-hour soak into a check a machine can judge (BF-2515).
//
// The reboot check (scripts/check-post-reboot-node.mjs) prints its verdict as
// JSON and carries no timestamp, so it can answer "is the Mac clean right
// now" but never "was the Mac clean for a whole day".  The soak needed a
// person to start a timer, remember it, and vouch for it afterwards.  This
// script keeps the two ends of the window instead: it captures the reboot
// verdict and the clock when the soak starts, captures them again when it
// ends, and refuses to call a window soaked unless the clock really moved
// and both ends were clean.
//
// Every input is treated as untrusted.  A missing or malformed state file is
// an error, not a pass: the state file is the record of the soak's first
// end, and an unreadable record cannot prove anything about the second end.
//
// What this check does NOT do, stated plainly because a narrower claim is the
// honest one: it observes the window at its two ends and nowhere in between.
// A clean observation at the start and a clean observation 24 hours later
// bound the endpoints; they do not establish that the machine stayed clean
// for the whole interval.  BF-2514's acceptance asks for 24 hours in which no
// BotFleet node process runs and every bot, routine, webhook, Zulip event and
// iOS push keeps working, and that continuous observation belongs to whatever
// samples the window while it runs.  This script is the window's bookend
// check, and its verdict says so.
//
// The state file is a local record, not a sealed one.  It carries a marker and
// a version, and this script refuses a file it did not write, but a hand
// edited timestamp can still shorten the window;  the check therefore proves
// elapsed time and two clean endpoints, and nothing more than that.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The minimum window the Phase 5 exit condition asks for. */
export const SOAK_MINIMUM_MS = 24 * 60 * 60 * 1000;

/**
 * What a green verdict from this script means, and what it does not.  The
 * words are part of the contract: a reader who takes "soaked" to mean
 * continuous observation has been told more than the script proved.
 */
export const SCOPE_NOTE =
  "This check observed the window at both ends and nowhere in between.  It does not establish that the machine stayed clean for the whole interval, and it does not stand in for the continuous observation BF-2514's acceptance asks for.";

/** The marker every state file this script writes carries. */
export const STATE_MARKER = "botfleet-soak-24h";

/** The state file format this script reads and writes. */
export const STATE_VERSION = 1;

/**
 * Run the reboot check and hand back what it printed.  The check exits 1
 * when the verdict is not ok, and prints its JSON before it exits, so the
 * exit code alone is not the answer — the JSON is.
 */
export function runRebootCheck(scriptPath) {
  const result = spawnSync(process.execPath, [scriptPath, "--json"], { encoding: "utf8" });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
    // The spawn's own failure message, so a check that could not be started
    // says why instead of failing with an empty reason.
    error: result.error?.message ?? "",
  };
}

/**
 * Is the harness service still installed?  The reboot check reports the
 * launchd jobs it found; on a platform without launchd the probe skips and
 * the set is empty, which is an honest "none observed" rather than a lie.
 */
export function harnessServicePresent(verdict) {
  const agents = verdict?.details?.launchAgents;
  return Array.isArray(agents) && agents.length > 0;
}

/**
 * Capture one end of the soak.  The runner is injected so the test suite
 * never needs macOS, launchctl or a real reboot.  A runner that printed
 * something other than the reboot check's JSON verdict is an error: an
 * unreadable capture must not read as a clean one.
 */
export function captureRebootVerdict(runCheck, nowMs = Date.now()) {
  const result = runCheck();
  const status = result?.status;
  if (status !== 0 && status !== 1) {
    const detail = (result?.stderr ?? "").trim() || result?.error?.message || "no output";
    throw new Error(`the reboot check exited ${String(status)}: ${detail}`);
  }
  let verdict;
  try {
    verdict = JSON.parse(result?.stdout ?? "");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`the reboot check did not print a JSON verdict: ${message}`);
  }
  if (verdict === null || verdict === undefined || (verdict.ok !== true && verdict.ok !== false)) {
    throw new Error("the reboot check's JSON verdict carries no boolean ok field");
  }
  return {
    at: new Date(nowMs).toISOString(),
    atMs: nowMs,
    verdict,
    harnessServicePresent: harnessServicePresent(verdict),
  };
}

/** How long a span was, in the plain words a reader would use. */
export function formatDuration(ms) {
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

/** Why one captured end is not clean. */
export function captureBlockers(record, label) {
  const blockers = [];
  if (record?.verdict?.ok !== true) {
    const failures = record?.verdict?.failures;
    const detail = Array.isArray(failures) && failures.length > 0 ? failures.join("; ") : "no verdict was recorded";
    blockers.push(`the reboot verdict at the ${label} of the soak was not ok: ${detail}`);
  }
  if (record?.harnessServicePresent !== false) {
    blockers.push(`the harness service was present at the ${label} of the soak`);
  }
  return blockers;
}

/**
 * Decide the window's two bookends.  Pure over the two captured records and
 * the clock, so the same window always earns the same verdict and the test
 * suite can replay it.  A green verdict means the window ran long enough and
 * both ends were clean; it is not a claim about the interval between them.
 */
export function soakVerdict(start, end, nowMs) {
  const blockers = [...captureBlockers(start, "start"), ...captureBlockers(end, "end")];
  const startedAtMs = start?.atMs;
  if (!Number.isFinite(startedAtMs)) {
    blockers.push("the soak start record carries no timestamp, so the window cannot be measured");
  } else {
    const elapsed = nowMs - startedAtMs;
    if (elapsed < 0) {
      blockers.push(
        `the soak start is ${formatDuration(-elapsed)} later than the clock now, so the window has not started`,
      );
    } else if (elapsed < SOAK_MINIMUM_MS) {
      blockers.push(
        `the soak window ran ${formatDuration(elapsed)}, short of the ${formatDuration(SOAK_MINIMUM_MS)} minimum`,
      );
    }
  }
  return { ok: blockers.length === 0, blockers };
}

/**
 * Check the state file against the format this script writes.  Returns null
 * when the file is usable, and otherwise the sentence that says why it is
 * not.
 */
export function validateState(state) {
  if (state === null || state === undefined) return "the state file is empty";
  if (state.marker !== STATE_MARKER) return `the state file carries no ${STATE_MARKER} marker`;
  if (state.version !== STATE_VERSION) {
    return `the state file version ${String(state.version)} is not the expected ${STATE_VERSION}`;
  }
  if (!Number.isFinite(state.atMs)) return "the state file carries no start timestamp";
  // A finite number is not always a date:  a millisecond count outside the
  // range a Date can hold has no ISO form, and asking for one throws.  The
  // file is refused instead, because a state file that cannot be read is
  // never a state file that passed.
  const atMs = new Date(state.atMs);
  if (Number.isNaN(atMs.getTime())) {
    return "the state file's start timestamp is outside the range a date can hold";
  }
  if (state.at !== atMs.toISOString()) {
    return "the state file's recorded instant and its timestamp disagree";
  }
  if (state.verdict === null || state.verdict === undefined) return "the state file carries no reboot verdict";
  if (state.verdict.ok !== true && state.verdict.ok !== false) {
    return "the state file's reboot verdict carries no boolean ok field";
  }
  if (state.harnessServicePresent !== true && state.harnessServicePresent !== false) {
    return "the state file carries no harness-service flag";
  }
  return null;
}

// Compare physical paths.  Node's ESM loader realpaths the entry module, so an
// invocation through a symlinked directory (macOS /var -> /private/var) never
// matches process.argv[1] when compared as text.
function isEntryModule() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  const args = process.argv.slice(2);
  const mode = args[0];
  const value = (flag) => {
    const index = args.indexOf(flag);
    if (index === -1) return undefined;
    return args[index + 1];
  };
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const rebootCheck = value("--reboot-check") ?? join(scriptDir, "check-post-reboot-node.mjs");

  if (mode !== "start" && mode !== "end") {
    console.error(
      "usage: node scripts/check-soak-24h.mjs start --out <state.json> [--reboot-check <script.mjs>]\n" +
        "       node scripts/check-soak-24h.mjs end --state <state.json> [--reboot-check <script.mjs>]",
    );
    process.exit(2);
  }

  if (mode === "start") {
    const outPath = value("--out");
    if (!outPath || outPath.startsWith("--")) {
      console.error("error: start needs --out <state.json>");
      process.exit(2);
    }
    let capture;
    try {
      capture = captureRebootVerdict(() => runRebootCheck(rebootCheck));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`error: could not capture the reboot verdict: ${message}`);
      process.exit(2);
    }
    const state = {
      marker: STATE_MARKER,
      version: STATE_VERSION,
      at: capture.at,
      atMs: capture.atMs,
      verdict: capture.verdict,
      harnessServicePresent: capture.harnessServicePresent,
    };
    writeFileSync(outPath, `${JSON.stringify(state, null, 2)}\n`);
    console.log(`soak start recorded at ${capture.at} in ${outPath}`);
    const blockers = captureBlockers(state, "start");
    if (blockers.length > 0) {
      console.error("the soak cannot start from a dirty machine:");
      for (const blocker of blockers) console.error(`  - ${blocker}`);
      process.exit(1);
    }
    console.log("the reboot verdict is clean and the harness service is absent.");
    process.exit(0);
  }

  const statePath = value("--state");
  if (!statePath || statePath.startsWith("--")) {
    console.error("error: end needs --state <state.json>");
    process.exit(2);
  }
  if (!existsSync(statePath)) {
    console.error(`error: the soak state file ${statePath} does not exist`);
    process.exit(2);
  }
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: the soak state file ${statePath} is not valid JSON: ${message}`);
    process.exit(2);
  }
  const problem = validateState(state);
  if (problem) {
    console.error(`error: the soak state file ${statePath} is unusable: ${problem}`);
    process.exit(2);
  }

  let capture;
  try {
    capture = captureRebootVerdict(() => runRebootCheck(rebootCheck));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: could not capture the reboot verdict: ${message}`);
    process.exit(2);
  }

  const verdict = soakVerdict(state, capture, Date.now());
  if (!verdict.ok) {
    console.error("the 24-hour soak is not satisfied:");
    for (const blocker of verdict.blockers) console.error(`  - ${blocker}`);
    process.exit(1);
  }
  console.log(
    `the 24-hour window ran ${formatDuration(Date.now() - state.atMs)} with a clean observation at each end.`,
  );
  console.log(SCOPE_NOTE);
}
