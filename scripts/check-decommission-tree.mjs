// Prove the Node decommission's first Done condition (BF-2515): the tracked
// tree carries no server/, no companion/, and no desktop Node manifest.
//
// The decommission plan's Done conditions name things that have to be gone
// for the Phase 6 cutover to mean anything, and until now nothing asserted
// their absence: the gate script read a state file that somebody filled in
// by hand, and the reboot check looked at running processes.  A leftover
// server/index.ts on main is invisible to both.  This script asks git, which
// is the only place that knows what the tree actually contains, and it fails
// closed: a checkout whose index cannot be read is a blocked gate, never a
// clean tree.
//
// The tree it asks about is the tracked tree, because an untracked leftover
// is a local accident and a tracked one is the thing a reviewer would merge.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Node source roots the decommission deletes.  `scripts/` is not one of
 * them: the gate scripts themselves live here and stay.
 */
export const DECOMMISSION_ROOTS = ["server", "companion"];

/**
 * The desktop Node manifests the decommission deletes with the stack.  A
 * leftover package.json or pnpm-lock.yaml at the repository root is a Node
 * desktop tree by definition, whatever its contents say.
 */
export const DESKTOP_MANIFESTS = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];

/**
 * The tracked files this gate cares about.  The pathspecs are anchored with
 * `:(top)` so a nested server/ or a companion/package.json elsewhere in the
 * tree cannot stand in for the root the decommission names, and `--full-name`
 * keeps the output relative to the work tree root rather than to whatever
 * directory the command ran from.
 */
export function trackedFiles(repoRoot) {
  const pathspecs = [
    ...DECOMMISSION_ROOTS.map((root) => `:(top)${root}`),
    ...DESKTOP_MANIFESTS.map((manifest) => `:(top)${manifest}`),
  ];
  const out = execFileSync("git", ["-C", repoRoot, "ls-files", "--full-name", "--", ...pathspecs], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return out.split("\n").filter(Boolean).sort();
}

/**
 * Does the checkout have a commit to read?  A repository with no commits has
 * an empty index, and an empty index reads as a clean tree, so a checkout
 * without a commit is a checkout whose tree could not be read.
 */
export function hasCommittedTree(repoRoot) {
  try {
    execFileSync("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", "HEAD"], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * What is still on the tree, which is exactly what the Done condition
 * forbids.  The function is pure over the file list so the test suite can
 * exercise it without a git repository, and so the CLI and the tests judge
 * the tree by the same rule.
 */
export function missingTreeConditions(files) {
  const roots = [];
  const manifests = [];
  for (const file of files) {
    const head = file.split("/")[0];
    if (DECOMMISSION_ROOTS.includes(head) && !roots.includes(head)) roots.push(head);
    if (DESKTOP_MANIFESTS.includes(file) && !manifests.includes(file)) manifests.push(file);
  }
  return { roots: roots.sort(), manifests: manifests.sort() };
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
  const args = process.argv.slice(2);
  const flagIndex = args.indexOf("--repo-root");
  let repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  if (flagIndex !== -1) {
    const value = args[flagIndex + 1];
    if (!value || value.startsWith("--")) {
      console.error("usage: node scripts/check-decommission-tree.mjs [--repo-root <path>]");
      process.exit(2);
    }
    repoRoot = value;
  }

  let files;
  try {
    files = trackedFiles(repoRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: could not read the tracked file list from ${repoRoot}: ${message}`);
    console.error("refusing to treat an unreadable index as a clean tree");
    process.exit(2);
  }
  if (!hasCommittedTree(repoRoot)) {
    console.error(`error: ${repoRoot} has no commit to read, so its tree cannot be judged`);
    console.error("refusing to treat an unreadable index as a clean tree");
    process.exit(2);
  }

  const remaining = missingTreeConditions(files);
  if (remaining.roots.length > 0 || remaining.manifests.length > 0) {
    console.error("Node decommission tree gate: FAILED — the tracked tree still carries the Node stack");
    for (const root of remaining.roots) {
      const count = files.filter((file) => file.split("/")[0] === root).length;
      console.error(`  - ${root}/ is still tracked (${count} file(s))`);
    }
    for (const manifest of remaining.manifests) {
      console.error(`  - ${manifest} is still tracked at the repository root`);
    }
    process.exit(1);
  }

  console.log(
    `the tracked tree carries no ${DECOMMISSION_ROOTS.map((root) => `${root}/`).join(", no ")} and no desktop Node manifest.`,
  );
}
