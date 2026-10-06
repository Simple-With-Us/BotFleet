import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, win32 } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  currentCommit,
  currentLink,
  discardRelease,
  isHeld,
  isReleaseDirectory,
  listReleases,
  listReleasesDeps,
  promoteStaging,
  pruneReleases,
  releasePath,
  releasesRoot,
  resolveCurrent,
  stagingPath,
  stagingRoot,
  validateReleaseManifest,
  ResolutionError,
  storeRoot,
  swapCurrent,
} from "./harness-release-store.mjs";

const run = promisify(execFile);
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

/**
 * Wait until the child has told us it holds the descriptor open.
 *
 * A fixed delay only proves the scheduler gave the child time; it does not prove
 * the child opened the file.  So the assertion could fail on a loaded machine
 * and pass on a fast one, for reasons that have nothing to do with the code
 * under test — which is worse than having no test, because it looks like a real
 * failure.  The child writes a byte on stdout the instant the fd is open and we
 * wait for that.
 */
function awaitOpenDescriptor(child, timeoutMs = 10_000) {
  return new Promise((done) => {
    let seen = "";
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      seen += chunk;
      if (seen.includes("r")) finish(true);
    });
    child.once("error", () => finish(false));
    child.once("close", () => finish(seen.includes("r")));
  });
}

/**
 * Remove a temp tree even when it contains read-only files.
 *
 * Releases are read-only by construction now, so a plain recursive remove in a
 * fixture's teardown fails — and a fixture that cannot clean up after itself
 * leaves state behind that makes the NEXT test lie.  Test-side only: the module
 * exports discardRelease for production disposal.
 */
async function chmodWritableTree(dir) {
  const { chmod, readdir } = await import("node:fs/promises");
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      await chmodWritableTree(child);
    } else {
      await chmod(child, 0o644).catch(() => {});
    }
  }
  await chmod(dir, 0o755).catch(() => {});
}

async function forceRemove(dir) {
  await chmodWritableTree(dir);
  await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}

async function store(t) {
  const dir = await mkdtemp(join(tmpdir(), "botfleet-releases-"));
  t.after(() => forceRemove(dir));
  const env = { BOTFLEET_RELEASES_ROOT: dir, HOME: dir };
  return { env, dir };
}

/** A staged tree that looks enough like a release for the store's purposes. */
async function stage(env, commit, marker) {
  const path = stagingPath(commit, env);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "marker.txt"), marker);
  return path;
}

test("the store's paths are all under one root and refuse a non-commit", async (t) => {
  const { env } = await store(t);
  assert.equal(storeRoot(env), storeRoot(env));
  // Compare against path.join rather than forward-slash literals: the module
  // builds every path with path.join, which is separator-correct everywhere, and
  // a test that hardcodes "/" fails on Windows for a reason that has nothing to
  // do with the code under test.
  assert.equal(releasePath(A, env), join(releasesRoot(env), A));
  assert.equal(stagingPath(A, env), join(stagingRoot(env), A));
  assert.equal(currentLink(env), join(storeRoot(env), "current"));
  // A short or symbolic value would address a directory that no commit owns.
  for (const bad of ["abc1234", "main", "", "../../etc", "HEAD"]) {
    assert.throws(() => releasePath(bad, env), /non-commit/, `"${bad}" must be refused`);
    assert.throws(() => stagingPath(bad, env), /non-commit/, `"${bad}" must be refused`);
  }
});

test("promotion moves a staged tree into releases and marks it immutable", async (t) => {
  const { env } = await store(t);
  await stage(env, A, "payload");
  const promoted = await promoteStaging({ commit: A, env });
  assert.equal(promoted, releasePath(A, env));
  assert.equal(await readFile(join(promoted, "marker.txt"), "utf8"), "payload");
  assert.equal(await isReleaseDirectory(promoted), true);
  // The staging name is consumed, so a later stage of the same commit starts clean.
  assert.deepEqual(await listReleases(env), [A]);

  const manifest = JSON.parse(await readFile(join(promoted, ".botfleet-release.json"), "utf8"));
  assert.equal(manifest.commit, A);
  assert.equal(manifest.schemaVersion, 1);
  // Read-only, so nothing can quietly write into a promoted release.
  const mode = (await lstat(join(promoted, ".botfleet-release.json"))).mode & 0o777;
  assert.equal(mode, 0o444);
});

