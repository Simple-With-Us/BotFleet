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
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

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
  try {
    const manifest = JSON.parse(await readFile(join(path, MANIFEST), "utf8"));
    return typeof manifest?.commit === "string" && FULL_COMMIT.test(manifest.commit);
  } catch {
    return false;
  }
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
  if (await isReleaseDirectory(physical)) {
    return JSON.parse(await readFile(join(physical, MANIFEST), "utf8")).commit;
  }
  // A pointer aimed at something that is not a release (a legacy checkout, or a
  // half-built directory) still tells the caller which commit is live, by name.
  const name = physical.split("/").pop();
  return FULL_COMMIT.test(name) ? name : null;
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
export async function promoteStaging({ commit, env = process.env, renameImpl = rename } = {}) {
  const from = stagingPath(commit, env);
  const to = releasePath(commit, env);
  const manifest = {
    schemaVersion: 1,
    commit,
    promotedAt: new Date().toISOString(),
    // Recorded so an operator looking at a release can tell what produced it
    // without reconstructing the history of the machine.
    node: process.version,
    platform: process.platform,
  };
  await writeFile(join(from, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444 });
  await mkdir(releasesRoot(env), { recursive: true, mode: 0o755 });
  try {
    await renameImpl(from, to);
  } catch (error) {
    throw new Error(
      `Could not promote ${from} to ${to}: ${error?.message || error}.  ` +
        `The staging directory and the releases directory must be on the same filesystem; ` +
        `if BOTFLEET_RELEASES_ROOT points somewhere else, point it at a path on the same volume.`,
    );
  }
  return to;
}

/**
 * Point `current` at a release.  Returns the directory that was displaced so the
 * caller can decide whether to keep it.
 *
 * The temporary link is created in the store root, so the rename is same-volume
 * and therefore atomic.  A reader following `current` at any instant sees either
 * the previous release or the new one.
 */
export async function swapCurrent({ commit, env = process.env } = {}) {
  const target = releasePath(commit, env);
  const link = currentLink(env);
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
      await rename(staged, link);
    } catch (error) {
      // rename-over-an-existing-link is POSIX.  Where it is not available,
      // remove the pointer first and say so, rather than crashing: a
      // non-atomic swap can leave `current` missing for an instant, which is
      // why the caller is told and the previous release is returned so it can be
      // restored.  On macOS — the only platform that runs this — the primary
      // path is the atomic one and this is never reached.
      if (!["EPERM", "EACCES", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error;
      atomic = false;
      await rm(link, { recursive: true, force: true });
      await rename(staged, link);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
  return { activated: target, previous, atomic };
}

/** Every promoted release, oldest first by name (commit SHAs sort by time). */
export async function listReleases(env = process.env) {
  try {
    const names = await readdir(releasesRoot(env), { withFileTypes: true });
    return names
      .filter((entry) => entry.isDirectory() && FULL_COMMIT.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
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
    ranToCompletion = typeof error?.code === "number";
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
export async function pruneReleases({ env = process.env, keep = MIN_RELEASES_KEPT, minAgeMs = DEFAULT_MIN_AGE_MS, now = Date.now(), isHeldImpl = isHeld } = {}) {
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
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    removed.push(commit);
  }
  return { removed, kept, live };
}
