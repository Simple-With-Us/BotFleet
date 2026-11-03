import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { HARNESS_API_VERSION, validBuildIdentity } from "../electron/runtime-identity.mjs";
import { validateReleaseManifest } from "./harness-release-store.mjs";
import { repoHasCommit, verifyReleaseAgainstCommit } from "./release-provenance.mjs";

/**
 * How a root presents for identity purposes.
 *
 * "git":     not release mode; the ordinary checkout path applies.  A
 *            commit-named directory WITHOUT a manifest stays here on purpose —
 *            a worktree named after the commit it holds is a real layout, and
 *            it has a .git to prove itself with.
 * "release": the directory's own name is a full commit, it carries
 *            `.botfleet-release.json`, and that manifest passes the store's
 *            strict validation while naming the SAME commit.  The name binding
 *            is what stops a copied manifest from lending this tree another
 *            release's identity.
 * "broken":  a manifest EXISTS but fails validation or names a different
 *            commit.  That is a damaged release, not a checkout: falling
 *            through to git would let an ENCLOSING repository's HEAD stand in
 *            for this tree's identity, which is exactly the misattribution
 *            release mode exists to prevent.  Broken reports zeros + dirty.
 */
function classifyReleaseRoot(root) {
  const name = basename(root);
  if (!/^[a-f0-9]{40}$/.test(name)) return { mode: "git" };
  // A real release is a git-LESS export.  A commit-named directory that still
  // carries .git (a worktree named after its commit is a real layout) is a
  // checkout: git's own dirty detection answers for it, and release mode must
  // never bypass a dirty-git result — that ordering is deliberate.
  try {
    statSync(join(root, ".git")); // a directory, or the file a worktree carries
    return { mode: "git" };
  } catch { /* no readable .git: the export case, keep classifying */ }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, ".botfleet-release.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { mode: "git" };
    return { mode: "broken" };
  }
  if (!validateReleaseManifest(manifest) || manifest.commit !== name) return { mode: "broken" };
  return { mode: "release", manifest };
}

/**
 * Repositories a release can be verified against, most explicit first.
 * The updater's checkout is the ordinary answer on a Mac host; the overrides
 * exist for tests and for a host whose checkout lives somewhere else.
 */
function provenanceRepoCandidates() {
  const candidates = [];
  if (process.env.BOTFLEET_PROVENANCE_REPO) candidates.push(process.env.BOTFLEET_PROVENANCE_REPO);
  if (process.env.BOTFLEET_CHECKOUT) candidates.push(process.env.BOTFLEET_CHECKOUT);
  candidates.push(join(homedir(), "apps", "botfleet-server"));
  return candidates;
}

/**
 * Identity for an explicit release-mode root.
 *
 * The manifest alone cannot make the tree clean: it sits inside the tree it
 * would vouch for, so a writer who edits the release edits the manifest too.
 * Clean comes only from verifying the exported bytes against the commit's
 * tree objects in a real repository — an external binding the release's own
 * writer cannot recompute.  Three outcomes, and they are kept distinct:
 *
 *   verified    the bytes ARE the commit's tree: commit + clean.
 *   unverified  no repository could check (absent, or missing the commit):
 *               the commit is reported as the manifest's claim, still dirty —
 *               a name, never a proof.
 *   drift       a repository checked and the bytes are NOT the commit: the
 *               commit is refused entirely (zeros + dirty), because naming it
 *               would attribute code to a commit it did not come from.
 */
