import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const gate = join(dirname(fileURLToPath(import.meta.url)), "lint-pr-gate.mjs");
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.test",
};

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(cwd, file, text) {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `edit ${file}`);
}

function runGate(cwd, baseRef) {
  const childEnv = { ...env };
  delete childEnv.LINT_BASE_REF;
  if (baseRef) childEnv.LINT_BASE_REF = baseRef;
  return spawnSync("node", [gate], { cwd, encoding: "utf8", env: childEnv });
}

describe("lint-pr-gate base fetch", () => {
  let root;
  let origin;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "lint-gate-test-"));
    origin = join(root, "origin");
    git(root, "init", "-q", "-b", "main", origin);
    commit(origin, "README.md", "one\n");
    commit(origin, "README.md", "two\n");
    // Stacked PR: fix/base is ahead of main; fix/top is ahead of fix/base.
    git(origin, "checkout", "-q", "-b", "fix/base");
    commit(origin, "base.md", "base\n");
    commit(origin, "base.md", "base2\n");
    git(origin, "checkout", "-q", "-b", "fix/top");
    commit(origin, "top.md", "top\n");
    // main moves on after the stack was cut, like a real repo.
    git(origin, "checkout", "-q", "main");
    commit(origin, "README.md", "three\n");
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  test("stacked PR base resolves a merge-base from a shallow checkout", () => {
    const clone = join(root, "shallow-stacked");
    git(root, "clone", "-q", "--depth=1", "--branch", "fix/top", `file://${origin}`, clone);
    assert.equal(git(clone, "rev-parse", "--is-shallow-repository"), "true");
    const r = runGate(clone, "origin/fix/base");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no lintable files changed/);
  });

  test("the base fetch leaves full history and a usable merge-base", () => {
    const clone = join(root, "shallow-history");
    git(root, "clone", "-q", "--depth=1", "--branch", "fix/top", `file://${origin}`, clone);
    const r = runGate(clone, "origin/fix/base");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(clone, "rev-parse", "--is-shallow-repository"), "false");
    assert.equal(
      git(clone, "merge-base", "origin/fix/base", "HEAD"),
      git(origin, "rev-parse", "fix/base"),
    );
  });

  test("full-depth checkout with the stacked base also passes", () => {
    const clone = join(root, "full-stacked");
    git(root, "clone", "-q", "--branch", "fix/top", `file://${origin}`, clone);
    const r = runGate(clone, "origin/fix/base");
    assert.equal(r.status, 0, r.stderr);
  });

  test("defaults to origin/main when no base ref is given", () => {
    const clone = join(root, "default-main");
    git(root, "clone", "-q", "--branch", "fix/base", `file://${origin}`, clone);
    const r = runGate(clone, undefined);
    assert.equal(r.status, 0, r.stderr);
  });

  test("a missing base branch still fails loudly", () => {
    const clone = join(root, "missing-base");
    git(root, "clone", "-q", "--branch", "fix/top", `file://${origin}`, clone);
    const r = runGate(clone, "origin/does-not-exist");
    assert.notEqual(r.status, 0);
  });
});
