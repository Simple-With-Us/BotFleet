import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { openedFileIsListedSync } from "../server/opened-file.ts";

export const REQUIRED_PLACEMENT_EVIDENCE = [
  "fresh-mac-only-install", "server-first-placement", "server-saturation-overflow",
  "mac-high-cpu-accepted", "both-hosts-pressure-queue", "disconnect-no-duplicate",
  "mode-change-fence", "forced-takeover-and-return", "settings-saved-vs-applied",
  "headroom-enforced-mac", "headroom-enforced-server", "mount-loss-root-fallback",
  "other-apps-unchanged", "inventory-recorded", "rollback-keeps-epoch", "connect-and-revert-clean",
];
export const HAND_RUN_PLACEMENT_EVIDENCE = [
  "mac-high-cpu-accepted", "headroom-enforced-mac", "headroom-enforced-server",
  "mount-loss-root-fallback", "other-apps-unchanged",
];
const nonempty = z.string().trim().min(1);
const handRun = z.strictObject({
  at: z.string().regex(/^(?:\d{4}-\d{2}-\d{2} )?(?:[1-9]|1[0-2]):[0-5]\d (?:AM|PM)$/),
  by: nonempty,
  log: nonempty,
});
/** Unknown keys and truthy strings are errors; absent evidence stays unmet. */
export const PlacementEvidenceSchema = z.strictObject({
  evidence: z.strictObject(Object.fromEntries(REQUIRED_PLACEMENT_EVIDENCE.map((key) => [key, z.boolean().optional()]))).optional(),
  handRun: z.strictObject(Object.fromEntries(HAND_RUN_PLACEMENT_EVIDENCE.map((key) => [key, handRun.optional()]))).optional(),
  inventory: z.strictObject({ server: nonempty.optional(), mac: nonempty.optional() }).optional(),
});

/** Pure assertion check; only the CLI additionally verifies artifact paths. */
export function evaluatePlacementEvidence(raw = {}) {
  const state = PlacementEvidenceSchema.parse(raw);
  const blockers = [];
  for (const key of REQUIRED_PLACEMENT_EVIDENCE) {
    if (state.evidence?.[key] !== true) blockers.push(`evidence ${key}: not asserted`);
  }
  for (const key of HAND_RUN_PLACEMENT_EVIDENCE) {
    if (state.evidence?.[key] === true && !state.handRun?.[key]) blockers.push(`handRun ${key}: no time, runner and log supplied`);
  }
  // Inventory is required even without a new default, so numeric defaults can
  // never use a weaker branch of this evidence gate.
  for (const host of ["server", "mac"]) {
    if (!state.inventory?.[host]) blockers.push(`inventory ${host}: no artifact supplied; numeric defaults must wait`);
  }
  return { ok: blockers.length === 0, blockers };
}

export function checkPlacementEvidenceFile(path) {
  const manifest = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let state;
  try {
    if (!openedFileIsListedSync(fstatSync(manifest), path)) throw new Error("Evidence manifest is not the listed regular single-link file");
    state = PlacementEvidenceSchema.parse(JSON.parse(readFileSync(manifest, "utf8")));
    if (!openedFileIsListedSync(fstatSync(manifest), path)) throw new Error("Evidence manifest changed while reading");
  } finally { closeSync(manifest); }
  const bundle = realpathSync(dirname(path));
  const inside = (candidate) => {
    const part = relative(bundle, candidate);
    return part !== "" && !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
  };
  const verdict = evaluatePlacementEvidence(state);
  const artifacts = [
    ...Object.entries(state.handRun ?? {}).map(([key, run]) => [`handRun ${key}`, run.log]),
    ...Object.entries(state.inventory ?? {}).map(([key, artifact]) => [`inventory ${key}`, artifact]),
  ];
  for (const [key, artifact] of artifacts) {
    let fd;
    try {
      const target = resolve(bundle, artifact);
      if (isAbsolute(artifact) || !inside(target)) throw new Error("artifact escapes the bundle");
      let component = bundle;
      for (const name of relative(bundle, target).split(sep)) {
        component = join(component, name);
        if (lstatSync(component).isSymbolicLink()) throw new Error("artifact path contains a link");
      }
      if (!inside(realpathSync(target))) throw new Error("artifact resolves outside the bundle");
      fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!inside(realpathSync(target)) || !openedFileIsListedSync(fstatSync(fd), target)) throw new Error("artifact handle differs from bundle entry");
      readSync(fd, Buffer.alloc(1), 0, 1, 0);
      if (!inside(realpathSync(target)) || !openedFileIsListedSync(fstatSync(fd), target)) throw new Error("artifact changed while reading");
    } catch {
      verdict.blockers.push(`${key}: artifact must be a readable single-link file within this evidence bundle: ${artifact}`);
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  verdict.ok = verdict.blockers.length === 0;
  return verdict;
}

let isEntry = false;
try { isEntry = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { /* imported */ }
if (isEntry) {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) {
    console.error("usage: node scripts/check-placement-evidence.mjs <placement-evidence.json>");
    process.exitCode = 2;
  } else {
    try {
      const verdict = checkPlacementEvidenceFile(path);
      if (!verdict.ok) {
        console.error("Placement evidence is BLOCKED:");
        for (const blocker of verdict.blockers) console.error(`  - ${blocker}`);
        process.exitCode = 1;
      } else console.log("Placement evidence: all sixteen recipes asserted with inventory and hand-run artifacts");
    } catch (error) {
      console.error(`Invalid placement evidence: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    }
  }
}