function readReleaseStoreIdentity(root, release, { requireGit, version, build, unknownCommit }) {
  let sourceCommit = unknownCommit;
  let sourceDirty = true;
  let verified = false;
  let sawRepo = false;
  // node_modules is executable code git never exported.  Clean requires it
  // verified too: either absent, or fingerprint-equal to a trusted reference
  // tree (BOTFLEET_PROVENANCE_DEPS) installed from the byte-verified lockfile.
  // An unverifiable dependency tree preserves unknown — never a clean claim
  // over arbitrary executable bytes.
  const referenceDeps = process.env.BOTFLEET_PROVENANCE_DEPS || null;
  for (const repo of provenanceRepoCandidates()) {
    if (!repoHasCommit(repo, release.commit)) continue;
    sawRepo = true;
    let verdict;
    try {
      verdict = verifyReleaseAgainstCommit({ releaseRoot: root, commit: release.commit, repo, referenceDeps });
    } catch {
      verdict = { ok: false, reason: "repo-unavailable" };
    }
    if (verdict.ok) {
      if (verdict.dependencies === "unverified") {
        // Source proven, dependencies unknown: name the commit, stay dirty.
        sourceCommit = release.commit;
        sourceDirty = true;
        break;
      }
      sourceCommit = release.commit;
      sourceDirty = false;
      verified = true;
      break;
    }
    if (verdict.reason === "drift" && verdict.driftScope !== "deps") {
      // Checked and NOT the commit's source: refuse the attribution outright.
      sourceCommit = unknownCommit;
      sourceDirty = true;
      verified = false;
      break;
    }
    if (verdict.reason === "drift") {
      // Dependency drift: the SOURCE is still the commit; the runtime is not clean.
      sourceCommit = release.commit;
      sourceDirty = true;
      verified = false;
      break;
    }
    if (verdict.reason === "unverifiable") {
      // Source proven, dependencies unverifiable (unreadable, or a reference
      // that would only compare the tree against itself): name the commit,
      // never cleanliness.
      sourceCommit = release.commit;
      sourceDirty = true;
      verified = false;
      break;
    }
  }
  if (!verified && !sawRepo) {
    // Nothing could check: report the claim, never cleanliness.  A repository
    // that held the commit but could not finish the check leaves the zeros
    // refusal standing, because a half-completed verification is not a claim
    // worth repeating either.
    sourceCommit = release.commit;
    sourceDirty = true;
  }
  // A build stamping a manifest from this tree must have PROOF of the commit,
  // not a claim: requireGit admits only a verified release.
  if (requireGit && !verified) {
    throw new Error(`cannot verify release identity for ${root}: no repository confirmed the exported bytes are ${release.commit}`);
  }
  // A release tree without a readable package.json is not a crash: with no
  // version left to report, validBuildIdentity rejects the identity below,
  // which is the controlled refusal every other invalid identity takes.
  let packageVersion;
  try {
    packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  } catch { /* absence is an invalid identity, not an exception */ }
  const value = {
    app: "botfleet",
    // The manifest's version is the one the deployer validated for this
    // release; the tree's package.json is what the same code reports when no
    // version was stamped.  A caller-supplied version still wins for a build.
    version: version ?? release.version ?? packageVersion,
    apiVersion: HARNESS_API_VERSION,
    sourceCommit,
    sourceDirty,
    uiHash: null,
  };
  if (release.build !== undefined || build !== null) value.build = build ?? release.build;
  if (!validBuildIdentity(value)) throw new Error("BotFleet release identity is invalid");
  return value;
}

/** Capture once at build/startup, so moving a checkout cannot relabel a live process.
 *
 * Pass `requireGit: true` when the identity is being stamped into a shipped
 * manifest: a build that writes this into `build-identity.json` must know its
 * real source commit, or the packaged app would ship a fabricated all-zeros
 * commit as provenance.  The server keeps the default for startup, where an
 * unavailable git is not a reason to refuse to boot. */
export function readSourceBuildIdentity(root, { requireGit = false, version = null, build = null } = {}) {
  // Git is not guaranteed to be on PATH: a checkout started from a GUI app, a
  // stripped container, or a test that scrubs PATH cannot run it.  That is not
  // a reason for the server to refuse to start, so an unavailable git reports
  // the commit as all zeros and the build as dirty.  Marking it dirty is what
  // makes this safe — `buildCompatibility` never calls two dirty builds
  // "matching", so an unknown commit can never read as agreement between a
  // stale UI bundle and this server.
  const unknownCommit = "0".repeat(40);

  // A release-store directory is explicit release mode, and only that: a
  // directory NAMED by a full commit, carrying a manifest that passes the
  // store's strict validation and names the same commit.  Anything less — no
  // manifest, an invalid one, a name mismatch — is not a release and falls
  // through to the ordinary git path, which in a git-less tree reports
  // zeros+dirty.  Release mode never turns a dirty or unknown tree clean.
  const release = classifyReleaseRoot(root);
  if (release.mode === "release") {
    return readReleaseStoreIdentity(root, release.manifest, { requireGit, version, build, unknownCommit });
  }

  let sourceCommit = unknownCommit;
  let sourceDirty = true;
  // A broken release never reaches git: see classifyReleaseRoot.
  if (release.mode !== "broken") try {
    const git = (...args) => execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const head = git("rev-parse", "HEAD");
    if (/^[a-f0-9]{40}$/.test(head)) {
      sourceCommit = head;
      sourceDirty = git("status", "--porcelain", "--untracked-files=no").length > 0;
    }
  } catch {
    // Git may be absent, timed out, or unable to read the index.  A real HEAD
    // already captured above still stands; only an unknown commit is refused
    // below when requireGit is set.  A status failure after HEAD succeeds keeps
    // sourceDirty true (the safe default), matching the documented fallback.
    /* commit stays unknown when HEAD never arrived; otherwise keep what we have */
  }
  const value = {
    app: "botfleet",
    // A build supplies its own version instead of editing package.json.  That
    // matters because the provenance gate requires a pristine checkout: a
    // version stamped into the source file would make every Mac build report
    // sourceDirty and fail the very gate that proves the build came from a
    // committed tree.
    version: version ?? JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
    apiVersion: HARNESS_API_VERSION, sourceCommit, sourceDirty, uiHash: null,
  };
  // The shared release planner supplies this value; a source run without
  // that plan reports no build rather than inventing one from the version.
  if (build !== null) value.build = build;
  // A manifest stamped into a shipped bundle must name a real commit: git ran
  // but reported no usable HEAD (shallow archive, corrupt repo), so the
  // all-zeros fallback would be fabricated provenance.
  if (requireGit && sourceCommit === unknownCommit) {
    throw new Error(`cannot read git identity for ${root}: git reported no usable HEAD`);
  }
  if (!validBuildIdentity(value)) throw new Error("BotFleet source identity is invalid");
  return value;
}

