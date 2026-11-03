// Verify that a release-store directory is byte-identical to the git commit it
// is named after, by comparing every exported file against the commit's tree
// objects in a real repository.
//
// WHY THIS EXISTS.  A release is staged with `git archive <commit>`, so at
// promote time its bytes ARE the commit's tree by construction.  After that,
// the only thing binding the live directory to the commit is the claim in
// `.botfleet-release.json` — a file that sits inside the tree it vouches for.
// Anyone or anything that can write into the release can edit code and the
// manifest together, and a self-stored hash would not change that: the writer
// recomputes it.  The binding here is EXTERNAL: the expected bytes come from
// the commit's tree objects in a repository, which a writer inside the release
// cannot edit.  This detects accidental drift (a crashed copy, a janitor, a
// half-restored backup) and any in-place edit that does not also control the
// source repository.  It does not — and is not meant to — protect against a
// writer who controls both the release AND the repository: git objects are
// content-addressed but the ref namespace is mutable, so a compromised source
// repo can name different bytes under the same commit only by rewriting
// history, which every fetch of the repo would expose.  That residue is the
// reason the updater ALSO gates on the runtime's authenticated identity and
// the prepared build's own validation; this module's job is the narrower
// statement "these bytes are (or are not) the tree of commit C in repo R".
//
// HOW IT VERIFIES.  `git ls-tree -r <commit>` names every blob the commit
// exports.  `git archive` writes exactly those blob bytes (the repo has no
// export-subst attributes, and LFS paths archive as their pointer blobs, which
// are the blob bytes too), so hashing each on-disk file as a git blob and
// comparing against the tree entry is an exact equality check, not a heuristic.
// Symlinks (mode 120000) hash their target bytes, the same way git stores them.
//
// TYPE IS COMPARED, not just bytes: a tracked symlink (mode 120000) and a
// regular file holding its target text hash identically but do not execute
// identically, so the tree entry's mode must match the on-disk type, and the
// executable bit (100755 vs 100644) must match too.  Other permission bits are
// not compared: promotion deliberately strips write bits.
//
// WHAT IS NOT IN THE TREE.  Two kinds of content legitimately exist in a
// release without being in the commit tree, and are excluded from the source
// comparison: `.botfleet-release.json` (the store's own manifest, written at
// promote time) and `.DS_Store` (written by Finder).  Anything else present on
// disk but absent from the tree — or absent on disk but present in the tree,
// or present with different bytes or a different type — is drift, and drift
// means the release is NOT the commit it names.
//
// DEPENDENCIES ARE A SEPARATE CLAIM.  node_modules is executable code that
// git never exported, so tree identity says nothing about it.  Given a
// trusted reference tree (one the caller installed from the byte-verified
// lockfile) it is fingerprint-compared and drift there fails the verdict;
// without a reference, a present node_modules is reported as "unverified" in
// the result's `dependencies` field — unknown, never silently clean.  A
// caller claiming whole-runtime identity must require "verified" or "absent".

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { join, posix } from "node:path";

const FULL_COMMIT = /^[a-f0-9]{40}$/;

/** How many drift paths each list keeps.  The full count is always reported;
 *  the list exists to give an operator somewhere to start, not to page. */
const MAX_LISTED = 20;

