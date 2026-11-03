import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import {
  dependencyScopeFingerprint,
  dependencyScopeStatus,
  gitBlobSha1,
  hashDependencyTree,
  listTreeObjects,
  repoHasCommit,
  verifyReleaseAgainstCommit,
} from "./release-provenance.mjs";

/**
 * A real repository and a real exported tree: the verifier's whole claim is
 * byte-equality with git's objects, so faking either side would test the fake.
 */
function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), "release-provenance-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  return { dir, git };
}

function commitTree(git, dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    if (content?.symlink) symlinkSync(content.symlink, full);
    else {
      writeFileSync(full, content?.content ?? content);
      if (content?.mode) chmodSync(full, content.mode);
    }
  }
  git("add", "-A");
  git("commit", "-q", "-m", "tree");
  return git("rev-parse", "HEAD");
}

function exportTree(git, dir, commit) {
  const out = join(dir, "export");
  mkdirSync(out, { recursive: true });
  execFileSync("git", ["-C", dir, "archive", "--format=tar", "--output", join(dir, "tree.tar"), commit]);
  execFileSync("tar", ["-xf", join(dir, "tree.tar"), "-C", out]);
  return out;
}

test("a byte-identical export verifies, with every blob checked", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, {
    "package.json": '{"name":"x","version":"1.0.0"}\n',
    "server/index.ts": "export const x = 1;\n",
    "docs/guide.md": "# guide\n",
  });
  const root = exportTree(git, dir, commit);
  const verdict = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.checked, 3);
});

test("a modified byte is drift and names the file", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "one\n", "b.txt": "two\n" });
  const root = exportTree(git, dir, commit);
  writeFileSync(join(root, "b.txt"), "TWO\n");
  const verdict = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "drift");
  assert.deepEqual(verdict.modified, ["b.txt"]);
  assert.match(verdict.detail, /b\.txt/);
});

test("a missing file and an extra file are both drift, named separately", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "one\n", "b.txt": "two\n" });
  const root = exportTree(git, dir, commit);
  rmSync(join(root, "a.txt"));
  writeFileSync(join(root, "c.txt"), "three\n");
  const verdict = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.missing, ["a.txt"]);
  assert.deepEqual(verdict.extra, ["c.txt"]);
});

// Real Finder .DS_Store files open with the Bud1 magic; the waiver proves
// the bytes are Finder metadata instead of trusting the name.
const DS_STORE_BYTES = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from("Bud1"), Buffer.alloc(64, 1)]);

test("node_modules, the store manifest and a genuine .DS_Store are legitimate non-tree content", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "one\n" });
  const root = exportTree(git, dir, commit);
  mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(root, ".botfleet-release.json"), '{"schemaVersion":1}\n');
  writeFileSync(join(root, ".DS_Store"), DS_STORE_BYTES);
  const verdict = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.checked, 1);
});

test("a nested .DS_Store with genuine Finder magic is waived at any depth", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "one\n" });
  const root = exportTree(git, dir, commit);
  mkdirSync(join(root, "server", "deep"), { recursive: true });
  writeFileSync(join(root, "server", "deep", ".DS_Store"), DS_STORE_BYTES);
  const verdict = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir });
  assert.equal(verdict.ok, true, "Finder writes metadata in whatever folder it touches");
});

test("bytes planted under the .DS_Store name are drift, never waived", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "one\n" });
  const root = exportTree(git, dir, commit);
  mkdirSync(join(root, "server"), { recursive: true });
  writeFileSync(join(root, "server", ".DS_Store"), "require('child_process').execSync('id')\n");
  const verdict = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir });
  assert.equal(verdict.ok, false, "a script named .DS_Store is not Finder metadata");
  assert.deepEqual(verdict.extra, ["server/.DS_Store"]);
});

test("an implausibly large .DS_Store is drift, magic or not", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "one\n" });
  const root = exportTree(git, dir, commit);
  writeFileSync(join(root, ".DS_Store"), Buffer.concat([DS_STORE_BYTES, Buffer.alloc(300 * 1024, 2)]));
  const verdict = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.extra, [".DS_Store"]);
});