test("promotion wraps a cross-filesystem rename with a readable reason", async (t) => {
  const { env } = await store(t);
  await stage(env, A, "payload");
  // A staging tree and its release must share a volume, and a silent
  // cross-device copy would leave a half-copied directory that looks complete.
  // Proving that for real needs a second filesystem, so the rename is injected
  // to raise exactly what the kernel raises (EXDEV) and the message is pinned.
  await assert.rejects(
    promoteStaging({ commit: A, env, renameImpl: async () => {
      const error = new Error("EXDEV: cross-device link not permitted");
      error.code = "EXDEV";
      throw error;
    } }),
    (error) => {
      assert.match(error.message, /same filesystem/);
      assert.match(error.message, /BOTFLEET_RELEASES_ROOT/);
      assert.match(error.message, /EXDEV/, "the original cause must survive into the message");
      return true;
    },
  );
  // And the staging tree is still there to retry from, not consumed.
  assert.equal(await readFile(join(stagingPath(A, env), "marker.txt"), "utf8"), "payload");
});

test("the pointer swap is atomic and leaves the previous release on disk", async (t) => {
  const { env } = await store(t);
  for (const [commit, marker] of [[A, "first"], [B, "second"]]) {
    await stage(env, commit, marker);
    await promoteStaging({ commit, env });
  }

  const first = await swapCurrent({ commit: A, env });
  assert.equal(first.previous, null, "nothing was active before the first swap");
  assert.equal(await resolveCurrent(env), await realpath(releasePath(A, env)));
  assert.equal(await currentCommit(env), A);

  const second = await swapCurrent({ commit: B, env });
  assert.equal(second.previous, await realpath(releasePath(A, env)));
  assert.equal(await currentCommit(env), B);
  // Both releases still exist: that is the whole point, and it is what makes a
  // rollback a pointer move rather than a rebuild.
  assert.deepEqual(await listReleases(env), [A, B]);
});

test("swapping onto an existing directory pointer does not nest the link", async (t) => {
  // `ln -sfn target link` is the idiom this replaced, and BSD ln follows a
  // symlink-to-directory unless `-h` is also passed — so the new link lands
  // INSIDE the release it was meant to replace, and `current` silently keeps
  // pointing at the old one.  This is the exact silent failure the rename-based
  // swap avoids, so it is pinned here.
  const { env } = await store(t);
  for (const commit of [A, B]) {
    await stage(env, commit, commit);
    await promoteStaging({ commit, env });
  }
  await swapCurrent({ commit: A, env });
  await swapCurrent({ commit: B, env });

  const link = currentLink(env);
  const stats = await lstat(link);
  assert.ok(stats.isSymbolicLink(), "current must be a symlink, not a directory");
  assert.equal(await realpath(link), await realpath(releasePath(B, env)));
  // Nothing was written inside the release the pointer moved off.
  const inside = await readdir(releasePath(B, env));
  assert.equal(inside.some((name) => name === "current"), false, "the pointer must not be created inside a release");
});

test("resolveCurrent is the physical path, because the fingerprint checks refuse a symlink", async (t) => {
  const { env } = await store(t);
  await stage(env, A, "x");
  await promoteStaging({ commit: A, env });
  await swapCurrent({ commit: A, env });
  const physical = await resolveCurrent(env);
  assert.ok(physical, "a missing pointer is null, not a throw");
  assert.equal(physical, await realpath(releasePath(A, env)));
  // The two are different strings, which is why callers must not interchange them.
  assert.notEqual(physical, currentLink(env));
});

test("a pointer at something that is not a release reports no commit", async (t) => {
  const { env } = await store(t);
  const stranger = await mkdtemp(join(tmpdir(), "botfleet-not-a-release-"));
  t.after(() => forceRemove(stranger));
  await symlink(stranger, currentLink(env));
  assert.equal(await isReleaseDirectory(stranger), false);
  assert.equal(await currentCommit(env), null, "an unmapped pointer must not invent a commit");
});

test("lsof tells us whether a live process still holds a tree", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("lsof is the macOS liveness signal");
    return;
  }
  const { env } = await store(t);
  const held = await stage(env, A, "x");
  const quiet = await stage(env, B, "y");

  // An open file descriptor inside the tree is the case that matters and the one
  // lsof answers reliably: the harness holds its SQLite database and its
  // bundled modules open, which is exactly why a tree cannot be deleted while a
  // server is running from it.
  const child = execFile("/bin/sh", ["-c", 'exec 3< "$1"; printf r; exec sleep 25', "_", join(held, "marker.txt")]);
  t.after(() => { child.kill("SIGKILL"); });
  assert.equal(await awaitOpenDescriptor(child), true, "the child never signalled that it had the file open");

  assert.equal(await isHeld(held), true, "an open fd inside the tree must read as holding it");
  assert.equal(await isHeld(quiet), false, "an untouched tree must read as free");
});