/** The git blob id of these exact bytes: sha1("blob <len>\0<bytes>"). */
export function gitBlobSha1(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** True when `repo` is a git repository that holds `commit` as a commit object. */
export function repoHasCommit(repo, commit) {
  if (!FULL_COMMIT.test(commit || "")) return false;
  try {
    git(repo, ["cat-file", "-e", `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The commit's full recursive tree as a map from path to { mode, sha }.
 * `-z` keeps paths byte-exact; quoting or escaping a path is how a weird
 * filename would otherwise smuggle a second entry into one line.
 */
export function listTreeObjects(repo, commit) {
  const out = git(repo, ["ls-tree", "-r", "-z", "--full-tree", commit]);
  const entries = new Map();
  for (const record of out.split("\0")) {
    if (!record) continue;
    // "<mode> <type> <sha>\t<path>"
    const tab = record.indexOf("\t");
    if (tab < 0) throw new Error(`Unparseable ls-tree record for ${commit}: ${record.slice(0, 80)}`);
    const meta = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    const [mode, type, sha] = meta;
    if (type === "commit") {
      // A gitlink names a submodule.  This repository has none, and a release
      // cannot contain one (git archive exports the empty directory), so one
      // showing up here is a tree this verifier was not built to judge.
      throw new Error(`Tree ${commit.slice(0, 12)} contains a submodule entry at ${path}; release provenance is undefined for submodules`);
    }
    entries.set(path, { mode, sha });
  }
  return entries;
}

const EXCLUDED_BASENAMES = new Set([".DS_Store"]);

/**
 * Content fingerprint of a dependency tree: every regular file's bytes and
 * every symlink's target, in sorted path order.  Two installs from the same
 * lockfile on the same pnpm version produce the same fingerprint; a planted
 * or edited file changes it.  This compares trees against EACH OTHER — the
 * reference must be one the caller already trusts (the tree it just installed
 * from a byte-verified lockfile), which is what keeps the binding external
 * to the tree being checked.
 */
/**
 * A symlink inside a verified tree must point INTO the same tree.  The hash
 * records target TEXT, so a link whose target escapes the root would vouch
 * for bytes nobody hashed, and a broken link resolves to nothing at all.
 * Returns a description of the problem, or null when the link is confined
 * and its target exists.  pnpm layouts satisfy this: package links point
 * relatively into the same release's node_modules/.pnpm tree, and workspace
 * links point relatively into the same release's workspace packages.
 */
export function linkProblem(root, relative, target) {
  if (posix.isAbsolute(target)) {
    return `${relative} -> ${target} is absolute; verified bytes stop at the tree root`;
  }
  const resolved = posix.normalize(posix.join(posix.dirname(relative), target));
  if (resolved === ".." || resolved.startsWith("../")) {
    return `${relative} -> ${target} escapes the tree root; verified bytes stop at the root`;
  }
  const absolute = join(root, resolved);
  if (!existsSync(absolute)) {
    return `${relative} -> ${target} resolves to ${resolved}, which does not exist`;
  }
  // Lexical shape is not custody: a link can resolve inside the tree THROUGH
  // a second link that itself reaches outside.  Only the fully resolved
  // target proves which bytes the link actually names.
  const realRoot = realpathSync(root);
  const realTarget = realpathSync(absolute);
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}/`)) {
    return `${relative} -> ${target} resolves outside the tree's custody (${realTarget})`;
  }
  return null;
}

/**
 * pnpm's own bookkeeping at a node_modules root.  These files are NOT
 * excluded: their stable content is install behavior (store layout, linker,
 * hoisting, registries) and stays in the custody fingerprint.  What two
 * correct installs of one lockfile legitimately differ in is an enumerated
 * volatile set — the prune timestamp in .modules.yaml and the validation
 * timestamp + absolute project-dir key in .pnpm-workspace-state-v1.json —
 * so each file is hashed in a canonical form with exactly those fields
 * stripped.  A file that cannot be canonicalized hashes RAW (fail closed:
 * difference detected, never waived), and only a PLAIN FILE gets this
 * treatment — a symlink of the same name is hashed as a link and confined.
 */
const PNPM_BOOKKEEPING = new Set([".modules.yaml", ".pnpm-workspace-state-v1.json"]);

/**
 * Canonical JSON for pnpm state: objects are key-sorted, and keys that are
 * ABSOLUTE PATHS (the install's own project dirs, path-dependent by
 * construction) are replaced by their sorted index.  The stable content -
 * which projects exist, their names and versions, the allow-builds table -
 * stays in the fingerprint; where on disk the tree sat does not.
 */
// Volatile bookkeeping fields, at any depth: validation timestamps and file
// ctimes record WHEN the install validated, never WHAT it accepted.
const PNPM_VOLATILE_KEYS = new Set(["lastValidatedTimestamp", "recordedAtNs", "ctimeNs"]);

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    const keys = Object.keys(value).filter((key) => !PNPM_VOLATILE_KEYS.has(key)).sort();
    const absoluteKeys = keys.filter((key) => key.startsWith("/"));
    const out = {};
    for (const key of keys) {
      const canonical = key.startsWith("/") ? `<abs:${absoluteKeys.indexOf(key)}>` : key;
      out[canonical] = canonicalJsonValue(value[key]);
    }
    return out;
  }
  return value;
}

