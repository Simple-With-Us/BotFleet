import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BASELINE_INCREASE_LABEL,
  evaluateRatchet,
  formatRatchetReport,
  parseArgs,
  readBaselineRulesFromRef,
} from "./check-lint-baseline.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = join(repoRoot, ".github/workflows/node-ci.yml");
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.test",
};

function counts(entries) {
  return new Map(Object.entries(entries));
}

function evaluate(overrides) {
  return evaluateRatchet({
    baselineRules: { "anti-slop/example": 10 },
    committedRules: { "anti-slop/example": 10 },
    current: counts({ "anti-slop/example": 10 }),
    errors: [],
    allowIncrease: false,
    mode: "base-ref",
    ...overrides,
  });
}

describe("evaluateRatchet", () => {
  test("a branch that is only behind the base passes when the merge commit matches the base baseline", () => {
    const result = evaluate({});
    assert.equal(result.failed, false);
    assert.equal(result.increased.length, 0);
    assert.equal(result.fileRaised.length, 0);
  });

  test("working tree mode still fails when a count rises above the committed baseline", () => {
    const result = evaluateRatchet({
      baselineRules: { "anti-slop/example": 10 },
      current: counts({ "anti-slop/example": 11 }),
      mode: "working-tree",
      allowIncrease: true,
    });
    assert.equal(result.failed, true);
    assert.equal(result.increased.length, 1);
  });

  test("working tree mode passes and records a cleanup when a count drops", () => {
    const result = evaluateRatchet({
      baselineRules: { "anti-slop/example": 10 },
      current: counts({ "anti-slop/example": 8 }),
      mode: "working-tree",
    });
    assert.equal(result.failed, false);
    assert.equal(result.decreased[0].now, 8);
  });

  test("lint errors fail even when warning counts are inside the baseline", () => {
    const result = evaluate({
      errors: ["anti-slop/no-reflect-apply in server/example.ts"],
    });
    assert.equal(result.failed, true);
  });

  test("a merge commit that adds warnings fails without the allow path", () => {
    const result = evaluate({
      current: counts({ "anti-slop/example": 12 }),
    });
    assert.equal(result.failed, true);
    const text = formatRatchetReport(result, { baselineRef: "origin/main" });
    assert.match(text, /baseline 10, now 12/);
    assert.match(text, /Do not run --update/);
    assert.match(text, new RegExp(BASELINE_INCREASE_LABEL));
  });

  test("bumping the JSON above the base fails even when measured counts do not rise", () => {
    const result = evaluate({
      committedRules: { "anti-slop/example": 14 },
    });
    assert.equal(result.failed, true);
    const text = formatRatchetReport(result, { baselineRef: "origin/main" });
    assert.match(text, /Bumping this JSON is not a green path/);
    assert.match(text, new RegExp(BASELINE_INCREASE_LABEL));
  });

  test("an exact raise is still a failure until the allow path is on", () => {
    const result = evaluate({
      current: counts({ "anti-slop/example": 12 }),
      committedRules: { "anti-slop/example": 12 },
    });
    assert.equal(result.failed, true);
  });

  test("the allow path accepts a raise only when the committed count equals the measurement", () => {
    const result = evaluate({
      current: counts({ "anti-slop/example": 12 }),
      committedRules: { "anti-slop/example": 12 },
      allowIncrease: true,
    });
    assert.equal(result.failed, false);
    const text = formatRatchetReport(result, {
      baselineRef: "origin/main",
      allowIncrease: true,
    });
    assert.match(text, /Allowed baseline increase/);
  });

  test("the allow path rejects headroom above the measured count", () => {
    const result = evaluate({
      current: counts({ "anti-slop/example": 12 }),
      committedRules: { "anti-slop/example": 20 },
      allowIncrease: true,
    });
    assert.equal(result.failed, true);
    const text = formatRatchetReport(result, { allowIncrease: true });
    assert.match(text, /no headroom/);
  });

  test("the allow path rejects a pure ceiling bump that measured counts do not need", () => {
    const result = evaluate({
      committedRules: { "anti-slop/example": 15 },
      allowIncrease: true,
    });
    assert.equal(result.failed, true);
    assert.equal(result.exactMismatch.length, 1);
  });

  test("a stale low baseline tells the author to revert it and not regenerate", () => {
    const result = evaluate({
      committedRules: { "anti-slop/example": 8 },
    });
    assert.equal(result.failed, true);
    const text = formatRatchetReport(result, { baselineRef: "origin/main" });
    assert.match(text, /only behind the base does not need a new baseline/);
    assert.match(text, /Do not regenerate it/);
  });

  test("a new rule on the merge commit counts as a rise from zero", () => {
    const result = evaluate({
      current: counts({
        "anti-slop/example": 10,
        "anti-slop/brand-new": 2,
      }),
      committedRules: {
        "anti-slop/example": 10,
        "anti-slop/brand-new": 2,
      },
    });
    assert.equal(result.failed, true);
    assert.equal(result.increased[0].rule, "anti-slop/brand-new");
    assert.equal(result.increased[0].base, 0);
  });

  test("cleaning a warning on the merge commit does not fail and does not require a file edit", () => {
    const result = evaluate({
      current: counts({ "anti-slop/example": 7 }),
    });
    assert.equal(result.failed, false);
    assert.equal(result.decreased[0].now, 7);
  });
});

