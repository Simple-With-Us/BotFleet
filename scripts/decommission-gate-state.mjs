// Emit the state file `check-decommission-gates.mjs` reads (BF-2515).
//
// The gate script's own comment names the one input that defeats it: a state
// file edited by hand, or a stale one whose issues have all been marked Done.
// Refreshing it used to mean reshaping a GraphQL response with a shell
// pipeline, which is exactly the kind of step that gets done from memory.
//
// So the refresh is one command, and the two halves that can be derived
// instead of asserted are derived:
//
//   - issue states come from Linear through the board CLI, and a failed query
//     exits non-zero rather than writing a partial file, so a refresh that did
//     not happen can never read as one that did;
//   - `inventory-clean` comes from running the audit against the committed
//     tree, so it is a measurement rather than somebody's belief about one.
//
// Everything else stays blocking on purpose.  The three evidence items that
// live on the Mac (the soak, replay parity and the final import) stay false:
// no command on this host can observe them, and a script that guessed would
// be worse than a human who has to say so.  `macLocalHarness.present` likewise
// stays true: only somebody on the Mac can verify the harness is gone, and
// the gate treats a missing or true value as unmet.  The optional server
// deployment is pre-filled as retained because it is the one approved
// exclusion, not a finding.
//
//   node scripts/decommission-gate-state.mjs --out /tmp/phase6-state.json
//   node scripts/decommission-gate-state.mjs --board-json <nodes.json> --out out.json
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  REQUIRED_EVIDENCE,
  REQUIRED_ISSUES,
  RETAINED_OPTIONAL_SERVER_PATHS,
  StateSchema,
} from "./check-decommission-gates.mjs";
import {
  INVENTORY_DOCS,
  findUncovered,
  trackedFiles,
} from "./audit-node-decommission.mjs";

const LINEAR_QUERY =
  'query { issues(filter: { team: { key: { eq: "BF" } } }, first: 250) { nodes { identifier state { name } } } }';

/** Evidence a script on this host cannot observe; only a human may assert it. */
export const HUMAN_ONLY_EVIDENCE = [
  "soak-24h-no-node",
  "replay-parity",
  "final-import-parity",
];

/**
 * Linear nodes, parsed at the boundary.  Anything that is not
 * `{ identifier, state: { name } }` with string values is rejected here,
 * where the refresh can refuse to write, rather than downstream where the
 * gate would have to guess what a malformed node meant.
 */
const LinearNodesSchema = z.array(
  z.object({
    identifier: z.string(),
    state: z.object({ name: z.string() }),
  }),
);

/**
 * Build the gate state from Linear nodes plus the audit's verdict.  Pure over
 * its inputs so the fixture in the test suite exercises what the CLI writes.
 *
 * A required issue that Linear did not mention is recorded as "Unknown", which
 * `evaluateGates` treats as unmet — the same verdict as omitting it, but it
 * shows up in the file as a fact instead of a hole.
 */
export function buildGateState(nodes, { inventoryClean, humanEvidence = {} } = {}) {
  const valid = LinearNodesSchema.parse(nodes ?? []);
  const byId = new Map(valid.map((node) => [node.identifier, node.state.name]));
  const issues = {};
  for (const gate of REQUIRED_ISSUES) {
    issues[gate.id] = byId.get(gate.id) ?? "Unknown";
  }
  const evidence = {};
  for (const gate of REQUIRED_EVIDENCE) {
    if (gate.id === "inventory-clean") evidence[gate.id] = inventoryClean === true;
    else evidence[gate.id] = humanEvidence[gate.id] === true;
  }
  const retained = {};
  for (const path of RETAINED_OPTIONAL_SERVER_PATHS) {
    retained[path] = "optional server deployment (BF-2544)";
  }
  return {
    issues,
    evidence,
    macLocalHarness: { present: true, retained },
  };
}

/** Read Linear nodes through the board CLI.  Throws rather than returning []. */
export function linearNodes() {
  const out = execFileSync(
    "board",
    ["api", "query", "--max-chars", "64000", LINEAR_QUERY, "--json"],
    { encoding: "utf8", timeout: 120_000 },
  );
  const payload = JSON.parse(out);
  // The CLI wraps GraphQL in an envelope; accept either shape.
  const data = payload?.data ?? payload;
  const nodes = data?.issues?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error("board api query returned no issues; refusing to write a state file");
  }
  return nodes;
}

/** Run the inventory audit against the committed tree.  Returns a boolean. */
export function inventoryClean(repoRoot) {
  const inventoryText = INVENTORY_DOCS.map((doc) =>
    readFileSync(join(repoRoot, doc), "utf8"),
  ).join("\n");
  return findUncovered(trackedFiles(repoRoot), inventoryText).length === 0;
}

function isEntryModule() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const outPath = value("--out");
  const boardJson = value("--board-json");
  if (!outPath) {
    console.error(
      "usage: node scripts/decommission-gate-state.mjs --out <state.json> [--board-json <nodes.json>]",
    );
    process.exit(2);
  }
  let nodes;
  try {
    nodes = boardJson ? JSON.parse(readFileSync(boardJson, "utf8")) : linearNodes();
  } catch (error) {
    console.error(`refusing to write ${outPath}: could not read issue states — ${error.message}`);
    process.exit(1);
  }
  const state = buildGateState(nodes, { inventoryClean: inventoryClean(repoRoot) });
  // Fail before writing rather than after: a file that the gate's own schema
  // rejects is worse than no file, because it reads as a refresh that worked.
  StateSchema.parse(state);
  writeFileSync(outPath, `${JSON.stringify(state, null, 2)}\n`);
  for (const gate of REQUIRED_ISSUES) console.log(`${gate.id}  ${state.issues[gate.id]}`);
  console.log(`inventory-clean  ${state.evidence["inventory-clean"]}`);
  console.log(
    `human-only (left blocking, assert these yourself): ${HUMAN_ONLY_EVIDENCE.join(", ")}, macLocalHarness.present`,
  );
  console.log(`wrote ${outPath}`);
}
