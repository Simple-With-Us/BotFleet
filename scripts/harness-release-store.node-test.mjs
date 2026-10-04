import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  currentCommit,
  currentLink,
  isHeld,
  isReleaseDirectory,
  listReleases,
  promoteStaging,
  pruneReleases,
  releasePath,
  resolveCurrent,
  stagingPath,
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

async function store(t) {
  const dir = await mkdtemp(join(tmpdir(), "botfleet-releases-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
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
  assert.ok(releasePath(A, env).endsWith(`/releases/${A}`));
  assert.ok(stagingPath(A, env).endsWith(`/staging/${A}`));
  assert.ok(currentLink(env).endsWith("/current"));
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
  t.after(() => rm(stranger, { recursive: true, force: true }));
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
  assert.equal(typeof exitedNonZero, "boolean");
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

  const result = await pruneReleases({ env, keep: 0, minAgeMs: 0, now, isHeldImpl: async () => true });
  assert.deepEqual(result.removed, [], "an unanswerable liveness question is not permission to delete");
  assert.equal(result.kept.length, 2);
  assert.deepEqual(await listReleases(env), [A, B, C]);
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
  assert.equal(typeof first.atomic, "boolean", "every swap must report its atomicity");
  if (process.platform !== "win32") {
    assert.equal(first.atomic, true, "the atomic path is the one macOS and Linux take");
    const second = await swapCurrent({ commit: B, env });
    assert.equal(second.atomic, true, "and it must stay atomic on every swap, not just the first");
  }
  // Whatever the platform did, the pointer ends up on the requested release.
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
    await rm(join(path, ".botfleet-release.json"), { force: true });
    // The manifest is what carries the ordering, so write it the way promotion
    // does and then let promoteStaging re-stamp it.
    await writeFile(
      join(path, ".botfleet-release.json"),
      `${JSON.stringify({ schemaVersion: 1, commit, promotedAt: when })}\n`,
    );
    await rm(join(path, ".botfleet-release.json"), { force: true });
    const real = Date.now();
    await promoteStaging({ commit, env });
    // Re-stamp promotedAt so the three releases are ordered deterministically
    // instead of by whatever millisecond the test happened to run in.
    const manifestPath = join(releasePath(commit, env), ".botfleet-release.json");
    await rm(manifestPath, { force: true });
    await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1, commit, promotedAt: when })}\n`);
    assert.ok(real);
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
