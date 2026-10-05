// Immutable, versioned release directories for the always-on harness, behind a
// single atomically swapped pointer.
//
// WHY THIS EXISTS.  The LaunchAgent `app.botfleet.server` runs from
// `~/apps/botfleet-server`, a mutable linked git worktree.  Every update
// `git checkout --detach`s that worktree and renames a fresh `node_modules` into
// place UNDER a live Node process that is serving HTTP and holding SQLite
// writes.  There is no rollback if the new tree is wrong: the old one is gone.
// Two failure modes follow from that, and both have happened — an update that
// renamed the tree and then failed to start the server, and a disk janitor that
// deleted `node_modules` from a running checkout, so the start script spent its
// budget reinstalling dependencies underneath a live server.
//
// The shape here is the one MCode uses, and the reason it is safe is that a
// release directory is never written to after it is promoted.  Preparing a new
// version cannot damage the running one, because it happens somewhere else
// entirely.  Activation is a pointer swap, and the old release is still on disk
// afterwards, so an unverified new version costs one rename rather than an
// outage.
//
// WHAT THIS DOES NOT DO.  It does not change how the desktop app updates.  That
// path is electron-updater's, it is guarded by a critical rule, and leaving it
// alone is a decision rather than an oversight — see
// docs/rollouts/2026-10-04-updater-ci-builds-smoke-gate-and-decoupled-installs.md.
//
// A note on the pointer swap: the usual idiom is `ln -sfn target link`, but BSD
// ln follows a symlink-to-directory when creating the new link unless `-h` is
// also passed, so the link silently lands INSIDE the directory it was meant to
// replace.  Creating a temporary symlink and renaming it over the destination is
// the same atomic operation with none of that edge case: `rename(2)` over an
// existing path is atomic, so a reader sees either the old release or the new
// one and never a missing pointer.

import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * A failure the caller must be able to branch on by CAUSE, not by matching a
 * message.  The pointer-restore path raises one of these, and it used to raise
 * a class that did not exist in this module — so the error path itself died
 * with a ReferenceError instead of reporting what had happened.
 */
export class ResolutionError extends Error {
  constructor(message, cause, details = {}) {
    super(message);
    this.name = "ResolutionError";
    this.cause = cause;
    Object.assign(this, details);
  }
}

const FULL_COMMIT = /^[a-f0-9]{40}$/;
const CURRENT = "current";
const STAGING = "staging";
const RELEASES = "releases";
// Written into a promoted release so anything inspecting one can tell it is
// immutable and which commit it holds, without resolving the symlink chain.
const MANIFEST = ".botfleet-release.json";
// A release is kept while something may still be running from it.  A harness
// that has been restarted once since the swap has let go of the old tree.
const MIN_RELEASES_KEPT = 2;
const DEFAULT_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** Root of the store, overridable for tests and for a non-default install. */
export function storeRoot(env = process.env) {
  if (env.BOTFLEET_RELEASES_ROOT) return env.BOTFLEET_RELEASES_ROOT;
  const home = env.HOME ?? "";
  if (!home) throw new Error("BOTFLEET_RELEASES_ROOT is unset and HOME is empty; the release store has nowhere to live");
  return join(home, ".botfleet");
}

export function releasesRoot(env = process.env) {
  return join(storeRoot(env), RELEASES);
}

export function stagingRoot(env = process.env) {
  return join(storeRoot(env), STAGING);
}

export function releasePath(commit, env = process.env) {
  if (!FULL_COMMIT.test(commit || "")) {
    throw new Error(`Refusing to address a release by a non-commit value: ${commit}`);
  }
  return join(releasesRoot(env), commit);
}

export function stagingPath(commit, env = process.env) {
  if (!FULL_COMMIT.test(commit || "")) {
    throw new Error(`Refusing to address a staging directory by a non-commit value: ${commit}`);
  }
  return join(stagingRoot(env), commit);
}

export function currentLink(env = process.env) {
  return join(storeRoot(env), CURRENT);
}