test("a directory named .DS_Store is walked, and its contents are never waived", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "one\n" });
  const root = exportTree(git, dir, commit);
  mkdirSync(join(root, ".DS_Store"));
  writeFileSync(join(root, ".DS_Store", "payload"), DS_STORE_BYTES);
  const verdict = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir });
  assert.equal(verdict.ok, false, "Finder never makes a .DS_Store directory; nothing inside is waived");
  assert.deepEqual(verdict.extra, [".DS_Store/payload"]);
});

test("a symlink in the tree verifies by its target bytes, and a changed target is drift", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, {
    "target.txt": "real\n",
    "link.txt": { symlink: "target.txt" },
  });
  const root = exportTree(git, dir, commit);
  assert.equal(verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir }).ok, true);
  rmSync(join(root, "link.txt"));
  symlinkSync("other.txt", join(root, "link.txt"));
  const verdict = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.modified, ["link.txt"]);
});

test("a repository without the commit cannot verify, and that is not drift", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "one\n" });
  const other = makeRepo(t);
  const root = exportTree(git, dir, commit);
  const verdict = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: other.dir });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "commit-missing");
});

test("a non-repository cannot verify, and that is not drift either", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "one\n" });
  const root = exportTree(git, dir, commit);
  // A plain temp directory, not inside any repository: git walks UP from the
  // path it is given, so a subdirectory of the repo would resolve to the repo.
  const nowhere = mkdtempSync(join(tmpdir(), "release-provenance-norepo-"));
  t.after(() => rmSync(nowhere, { recursive: true, force: true }));
  const verdict = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: nowhere });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "repo-unavailable");
});

test("a garbage commit value is refused before any git call", (t) => {
  const { dir } = makeRepo(t);
  const verdict = verifyReleaseAgainstCommit({ releaseRoot: dir, commit: "../../etc", repo: dir });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "commit-missing");
});

test("gitBlobSha1 matches git's own object id for the same bytes", (t) => {
  const { dir, git } = makeRepo(t);
  writeFileSync(join(dir, "blob.txt"), "blob bytes ✓\n");
  const expected = git("hash-object", "blob.txt");
  assert.equal(gitBlobSha1(readFileSync(join(dir, "blob.txt"))), expected);
});

test("listTreeObjects reads every entry with its blob id", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "one\n", "dir/b.txt": "two\n" });
  const tree = listTreeObjects(dir, commit);
  assert.equal(tree.size, 2);
  assert.equal(tree.get("a.txt").sha, git("hash-object", join(dir, "a.txt")));
  assert.equal(tree.get("dir/b.txt").mode, "100644");
});

test("repoHasCommit answers for real and absent commits", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "one\n" });
  assert.equal(repoHasCommit(dir, commit), true);
  assert.equal(repoHasCommit(dir, "f".repeat(40)), false);
  assert.equal(repoHasCommit(dir, "not-a-commit"), false);
});

test("a tracked symlink replaced by a regular file with the same bytes is TYPE drift", (t) => {
  // The blob hash of a symlink IS its target text, so a byte-only verifier
  // accepts the substitution; the mode check is what refuses it.
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, {
    "target.txt": "real\n",
    "link.txt": { symlink: "target.txt" },
  });
  const root = exportTree(git, dir, commit);
  rmSync(join(root, "link.txt"));
  writeFileSync(join(root, "link.txt"), "target.txt");
  const verdict = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "drift");
  assert.ok(verdict.modified.some((entry) => entry.startsWith("link.txt")), "named as modified, not accepted");
});

test("a regular file replaced by a symlink to the same bytes is TYPE drift", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "payload\n", "b.txt": "payload\n" });
  const root = exportTree(git, dir, commit);
  rmSync(join(root, "b.txt"));
  symlinkSync("a.txt", join(root, "b.txt"));
  const verdict = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "drift");
  assert.ok(verdict.modified.some((entry) => entry.startsWith("b.txt")));
});

test("the executable bit is compared both ways", (t) => {
  const { dir, git } = makeRepo(t);
  writeFileSync(join(dir, "tool.sh"), "#!/bin/sh\n");
  chmodSync(join(dir, "tool.sh"), 0o755);
  const commit = commitTree(git, dir, {});
  const root = exportTree(git, dir, commit);
  assert.equal(verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir }).ok, true);
  chmodSync(join(root, "tool.sh"), 0o644);
  const lost = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir });
  assert.equal(lost.ok, false);
  assert.ok(lost.modified.some((entry) => entry.includes("executable")));
});

