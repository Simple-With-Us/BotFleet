import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SCOPE_NOTE,
  SOAK_MINIMUM_MS,
  STATE_MARKER,
  STATE_VERSION,
  captureRebootVerdict,
  harnessServicePresent,
  soakVerdict,
  validateState,
} from "./check-soak-24h.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "scripts", "check-soak-24h.mjs");

const CLEAN_VERDICT = {
  ok: true,
  failures: [],
  details: {
    processes: [],
    launchAgents: [],
    portListeners: [],
    gitFiles: [],
    probeErrors: [],
  },
};

/** A stand-in for the reboot check: it prints a verdict and never reboots. */
const CLEAN_CHECK = `const verdict = ${JSON.stringify(CLEAN_VERDICT)};
console.log(JSON.stringify(verdict));
`;

/** A captured end of a soak that was clean. */
function cleanRecord(atMs) {
  return {
    at: new Date(atMs).toISOString(),
    atMs,
    verdict: CLEAN_VERDICT,
    harnessServicePresent: false,
  };
}

test("a window that ran the full day with clean ends is soaked", () => {
  const start = cleanRecord(1_000_000);
  const end = cleanRecord(1_000_000 + SOAK_MINIMUM_MS + 60_000);
  const verdict = soakVerdict(start, end, 1_000_000 + SOAK_MINIMUM_MS + 60_000);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.blockers, []);
});

test("a window shorter than 24 hours is not a soak", () => {
  const start = cleanRecord(1_000_000);
  const end = cleanRecord(1_000_000 + SOAK_MINIMUM_MS - 1);
  const verdict = soakVerdict(start, end, 1_000_000 + SOAK_MINIMUM_MS - 1);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.blockers.length, 1);
  assert.match(verdict.blockers[0], /short of the 24h 0m minimum/);
});

test("a reboot verdict that was not ok at either end blocks the soak", () => {
  const start = cleanRecord(1_000_000);
  const end = cleanRecord(1_000_000 + SOAK_MINIMUM_MS);
  const dirtyStart = { ...start, verdict: { ok: false, failures: ["Lingering BotFleet Node processes detected"] } };
  const dirtyEnd = { ...end, verdict: { ok: false, failures: ["Lingering BotFleet LaunchAgents loaded in launchd"] } };

  const atStart = soakVerdict(dirtyStart, end, 1_000_000 + SOAK_MINIMUM_MS);
  assert.equal(atStart.ok, false);
  assert.ok(atStart.blockers.some((line) => /at the start of the soak was not ok/.test(line)));
  assert.ok(atStart.blockers.some((line) => /Lingering BotFleet Node processes/.test(line)));

  const atEnd = soakVerdict(start, dirtyEnd, 1_000_000 + SOAK_MINIMUM_MS);
  assert.equal(atEnd.ok, false);
  assert.ok(atEnd.blockers.some((line) => /at the end of the soak was not ok/.test(line)));
});

test("the harness service present at either end blocks the soak", () => {
  const start = cleanRecord(1_000_000);
  const end = cleanRecord(1_000_000 + SOAK_MINIMUM_MS);
  const withService = { ...start, harnessServicePresent: true };
  const verdict = soakVerdict(withService, end, 1_000_000 + SOAK_MINIMUM_MS);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.blockers.some((line) => /harness service was present at the start/.test(line)));

  const atEnd = soakVerdict(start, { ...end, harnessServicePresent: true }, 1_000_000 + SOAK_MINIMUM_MS);
  assert.equal(atEnd.ok, false);
  assert.ok(atEnd.blockers.some((line) => /harness service was present at the end/.test(line)));
});

test("a soak whose start is later than the clock has not started", () => {
  const start = cleanRecord(2_000_000);
  const end = cleanRecord(2_000_000 + SOAK_MINIMUM_MS);
  const verdict = soakVerdict(start, end, 1_000_000);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.blockers.some((line) => /has not started/.test(line)));
});

test("the capture refuses a runner that printed no JSON verdict", () => {
  assert.throws(
    () => captureRebootVerdict(() => ({ stdout: "not json", stderr: "", status: 0 })),
    /did not print a JSON verdict/,
  );
  assert.throws(
    () => captureRebootVerdict(() => ({ stdout: "", stderr: "boom", status: 2 })),
    /the reboot check exited 2/,
  );
  assert.throws(
    () =>
      captureRebootVerdict(() => ({
        stdout: "",
        stderr: "",
        status: null,
        error: new Error("spawn ENOENT"),
      })),
    /spawn ENOENT/,
  );
  assert.throws(
    () => captureRebootVerdict(() => ({ stdout: JSON.stringify({ failures: [] }), stderr: "", status: 0 })),
    /carries no boolean ok field/,
  );
});

test("the capture reports the harness service the reboot check found", () => {
  const clean = captureRebootVerdict(() => ({ stdout: JSON.stringify(CLEAN_VERDICT), stderr: "", status: 0 }), 1_000);
  assert.equal(clean.verdict.ok, true);
  assert.equal(clean.harnessServicePresent, false);
  assert.equal(clean.atMs, 1_000);

  const loaded = {
    ok: false,
    failures: ["Lingering BotFleet LaunchAgents loaded in launchd (app.botfleet.server)"],
    details: { ...CLEAN_VERDICT.details, launchAgents: [{ label: "app.botfleet.server", running: true }] },
  };
  const dirty = captureRebootVerdict(() => ({ stdout: JSON.stringify(loaded), stderr: "", status: 1 }), 2_000);
  assert.equal(dirty.harnessServicePresent, true);
  assert.equal(harnessServicePresent(loaded), true);
  assert.equal(harnessServicePresent(CLEAN_VERDICT), false);
});