/** Is this path a release directory we promoted, as opposed to a live checkout? */
export async function isReleaseDirectory(path) {
  return validateReleaseManifest(await readReleaseManifest(path)) !== null;
}

const MANIFEST_FIELDS = Object.freeze(["schemaVersion", "commit", "promotedAt", "node", "platform"]);

/**
 * Strictly validate a release manifest, or return null.
 *
 * The review asked for a schema, and the substance of that is right: a manifest
 * is untrusted on-disk JSON at a trust boundary, and a check that only looks at
 * `commit` will happily accept an object that also carries anything else.  The
 * first version did exactly that.
 *
 * This is hand-written rather than zod, and the reason is structural rather
 * than preference: this module is about to be imported by the updater, which
 * bootstraps itself by archiving a fixed graph into a temp directory with no
 * node_modules beside it, so a bare third-party import works in CI and then
 * throws ERR_MODULE_NOT_FOUND on every Mac at the moment the updater might need
 * to recover.  Every module in that graph imports nothing but node: builtins.
 *
 * So: every declared field is type-checked, and an UNKNOWN key is rejected —
 * which is the part a single-regex check could not do and the part that matters
 * for a file nothing else is meant to write.
 */
export function validateReleaseManifest(manifest) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- these type checks ARE the boundary parse this function exists to do; the rule discourages typeof as a SUBSTITUTE for parsing, which is the opposite of what these lines are
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return null;
  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_FIELDS.includes(key)) return null; // unknown property
  }
  if (manifest.schemaVersion !== 1) return null;
  if (!FULL_COMMIT.test(manifest.commit ?? "")) return null;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- schema field validation
  if (typeof manifest.promotedAt !== "string" || !Number.isFinite(Date.parse(manifest.promotedAt))) return null;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- schema field validation
  if (manifest.node !== undefined && typeof manifest.node !== "string") return null;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- schema field validation
  if (manifest.platform !== undefined && typeof manifest.platform !== "string") return null;
  return manifest;
}

/**
 * The physical directory behind the pointer, or null when nothing is activated.
 *
 * The updater must use this, not the pointer: `dependencyFingerprint` and
 * `validateBuiltBundle` both refuse a symlinked root, because a symlink is not a
 * stable identity for a tree whose contents are being compared.  So the pointer
 * is a launchd-level indirection only, and anything that reasons about the tree
 * resolves it first.
 */
export async function resolveCurrent(env = process.env) {
  try {
    return await realpath(currentLink(env));
  } catch {
    return null;
  }
}

export async function currentCommit(env = process.env) {
  const physical = await resolveCurrent(env);
  if (!physical) return null;
  // ONE read, guarded.  This used to check the manifest and then read it again,
  // and a prune landing between the two made the second read throw out of a
  // function documented to return null — so a caller doing the documented null
  // check still crashed, on the exact path where a release is being deleted.
  const manifest = validateReleaseManifest(await readReleaseManifest(physical));
  if (manifest) return manifest.commit;
  // A pointer aimed at something that is not a release (a legacy checkout, or a
  // half-built directory) still tells the caller which commit is live, by name.
  // Split on the platform's separator: a hard-coded "/" would make every path
  // look like one segment on Windows and silently answer null there.
  const name = physical.split(sep).pop();
  return FULL_COMMIT.test(name) ? name : null;
}

