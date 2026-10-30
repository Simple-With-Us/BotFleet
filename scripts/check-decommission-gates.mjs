// Refuse the Phase 6 Node decommission until every gate it depends on is
// green (BF-2515).  Deleting the Mac-local Node harness is the one
// irreversible step in the native rewrite: done early it does not degrade a
// feature, it stops every bot.  The port inventory already says what replaces
// each file; this script says whether the replacements have actually landed,
// in a form a human or a workflow can run before anyone types `git rm`.
//
// SCOPE: the deletion target is the Mac-local Node stack; BotFleet may also
// run with the server as the primary BotFleet server (BF-2544), and
// deploy/linux-server/ ships the SAME server/ code as that optional
// deployment; the deployment path is retained, but its dependency on shared
// source has a separate preservation-evidence gate before that source can be
// deleted; the Linux path is named in RETAINED_OPTIONAL_SERVER_PATHS, and
// scripts/audit-node-decommission.mjs records it as retained rather than as
// an uncovered file.
//
// Input is a plain JSON state file so the check itself needs no network and
// can be unit-tested with fixtures:
//
//   {
//     "issues":   { "BF-2510": "Done", "BF-2514": "In Progress", ... },
//     "evidence": { "soak-24h-no-node": false, "replay-parity": true, ... },
//     "macLocalHarness": {
//       "present": false,
//       "retained": { "deploy/linux-server/": "optional server deployment (BF-2544)" }
//     }
//   }
//
// Issue states are Linear workflow state names ("Todo", "In Progress",
// "In Review", "Done", ...).  Anything that is not a completed state counts
// as unmet: "In Review" is not landed, and this gate is precisely about not
// mistaking nearly-done for done.  Cancelled and duplicate are not landed
// either: the replacement never existed, so deleting the code it was to
// replace stops the bots.  Refresh the state file from Linear at run time
// (board api query ... project issues) rather than editing it by hand; a
// stale all-Done file is the one input that defeats the guard, so the CLI
// prints the age of the file it read when it can stat it.
//
// The state file is the trust boundary: it decides whether an irreversible
// deletion may happen, so it is parsed against a strict schema and only the
// validated result reaches evaluateGates.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Issue states that mean the replacement actually landed. */
const COMPLETED = new Set(["done", "completed", "complete"]);

/**
 * The Mac-local Node stack this gate retires.  The optional server
 * deployment is deliberately NOT one of them: deploy/linux-server/ ships the
 * same server/ code and stays (BF-2544).
 */
export const MAC_LOCAL_ROOTS = ["server", "companion", "shared", "electron"];

/**
 * Paths the decommission deliberately keeps.  The optional server deployment
 * is one of them, and naming it here is what makes the exclusion explicit:
 * the gate never blocks on it, and the audit records it as retained rather
 * than as an uncovered file.
 */
export const RETAINED_OPTIONAL_SERVER_PATHS = ["deploy/linux-server/"];

/**
 * Surfaces that are not part of the Mac-local Node stack, or whose source is
 * deliberately retained, but still depend on parts of the stack being
 * removed: BotFleet Control (mac-control/) is Swift, so no inventory row
 * retires it, yet every local thing it does goes through that stack: its
 * six HTTP routes live only in server/index.ts, it supervises the
 * app.botfleet.server and app.botfleet.companion LaunchAgents and pm2
 * botfleet-mcp, its offline VM helper is compiled from
 * server/local-vm-offline-cli.ts, and its only build and install path is the
 * Electron packaging that Step 6 deletes.  Deleting the stack with Control's
 * future undecided leaves a menu bar app whose every row reads "not
 * installed", so the decision is a gate (BF-2583).
 */
