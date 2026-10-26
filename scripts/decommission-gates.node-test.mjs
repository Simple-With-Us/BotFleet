import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  HARNESS_LAUNCH_AGENT,
  OPTIONAL_SERVER_DEPLOYMENT,
  StateSchema,
  evaluateGates,
  isCompletedState,
} from "./check-decommission-gates.mjs";
import {
  INVENTORY_DOCS,
  RETAINED_PATHS,
  findMissingRetained,
  findUncovered,
  retainedFiles,
  trackedFiles,
} from "./audit-node-decommission.mjs";

// The retirement scope BF-2544 asks for: the Mac's Node harness LaunchAgent
// goes, the optional server deployment stays.
const SCOPE = {
  retire: [HARNESS_LAUNCH_AGENT],
  retain: [OPTIONAL_SERVER_DEPLOYMENT],
};

const ALL_DONE = {
  scope: SCOPE,
  issues: {
    "BF-2510": "Done",
    "BF-2511": "Done",
    "BF-2512": "Done",
    "BF-2513": "Done",
    "BF-2503": "Done",
    "BF-2504": "Done",
    "BF-2514": "Done",
  },
  evidence: {
    "soak-24h-no-node": true,
    "replay-parity": true,
    "final-import-parity": true,
    "inventory-clean": true,
  },
};

test("all gates green lets the decommission proceed", () => {
  assert.deepEqual(evaluateGates(ALL_DONE), { ok: true, blockers: [] });
});