test("a present node_modules is UNVERIFIED without a trusted reference, never silently clean", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "one\n" });
  const root = exportTree(git, dir, commit);
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "node_modules", "injected.js"), "require('child_process')\n");
  const verdict = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir });
  assert.equal(verdict.ok, true, "source tree still verifies");
  assert.equal(verdict.dependencies, "unverified", "executable dependency tree is reported unknown");
});

test("dependencies verify against a trusted reference tree, and planted content is drift", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "one\n" });
  const root = exportTree(git, dir, commit);
  // The reference is a mirror TREE (a fresh install of the same commit), not
  // the node_modules directory itself.
  const reference = join(dir, "reference-tree");
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  symlinkSync("dep", join(root, "node_modules", "dep-link"));
  mkdirSync(join(reference, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(reference, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  symlinkSync("dep", join(reference, "node_modules", "dep-link"));
  const verified = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir, referenceDeps: reference });
  assert.equal(verified.ok, true);
  assert.equal(verified.dependencies, "verified");
  writeFileSync(join(root, "node_modules", "dep", "injected.js"), "// planted\n");
  const drift = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir, referenceDeps: reference });
  assert.equal(drift.ok, false);
  assert.equal(drift.reason, "drift");
  assert.equal(drift.driftScope, "deps");
});

// Reviewer reproduction 1: a NESTED node_modules (server/node_modules) is
// executable code node module resolution can load; it must be collected and
// reported, never silently excluded as "absent".
test("a nested node_modules is part of the dependency scope, never absent", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "one\n", "server/index.js": "// src\n" });
  const root = exportTree(git, dir, commit);
  mkdirSync(join(root, "server", "node_modules"), { recursive: true });
  writeFileSync(join(root, "server", "node_modules", "evil.js"), "require('child_process')\n");
  const verdict = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir });
  assert.equal(verdict.ok, true, "source tree still verifies");
  assert.equal(verdict.dependencies, "unverified", "nested dependency root is reported unknown, not absent");
  // And it is inside the scope fingerprint: changing it changes the fingerprint.
  const before = dependencyScopeFingerprint(root);
  writeFileSync(join(root, "server", "node_modules", "evil.js"), "// changed\n");
  assert.notEqual(dependencyScopeFingerprint(root), before);
  // A matching reference verifies the nested root too.
  const reference = join(dir, "reference-tree");
  mkdirSync(join(reference, "server", "node_modules"), { recursive: true });
  writeFileSync(join(reference, "server", "node_modules", "evil.js"), "// changed\n");
  const verified = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir, referenceDeps: reference });
  assert.equal(verified.dependencies, "verified");
});

// Reviewer reproduction 2: node_modules that is a symlink (broken or not) is
// not an install location; "absent" is reserved for ENOENT only.
test("a symlink or file named node_modules is drift, never absent", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "one\n" });
  const root = exportTree(git, dir, commit);
  symlinkSync(join(dir, "nowhere"), join(root, "node_modules"));
  const linked = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir });
  assert.equal(linked.ok, false);
  assert.equal(linked.reason, "drift");
  assert.equal(linked.driftScope, "deps");
  rmSync(join(root, "node_modules"));
  writeFileSync(join(root, "node_modules"), "not a directory\n");
  const filed = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir });
  assert.equal(filed.ok, false);
  assert.equal(filed.driftScope, "deps");
});

// Reviewer reproduction 3: a reference that IS the tree under test compares
// the tree against itself and proves nothing.
test("a reference inside the tree it would vouch for is refused as self-comparison", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "one\n" });
  const root = exportTree(git, dir, commit);
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  const selfRef = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir, referenceDeps: join(root, "node_modules") });
  assert.equal(selfRef.ok, false);
  assert.equal(selfRef.reason, "unverifiable");
  const rootRef = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir, referenceDeps: root });
  assert.equal(rootRef.ok, false);
  assert.equal(rootRef.reason, "unverifiable");
});