/** Read a release manifest, returning null rather than throwing on anything. */
async function readReleaseManifest(directory) {
  try {
    return JSON.parse(await readFile(join(directory, MANIFEST), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Move a prepared staging directory into `releases/<commit>` and mark it.
 *
 * `rename` is atomic and refuses to cross a filesystem, which is the correct
 * behaviour here: a staging tree and its release must be on the same volume, and
 * a silent cross-device copy would leave a half-copied "release" that looks
 * complete.  `mkdir` first is the portable way to fail on a cross-device rename
 * with a clear error rather than an obscure one from the kernel.
 */
export async function promoteStaging({ commit, env = process.env, renameImpl = rename, promotedAt = new Date().toISOString() } = {}) {
  const from = stagingPath(commit, env);
  const to = releasePath(commit, env);
  const manifest = {
    schemaVersion: 1,
    commit,
    promotedAt,
    // Recorded so an operator looking at a release can tell what produced it
    // without reconstructing the history of the machine.
    node: process.version,
    platform: process.platform,
  };
  const manifestPath = join(from, MANIFEST);
  // Remove any leftover first.  A previous attempt may have written the manifest
  // read-only, and fs.writeFile applies `mode` only when it CREATES a file — so
  // rewriting one that already exists throws EACCES against our own 0o444, and
  // a retried promotion would fail with "run chmod manually" on a file this
  // function wrote seconds earlier.
  await rm(manifestPath, { force: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444 });
  await mkdir(releasesRoot(env), { recursive: true, mode: 0o755 });
  try {
    await renameImpl(from, to);
  } catch (error) {
    // Re-promoting a commit that is already a release is not a cross-device
    // problem, and telling an operator to move a directory they did not break
    // sends them the wrong way. ENOTEMPTY/EEXIST means it is already there.
    if (["ENOTEMPTY", "EEXIST", "EISDIR"].includes(error?.code)) {
      throw new ResolutionError(
        `Commit ${commit.slice(0, 12)} is already a release at ${to}; nothing to promote.`,
        "already-released",
        { releasePath: to },
      );
    }
    throw new ResolutionError(
      `Could not promote ${from} to ${to}: ${error?.message || error}.  ` +
        `The staging directory and the releases directory must be on the same filesystem; ` +
        `if BOTFLEET_RELEASES_ROOT points somewhere else, point it at a path on the same volume.`,
      "promote-failed",
    );
  }
  // ENFORCE immutability, do not just claim it.  The 0o444 above marks one file;
  // the directory and everything in it kept the staging tree's defaults, so
  // nothing actually stopped anything from writing into a promoted release —
  // and the whole design rests on a release being byte-identical to the commit
  // it names.  The release is read-only, not merely documented read-only.
  try {
    await makeReadOnly(to);
  } catch (error) {
    throw new ResolutionError(
      `${error.message}  The tree is already promoted at ${to}; it cannot be re-promoted, so it must be removed with discardRelease() before retrying.`,
      "release-not-read-only",
      { releasePath: to },
    );
  }
  return to;
}

/**
 * Drop write permission from a promoted release, and say so if it did not take.
 *
 * Read-only is the invariant, so a failure here is a failure to promote, not a
 * warning to print later: an operator who believes a release is immutable and
 * discovers otherwise has been misled by this code.
 */
/**
 * Remove a promoted release, restoring write permission first.
 *
 * A release is read-only by construction, so unlinking one fails — and anything
 * that removes a release (the pruner, a test fixture tearing down, an operator
 * reclaiming disk) needs that one fact.  Keeping it in a single exported place
 * means there is one thing to get right rather than N.
 *
 * Callers are responsible for having established that nothing is running from
 * the release; this function does not check, because the pruner has already
 * done a liveness check that a blind caller has not.
 */
export async function discardRelease(commit, env = process.env) {
  const path = releasePath(commit, env);
  await makeWritable(path);
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    // The tree was made writable to be deleted, and it still exists.  Put the
    // immutability back rather than leaving a promoted release silently
    // writable: `force: true` only suppresses ENOENT, so an EBUSY or EEXIST
    // here returns with the release intact — and the next caller would find a
    // "read-only" release that anything can write to.
    let restored = false;
    try {
      await makeReadOnly(path);
      restored = true;
    } catch {
      // Already gone, or no longer ours to fix; the original error is the one
      // that explains why discard failed.
    }
    throw new ResolutionError(
      `Could not discard ${path}: ${error?.message || error}` +
        (restored
          ? "  Its read-only permissions have been restored."
          : "  AND its permissions could not be restored, so it is still writable — treat it as unsafe until someone removes it by hand."),
      restored ? "discard-failed-read-only-restored" : "discard-failed-writable",
      { releasePath: path },
    );
  }
  return path;
}


/**
 * Walk a tree and set its permission bits, or report the directory mode.
 *
 * One walker, used in both directions, because the mistake this replaces was
 * exactly a half-applied one: chmod-ing the top directory and assuming the
 * contents followed.  They do not — a promoted tree kept its staging
 * permissions, so the "immutable" release was fully writable file by file and
 * nothing stopped anyone from editing a release in place.
 */
async function setTreePermission(path, { writable, readOnly, errors = [] }) {
  const { chmod, readdir } = await import("node:fs/promises");
  try {
    await chmod(path, writable ? 0o755 : 0o555);
  } catch (err) {
    errors.push({ path, error: err });
  }
  let entries = [];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (err) {
    errors.push({ path, error: err });
    return errors;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      await setTreePermission(child, { writable, readOnly, errors });
    } else if (!entry.isSymbolicLink()) {
      // chmod follows symlinks; a link in the tree would chmod its target outside the release
      try {
        await chmod(child, writable ? 0o644 : readOnly);
      } catch (err) {
        errors.push({ path: child, error: err });
      }
    }
  }
  return errors;
}

async function makeWritable(path) {
  await setTreePermission(path, { writable: true, readOnly: 0o444 });
}

async function makeReadOnly(path) {
  const errors = await setTreePermission(path, { writable: false, readOnly: 0o444 });
  if (errors.length > 0) {
    const failedPaths = errors.slice(0, 3).map((e) => e.path).join(", ");
    throw new ResolutionError(
      `Promoted ${path} but ${errors.length} file(s) failed permission updates: ${failedPaths}; ` +
        `a release must be immutable, so this is not being treated as a success`,
      "release-not-read-only",
      { releasePath: path, errors },
    );
  }
  const { stat } = await import("node:fs/promises");
  const mode = (await stat(path)).mode & 0o222;
  if (mode !== 0) {
    throw new ResolutionError(
      `Promoted ${path} but it is still writable (mode ${(mode & 0o777).toString(8)}); ` +
        `a release must be immutable, so this is not being treated as a success`,
      "release-not-read-only",
      { releasePath: path },
    );
  }
}

/**
 * Point `current` at a release.  Returns the directory that was displaced so the
 * caller can decide whether to keep it.
 *
 * The temporary link is created in the store root, so the rename is same-volume
 * and therefore atomic.  A reader following `current` at any instant sees either
 * the previous release or the new one.
 */
/** Create a symlink at `path` pointing at `target`, used to keep a spare. */
async function createPointerAt(path, target, type) {
  const spare = `${path}.displaced-${randomUUID().slice(0, 8)}`;
  await symlink(target, spare, type);
  return spare;
}

export async function swapCurrent({ commit, env = process.env, renameImpl = rename } = {}) {
  const target = releasePath(commit, env);
  const link = currentLink(env);
  // The pointer is only ever moved onto a release that exists.  Without this,
  // a typo'd or already-pruned commit gets a `current` that resolves to
  // nothing: the launcher follows it, finds no tree, and the harness cannot
  // start — with no error anywhere saying the pointer is dangling, because from
  // the store's point of view the swap succeeded.
  let targetStat;
  try {
    targetStat = await stat(target);
  } catch (error) {
    throw new ResolutionError(
      `Cannot point current at ${target}: ${error?.message || error}.  ` +
        `Promote that commit first — swapCurrent only moves the pointer onto a release that already exists.`,
      "release-missing",
      { releasePath: target },
    );
  }
  if (!targetStat.isDirectory()) {
    throw new ResolutionError(
      `${target} is not a directory, so it cannot be a release.  ` +
        `Promote that commit first — swapCurrent only moves the pointer onto a release that already exists.`,
      "release-missing",
      { releasePath: target },
    );
  }
  const previous = await resolveCurrent(env);
  const scratch = await mkdtemp(join(storeRoot(env), ".current-"));
  const staged = join(scratch, CURRENT);
  // "dir" matters on Windows: without a type, Node infers one from the target,
  // and since the target is a directory it creates a JUNCTION — which Windows
  // then refuses to rename over, because a junction is a directory for
  // MoveFileEx purposes.  That is the whole reason the atomic form appeared to
  // be broken there rather than merely unsupported.
  const linkType = process.platform === "win32" ? "junction" : "dir";
  let atomic = true;
  try {
    await symlink(target, staged, linkType);
    try {
      await renameImpl(staged, link);
    } catch (error) {
      // rename-over-an-existing-link is POSIX.  Where it is not available,
      // remove the pointer first and say so, rather than crashing: a
      // non-atomic swap can leave `current` missing for an instant, which is
      // why the caller is told and the previous release is returned so it can be
      // restored.  On macOS — the only platform that runs this — the primary
      // path is the atomic one and this is never reached.
      if (!["EPERM", "EACCES", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error;
      atomic = false;
      // Put the old pointer back if the retry fails, because we just deleted it.
      // Without this a failed swap leaves `current` ABSOLENT rather than stale,
      // and absent is the one state the harness cannot start from: the launcher
      // resolves the pointer and a missing one means no harness at all.  A stale
      // pointer is recoverable; a missing one is an outage.
      const displaced = previous ? await createPointerAt(link, previous, linkType) : null;
      await rm(link, { recursive: true, force: true });
      try {
        await renameImpl(staged, link);
        // The retry succeeded, so the spare has served its purpose: `previous`
        // is returned below for the caller to keep.  Left in place it is a
        // stray `current.displaced-<hex>` symlink per non-atomic swap, and
        // nothing in the store ever prunes those.
        if (displaced) await rm(displaced, { recursive: true, force: true }).catch(() => {});
      } catch (retryError) {
        // Report what actually happened.  Swallowing the restore result and
        // then always saying "could not restore" tells an operator staring at
        // a harness outage that their previous release is gone when it is
        // sitting there — which sends them looking for the wrong problem.
        let restored = false;
        let restoreError = null;
        if (displaced) {
          try {
            await rename(displaced, link);
            restored = true;
          } catch (error) {
            restoreError = error;
          }
        }
        throw new ResolutionError(
          restored
            ? `Could not move the release pointer to ${target}, so the previous release was put back: ${retryError?.message || retryError}`
            : `Could not move the release pointer to ${target} and could not restore the previous release: ${retryError?.message || retryError}` +
              (restoreError ? `  Restoring it also failed: ${restoreError?.message || restoreError}` : ""),
          restored ? "swap-failed-restored" : "pointer-lost",
          { previous, restored },
        );
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
  return { activated: target, previous, atomic };
}

/**
 * Every promoted release, OLDEST FIRST BY WHEN IT WAS PROMOTED.
 *
 * Not by commit SHA.  A SHA contains no time information, and lexicographic
 * order is only chronological when commits happen to be created in ascending
 * order — which is not a property, it is a coincidence.  Promote `bbbb…` and
 * then `aaaa…` and a name-sorted list puts `aaaa…` FIRST, so a retention policy
 * keeping the most recent N would delete the NEWER release and retain the stale
 * one.  That is a rollback target that is not a rollback target.
 *
 * `promotedAt` in the manifest is the real ordering key.  A directory whose
 * manifest cannot be read falls back to its mtime, and then to the name, so an
 * unreadable release sorts predictably instead of vanishing from the list.
 */
export async function listReleases(env = process.env) {
  let entries;
  try {
    entries = await readdir(releasesRoot(env), { withFileTypes: true });
  } catch {
    return [];
  }
  const releases = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !FULL_COMMIT.test(entry.name)) continue;
    const path = join(releasesRoot(env), entry.name);
    const promotedAt = await promotedAtOf(path);
    releases.push({ commit: entry.name, promotedAt });
  }
  return releases.sort((a, b) => a.promotedAt - b.promotedAt || a.commit.localeCompare(b.commit)).map((r) => r.commit);
}

async function promotedAtOf(path) {
  try {
    const manifest = validateReleaseManifest(JSON.parse(await readFile(join(path, MANIFEST), "utf8")));
    const when = manifest ? Date.parse(manifest.promotedAt) : Number.NaN;
    if (Number.isFinite(when)) return when;
  } catch {
    // fall through to the filesystem
  }
  try {
    // Awaited inside the try, never returned from it.  A promise RETURNED from
    // a try block is not covered by that block's catch, so a stat() failure would
    // escape as an unhandled rejection instead of falling back to 0 — and this
    // runs once per release inside a retention pass that is about to delete
    // things, which is the worst possible place for an unhandled rejection.
    const { stat } = await import("node:fs/promises");
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Does any running process still hold files inside this directory?
 *
 * This is the question that decides whether a release can be deleted, and
 * getting it wrong in the permissive direction deletes a tree out from under a
 * live server.  `lsof` is the only reliable signal on macOS — a process can hold
 * an open file descriptor, a mapped library, or a current working directory, and
 * none of those are visible anywhere else.
 *
 * The trap, and it is a nasty one: lsof's EXIT STATUS does not mean "found
 * nothing".  It reports whether lsof completed without warnings, so a run that
 * prints a perfectly good match and also emits a warning exits 1.  Judging on
 * the exit code therefore reads a held tree as free, which is exactly backwards
 * for a deletion gate.  So: judge on the OUTPUT, and treat "no output and a
 * non-zero status" as cannot-answer rather than as free.
 */
export async function isHeld(directory, { timeoutMs = 25_000 } = {}) {
  let stdout = "";
  // "Did lsof run to completion?"  Its exit status answers a different question
  // — whether it warned — so it cannot be used for this, but the two are not the
  // same either.
  let ranToCompletion = false;
  try {
    ({ stdout } = await run("lsof", ["-Fn", "+D", directory], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }));
    ranToCompletion = true;
  } catch (error) {
    // A non-zero exit still carries valid stdout whenever lsof found anything, so
    // the output is examined either way.  Node reports an ordinary non-zero exit
    // as a numeric code and a failure to execute as a string like ENOENT, or as
    // killed/signal on a timeout.
    stdout = String(error?.stdout || "");
    ranToCompletion = Number.isInteger(error?.code);
  }
  if (/(^|\n)p\d+/.test(stdout)) return true; // something is holding files here
  // lsof on an empty or untouched directory exits 1 with no output at all, so
  // "ran and printed nothing" genuinely means free.  Treating a non-zero status
  // as unanswerable instead would make every release permanently unprunable,
  // since +D routinely warns.
  return !ranToCompletion; // could not run, or timed out: not permission to delete
}

/**
 * Delete releases nothing can be running from any more.
 *
 * Conservative by construction: it keeps `current`, keeps the most recent
 * `minKeep`, keeps anything too young to be a previous generation, and keeps
 * anything `lsof` cannot clear.  Pruning is housekeeping, so a mistake here is
 * wasted disk at worst — but the same mistake aimed the other way is an outage,
 * and that is not a trade this makes.
 */
export async function pruneReleases({ env = process.env, keep = MIN_RELEASES_KEPT, minAgeMs = DEFAULT_MIN_AGE_MS, now = Date.now(), isHeldImpl = isHeld, onRemove } = {}) {
  const live = await currentCommit(env);
  const releases = await listReleases(env);
  const candidates = releases.filter((commit) => commit !== live);
  const doomed = candidates.slice(0, Math.max(0, candidates.length - Math.max(0, keep)));
  const removed = [];
  const kept = [];
  for (const commit of doomed) {
    const path = releasePath(commit, env);
    let stat;
    try {
      stat = await import("node:fs/promises").then((fs) => fs.stat(path));
    } catch {
      continue;
    }
    if (now - stat.mtimeMs < minAgeMs) {
      kept.push({ commit, reason: "too-young" });
      continue;
    }
    if (await isHeldImpl(path)) {
      kept.push({ commit, reason: "held-by-a-process" });
      continue;
    }
    // A promoted release is read-only, and a read-only directory cannot be
    // unlinked.  Pruning is the ONE place allowed to restore write permission,
    // and only after liveness said nothing is running from it.  Making the
    // release immutable and teaching the pruner about it are the same change.
    await discardRelease(commit, env);
    removed.push(commit);
    onRemove?.(commit);
  }
  return { removed, kept, live };
}
