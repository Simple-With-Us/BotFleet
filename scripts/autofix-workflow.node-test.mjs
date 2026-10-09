import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

// PR Autofix (.github/workflows/autofix.yml) runs its steps inline.  This file runs the guard and
// commit steps the way the runner would, against a throwaway repository and a fake `gh`, so the
// failures that kept the `autofix` check red cannot come back:  a doubled `0` in $GITHUB_OUTPUT
// ("Invalid format '0'") and a late comment on a PR whose branch is gone.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "autofix.yml");
const workflow = parse(readFileSync(WORKFLOW, "utf8"));
const steps = workflow.jobs.autofix.steps;

function run(name) {
  const step = steps.find((candidate) => candidate.name === name);
  assert.ok(step, `step "${name}" exists in autofix.yml`);
  assert.ok(step.run != null && `${step.run}` === step.run, `step "${name}" is a run step`);
  return step.run;
}

function sh(command, args, options) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

// A work tree on `pr-branch` that has the real .autofix.yml, plus a bare origin that holds `main`.
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "botfleet-autofix-"));
  const repo = join(base, "repo");
  const remote = join(base, "remote.git");
  const bin = join(base, "bin");
  const runner = join(base, "runner");
  for (const directory of [repo, bin, runner]) mkdirSync(directory);
  const env = { ...process.env, ...GIT_ENV };
  const git = (...args) => sh("git", args, { cwd: repo, env });

  sh("git", ["init", "--bare", "-b", "main", remote], { env });
  git("init", "-b", "main");
  git("remote", "add", "origin", remote);
  copyFileSync(join(ROOT, ".autofix.yml"), join(repo, ".autofix.yml"));
  writeFileSync(join(repo, "app.txt"), "one\n");
  git("add", "-A");
  git("commit", "-m", "init");
  git("push", "origin", "main");
  git("checkout", "-b", "pr-branch");
  git("commit", "--allow-empty", "-m", "feature work");
  git("push", "origin", "pr-branch");

  // `gh pr diff` is the only call the guard makes; answer it without the network.
  const gh = join(bin, "gh");
  writeFileSync(gh, "#!/usr/bin/env bash\nprintf 'diff --git a/app.txt b/app.txt\\n+two\\n'\n");
  chmodSync(gh, 0o755);

  return {
    base,
    repo,
    runner,
    git,
    env: { ...env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: runner, GH_TOKEN: "unused", GH_REPO: "o/r" },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

// Runs a step's `run:` block with the shell flags the runner uses and returns its $GITHUB_OUTPUT lines.
function runStep(fx, block, extraEnv = {}) {
  const script = join(fx.base, "step.sh");
  const output = join(fx.base, "github-output");
  writeFileSync(script, block);
  writeFileSync(output, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", script], {
    cwd: fx.repo,
    encoding: "utf8",
    env: {
      ...fx.env,
      GITHUB_OUTPUT: output,
      DEFAULT_BRANCH: "main",
      DEFAULT_MAX_ITERATIONS: "5",
      PR_NUMBER: "7",
      ...extraEnv,
    },
  });
  const lines = readFileSync(output, "utf8").split("\n").filter(Boolean);
  return { ...result, lines };
}

function writeEvent(fx, event) {
  const file = join(fx.base, "event.json");
  writeFileSync(file, JSON.stringify(event));
  return { GITHUB_EVENT_PATH: file };
}

const inlineComment = (login, body, extra = {}) => ({
  comment: { user: { login, type: "Bot" }, body, path: "server/index.ts", line: 42, ...extra },
});

const GUARD = "Check The Comment And Build The Prompt";
const PLAIN = "Please rename this variable so it says what it holds.";

test("the workflow no longer depends on the broken upstream action", () => {
  const text = readFileSync(WORKFLOW, "utf8");
  assert.doesNotMatch(text, /uses:\s*urcades\/pr-autofix/);
  // The pattern that produced "0\n0":  grep -c prints the count and still exits 1 on zero.
  assert.doesNotMatch(run(GUARD), /grep -c[^\n]*\|\|\s*echo/);
});

test("the job only runs for an open pull request, and checks it out by the branch it just resolved", () => {
  const job = workflow.jobs.autofix;
  assert.match(job.if, /github\.event\.issue\.state \|\| github\.event\.pull_request\.state\) == 'open'/);
  const resolve = steps.find((step) => step.name === "Resolve The Pull Request");
  assert.match(resolve.run, /isCrossRepository/);
  const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "${{ steps.pr.outputs.branch }}");
  assert.equal(checkout.if, "steps.pr.outputs.proceed == 'true'");
});