function canonicalPnpmBookkeeping(name, bytes) {
  const text = bytes.toString("utf8");
  if (name === ".modules.yaml") {
    // pnpm's serializer emits flat `key: value` lines at the top level and
    // nested maps below them; only the volatile prune timestamp is dropped.
    return text.split("\n").filter((line) => !/^\s*"?prunedAt"?:/.test(line)).join("\n");
  }
  if (name === ".pnpm-workspace-state-v1.json") {
    try {
      const parsed = JSON.parse(text);
      return JSON.stringify(canonicalJsonValue(parsed));
    } catch {
      return bytes;
    }
  }
  return bytes;
}

export function hashDependencyTree(root, { confineTo = root, pathPrefix = "" } = {}) {
  const hash = createHash("sha256");
  let files = 0;
  const linkProblems = [];
  const walk = (relative) => {
    const entries = readdirSync(join(root, relative), { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(name);
      } else if (entry.isSymbolicLink()) {
        const target = readlinkSync(join(root, name));
        // Confinement is against the WHOLE tree the caller vouches for, not
        // this dependency root: a pnpm workspace link legitimately points
        // from node_modules into the release's own packages, whose bytes the
        // source scope already covers.
        const problem = linkProblem(confineTo, pathPrefix ? `${pathPrefix}/${name}` : name, target);
        if (problem) linkProblems.push(problem);
        hash.update(`L${name.length}:${name}:`).update(target, "utf8");
        files += 1;
      } else if (entry.isFile()) {
        // The executable bit is identity for runnable code, same as in the
        // source comparison: two trees differing only in exec bits are not
        // the same dependency tree.
        const executable = (lstatSync(join(root, name)).mode & 0o111) !== 0;
        const rawBytes = readFileSync(join(root, name));
        const bytes = relative === "" && PNPM_BOOKKEEPING.has(entry.name)
          ? canonicalPnpmBookkeeping(entry.name, rawBytes)
          : rawBytes;
        hash.update(`F${name.length}:${name}:${executable ? "x" : "-"}:${bytes.length}:`).update(bytes);
        files += 1;
      } else {
        throw new Error(`unsupported entry in dependency tree: ${name}`);
      }
    }
  };
  walk("");
  return { fingerprint: hash.digest("hex"), files, linkProblems };
}
const MANIFEST_NAME = ".botfleet-release.json";

function isExcluded(relativePath, isRootLevel) {
  if (isRootLevel && relativePath === MANIFEST_NAME) return true;
  return relativePath.split("/").some((segment) => EXCLUDED_BASENAMES.has(segment));
}

/**
 * Walk the release tree, returning a map from relative path to the on-disk
 * blob sha1, plus a list of paths that could not be read at all.
 * Broken symlinks and unreadable files are drift evidence, not skips.
 */
const LFS_POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n?$/;

/**
 * When the committed blob is a Git LFS pointer, the real bytes are proven by
 * the pointer's own record: the file's sha256 must equal the pointer's oid
 * and its byte length the pointer's size.  A non-pointer blob, an unreadable
 * file, or any mismatch is not accepted.
 */
function lfsPointerAccepts(repo, blobSha, filePath) {
  let blob;
  try {
    blob = git(repo, ["cat-file", "-p", blobSha]);
  } catch {
    return false;
  }
  const match = LFS_POINTER.exec(blob);
  if (!match) return false;
  let bytes;
  try {
    bytes = readFileSync(filePath);
  } catch {
    return false;
  }
  return bytes.length === Number(match[2]) && createHash("sha256").update(bytes).digest("hex") === match[1];
}