test("a state file this tool did not write is refused", () => {
  assert.match(validateState({}), new RegExp(`carries no ${STATE_MARKER} marker`));
  assert.match(
    validateState({ marker: STATE_MARKER, version: STATE_VERSION }),
    /no start timestamp/,
  );
  assert.equal(validateState({ marker: STATE_MARKER, version: STATE_VERSION, ...cleanRecord(1_000) }), null);
});

test("a state file whose recorded instant and timestamp disagree is refused", () => {
  const tampered = { marker: STATE_MARKER, version: STATE_VERSION, ...cleanRecord(1_000) };
  tampered.at = new Date(999_000_000).toISOString();
  assert.match(validateState(tampered), /recorded instant and its timestamp disagree/);
});

test("a state file whose start timestamp is out of range is refused, not thrown", () => {
  // A finite millisecond count outside the range a Date can hold has no ISO
  // form, and asking for one throws.  The file must be refused instead.
  const state = {
    marker: STATE_MARKER,
    version: STATE_VERSION,
    atMs: 1e18,
    at: "not a date",
    verdict: { ok: true },
    harnessServicePresent: false,
  };
  const reason = validateState(state);
  assert.match(String(reason), /outside the range a date can hold/);
});

test("the CLI records the start of the soak and judges the end of it", () => {
  const directory = mkdtempSync(join(tmpdir(), "botfleet-soak-24h-"));
  try {
    const check = join(directory, "fake-reboot-check.mjs");
    writeFileSync(check, CLEAN_CHECK);
    const statePath = join(directory, "soak.json");

    const started = spawnSync("node", [cli, "start", "--out", statePath, "--reboot-check", check], {
      encoding: "utf8",
    });
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /soak start recorded at/);

    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.marker, STATE_MARKER);
    assert.equal(state.verdict.ok, true);
    assert.equal(state.harnessServicePresent, false);

    // A soak that has only just started has not run its 24 hours yet.
    const tooSoon = spawnSync("node", [cli, "end", "--state", statePath, "--reboot-check", check], {
      encoding: "utf8",
    });
    assert.equal(tooSoon.status, 1, "a window shorter than 24 hours must not pass");
    assert.match(tooSoon.stderr, /short of the 24h 0m minimum/);

    // Move the window's start back a day and a quarter, the way a day of
    // waiting would have moved it.
    const aged = { ...state, atMs: Date.now() - 25 * 60 * 60 * 1000 };
    aged.at = new Date(aged.atMs).toISOString();
    writeFileSync(statePath, JSON.stringify(aged, null, 2));

    const finished = spawnSync("node", [cli, "end", "--state", statePath, "--reboot-check", check], {
      encoding: "utf8",
    });
    assert.equal(finished.status, 0, finished.stderr);
    assert.match(finished.stdout, /the 24-hour window ran .* with a clean observation at each end/);
    // A green verdict must not read as a claim about the interval between the
    // two observations, so the scope note travels with it and the old
    // overstating wording is gone.
    assert.match(finished.stdout, /observed the window at both ends and nowhere in between/);
    assert.doesNotMatch(finished.stdout, /the 24-hour soak is satisfied/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a green verdict states what it did not observe", () => {
  assert.match(SCOPE_NOTE, /both ends and nowhere in between/);
  assert.match(SCOPE_NOTE, /does not establish/);
  assert.match(SCOPE_NOTE, /BF-2514/);
});

test("the CLI refuses a missing, malformed or foreign state file", () => {
  const directory = mkdtempSync(join(tmpdir(), "botfleet-soak-24h-"));
  try {
    const check = join(directory, "fake-reboot-check.mjs");
    writeFileSync(check, CLEAN_CHECK);

    const missing = spawnSync("node", [cli, "end", "--state", join(directory, "nope.json"), "--reboot-check", check], {
      encoding: "utf8",
    });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /does not exist/);

    const malformed = join(directory, "malformed.json");
    writeFileSync(malformed, "{not json");
    const broken = spawnSync("node", [cli, "end", "--state", malformed, "--reboot-check", check], {
      encoding: "utf8",
    });
    assert.equal(broken.status, 2);
    assert.match(broken.stderr, /is not valid JSON/);

    const foreign = join(directory, "foreign.json");
    writeFileSync(foreign, JSON.stringify({ soak: "24h", startedAt: "yesterday" }));
    const other = spawnSync("node", [cli, "end", "--state", foreign, "--reboot-check", check], {
      encoding: "utf8",
    });
    assert.equal(other.status, 2);
    assert.match(other.stderr, /carries no botfleet-soak-24h marker/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the CLI refuses a reboot check that printed no verdict", () => {
  const directory = mkdtempSync(join(tmpdir(), "botfleet-soak-24h-"));
  try {
    const check = join(directory, "silent-reboot-check.mjs");
    writeFileSync(check, "process.exit(0);\n");
    const result = spawnSync("node", [cli, "start", "--out", join(directory, "soak.json"), "--reboot-check", check], {
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /could not capture the reboot verdict/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the CLI refuses a mode it does not know", () => {
  const result = spawnSync("node", [cli], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: node scripts\/check-soak-24h\.mjs start/);
});
