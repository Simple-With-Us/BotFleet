import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  NODE_DESKTOP_PATTERNS,
  findNodeDesktopJobs,
} from "./check-node-ci-jobs.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "scripts", "check-node-ci-jobs.mjs");

const WORKFLOW = `name: CI
on:
  push:
jobs:
  test:
    name: typecheck + test (ubuntu)
    runs-on: ubuntu-latest
    steps:
      - name: Complete application test chain
        run: pnpm typecheck && pnpm test
  ios:
    name: Swift tests + iOS build
    runs-on: ubuntu-latest
    steps:
      - name: Swift package tests
        run: swift test
`;

/** Write a workflow into a throwaway checkout and return its root. */
function makeCheckout(directory, workflows) {
  for (const [name, contents] of Object.entries(workflows)) {
    const path = join(directory, ".github", "workflows", name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return directory;
}

test("a workflow whose jobs leave the Node desktop alone is clean", () => {
  const workflow = {
    jobs: {
      ios: {
        name: "Swift tests + iOS build",
        steps: [{ name: "Swift package tests", run: "swift test" }],
      },
    },
  };
  assert.deepEqual(findNodeDesktopJobs(workflow, ".github/workflows/ci.yml"), []);
});

test("a job that runs the Node test chain is named with the pattern it matched", () => {
  const workflow = {
    jobs: {
      test: {
        name: "typecheck + test (ubuntu)",
        steps: [{ name: "Complete application test chain", run: "pnpm typecheck && pnpm test" }],
      },
    },
  };
  const offenders = findNodeDesktopJobs(workflow, ".github/workflows/ci.yml");
  assert.ok(offenders.length > 0);
  for (const offender of offenders) {
    assert.equal(offender.file, ".github/workflows/ci.yml");
    assert.equal(offender.job, "test");
    assert.equal(offender.name, "typecheck + test (ubuntu)");
    assert.ok(NODE_DESKTOP_PATTERNS.includes(offender.pattern));
  }
  assert.ok(offenders.some((offender) => offender.pattern === "pnpm test"));
  assert.ok(offenders.some((offender) => offender.pattern === "typecheck + test"));
});

test("the gate reads the workflow job set and names every offender", () => {
  const directory = mkdtempSync(join(tmpdir(), "botfleet-node-ci-jobs-"));
  try {
    makeCheckout(directory, { "ci.yml": WORKFLOW });
    const result = spawnSync("node", [cli, "--repo-root", directory], { encoding: "utf8" });
    assert.equal(result.status, 1, "the Node desktop job must block the gate");
    assert.match(result.stderr, /\.github\/workflows\/ci\.yml: job "test"/);
    assert.match(result.stderr, /"typecheck \+ test \(ubuntu\)"/);
    assert.match(result.stderr, /matches "pnpm test"/);
    // The clean job is never named as an offender.
    assert.doesNotMatch(result.stderr, /job "ios"/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a workflow with no Node desktop job passes the gate", () => {
  const directory = mkdtempSync(join(tmpdir(), "botfleet-node-ci-jobs-"));
  try {
    makeCheckout(directory, {
      "ios.yml": `name: iOS
jobs:
  ios:
    name: Swift tests + iOS build
    steps:
      - run: swift test
`,
    });
    const result = spawnSync("node", [cli, "--repo-root", directory], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 workflow file\(s\) read, no job runs the Node desktop/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a workflow file that cannot be parsed is refused instead of skipped", () => {
  const directory = mkdtempSync(join(tmpdir(), "botfleet-node-ci-jobs-"));
  try {
    makeCheckout(directory, {
      "broken.yml": "name: CI\njobs:\n  test:\n    steps:\n  - run: pnpm test\n   badly: indented\n",
    });
    const result = spawnSync("node", [cli, "--repo-root", directory], { encoding: "utf8" });
    assert.equal(result.status, 2, "an unreadable workflow must not be skipped");
    assert.match(result.stderr, /broken\.yml/);
    assert.match(result.stderr, /refusing to skip a workflow this gate could not read/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a workflow without a job set is refused instead of passing", () => {
  const directory = mkdtempSync(join(tmpdir(), "botfleet-node-ci-jobs-"));
  try {
    makeCheckout(directory, { "empty.yml": "name: CI\non:\n  push:\n" });
    const result = spawnSync("node", [cli, "--repo-root", directory], { encoding: "utf8" });
    assert.equal(result.status, 2, "a workflow with no job set cannot be judged clean");
    assert.match(result.stderr, /has no jobs/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a checkout with no workflow directory is refused", () => {
  const directory = mkdtempSync(join(tmpdir(), "botfleet-node-ci-jobs-"));
  try {
    const result = spawnSync("node", [cli, "--repo-root", directory], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /could not read the workflow directory/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the committed workflows still carry a Node desktop job, so the gate fails today", () => {
  const result = spawnSync("node", [cli], { encoding: "utf8", cwd: repoRoot });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.github\/workflows\/ci\.yml: job "test"/);
  assert.match(result.stderr, /matches "pnpm test"/);
});