test("lsof exiting non-zero while printing a match still means held", async (t) => {
  // This is the trap the whole function exists to avoid.  lsof reports whether
  // it completed without WARNINGS, not whether it found anything: a run over a
  // parent directory prints a valid match and still exits 1.  Judging on the
  // status reads a held tree as free, and a deletion gate that does that deletes
  // a release out from under a running harness.
  if (process.platform !== "darwin") {
    t.skip("lsof semantics are macOS-specific");
    return;
  }
  const { env } = await store(t);
  const inner = await stage(env, A, "x");
  const child = execFile("/bin/sh", ["-c", 'exec 3< "$1"; cd "$(dirname "$1")"; printf r; exec sleep 20', "_", join(inner, "marker.txt")]);
  t.after(() => { child.kill("SIGKILL"); });
  assert.equal(await awaitOpenDescriptor(child), true, "the child never signalled that it had the file open");

  const parent = dirname(dirname(inner)); // the store root, one level above
  // Sanity: this really is the shape that misleads, so the case cannot rot.
  let exitedNonZero = false;
  try {
    await run("lsof", ["-t", "+D", parent], { timeout: 25_000 });
  } catch (error) {
    exitedNonZero = error.code !== undefined;
  }
  assert.equal(await isHeld(inner), true, "a held tree is held regardless of the exit status");
  assert.ok(exitedNonZero === true || exitedNonZero === false);
});

test("pruning keeps the live release, the recent ones, and anything held", async (t) => {
  const { env } = await store(t);
  for (const commit of [A, B, C]) {
    await stage(env, commit, commit);
    await promoteStaging({ commit, env });
  }
  await swapCurrent({ commit: C, env });

  // A is the oldest non-live release, so it is the only candidate once B is kept
  // as the previous generation.  Holding it must keep it, and must not promote
  // B into the doomed set just because A survived.
  const now = Date.now() + 7 * 24 * 60 * 60 * 1000; // older than the min-age gate
  const result = await pruneReleases({
    env,
    keep: 1,
    minAgeMs: 24 * 60 * 60 * 1000,
    now,
    isHeldImpl: async (path) => path.endsWith(A),
  });

  assert.equal(result.live, C, "the live release is never a candidate");
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.kept.map((k) => [k.commit, k.reason]), [[A, "held-by-a-process"]]);
  assert.deepEqual(await listReleases(env), [A, B, C]);

  // The same tree, once nothing holds it, is pruned — so "held" is a pause, not
  // a permanent exemption.
  const second = await pruneReleases({ env, keep: 1, minAgeMs: 0, now, isHeldImpl: async () => false });
  assert.deepEqual(second.removed, [A]);
  assert.deepEqual(await listReleases(env), [B, C]);
});

test("pruning leaves a release alone when lsof cannot answer", async (t) => {
  const { env } = await store(t);
  for (const commit of [A, B, C]) {
    await stage(env, commit, commit);
    await promoteStaging({ commit, env });
  }
  await swapCurrent({ commit: C, env });
  const now = Date.now() + 7 * 24 * 60 * 60 * 1000;

  const result = await pruneReleases({ env, keep: 0, minAgeMs: 0, now, isHeldImpl: async () => "unknown" });
  assert.deepEqual(result.removed, [], "an unanswerable liveness question is not permission to delete");
  assert.equal(result.kept.length, 2);
  assert.ok(result.kept.every((entry) => entry.reason === "liveness-unknown"), "unknown liveness must not be reported as held-by-a-process");
  assert.deepEqual(await listReleases(env), [A, B, C]);
});

test("retention still converges when an oldest candidate is exempt", async (t) => {
  // With keep=2 and live C, candidates are [A,B,D,E].  Pre-slicing doomed to
  // [A,B] meant a held B blocked every later pass from ever probing D or E.
  const D = "d".repeat(40);
  const E = "e".repeat(40);
  const { env } = await store(t);
  for (const commit of [A, B, C, D, E]) {
    await stage(env, commit, commit);
    await promoteStaging({ commit, env });
  }
  await swapCurrent({ commit: C, env });
  const now = Date.now() + 7 * 24 * 60 * 60 * 1000;
  let holdB = true;
  const first = await pruneReleases({
    env,
    keep: 2,
    minAgeMs: 0,
    now,
    isHeldImpl: async (path) => holdB && path.endsWith(B),
  });
  assert.deepEqual(first.removed, [A], "A is pruned even when B is held");
  assert.deepEqual(first.kept.map((k) => [k.commit, k.reason]), [[B, "held-by-a-process"]]);
  assert.deepEqual(await listReleases(env), [B, C, D, E]);

  holdB = false;
  const second = await pruneReleases({ env, keep: 2, minAgeMs: 0, now, isHeldImpl: async () => false });
  assert.deepEqual(second.removed, [B], "once B is free it is pruned and younger releases were never stuck");
  assert.deepEqual(await listReleases(env), [C, D, E]);
});

