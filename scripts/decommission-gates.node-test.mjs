import assert from "node:assert/strict";
import test from "node:test";
import { evaluateGates, isCompletedState } from "./check-decommission-gates.mjs";
import { findUncovered } from "./audit-node-decommission.mjs";

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