describe("parseArgs", () => {
  test("reads the allow opt-in only from the exact env value 1", () => {
    assert.equal(parseArgs([], { LINT_BASELINE_ALLOW_INCREASE: "1" }).allowIncrease, true);
    assert.equal(parseArgs([], { LINT_BASELINE_ALLOW_INCREASE: "0" }).allowIncrease, false);
    assert.equal(parseArgs([], { LINT_BASELINE_ALLOW_INCREASE: "true" }).allowIncrease, false);
    assert.equal(parseArgs(["--allow-increase"], {}).allowIncrease, true);
  });

  test("takes the baseline ref from the flag or the env", () => {
    assert.equal(parseArgs(["--baseline-ref", "origin/main"], {}).baselineRef, "origin/main");
    assert.equal(parseArgs([], { LINT_BASELINE_REF: "origin/main" }).baselineRef, "origin/main");
  });

  test("refuses to combine --update with a baseline ref", () => {
    assert.throws(
      () => parseArgs(["--update", "--baseline-ref", "origin/main"], {}),
      /does not treat a rewritten baseline as success/,
    );
  });

  test("refuses a baseline ref that could change the git show path", () => {
    assert.throws(() => parseArgs(["--baseline-ref", "origin/main:other"], {}), /Refusing baseline ref/);
    assert.throws(() => parseArgs(["--baseline-ref", "origin/../main"], {}), /Refusing baseline ref/);
  });
});

describe("readBaselineRulesFromRef", () => {
  const scratch = [];

  after(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });

  test("reads the base branch file, not the higher copy in the working tree", () => {
    const root = mkdtempSync(join(tmpdir(), "lint-baseline-ref-"));
    scratch.push(root);
    const git = (...args) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: gitEnv });
      assert.equal(result.status, 0, result.stderr);
    };
    git("init", "-q", "-b", "main");
    writeFileSync(
      join(root, ".oxlint-baseline.json"),
      JSON.stringify({ rules: { "anti-slop/example": 4 } }) + "\n",
    );
    git("add", ".oxlint-baseline.json");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    writeFileSync(
      join(root, ".oxlint-baseline.json"),
      JSON.stringify({ rules: { "anti-slop/example": 40 } }) + "\n",
    );
    git("add", ".oxlint-baseline.json");
    git("commit", "-q", "-m", "regen");

    const rules = readBaselineRulesFromRef("main", root);
    assert.deepEqual(rules, { "anti-slop/example": 4 });
  });
});

describe("node-ci pull request ratchet", () => {
  test("the workflow keeps both gates and opts in only through the label", () => {
    const yaml = readFileSync(workflowPath, "utf8");
    assert.match(yaml, /node scripts\/lint-pr-gate\.mjs/);
    assert.match(yaml, /node scripts\/check-lint-baseline\.mjs --baseline-ref "\$LINT_BASELINE_REF"/);
    assert.match(yaml, new RegExp(BASELINE_INCREASE_LABEL));
    assert.match(yaml, /LINT_BASELINE_ALLOW_INCREASE:/);
    assert.match(yaml, /labeled/);
    assert.match(yaml, /unlabeled/);
    assert.doesNotMatch(yaml, /github\.event\.pull_request\.head\.sha/);
    assert.doesNotMatch(yaml, /LINT_BASELINE_ALLOW_INCREASE:\s*"1"/);
    assert.doesNotMatch(yaml, /LINT_BASELINE_ALLOW_INCREASE:\s*'1'/);
  });
});
