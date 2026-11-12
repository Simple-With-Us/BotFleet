import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  prunablePath,
  resolveRollbackPlacement,
  rollbackGenerationStatus,
  rollbackGenerations,
  rollbackGenerationsToPrune,
  sameVolume,
  staleCandidateNames,
  survivingRollbackProcessError,
} from "./update-botfleet-mac.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "botfleet-rollback-placement-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("a same-volume update cache keeps the rollback bundle out of the applications folder", async (t) => {
  const root = await fixture(t);
  const stage = join(root, "updates", "audit-ae8abe7d");
  await mkdir(stage, { recursive: true, mode: 0o700 });
  const placement = await resolveRollbackPlacement({
    livePath: join(root, "Applications", "BotFleet.app"),
    stageDirectory: stage,
    stageName: "BotFleet.app",
    generation: "1-aaaaaaaaaaaa",
    adjacentPath: join(root, "Applications", ".BotFleet.rollback-1-aaaaaaaaaaaa.app"),
  });
  assert.equal(placement.placement, "stage");
  assert.equal(placement.crossVolume, false);
  assert.equal(placement.path, join(stage, "rollback", "1-aaaaaaaaaaaa", "BotFleet.app"));
  assert.equal(placement.directory, join(stage, "rollback", "1-aaaaaaaaaaaa"));
  assert.equal(placement.crossVolumeReason, undefined);
});

test("a cross-volume cache falls back to the adjacent hidden bundle and records why", async (t) => {
  const root = await fixture(t);
  const adjacent = join(root, "Applications", ".BotFleet.rollback-1-aaaaaaaaaaaa.app");
  const placement = await resolveRollbackPlacement(
    {
      livePath: join(root, "Applications", "BotFleet.app"),
      stageDirectory: join(root, "updates", "audit-ae8abe7d"),
      stageName: "BotFleet.app",
      generation: "1-aaaaaaaaaaaa",
      adjacentPath: adjacent,
    },
    async () => false,
  );
  assert.equal(placement.placement, "adjacent");
  assert.equal(placement.crossVolume, true);
  assert.equal(placement.path, adjacent);
  assert.equal(placement.directory, join(root, "Applications"));
  assert.match(placement.crossVolumeReason, /different volume/);
});

test("volume comparison resolves paths that do not exist yet", async (t) => {
  const root = await fixture(t);
  assert.equal(await sameVolume(join(root, "updates/audit/rollback"), join(root, "Applications/BotFleet.app")), true);
  const devices = new Map([[root, 1]]);
  assert.equal(
    await sameVolume(join(root, "a/b/c"), "/", async (path) => ({ dev: devices.get(path) ?? 2 })),
    false,
  );
});

test("a receipt without a status is the verified shape earlier updates wrote", () => {
  assert.equal(rollbackGenerationStatus(undefined), "verified");
  assert.equal(rollbackGenerationStatus({}), "verified");
  assert.equal(rollbackGenerationStatus({ status: "verified" }), "verified");
  assert.equal(rollbackGenerationStatus({ status: "installing" }), "installing");
});

test("pruning keeps one verified generation and never touches an unverified one", () => {
  const generations = [
    { receiptPath: "/updates/new/rollback/BotFleet.app.json", receipt: { appPath: "/Applications/BotFleet.app", installedAt: "2026-09-12T11:31:00.000Z" } },
    { receiptPath: "/Applications/.BotFleet.rollback-old.app.json", receipt: { appPath: "/Applications/BotFleet.app", installedAt: "2026-09-11T21:01:00.000Z" } },
    { receiptPath: "/updates/broken/rollback/BotFleet.app.json", receipt: { appPath: "/Applications/BotFleet.app", status: "installing", installedAt: "2026-09-12T11:40:00.000Z" } },
    { receiptPath: "/updates/other/rollback/BotFleet.app.json", receipt: { appPath: "/Applications/BotFleet Beta.app", installedAt: "2026-09-12T11:35:00.000Z" } },
  ];
  const pruned = rollbackGenerationsToPrune(generations, {
    appPath: "/Applications/BotFleet.app",
    keepReceiptPath: "/updates/new/rollback/BotFleet.app.json",
  });
  assert.deepEqual(pruned.map((item) => item.receiptPath), ["/Applications/.BotFleet.rollback-old.app.json"]);

  // Without an explicit generation to keep, the newest verified one survives.
  assert.deepEqual(
    rollbackGenerationsToPrune(generations, { appPath: "/Applications/BotFleet.app" }).map((item) => item.receiptPath),
    ["/Applications/.BotFleet.rollback-old.app.json"],
  );
  // An in-progress generation is never the one kept, and never pruned either.
  assert.deepEqual(
    rollbackGenerationsToPrune([generations[2]], { appPath: "/Applications/BotFleet.app" }),
    [],
  );
});