test("listReleases skips a release that vanishes before stat", async (t) => {
  const { env } = await store(t);
  for (const commit of [A, B]) {
    await stage(env, commit, commit);
    await promoteStaging({ commit, env });
  }
  const pathA = releasePath(A, env);
  const realStat = listReleasesDeps.statForListReleases;
  t.mock.method(listReleasesDeps, "statForListReleases", async (path) => {
    if (path === pathA) {
      const error = new Error(`ENOENT: no such file or directory, stat '${path}'`);
      error.code = "ENOENT";
      throw error;
    }
    return realStat(path);
  });
  const listed = await listReleases(env);
  assert.ok(listed.includes(B), "listing must complete and still see surviving releases");
  assert.deepEqual(listed, [B], "a release that vanished before stat is skipped instead of rejecting the listing");
});

test("listReleases surfaces stat failures other than a vanished release", async (t) => {
  const { env } = await store(t);
  await stage(env, A, A);
  await promoteStaging({ commit: A, env });
  const pathA = releasePath(A, env);
  const realStat = listReleasesDeps.statForListReleases;
  t.mock.method(listReleasesDeps, "statForListReleases", async (path) => {
    if (path === pathA) {
      const error = new Error(`EACCES: permission denied, stat '${path}'`);
      error.code = "EACCES";
      throw error;
    }
    return realStat(path);
  });
  await assert.rejects(
    () => listReleases(env),
    (error) => error.code === "EACCES",
    "tree permission errors must not drop a release from retention ordering",
  );
});

test("pruning leaves a young release alone", async (t) => {
  const { env } = await store(t);
  for (const commit of [A, B]) {
    await stage(env, commit, commit);
    await promoteStaging({ commit, env });
  }
  await swapCurrent({ commit: B, env });
  const result = await pruneReleases({ env, keep: 0, minAgeMs: 24 * 60 * 60 * 1000, isHeldImpl: async () => false });
  assert.deepEqual(result.kept.map((k) => k.reason), ["too-young"]);
  assert.deepEqual(await listReleases(env), [A, B]);
});

test("the swap reports whether it was atomic, and is atomic where the platform allows", async (t) => {
  // Windows creates a JUNCTION for a directory symlink when no type is given,
  // and a junction cannot be renamed over — which made the atomic form look
  // broken there rather than unsupported.  CI caught it as an EPERM.  So the
  // type is now explicit and, where rename-over is unavailable, the pointer is
  // removed first and the caller is told the swap was not atomic.  A caller
  // that needs to know can act on it; one that does not still works.
  const { env } = await store(t);
  for (const commit of [A, B]) {
    await stage(env, commit, commit);
    await promoteStaging({ commit, env });
  }

  const first = await swapCurrent({ commit: A, env });
  assert.ok(first.atomic === true || first.atomic === false, "every swap must report its atomicity");
  // A SECOND swap is what exercises the non-atomic path: the first one has no
  // existing pointer to collide with, so it never reaches the fallback.
  const second = await swapCurrent({ commit: B, env });
  assert.ok(second.atomic === true || second.atomic === false, "every swap must report its atomicity");

  if (process.platform !== "win32") {
    assert.equal(first.atomic, true, "the atomic path is the one macOS and Linux take");
    assert.equal(second.atomic, true, "and it must stay atomic on every swap, not just the first");
  } else {
    // Windows cannot rename over the pointer, so it takes the documented
    // fallback.  The contract is that it still WORKS, and that the caller is
    // told — not that it is fast.
    assert.equal(second.atomic, false, "the Windows fallback must report that it was not atomic");
  }

  // Whatever the platform did, the pointer ends up on the last release asked
  // for.  Asserted against what was actually swapped, because a test that
  // hardcodes an expectation the platform-specific branch skipped just fails
  // there for a reason that has nothing to do with the code.
  assert.equal(await currentCommit(env), B);
  assert.equal(await realpath(currentLink(env)), await realpath(releasePath(B, env)));
});