export const DEPENDENT_SURFACES = [
  {
    path: "mac-control/",
    decision: "docs/plans/2026-10-29-botfleet-control-after-node.md",
    evidence: "control-disposition",
    why: "BotFleet Control's local half (:8799 routes, LaunchAgents, pm2, the offline VM helper, the Electron-side build) is the Mac-local Node stack; its post-Node disposition is Decision 1 of the plan and must be recorded and landed before the stack is deleted",
  },
  {
    path: "deploy/linux-server/",
    decision: "docs/native-rewrite-linux-source-retention.md",
    evidence: "linux-server-preservation",
    why: "the Linux deployment uses server/ and shared/ source plus a built dist/ UI, its required runtime (Node today), update refs, and rollback; verify the maintained source/build/update/rollback closure or a verified replacement before deleting any part of that closure",
  },
];

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
    id: "placement-evidence",
    why: "BF-2559's sixteen placement and headroom recipes pass scripts/check-placement-evidence.mjs, including Mac runs, authorized server fixture runs and both host inventories; a foundation contract or CI alone does not assert this evidence",
  },
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
    why: `scripts/audit-node-decommission.mjs reports no file in ${MAC_LOCAL_ROOTS.join(", ")} without a Swift owner or a retired reason; deploy/linux-server/ is retained and its shared-source dependency is separately gated`,
  },
  {
    id: "control-disposition",
    why: `BotFleet Control's post-Node disposition (Decision 1 in ${DEPENDENT_SURFACES[0].decision}) is recorded by the owner and landed: Control is retired with the Electron shell, kept with a native control channel and its own build path, or split so the native app owns the lifecycle surface; until then mac-control/ stops working at cutover (BF-2583)`,
  },
  {
    id: "linux-server-preservation",
    why: `BF-2544's Linux mode has a maintained ${DEPENDENT_SURFACES[1].decision} source/build/update/rollback closure, or a verified replacement preserving the Linux harness, UI, required runtime, update and rollback paths; verify this explicitly before deleting shared source.\u00A0 Do not infer it from the retained directory, inventory-clean, the Mac soak, or issue states`,
  },
];

/**
 * The state file's schema.  Strict on purpose: a mistyped key must fail
 * loudly rather than read as an unasserted gate.
 */
export const StateSchema = z.strictObject({
  issues: z.record(z.string(), z.string()).optional(),
  evidence: z.record(z.string(), z.boolean()).optional(),
  macLocalHarness: z
    .strictObject({
      present: z.boolean(),
      retained: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});

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
  const retained = [];
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
  // The Mac-local harness itself.  This is the gate's stated purpose: the
  // Mac no longer runs the Node stack.
  const harness = state.macLocalHarness;
  if (harness === undefined) {
    blockers.push(
      "macLocalHarness: no state supplied (treating as unmet) — assert that the Mac no longer runs the Node harness",
    );
  } else if (harness.present !== false) {
    blockers.push(
      "macLocalHarness: still present — the Mac-local Node harness must be gone before the code it runs is deleted",
    );
  }
  // The optional server deployment is an approved exclusion, so declaring it
  // retained is recorded and never blocked.  Any OTHER retained path is a
  // finding: it means Mac-local code was quietly spared.
  for (const [path, why] of Object.entries(harness?.retained ?? {})) {
    if (!RETAINED_OPTIONAL_SERVER_PATHS.includes(path)) {
      blockers.push(
        `retained ${path}: not an approved exclusion — only ${RETAINED_OPTIONAL_SERVER_PATHS.join(", ")} may be retained`,
      );
      continue;
    }
    retained.push({ path, why });
  }
  return { ok: blockers.length === 0, blockers, retained };
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
        'state.json: {"issues": {"BF-2510": "Done", ...}, "evidence": {"soak-24h-no-node": true, "control-disposition": true, ...}, "macLocalHarness": {"present": false, "retained": {"deploy/linux-server/": "optional server deployment (BF-2544)"}}}\n' +
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
  let raw;
  try {
    raw = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${statePath} is not valid JSON: ${message}`);
    process.exit(2);
  }
  const parsed = StateSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(`error: ${statePath} does not match the state schema:`);
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    process.exit(2);
  }
  const verdict = evaluateGates(parsed.data);
  if (!verdict.ok) {
    console.error("Phase 6 decommission is BLOCKED:");
    for (const blocker of verdict.blockers) console.error(`  - ${blocker}`);
    process.exit(1);
  }
  console.log("Phase 6 decommission gates: all green. Deletion may proceed; the reboot check still belongs to BF-2515.");
  console.log(
    `Scope: the Mac-local Node harness only (${MAC_LOCAL_ROOTS.join(", ")}).\u00A0 ` +
      "The optional server deployment (deploy/linux-server/, BF-2544) is retained, and its shared source has a separate preservation evidence gate.",
  );
  for (const entry of verdict.retained) {
    console.log(`Retained on purpose: ${entry.path} — ${entry.why}`);
  }
  for (const entry of DEPENDENT_SURFACES) {
    console.log(`Depends on the stack being deleted: ${entry.path} — evidence ${entry.evidence} per ${entry.decision}`);
  }
  console.log(
    "The Electron shell and its updater feed additionally need BF-2485 and BF-2486; see docs/native-rewrite-decommission-runbook.md steps 6 and 7.",
  );
}