test("prune refuses any receipt path outside the directories the updater owns", () => {
  const roots = ["/Applications", "/Users/test/apps", "/Users/test/Library/Caches/BotFleet/updates"];
  assert.equal(prunablePath("/Applications/.BotFleet.rollback-old.app", roots), true);
  assert.equal(prunablePath("/Users/test/Library/Caches/BotFleet/updates/audit/rollback/BotFleet.app", roots), true);
  assert.equal(prunablePath("/Applications", roots), false);
  assert.equal(prunablePath("/Users/test/Documents/taxes", roots), false);
  assert.equal(prunablePath("/", roots), false);
  assert.equal(prunablePath(undefined, roots), false);
});

test("abandoned update candidates are recognised only once their updater is gone", () => {
  const names = [
    "BotFleet.app",
    ".BotFleet.rollback-1-aaaaaaaaaaaa.app",
    ".BotFleet.update-4242-1757000000000.app",
    ".BotFleet.update-9999-1757000000001.app",
    ".BotFleet.update-7777-1757000000002.app",
  ];
  assert.deepEqual(
    staleCandidateNames(names, {
      prefix: ".BotFleet.update-",
      suffix: ".app",
      keepNames: [".BotFleet.update-7777-1757000000002.app"],
      isAlive: (pid) => pid === 4242,
    }),
    { stale: [".BotFleet.update-9999-1757000000001.app"], unrecognised: [] },
  );
});

test("a process left running from the renamed bundle is reported by its path", () => {
  assert.equal(survivingRollbackProcessError([], "/Applications/.BotFleet.rollback-old.app"), null);
  assert.match(
    survivingRollbackProcessError([7734], "/Applications/.BotFleet.rollback-old.app"),
    /7734 still runs from the prior bundle .*rollback-old\.app.*until relaunch/,
  );
});

test("generations come from receipts in both placements and a bundle without one is only reported", async (t) => {
  const root = await fixture(t);
  const applications = join(root, "Applications");
  const updates = join(root, "updates");
  const appPath = join(applications, "BotFleet.app");
  await mkdir(appPath, { recursive: true });

  const legacyBundle = join(applications, ".BotFleet.rollback-1757600000000-2246f19e9de8.app");
  await mkdir(legacyBundle, { recursive: true });
  // Exactly the keys the first receipt schema wrote, with no status at all.
  await writeFile(`${legacyBundle}.json`, `${JSON.stringify({
    schemaVersion: 1,
    previousCommit: "2".repeat(40),
    replacementCommit: "a".repeat(40),
    rollbackBundle: legacyBundle,
    rollbackDependencies: join(root, "apps", ".botfleet-server.node_modules.rollback-old"),
    installedAt: "2026-09-11T21:01:00.000Z",
  }, null, 2)}\n`);

  const orphan = join(applications, ".BotFleet.rollback-1757700000000-ffffffffffff.app");
  await mkdir(orphan, { recursive: true });

  const stagedRollback = join(updates, "audit-ae8abe7d", "rollback");
  await mkdir(stagedRollback, { recursive: true, mode: 0o700 });
  await mkdir(join(stagedRollback, "BotFleet.app"));
  await writeFile(join(stagedRollback, "BotFleet.app.json"), `${JSON.stringify({
    schemaVersion: 1,
    status: "verified",
    appPath,
    previousCommit: "a".repeat(40),
    replacementCommit: "b".repeat(40),
    rollbackBundle: join(stagedRollback, "BotFleet.app"),
    rollbackDependencies: join(root, "apps", ".botfleet-server.node_modules.rollback-new"),
    rollbackPlacement: "stage",
    crossVolume: false,
    installedAt: "2026-09-12T11:31:00.000Z",
  }, null, 2)}\n`);

  const { generations, orphans } = await rollbackGenerations({ appPath, updatesDirectory: updates });
  assert.deepEqual(generations.map((item) => item.receiptPath).sort(), [
    `${legacyBundle}.json`,
    join(stagedRollback, "BotFleet.app.json"),
  ].sort());
  assert.deepEqual(orphans, [orphan]);

  // The legacy receipt names no application, so no install claims it and the
  // prune leaves it for a person.
  const pruned = rollbackGenerationsToPrune(generations, {
    appPath,
    keepReceiptPath: join(stagedRollback, "BotFleet.app.json"),
  });
  assert.deepEqual(pruned, []);
});

test("the updater writes the rollback receipt beside whichever bundle it produced", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("./update-botfleet-mac.mjs", import.meta.url), "utf8"));
  // The receipt path is derived from what this run rolled back: the bundle path
  // when the app moved, otherwise the dependency rollback path for server-only.
  assert.match(source, /rollbackReceiptPathForPrevious\(previous\)/);
  assert.match(source, /status: "installing"/);
  assert.match(source, /status: "verified"/);
  // The prior bundle must never be parked in the installed application's folder
  // by default again.
  assert.match(source, /stageName: basename\(config\.appPath\)/);
  assert.match(source, /BotFleet process .* still runs from inside/);
});
