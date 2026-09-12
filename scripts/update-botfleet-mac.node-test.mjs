import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isExpectedBotFleetProcess, loadPrepared, parseArguments, swapPreparedFiles } from "./update-botfleet-mac.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));

test("prepare and apply expose an explicit reusable stage", () => {
  assert.deepEqual(
    parseArguments(["prepare", "--target", "abc", "--source", "/tmp/source", "--stage", "/tmp/stage"]),
    {
      command: "prepare",
      target: "abc",
      source: "/tmp/source",
      stage: "/tmp/stage",
      bundle: undefined,
      dependencies: undefined,
      openApplication: true,
    },
  );
  assert.deepEqual(parseArguments(["apply", "--stage", "/tmp/stage", "--no-open"]), {
    command: "apply",
    target: "origin/main",
    source: undefined,
    stage: "/tmp/stage",
    bundle: undefined,
    dependencies: undefined,
    openApplication: false,
  });
  assert.throws(() => parseArguments(["apply"]), /requires --stage/);
  assert.throws(() => parseArguments(["update", "--unknown"]), /Unknown option/);
  assert.throws(() => parseArguments(["prepare", "--bundle", "/tmp/app"]), /supplied together/);
  assert.throws(
    () => parseArguments(["prepare", "--bundle", "/tmp/app", "--dependencies", "/tmp/deps"]),
    /requires its exact --source/,
  );
  assert.equal(
    parseArguments([
      "prepare",
      "--source", "/tmp/source",
      "--bundle", "/tmp/source/release/BotFleet.app",
      "--dependencies", "/tmp/source/node_modules",
    ]).bundle,
    "/tmp/source/release/BotFleet.app",
  );
});

test("prepared stages reject symlink directories and public manifests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "botfleet-update-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, "stage");
  const link = join(root, "stage-link");
  await mkdir(stage, { mode: 0o700 });
  await symlink(stage, link);
  await assert.rejects(loadPrepared(link), /must be a real directory/);

  const manifest = join(stage, "prepared.json");
  await writeFile(manifest, "{}\n", { mode: 0o600 });
  await chmod(manifest, 0o644);
  await assert.rejects(loadPrepared(stage), /must not be accessible by group or other users/);
});

test("production updater has no force-kill or unrelated desktop-process cleanup", async () => {
  const source = await readFile(join(scripts, "update-botfleet-mac.mjs"), "utf8");
  for (const forbidden of ["pkill", "killall", '"Dock"', '"Finder"', '"System Settings"']) {
    assert.equal(source.includes(forbidden), false, `must not contain ${forbidden}`);
  }
  assert.doesNotMatch(source, /process\.kill\([^\n]+"SIGKILL"/);
  assert.match(source, /process\.kill\(pid, "SIGTERM"\)/);
  assert.match(source, /runtime\.safeToRestart !== true/);
  assert.match(source, /runtime\.sourceCommit !== expectedBuild\.targetCommit/);
  assert.match(source, /Database ownership is ambiguous/);
});

test("process verification binds relative server commands to the live checkout cwd", () => {
  const config = { appPath: "/Applications/BotFleet.app", checkout: "/Users/test/apps/botfleet-server" };
  assert.equal(
    isExpectedBotFleetProcess("/opt/homebrew/bin/node --experimental-strip-types server/index.ts", config.checkout, config),
    true,
  );
  assert.equal(
    isExpectedBotFleetProcess("/opt/homebrew/bin/node --experimental-strip-types server/index.ts", "/tmp/decoy", config),
    false,
  );
  assert.equal(isExpectedBotFleetProcess("/usr/bin/python3 server/index.ts", config.checkout, config), false);
  assert.equal(isExpectedBotFleetProcess("/Applications/Other.app/Contents/MacOS/BotFleet", "/", config), false);
  assert.equal(isExpectedBotFleetProcess("/Applications/BotFleet.app/Contents/MacOS/BotFleet", "/", config), true);
});

test("packaged identity comes from the build output rather than an ambient label", async () => {
  const source = await readFile(join(scripts, "update-botfleet-mac.mjs"), "utf8");
  assert.match(source, /Contents\/Resources\/server\/build-identity\.json/);
  assert.match(source, /build\.sourceDirty !== false/);
  assert.doesNotMatch(source, /BOTFLEET_SOURCE_COMMIT:/);
});

async function swapFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "botfleet-update-swap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = {
    appPath: join(root, "BotFleet.app"),
    candidateApp: join(root, ".candidate.app"),
    rollbackApp: join(root, ".rollback.app"),
    liveDependencies: join(root, "node_modules"),
    candidateDependencies: join(root, ".candidate-node_modules"),
    rollbackDependencies: join(root, ".rollback-node_modules"),
  };
  for (const [path, marker] of [
    [paths.appPath, "old-app"],
    [paths.candidateApp, "new-app"],
    [paths.liveDependencies, "old-deps"],
    [paths.candidateDependencies, "new-deps"],
  ]) {
    await mkdir(path);
    await writeFile(join(path, "marker"), marker);
  }
  return paths;
}

test("the app and dependency tree swap together while retaining both prior copies", async (t) => {
  const paths = await swapFixture(t);
  await swapPreparedFiles(paths);
  assert.equal(await readFile(join(paths.appPath, "marker"), "utf8"), "new-app");
  assert.equal(await readFile(join(paths.liveDependencies, "marker"), "utf8"), "new-deps");
  assert.equal(await readFile(join(paths.rollbackApp, "marker"), "utf8"), "old-app");
  assert.equal(await readFile(join(paths.rollbackDependencies, "marker"), "utf8"), "old-deps");
});

test("a dependency install rename failure restores the old app and dependencies", async (t) => {
  const paths = await swapFixture(t);
  let calls = 0;
  await assert.rejects(
    swapPreparedFiles(paths, async (from, to) => {
      calls += 1;
      if (calls === 4) throw new Error("injected dependency rename failure");
      await rename(from, to);
    }),
    /injected dependency rename failure/,
  );
  assert.equal(await readFile(join(paths.appPath, "marker"), "utf8"), "old-app");
  assert.equal(await readFile(join(paths.liveDependencies, "marker"), "utf8"), "old-deps");
  assert.equal(await readFile(join(paths.candidateApp, "marker"), "utf8"), "new-app");
  assert.equal(await readFile(join(paths.candidateDependencies, "marker"), "utf8"), "new-deps");
});