// Reviewer reproduction 3: a dependency-scope symlink whose target escapes
// the tree vouches for bytes nobody hashed (the fingerprint records target
// TEXT).  Confinement is checked before any comparison; the scope is drift.
test("a dependency link escaping the tree is named drift, never fingerprinted over", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "one\n" });
  const root = exportTree(git, dir, commit);
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  symlinkSync("/etc/passwd", join(root, "node_modules", "stolen"));
  const status = dependencyScopeStatus(root);
  assert.equal(status.linkProblems.length, 1);
  assert.match(status.linkProblems[0], /stolen -> \/etc\/passwd is absolute/);
  const reference = join(dir, "reference-tree");
  mkdirSync(join(reference, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(reference, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  const verdict = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir, referenceDeps: reference });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "drift");
  assert.equal(verdict.driftScope, "deps");
  assert.match(verdict.detail, /dependency links outside custody/);
});

test("a dependency link escaping via dot-dot and a dangling link are both custody problems", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "one\n" });
  const root = exportTree(git, dir, commit);
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  symlinkSync("../../../outside", join(root, "node_modules", "dep", "escape"));
  symlinkSync("missing-target", join(root, "node_modules", "dep", "dangling"));
  const problems = dependencyScopeStatus(root).linkProblems;
  assert.equal(problems.length, 2);
  assert.ok(problems.some((problem) => /escapes the tree root/.test(problem)), problems.join(" | "));
  assert.ok(problems.some((problem) => /does not exist/.test(problem)), problems.join(" | "));
});

test("a link resolving inside through a second link that reaches outside is resolved custody, not lexical shape", (t) => {
  // Reviewer probe: linkProblem(root, "loaded.js", "bridge/code.js") passed
  // lexically when bridge is itself a symlink out of the tree.  Only the
  // fully resolved target proves which bytes the link names.
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "one\n" });
  const root = exportTree(git, dir, commit);
  const outside = join(dir, "outside-bytes");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "code.js"), "require('child_process')\n");
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  symlinkSync(outside, join(root, "node_modules", "dep", "bridge"));
  const problems = dependencyScopeStatus(root).linkProblems;
  assert.equal(problems.length, 1, "the bridge link itself is caught as absolute");
  assert.match(problems[0], /bridge -> .* is absolute/);
  // A RELATIVE bridge to outside bytes is caught by resolution, not lexicon.
  rmSync(join(root, "node_modules", "dep", "bridge"));
  const rel = relative(join(root, "node_modules", "dep"), outside);
  symlinkSync(rel, join(root, "node_modules", "dep", "bridge"));
  const problems2 = dependencyScopeStatus(root).linkProblems;
  assert.equal(problems2.length, 1, "a relative bridge out of the tree is caught by resolution");
  assert.match(problems2[0], /escapes the tree root|resolves outside the tree's custody/);
});

test("a pnpm workspace link from node_modules into the release's own packages is confined and trusted", (t) => {
  // Reviewer probe: node_modules/workspace-package -> ../workspace-package
  // was REJECTED as 'escapes tree root'.  The target lives inside the
  // release; its bytes are the source scope's claim, and the link is fine.
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, {
    "a.txt": "one\n",
    "packages/workspace-package/index.js": "module.exports = 1;\n",
    "packages/workspace-package/package.json": '{"name":"workspace-package","version":"1.0.0"}\n',
  });
  const root = exportTree(git, dir, commit);
  mkdirSync(join(root, "node_modules"), { recursive: true });
  symlinkSync("../packages/workspace-package", join(root, "node_modules", "workspace-package"));
  const status = dependencyScopeStatus(root);
  assert.deepEqual(status.linkProblems, [], "workspace link inside the release is confined");
  const reference = join(dir, "reference-tree");
  mkdirSync(join(reference, "packages", "workspace-package"), { recursive: true });
  writeFileSync(join(reference, "packages", "workspace-package", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(reference, "packages", "workspace-package", "package.json"), '{"name":"workspace-package","version":"1.0.0"}\n');
  mkdirSync(join(reference, "node_modules"), { recursive: true });
  symlinkSync("../packages/workspace-package", join(reference, "node_modules", "workspace-package"));
  assert.equal(
    verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir, referenceDeps: reference }).dependencies,
    "verified",
    "a workspace-linked scope verifies against a matching reference",
  );
});

