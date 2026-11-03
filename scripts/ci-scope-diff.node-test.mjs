import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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

test("scope classification needs commit and tree history without historical file blobs", () => {
  const repo = buildFixture();
  try {
    const objects = repo.git("rev-list", "--objects", "--all").stdout.trim().split("\n");
    let removed = 0;
    for (const row of objects) {
      const oid = row.split(" ")[0];
      if (repo.git("cat-file", "-t", oid).stdout.trim() !== "blob") continue;
      rmSync(join(repo.dir, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
      removed += 1;
    }
    assert.ok(removed > 0);
    const scoped = scope(repo, repo.base, repo.head);
    assert.equal(scoped.status, 0, scoped.stderr);
    assert.deepEqual(scoped.paths, ["docs/decision.md"]);
    assert.equal(classify(scoped.paths).ios_changed, "false");
    assert.equal(classify(scoped.paths).docs_only, "true");
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a filtered full-history checkout lazily fetches the historical effort ledger for its guard", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-filtered-history-"));
  const home = join(dir, "home");
  const seed = join(dir, "seed");
  const remote = join(dir, "remote.git");
  const partial = join(dir, "partial");
  mkdirSync(home);

  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "History Fixture",
    GIT_AUTHOR_EMAIL: "history-fixture@example.invalid",
    GIT_COMMITTER_NAME: "History Fixture",
    GIT_COMMITTER_EMAIL: "history-fixture@example.invalid",
    CI: "true",
  };
  const run = (command, args, cwd, extraEnv = {}) => {
    const result = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      env: { ...env, ...extraEnv },
    });
    assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stderr}`);
    return result.stdout.trim();
  };
  const git = (cwd, ...args) => run("git", ["-C", cwd, ...args], dir);
  const write = (root, rel, body) => {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  };

  try {
    run("git", ["init", "-b", "main", seed], dir);
    git(seed, "config", "user.name", "History Fixture");
    git(seed, "config", "user.email", "history-fixture@example.invalid");
    mkdirSync(join(seed, "scripts"));
    cpSync(join(ROOT, "scripts/effort-log-integrity.node-test.mjs"), join(seed, "scripts/effort-log-integrity.node-test.mjs"));
    cpSync(join(ROOT, "scripts/effort-log-integrity-lib.mjs"), join(seed, "scripts/effort-log-integrity-lib.mjs"));

    const seats = ["AG", "CLAUDE", "CODEX", "GROK", "MINIMAX"];
    const ledger = seats.flatMap((seat) =>
      Array.from({ length: 100 }, (_, index) => `- **2026-11-03 - ${seat} - fixture ${index}**\n`),
    ).join("");
    write(seed, "docs/EFFORT-LOG.md", ledger);
    git(seed, "add", ".");
    git(seed, "commit", "-m", "fixture base");
    const base = git(seed, "rev-parse", "HEAD");
    const oldBlob = git(seed, "rev-parse", "HEAD:docs/EFFORT-LOG.md");

    git(seed, "checkout", "-b", "fixture-head");
    write(seed, "docs/EFFORT-LOG.md", `${ledger}- **2026-11-03 - CODEX - added fixture**\n`);
    git(seed, "commit", "-am", "fixture head");
    run("git", ["clone", "--bare", seed, remote], dir);
    git(remote, "config", "uploadpack.allowFilter", "true");
    run("git", ["clone", "--filter=blob:none", "--no-checkout", pathToFileURL(remote).href, partial], dir);
    git(partial, "checkout", "fixture-head");

    const noLazyFetch = { GIT_NO_LAZY_FETCH: "1" };
    const missingBlob = spawnSync("git", ["-C", partial, "cat-file", "-e", oldBlob], {
      encoding: "utf8",
      env: { ...env, ...noLazyFetch },
    });
    assert.notEqual(missingBlob.status, 0, "historical ledger blob starts absent");
    assert.equal(git(partial, "merge-base", "origin/main", "HEAD"), base);
    assert.equal(git(partial, "rev-list", "--count", "HEAD"), "2");

    const guard = spawnSync(process.execPath, ["--test", "scripts/effort-log-integrity.node-test.mjs"], {
      cwd: partial,
      encoding: "utf8",
      env,
    });
    assert.equal(guard.status, 0, guard.stderr || guard.stdout);
    assert.match(guard.stdout, /ℹ tests 6\nℹ suites 0\nℹ pass 6\nℹ fail 0/);

    const fetchedBlob = spawnSync("git", ["-C", partial, "cat-file", "-e", oldBlob], {
      encoding: "utf8",
      env: { ...env, ...noLazyFetch },
    });
    assert.equal(fetchedBlob.status, 0, "effort guard lazily fetched the historical ledger blob");
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
