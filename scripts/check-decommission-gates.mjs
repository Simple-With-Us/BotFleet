// Refuse the Phase 6 Node decommission until every gate it depends on is
// green (BF-2515).  Deleting server/, companion/ and the Node build chain is
// the one irreversible step in the native rewrite: done early it does not
// degrade a feature, it stops every bot.  The port inventory already says
// what replaces each file; this script says whether the replacements have
// actually landed, in a form a human or a workflow can run before anyone
// types `git rm`.
//
// Input is a plain JSON state file so the check itself needs no network and
// can be unit-tested with fixtures:
//
//   {
//     "scope":    { "retire": ["app.botfleet.server"],
//                   "retain": ["deploy/linux-server"] },
//     "issues":   { "BF-2510": "Done", "BF-2514": "In Progress", ... },
//     "evidence": { "soak-24h-no-node": false, "replay-parity": true, ... }
//   }
//
// Issue states are Linear workflow state names ("Todo", "In Progress",
// "In Review", "Done", ...).  Anything that is not a completed state counts
// as unmet: "In Review" is not landed, and this gate is precisely about not
// mistaking nearly-done for done.  A canceled or duplicate issue is unmet
// too: those states mean the work was abandoned, not that it landed.
// Refresh the state file from Linear at run time (board api query ...
// project issues) rather than editing it by hand; a stale all-Done file is
// the one input that defeats the guard, so the CLI prints the age of the
// file it read when it can stat it.
//
// Scope (BF-2544).  This gate covers the Mac's Node harness LaunchAgent
// (app.botfleet.server) and the Node files it runs, and nothing else.  The
// optional server deployment under deploy/linux-server survives the native
// rewrite by decision, so the state file must declare the retirement scope
// explicitly and must retain that path; a scope that would retire it is a
// blocker, not a warning.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const COMPLETED = new Set(["done", "completed", "complete"]);

/** The Mac harness LaunchAgent Phase 6 retires.  It is the whole scope. */
export const HARNESS_LAUNCH_AGENT = "app.botfleet.server";

/** The optional server deployment, retained by decision (BF-2544). */
export const OPTIONAL_SERVER_DEPLOYMENT = "deploy/linux-server";

/** Issues that must be Done before any Node deletion lands. */
export const REQUIRED_ISSUES = [
  {
    id: "BF-2510",
    why: "the iOS companion endpoint ruling decides whether a slim Node companion host survives; deleting first answers it by accident",
  },
  {
    id: "BF-2511",
    why: "the chosen companion endpoint must be built, or paired phones strand at cutover",
  },
  {
    id: "BF-2512",
    why: "the Swift Zulip actor and Linear sync client replace server/zulip/* and the Linear write path",
  },
  {
    id: "BF-2513",
    why: "the Swift routines and webhooks scheduler replaces the Node scheduler that fires every routine",
  },
  {
    id: "BF-2503",
    why: "replay fixtures must be captured from the events/*.ndjson tee before the tee stops, or engine parity becomes unprovable",
  },
  {
    id: "BF-2504",
    why: "the EngineDriver contract and core actors are the runtime every native engine turn runs on",
  },
  {
    id: "BF-2514",
    why: "the single-writer cutover retires app.botfleet.server and owns the 24-hour no-Node run; Phase 6 owns only the reboot check after it",
  },
];

/** Evidence that lives outside Linear and must be asserted explicitly. */
export const REQUIRED_EVIDENCE = [
  {
    id: "soak-24h-no-node",
    why: "Phase 5 exit: 24 hours with the Node harness stopped and its launchd job booted out, every bot answering",
  },
  {
    id: "replay-parity",
    why: "each engine's recorded turns replay through EngineDriver with the same ordered TurnEvent kinds the Node harness recorded",
  },
  {
    id: "final-import-parity",
    why: "the final import parity report matches and the Node store is archived read-only, with rollback rehearsed once",
  },
  {
    id: "inventory-clean",
    why: "scripts/audit-node-decommission.mjs reports no file in server/, companion/, shared/ or electron/ without a Swift owner or a retired reason",
  },
];

export function isCompletedState(name) {
  return typeof name === "string" && COMPLETED.has(name.trim().toLowerCase());
}

/**
 * The retirement scope a state file must declare.  `retire` names what this
 * decommission removes and `retain` names what survives it, so a scope
 * mistake is a visible blocker instead of a deleted directory.
 */
export const ScopeSchema = z.strictObject({
  retire: z.array(z.string().min(1)),
  retain: z.array(z.string().min(1)),
});

/** The state file, validated at the trust boundary before it decides. */
export const StateSchema = z.strictObject({
  scope: ScopeSchema,
  issues: z.record(z.string(), z.string()),
  evidence: z.record(z.string(), z.boolean()),
});

/**
 * Blockers for a retirement scope that is missing, too wide, or would take
 * the optional server deployment with it (BF-2544).
 */
