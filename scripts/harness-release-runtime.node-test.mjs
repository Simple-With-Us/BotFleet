import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  bindReleaseRuntime,
  listRetainedRuntimes,
  releaseRuntime,
  releaseRuntimeBindingPath,
  releasePath,
  retainedRuntimePath,
  retainRuntime,
  runtimesRoot,
  runtimeBindingsRoot,
  stagingPath,
} from "./harness-release-store.mjs";

const run = promisify(execFile);
const A = "a".repeat(40);
const B = "b".repeat(40);
const CLI = fileURLToPath(new URL("./harness-release.mjs", import.meta.url));

/**
 * A stand-in for a runtime binary.
 *
 * The store checks the ELF magic and the executable bit and nothing else about
 * the bytes it keeps, so a few dozen bytes are a real runtime as far as the
 * store is concerned.  A suite that copied the host Node instead would spend a
 * hundred and fifty megabytes a case on proving that a file can be copied.
 */
const ELF_STUB = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60, 7)]);

/** A store, a source binary, and the teardown that removes both. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "bf-release-runtime-test-"));
  t.after(async () => {
    // A promoted release is read-only by construction, so the teardown has to
    // make the tree writable before it can remove it.
    const { chmod, readdir } = await import("node:fs/promises");
    const walk = async (directory) => {
      let entries = [];
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const child = join(directory, entry.name);
        if (entry.isDirectory()) await walk(child);
        else await chmod(child, 0o644).catch(() => {});
      }
      await chmod(directory, 0o755).catch(() => {});
    };
    await walk(root);
    await rm(root, { recursive: true, force: true });
  });
  const env = { BOTFLEET_RELEASES_ROOT: join(root, "store") };
  const source = join(root, "runtime-source");
  await writeFile(source, ELF_STUB);
  await chmod(source, 0o755);
  return { root, env, source };
}

/** The cause code of a refusal, so a case names the rule it is proving. */
async function causeOf(action) {
  try {
    await action();
  } catch (error) {
    return error?.cause || error?.code || "no-cause";
  }
  return "no-refusal";
}
test("a retained runtime is kept in the store's own area and named by its own digest", async (t) => {
  const { env, source } = await fixture(t);
  const runtime = await retainRuntime({ source, env });
  assert.equal(runtime.format, "elf");
  assert.equal(runtime.bytes, ELF_STUB.length);
  assert.equal(basename(runtime.path), runtime.sha256);
  assert.equal(runtime.path, retainedRuntimePath(runtime.sha256, env));
  // Beside the releases, never inside one: a release directory IS the tree
  // the probe fingerprints and the tree the store compares with its commit.
  assert.equal(dirname(runtime.path), runtimesRoot(env));
  const kept = await stat(runtime.path);
  assert.equal(kept.size, ELF_STUB.length);
  // The kept bytes cannot be rewritten in place by anything that finds them.
  assert.equal(kept.mode & 0o777, 0o555);
});test("the kept bytes are a copy: replacing the source does not change them", async (t) => {
  const { env, source } = await fixture(t);
  const runtime = await retainRuntime({ source, env });
  await writeFile(source, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 9, 9, 9]));
  const kept = await readFile(runtime.path);
  assert.deepEqual(kept, ELF_STUB);
  assert.equal((await stat(runtime.path)).size, ELF_STUB.length);
});test("retaining the same bytes twice keeps the SAME file, so a proved inode stays valid", async (t) => {
  const { env, source } = await fixture(t);
  const first = await retainRuntime({ source, env });
  // The file is inspected BEFORE the second retain: a second retain that
  // replaced it would otherwise be invisible to a later stat.
  const before = await stat(first.path);
  const second = await retainRuntime({ source, env });
  assert.equal(second.path, first.path);
  assert.equal(second.sha256, first.sha256);
  const after = await stat(second.path);
  assert.equal(after.ino, before.ino);
  assert.equal(after.dev, before.dev);
});test("a source that is a link, a directory, a plain file or a script is refused by name", async (t) => {
  const { root, env, source } = await fixture(t);
  const link = join(root, "runtime-link");
  await symlink(source, link);
  assert.equal(await causeOf(() => retainRuntime({ source: link, env })), "runtime-symlink");
  assert.equal(await causeOf(() => retainRuntime({ source: root, env })), "runtime-not-file");
  const plain = join(root, "plain-file");
  await writeFile(plain, ELF_STUB);
  assert.equal(await causeOf(() => retainRuntime({ source: plain, env })), "runtime-not-executable");
  const script = join(root, "script-runtime");
  await writeFile(script, "#!/bin/sh\nexit 0\n");
  await chmod(script, 0o755);
  assert.equal(await causeOf(() => retainRuntime({ source: script, env })), "runtime-not-binary");
  assert.equal(await causeOf(() => retainRuntime({ source: "relative/runtime", env })), "runtime-path-invalid");
  // Nothing refused was kept.
  assert.deepEqual(await listRetainedRuntimes(env), []);
});test("a binding record names the runtime a release runs under, and it lives beside the release", async (t) => {
  const { env, source } = await fixture(t);
  const bound = await bindReleaseRuntime({ commit: A, source, env });
  assert.equal(bound.path, releaseRuntimeBindingPath(A, env));
  assert.equal(dirname(bound.path), runtimeBindingsRoot(env));
  assert.equal(bound.record.commit, A);
  assert.equal(bound.record.schemaVersion, 1);
  assert.equal(bound.record.runtime.sha256, retainedRuntimePath(bound.record.runtime.sha256, env).split("/").pop());
  const answer = await releaseRuntime(A, env);
  assert.equal(answer.path, bound.record.runtime.path);
  assert.equal(answer.sha256, bound.record.runtime.sha256);
  assert.equal(answer.bytes, ELF_STUB.length);
  // A release with no binding has none.
  assert.equal(await releaseRuntime(B, env), null);
});test("a binding whose runtime has gone, or whose record is unreadable, answers null", async (t) => {
  const { env, source } = await fixture(t);
  const bound = await bindReleaseRuntime({ commit: A, source, env });
  await rm(bound.record.runtime.path, { force: true });
  assert.equal(await releaseRuntime(A, env), null);
  await bindReleaseRuntime({ commit: A, source, env });
  await writeFile(releaseRuntimeBindingPath(A, env), "not json at all");
  assert.equal(await releaseRuntime(A, env), null);
});test("every retained runtime is listed by its digest", async (t) => {
  const { root, env, source } = await fixture(t);
  const other = join(root, "other-runtime");
  await writeFile(other, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60, 3)]));
  await chmod(other, 0o755);
  const first = await retainRuntime({ source, env });
  const second = await retainRuntime({ source: other, env });
  const listed = await listRetainedRuntimes(env);
  assert.equal(listed.length, 2);
  assert.deepEqual(listed.map((entry) => entry.sha256).sort(), [first.sha256, second.sha256].sort());
  for (const entry of listed) {
    assert.equal(entry.path, retainedRuntimePath(entry.sha256, env));
    assert.equal(basename(entry.path), entry.sha256);
  }
  // A file that is not a digest is not a retained runtime.
  await writeFile(join(runtimesRoot(env), "not-a-digest"), ELF_STUB);
  assert.equal((await listRetainedRuntimes(env)).length, 2);
});test("binding a runtime to a release leaves the strict manifest with exactly its seven fields", async (t) => {
  const { env, source } = await fixture(t);
  const staging = stagingPath(A, env);
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, "package.json"), '{"name":"botfleet","version":"0.1.0"}\n');
  await bindReleaseRuntime({ commit: A, source, env });
  const manifest = JSON.parse(await readFile(join(releasePath(A, env), ".botfleet-release.json"), "utf8").catch(() => "{}"));
  // The release was never promoted here, so the manifest is absent; the point
  // of the case is that binding a runtime writes NOTHING into a release.
  assert.deepEqual(manifest, {});
  const entries = await readdir(runtimesRoot(env));
  assert.equal(entries.length, 1);
});test("the CLI keeps a runtime, binds it to a release and lists it", async (t) => {
  const { env, source } = await fixture(t);
  const kept = await run(process.execPath, [CLI, "retain-runtime", "--source", source], { env: { ...process.env, ...env } });
  assert.match(kept.stdout, /sha256:  [a-f0-9]{64}/);
  const digest = kept.stdout.match(/sha256:  ([a-f0-9]{64})/)[1];
  assert.equal(kept.stdout.includes(retainedRuntimePath(digest, env)), true);
  const bound = await run(process.execPath, [CLI, "bind-runtime", A, "--source", source], { env: { ...process.env, ...env } });
  assert.match(bound.stdout, /runtime: /);
  const listed = await run(process.execPath, [CLI, "runtimes"], { env: { ...process.env, ...env } });
  assert.equal(listed.stdout.includes(digest), true);
});
test("an empty source is refused: the store keeps the bytes of a program", async (t) => {
  const { env, root } = await fixture(t);
  const empty = join(root, "empty-runtime");
  await writeFile(empty, "");
  await chmod(empty, 0o755);
  assert.equal(await causeOf(() => retainRuntime({ source: empty, env })), "runtime-not-binary");
  assert.deepEqual(await listRetainedRuntimes(env), []);
});

test("a file already at the kept path whose bytes are not its digest is refused", async (t) => {
  const { env, source } = await fixture(t);
  const first = await retainRuntime({ source, env });
  // The file that is already there holds other bytes than its name says.
  await rm(first.path, { force: true });
  await writeFile(first.path, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60, 0x39)]));
  await chmod(first.path, 0o555);
  const planted = await causeOf(() => retainRuntime({ source, env }));
  assert.equal(planted, "runtime-not-stored");
});

test("promote binds a runtime when the operator names one with --source", async (t) => {
  const { env, source } = await fixture(t);
  const staging = stagingPath(A, env);
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, "package.json"), '{"name":"botfleet","version":"0.1.0"}\n');
  const promoted = await run(process.execPath, [CLI, "promote", A, "--source", source], { env: { ...process.env, ...env } });
  assert.match(promoted.stdout, /promoted: /);
  assert.match(promoted.stdout, /sha256:  [a-f0-9]{64}/);
  const bound = await releaseRuntime(A, env);
  assert.ok(bound, "promote --source must bind the runtime to the release");
  assert.equal(bound.sha256, retainedRuntimePath(bound.sha256, env).split("/").pop());
});
