import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FAILED_INSTALL_KEEP,
  failedInstallBundlesToPrune,
  pruneFailedInstallBundles,
} from "./failed-install-retention.mjs";

test("pruneFailedInstallBundles removes only names this updater owns", () => {
  const root = mkdtempSync(join(tmpdir(), "bf-failed-"));
  const appPath = join(root, "BotFleet.app");
  mkdirSync(appPath);
  const names = [
    "BotFleet.app.failed-1000",
    "BotFleet.app.failed-2000",
    "BotFleet.app.failed-3000",
    "BotFleet.app.failed-4000",
    "BotFleet Beta.app.failed-5000",
  ];
  for (const name of names) {
    mkdirSync(join(root, name));
  }
  const removed = pruneFailedInstallBundles(appPath, {
    keep: 2,
    listNames: (dir) => readdirSync(dir),
    remove: (path) => rmSync(path, { recursive: true, force: true }),
  });
  assert.deepEqual(
    [...removed.map((path) => path.split("/").at(-1))].sort(),
    ["BotFleet.app.failed-1000", "BotFleet.app.failed-2000"].sort(),
  );
  assert.equal(FAILED_INSTALL_KEEP, 3);
  assert.deepEqual(
    failedInstallBundlesToPrune(names, "BotFleet.app", 2).sort(),
    ["BotFleet.app.failed-1000", "BotFleet.app.failed-2000"].sort(),
  );
  rmSync(root, { recursive: true, force: true });
});
