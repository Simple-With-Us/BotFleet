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
//     "issues":   { "BF-2510": "Done", "BF-2514": "In Progress", ... },
//     "evidence": { "soak-24h-no-node": false, "replay-parity": true, ... }
//   }
//
// Issue states are Linear workflow state names ("Todo", "In Progress",
// "In Review", "Done", ...).  Anything that is not a completed state counts
// as unmet: "In Review" is not landed, and this gate is precisely about not
// mistaking nearly-done for done.  Refresh the state file from Linear at
// run time (board api query ... project issues) rather than editing it by
// hand; a stale all-Done file is the one input that defeats the guard, so
// the CLI prints the age of the file it read when it can stat it.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const COMPLETED = new Set(["done", "completed", "complete", "cancelled", "canceled", "duplicate"]);

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
        'state.json: {"issues": {"BF-2510": "Done", ...}, "evidence": {"soak-24h-no-node": true, ...}}',
    );
    process.exit(2);
  }
  const ageHours = (Date.now() - statSync(statePath).mtimeMs) / 3_600_000;
  if (ageHours > 24) {
    console.error(
      `warning: ${statePath} is ${Math.floor(ageHours)}h old; refresh it from Linear before trusting this verdict`,
    );
  }
  const verdict = evaluateGates(JSON.parse(readFileSync(statePath, "utf8")));
  if (!verdict.ok) {
    console.error("Phase 6 decommission is BLOCKED:");
    for (const blocker of verdict.blockers) console.error(`  - ${blocker}`);
    process.exit(1);
  }
  console.log("Phase 6 decommission gates: all green. Deletion may proceed; the reboot check still belongs to BF-2515.");
}
