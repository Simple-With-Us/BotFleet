import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  NODE_DESKTOP_PATTERNS,
  compositeActionFiles,
  findNodeDesktopActionSteps,
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

test("a job that only typechecks is a Node desktop job too", () => {
  const workflow = {
    jobs: {
      typecheck: {
        name: "Typecheck",
        steps: [{ name: "Typecheck", run: "pnpm typecheck" }],
      },
    },
  };
  const offenders = findNodeDesktopJobs(workflow, ".github/workflows/ci.yml");
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].job, "typecheck");
  assert.equal(offenders[0].pattern, "pnpm typecheck");
});

test("a job that reaches the desktop through a reusable workflow or a matrix is named", () => {
  const workflow = {
    jobs: {
      delegated: {
        name: "Delegated desktop build",
        uses: "./.github/workflows/desktop.yml",
        strategy: { matrix: { run: ["electron-builder --dir"] } },
      },
    },
  };
  const offenders = findNodeDesktopJobs(workflow, ".github/workflows/ci.yml");
  const patterns = offenders.map((offender) => offender.pattern);
  assert.ok(patterns.includes("electron-builder"), "a matrix value that names the desktop must be caught");
  assert.ok(offenders.every((offender) => offender.job === "delegated"));
});

test("a job that installs the desktop dependency closure is a Node desktop job", () => {
  // The root manifest and lockfile hold the whole desktop closure, so a job
  // that installs it cannot outlive the desktop.  A job that only installs a
  // pinned CLI is a different thing, and must not be named.
  const workflow = {
    jobs: {
      lint: {
        name: "Lint",
        steps: [{ name: "Install", run: "pnpm install --frozen-lockfile" }],
      },
      cli: {
        name: "Install pinned CLI",
        steps: [{ name: "Install CLI", run: "npm install --global vercel@64.5.0" }],
      },
    },
  };
  const offenders = findNodeDesktopJobs(workflow, ".github/workflows/node-ci.yml");
  const installers = offenders.filter((offender) => offender.pattern === "pnpm install");
  assert.equal(installers.length, 1);
  assert.equal(installers[0].job, "lint");
  assert.ok(
    !offenders.some((offender) => offender.job === "cli"),
    "a job that installs a global CLI does not install the desktop",
  );
});

test("a workflow that only mentions the command in a prompt is not a desktop job", () => {
  // An autofix workflow passes the repo's verify command to its agent as
  // text.  The job does not run the desktop, so naming it would be a false
  // report and the audit would lose its value.
  const workflow = {
    jobs: {
      autofix: {
        name: "autofix",
        with: { prompt: "This repo's verify command: `pnpm typecheck && pnpm test`." },
        steps: [{ name: "Run the agent", run: "node agent.mjs" }],
      },
    },
  };
  assert.deepEqual(findNodeDesktopJobs(workflow, ".github/workflows/claude-code-autofix.yml"), []);
});