test("a pnpm-style relative link INTO the same tree stays trusted", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "one\n" });
  const good = exportTree(git, dir, commit);
  mkdirSync(join(good, "node_modules", ".pnpm", "dep@1", "node_modules", "dep"), { recursive: true });
  writeFileSync(join(good, "node_modules", ".pnpm", "dep@1", "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  symlinkSync(".pnpm/dep@1/node_modules/dep", join(good, "node_modules", "dep"));
  assert.deepEqual(dependencyScopeStatus(good).linkProblems, []);
});

// Reviewer reproduction 4: two trees differing only in an executable bit
// must not share a fingerprint — mode is identity for runnable code.
test("the executable bit is part of the dependency fingerprint", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "one\n" });
  const root = exportTree(git, dir, commit);
  mkdirSync(join(root, "node_modules", "dep", "bin"), { recursive: true });
  writeFileSync(join(root, "node_modules", "dep", "bin", "cli.js"), "#!/usr/bin/env node\n");
  const before = dependencyScopeFingerprint(root);
  chmodSync(join(root, "node_modules", "dep", "bin", "cli.js"), 0o755);
  const after = dependencyScopeFingerprint(root);
  assert.notEqual(after, before, "flipping the exec bit changes the custody fingerprint");
  const reference = join(dir, "reference-tree");
  mkdirSync(join(reference, "node_modules", "dep", "bin"), { recursive: true });
  writeFileSync(join(reference, "node_modules", "dep", "bin", "cli.js"), "#!/usr/bin/env node\n");
  const verdict = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir, referenceDeps: reference });
  assert.equal(verdict.ok, false, "same bytes, different exec bit: drift");
  assert.equal(verdict.driftScope, "deps");
  chmodSync(join(reference, "node_modules", "dep", "bin", "cli.js"), 0o755);
  assert.equal(
    verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir, referenceDeps: reference }).dependencies,
    "verified",
    "matching exec bits verify",
  );
});

// Reviewer reproduction 5: the SOURCE tree's links are confined too — an
// untracked symlink reaching out of the release is source drift, even when
// every git-tracked byte matches.
test("a source-tree symlink escaping the release is source drift", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "one\n" });
  const root = exportTree(git, dir, commit);
  symlinkSync("/etc", join(root, "etc-peek"));
  const verdict = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir });
  // The extra entry itself is already source drift; the link problem must be
  // reported as such once the tree otherwise matches.  Remove ambiguity:
  // check the dedicated link-problem branch with a TRACKED-shape tree.
  assert.equal(verdict.ok, false);
  assert.equal(verdict.driftScope, "source");
});

test("a tracked symlink in the commit is verified by confinement, and an escaped target is named", (t) => {
  const { dir, git } = makeRepo(t);
  mkdirSync(join(dir, "docs"), { recursive: true });
  const commit = commitTree(git, dir, {
    "a.txt": "one\n",
    "docs/guide.md": "# guide\n",
    "docs/latest": { symlink: "guide.md" },
  });
  const root = exportTree(git, dir, commit);
  const verdict = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir });
  assert.equal(verdict.ok, true, "a confined tracked symlink verifies");
  // A retargeted tracked symlink is ordinary source drift (its target text
  // no longer matches the committed blob), named as modified...
  rmSync(join(root, "docs", "latest"));
  symlinkSync("../outside-the-tree", join(root, "docs", "latest"));
  const retargeted = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir });
  assert.equal(retargeted.ok, false);
  assert.equal(retargeted.driftScope, "source");
  assert.match(retargeted.detail, /modified \(docs\/latest\)/);
});

test("a commit whose own tracked symlink escapes the tree is named a symlink problem, never verified", (t) => {
  // The byte-and-type comparison cannot catch this: the export reproduces
  // the committed target text exactly.  Confinement is the only check left.
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, {
    "a.txt": "one\n",
    "docs/guide.md": "# guide\n",
    "docs/escape": { symlink: "../../outside-the-tree" },
  });
  const root = exportTree(git, dir, commit);
  const verdict = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.driftScope, "source");
  assert.match(verdict.detail, /symlink problems: docs\/escape/);
});