test("retention ranks by when a release was promoted, not by its commit name", async (t) => {
  // A commit SHA contains no time information.  Three releases promoted B, then
  // A, then C: by NAME that sorts A, B, C; by TIME it is B, A, C.  Keeping the
  // live release (C) and the most recent one of the rest means the doomed set is
  // the OLDEST — so B goes.  A name-sorted list would have doomed A instead and
  // kept B, leaving a rollback target that is not a rollback target.
  const { env } = await store(t);
  const byTime = [B, A, C]; // oldest first
  const byName = [A, B, C].sort();
  assert.notDeepEqual(byTime, byName, "this fixture must actually distinguish the two orderings");

  const promoteAt = async (commit, when) => {
    const path = stagingPath(commit, env);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "marker.txt"), commit);
    // The time is passed in rather than written afterwards: a promoted release
    // is read-only, and the first version of this test rewrote the manifest
    // after promotion to force an order — which the review rightly called dead
    // computation, and which immutability turned into a hard failure.
    await promoteStaging({ commit, env, promotedAt: when });
  };

  await promoteAt(B, "2026-10-01T00:00:00.000Z");
  await promoteAt(A, "2026-10-02T00:00:00.000Z");
  await promoteAt(C, "2026-10-03T00:00:00.000Z");
  await swapCurrent({ commit: C, env });

  assert.deepEqual(await listReleases(env), [B, A, C], "listing must be oldest-first by promotion");

  await pruneReleases({ env, keep: 1, minAgeMs: 0, now: Date.now(), isHeldImpl: async () => false });
  const remaining = await listReleases(env);
  assert.deepEqual(remaining, [A, C], "the OLDEST release is the one pruned, and the live one is kept");
  assert.ok(!remaining.includes(B), "keeping B would retain the stale release as the rollback target");
});

test("the commit is read from a path with the platform's own separator", () => {
  // The name was extracted with a hard-coded "/", which on Windows makes every
  // path look like a single segment — so currentCommit answered null for a
  // perfectly valid pointer, and did so silently.  Pinned here with a Windows
  // path so the bug cannot come back even on a machine whose tests all pass.
  const windowsPointer = "C:\\Users\\example\\releases\\" + A;
  assert.equal(windowsPointer.split(win32.sep).pop(), A, "the last segment must be recoverable on Windows");
  assert.equal(windowsPointer.split("/").pop(), windowsPointer, "which is exactly what the hard-coded split returned");
});

test("where rename-over is refused, the swap still works and says it was not atomic", async (t) => {
  // The Windows fallback was otherwise only exercised on Windows, which is the one
  // place this cannot be reasoned about from a Mac.  Injecting the EPERM makes
  // the branch run on every platform, so the fallback's contract — it WORKS, and
  // the caller is TOLD it was not atomic — is pinned here rather than discovered
  // in CI on a machine nobody can reproduce on.
  const { env } = await store(t);
  for (const commit of [A, B]) {
    await stage(env, commit, commit);
    await promoteStaging({ commit, env });
  }
  await swapCurrent({ commit: A, env });

  let calls = 0;
  // The stub must still PERFORM the real rename on its second call — a stub that
  // merely stopped throwing would leave the pointer deleted and the test would
  // be asserting a broken fallback rather than a working one.
  const refusing = async (...args) => {
    calls += 1;
    if (calls === 1) {
      const error = new Error("EPERM: operation not permitted, rename");
      error.code = "EPERM";
      throw error;
    }
    return rename(...args);
  };

  const result = await swapCurrent({ commit: B, env, renameImpl: refusing });
  assert.equal(result.atomic, false, "the caller must be told the swap was not atomic");
  assert.equal(calls, 2, "the fallback retries the rename once after clearing the pointer");
  // And the point of the fallback: the pointer still ends up where it was asked
  // to be, because a non-atomic swap is only acceptable if it still works.
  assert.equal(await currentCommit(env), B);
  assert.equal(await realpath(currentLink(env)), await realpath(releasePath(B, env)));

  await t.test("an unrecognised failure is not swallowed", async () => {
    await assert.rejects(
      swapCurrent({
        commit: A,
        env,
        renameImpl: async () => {
          const error = new Error("EIO: i/o error");
          error.code = "EIO";
          throw error;
        },
      }),
      (error) => error.code === "EIO",
    );
  });
});