test("a prompt that names the install is not a desktop job either", () => {
  // Same rule, one step further: a prompt that tells an agent to run
  // `pnpm install` is text, and the job that carries it does not install the
  // desktop closure.
  const workflow = {
    jobs: {
      autofix: {
        name: "autofix",
        with: { prompt: "Start with `pnpm install --frozen-lockfile`." },
        steps: [{ name: "Run the agent", run: "node agent.mjs" }],
      },
    },
  };
  assert.deepEqual(findNodeDesktopJobs(workflow, ".github/workflows/claude-code-autofix.yml"), []);
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
    assert.match(result.stdout, /1 workflow file\(s\) and 0 composite action\(s\) read, no job runs the Node desktop/);
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

test("a workflow whose job shape is malformed is refused instead of judged", () => {
  // A workflow file is untrusted YAML.  A job whose steps are not a list of
  // steps must not read as a job with no steps, or the gate would pass on a
  // shape it could not read.
  const directory = mkdtempSync(join(tmpdir(), "botfleet-node-ci-jobs-"));
  try {
    makeCheckout(directory, {
      "ci.yml": "name: CI\njobs:\n  test:\n    steps: not-a-list\n",
    });
    const result = spawnSync("node", [cli, "--repo-root", directory], { encoding: "utf8" });
    assert.equal(result.status, 2, "a malformed shape must not be judged clean");
    assert.match(result.stderr, /ci\.yml/);
    assert.match(result.stderr, /not a workflow shape this gate can judge/);
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

test("a composite action that runs the Node desktop is named", () => {
  // A job that calls a local composite action delegates its steps to that
  // action, so a step that lives in the action still runs the desktop.
  const action = {
    name: "Desktop build",
    runs: {
      using: "composite",
      steps: [{ name: "Run the desktop tests", run: "pnpm test" }],
    },
  };
  const offenders = findNodeDesktopActionSteps(action, ".github/actions/build/action.yml", "build");
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].job, "build");
  assert.equal(offenders[0].name, "Desktop build");
  assert.equal(offenders[0].pattern, "pnpm test");
});

test("a composite action that runs no desktop work is clean", () => {
  const action = {
    name: "Infisical secrets",
    runs: {
      using: "composite",
      steps: [{ name: "Fetch secrets", run: "node \"$GITHUB_ACTION_PATH/../../../scripts/infisical-fetch.mjs\"" }],
    },
  };
  assert.deepEqual(findNodeDesktopActionSteps(action, ".github/actions/secrets/action.yml", "secrets"), []);
});

test("a checkout with no composite actions carries nothing to judge", () => {
  const directory = mkdtempSync(join(tmpdir(), "botfleet-node-ci-jobs-"));
  try {
    assert.deepEqual(compositeActionFiles(directory), []);
    makeCheckout(directory, { "ci.yml": "name: CI\njobs:\n  ios:\n    steps:\n      - run: swift test\n" });
    mkdirSync(join(directory, ".github", "actions", "build"), { recursive: true });
    writeFileSync(
      join(directory, ".github", "actions", "build", "action.yml"),
      "name: Build\nruns:\n  using: composite\n  steps:\n    - run: pnpm test\n",
    );
    const found = compositeActionFiles(directory);
    assert.equal(found.length, 1);
    assert.equal(found[0].id, "build");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the gate names a composite action that runs the Node desktop", () => {
  const directory = mkdtempSync(join(tmpdir(), "botfleet-node-ci-jobs-"));
  try {
    makeCheckout(directory, {
      "ci.yml": "name: CI\njobs:\n  desktop:\n    name: Desktop\n    steps:\n      - uses: ./.github/actions/build\n",
    });
    mkdirSync(join(directory, ".github", "actions", "build"), { recursive: true });
    writeFileSync(
      join(directory, ".github", "actions", "build", "action.yml"),
      "name: Desktop build\nruns:\n  using: composite\n  steps:\n    - run: pnpm test\n",
    );
    const result = spawnSync("node", [cli, "--repo-root", directory], { encoding: "utf8" });
    assert.equal(result.status, 1, "the Node desktop job must block the gate");
    assert.match(result.stderr, /\.github\/actions\/build\/action\.yml: job "build"/);
    assert.match(result.stderr, /matches "pnpm test"/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a composite action that cannot be parsed is refused instead of skipped", () => {
  const directory = mkdtempSync(join(tmpdir(), "botfleet-node-ci-jobs-"));
  try {
    makeCheckout(directory, { "ci.yml": "name: CI\njobs:\n  ios:\n    steps:\n      - run: swift test\n" });
    mkdirSync(join(directory, ".github", "actions", "broken"), { recursive: true });
    writeFileSync(join(directory, ".github", "actions", "broken", "action.yml"), "name: Broken\nruns: [unclosed\n");
    const result = spawnSync("node", [cli, "--repo-root", directory], { encoding: "utf8" });
    assert.equal(result.status, 2, "an unreadable composite action must not be skipped");
    assert.match(result.stderr, /broken\/action\.yml/);
    assert.match(result.stderr, /refusing to skip a composite action this gate could not read/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the committed workflows still carry a Node desktop job, so the gate fails today", () => {
  const result = spawnSync("node", [cli], { encoding: "utf8", cwd: repoRoot });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.github\/workflows\/ci\.yml: job "test"/);
  assert.match(result.stderr, /matches "pnpm test"/);
  // The desktop lint workflow installs the closure, so the gate has to name
  // it as well: a removal that left it behind would break CI on main.
  assert.match(result.stderr, /\.github\/workflows\/node-ci\.yml: job "lint"/);
  assert.match(result.stderr, /matches "pnpm install"/);
  // The repository's own composite action runs a dependency-free script, so
  // reading it must not invent an offender.
  assert.doesNotMatch(result.stderr, /\.github\/actions\//);
});