export function scopeBlockers(scope) {
  const blockers = [];
  if (!scope) {
    blockers.push(
      `scope: no retirement scope supplied — declare scope.retire = ["${HARNESS_LAUNCH_AGENT}"] ` +
        `and scope.retain = ["${OPTIONAL_SERVER_DEPLOYMENT}"]`,
    );
    return blockers;
  }
  const retire = Array.isArray(scope.retire) ? scope.retire : [];
  const retain = Array.isArray(scope.retain) ? scope.retain : [];
  if (!retire.includes(HARNESS_LAUNCH_AGENT)) {
    blockers.push(
      `scope: the retirement must name the Mac harness LaunchAgent ${HARNESS_LAUNCH_AGENT}; ` +
        `got ${JSON.stringify(retire)}`,
    );
  }
  const takesTheServer = retire.filter(
    (path) =>
      path === OPTIONAL_SERVER_DEPLOYMENT ||
      path.startsWith(`${OPTIONAL_SERVER_DEPLOYMENT}/`) ||
      path.startsWith("deploy/") ||
      path.includes("linux-server"),
  );
  if (takesTheServer.length > 0) {
    blockers.push(
      `scope: ${takesTheServer.join(", ")} would retire the optional server deployment ` +
        `(${OPTIONAL_SERVER_DEPLOYMENT}); BF-2544 keeps it — Phase 6 retires the Mac harness only`,
    );
  }
  if (!retain.includes(OPTIONAL_SERVER_DEPLOYMENT)) {
    blockers.push(
      `scope: the optional server deployment (${OPTIONAL_SERVER_DEPLOYMENT}) must be listed in ` +
        `scope.retain; BF-2544 keeps it`,
    );
  }
  return blockers;
}

/**
 * Evaluate one state object.  Pure: the same input always earns the same
 * verdict, so the decision can be replayed in tests and in CI.
 */
export function evaluateGates(state = {}) {
  const issues = state.issues ?? {};
  const evidence = state.evidence ?? {};
  const blockers = [];
  for (const gate of REQUIRED_ISSUES) {
    const current = issues[gate.id];
    if (current === undefined) {
      blockers.push(`${gate.id}: no state supplied (treating as unmet) — ${gate.why}`);
    } else if (!isCompletedState(current)) {
      blockers.push(`${gate.id}: ${current} — ${gate.why}`);
    }
  }
  for (const gate of REQUIRED_EVIDENCE) {
    if (evidence[gate.id] !== true) {
      blockers.push(`evidence ${gate.id}: not asserted — ${gate.why}`);
    }
  }
  // The scope guard comes last so the blocker list still opens with the
  // unfinished work, not with the shape of the file that reported it.
  blockers.push(...scopeBlockers(state.scope));
  return { ok: blockers.length === 0, blockers };
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
  const [, , statePath] = process.argv;
  if (!statePath || !existsSync(statePath)) {
    console.error(
      "usage: node scripts/check-decommission-gates.mjs <state.json>\n" +
        'state.json: {"scope": {"retire": ["app.botfleet.server"], "retain": ["deploy/linux-server"]},\n' +
        '            "issues": {"BF-2510": "Done", ...}, "evidence": {"soak-24h-no-node": true, ...}}\n' +
        "the deletion order this gate protects: docs/native-rewrite-decommission-runbook.md",
    );
    process.exit(2);
  }
  const ageHours = (Date.now() - statSync(statePath).mtimeMs) / 3_600_000;
  if (ageHours > 24) {
    console.error(
      `warning: ${statePath} is ${Math.floor(ageHours)}h old; refresh it from Linear before trusting this verdict`,
    );
  }
  let rawState;
  try {
    rawState = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    console.error(`Phase 6 decommission is BLOCKED: ${statePath} is not valid JSON (${error.message})`);
    process.exit(1);
  }
  // The file is untrusted input: an invalid issue state or a hand-edited
  // evidence flag must not reach the gate, and an invalid scope must not
  // widen the retirement.
  const parsed = StateSchema.safeParse(rawState);
  if (!parsed.success) {
    console.error(`Phase 6 decommission is BLOCKED: ${statePath} does not match the state schema`);
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    process.exit(1);
  }
  const verdict = evaluateGates(parsed.data);
  if (!verdict.ok) {
    console.error("Phase 6 decommission is BLOCKED:");
    for (const blocker of verdict.blockers) console.error(`  - ${blocker}`);
    process.exit(1);
  }
  console.log(
    "Phase 6 decommission gates: all green. Deletion may proceed for the Mac Node harness; " +
      "the reboot check still belongs to BF-2515.",
  );
  console.log(
    `Scope: this covers the Mac harness LaunchAgent ${HARNESS_LAUNCH_AGENT} and the Node files it runs. ` +
      `The optional server deployment (${OPTIONAL_SERVER_DEPLOYMENT}) survives Phase 6 and is not in scope for deletion.`,
  );
  console.log(
    "The Electron shell and its updater feed additionally need BF-2485 and BF-2486; see docs/native-rewrite-decommission-runbook.md steps 6 and 7.",
  );
}
