// BF-2718: the drift gate must pass a clean tree, name every drifted
// generated path, and fail closed when git cannot read the tree.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { GENERATED_PATHS, findDriftedPaths, main } from "./check-xcodegen-drift.mjs";

const PLIST = "ios/MacApp/Info.plist";

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

describe("check-xcodegen-drift (BF-2718)", () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "xcodegen-drift-"));
    git(root, "init", "-q");
    git(root, "config", "user.email", "drift@example.invalid");
    git(root, "config", "user.name", "Drift Test");
    mkdirSync(join(root, dirname(PLIST)), { recursive: true });
    writeFileSync(join(root, PLIST), "<plist>tracked</plist>\n");
    git(root, "add", PLIST);
    git(root, "commit", "-qm", "track the generated plist");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("names the three Info.plists and the project bundle", () => {
    assert.deepEqual(GENERATED_PATHS, [
      "ios/App/Info.plist",
      "ios/Widgets/Info.plist",
      "ios/MacApp/Info.plist",
      "ios/BotFleet.xcodeproj",
    ]);
  });

  it("passes a clean tree", () => {
    assert.deepEqual(findDriftedPaths(root, [PLIST]), []);
    assert.equal(main(root), 0);
  });

  it("names a generated file the generator rewrote", () => {
    writeFileSync(join(root, PLIST), "<plist>regenerated</plist>\n");
    assert.deepEqual(findDriftedPaths(root, [PLIST]), [PLIST]);
    assert.equal(main(root), 1);
  });

  it("treats an untracked generated file as drift", () => {
    const widgets = "ios/Widgets/Info.plist";
    mkdirSync(join(root, dirname(widgets)), { recursive: true });
    writeFileSync(join(root, widgets), "<plist>new</plist>\n");
    assert.deepEqual(findDriftedPaths(root, ["ios/Widgets/Info.plist"]), [widgets]);
  });

  it("ignores changes outside the generated paths", () => {
    writeFileSync(join(root, "README.md"), "not generated\n");
    assert.deepEqual(findDriftedPaths(root, [PLIST]), []);
  });

  it("fails closed outside a repository", () => {
    const bare = mkdtempSync(join(tmpdir(), "xcodegen-drift-bare-"));
    try {
      assert.equal(main(bare), 1);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