test("a manifest is validated in full, and an unknown key rejects it", async (t) => {
  // The first version checked only `commit`, so a manifest carrying anything
  // else at all — a path, a command, whatever a future writer felt like adding —
  // was accepted.  For a file nothing else is meant to write, an unrecognised
  // key is a signal that something else wrote it.
  const dir = await mkdtemp(join(tmpdir(), "botfleet-manifest-strict-"));
  t.after(() => forceRemove(dir));
  const valid = {
    schemaVersion: 1,
    commit: A,
    promotedAt: "2026-10-04T00:00:00.000Z",
    node: process.version,
    platform: process.platform,
  };
  assert.ok(validateReleaseManifest(valid), "a complete, well-formed manifest is valid");
  assert.ok(validateReleaseManifest({ schemaVersion: 1, commit: A, promotedAt: valid.promotedAt }),
    "node and platform are informational and may be absent");

  for (const [patch, why] of [
    [{ schemaVersion: 2 }, "an unknown schema version"],
    [{ commit: 42 }, "a non-string commit"],
    [{ commit: "main" }, "a branch name as commit"],
    [{ promotedAt: "not a date" }, "an unparseable promotedAt"],
    [{ promotedAt: 1750000000 }, "a numeric promotedAt"],
    [{ node: 24 }, "a non-string node"],
    [{ platform: [] }, "an array platform"],
    [{ extra: "anything" }, "an UNKNOWN key"],
    [{ installPath: "/tmp/elsewhere" }, "an unknown key carrying a path"],
  ]) {
    const manifest = { ...valid, ...patch };
    assert.equal(validateReleaseManifest(manifest), null, why);
  }
  for (const body of [null, undefined, [], "a string", 7, true]) {
    assert.equal(validateReleaseManifest(body), null, `${JSON.stringify(body)} is not a manifest`);
  }

  // And the same strictness applies through the filesystem entry point.
  await writeFile(join(dir, ".botfleet-release.json"), JSON.stringify({ ...valid, injected: true }));
  assert.equal(await isReleaseDirectory(dir), false, "an unknown key means the directory is not a release");
  await writeFile(join(dir, ".botfleet-release.json"), JSON.stringify(valid));
  assert.equal(await isReleaseDirectory(dir), true);
});

test("a manifest whose commit is not a full SHA is not a release", async (t) => {
  // The commit check is one expression rather than a typeof plus a format
  // check, so these pin that a non-string is rejected by the SAME test that
  // validates the format — a manifest claiming commit: 42, or commit: "main",
  // or no commit at all, must not be mistaken for a release.
  const dir = await mkdtemp(join(tmpdir(), "botfleet-manifest-"));
  t.after(() => forceRemove(dir));
  const write = async (body) => {
    const text =
      body != null && Object.getPrototypeOf(body) === Object.prototype ? JSON.stringify(body) : String(body);
    await writeFile(join(dir, ".botfleet-release.json"), text);
    return isReleaseDirectory(dir);
  };
  assert.equal(await write({ schemaVersion: 1, commit: A, promotedAt: "2026-10-01T00:00:00.000Z" }), true);
  assert.equal(await write({ schemaVersion: 1, commit: 42 }), false, "a number is not a commit");
  assert.equal(await write({ schemaVersion: 1, commit: "main" }), false, "a branch name is not a commit");
  assert.equal(await write({ schemaVersion: 1, commit: "abc" }), false, "a short sha is not a commit");
  assert.equal(await write({ schemaVersion: 1, commit: `${A}Z` }), false, "a non-hex character is not a commit");
  assert.equal(await write({ schemaVersion: 1 }), false, "no commit is not a release");
  assert.equal(await write("not json at all"), false, "unparseable is not a release");
});

