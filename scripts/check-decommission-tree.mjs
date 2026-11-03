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
// The tree it asks about is the committed tree, because the question is what
// main carries.  A file that is only staged, or only untracked, is a local
// accident: judging the index would report a tree that nobody merged.
//
// The contract asserted here is the full removal of the Node roots.  BF-2515
// qualifies its own condition with "or only the ruled companion host", so if
// the Phase 5 ruling keeps a slimmed server/, that ruling is what changes
// this contract, and the gate would then have to name the host it accepts
// rather than assert that no server/ remains.
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
 * The Mac-local roots this gate does NOT own, named so a reader can see the
 * boundary instead of guessing it.  `shared/` carries native consumers as well
 * as Node ones, so BF-2515 cannot delete it wholesale and BF-2544 owns the
 * retained Linux closure;  `electron/` is the Electron half of the
 * decommission, which BF-2485 owns.
 */
export const OUT_OF_SCOPE_ROOTS = ["shared", "electron"];

/**
 * The desktop Node manifests the decommission deletes with the stack.  A
 * leftover package.json or pnpm-lock.yaml at the repository root is a Node
 * desktop tree by definition, whatever its contents say.
 */
export const DESKTOP_MANIFESTS = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];

/**
 * The files the COMMITTED tree carries under the roots this gate owns.
 *
 * The committed tree, not the index.  `git ls-files` reports what is staged
 * for the next commit, so a developer's staged file would read as if it were
 * already on main and the gate would judge a tree that nobody merged.  The
 * question this gate answers is what main carries, so it reads HEAD.
 *
 * The pathspecs are given without a leading "./" and without the `:(top)`
 * magic, because ls-tree paths are already relative to the tree root, and a
 * bare `package.json` names the root manifest only, not `companion/package.json`.
 */
export function trackedFiles(repoRoot) {
  const out = execFileSync(
    "git",
    [
      "-C",
      repoRoot,
      "ls-tree",
      "-r",
      "--name-only",
      "HEAD",
      "--",
      ...DECOMMISSION_ROOTS,
      ...DESKTOP_MANIFESTS,
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  return out.split("\n").filter(Boolean).sort();
}

/**
 * Is this directory a git work tree at all?  A directory that is not one and
 * a work tree with no commit are different failures, and the reader needs to
 * be told which one happened.
 */
export function isWorkTree(repoRoot) {
  try {
    execFileSync("git", ["-C", repoRoot, "rev-parse", "--git-dir"], {
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
 * Does the checkout have a commit to read?  A repository with no commits has
 * an empty tree, and an empty tree reads as a clean tree, so a checkout
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

  if (!isWorkTree(repoRoot)) {
    console.error(`error: could not read the tracked file list from ${repoRoot}: it is not a git work tree`);
    console.error("refusing to treat an unreadable index as a clean tree");
    process.exit(2);
  }
  if (!hasCommittedTree(repoRoot)) {
    console.error(`error: ${repoRoot} has no commit to read, so its tree cannot be judged`);
    console.error("refusing to treat an unreadable index as a clean tree");
    process.exit(2);
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
  console.log(
    `not checked here, because another issue owns them: ${OUT_OF_SCOPE_ROOTS.map((root) => `${root}/`).join(", ")}.`,
  );
}
