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
//   - issue states come from Linear through the simple-board CLI, and a failed query
//     exits non-zero rather than writing a partial file, so a refresh that did
//     not happen can never read as one that did;
//   - `inventory-clean` comes from running the audit against the committed
//     tree, so it is a measurement rather than somebody's belief about one.
//
// The CLI leaves everything else blocking; the six human-only evidence items
// (placement, soak, replay, import, Control, Linux) stay false.  Replay,
// import, linux-retention and process-inventory have receipt producers, but a
// receipt only feeds the evidence bundle and never sets one of these booleans.
// `macLocalHarness.present` stays true: only somebody on the Mac can verify the
// harness is gone, and a missing or true value is unmet.  The optional server
// deployment is pre-filled as retained: the one approved exclusion, not a finding.
//
//   node scripts/decommission-gate-state.mjs --out /tmp/phase6-state.json
//   node scripts/decommission-gate-state.mjs --board-json <nodes.json> --out out.json
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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

/* oxlint-disable eslint/no-irregular-whitespace -- Owner-required NBSP sentence gaps occur only in prose comments in this script. */

const LINEAR_PAGE_SIZE = 250;
// Four pages (a thousand issues) bound the refresh; the loop below almost
// always stops after the first page, because it quits as soon as every
// required issue has been seen.
const LINEAR_MAX_PAGES = 4;
// The owner's copy rule: a real U+00A0 plus a normal space between the
// sentences of anything a human reads.
const SENTENCE_GAP = "  ";

const linearPageQuery = (after) =>
  `query { issues(filter: { team: { key: { eq: "BF" } } }, first: ${LINEAR_PAGE_SIZE}${after ? `, after: ${JSON.stringify(after)}` : ""}) { nodes { identifier state { name } } pageInfo { hasNextPage endCursor } } }`;

/**
 * Accept every shape the refresh can hand us: a bare nodes array (a fixture,
 * or a jq-extracted file), the raw `api query --json` envelope, or the
 * same envelope without its `data` wrapper.  Anything else is refused rather
 * than guessed at.
 */
export function unwrapNodes(raw) {
  const envelope = Array.isArray(raw) ? raw : (raw?.data ?? raw)?.issues?.nodes;
  if (!Array.isArray(envelope)) {
    throw new Error("no Linear issues array found; pass --board-json a nodes array or a raw board api query dump");
  }
  return envelope;
}

/**
 * The current Linear-backed CLI.  The legacy `board` binary, its
 * `board-legacy` alias and the mac-collab backend behind them are retired
 * write routes (AGENTS.md), so a refresh must never resolve one of them.  
 * `simple-board` serves the `api query` surface this script already sends:
 * a GraphQL document, `--max-chars` and `--json`.
 */
export const CURRENT_LINEAR_CLI = "simple-board";

/** The retired CLI names a refresh must never resolve. */
export const RETIRED_LINEAR_CLI_NAMES = ["board", "board-legacy"];

/**
 * The retired mac-collab backend, whose binaries are retired write routes
 * too (AGENTS.md).  The marker is compared case-folded: a
 * case-insensitive volume resolves the directory under any spelling.
 */
export const RETIRED_BACKEND_MARKER = "mac-collab";

/**
 * A path that names a retired CLI is not a Linear route.  The basename is
 * folded to lowercase before the comparison: on a case-insensitive volume
 * `BOARD` and `Board` resolve to the same retired binary, and an exact-case
 * comparison would let them through.
 */
export function isRetiredLinearCli(path) {
  const name = basename(path).toLowerCase();
  return RETIRED_LINEAR_CLI_NAMES.some((retired) => {
    const retiredName = retired.toLowerCase();
    return name === retiredName || name.startsWith(`${retiredName}-`);
  });
}

/**
 * A path inside the retired mac-collab backend is not a Linear route.  The
 * comparison is case-folded for the same reason the CLI name is.
 */
export function isRetiredBackendPath(path) {
  return path.toLowerCase().includes(RETIRED_BACKEND_MARKER);
}