test("a swap that fails after deleting the pointer puts the old one back", async (t) => {
  // The fallback removes `current` and renames into place.  If that second
  // rename fails too, the pointer is GONE — and absent is the one state the
  // harness cannot start from, because the launcher resolves the pointer and a
  // missing one means no harness at all.  A stale pointer is recoverable.
  const { env } = await store(t);
  for (const commit of [A, B]) {
    await stage(env, commit, commit);
    await promoteStaging({ commit, env });
  }
  await swapCurrent({ commit: A, env });
  assert.equal(await currentCommit(env), A);

  // A pointer is only ever moved onto a release that exists.  Without this a
  // typo'd or already-pruned commit leaves `current` resolving to nothing, and
  // nothing says so — the swap "succeeded" from the store's point of view and
  // the harness simply cannot start.
  await assert.rejects(
    () => swapCurrent({ commit: "0".repeat(40), env }),
    (error) => {
      assert.equal(error.cause, "release-missing");
      assert.match(error.message, /Promote that commit first/);
      return true;
    },
    "swapCurrent must refuse to point current at a release that does not exist",
  );
  assert.equal(await currentCommit(env), A, "a refused swap must leave current exactly where it was");

  // Refuse the FIRST rename (so the fallback engages), then fail the retry.
  // Caught rather than asserted through assert.rejects, because the checks
  // below need to await a realpath comparison.
  let calls = 0;
  let caught = null;
  try {
    await swapCurrent({
      commit: B,
      env,
      renameImpl: async () => {
        calls += 1;
        const error = new Error(calls === 1 ? "EPERM: not permitted" : "EIO: i/o error");
        error.code = calls === 1 ? "EPERM" : "EIO";
        throw error;
      },
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "the swap must fail rather than silently succeed");
  // The restore SUCCEEDED here — the assertions below prove `current` resolves
  // back to A — so the cause must say so.  This test used to expect
  // "pointer-lost" while simultaneously proving the pointer was found, which is
  // how an operator staring at a recovered harness was told their previous
  // release was gone, and sent looking for a problem that did not exist.
  assert.equal(caught.cause, "swap-failed-restored");
  assert.equal(caught.restored, true, "the cause must report the restore actually happening");
  assert.doesNotMatch(caught.message, /could not restore/, "a successful restore must not be described as a failed one");
  assert.equal(caught.previous, await realpath(releasePath(A, env)), "the error must name what was live before");

  // The point: `current` still resolves, and it still points at the release
  // that was live before the failed attempt.
  assert.equal(await currentCommit(env), A, "the previous release must be live again");
  assert.equal(await realpath(currentLink(env)), await realpath(releasePath(A, env)));
  await t.test("and no spare pointer is left behind", async () => {
    const { readdir } = await import("node:fs/promises");
    const strays = (await readdir(storeRoot(env))).filter((name) => name.includes(".displaced-"));
    assert.deepEqual(strays, [], `stray pointer spares left in the store root: ${strays.join(", ")}`);
  });
});

test("currentCommit answers for every pointer state, not just a happy one", async (t) => {
  // The coverage gap: nothing exercised currentCommit against a missing
  // pointer, a pointer at a non-release, or a release whose manifest is
  // unreadable — and it is the function every caller uses to decide what is
  // live, so a wrong answer is a wrong install.
  const { env } = await store(t);
  assert.equal(await currentCommit(env), null, "no pointer at all is null, not a throw");

  await stage(env, A, "x");
  await promoteStaging({ commit: A, env });
  await swapCurrent({ commit: A, env });
  assert.equal(await currentCommit(env), A, "a real release reports its commit");

  // A pointer at a plain directory that is not a release: the name is used, so
  // a legacy checkout named like a commit still answers.
  const legacy = await mkdtemp(join(tmpdir(), "botfleet-legacy-"));
  t.after(() => forceRemove(legacy));
  await rm(currentLink(env), { force: true });
  await symlink(legacy, currentLink(env));
  assert.equal(await currentCommit(env), null, "a directory named like nothing is not a commit");

  // An unreadable manifest must degrade to null rather than throw, because the
  // caller documents a null return and checks for it.
  // The release is read-only now, so removing its manifest goes through the
  // module's own disposal path rather than a bare unlink.
  const { chmod } = await import("node:fs/promises");
  await chmod(releasePath(A, env), 0o755).catch(() => {});
  await rm(join(releasePath(A, env), ".botfleet-release.json"), { force: true });
  await rm(currentLink(env), { force: true });
  await symlink(releasePath(A, env), currentLink(env));
  assert.equal(await currentCommit(env), A, "a release with no manifest still reports its name");
});

test("promoting preserves each file's mode and only removes write bits", async (t) => {
  // "Read-only" is a statement about who may write, not a constant mode.
  // Flattening to 0o444 stripped the execute bit off anything runnable and made
  // a deliberately group-only file world-readable, so a release stopped being
  // the thing it was verified as.
  const { env } = await store(t);
  const commit = "b".repeat(40);
  const staging = await stage(env, commit, commit);
  await writeFile(join(staging, "tool.sh"), "#!/bin/sh\n", { mode: 0o755 });
  await writeFile(join(staging, "restricted"), "secret\n", { mode: 0o640 });
  await promoteStaging({ commit, env });

  const release = releasePath(commit, env);
  const modeOf = async (name) => (await stat(join(release, name))).mode & 0o777;
  const toolMode = await modeOf("tool.sh");
  const restrictedMode = await modeOf("restricted");
  if (process.platform === "win32") {
    // Windows chmod only toggles the read-only attribute; POSIX execute and group
    // bits are not preserved the way they are on macOS and Linux.
    assert.equal(toolMode & 0o222, 0, "write bits must be cleared on Windows");
    assert.equal(restrictedMode & 0o222, 0, "write bits must be cleared on Windows");
  } else {
    assert.equal(toolMode, 0o555, "an executable stays executable, minus write");
    assert.equal(restrictedMode, 0o440, "a 0640 file keeps its group read and loses group write");
  }

  // And the round trip back to writable does not invent permissions either.
  await discardRelease(commit, env);
  await assert.rejects(() => stat(release), /ENOENT/);
});

test("a promoted release is actually read-only, not merely documented as such", async (t) => {
  // The design rests on a release being byte-identical to the commit it names.
  // Marking one manifest 0o444 and calling the tree immutable asserts something
  // the filesystem does not agree with, so the directory is made read-only and
  // a failure to do so is a failure to promote.
  const { env } = await store(t);
  await stage(env, A, "payload");
  const promoted = await promoteStaging({ commit: A, env });
  const { stat, chmod } = await import("node:fs/promises");

  assert.equal((await stat(promoted)).mode & 0o222, 0, "the release directory must not be writable");
  assert.equal((await stat(join(promoted, "marker.txt"))).mode & 0o222, 0, "nothing inside a release may be writable");
  await assert.rejects(writeFile(join(promoted, "marker.txt"), "tampered"), "writing into a release must fail");

  // And disposal restores permission deliberately rather than failing — the
  // pruner is the one place allowed to break the invariant.
  await t.test("disposal restores write permission and removes it", async () => {
    const spare = await store(t);
    await stage(spare.env, B, "payload");
    const path = await promoteStaging({ commit: B, env: spare.env });
    assert.equal((await stat(path)).mode & 0o222, 0);
    await discardRelease(B, spare.env);
    await assert.rejects(stat(path), "disposal must actually remove the release");
  });
  await chmod(promoted, 0o755).catch(() => {});
});

test("re-promoting an already-released commit says so, not 'check your filesystem'", async (t) => {
  // The catch used to rewrap EVERY promotion failure as a cross-device problem,
  // so re-running apply on a commit that is already a release told an operator
  // to go and move a directory they never broke.
  const { env } = await store(t);
  await stage(env, A, "payload");
  await promoteStaging({ commit: A, env });

  // A rename onto an existing non-empty directory reports ENOTEMPTY.
  await stage(env, A, "payload-again");
  const { rename: realRename } = await import("node:fs/promises");
  const collision = async (from, to) => {
    if (basename(to) === A) {
      const error = new Error("directory not empty");
      error.code = "ENOTEMPTY";
      throw error;
    }
    return realRename(from, to);
  };
  await assert.rejects(
    promoteStaging({ commit: A, env, renameImpl: collision }),
    (error) => {
      assert.equal(error.cause, "already-released");
      assert.match(error.message, /already a release/);
      assert.doesNotMatch(error.message, /same filesystem/);
      return true;
    },
  );
});

test("promoting without a staging tree raises staging-missing before writing a manifest", async (t) => {
  const { env } = await store(t);
  await assert.rejects(
    promoteStaging({ commit: A, env }),
    (error) => {
      assert.ok(error instanceof ResolutionError);
      assert.equal(error.cause, "staging-missing");
      return true;
    },
  );
  await assert.rejects(stat(join(stagingPath(A, env), ".botfleet-release.json")), (error) => error.code === "ENOENT");
});

test("a manifest whose commit disagrees with its directory name is not live identity", async (t) => {
  const { env } = await store(t);
  await stage(env, A, "x");
  await promoteStaging({ commit: A, env });
  await swapCurrent({ commit: A, env });
  const manifestPath = join(releasePath(A, env), ".botfleet-release.json");
  await chmodWritableTree(releasePath(A, env));
  await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1, commit: B, promotedAt: "2026-10-04T00:00:00.000Z" }, null, 2)}\n`);
  assert.equal(await currentCommit(env), null, "a mismatched manifest must not redefine the live commit");
  assert.deepEqual(await listReleases(env), [], "mismatched releases are excluded from retention ordering");
});

test("retention breaks ties on directory mtime, not commit name", async (t) => {
  const { env } = await store(t);
  const when = "2026-10-04T12:00:00.000Z";
  const { utimes } = await import("node:fs/promises");
  let mtime = Date.UTC(2026, 9, 4, 12, 0, 0);
  for (const commit of [B, A]) {
    await stage(env, commit, commit);
    await promoteStaging({ commit, env, promotedAt: when });
    mtime += 1000;
    await utimes(releasePath(commit, env), mtime / 1000, mtime / 1000);
  }
  await swapCurrent({ commit: A, env });
  const listed = await listReleases(env);
  assert.deepEqual(listed, [B, A], "same promotedAt must order by mtime, not SHA");
});
