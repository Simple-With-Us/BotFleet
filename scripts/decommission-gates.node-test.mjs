import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MAC_LOCAL_ROOTS,
  REQUIRED_ISSUES,
  RETAINED_OPTIONAL_SERVER_PATHS,
  StateSchema,
  evaluateGates,
  isCompletedState,
} from "./check-decommission-gates.mjs";
import {
  AUDITED_ROOTS,
  INVENTORY_DOCS,
  RETAINED_PATHS,
  findUncovered,
  retainedFiles,
  trackedFiles,
} from "./audit-node-decommission.mjs";
import { buildGateState, collectLinearNodes, unwrapNodes } from "./decommission-gate-state.mjs";

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
  // The Mac-local harness is gone, and the optional server deployment is
  // kept on purpose.
  macLocalHarness: {
    present: false,
    retained: { "deploy/linux-server/": "optional server deployment (BF-2544)" },
  },
};

test("all gates green lets the decommission proceed", () => {
  assert.deepEqual(evaluateGates(ALL_DONE), {
    ok: true,
    blockers: [],
    retained: [
      { path: "deploy/linux-server/", why: "optional server deployment (BF-2544)" },
    ],
  });
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
  assert.ok(verdict.blockers.some((line) => line.startsWith("macLocalHarness: no state supplied")));
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

test("a cancelled or duplicate issue is not landed", () => {
  // Cancelled and duplicate mean the replacement never existed, so deleting
  // the code they were to replace stops the bots.  Only a state that means
  // the work landed satisfies a gate.
  for (const state of ["Cancelled", "Canceled", "Duplicate"]) {
    assert.equal(isCompletedState(state), false, `${state} must not count as completed`);
    const verdict = evaluateGates({
      ...ALL_DONE,
      issues: { ...ALL_DONE.issues, "BF-2514": state },
    });
    assert.equal(verdict.ok, false, `${state} must block the gate`);
    assert.ok(verdict.blockers.some((line) => line.startsWith("BF-2514:")));
  }
});

test("one unasserted evidence item blocks on its own", () => {
  const verdict = evaluateGates({
    ...ALL_DONE,
    evidence: { ...ALL_DONE.evidence, "final-import-parity": false },
  });
  assert.deepEqual(verdict.blockers.length, 1);
  assert.match(verdict.blockers[0], /final-import-parity/);
});

// BF-2544: BotFleet may run with the server as the primary BotFleet server,
// and deploy/linux-server/ ships that server code as the optional
// deployment.  The Phase 6 gate therefore guards the Mac-local harness only:
// it must pass with the optional server path still on disk, and it must
// still fail while the Mac-local harness is there.
test("the gate passes with the Mac-local harness gone and deploy/ retained", () => {
  const verdict = evaluateGates({
    issues: ALL_DONE.issues,
    evidence: ALL_DONE.evidence,
    macLocalHarness: {
      present: false,
      retained: { "deploy/linux-server/": "optional server deployment (BF-2544)" },
    },
  });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.blockers, []);
});

test("the gate still fails while the Mac-local harness is present", () => {
  const verdict = evaluateGates({
    ...ALL_DONE,
    macLocalHarness: {
      present: true,
      retained: { "deploy/linux-server/": "optional server deployment (BF-2544)" },
    },
  });
  assert.equal(verdict.ok, false);
  assert.ok(
    verdict.blockers.some((line) => line.startsWith("macLocalHarness: still present")),
    `expected the harness to block, got: ${verdict.blockers.join(" | ")}`,
  );
});

test("the optional server path is retained, never a blocker", () => {
  assert.deepEqual(RETAINED_OPTIONAL_SERVER_PATHS, ["deploy/linux-server/"]);
  assert.ok(!MAC_LOCAL_ROOTS.includes("deploy"));
  const verdict = evaluateGates(ALL_DONE);
  assert.equal(verdict.ok, true);
  assert.ok(verdict.blockers.every((line) => !line.includes("deploy/")));
  assert.deepEqual(verdict.retained, [
    { path: "deploy/linux-server/", why: "optional server deployment (BF-2544)" },
  ]);
});

test("a Mac-local path may not be quietly retained", () => {
  const verdict = evaluateGates({
    ...ALL_DONE,
    macLocalHarness: { present: false, retained: { "server/": "spared for now" } },
  });
  assert.equal(verdict.ok, false);
  assert.ok(
    verdict.blockers.some((line) => line.includes("not an approved exclusion")),
    `expected an unapproved retention to block, got: ${verdict.blockers.join(" | ")}`,
  );
});

test("the state file is validated before it reaches the gate", () => {
  // A malformed value must not decide an irreversible deletion.
  assert.equal(StateSchema.safeParse({ issues: { "BF-2510": 7 } }).success, false);
  assert.equal(StateSchema.safeParse({ evidence: { "soak-24h-no-node": "yes" } }).success, false);
  assert.equal(StateSchema.safeParse({ macLocalHarness: { present: "no" } }).success, false);
  assert.equal(StateSchema.safeParse({ issue: {} }).success, false);
  assert.equal(StateSchema.safeParse(ALL_DONE).success, true);
  for (const gate of REQUIRED_ISSUES) {
    assert.ok(ALL_DONE.issues[gate.id], `${gate.id} must have a state in the fixture`);
  }
});

test("the CLI validates the state file before it decides", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const cli = join(repoRoot, "scripts/check-decommission-gates.mjs");
  const directory = mkdtempSync(join(tmpdir(), "botfleet-gate-"));
  try {
    // A malformed evidence value must be refused before the gate runs: exit
    // 2 is the schema refusal, and exit 1 would mean the gate judged it.
    const malformed = join(directory, "malformed.json");
    writeFileSync(
      malformed,
      JSON.stringify({
        ...ALL_DONE,
        evidence: { ...ALL_DONE.evidence, "soak-24h-no-node": "yes" },
      }),
    );
    const refused = spawnSync("node", [cli, malformed], { encoding: "utf8" });
    assert.equal(refused.status, 2, "a malformed state file must be refused");
    assert.match(refused.stderr, /does not match the state schema/);

    // The same CLI prints the retained optional server path, so a reader
    // can see it is kept on purpose and not merely unmentioned.
    const green = join(directory, "green.json");
    writeFileSync(green, JSON.stringify(ALL_DONE));
    const passed = spawnSync("node", [cli, green], { encoding: "utf8" });
    assert.equal(passed.status, 0);
    assert.match(passed.stdout, /all green/);
    assert.match(passed.stdout, /Retained on purpose: deploy\/linux-server\//);
    assert.match(passed.stdout, /is deliberately retained and is not a decommission target/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

// The optional server deployment is audited too, and it is a documented
// exception rather than a finding: the audit must SEE it, and must report
// it as retained rather than as uncovered.
test("the audit covers deploy/ and records the optional server path as retained", () => {
  assert.ok(AUDITED_ROOTS.includes("deploy"), "deploy/ must be an audited root");
  const optional = [
    "deploy/linux-server/install.sh",
    "deploy/linux-server/common.sh",
    "deploy/linux-server/owner-gate.mjs",
  ];
  // No inventory row names them: the retained list is what covers them.
  assert.deepEqual(findUncovered(optional, INVENTORY), []);
  assert.deepEqual(retainedFiles(optional), [...optional].sort());
  assert.deepEqual(
    RETAINED_PATHS.map((entry) => entry.path),
    ["deploy/linux-server/"],
  );
  // A new subsystem under deploy/ is still drift, not a retained path.
  assert.deepEqual(findUncovered(["deploy/windows/thing.ps1"], INVENTORY), [
    "deploy/windows/thing.ps1",
  ]);
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
  const files = trackedFiles(repoRoot);
  const uncovered = findUncovered(files, inventoryText);
  assert.deepEqual(
    uncovered,
    [],
    `no inventory row names these files, so BF-2514/BF-2515 cannot cite the inventory as their gate: ${uncovered.join(", ")}`,
  );
  // The optional server path is inside the audited tree, and every one of
  // its files is reported as retained, so the exclusion stays visible.
  const retained = retainedFiles(files);
  assert.ok(retained.length > 0, "the audit must see deploy/ so the optional server path stays visible");
  assert.ok(
    retained.every((file) => file.startsWith("deploy/linux-server/")),
    `unexpected retained paths: ${retained.join(", ")}`,
  );
});

// The refresh step is where a safety gate usually leaks: somebody reshapes a
// GraphQL response by hand once, the file goes stale, and the guard reads a
// memory instead of a fact.  These pin the two properties that make the
// generated file trustworthy — a missing issue is visible rather than absent,
// and only the two machine-checkable halves are filled in.
const linearNodes = (states) =>
  Object.entries(states).map(([identifier, name]) => ({ identifier, state: { name } }));

const ALL_DONE_STATES = {
  "BF-2510": "Done",
  "BF-2511": "Done",
  "BF-2512": "Done",
  "BF-2513": "Done",
  "BF-2503": "Done",
  "BF-2504": "Done",
  "BF-2514": "Done",
};

test("generated state passes the gate's schema and blocks on the human-only halves", () => {
  const state = buildGateState(linearNodes(ALL_DONE_STATES), { inventoryClean: true });
  assert.equal(StateSchema.safeParse(state).success, true);
  // Even with every issue Done and the inventory clean, the generated file
  // blocks: the soak, the replays, the final import and the Mac harness
  // check all need a human to assert them.
  assert.equal(evaluateGates(state).ok, false);
  assert.ok(
    evaluateGates(state).blockers.some((blocker) => blocker.startsWith("evidence soak-24h-no-node")),
  );
  assert.ok(
    evaluateGates(state).blockers.some((blocker) => blocker.startsWith("macLocalHarness")),
  );
});

test("an issue Linear did not mention is recorded as Unknown, not omitted", () => {
  const { "BF-2504": _dropped, ...withoutOne } = ALL_DONE_STATES;
  const state = buildGateState(linearNodes(withoutOne), { inventoryClean: true });
  assert.equal(state.issues["BF-2504"], "Unknown");
  assert.ok(evaluateGates(state).blockers.some((blocker) => blocker.startsWith("BF-2504: Unknown")));
});

test("a dirty inventory blocks the gate even when every issue is Done", () => {
  const state = buildGateState(linearNodes(ALL_DONE_STATES), { inventoryClean: false });
  assert.equal(state.evidence["inventory-clean"], false);
  assert.ok(
    evaluateGates(state).blockers.some((blocker) => blocker.startsWith("evidence inventory-clean")),
  );
});

test("the Mac-only evidence is never filled in by a script", () => {
  const state = buildGateState(linearNodes(ALL_DONE_STATES), { inventoryClean: true });
  for (const id of ["soak-24h-no-node", "replay-parity", "final-import-parity"]) {
    assert.equal(state.evidence[id], false, `${id} must stay false unless a human asserts it`);
  }
  assert.equal(state.macLocalHarness.present, true);
});

test("identifiers outside the required set do not leak into the state", () => {
  const state = buildGateState(
    linearNodes({ ...ALL_DONE_STATES, "BF-9999": "Done" }),
    { inventoryClean: true },
  );
  assert.equal(Object.hasOwn(state.issues, "BF-9999"), false);
});

test("a malformed Linear node fails the refresh instead of writing a guess", () => {
  assert.throws(
    () =>
      buildGateState([{ identifier: "BF-2510", state: { name: 7 } }], {
        inventoryClean: true,
      }),
  );
});

test("a saved CLI dump unwraps like the live query does", () => {
  const nodes = linearNodes(ALL_DONE_STATES);
  assert.deepEqual(unwrapNodes(nodes), nodes);
  assert.deepEqual(unwrapNodes({ data: { issues: { nodes } } }), nodes);
  assert.deepEqual(unwrapNodes({ issues: { nodes } }), nodes);
  assert.throws(() => unwrapNodes({ data: { issues: { nodes: null } } }), /no Linear issues array/);
});

test("pagination stops as soon as every required issue has been seen", () => {
  let calls = 0;
  const nodes = collectLinearNodes(() => {
    calls += 1;
    return { nodes: linearNodes(ALL_DONE_STATES), pageInfo: { hasNextPage: true, endCursor: "cursor-1" } };
  });
  assert.equal(calls, 1);
  assert.equal(nodes.length, Object.keys(ALL_DONE_STATES).length);
});

test("pagination follows cursors until the required set is complete", () => {
  const first = linearNodes({ "BF-2510": "Done" });
  const rest = linearNodes({ ...ALL_DONE_STATES, "BF-2510": "Done" });
  const seen = [];
  const nodes = collectLinearNodes((after) => {
    seen.push(after);
    return after === null
      ? { nodes: first, pageInfo: { hasNextPage: true, endCursor: "cursor-1" } }
      : { nodes: rest, pageInfo: { hasNextPage: false, endCursor: null } };
  });
  assert.deepEqual(seen, [null, "cursor-1"]);
  const state = buildGateState(nodes, { inventoryClean: true });
  assert.equal(state.issues["BF-2514"], "Done");
});

test("pagination is capped so a broken cursor cannot loop forever", () => {
  let calls = 0;
  collectLinearNodes(() => {
    calls += 1;
    return { nodes: [], pageInfo: { hasNextPage: true, endCursor: `cursor-${calls}` } };
  });
  assert.equal(calls, 4);
});