/**
 * The on-disk shape of one entry, compared against the tree's mode: a blob
 * hash alone is NOT identity — a tracked symlink (mode 120000) and a regular
 * file holding its target text hash identically while resolving differently
 * when executed or opened.  Type is always compared; the executable bit is
 * compared too (100755 vs 100644), because promotion strips write bits but
 * never touches exec bits, so a flip is drift, not packaging.
 */
function diskEntry(fullPath, entry) {
  if (entry.isSymbolicLink()) {
    return { type: "symlink", sha: gitBlobSha1(Buffer.from(readlinkSync(fullPath), "utf8")) };
  }
  if (entry.isFile()) {
    const executable = (lstatSync(fullPath).mode & 0o111) !== 0;
    return { type: "file", executable, sha: gitBlobSha1(readFileSync(fullPath)) };
  }
  return null; // fifo/socket/device: no place in an exported source tree
}

function hashReleaseTree(releaseRoot) {
  const actual = new Map();
  const unreadable = [];
  const depRoots = [];
  const depRootProblems = [];
  const linkProblems = [];
  const walk = (relative) => {
    let entries;
    try {
      entries = readdirSync(join(releaseRoot, relative), { withFileTypes: true });
    } catch {
      unreadable.push(relative || ".");
      return;
    }
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      // Dependency roots are COLLECTED, never silently skipped: every
      // node_modules at any depth is executable code the source comparison
      // does not cover, and each one must later be verified or reported.
      if (entry.name === "node_modules") {
        if (entry.isDirectory()) {
          depRoots.push(name);
        } else {
          // A symlink or file named node_modules is not an install location;
          // it is someone pointing module resolution somewhere unaccounted.
          depRootProblems.push(`${name} is ${entry.isSymbolicLink() ? "a symlink" : "not a directory"}`);
        }
        continue;
      }
      if (isExcluded(name, !relative)) continue;
      try {
        if (entry.isDirectory()) {
          walk(name);
        } else {
          if (entry.isSymbolicLink()) {
            // The git tree records target text; a tracked link whose target
            // escapes the tree vouches for bytes nobody hashed.
            const problem = linkProblem(releaseRoot, name, readlinkSync(join(releaseRoot, name)));
            if (problem) linkProblems.push(problem);
          }
          const disk = diskEntry(join(releaseRoot, name), entry);
          if (disk) actual.set(name, disk);
          else unreadable.push(name);
        }
      } catch {
        unreadable.push(name);
      }
    }
  };
  walk("");
  return { actual, unreadable, depRoots, depRootProblems, linkProblems };
}

/** The tree entry's mode as the disk shape it must have, or a mismatch reason. */
function modeMatches(treeMode, disk) {
  if (treeMode === "120000") return disk.type === "symlink" ? null : "symlink replaced by a regular file";
  if (disk.type !== "file") return "regular file replaced by a symlink";
  if (treeMode === "100755" && !disk.executable) return "lost its executable bit";
  if (treeMode === "100644" && disk.executable) return "gained an executable bit";
  return null;
}

function capList(paths) {
  const listed = paths.slice(0, MAX_LISTED);
  return paths.length > MAX_LISTED ? [...listed, `…and ${paths.length - MAX_LISTED} more`] : listed;
}

/**
 * Verify `releaseRoot` against `commit`'s tree in `repo`.
 *
 * Returns one of:
 *   { ok: true,  commit, checked }
 *   { ok: false, reason: "repo-unavailable" | "commit-missing", detail }
 *   { ok: false, reason: "drift", detail, missing, modified, extra, unreadable }
 *
 * The two non-drift failures are distinguished on purpose: "I could not check"
 * and "I checked and it does not match" must never read as the same answer,
 * because the first is an environment problem and the second means the bytes
 * are not the commit.
 */
/**
 * One fingerprint covering EVERY dependency root in a tree (any depth), keyed
 * by the root's relative path so a planted nested root changes the result.
 * Returns null when the tree has no dependency roots at all.
 */
/**
 * The dependency scope of a tree: every node_modules at any depth, the
 * fingerprint covering all of them, and every non-confined link found inside
 * them.  A scope with link problems is not fingerprint-trustworthy: its hash
 * records target text for links that reach bytes outside the tree.
 */
