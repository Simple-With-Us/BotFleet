import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts/ci-scope-diff.sh");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Scope Test",
  GIT_AUTHOR_EMAIL: "scope@test.invalid",
  GIT_COMMITTER_NAME: "Scope Test",
  GIT_COMMITTER_EMAIL: "scope@test.invalid",
};

/** Build a repository with a stale base and a pull request that touches one file. */
function buildFixture() {
  const dir = mkdtempSync(join(tmpdir(), "ci-scope-"));
  const git = (...args) =>
    spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
  const write = (rel, body) => {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  };

  assert.equal(git("init", "-b", "main").status, 0);

  // The base commit:  the base branch tip at the last synchronisation.
  write("docs/base.md", "base\n");
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD").stdout.trim();

  // Main moves on,  and the newer commits touch iOS and server paths.
  write("ios/App.swift", "ios\n");
  write("server/index.ts", "server\n");
  git("add", ".");
  git("commit", "-m", "main moves on");
  const mainTip = git("rev-parse", "HEAD").stdout.trim();

  // The pull request branches off the base and touches one documentation file.
  git("checkout", "-b", "feature", base);
  write("docs/decision.md", "decision\n");
  git("add", ".");
  git("commit", "-m", "pull request");
  const head = git("rev-parse", "HEAD").stdout.trim();

  // The merge commit CI checks out,  built on the newer main tip.
  git("checkout", "main");
  git("merge", "--no-ff", "-m", "merge", "feature");
  const merge = git("rev-parse", "HEAD").stdout.trim();

  return { dir, base, head, mainTip, merge, git };
}

function scope(repo, base, head) {
  const result = spawnSync("bash", [SCRIPT, base, head], {
    cwd: repo.dir,
    encoding: "utf8",
    env: GIT_ENV,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    paths: result.stdout.split("\0").filter(Boolean),
  };
}

function classify(paths) {
  const result = spawnSync(process.execPath, [join(ROOT, "scripts/ci-change-scope.mjs")], {
    cwd: ROOT,
    input: Buffer.from(paths.join("\0")),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return Object.fromEntries(
    result.stdout.trim().split("\n").map((line) => line.split("=")),
  );
}

test("the scope is the pull request's own changes,  not the base branch's newer commits", () => {
  const repo = buildFixture();
  try {
    const scoped = scope(repo, repo.base, repo.head);
    assert.equal(scoped.status, 0, scoped.stderr);
    assert.deepEqual(scoped.paths, ["docs/decision.md"]);

    // The classification the workflow now sees:  a documentation-only change.
    assert.equal(classify(scoped.paths).docs_only, "true");
    assert.equal(classify(scoped.paths).ios_changed, "false");
    assert.equal(classify(scoped.paths).changed_count, "1");
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("the old base-to-merge-commit diff folded main's newer commits into the scope", () => {
  const repo = buildFixture();
  try {
    // What the workflow used to compute:  the stored base SHA to the merge
    // commit.  The merge commit's first parent is newer than the stored base
    // SHA,  so main's commits came with it.
    const old = spawnSync(
      "git",
      ["-C", repo.dir, "diff", "--no-renames", "--name-only", "-z", repo.base, repo.merge],
      { encoding: "utf8", env: GIT_ENV },
    );
    const oldPaths = old.stdout.split("\0").filter(Boolean);
    assert.ok(oldPaths.includes("ios/App.swift"), oldPaths.join(","));
    assert.ok(oldPaths.includes("server/index.ts"), oldPaths.join(","));

    // That is what made a one-file documentation change look like an iOS
    // change,  and it kept the macOS and xcode-27 runners alive.
    const classified = classify(oldPaths);
    assert.equal(classified.docs_only, "false");
    assert.equal(classified.ios_changed, "true");

    // The new scope does not carry main's commits.
    const scoped = scope(repo, repo.base, repo.head);
    assert.equal(scoped.paths.includes("ios/App.swift"), false);
    assert.equal(scoped.paths.includes("server/index.ts"), false);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a push still reports the commits the push carried", () => {
  const repo = buildFixture();
  try {
    // A push names its own two ends:  the commit before and the commit after.
    const scoped = scope(repo, repo.base, repo.mainTip);
    assert.equal(scoped.status, 0, scoped.stderr);
    assert.deepEqual(scoped.paths.sort(), ["ios/App.swift", "server/index.ts"]);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("the scope refuses to guess when it cannot establish one", () => {
  const repo = buildFixture();
  try {
    const missing = "0".repeat(40);
    for (const [base, head] of [
      ["not-a-sha", repo.head],
      [repo.base, "not-a-sha"],
      [missing, repo.head],
      [repo.base, missing],
      [missing, missing],
    ]) {
      const scoped = scope(repo, base, head);
      assert.notEqual(scoped.status, 0, `${base} ${head}`);
      assert.equal(scoped.stdout, "", `${base} ${head}`);
    }

    // A well-formed commit that is not in this checkout is refused too.
    const scoped = scope(repo, "1".repeat(40), repo.head);
    assert.notEqual(scoped.status, 0);
    assert.equal(scoped.stdout, "");
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});