// Reviewer reproduction 6: a trusted REFERENCE with escaping links proves
// nothing — the release becomes unverifiable, never verified-by-escape.
test("a reference with links outside its own custody makes the release unverifiable", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "one\n" });
  const root = exportTree(git, dir, commit);
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  const reference = join(dir, "reference-tree");
  mkdirSync(join(reference, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(reference, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  symlinkSync("/etc/passwd", join(reference, "node_modules", "stolen"));
  const verdict = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir, referenceDeps: reference });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "unverifiable");
  assert.match(verdict.detail, /trusted dependency reference has links outside its own custody/);
});

test("a trusted fingerprint verifies the dependency scope, and a wrong one is drift", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "one\n" });
  const root = exportTree(git, dir, commit);
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  const fingerprint = dependencyScopeFingerprint(root);
  const verified = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir, expectedDepsFingerprint: fingerprint });
  assert.equal(verified.ok, true);
  assert.equal(verified.dependencies, "verified");
  const wrong = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir, expectedDepsFingerprint: "0".repeat(64) });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, "drift");
  assert.equal(wrong.driftScope, "deps");
});

test("an unreadable dependency root is unverifiable, never absent", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "one\n" });
  const root = exportTree(git, dir, commit);
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  chmodSync(join(root, "node_modules"), 0o000);
  let verdict;
  try {
    verdict = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir, expectedDepsFingerprint: "0".repeat(64) });
  } finally {
    chmodSync(join(root, "node_modules"), 0o755);
  }
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "unverifiable");
});


// Reviewer gap 3: pnpm's own bookkeeping (.modules.yaml prune timestamps,
// .pnpm-workspace-state-v1.json absolute paths + validation times) differs
// between two CORRECT installs of the same lockfile; it is not package code
// and stays out of the custody fingerprint.
test("pnpm bookkeeping hashes semantically: volatile fields waived, stable install behavior covered", (t) => {
  const { dir, git } = makeRepo(t);
  const commit = commitTree(git, dir, { "a.txt": "one\n" });
  const makeTree = (label, { storeDir = "/same/store", linker = "isolated" } = {}) => {
    const root = join(dir, `tree-${label}-${linker}`);
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    writeFileSync(join(root, "node_modules", ".modules.yaml"),
      `hoistedDependencies: {}\nlayoutVersion: 5\nnodeLinker: ${linker}\npackageManager: pnpm@12.16.1\nprunedAt: Tue, 03 Nov 2026 10:3${label === "a" ? 2 : 3}:00 GMT\nstoreDir: ${storeDir}\nvirtualStoreDir: .pnpm\n`);
    writeFileSync(join(root, "node_modules", ".pnpm-workspace-state-v1.json"),
      JSON.stringify({ lastValidatedTimestamp: label === "a" ? 1 : 2, [`/abs/${label}`]: { ignoredBuilds: [] } }));
    return root;
  };
  const a = makeTree("a");
  const b = makeTree("b");
  assert.equal(dependencyScopeFingerprint(a), dependencyScopeFingerprint(b),
    "prune/validation timestamps and the absolute project-dir key never move the fingerprint");
  // Stable install behavior is NOT waived: a different store layout or
  // linker is a different accepted dependency tree.
  const c = makeTree("c", { storeDir: "/other/store" });
  assert.notEqual(dependencyScopeFingerprint(a), dependencyScopeFingerprint(c), "storeDir stays covered");
  const d = makeTree("d", { linker: "hoisted" });
  assert.notEqual(dependencyScopeFingerprint(a), dependencyScopeFingerprint(d), "nodeLinker stays covered");
  // A package file SHARING a bookkeeping name deeper in the tree is real
  // content and stays fully covered (no canonicalization).
  writeFileSync(join(a, "node_modules", "dep", ".modules.yaml"), "prunedAt: inside-a-package\n");
  assert.notEqual(dependencyScopeFingerprint(a), dependencyScopeFingerprint(b));
  // A SYMLINK named .modules.yaml is a link: hashed as link text and
  // confined, never treated as bookkeeping.
  const e = makeTree("e");
  rmSync(join(e, "node_modules", ".modules.yaml"));
  symlinkSync("/etc/passwd", join(e, "node_modules", ".modules.yaml"));
  const statusE = dependencyScopeStatus(e);
  assert.equal(statusE.linkProblems.length, 1);
  assert.match(statusE.linkProblems[0], /.modules.yaml -> \/etc\/passwd is absolute/);
});