/**
 * The real path behind a CLI path, or the literal path when it does not
 * exist.  A retired binary reached through a symlink or under a
 * renamed copy has to fail the same gate, so the refusal looks at the
 * resolved path as well as the literal one.
 */
export function resolveRealCliPath(path) {
  try {
    return realpathSync(path);
  } catch {
    // The path does not exist, so the basename check still applies to it.
    return path;
  }
}

/**
 * The CLI on PATH, or null when it is missing or a retired mac-collab shadow.
 */
function linearCliOnPath(name) {
  try {
    const whichOut = execFileSync("which", [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!whichOut) return null;
    const resolved = resolveRealCliPath(whichOut);
    if (isRetiredBackendPath(resolved)) return null;
    // A `simple-board` that resolves to a retired binary is that binary
    // under another name, so it fails the same gate.
    if (isRetiredLinearCli(resolved)) return null;
    // The VALIDATED path is the one that is returned.  Handing back the
    // literal `which` output would leave a gap between the check and the
    // use:  a symlink swapped after this gate, or a `which` that answers
    // with a symlink, would send the exec somewhere the gate never saw.
    return resolved;
  } catch {
    // The CLI is not on PATH, so the refresh fails closed below.
    return null;
  }
}

/**
 * Resolve the CLI binary to query Linear.  Prefers explicit BOARD_CLI,
 * prefers the verified simple-board under ~/.local/bin, and refuses the
 * retired `board` binary outright: it is a retired write route, so a refresh
 * must never resolve it.
 */
export function resolveBoardCli() {
  const override = process.env.BOARD_CLI;
  if (override) {
    // The override is resolved before it is judged: a symlink or a renamed
    // copy of a retired binary must not reach the gate under an innocent
    // name, and the retired backend is refused by its own path as well.
    const resolved = resolveRealCliPath(override);
    if (isRetiredLinearCli(override)) {
      throw new Error(
        `BOARD_CLI names the retired Linear CLI '${override}'.${SENTENCE_GAP}Set BOARD_CLI to ${CURRENT_LINEAR_CLI}, the current Linear-backed CLI.`,
      );
    }
    if (isRetiredLinearCli(resolved)) {
      throw new Error(
        `BOARD_CLI resolves to the retired Linear CLI '${resolved}'.${SENTENCE_GAP}Set BOARD_CLI to ${CURRENT_LINEAR_CLI}, the current Linear-backed CLI.`,
      );
    }
    if (isRetiredBackendPath(override) || isRetiredBackendPath(resolved)) {
      throw new Error(
        `BOARD_CLI names a retired Linear CLI in the mac-collab backend '${override}'.${SENTENCE_GAP}Set BOARD_CLI to ${CURRENT_LINEAR_CLI}, the current Linear-backed CLI.`,
      );
    }
    // The VALIDATED path is the one that is returned, so the exec runs
    // exactly the target the gate judged and not the literal spelling of it.
    return resolved;
  }
  const verifiedDefault = join(process.env.HOME ?? "", ".local", "bin", CURRENT_LINEAR_CLI);
  if (existsSync(verifiedDefault)) {
    // The default branch carries the same gate as the override and the PATH
    // branch.  A verified default that is a symlink to, or a copy of, the
    // retired binary, or that sits in the retired backend, is that retired
    // write route under an innocent name, so it is refused here too.
    const resolvedDefault = resolveRealCliPath(verifiedDefault);
    if (isRetiredLinearCli(verifiedDefault) || isRetiredLinearCli(resolvedDefault)) {
      throw new Error(
        `Default CLI '${verifiedDefault}' resolves to the retired Linear CLI '${resolvedDefault}'.${SENTENCE_GAP}Set BOARD_CLI to ${CURRENT_LINEAR_CLI}, the current Linear-backed CLI.`,
      );
    }
    if (isRetiredBackendPath(verifiedDefault) || isRetiredBackendPath(resolvedDefault)) {
      throw new Error(
        `Default CLI '${verifiedDefault}' sits in the retired mac-collab backend '${resolvedDefault}'.${SENTENCE_GAP}Set BOARD_CLI to ${CURRENT_LINEAR_CLI}, the current Linear-backed CLI.`,
      );
    }
    return resolvedDefault;
  }
  const onPath = linearCliOnPath(CURRENT_LINEAR_CLI);
  if (onPath) return onPath;
  throw new Error(
    `Linear CLI '${CURRENT_LINEAR_CLI}' not found on PATH or at ~/.local/bin/${CURRENT_LINEAR_CLI}.${SENTENCE_GAP}Set BOARD_CLI or install ${CURRENT_LINEAR_CLI} at ~/.local/bin/${CURRENT_LINEAR_CLI}.`,
  );
}

/** One Linear page through the Linear CLI.  Throws rather than returning []. */
export function fetchLinearPage(after) {
  const cli = resolveBoardCli();
  const out = execFileSync(
    cli,
    ["api", "query", "--max-chars", "64000", linearPageQuery(after), "--json"],
    { encoding: "utf8", timeout: 120_000 },
  );
  const payload = JSON.parse(out);
  // The CLI wraps GraphQL in an envelope; accept either shape.
  const data = payload?.data ?? payload;
  return {
    nodes: unwrapNodes(data),
    pageInfo: data?.issues?.pageInfo,
  };
}

/**
 * Every Linear page up to the cap, stopping early once all required issues
 * have been seen.  Pure over `fetchPage` so the test suite can drive the
 * loop with canned pages: the single-page query this replaced failed closed
 * (a required issue past the first page read as Unknown forever), and the
 * fix for that is this loop, so the loop earns its own fixtures.
 */
export function collectLinearNodes(fetchPage) {
  const nodes = [];
  let after = null;
  for (let page = 0; page < LINEAR_MAX_PAGES; page += 1) {
    const { nodes: batch, pageInfo } = fetchPage(after);
    nodes.push(...batch);
    const found = new Set(nodes.map((node) => node?.identifier));
    if (REQUIRED_ISSUES.every((gate) => found.has(gate.id))) break;
    if (!pageInfo?.hasNextPage) break;
    after = pageInfo.endCursor;
  }
  return nodes;
}

/** Read Linear nodes through the Linear CLI.  Throws rather than returning []. */
export function linearNodes() {
  const nodes = collectLinearNodes(fetchLinearPage);
  if (nodes.length === 0) {
    throw new Error("simple-board api query returned no issues; refusing to write a state file");
  }
  return nodes;
}

/** Evidence a script on this host cannot observe; only a human may assert it. */
export const HUMAN_ONLY_EVIDENCE = [
  "placement-evidence",
  "soak-24h-no-node",
  "replay-parity",
  "final-import-parity",
  "control-disposition",
  "linux-server-preservation",
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
  let state;
  try {
    const raw = boardJson ? JSON.parse(readFileSync(boardJson, "utf8")) : linearNodes();
    // A saved CLI dump carries the envelope; the live path already unwrapped
    // its pages.  Unwrap here too, inside the guard, so a file that is not a
    // nodes array refuses the write instead of throwing past it.
    nodes = boardJson ? unwrapNodes(raw) : raw;
    state = buildGateState(nodes, { inventoryClean: inventoryClean(repoRoot) });
    // Fail before writing rather than after: a file that the gate's own
    // schema rejects is worse than no file, because it reads as a refresh
    // that worked.
    StateSchema.parse(state);
  } catch (error) {
    console.error(`refusing to write ${outPath}: could not read issue states — ${error.message}`);
    process.exit(1);
  }
  writeFileSync(outPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  for (const gate of REQUIRED_ISSUES) console.log(`${gate.id}  ${state.issues[gate.id]}`);
  console.log(`inventory-clean  ${state.evidence["inventory-clean"]}`);
  console.log(
    `human-only (left blocking, assert these yourself): ${HUMAN_ONLY_EVIDENCE.join(", ")}, macLocalHarness.present`,
  );
  console.log(`wrote ${outPath}`);
}
