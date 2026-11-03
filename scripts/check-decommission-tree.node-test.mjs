import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DECOMMISSION_ROOTS,
  DESKTOP_MANIFESTS,
  missingTreeConditions,
} from "./check-decommission-tree.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "scripts", "check-decommission-tree.mjs");

/**
 * Build a throwaway git work tree so `git ls-files` really runs against a
 * real index instead of a mocked one.
 */
function makeRepo(directory, files) {
  execFileSync("git", ["init", "--quiet"], { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
  for (const [name, contents] of Object.entries(files)) {
    const path = join(directory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  execFileSync("git", ["add", "-A"], { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
  execFileSync(
    "git",
    [
      "-c",
      "user.email=botfleet-tests@example.invalid",
      "-c",
      "user.name=BotFleet Tests",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
  );
  return directory;
}

test("a tracked tree without the Node roots or manifests meets every condition", () => {
  const remaining = missingTreeConditions([
    "ios/Sources/BotFleet/App.swift",
    "scripts/check-decommission-tree.mjs",
    "docs/native-rewrite-decommission-runbook.md",
  ]);
  assert.deepEqual(remaining, { roots: [], manifests: [] });
});

test("a surviving Node root or desktop manifest is an unmet condition", () => {
  const remaining = missingTreeConditions([
    "server/index.ts",
    "server/zulip/client.ts",
    "companion/src/index.ts",
    "package.json",
    "ios/Sources/BotFleet/App.swift",
  ]);
  assert.deepEqual(remaining.roots, ["companion", "server"]);
  assert.deepEqual(remaining.manifests, ["package.json"]);
});

test("a manifest that is not at the repository root does not count", () => {
  // companion/package.json belongs to the Node root the decommission deletes
  // anyway; it must not be reported as a leftover desktop manifest.
  const remaining = missingTreeConditions(["companion/package.json", "ios/Package.swift"]);
  assert.deepEqual(remaining.manifests, []);
  assert.deepEqual(remaining.roots, ["companion"]);
});

test("the gate refuses a directory that is not a git work tree", () => {
  const directory = mkdtempSync(join(tmpdir(), "botfleet-decommission-tree-"));
  try {
    const result = spawnSync("node", [cli, "--repo-root", directory], { encoding: "utf8" });
    assert.equal(result.status, 2, "an unreadable index must be refused, never passed");
    assert.match(result.stderr, /could not read the tracked file list/);
    assert.match(result.stderr, /refusing to treat an unreadable index as a clean tree/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the gate refuses a checkout with no commit to read", () => {
  const directory = mkdtempSync(join(tmpdir(), "botfleet-decommission-tree-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
    const result = spawnSync("node", [cli, "--repo-root", directory], { encoding: "utf8" });
    assert.equal(result.status, 2, "an empty index must not read as a clean tree");
    assert.match(result.stderr, /has no commit to read/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the gate names every Node root and manifest still on the tree", () => {
  const directory = mkdtempSync(join(tmpdir(), "botfleet-decommission-tree-"));
  try {
    makeRepo(directory, {
      "server/index.ts": "export const harness = true;\n",
      "companion/src/index.ts": "export const companion = true;\n",
      "package.json": "{}\n",
      "pnpm-lock.yaml": "lockfileVersion: 9\n",
      "ios/Sources/BotFleet/App.swift": "// app\n",
    });
    const result = spawnSync("node", [cli, "--repo-root", directory], { encoding: "utf8" });
    assert.equal(result.status, 1, "the leftovers must block the gate");
    assert.match(result.stderr, /server\/ is still tracked \(1 file\(s\)\)/);
    assert.match(result.stderr, /companion\/ is still tracked \(1 file\(s\)\)/);
    assert.match(result.stderr, /package\.json is still tracked at the repository root/);
    assert.match(result.stderr, /pnpm-lock\.yaml is still tracked at the repository root/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the gate passes a tree the decommission already cleared", () => {
  const directory = mkdtempSync(join(tmpdir(), "botfleet-decommission-tree-"));
  try {
    makeRepo(directory, {
      "ios/Sources/BotFleet/App.swift": "// app\n",
      "scripts/check-decommission-tree.mjs": "// gate\n",
    });
    const result = spawnSync("node", [cli, "--repo-root", directory], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /the tracked tree carries no server\/, no companion\/ and no desktop Node manifest/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the committed tree still carries the Node stack, so the gate fails today", () => {
  // The gate is meant to fail while the runtime is still present; a pass
  // here would mean it stopped looking at the real tree.
  const result = spawnSync("node", [cli], { encoding: "utf8", cwd: repoRoot });
  assert.equal(result.status, 1);
  for (const root of DECOMMISSION_ROOTS) {
    assert.match(result.stderr, new RegExp(`${root}/ is still tracked`));
  }
  for (const manifest of DESKTOP_MANIFESTS) {
    assert.match(result.stderr, new RegExp(`${manifest.replace(".", "\\.")} is still tracked`));
  }
});