// Git LFS: the committed blob for a tracked binary is a POINTER.  An export
// on a git-lfs host holds the real bytes; the pointer's own oid/size record
// proves them.
test("an LFS-tracked file verifies against its pointer's oid and size, and wrong bytes are drift", (t) => {
  const { dir, git } = makeRepo(t);
  const real = Buffer.from("GIF89a-real-bytes-for-the-test\n");
  const oid = createHash("sha256").update(real).digest("hex");
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${real.length}\n`;
  const commit = commitTree(git, dir, { "a.txt": "one\n", "img/face.gif": pointer });
  const root = exportTree(git, dir, commit);
  // The archive holds the pointer text (no smudge here); that verifies as-is.
  assert.equal(verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir }).ok, true);
  // A smudged export (real bytes where the pointer was) verifies too.
  writeFileSync(join(root, "img", "face.gif"), real);
  assert.equal(verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir }).ok, true);
  // Wrong bytes of the right KIND are still drift.
  writeFileSync(join(root, "img", "face.gif"), Buffer.concat([real, Buffer.from("tampered")]));
  const verdict = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.driftScope, "source");
});

test("LFS content acceptance never waives type or mode: exec bit both directions, symlink type", (t) => {
  // Reviewer regression block: tracked 100644 pointer + real bytes at 0755
  // verified ok.  Mode and type are identity independent of content.
  const { dir, git } = makeRepo(t);
  const real = Buffer.from("GIF89a-real-bytes-for-the-test\n");
  const oid = createHash("sha256").update(real).digest("hex");
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${real.length}\n`;
  const commit = commitTree(git, dir, { "a.txt": "one\n", "img/face.gif": pointer });
  const root = exportTree(git, dir, commit);
  writeFileSync(join(root, "img", "face.gif"), real);
  assert.equal(verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir }).ok, true, "same content, same mode: verifies");
  // Tracked 100644, real bytes 0755: drift.
  chmodSync(join(root, "img", "face.gif"), 0o755);
  const execSet = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir });
  assert.equal(execSet.ok, false, "content acceptance must not waive an added exec bit");
  assert.match(execSet.detail, /face\.gif/);
  chmodSync(join(root, "img", "face.gif"), 0o644);
  // Real bytes replaced by a SYMLINK to them: type drift even when the
  // target content matches the pointer.
  const realPath = join(dir, "real-face.gif");
  writeFileSync(realPath, real);
  rmSync(join(root, "img", "face.gif"));
  symlinkSync(realPath, join(root, "img", "face.gif"));
  const linkVerdict = verifyReleaseAgainstCommit({ releaseRoot: root, commit, repo: dir });
  assert.equal(linkVerdict.ok, false, "a symlink is never the regular blob, whatever its target holds");
  // And the reverse direction: tracked EXECUTABLE blob whose pointer matches
  // a non-executable file is drift too.
  const commit2 = commitTree(git, dir, { "a.txt": "one\n", "bin/tool": { content: pointer, mode: 0o755 } });
  const root2 = exportTree(git, dir, commit2);
  writeFileSync(join(root2, "bin", "tool"), real);
  chmodSync(join(root2, "bin", "tool"), 0o644);
  const execCleared = verifyReleaseAgainstCommit({ releaseRoot: root2, commit: commit2, repo: dir });
  assert.equal(execCleared.ok, false, "a removed exec bit is drift even with pointer-matching content");
});

test("hashDependencyTree fingerprints content, order-independently", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dep-fingerprint-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "a", "b"), { recursive: true });
  writeFileSync(join(dir, "a", "b", "x.js"), "x\n");
  writeFileSync(join(dir, "a", "y.js"), "y\n");
  const first = hashDependencyTree(dir);
  const second = hashDependencyTree(dir);
  assert.equal(first.fingerprint, second.fingerprint);
  writeFileSync(join(dir, "a", "z.js"), "z\n");
  assert.notEqual(hashDependencyTree(dir).fingerprint, first.fingerprint);
});