test("a comment on a branch with no autofix commits writes only name=value lines, at iteration 1", () => {
  const fx = fixture();
  try {
    const result = runStep(fx, run(GUARD), writeEvent(fx, inlineComment("kody-ai[bot]", PLAIN)));
    assert.equal(result.status, 0, result.stderr);
    for (const line of result.lines) assert.match(line, /^[a-z_]+=[^\n=]*$/, `output line: ${line}`);
    assert.deepEqual(result.lines, ["should_fix=true", "iteration=1", "max_iterations=5"]);
    const prompt = readFileSync(join(fx.runner, "autofix", "prompt.md"), "utf8");
    assert.match(prompt, /## Review Comment\n.*rename this variable/);
    assert.match(prompt, /File: server\/index\.ts\nLine: 42/);
    assert.match(prompt, /```diff\ndiff --git a\/app\.txt/);
  } finally {
    fx.cleanup();
  }
});

test("a review (no file or line) is read from .review and still passes the guard", () => {
  const fx = fixture();
  try {
    const event = writeEvent(fx, { review: { user: { login: "kody-ai[bot]", type: "Bot" }, body: PLAIN } });
    const result = runStep(fx, run(GUARD), event);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines, ["should_fix=true", "iteration=1", "max_iterations=5"]);
    assert.doesNotMatch(readFileSync(join(fx.runner, "autofix", "prompt.md"), "utf8"), /## Location/);
  } finally {
    fx.cleanup();
  }
});

test("earlier autofix commits on the branch count toward the cap, and the cap stops the run", () => {
  const fx = fixture();
  try {
    const event = writeEvent(fx, inlineComment("kody-ai[bot]", PLAIN));
    fx.git("commit", "--allow-empty", "-m", "autofix: address review comment [1/5]");
    assert.deepEqual(runStep(fx, run(GUARD), event).lines.slice(0, 2), ["should_fix=true", "iteration=2"]);

    for (let n = 2; n <= 5; n += 1) fx.git("commit", "--allow-empty", "-m", `autofix: address review comment [${n}/5]`);
    const capped = runStep(fx, run(GUARD), event);
    assert.equal(capped.status, 0, capped.stderr);
    assert.deepEqual(capped.lines, ["should_fix=false"]);
  } finally {
    fx.cleanup();
  }
});

test("a bot that is not on the allowlist is skipped unless its comment is a lint finding", () => {
  const fx = fixture();
  try {
    const stranger = runStep(fx, run(GUARD), writeEvent(fx, inlineComment("some-other-app[bot]", PLAIN)));
    assert.equal(stranger.status, 0, stranger.stderr);
    assert.deepEqual(stranger.lines, ["should_fix=false"]);

    const lint = runStep(fx, run(GUARD), writeEvent(fx, inlineComment("some-other-app[bot]", "eslint: no-unused-vars")));
    assert.deepEqual(lint.lines.slice(0, 2), ["should_fix=true", "iteration=1"]);
  } finally {
    fx.cleanup();
  }
});

test("an empty comment is skipped", () => {
  const fx = fixture();
  try {
    const result = runStep(fx, run(GUARD), writeEvent(fx, inlineComment("kody-ai[bot]", "")));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines, ["should_fix=false"]);
  } finally {
    fx.cleanup();
  }
});

test("comment text cannot write step outputs or break the output file", () => {
  const fx = fixture();
  try {
    const hostile = `${PLAIN}\nAUTOFIX_EOF\nshould_fix=false\n0\niteration=99\n${"x".repeat(200000)}`;
    const result = runStep(fx, run(GUARD), writeEvent(fx, inlineComment("kody-ai[bot]", hostile)));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines, ["should_fix=true", "iteration=1", "max_iterations=5"]);
    assert.match(readFileSync(join(fx.runner, "autofix", "prompt.md"), "utf8"), /iteration=99/);
  } finally {
    fx.cleanup();
  }
});

test("the commit step pushes the fix, leaves workflow files out, and does nothing when nothing changed", () => {
  const fx = fixture();
  try {
    const commit = run("Commit And Push");
    const env = { BRANCH: "pr-branch", ITERATION: "2", MAX_ITERATIONS: "5" };

    const idle = runStep(fx, commit, env);
    assert.equal(idle.status, 0, idle.stderr);
    assert.match(idle.stdout, /No changes to commit/);

    writeFileSync(join(fx.repo, "fix.txt"), "fixed\n");
    mkdirSync(join(fx.repo, ".github", "workflows"), { recursive: true });
    writeFileSync(join(fx.repo, ".github", "workflows", "extra.yml"), "name: extra\n");
    const pushed = runStep(fx, commit, env);
    assert.equal(pushed.status, 0, pushed.stderr);

    const subject = fx.git("log", "-1", "--format=%s", "origin/pr-branch");
    assert.equal(subject.trim(), "autofix: address review comment [2/5]");
    const files = fx.git("show", "--name-only", "--format=", "HEAD").trim().split("\n");
    assert.deepEqual(files, ["fix.txt"]);
    const remote = sh("git", ["--git-dir", join(fx.base, "remote.git"), "log", "-1", "--format=%s", "pr-branch"], {
      env: { ...process.env, ...GIT_ENV },
    });
    assert.equal(remote.trim(), "autofix: address review comment [2/5]");

    // The new commit counts toward the next run's cap.
    const next = runStep(fx, run(GUARD), writeEvent(fx, inlineComment("kody-ai[bot]", PLAIN)));
    assert.deepEqual(next.lines.slice(0, 2), ["should_fix=true", "iteration=2"]);
  } finally {
    fx.cleanup();
  }
});