export function dependencyScopeStatus(root) {
  const depRoots = [];
  const walk = (relative) => {
    let entries;
    try {
      entries = readdirSync(join(root, relative), { withFileTypes: true });
    } catch (error) {
      throw new Error(`unreadable directory ${relative || "."} under ${root}: ${error?.message || error}`);
    }
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name === "node_modules") {
        if (entry.isDirectory()) depRoots.push(name);
        continue;
      }
      if (entry.isDirectory()) walk(name);
    }
  };
  walk("");
  const linkProblems = [];
  if (depRoots.length === 0) return { fingerprint: null, roots: depRoots, linkProblems };
  const hash = createHash("sha256");
  for (const depRoot of depRoots.sort()) {
    const tree = hashDependencyTree(join(root, depRoot), { confineTo: root, pathPrefix: depRoot });
    for (const problem of tree.linkProblems) linkProblems.push(problem);
    hash.update(`R${depRoot.length}:${depRoot}:${tree.fingerprint}:`);
  }
  return { fingerprint: hash.digest("hex"), roots: depRoots, linkProblems };
}

export function dependencyScopeFingerprint(root) {
  return dependencyScopeStatus(root).fingerprint;
}

export function verifyReleaseAgainstCommit({ releaseRoot, commit, repo, referenceDeps = null, expectedDepsFingerprint = null }) {
  if (!FULL_COMMIT.test(commit || "")) {
    return { ok: false, reason: "commit-missing", detail: `not a full commit id: ${commit}` };
  }
  let expected;
  try {
    git(repo, ["rev-parse", "--git-dir"]);
  } catch (error) {
    return { ok: false, reason: "repo-unavailable", detail: `${repo}: ${error?.message || error}` };
  }
  if (!repoHasCommit(repo, commit)) {
    return { ok: false, reason: "commit-missing", detail: `${repo} does not hold commit ${commit}` };
  }
  try {
    expected = listTreeObjects(repo, commit);
  } catch (error) {
    return { ok: false, reason: "repo-unavailable", detail: `ls-tree ${commit.slice(0, 12)}: ${error?.message || error}` };
  }
  const { actual, unreadable, depRoots, depRootProblems, linkProblems: sourceLinkProblems } = hashReleaseTree(releaseRoot);
  const missing = [];
  const modified = [];
  for (const [path, entry] of expected) {
    const onDisk = actual.get(path);
    if (onDisk === undefined) {
      missing.push(path);
      continue;
    }
    // Type and mode are identity on EVERY entry, independent of content:
    // a tracked symlink is never a regular file, and the executable bit is
    // compared in both directions — no content rule may waive either.
    const modeProblem = modeMatches(entry.mode, onDisk);
    if (modeProblem) {
      modified.push(`${path} (${modeProblem})`);
      continue;
    }
    if (onDisk.sha !== entry.sha) {
      // Git LFS: the committed blob of a REGULAR file may be a POINTER.  An
      // export on a host with git-lfs smudging holds the real bytes instead;
      // accept the file's content when its sha256 and size are exactly the
      // pointer's record.  Only a regular blob on a regular file qualifies.
      if (onDisk.type !== "file" || entry.mode !== "100644" && entry.mode !== "100755" ||
          !lfsPointerAccepts(repo, entry.sha, join(releaseRoot, path))) {
        modified.push(path);
      }
    }
  }
  const extra = [];
  for (const path of actual.keys()) {
    if (!expected.has(path)) extra.push(path);
  }
  if (missing.length || modified.length || extra.length || unreadable.length) {
    return driftResult(releaseRoot, commit, "source", { missing, modified, extra, unreadable });
  }
  // The exported source tree is byte-and-type identical to the commit.  The
  // dependency scope is a separate claim: node_modules is executable code
  // that git never exported, so source identity says nothing about it.
  // ENOENT is the only "absent" — a root that exists but is the wrong type is
  // drift, and one that cannot be read is UNVERIFIABLE, never absent.
  if (sourceLinkProblems.length) {
    return {
      ok: false,
      reason: "drift",
      driftScope: "source",
      detail: `${releaseRoot}: symlink problems: ${capList(sourceLinkProblems).join("; ")}`,
      missing: [], modified: [], extra: [], unreadable: [],
    };
  }
  if (depRootProblems.length) {
    return {
      ok: false,
      reason: "drift",
      driftScope: "deps",
      detail: `${releaseRoot}: dependency root problems: ${capList(depRootProblems).join("; ")}`,
      missing: [], modified: [], extra: [], unreadable: [],
    };
  }
  if (depRoots.length === 0) {
    return { ok: true, commit, checked: expected.size, dependencies: "absent", depsFingerprint: null };
  }
  // A trusted expectation is either a reference tree the caller installed
  // from the byte-verified lockfile, or a fingerprint the caller captured
  // while it held such a tree known-good.  Neither may live inside the tree
  // being checked: a reference that IS the release's own tree proves nothing.
  let actualScope;
  try {
    actualScope = dependencyScopeStatus(releaseRoot);
  } catch (error) {
    return {
      ok: false,
      reason: "unverifiable",
      detail: `dependency scope unreadable: ${error?.message || error}`,
    };
  }
  if (actualScope.linkProblems.length) {
    return {
      ok: false,
      reason: "drift",
      driftScope: "deps",
      detail: `${releaseRoot}: dependency links outside custody: ${capList(actualScope.linkProblems).join("; ")}`,
      missing: [], modified: [], extra: [], unreadable: [],
    };
  }
  const actualFingerprint = actualScope.fingerprint;
  let expectedFingerprint = expectedDepsFingerprint;
  if (!expectedFingerprint && referenceDeps) {
    const releaseReal = realpathSync(releaseRoot);
    const referenceReal = realpathSync(referenceDeps);
    if (referenceReal === releaseReal || referenceReal.startsWith(`${releaseReal}/`)) {
      return {
        ok: false,
        reason: "unverifiable",
        detail: "dependency reference is inside the tree it would vouch for; self-comparison is not proof",
      };
    }
    let referenceScope;
    try {
      referenceScope = dependencyScopeStatus(referenceDeps);
    } catch (error) {
      return {
        ok: false,
        reason: "unverifiable",
        detail: `trusted dependency reference unreadable: ${error?.message || error}`,
      };
    }
    if (referenceScope.linkProblems.length) {
      return {
        ok: false,
        reason: "unverifiable",
        detail: `trusted dependency reference has links outside its own custody: ${capList(referenceScope.linkProblems).join("; ")}`,
      };
    }
    expectedFingerprint = referenceScope.fingerprint;
  }
  if (!expectedFingerprint) {
    return { ok: true, commit, checked: expected.size, dependencies: "unverified", depsFingerprint: actualFingerprint };
  }
  if (actualFingerprint !== expectedFingerprint) {
    return {
      ok: false,
      reason: "drift",
      driftScope: "deps",
      detail: `${releaseRoot}: dependency scope does not match the trusted expectation (covering ${depRoots.length} root(s): ${depRoots.join(", ")})`,
      missing: [], modified: [], extra: [], unreadable: [],
    };
  }
  return { ok: true, commit, checked: expected.size, dependencies: "verified", depsFingerprint: actualFingerprint };
}

function driftResult(releaseRoot, commit, driftScope, { missing, modified, extra, unreadable }) {
  const parts = [];
  if (missing.length) parts.push(`${missing.length} missing (${capList(missing).join(", ")})`);
  if (modified.length) parts.push(`${modified.length} modified (${capList(modified).join(", ")})`);
  if (extra.length) parts.push(`${extra.length} not in commit (${capList(extra).join(", ")})`);
  if (unreadable.length) parts.push(`${unreadable.length} unreadable (${capList(unreadable).join(", ")})`);
  return {
    ok: false,
    reason: "drift",
    driftScope,
    detail: `${releaseRoot} is not the tree of ${commit.slice(0, 12)}: ${parts.join("; ")}`,
    missing: capList(missing),
    modified: capList(modified),
    extra: capList(extra),
    unreadable: capList(unreadable),
  };
}
