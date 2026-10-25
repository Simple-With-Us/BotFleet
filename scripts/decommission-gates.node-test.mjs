import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateGates, isCompletedState } from "./check-decommission-gates.mjs";
import { INVENTORY_DOCS, findUncovered, trackedFiles } from "./audit-node-decommission.mjs";

const ALL_DONE = {
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
