import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { authorizedRuntime, buildCompatibility, hashStaticUi, readPackagedBuildIdentity, validBuildIdentity } from "./runtime-identity.mjs";
import { readSourceBuildIdentity } from "../scripts/source-build-identity.mjs";
import { harnessOwnerProof } from "./harness-ownership.mjs";
import { probeHarness, resolvePackagedServer } from "./server-boot-probe.mjs";

const build = { app: "botfleet", sourceCommit: "a".repeat(40), sourceDirty: false, apiVersion: 1, version: "1.0.30", uiHash: "e".repeat(64) };
const owner = { version: 1, pid: 4242, port: 8799, nonce: "b".repeat(64) };

test("packaged runtime identity loads without release-store scripts", async () => {
  const root = mkdtempSync(join(tmpdir(), "bf-packaged-identity-"));
  try {
    const packaged = join(root, "electron", "runtime-identity.mjs");
    mkdirSync(join(root, "electron"));
    copyFileSync(new URL("./runtime-identity.mjs", import.meta.url), packaged);
    const module = await import(pathToFileURL(packaged).href);
    assert.equal(typeof module.readPackagedBuildIdentity, "function");
    assert.equal(module.validBuildIdentity(build), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release build metadata is optional for old identities and preserves the shared timestamp verbatim", () => {
  assert.equal(validBuildIdentity(build), true);
  assert.equal(validBuildIdentity({ ...build, version: "0.1.0", build: "202610301230" }), true);
  assert.equal(validBuildIdentity({ ...build, build: "12.3.4" }), true);
  for (const invalid of [null, 202610301230, "unknown", "1e12", "12..3", "1.2.3.4"]) {
    assert.equal(validBuildIdentity({ ...build, build: invalid }), false);
  }
});

test("runtime diagnostics require the private nonce and never accept the public health proof", () => {
  assert.equal(authorizedRuntime(owner, `Bearer ${owner.nonce}`), true);
  for (const header of [undefined, "Bearer bad", `Bearer ${"c".repeat(64)}`, `Bearer ${harnessOwnerProof(owner, "d".repeat(64))}`]) {
    assert.equal(authorizedRuntime(owner, header), false);
  }
});

test("build/API compatibility uses bundled UI for changed or dirty source and rejects unknown API", () => {
  assert.equal(buildCompatibility(build, build), "matching");
  assert.equal(buildCompatibility(build, { ...build, sourceCommit: "c".repeat(40) }), "bundled-ui");
  assert.equal(buildCompatibility(build, { ...build, sourceDirty: true }), "bundled-ui");
  assert.equal(buildCompatibility(build, { ...build, uiHash: "f".repeat(64) }), "bundled-ui");
  assert.equal(buildCompatibility(build, { ...build, uiHash: null }), "bundled-ui");
  assert.equal(buildCompatibility(build, { ...build, apiVersion: 2 }), "incompatible");
  assert.equal(buildCompatibility(build, { ...build, sourceCommit: null }), "incompatible");
});

test("static identity changes when an asset changes even if index.html does not", () => {
  const root = mkdtempSync(join(tmpdir(), "bf-ui-identity-"));
  try {
    assert.equal(hashStaticUi(root), null);
    writeFileSync(join(root, "index.html"), '<script src="app.js"></script>');
    writeFileSync(join(root, "app.js"), "one");
    const before = hashStaticUi(root);
    writeFileSync(join(root, "app.js"), "two");
    assert.notEqual(hashStaticUi(root), before);
    assert.equal(hashStaticUi(root), hashStaticUi(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("source identity stays pinned after the checkout advances; packaged identity requires its own manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "bf-build-identity-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  try {
    git("init");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.0.30" }));
    git("add", "."); git("commit", "-m", "initial");
    const pinned = readSourceBuildIdentity(root);
    const stamped = readSourceBuildIdentity(root, { requireGit: true, version: "0.1.0", build: "202610301230" });
    assert.equal(stamped.version, "0.1.0");
    assert.equal(stamped.build, "202610301230");
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.0.31" }));
    assert.equal(readSourceBuildIdentity(root).sourceDirty, true);
    git("add", "."); git("commit", "-m", "next");
    assert.notEqual(readSourceBuildIdentity(root).sourceCommit, pinned.sourceCommit);
    assert.equal(pinned.version, "1.0.30");
    mkdirSync(join(root, "server"));
    assert.throws(() => readPackagedBuildIdentity(join(root, "server")));
    writeFileSync(join(root, "server", "build-identity.json"), JSON.stringify(pinned));
    // A build-less legacy manifest still resolves: null build stays the
    // legal unknown-order identity for old packages (BF-2588).
    assert.equal(pinned.build, undefined);
    assert.deepEqual(readPackagedBuildIdentity(join(root, "server")), pinned);
    writeFileSync(join(root, "server", "build-identity.json"), JSON.stringify(stamped));
    assert.deepEqual(readPackagedBuildIdentity(join(root, "server")), stamped);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A checkout the server starts from may have no usable git: a GUI launch with a
// thin PATH, a stripped container, a source archive.  The server still boots,
// and says its commit is unknown and its build dirty, which buildCompatibility
// never calls a match.  A build that stamps the identity into a shipped
// manifest asks for `requireGit` instead and refuses to invent a commit.
test("source identity falls back to an unknown, dirty commit when git cannot name HEAD, and requireGit refuses it", () => {
  const unknown = "0".repeat(40);
  const plain = mkdtempSync(join(tmpdir(), "bf-build-identity-nogit-"));
  const emptyRepo = mkdtempSync(join(tmpdir(), "bf-build-identity-empty-"));
  const bin = mkdtempSync(join(tmpdir(), "bf-build-identity-bin-"));
  const pathBefore = process.env.PATH;
  try {
    for (const root of [plain, emptyRepo]) writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.0.30" }));
    execFileSync("git", ["-C", emptyRepo, "init"], { stdio: "pipe" }); // a repo with no commit has no HEAD

    for (const root of [plain, emptyRepo]) {
      const identity = readSourceBuildIdentity(root);
      assert.equal(identity.sourceCommit, unknown);
      assert.equal(identity.sourceDirty, true, "an unknown commit must never read as a clean build");
      assert.equal(identity.version, "1.0.30");
      assert.throws(() => readSourceBuildIdentity(root, { requireGit: true }), /cannot read git identity for/);
    }

    // No git on PATH at all: the default still boots, requireGit still refuses.
    process.env.PATH = bin;
    assert.equal(readSourceBuildIdentity(plain).sourceCommit, unknown);
    assert.throws(() => readSourceBuildIdentity(plain, { requireGit: true }), /cannot read git identity for/);
    // The refusal names the checkout and says nothing about its contents.
    assert.throws(() => readSourceBuildIdentity(plain, { requireGit: true }), (error) => !String(error).includes("1.0.30"));
  } finally {
    process.env.PATH = pathBefore;
    for (const dir of [plain, emptyRepo, bin]) rmSync(dir, { recursive: true, force: true });
  }
});

test("requireGit returns the real commit and a clean flag from a committed checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "bf-build-identity-real-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe", encoding: "utf8" }).trim();
  try {
    git("init");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.0.30" }));
    git("add", ".");
    git("commit", "-m", "initial");
    const head = git("rev-parse", "HEAD");
    const identity = readSourceBuildIdentity(root, { requireGit: true });
    assert.equal(identity.sourceCommit, head);
    assert.match(identity.sourceCommit, /^[a-f0-9]{40}$/);
    assert.equal(identity.sourceDirty, false);
    assert.deepEqual(readSourceBuildIdentity(root), identity, "requireGit changes only what is refused, never what is reported");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function fakeFetch(runtime, { proof = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, "error");
    if (url.endsWith("/api/health")) return { ok: true, json: async () => ({
      app: "botfleet", pid: owner.pid, static: true,
      ownerProof: proof ? harnessOwnerProof(owner, options.headers["x-botfleet-owner-challenge"]) : null,
    }) };
    assert.equal(options.headers.authorization, `Bearer ${owner.nonce}`);
    assert.equal(options.signal, calls[0].options.signal, "both requests share the same deadline");
    return { ok: status === 200, json: async () => runtime };
  };
  return { fetchImpl, calls };
}
const runtime = (patch = {}) => ({ ...build, pid: owner.pid, dataOwner: { pid: owner.pid, port: owner.port }, ...patch });

test("authenticated matching static build attaches; changed compatible build serves bundled UI", async () => {
  for (const changed of [false, true]) {
    const remote = runtime(changed ? { sourceCommit: "c".repeat(40) } : {});
    const fake = fakeFetch(remote);
    const result = await probeHarness({ port: owner.port, owner, expectedBuild: build, fetchImpl: fake.fetchImpl });
    assert.equal(result.kind, "botfleet");
    assert.equal(result.static, !changed);
    assert.equal(result.sourceCommit, remote.sourceCommit);
  }
});

test("wrong health proof never receives the private nonce", async () => {
  const fake = fakeFetch(runtime(), { proof: false });
  assert.equal((await probeHarness({ port: owner.port, owner, expectedBuild: build, fetchImpl: fake.fetchImpl })).kind, "unavailable");
  assert.equal(fake.calls.length, 1);
});

test("legacy/malformed/wrong-owner/incompatible runtime never permits another harness spawn", async () => {
  for (const [data, status] of [[runtime(), 404], [null, 200], [runtime({ pid: 999 }), 200], [runtime({ apiVersion: 2 }), 200]]) {
    const fake = fakeFetch(data, { status });
    const result = await resolvePackagedServer({
      ports: [8799, 18799], owner: () => owner, attempts: 1, attachSettleMs: 0,
      probe: (port, currentOwner) => probeHarness({ port, owner: currentOwner, expectedBuild: build, fetchImpl: fake.fetchImpl }),
      spawn: async () => { assert.fail("incompatible live owner must never permit a second process"); },
    });
    assert.equal(result.mode, "failed");
  }
});

// Release-store mode: identity for a directory that has no .git but carries a
// strict release manifest bound to its directory name.  These tests use a real
// repository and a real `git archive` export, because the entire claim is
// byte-equality with git's objects.
function makeReleaseFixture(t, files = { "package.json": '{"name":"botfleet","version":"1.0.42"}\n', "server/index.ts": "export {};\n" }) {
  const dir = mkdtempSync(join(tmpdir(), "runtime-identity-release-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "tree");
  const commit = git("rev-parse", "HEAD");
  const release = join(dir, "releases", commit);
  mkdirSync(release, { recursive: true });
  execFileSync("git", ["-C", dir, "archive", "--format=tar", "--output", join(dir, "tree.tar"), commit]);
  execFileSync("tar", ["-xf", join(dir, "tree.tar"), "-C", release]);
  return { dir, git, commit, release };
}

function writeManifest(release, commit, extra = {}) {
  writeFileSync(join(release, ".botfleet-release.json"), JSON.stringify({
    schemaVersion: 1, commit, promotedAt: "2026-11-03T00:00:00.000Z", ...extra,
  }));
}

function withProvenanceRepo(repo, fn) {
  const previous = process.env.BOTFLEET_PROVENANCE_REPO;
  process.env.BOTFLEET_PROVENANCE_REPO = repo;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.BOTFLEET_PROVENANCE_REPO;
    else process.env.BOTFLEET_PROVENANCE_REPO = previous;
  }
}

test("a byte-verified release reports its commit clean, with the manifest's stamped version", (t) => {
  const { dir, commit, release } = makeReleaseFixture(t);
  writeManifest(release, commit, { version: "1.0.202611030400", build: "202611030400" });
  const identity = withProvenanceRepo(dir, () => readSourceBuildIdentity(release));
  assert.equal(identity.sourceCommit, commit);
  assert.equal(identity.sourceDirty, false);
  assert.equal(identity.version, "1.0.202611030400", "the deployer-stamped version wins over package.json");
  assert.equal(identity.build, "202611030400");
});

test("a release without a stamped version reports the exported package.json version", (t) => {
  const { dir, commit, release } = makeReleaseFixture(t);
  writeManifest(release, commit);
  const identity = withProvenanceRepo(dir, () => readSourceBuildIdentity(release));
  assert.equal(identity.version, "1.0.42");
  assert.equal(identity.sourceDirty, false);
});

test("a release with no stamped version and no readable package.json is a controlled invalid identity, never a crash", (t) => {
  const { dir, commit, release } = makeReleaseFixture(t, { "server/index.ts": "export {};\n" });
  writeManifest(release, commit);
  assert.throws(
    () => withProvenanceRepo(dir, () => readSourceBuildIdentity(release)),
    (error) => {
      assert.match(error.message, /identity is invalid/, "the same refusal every invalid identity takes");
      assert.doesNotMatch(error.message, /ENOENT/, "a missing package.json is not an I/O exception");
      return true;
    },
  );
});

test("a release whose bytes drifted from its commit refuses the commit entirely", (t) => {
  const { dir, commit, release } = makeReleaseFixture(t);
  writeManifest(release, commit);
  writeFileSync(join(release, "server/index.ts"), "export const injected = true;\n");
  const identity = withProvenanceRepo(dir, () => readSourceBuildIdentity(release));
  assert.equal(identity.sourceCommit, "0".repeat(40), "drift never attributes code to the commit it did not come from");
  assert.equal(identity.sourceDirty, true);
});

test("a release no repository can check reports the manifest's claim, still dirty", (t) => {
  const { commit, release } = makeReleaseFixture(t);
  writeManifest(release, commit);
  const nowhere = mkdtempSync(join(tmpdir(), "runtime-identity-norepo-"));
  t.after(() => rmSync(nowhere, { recursive: true, force: true }));
  const identity = withProvenanceRepo(nowhere, () => readSourceBuildIdentity(release));
  assert.equal(identity.sourceCommit, commit, "the claim is named for diagnostics");
  assert.equal(identity.sourceDirty, true, "a claim is never clean");
});

test("a manifest naming a different commit than its directory is not a release", (t) => {
  const { dir, release } = makeReleaseFixture(t);
  writeManifest(release, "f".repeat(40));
  const identity = withProvenanceRepo(dir, () => readSourceBuildIdentity(release));
  assert.equal(identity.sourceCommit, "0".repeat(40), "falls through to the git path, which finds no .git");
  assert.equal(identity.sourceDirty, true);
});

test("an invalid manifest is not release mode, even in a commit-named directory", (t) => {
  const { dir, commit, release } = makeReleaseFixture(t);
  writeFileSync(join(release, ".botfleet-release.json"), JSON.stringify({ schemaVersion: 1, commit, injected: true }));
  const identity = withProvenanceRepo(dir, () => readSourceBuildIdentity(release));
  assert.equal(identity.sourceCommit, "0".repeat(40));
  assert.equal(identity.sourceDirty, true);
});

test("requireGit admits a verified release and refuses an unverified claim", (t) => {
  const { dir, commit, release } = makeReleaseFixture(t);
  writeManifest(release, commit);
  const verified = withProvenanceRepo(dir, () => readSourceBuildIdentity(release, { requireGit: true }));
  assert.equal(verified.sourceCommit, commit);
  const nowhere = mkdtempSync(join(tmpdir(), "runtime-identity-requiregit-"));
  t.after(() => rmSync(nowhere, { recursive: true, force: true }));
  assert.throws(
    () => withProvenanceRepo(nowhere, () => readSourceBuildIdentity(release, { requireGit: true })),
    /cannot verify release identity/,
  );
});

test("a commit-named GIT worktree with a manifest is never release mode: dirty git answers", (t) => {
  // Release mode must not bypass git's own dirty detection: a checkout that
  // happens to be named by a commit and carry a manifest is a checkout.
  const { dir, commit } = makeReleaseFixture(t);
  // Use the repo itself as the "commit-named" root: rename is not possible, so
  // create a worktree whose directory name is the commit.
  const worktree = join(dir, "wt", commit);
  execFileSync("git", ["-C", dir, "worktree", "add", "--detach", worktree, commit]);
  writeManifest(worktree, commit);
  const clean = withProvenanceRepo(dir, () => readSourceBuildIdentity(worktree));
  assert.equal(clean.sourceCommit, commit);
  assert.equal(clean.sourceDirty, false, "a clean worktree reports its real commit via git");
  writeFileSync(join(worktree, "server/index.ts"), "// edited\n");
  const dirty = withProvenanceRepo(dir, () => readSourceBuildIdentity(worktree));
  assert.equal(dirty.sourceCommit, commit);
  assert.equal(dirty.sourceDirty, true, "git's dirty result stands — release mode did not bypass it");
});

test("a release with unverifiable dependencies names its commit but stays dirty", (t) => {
  const { dir, commit, release } = makeReleaseFixture(t);
  writeManifest(release, commit);
  mkdirSync(join(release, "node_modules"), { recursive: true });
  writeFileSync(join(release, "node_modules", "injected.js"), "// anything\n");
  const identity = withProvenanceRepo(dir, () => readSourceBuildIdentity(release));
  assert.equal(identity.sourceCommit, commit, "source provenance still reported");
  assert.equal(identity.sourceDirty, true, "executable deps unverified: unknown, never clean");
});

test("a release with dependencies verified against a trusted reference reports clean", (t) => {
  const { dir, commit, release } = makeReleaseFixture(t);
  writeManifest(release, commit);
  mkdirSync(join(release, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(release, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  // The reference is a mirror TREE (a fresh install of the same commit), not
  // the node_modules directory itself.
  const reference = mkdtempSync(join(tmpdir(), "runtime-identity-deps-"));
  t.after(() => rmSync(reference, { recursive: true, force: true }));
  mkdirSync(join(reference, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(reference, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  const previous = process.env.BOTFLEET_PROVENANCE_DEPS;
  process.env.BOTFLEET_PROVENANCE_DEPS = reference;
  try {
    const identity = withProvenanceRepo(dir, () => readSourceBuildIdentity(release));
    assert.equal(identity.sourceCommit, commit);
    assert.equal(identity.sourceDirty, false);
    writeFileSync(join(release, "node_modules", "dep", "planted.js"), "// planted\n");
    const drifted = withProvenanceRepo(dir, () => readSourceBuildIdentity(release));
    assert.equal(drifted.sourceCommit, commit, "deps drift does not deny the source commit");
    assert.equal(drifted.sourceDirty, true, "deps drift is not clean");
  } finally {
    if (previous === undefined) delete process.env.BOTFLEET_PROVENANCE_DEPS;
    else process.env.BOTFLEET_PROVENANCE_DEPS = previous;
  }
});