test("today's Phase 6 state is blocked, naming the unruled decision first", () => {
  const verdict = evaluateGates({
    issues: { "BF-2510": "In Progress", "BF-2502": "Done" },
    evidence: {},
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.blockers[0], /^BF-2510: In Progress/);
  // Missing states are unmet, never silently green.
  assert.ok(verdict.blockers.some((line) => line.startsWith("BF-2514: no state supplied")));
  assert.ok(verdict.blockers.some((line) => line.startsWith("evidence soak-24h-no-node")));
});

test("In Review is not landed", () => {
  assert.equal(isCompletedState("In Review"), false);
  assert.equal(isCompletedState("Done"), true);
  assert.equal(isCompletedState(" completed "), true);
  const verdict = evaluateGates({
    ...ALL_DONE,
    issues: { ...ALL_DONE.issues, "BF-2514": "In Review" },
  });
  assert.equal(verdict.ok, false);
});

test("one unasserted evidence item blocks on its own", () => {
  const verdict = evaluateGates({
    ...ALL_DONE,
    evidence: { ...ALL_DONE.evidence, "final-import-parity": false },
  });
  assert.deepEqual(verdict.blockers.length, 1);
  assert.match(verdict.blockers[0], /final-import-parity/);
});

test("a canceled or duplicate issue is unmet, not landed", () => {
  // Cancelled means the work was abandoned; a duplicate points at work that
  // may never have happened.  Either way the replacement never landed, and
  // the gate is precisely about not mistaking that for done.
  assert.equal(isCompletedState("Cancelled"), false);
  assert.equal(isCompletedState("Canceled"), false);
  assert.equal(isCompletedState("Duplicate"), false);
  for (const state of ["Cancelled", "Duplicate"]) {
    const verdict = evaluateGates({
      ...ALL_DONE,
      issues: { ...ALL_DONE.issues, "BF-2514": state },
    });
    assert.equal(verdict.ok, false, state);
    assert.ok(
      verdict.blockers.some((line) => line.startsWith("BF-2514:")),
      `${state} must name the issue`,
    );
  }
});

test("the gate refuses a retirement that would take the optional server deployment", () => {
  const verdict = evaluateGates({
    ...ALL_DONE,
    scope: {
      retire: [HARNESS_LAUNCH_AGENT, OPTIONAL_SERVER_DEPLOYMENT],
      retain: [],
    },
  });
  assert.equal(verdict.ok, false);
  assert.ok(
    verdict.blockers.some((line) => /BF-2544 keeps it/.test(line)),
    `blockers: ${verdict.blockers.join(" | ")}`,
  );
});

test("the gate refuses a scope that forgets to retain the optional server deployment", () => {
  const verdict = evaluateGates({
    ...ALL_DONE,
    scope: { retire: [HARNESS_LAUNCH_AGENT], retain: [] },
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.blockers.some((line) => /must be listed in scope\.retain/.test(line)));
});

test("the gate refuses a scope that does not name the Mac harness LaunchAgent", () => {
  const verdict = evaluateGates({
    ...ALL_DONE,
    scope: { retire: ["server"], retain: [OPTIONAL_SERVER_DEPLOYMENT] },
  });
  assert.equal(verdict.ok, false);
  assert.ok(
    verdict.blockers.some((line) => line.includes(HARNESS_LAUNCH_AGENT)),
    `blockers: ${verdict.blockers.join(" | ")}`,
  );
});

test("a missing scope is unmet: the retirement scope is never assumed", () => {
  const verdict = evaluateGates({
    issues: ALL_DONE.issues,
    evidence: ALL_DONE.evidence,
  });
  assert.equal(verdict.ok, false);
  assert.ok(
    verdict.blockers.some((line) => line.startsWith("scope: no retirement scope supplied")),
    `blockers: ${verdict.blockers.join(" | ")}`,
  );
});

test("the state file is validated before it decides anything", () => {
  assert.equal(StateSchema.safeParse(ALL_DONE).success, true);
  // An unknown key means the file was hand-edited into a shape the gate
  // never agreed to read.
  assert.equal(StateSchema.safeParse({ ...ALL_DONE, extra: true }).success, false);
  // Evidence must be a boolean claim, not a string that reads as true.
  assert.equal(
    StateSchema.safeParse({
      ...ALL_DONE,
      evidence: { ...ALL_DONE.evidence, "inventory-clean": "true" },
    }).success,
    false,
  );
  // A state file without a scope cannot say what it retires.
  assert.equal(
    StateSchema.safeParse({ issues: ALL_DONE.issues, evidence: ALL_DONE.evidence }).success,
    false,
  );
});

const INVENTORY = [
  "Owner table:",
  "| `server/zulip/*` (13 files) | `ZulipEventActor` BF-2512 |",
  "| `server/store.ts`, `server/mcp-{gate,registry}.ts` | `DatabaseService` BF-2480 |",
  "| `electron/main.mjs:1006-1078` | **BF-2497** |",
  "| `redact.ts` | portable port |",
].join("\n");

test("audit covers glob siblings, brace expansions and test twins", () => {
  const uncovered = findUncovered(
    [
      "server/zulip/client.ts",
      "server/zulip/new-arrival.ts",
      "server/store.ts",
      "server/store.test.ts",
      "server/mcp-gate.ts",
      "server/mcp-registry.test.ts",
      "electron/main.mjs",
      "shared/redact.ts",
    ],
    INVENTORY,
  );
  assert.deepEqual(uncovered, []);
});

test("audit flags a new subsystem in a new place", () => {
  const uncovered = findUncovered(
    ["server/zulip/client.ts", "server/telepathy/beams.ts", "server/telepathy/beams.test.ts"],
    INVENTORY,
  );
  assert.deepEqual(uncovered, ["server/telepathy/beams.test.ts", "server/telepathy/beams.ts"]);
});

test("feature tests follow their subsystem's prefix", () => {
  const uncovered = findUncovered(
    ["server/zulip/client.ts", "server/zulip/client-reconnect-storm.test.ts"],
    INVENTORY,
  );
  assert.deepEqual(uncovered, []);
});

// The fixtures above prove the matcher works; this one proves the committed
// tree is still covered by it.  Without it the audit is a script somebody has
// to remember to run, and the drift it exists to catch — a subsystem landing
// on main with no owner row — is exactly the change nobody remembers to
// audit.  It happened twice: BF-2544 added electron/server-target.mjs and its
// twins, #1335 added server/provider-reload-order.test.ts, and neither showed
// up until the audit was run by hand on 2026-10-25.
test("the tree as committed is fully covered by the inventories", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const inventoryText = INVENTORY_DOCS.map((doc) =>
    readFileSync(join(repoRoot, doc), "utf8"),
  ).join("\n");
  const uncovered = findUncovered(trackedFiles(repoRoot), inventoryText);
  assert.deepEqual(
    uncovered,
    [],
    `no inventory row names these files, so BF-2514/BF-2515 cannot cite the inventory as their gate: ${uncovered.join(", ")}`,
  );
});

/** A throwaway git repository with one commit, for the retained-path audit. */
function makeTempRepo(files) {
  const directory = mkdtempSync(join(tmpdir(), "botfleet-retained-"));
  execFileSync("git", ["init", "-q", "-b", "main", directory]);
  execFileSync("git", ["-C", directory, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", directory, "config", "user.name", "Test"]);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, name)), { recursive: true });
    writeFileSync(join(directory, name), body);
  }
  execFileSync("git", ["-C", directory, "add", "-A"]);
  execFileSync("git", ["-C", directory, "commit", "-q", "-m", "fixture"]);
  return directory;
}

test("the optional server deployment is audited as retained, and its loss is a finding", () => {
  // BF-2544: the server deployment survives the native rewrite.  The audit
  // records that on purpose, and fails when the path disappears.
  const entry = RETAINED_PATHS.find((item) => item.path === OPTIONAL_SERVER_DEPLOYMENT);
  assert.ok(entry, "the optional server deployment must be a declared retained path");
  assert.match(entry.why, /BF-2544/);

  const repo = makeTempRepo({ "deploy/linux-server/install.sh": "#!/bin/sh\n" });
  try {
    assert.deepEqual(findMissingRetained(repo), []);
    rmSync(join(repo, "deploy/linux-server"), { recursive: true, force: true });
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "drop the server"]);
    assert.deepEqual(findMissingRetained(repo), [OPTIONAL_SERVER_DEPLOYMENT]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the committed tree still holds the optional server deployment", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  assert.deepEqual(findMissingRetained(repoRoot), []);
  const retained = retainedFiles(repoRoot);
  assert.ok(retained.length > 0, "deploy/linux-server must hold tracked files");
  assert.ok(retained.every((file) => file.startsWith(`${OPTIONAL_SERVER_DEPLOYMENT}/`)));
});
