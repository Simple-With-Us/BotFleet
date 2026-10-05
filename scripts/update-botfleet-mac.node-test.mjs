import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import {
  applicationAttachmentError,
  applicationIdentitiesCanTransition,
  SAFE_STORAGE_EXPORT_FLAG,
  shouldExportSafeStorageBeforeRename,
  authenticatedRuntimeError,
  bootOutHarnessForQuiesce,
  credentialPreparationReceiptPath,
  DEFAULT_PORTS,
  dependencyFingerprint,
  designatedRequirementFromOutput,
  fenceRuntimeAdmission,
  healthTopologyResult,
  harnessBootstrapPlist,
  harnessLaunchdLabel,
  isExpectedBotFleetProcess,
  launchAgentPlistLabel,
  loadPrepared,
  main,
  parseArguments,
  pendingRecoveryReceiptPath,
  quiesceBootoutLabels,
  rollbackHarnessBootoutLabels,
  rollbackHarnessBootstrapPlists,
  rollbackReadinessError,
  run,
  runtimePreflight,
  settledRunOutcome,
  signalProcess,
  stableApplicationProcessError,
  startedHarnessLabel,
  swapPreparedFiles,
  terminateVerified,
  validateBuiltBundle,
  waitForLaunchdBootout,
} from "./update-botfleet-mac.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));

test("a detached run is given a progress file and a run id to report under", () => {
  const parsed = parseArguments(["update", "--progress", "/tmp/state/run.json", "--run-id", "run_one"]);
  assert.equal(parsed.command, "update");
  // Resolved, like every other path option: the detached run is launched from
  // a working directory nobody chose, so a relative --progress would land
  // somewhere unpredictable.  `resolve` is what makes this assertion true on
  // Windows CI too, where the same absolute POSIX path gains a drive letter.
  assert.equal(parsed.progress, resolve("/tmp/state/run.json"));
  assert.equal(parsed.runId, "run_one");
  // A run id with nothing to write it to is a caller mistake, not a default.
  assert.throws(() => parseArguments(["update", "--run-id", "run_one"]), /--run-id requires --progress/);
  assert.throws(() => parseArguments(["update", "--progress", "/tmp/p", "--run-id", "../escape"]), /short identifier/);
  // The recovery action still takes nothing at all.
  assert.throws(() => parseArguments(["unquiesce", "--progress", "/tmp/p"]), /accepts no options/);
});

test("prepare and apply expose an explicit reusable stage", () => {
  assert.deepEqual(
    parseArguments(["prepare", "--target=abc", "--source", "/tmp/source", "--stage", "/tmp/stage"]),
    {
      command: "prepare",
      target: "abc",
      source: resolve("/tmp/source"),
      stage: resolve("/tmp/stage"),
      bundle: undefined,
      dependencies: undefined,
      openApplication: true,
      progress: undefined,
      runId: undefined,
    },
  );
  assert.deepEqual(parseArguments(["apply", "--stage", "/tmp/stage", "--no-open"]), {
    command: "apply",
    target: "origin/main",
    source: undefined,
    stage: resolve("/tmp/stage"),
    bundle: undefined,
    dependencies: undefined,
    openApplication: false,
    progress: undefined,
    runId: undefined,
  });
  assert.throws(() => parseArguments(["apply"]), /requires --stage/);
  assert.throws(() => parseArguments(["update", "--unknown"]), /Unknown option/);
  assert.throws(() => parseArguments(["prepare", "--bundle", "/tmp/app"]), /supplied together/);
  assert.equal(parseArguments(["unquiesce"]).command, "unquiesce");
  assert.throws(() => parseArguments(["unquiesce", "--no-open"]), /accepts no options/);
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
    resolve("/tmp/source/release/BotFleet.app"),
  );
});

test("prepared stages reject symlink directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "botfleet-update-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, "stage");
  const link = join(root, "stage-link");
  await mkdir(stage, { mode: 0o700 });
  await symlink(stage, link);
  await assert.rejects(loadPrepared(link), /must be a real directory/);
});

test("prepared stages reject public manifests", { skip: process.platform === "win32" ? "Mac updater requires POSIX ownership and modes" : false }, async (t) => {
  const stage = await mkdtemp(join(tmpdir(), "botfleet-update-stage-"));
  t.after(() => rm(stage, { recursive: true, force: true }));
  const manifest = join(stage, "prepared.json");
  await writeFile(manifest, "{}\n", { mode: 0o600 });
  await chmod(manifest, 0o644);
  await assert.rejects(loadPrepared(stage), /must not be accessible by group or other users/);
});

test("transition release loads stages prepared for either accepted bundle ID and rejects any other", { skip: process.platform === "win32" ? "Mac updater requires POSIX ownership and modes" : false }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "botfleet-update-stage-ids-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const writePreparedStage = async (name, bundleIdentifier) => {
    const stage = join(root, name);
    await mkdir(stage, { mode: 0o700 });
    await writeFile(join(stage, "prepared.json"), `${JSON.stringify({
      schemaVersion: 2,
      sourceCommit: "a".repeat(40),
      version: "1.0.0",
      apiVersion: 1,
      uiHash: "b".repeat(64),
      teamIdentifier: "CC8UTF7ATG",
      bundleIdentifier,
      designatedRequirement: "requirement",
      bundleName: "BotFleet.app",
      dependenciesName: "node_modules",
      dependencyFingerprint: "c".repeat(64),
    })}\n`, { mode: 0o600 });
    return stage;
  };
  // main still builds com.botfleet.app until the rename PR lands.
  assert.equal((await loadPrepared(await writePreparedStage("legacy", "com.botfleet.app"))).bundleIdentifier, "com.botfleet.app");
  assert.equal((await loadPrepared(await writePreparedStage("renamed", "app.botfleet.macos"))).bundleIdentifier, "app.botfleet.macos");
  await assert.rejects(loadPrepared(await writePreparedStage("other", "com.example.other")), /invalid identity/);
});

test("bundle validation rejects a symlink before trusting its contents", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "botfleet-update-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, "BotFleet.app");
  const link = join(root, "BotFleet-link.app");
  await mkdir(bundle);
  await symlink(bundle, link);
  await assert.rejects(validateBuiltBundle(link, "b".repeat(40)), /must be a real directory/);
});

test("dependency fingerprints cover package contents and symlink targets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "botfleet-update-dependencies-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dependencies = join(root, "node_modules");
  await mkdir(join(dependencies, ".pnpm"), { recursive: true });
  await mkdir(join(dependencies, "package"));
  await writeFile(join(dependencies, ".modules.yaml"), "layoutVersion: 5\n");
  await writeFile(join(dependencies, ".pnpm/lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(join(dependencies, "package/index.js"), "export const value = 1;\n");
  await symlink("package", join(dependencies, "package-link"));

  const original = await dependencyFingerprint(dependencies);
  await writeFile(join(dependencies, "package/index.js"), "export const value = 2;\n");
  const contentChanged = await dependencyFingerprint(dependencies);
  assert.notEqual(contentChanged, original);

  await rm(join(dependencies, "package-link"));
  await symlink("other-package", join(dependencies, "package-link"));
  assert.notEqual(await dependencyFingerprint(dependencies), contentChanged);
});

test("command results wait for output pipes to close", async () => {
  const script = `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", "setTimeout(() => process.stdout.write('late\\\\n'), 40)"], { stdio: ["ignore", 1, 2] });
    process.stdout.write("early\\n");
  `;
  const result = await run(process.execPath, ["-e", script]);
  assert.equal(result.stdout, "early\nlate\n");
});

test("designated requirement comparison excludes the bundle-specific executable path", () => {
  const requirement = 'designated => identifier "app.botfleet.macos" and certificate leaf[subject.OU] = CC8UTF7ATG';
  const installed = `Executable=/Applications/BotFleet.app/Contents/MacOS/BotFleet\n${requirement}\n`;
  const candidate = `Executable=/Applications/.BotFleet.update-123.app/Contents/MacOS/BotFleet\n${requirement}\n`;
  assert.equal(designatedRequirementFromOutput(installed), requirement);
  assert.equal(designatedRequirementFromOutput(candidate), requirement);
});

test("application identity transition accepts only the signed legacy app as the installed predecessor", () => {
  const current = {
    teamIdentifier: "CC8UTF7ATG",
    bundleIdentifier: "app.botfleet.macos",
    designatedRequirement: "current-requirement",
  };
  const legacy = {
    teamIdentifier: "CC8UTF7ATG",
    bundleIdentifier: "com.botfleet.app",
    designatedRequirement: "legacy-requirement",
  };
  assert.equal(applicationIdentitiesCanTransition(legacy, current), true);
  assert.equal(applicationIdentitiesCanTransition(current, current), true);
  assert.equal(applicationIdentitiesCanTransition({ ...legacy, teamIdentifier: "ATTACKER" }, current), false);
  assert.equal(applicationIdentitiesCanTransition({ ...legacy, bundleIdentifier: "com.example.other" }, current), false);
  assert.equal(applicationIdentitiesCanTransition(legacy, { ...current, bundleIdentifier: "com.botfleet.app" }), false);
  assert.equal(applicationIdentitiesCanTransition(current, { ...current, designatedRequirement: "changed" }), false);
});

test("transition release still accepts main's legacy-ID candidate over a legacy install, and never downgrades", () => {
  const legacy = {
    teamIdentifier: "CC8UTF7ATG",
    bundleIdentifier: "com.botfleet.app",
    designatedRequirement: "legacy-requirement",
  };
  const current = {
    teamIdentifier: "CC8UTF7ATG",
    bundleIdentifier: "app.botfleet.macos",
    designatedRequirement: "current-requirement",
  };
  // Until the rename lands, main builds com.botfleet.app: an ordinary
  // main-to-main update keeps the pre-transition same-requirement rule.
  assert.equal(applicationIdentitiesCanTransition(legacy, legacy), true);
  assert.equal(applicationIdentitiesCanTransition(legacy, { ...legacy, designatedRequirement: "changed" }), false);
  assert.equal(applicationIdentitiesCanTransition(legacy, { ...legacy, teamIdentifier: "ATTACKER" }), false);
  // A renamed install is never replaced by a legacy-ID candidate.
  assert.equal(applicationIdentitiesCanTransition(current, { ...legacy, designatedRequirement: current.designatedRequirement }), false);
  assert.equal(applicationIdentitiesCanTransition(current, legacy), false);
  // Any other bundle ID is rejected as a candidate.
  assert.equal(applicationIdentitiesCanTransition(legacy, { ...legacy, bundleIdentifier: "com.example.other" }), false);
});

test("safeStorage export runs only when the installed app is the legacy identity", () => {
  assert.equal(shouldExportSafeStorageBeforeRename("com.botfleet.app", "app.botfleet.macos"), true);
  assert.equal(shouldExportSafeStorageBeforeRename("app.botfleet.macos", "app.botfleet.macos"), false);
  assert.equal(shouldExportSafeStorageBeforeRename("com.botfleet.app", "com.botfleet.app"), false);
  assert.equal(SAFE_STORAGE_EXPORT_FLAG, "--export-safe-storage-migration");
});

test("the stable wrapper bootstraps updater policy from the fetched target", async () => {
  const source = await readFile(join(scripts, "update-botfleet.sh"), "utf8");
  assert.match(source, /BOOTSTRAP_REF="\$\{BOTFLEET_UPDATE_TARGET:-origin\/main\}"/);
  assert.match(source, /elif \[\[ "\$arg" == "--target" \]\]/);
  assert.match(source, /elif \[\[ "\$arg" == --target=\* \]\]/);
  assert.match(source, /BOOTSTRAP_REF="\$arg"/);
  assert.match(source, /UPDATER_ARGS\+=\(--target "\$BOTFLEET_UPDATE_TARGET"\)/);
  assert.ok(
    source.indexOf('BOOTSTRAP_REF="$arg"') < source.indexOf('git -C "$BOTFLEET_CHECKOUT" archive "$BOOTSTRAP_COMMIT"'),
    "--target must select updater policy before the target graph is archived",
  );
  assert.match(source, /git -C "\$BOTFLEET_CHECKOUT" archive "\$BOOTSTRAP_COMMIT"/);
  for (const path of [
    "scripts/update-botfleet-mac.mjs",
    "scripts/mac-update-transaction.mjs",
    "scripts/update-progress.mjs",
    "electron/update-credential-preparation.mjs",
  ]) {
    assert.match(source, new RegExp(path.replaceAll("/", "\\/")));
  }
  assert.match(source, /"\$NODE_BIN" "\$BOOTSTRAP_DIR\/scripts\/update-botfleet-mac.mjs"/);
  assert.ok(
    source.indexOf("git -C \"$BOTFLEET_CHECKOUT\" archive") < source.indexOf('if [[ -f "$LOCAL_IMPL" ]]'),
    "the target updater must run before either installed implementation",
  );
});

test("forced updates refresh the selected bootstrap ref before archiving it", async () => {
  const source = await readFile(join(scripts, "update-botfleet.sh"), "utf8");
  const forceCheck = source.indexOf('if [[ "${BOTFLEET_FORCE:-}" == "1" ]]');
  const targetSelection = source.indexOf('BOOTSTRAP_REF="${BOTFLEET_UPDATE_TARGET:-origin/main}"');
  const targetOverride = source.indexOf('BOOTSTRAP_REF="$arg"');
  const fetch = source.indexOf('git -C "$BOTFLEET_CHECKOUT" fetch --quiet origin "$BOOTSTRAP_FETCH_REF"');
  const archive = source.indexOf('git -C "$BOTFLEET_CHECKOUT" archive "$BOOTSTRAP_COMMIT"');

  assert.ok(forceCheck >= 0, "the regression must exercise the forced-update path");
  assert.ok(targetSelection > forceCheck, "bootstrap selection happens after the force skip");
  assert.ok(targetOverride > targetSelection, "--target keeps precedence over the environment");
  assert.ok(fetch > targetOverride, "the final selected ref must be known before fetching");
  assert.ok(archive > fetch, "the selected ref must be refreshed before it can be archived");
  assert.match(source, /BOOTSTRAP_FETCH_REF="\$\{BOOTSTRAP_REF#origin\/\}"/);
  assert.match(
    source,
    /if git -C "\$BOTFLEET_CHECKOUT" fetch --quiet origin "\$BOOTSTRAP_FETCH_REF" 2>\/dev\/null; then[\s\S]*?git -C "\$BOTFLEET_CHECKOUT" archive "\$BOOTSTRAP_COMMIT"/,
    "a failed refresh must not fall through to a stale local archive",
  );
});

test("the stable wrapper enforces origin/main ancestry before archiving or executing the bootstrap target", async () => {
  const source = await readFile(join(scripts, "update-botfleet.sh"), "utf8");
  const fetch = source.indexOf('git -C "$BOTFLEET_CHECKOUT" fetch --quiet origin "$BOOTSTRAP_FETCH_REF"');
  const mainRefresh = source.indexOf('git -C "$BOTFLEET_CHECKOUT" fetch --quiet origin main', fetch);
  const resolve = source.indexOf('BOOTSTRAP_COMMIT="$(git -C "$BOTFLEET_CHECKOUT" rev-parse --verify "${BOOTSTRAP_REF}^{commit}"', fetch);
  const ancestry = source.indexOf('merge-base --is-ancestor "$BOOTSTRAP_COMMIT" origin/main', fetch);
  const archive = source.indexOf('git -C "$BOTFLEET_CHECKOUT" archive "$BOOTSTRAP_COMMIT"');
  const exec = source.indexOf('"$NODE_BIN" "$BOOTSTRAP_DIR/scripts/update-botfleet-mac.mjs"');
  assert.ok(fetch >= 0, "the bootstrap target is fetched");
  assert.ok(mainRefresh > fetch, "origin/main is refreshed after the target fetch, as resolveTarget() does");
  assert.ok(resolve > mainRefresh, "the fetched commit is resolved before it is checked");
  assert.ok(ancestry > resolve, "the resolved commit is checked against origin/main");
  assert.ok(archive > ancestry, "no target code is archived before the ancestry check");
  assert.ok(exec > ancestry, "no target code is executed before the ancestry check");
  // Fail closed: rejection must exit, not fall through to an installed
  // implementation whose resolveTarget() may predate the ancestry rule.
  const rejection = source.indexOf("is not reachable from origin/main", ancestry);
  const rejectExit = source.indexOf("exit 1", ancestry);
  assert.ok(rejection > ancestry && rejection < archive, "an unmerged target is rejected with resolveTarget()'s reason");
  assert.ok(rejectExit > ancestry && rejectExit < archive, "rejection exits before any archive or exec of the target");
  assert.match(source, /\^\[0-9a-f\]\{40\}\$/);
});

test("the stable wrapper rejects an unmerged --target before running any of its code", { skip: process.platform === "win32" ? "the stable wrapper requires bash" : false }, async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "ubf-bootstrap-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const remote = join(fixture, "remote");
  const checkout = join(fixture, "checkout");
  const marker = join(fixture, "executed");
  await mkdir(remote, { recursive: true });
  const git = (cwd, args) => run("git", ["-C", cwd, ...args]);
  const writeUpdater = async (cwd, text) => {
    for (const path of [
      "scripts/update-botfleet-mac.mjs",
      "scripts/mac-update-transaction.mjs",
      "scripts/update-progress.mjs",
      "electron/update-credential-preparation.mjs",
    ]) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), path.endsWith("update-botfleet-mac.mjs") ? text : "// placeholder\n");
    }
  };
  const updater = (label) => `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, ${JSON.stringify(label)});\n`;
  await git(fixture, ["init", "-b", "main", "remote"]);
  await git(remote, ["config", "user.email", "test@example.com"]);
  await git(remote, ["config", "user.name", "Test"]);
  await writeUpdater(remote, updater("main"));
  await git(remote, ["add", "."]);
  await git(remote, ["commit", "-m", "main"]);
  // An unmerged ref: its updater code is not reachable from origin/main.
  await git(remote, ["checkout", "-b", "evil"]);
  await writeUpdater(remote, updater("evil"));
  await git(remote, ["add", "."]);
  await git(remote, ["commit", "-m", "evil"]);
  await git(remote, ["checkout", "main"]);
  await git(fixture, ["clone", "remote", "checkout"]);
  await git(checkout, ["config", "user.email", "test@example.com"]);
  await git(checkout, ["config", "user.name", "Test"]);

  const env = { BOTFLEET_CHECKOUT: checkout, BOTFLEET_FORCE: "1" };
  const rejected = await run("bash", [join(scripts, "update-botfleet.sh"), "--target", "origin/evil"], { env, allowFailure: true });
  assert.equal(rejected.code, 1, "an unmerged --target must be rejected");
  assert.match(rejected.stderr, /not reachable from origin\/main/);
  const mainCommit = (await run("git", ["-C", checkout, "rev-parse", "origin/main"])).stdout.trim();
  const evilCommit = (await run("git", ["-C", checkout, "rev-parse", "origin/evil"])).stdout.trim();
  assert.notEqual(evilCommit, mainCommit);
  const merged = await run("git", ["-C", checkout, "merge-base", "--is-ancestor", evilCommit, "origin/main"], { allowFailure: true });
  assert.notEqual(merged.code, 0, "the fixture's evil ref must actually be unmerged");
  assert.equal(await readFile(marker, "utf8").catch(() => null), null, "no archived updater code ran");

  const accepted = await run("bash", [join(scripts, "update-botfleet.sh"), "--target", "origin/main"], { env, allowFailure: true });
  assert.equal(accepted.code, 0, `a merged --target still bootstraps: ${accepted.stderr}`);
  assert.equal(await readFile(marker, "utf8"), "main", "the archived updater from the merged target ran");
});

test("the stable wrapper resolves a revision-expression --target instead of fetching it as a refspec", { skip: process.platform === "win32" ? "the stable wrapper requires bash" : false }, async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "ubf-revexpr-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const remote = join(fixture, "remote");
  const checkout = join(fixture, "checkout");
  const marker = join(fixture, "executed.json");
  await mkdir(remote, { recursive: true });
  const git = (cwd, args) => run("git", ["-C", cwd, ...args]);
  const writeUpdater = async (cwd, label) => {
    for (const path of [
      "scripts/update-botfleet-mac.mjs",
      "scripts/mac-update-transaction.mjs",
      "scripts/update-progress.mjs",
      "electron/update-credential-preparation.mjs",
    ]) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), path.endsWith("update-botfleet-mac.mjs")
        ? `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({ label: ${JSON.stringify(label)}, args: process.argv.slice(2) }));\n`
        : "// placeholder\n");
    }
  };
  await git(fixture, ["init", "-b", "main", "remote"]);
  await git(remote, ["config", "user.email", "test@example.com"]);
  await git(remote, ["config", "user.name", "Test"]);
  await writeUpdater(remote, "older");
  await git(remote, ["add", "."]);
  await git(remote, ["commit", "-m", "older"]);
  await writeUpdater(remote, "newer");
  await git(remote, ["add", "."]);
  await git(remote, ["commit", "-m", "newer"]);
  await git(fixture, ["clone", "remote", "checkout"]);
  const olderCommit = (await git(remote, ["rev-parse", "main~1"])).stdout.trim();
  const newerCommit = (await git(remote, ["rev-parse", "main"])).stdout.trim();

  const wrapper = join(scripts, "update-botfleet.sh");
  const env = { BOTFLEET_CHECKOUT: checkout, BOTFLEET_FORCE: "1" };
  // origin/main~1 is not a fetchable refspec.  Fetching it verbatim fails and
  // falls through to the checkout's installed (newer) updater; the wrapper must
  // instead fetch main and run the target's own (older) updater policy.
  const parent = await run("bash", [wrapper, "--target", "origin/main~1"], { env, allowFailure: true });
  assert.equal(parent.code, 0, `origin/main~1 bootstraps: ${parent.stderr}`);
  assert.doesNotMatch(parent.stderr, /using the installed implementation/);
  assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), { label: "older", args: ["--target", olderCommit] });

  await rm(marker, { force: true });
  const peeled = await run("bash", [wrapper, "--target=origin/main^{commit}"], { env, allowFailure: true });
  assert.equal(peeled.code, 0, `origin/main^{commit} bootstraps: ${peeled.stderr}`);
  assert.doesNotMatch(peeled.stderr, /using the installed implementation/);
  assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), { label: "newer", args: ["--target", newerCommit] });
});

test("unquiesce ignores update targets and bootstraps the recovery from origin/main", { skip: process.platform === "win32" ? "the stable wrapper requires bash" : false }, async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "ubf-unquiesce-target-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const remote = join(fixture, "remote");
  const checkout = join(fixture, "checkout");
  const marker = join(fixture, "executed.json");
  await mkdir(remote, { recursive: true });
  const git = (cwd, args) => run("git", ["-C", cwd, ...args]);
  const writeUpdater = async (cwd, label) => {
    for (const path of [
      "scripts/update-botfleet-mac.mjs",
      "scripts/mac-update-transaction.mjs",
      "scripts/update-progress.mjs",
      "electron/update-credential-preparation.mjs",
    ]) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), path.endsWith("update-botfleet-mac.mjs")
        ? `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({ label: ${JSON.stringify(label)}, args: process.argv.slice(2) }));\n`
        : "// placeholder\n");
    }
  };
  await git(fixture, ["init", "-b", "main", "remote"]);
  await git(remote, ["config", "user.email", "test@example.com"]);
  await git(remote, ["config", "user.name", "Test"]);
  await writeUpdater(remote, "main");
  await git(remote, ["add", "."]);
  await git(remote, ["commit", "-m", "main"]);
  // An unmerged ref, left over as BOTFLEET_UPDATE_TARGET from an interrupted
  // targeted update; the ancestry check refuses its updater code.
  await git(remote, ["checkout", "-b", "fenced"]);
  await writeUpdater(remote, "fenced");
  await git(remote, ["add", "."]);
  await git(remote, ["commit", "-m", "fenced"]);
  await git(remote, ["checkout", "main"]);
  await git(fixture, ["clone", "remote", "checkout"]);

  const wrapper = join(scripts, "update-botfleet.sh");
  const env = { BOTFLEET_CHECKOUT: checkout, BOTFLEET_FORCE: "1", BOTFLEET_UPDATE_TARGET: "origin/fenced" };
  // The recovery action must release admission even while the environment
  // names the unmerged ref: it bootstraps origin/main's updater instead.
  const recovered = await run("bash", [wrapper, "unquiesce"], { env, allowFailure: true });
  assert.equal(recovered.code, 0, `unquiesce recovers: ${recovered.stderr}`);
  assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), {
    label: "main",
    args: ["unquiesce"],
  }, "unquiesce bootstraps origin/main's updater and stays option-free");

  // The same env target still gates a plain update run.
  await rm(marker, { force: true });
  const rejected = await run("bash", [wrapper], { env, allowFailure: true });
  assert.equal(rejected.code, 1, "an unmerged env target is still refused for updates");
  assert.match(rejected.stderr, /not reachable from origin\/main/);
  assert.equal(await readFile(marker, "utf8").catch(() => null), null, "no updater code ran for the refused target");
});


test("the stable wrapper resolves env and equals-form targets to the pinned validated commit", { skip: process.platform === "win32" ? "the stable wrapper requires bash" : false }, async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "ubf-target-passthrough-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const remote = join(fixture, "remote");
  const checkout = join(fixture, "checkout");
  const marker = join(fixture, "executed.json");
  await mkdir(remote, { recursive: true });
  const git = (cwd, args) => run("git", ["-C", cwd, ...args]);
  const writeUpdater = async (cwd, label) => {
    for (const path of [
      "scripts/update-botfleet-mac.mjs",
      "scripts/mac-update-transaction.mjs",
      "scripts/update-progress.mjs",
      "electron/update-credential-preparation.mjs",
    ]) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), path.endsWith("update-botfleet-mac.mjs")
        ? `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({ label: ${JSON.stringify(label)}, args: process.argv.slice(2) }));\n`
        : "// placeholder\n");
    }
  };
  await git(fixture, ["init", "-b", "main", "remote"]);
  await git(remote, ["config", "user.email", "test@example.com"]);
  await git(remote, ["config", "user.name", "Test"]);
  await writeUpdater(remote, "env-target");
  await git(remote, ["add", "."]);
  await git(remote, ["commit", "-m", "env target"]);
  await git(remote, ["branch", "env-target"]);
  await writeUpdater(remote, "main");
  await git(remote, ["add", "."]);
  await git(remote, ["commit", "-m", "main advances"]);
  await git(fixture, ["clone", "remote", "checkout"]);
  const envTargetCommit = (await git(checkout, ["rev-parse", "origin/env-target"])).stdout.trim();
  const mainCommit = (await git(checkout, ["rev-parse", "origin/main"])).stdout.trim();
  const wrapper = join(scripts, "update-botfleet.sh");
  const env = { BOTFLEET_CHECKOUT: checkout, BOTFLEET_FORCE: "1", BOTFLEET_UPDATE_TARGET: "origin/env-target" };

  const envRun = await run("bash", [wrapper], { env, allowFailure: true });
  assert.equal(envRun.code, 0, envRun.stderr);
  assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), {
    label: "env-target",
    args: ["--target", envTargetCommit],
  });

  const equalsRun = await run("bash", [wrapper, "--target=origin/main"], { env, allowFailure: true });
  assert.equal(equalsRun.code, 0, equalsRun.stderr);
  assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), {
    label: "main",
    args: ["--target", mainCommit],
  });
});

test("the stable wrapper builds the commit it validated, even when main moves mid-run", { skip: process.platform === "win32" ? "the stable wrapper requires bash" : false }, async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "ubf-pinned-target-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const remote = join(fixture, "remote");
  const checkout = join(fixture, "checkout");
  const marker = join(fixture, "executed.json");
  await mkdir(remote, { recursive: true });
  const git = (cwd, args) => run("git", ["-C", cwd, ...args]);
  for (const path of [
    "scripts/update-botfleet-mac.mjs",
    "scripts/mac-update-transaction.mjs",
    "scripts/update-progress.mjs",
    "electron/update-credential-preparation.mjs",
  ]) {
    await mkdir(dirname(join(remote, path)), { recursive: true });
    await writeFile(join(remote, path), path.endsWith("update-botfleet-mac.mjs")
      ? `import { execFileSync } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nexecFileSync("git", ["-C", process.env.UBF_FIXTURE_REMOTE, "commit", "--allow-empty", "-m", "raced"]);\nexecFileSync("git", ["-C", process.env.BOTFLEET_CHECKOUT, "fetch", "--quiet", "origin", "main"]);\nconst moved = execFileSync("git", ["-C", process.env.BOTFLEET_CHECKOUT, "rev-parse", "origin/main"], { encoding: "utf8" }).trim();\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({ label: "main", args: process.argv.slice(2), moved }));\n`
      : "// placeholder\n");
  }
  await git(fixture, ["init", "-b", "main", "remote"]);
  await git(remote, ["config", "user.email", "test@example.com"]);
  await git(remote, ["config", "user.name", "Test"]);
  await git(remote, ["add", "."]);
  await git(remote, ["commit", "-m", "updater"]);
  const validatedCommit = (await git(remote, ["rev-parse", "HEAD"])).stdout.trim();
  await git(fixture, ["clone", "remote", "checkout"]);
  const wrapper = join(scripts, "update-botfleet.sh");
  // The stub updater advances origin/main and re-fetches it, exactly the
  // window in which resolveTarget() would resolve a newer main than the
  // policy the wrapper archived.  The run must still build the validated
  // commit.
  const env = { BOTFLEET_CHECKOUT: checkout, BOTFLEET_FORCE: "1", UBF_FIXTURE_REMOTE: remote };
  const result = await run("bash", [wrapper], { env, allowFailure: true });
  assert.equal(result.code, 0, result.stderr);
  const executed = JSON.parse(await readFile(marker, "utf8"));
  assert.equal(executed.label, "main", "policy came from the validated commit");
  assert.notEqual(executed.moved, validatedCommit, "the fixture must actually move origin/main mid-run");
  assert.deepEqual(executed.args, ["--target", validatedCommit], "the candidate is pinned to the validated commit, not the moved origin/main");

  // A full commit SHA is itself a valid --target: it resolves locally and
  // passes the same origin/main ancestry check.
  await rm(marker, { force: true });
  const shaRun = await run("bash", [wrapper, "--target", validatedCommit], { env, allowFailure: true });
  assert.equal(shaRun.code, 0, shaRun.stderr);
  assert.deepEqual(JSON.parse(await readFile(marker, "utf8")).args, ["--target", validatedCommit]);
});

test("resolveTarget accepts a full commit SHA on main", async () => {
  const source = await readFile(join(scripts, "update-botfleet-mac.mjs"), "utf8");
  const resolveTarget = source.indexOf("resolveTarget: async (plan) => {");
  assert.ok(resolveTarget >= 0);
  const body = source.slice(resolveTarget, source.indexOf("prepareSource:", resolveTarget));
  // It fetches origin/main, never the target ref: a bare SHA needs no fetch
  // of its own, resolves locally, and passes the same ancestry check.
  assert.match(body, /\["fetch", "origin", "main"\]/);
  assert.doesNotMatch(body, /\["fetch", "origin", plan\.target\]/);
  assert.match(body, /rev-parse", "--verify", `\$\{plan\.target\}\^\{commit\}`/);
  assert.match(body, /merge-base", "--is-ancestor", commit, "origin\/main"/);
});

test("the stable wrapper expands UPDATER_ARGS with the bash 3.2 safe form", async () => {
  const source = await readFile(join(scripts, "update-botfleet.sh"), "utf8");
  // Stock macOS /bin/bash is 3.2, where expanding an EMPTY array under
  // `set -u` fails with "unbound variable". That kills the no-argument
  // in-app update path (electron/updater.mjs spawns the wrapper with no
  // args and no BOTFLEET_UPDATE_TARGET, leaving UPDATER_ARGS empty), so
  // every expansion must carry the `${UPDATER_ARGS[@]+...}` guard. CI bash
  // is newer and cannot reproduce the 3.2 failure, so this asserts the
  // guarded form directly instead of observing the error.
  assert.doesNotMatch(source, /(?<!\+)"\$\{UPDATER_ARGS\[@\]\}"/);
  assert.match(source, /\$\{UPDATER_ARGS\[@\]\+"\$\{UPDATER_ARGS\[@\]\}"\}/);
});

test("the stable wrapper runs with no arguments and no update target", { skip: process.platform === "win32" ? "the stable wrapper requires bash" : false }, async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "ubf-no-args-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const remote = join(fixture, "remote");
  const checkout = join(fixture, "checkout");
  const marker = join(fixture, "executed.json");
  await mkdir(remote, { recursive: true });
  const git = (cwd, args) => run("git", ["-C", cwd, ...args]);
  for (const path of [
    "scripts/update-botfleet-mac.mjs",
    "scripts/mac-update-transaction.mjs",
    "scripts/update-progress.mjs",
    "electron/update-credential-preparation.mjs",
  ]) {
    await mkdir(dirname(join(remote, path)), { recursive: true });
    await writeFile(join(remote, path), path.endsWith("update-botfleet-mac.mjs")
      ? `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({ args: process.argv.slice(2) }));\n`
      : "// placeholder\n");
  }
  await git(fixture, ["init", "-b", "main", "remote"]);
  await git(remote, ["config", "user.email", "test@example.com"]);
  await git(remote, ["config", "user.name", "Test"]);
  await git(remote, ["add", "."]);
  await git(remote, ["commit", "-m", "updater"]);
  await git(fixture, ["clone", "remote", "checkout"]);
  const mainCommit = (await git(checkout, ["rev-parse", "origin/main"])).stdout.trim();
  // No positional arguments and no BOTFLEET_UPDATE_TARGET: UPDATER_ARGS
  // stays empty, the exact shape electron/updater.mjs spawns for the
  // no-argument in-app update. On bash >= 4.4 this passes even without the
  // guarded expansion; on bash 3.2 it exercises the path that used to exit
  // with "unbound variable" before the updater ran.  The bootstrapped
  // updater receives the validated commit, not the symbolic origin/main.
  const result = await run("bash", [join(scripts, "update-botfleet.sh")], {
    env: { BOTFLEET_CHECKOUT: checkout, BOTFLEET_FORCE: "1" },
    allowFailure: true,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), { args: ["--target", mainCommit] });
});

test("the stable wrapper detects a linked worktree checkout, where .git is a file", { skip: process.platform === "win32" ? "the stable wrapper requires bash" : false }, async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "ubf-worktree-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const remote = join(fixture, "remote");
  const primary = join(fixture, "primary");
  const checkout = join(fixture, "checkout");
  const marker = join(fixture, "executed.json");
  await mkdir(remote, { recursive: true });
  const git = (cwd, args) => run("git", ["-C", cwd, ...args]);
  for (const path of [
    "scripts/update-botfleet-mac.mjs",
    "scripts/mac-update-transaction.mjs",
    "scripts/update-progress.mjs",
    "electron/update-credential-preparation.mjs",
  ]) {
    await mkdir(dirname(join(remote, path)), { recursive: true });
    await writeFile(join(remote, path), path.endsWith("update-botfleet-mac.mjs")
      ? `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({ label: "bootstrapped", args: process.argv.slice(2) }));\n`
      : "// placeholder\n");
  }
  await git(fixture, ["init", "-b", "main", "remote"]);
  await git(remote, ["config", "user.email", "test@example.com"]);
  await git(remote, ["config", "user.name", "Test"]);
  await git(remote, ["add", "."]);
  await git(remote, ["commit", "-m", "updater"]);
  await git(fixture, ["clone", "remote", "primary"]);
  // The owner's checkout is a linked worktree of another clone, so its .git
  // is a gitdir pointer file rather than a directory.
  await git(primary, ["worktree", "add", "--detach", checkout, "origin/main"]);
  assert.ok((await stat(join(checkout, ".git"))).isFile(), "the fixture checkout's .git must be a file");
  const wrapper = join(scripts, "update-botfleet.sh");

  // Up-to-date check: the worktree is already at origin/main, so an unforced
  // run must short-circuit instead of running any updater.
  const current = await run("bash", [wrapper], { env: { BOTFLEET_CHECKOUT: checkout }, allowFailure: true });
  assert.equal(current.code, 0, current.stderr);
  assert.match(current.stdout, /Already at .*Nothing to update/);
  assert.equal(await readFile(marker, "utf8").catch(() => null), null, "an up-to-date worktree runs no updater");

  // Bootstrap: a forced run must archive and run the target's updater from
  // the worktree, not fall back to the installed implementation.
  const forced = await run("bash", [wrapper], { env: { BOTFLEET_CHECKOUT: checkout, BOTFLEET_FORCE: "1" }, allowFailure: true });
  assert.equal(forced.code, 0, forced.stderr);
  assert.doesNotMatch(forced.stderr, /using the installed implementation/);
  const mainCommit = (await git(checkout, ["rev-parse", "origin/main"])).stdout.trim();
  assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), { label: "bootstrapped", args: ["--target", mainCommit] });
});

test("the up-to-date shortcut only swallows a plain update to origin/main", { skip: process.platform === "win32" ? "the stable wrapper requires bash" : false }, async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "ubf-shortcut-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const remote = join(fixture, "remote");
  const checkout = join(fixture, "checkout");
  const marker = join(fixture, "executed.json");
  await mkdir(remote, { recursive: true });
  const git = (cwd, args) => run("git", ["-C", cwd, ...args]);
  const writeUpdater = async (label) => {
    for (const path of [
      "scripts/update-botfleet-mac.mjs",
      "scripts/mac-update-transaction.mjs",
      "scripts/update-progress.mjs",
      "electron/update-credential-preparation.mjs",
    ]) {
      await mkdir(dirname(join(remote, path)), { recursive: true });
      await writeFile(join(remote, path), path.endsWith("update-botfleet-mac.mjs")
        ? `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({ label: ${JSON.stringify(label)}, args: process.argv.slice(2) }));\n`
        : "// placeholder\n");
    }
  };
  await git(fixture, ["init", "-b", "main", "remote"]);
  await git(remote, ["config", "user.email", "test@example.com"]);
  await git(remote, ["config", "user.name", "Test"]);
  // An older commit that is still reachable from main: a legitimate non-main
  // target the ancestry rule accepts.
  await writeUpdater("older");
  await git(remote, ["add", "."]);
  await git(remote, ["commit", "-m", "older"]);
  await git(remote, ["branch", "older"]);
  await writeUpdater("main");
  await git(remote, ["add", "."]);
  await git(remote, ["commit", "-m", "main"]);
  await git(fixture, ["clone", "remote", "checkout"]);
  const mainCommit = (await git(checkout, ["rev-parse", "origin/main"])).stdout.trim();
  const olderCommit = (await git(checkout, ["rev-parse", "origin/older"])).stdout.trim();
  assert.equal((await git(checkout, ["rev-parse", "HEAD"])).stdout.trim(), mainCommit, "the fixture checkout must be at origin/main");
  const stage = join(fixture, "stage");
  await mkdir(stage, { recursive: true });
  await writeFile(join(stage, "prepared.json"), JSON.stringify({ sourceCommit: mainCommit }));
  const wrapper = join(scripts, "update-botfleet.sh");
  // No BOTFLEET_FORCE anywhere below: every run sees HEAD == origin/main.
  const invoke = async (args, extraEnv = {}) => {
    await rm(marker, { force: true });
    const result = await run("bash", [wrapper, ...args], { env: { BOTFLEET_CHECKOUT: checkout, ...extraEnv }, allowFailure: true });
    const executed = await readFile(marker, "utf8").then(JSON.parse, () => null);
    return { ...result, executed };
  };

  for (const args of [[], ["update"], ["update", "--no-open"], ["--target", "origin/main"], ["--target=origin/main"]]) {
    const result = await invoke(args);
    assert.equal(result.code, 0, `${JSON.stringify(args)}: ${result.stderr}`);
    assert.match(result.stdout, /Already at .*Nothing to update/, `${JSON.stringify(args)} is a plain update and should short-circuit`);
    assert.equal(result.executed, null, `${JSON.stringify(args)} ran an updater`);
  }

  // Commands that resolve a candidate get it pinned to the commit the
  // wrapper validated; apply keeps its stage manifest target and unquiesce
  // stays option-free.
  const mustRun = [
    // The admission recovery action must release the fence even when current.
    { args: ["unquiesce"], expected: { label: "main", args: ["unquiesce"] } },
    { args: ["prepare"], expected: { label: "main", args: ["prepare", "--target", mainCommit] } },
    { args: ["apply", "--stage", stage], expected: { label: "main", args: ["apply", "--stage", stage] } },
    { args: ["--target", "origin/older"], expected: { label: "older", args: ["--target", olderCommit] } },
    { args: ["--target=origin/older"], expected: { label: "older", args: ["--target", olderCommit] } },
    { args: [], env: { BOTFLEET_UPDATE_TARGET: "origin/older" }, expected: { label: "older", args: ["--target", olderCommit] } },
    // The harness's detached run needs the updater's progress record.
    {
      args: ["update", "--progress", join(fixture, "run.json"), "--run-id", "run_one"],
      expected: { label: "main", args: ["update", "--progress", join(fixture, "run.json"), "--run-id", "run_one", "--target", mainCommit] },
    },
  ];
  for (const { args, env = {}, expected } of mustRun) {
    const label = `${JSON.stringify(args)} ${JSON.stringify(env)}`;
    const result = await invoke(args, env);
    assert.equal(result.code, 0, `${label}: ${result.stderr}`);
    assert.doesNotMatch(result.stdout, /Already at/, `${label} must not short-circuit at origin/main`);
    assert.deepEqual(result.executed, expected, `${label} must reach the bootstrapped updater`);
  }
});

test("the stable wrapper does not test for a .git directory to find the checkout", async () => {
  const source = await readFile(join(scripts, "update-botfleet.sh"), "utf8");
  assert.doesNotMatch(source, /-d "\$BOTFLEET_CHECKOUT\/\.git"/);
  assert.match(source, /git -C "\$BOTFLEET_CHECKOUT" rev-parse --git-dir/);
});

test("apply bootstraps the updater recorded in the stage manifest, not a newer origin/main", { skip: process.platform === "win32" ? "the stable wrapper requires bash" : false }, async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "ubf-stage-bootstrap-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const remote = join(fixture, "remote");
  const checkout = join(fixture, "checkout");
  const marker = join(fixture, "executed");
  await mkdir(remote, { recursive: true });
  const git = (cwd, args) => run("git", ["-C", cwd, ...args]);
  const writeUpdater = async (cwd, label) => {
    for (const path of [
      "scripts/update-botfleet-mac.mjs",
      "scripts/mac-update-transaction.mjs",
      "scripts/update-progress.mjs",
      "electron/update-credential-preparation.mjs",
    ]) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), path.endsWith("update-botfleet-mac.mjs")
        ? `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, ${JSON.stringify(label)});\n`
        : "// placeholder\n");
    }
  };
  const commit = async (cwd, label) => {
    await writeUpdater(cwd, label);
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", label]);
    return (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
  };
  const writeStage = async (name, manifest) => {
    const stage = join(fixture, name);
    await mkdir(stage, { recursive: true, mode: 0o700 });
    await writeFile(join(stage, "prepared.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest), { mode: 0o600 });
    return stage;
  };
  await git(fixture, ["init", "-b", "main", "remote"]);
  await git(remote, ["config", "user.email", "test@example.com"]);
  await git(remote, ["config", "user.name", "Test"]);
  // The stage is prepared at X ...
  const preparedCommit = await commit(remote, "prepared");
  await git(fixture, ["clone", "remote", "checkout"]);
  const stage = await writeStage("stage", { schemaVersion: 2, sourceCommit: preparedCommit });
  // ... and main moves past X before apply runs.
  const advancedCommit = await commit(remote, "advanced");
  await git(remote, ["checkout", "-b", "evil"]);
  const evilCommit = await commit(remote, "evil");
  await git(remote, ["checkout", "main"]);
  assert.notEqual(advancedCommit, preparedCommit);

  const env = { BOTFLEET_CHECKOUT: checkout, BOTFLEET_FORCE: "1", BOTFLEET_UPDATE_TARGET: "" };
  const wrapper = join(scripts, "update-botfleet.sh");
  const applied = await run("bash", [wrapper, "apply", "--stage", stage], { env, allowFailure: true });
  assert.equal(applied.code, 0, `apply bootstraps: ${applied.stderr}`);
  assert.equal(
    (await git(checkout, ["rev-parse", "origin/main"])).stdout.trim(),
    advancedCommit,
    "the wrapper refreshed origin/main past the prepared commit",
  );
  assert.equal(await readFile(marker, "utf8"), "prepared", "apply ran the prepared commit's updater, not advanced main's");

  // Same ancestry rule as --target: a manifest naming an unmerged commit
  // never supplies updater policy.
  await rm(marker, { force: true });
  await git(checkout, ["fetch", "--quiet", "origin", "evil"]);
  const evilStage = await writeStage("evil-stage", { schemaVersion: 2, sourceCommit: evilCommit });
  const rejected = await run("bash", [wrapper, "apply", "--stage", evilStage], { env, allowFailure: true });
  assert.equal(rejected.code, 1, "an unmerged stage commit must be rejected");
  assert.match(rejected.stderr, /not reachable from origin\/main/);
  assert.equal(await readFile(marker, "utf8").catch(() => null), null, "no updater code ran for the unmerged stage");

  // A stage without a readable source commit fails closed instead of falling
  // back to origin/main or the installed implementation.
  const brokenStage = await writeStage("broken-stage", "{ not json");
  const broken = await run("bash", [wrapper, "apply", "--stage", brokenStage], { env, allowFailure: true });
  assert.equal(broken.code, 1, "an unreadable manifest must be rejected");
  assert.match(broken.stderr, /does not record a full source commit/);
  assert.equal(await readFile(marker, "utf8").catch(() => null), null, "no updater code ran for the unreadable stage");
});

test("rollback boots out the legacy label when startHarness bootstrapped the legacy plist", () => {
  const config = {
    label: "app.botfleet.server",
    plist: "/Users/test/Library/LaunchAgents/app.botfleet.server.plist",
    legacyLabel: "com.jay.botfleet-server",
    legacyPlist: "/Users/test/Library/LaunchAgents/com.jay.botfleet-server.plist",
  };
  // Legacy-only Mac: the fallback bootstraps the legacy-named plist.  Its job
  // may run under either label (a Mac migrated in place declares the renamed
  // one in that file); the path mapping assumes the legacy label, and rollback
  // boots out the renamed label regardless, so both are covered.
  const started = harnessBootstrapPlist(config, { plistExists: false, legacyPlistExists: true });
  assert.equal(started, config.legacyPlist);
  assert.equal(harnessLaunchdLabel(config, started), config.legacyLabel);
  // If verification then fails, rollback must boot out that label too, or
  // its KeepAlive restarts the failed replacement mid-rollback.
  const previous = { launchdLoaded: false, legacyLaunchdLoaded: true, startedHarnessLabel: harnessLaunchdLabel(config, started) };
  assert.deepEqual(rollbackHarnessBootoutLabels(config, previous), [config.label, config.legacyLabel]);
  // The renamed plist starts the renamed label; nothing extra to boot out.
  assert.equal(harnessLaunchdLabel(config, config.plist), config.label);
  assert.deepEqual(rollbackHarnessBootoutLabels(config, { startedHarnessLabel: config.label }), [config.label]);
  // Failure before startHarness: only the renamed label, as before.
  assert.deepEqual(rollbackHarnessBootoutLabels(config, {}), [config.label]);
  // Quiesce can throw while booting out the legacy label, before startHarness
  // records startedHarnessLabel.  Rollback must still retry the legacy
  // bootout from the recorded launchd state, or the legacy job's KeepAlive
  // restarts the harness mid-rollback.
  assert.deepEqual(
    rollbackHarnessBootoutLabels(config, { launchdLoaded: true, legacyLaunchdLoaded: true }),
    [config.label, config.legacyLabel],
  );
  assert.deepEqual(
    rollbackHarnessBootoutLabels(config, { launchdLoaded: false, legacyLaunchdLoaded: true }),
    [config.label, config.legacyLabel],
  );
});

test("startHarness records the Label a custom startup plist declares, not the path mapping", async () => {
  const config = {
    label: "app.botfleet.server",
    plist: "/Users/test/custom/botfleet.plist",
    customPlist: true,
    legacyLabel: "com.jay.botfleet-server",
    legacyPlist: "/Users/test/Library/LaunchAgents/com.jay.botfleet-server.plist",
  };
  const reads = [];
  const declares = (label) => async (plist) => { reads.push(plist); return label; };
  // A custom BOTFLEET_LAUNCH_AGENT_PLIST carrying the legacy Label starts
  // com.jay.botfleet-server even though its path maps to the renamed label.
  assert.equal(harnessLaunchdLabel(config, config.plist), config.label);
  const started = await startedHarnessLabel(config, config.plist, declares(config.legacyLabel));
  assert.equal(started, config.legacyLabel);
  assert.deepEqual(reads, [config.plist]);
  // With that label not loaded at capture, rollback must still boot it out,
  // or its KeepAlive restarts the failed replacement mid-rollback.
  assert.deepEqual(
    rollbackHarnessBootoutLabels(config, { launchdLoaded: false, legacyLaunchdLoaded: false, startedHarnessLabel: started }),
    [config.label, config.legacyLabel],
  );
  // A custom plist declaring the renamed label records the renamed label.
  assert.equal(await startedHarnessLabel(config, config.plist, declares(config.label)), config.label);
  // An unreadable Label falls back to the path mapping.
  assert.equal(await startedHarnessLabel(config, config.plist, declares(null)), config.label);
  // The legacy fallback plist is not custom; it keeps the legacy label without a read.
  reads.length = 0;
  assert.equal(await startedHarnessLabel(config, config.legacyPlist, declares("unexpected")), config.legacyLabel);
  assert.deepEqual(reads, []);
  // Without a custom plist the path mapping stands and nothing is read.
  const defaults = { ...config, customPlist: false, plist: "/Users/test/Library/LaunchAgents/app.botfleet.server.plist" };
  assert.equal(await startedHarnessLabel(defaults, defaults.plist, declares(config.legacyLabel)), config.label);
  assert.deepEqual(reads, []);
});

test("quiesce boots out each loaded label exactly once, even when the renamed label is the legacy label", () => {
  const config = { label: "app.botfleet.server", legacyLabel: "com.jay.botfleet-server" };
  assert.deepEqual(quiesceBootoutLabels(config, { launchdLoaded: true, legacyLaunchdLoaded: true }), [config.label, config.legacyLabel]);
  assert.deepEqual(quiesceBootoutLabels(config, { launchdLoaded: true, legacyLaunchdLoaded: false }), [config.label]);
  assert.deepEqual(quiesceBootoutLabels(config, { launchdLoaded: false, legacyLaunchdLoaded: true }), [config.legacyLabel]);
  assert.deepEqual(quiesceBootoutLabels(config, { launchdLoaded: false, legacyLaunchdLoaded: false }), []);
  // BOTFLEET_LAUNCH_AGENT_LABEL may name the legacy label itself; the
  // bootout must still run, exactly once, or the update installs over a live
  // harness.
  const aliased = { label: "com.jay.botfleet-server", legacyLabel: "com.jay.botfleet-server" };
  assert.deepEqual(quiesceBootoutLabels(aliased, { launchdLoaded: true, legacyLaunchdLoaded: true }), ["com.jay.botfleet-server"]);
  assert.deepEqual(quiesceBootoutLabels(aliased, { launchdLoaded: false, legacyLaunchdLoaded: true }), ["com.jay.botfleet-server"]);
});

test("rollback confirms a bootout label is absent, retrying a slow teardown within a bounded window", async () => {
  // Already gone: launchctl print exits nonzero on the first probe.
  assert.equal(await waitForLaunchdBootout("gui/501", "app.botfleet.server", { probe: async () => ({ code: 1 }) }), true);
  // Still loaded, then torn down: retry until print fails.
  let probes = 0;
  const waits = [];
  const cleared = await waitForLaunchdBootout("gui/501", "app.botfleet.server", {
    probe: async () => { probes += 1; return { code: probes < 3 ? 0 : 1 }; },
    wait: async (ms) => { waits.push(ms); },
  });
  assert.equal(cleared, true);
  assert.equal(probes, 3);
  assert.equal(waits.length, 2, "no wait after the probe that confirms absence");
  // Never torn down: the window stays bounded and reports failure.
  let stuckProbes = 0;
  const stuck = await waitForLaunchdBootout("gui/501", "com.jay.botfleet-server", {
    attempts: 4,
    probe: async () => { stuckProbes += 1; return { code: 0 }; },
    wait: async () => {},
  });
  assert.equal(stuck, false);
  assert.equal(stuckProbes, 4, "a surviving job is retried, not awaited forever");
});

// A process table for terminateVerified.  Each entry is { command, cwd, alive }
// plus optional hooks: exitDuringPs and exitDuringLsof end the process while
// that inspection is still running, which is the window a loaded Mac (load
// average 200-400) leaves open for seconds; ignoresTerm survives SIGTERM and
// killError makes the signal itself fail.
function processTable(entries) {
  const table = new Map(Object.entries(entries).map(([pid, entry]) => [Number(pid), { alive: true, ...entry }]));
  const signals = [];
  const deps = {
    isAlive: (pid) => table.get(pid)?.alive === true,
    commandOf: async (pid) => {
      const entry = table.get(pid);
      if (!entry?.alive) return "";
      if (entry.exitDuringPs) { entry.alive = false; return ""; }
      return entry.command;
    },
    cwdOf: async (pid) => {
      const entry = table.get(pid);
      if (!entry?.alive) return "";
      if (entry.exitDuringLsof) entry.alive = false;
      return entry.cwd;
    },
    kill: (pid, signal) => {
      const entry = table.get(pid);
      if (entry?.killError) throw entry.killError;
      if (!entry?.alive) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH", errno: -3, syscall: "kill" });
      signals.push([pid, signal]);
      if (signal === "SIGTERM" && !entry.ignoresTerm) entry.alive = false;
    },
    wait: async () => {},
  };
  return { table, signals, deps };
}

const quiesceConfig = {
  appPath: "/Applications/BotFleet.app",
  checkout: "/Users/test/apps/botfleet-server",
  gracefulExitMs: 0,
  termExitMs: 0,
};
const electronMain = "/Applications/BotFleet.app/Contents/MacOS/BotFleet";
const electronHelper = "/Applications/BotFleet.app/Contents/Frameworks/BotFleet Helper.app/Contents/MacOS/BotFleet Helper --type=utility";
const checkoutHarness = "node --import tsx server/index.ts";

test("signalProcess reports an already-exited process as gone and still throws every other failure", async () => {
  const esrch = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  assert.equal(signalProcess(4242, "SIGTERM", () => { throw esrch; }), false);
  const sent = [];
  assert.equal(signalProcess(4242, "SIGTERM", (pid, signal) => { sent.push([pid, signal]); }), true);
  assert.deepEqual(sent, [[4242, "SIGTERM"]]);
  const eperm = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
  assert.throws(
    () => signalProcess(4242, "SIGTERM", () => { throw eperm; }),
    (error) => /Could not send SIGTERM to BotFleet process 4242: kill EPERM/.test(error.message) && error.cause === eperm,
  );
  // The real process.kill: a reaped child's pid answers ESRCH.  Signal 0 only
  // probes, so nothing is ever delivered to anyone even if the pid is reused.
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  assert.equal(signalProcess(child.pid, 0), false);
  assert.equal(signalProcess(process.pid, 0), true);
});

test("quiesce treats a process that exits between verification and SIGTERM as stopped, not as kill ESRCH", async () => {
  // 2026-10-02 apply: SIGTERM reached the Electron main process, its quit took
  // the companion and helpers down with it, and the next helper in the loop
  // had passed ps and lsof but was gone by the time the updater signalled it.
  const { table, signals, deps } = processTable({
    501: { command: electronMain, cwd: "/" },
    // Verified by ps and lsof, then gone before the signal: kill would ESRCH.
    502: { command: electronHelper, cwd: "/", exitDuringLsof: true },
    503: { command: electronHelper, cwd: "/" },
  });
  const previous = { runtimePids: [501], appPids: [501, 502, 503], processCommands: {}, processCwds: {} };
  await terminateVerified([501, 502, 503], previous, quiesceConfig, { current: [501, 502, 503], ...deps });
  assert.deepEqual(signals, [[501, "SIGTERM"], [503, "SIGTERM"]], "the gone helper is skipped and the rest still get SIGTERM");
  assert.equal([...table.values()].some((entry) => entry.alive), false);
  // Rollback calls the strict form with no `current`; the same race must not
  // fail it either, or a quiesce failure turns into a failed rollback.
  const strict = processTable({
    501: { command: electronMain, cwd: "/" },
    502: { command: electronHelper, cwd: "/", exitDuringLsof: true },
  });
  await terminateVerified([501, 502], previous, quiesceConfig, strict.deps);
  assert.deepEqual(strict.signals, [[501, "SIGTERM"]]);
});

test("quiesce skips a process that exits while ps is describing it instead of calling it foreign", async () => {
  const { signals, deps } = processTable({
    501: { command: electronMain, cwd: "/", exitDuringPs: true },
    16529: { command: checkoutHarness, cwd: quiesceConfig.checkout },
  });
  const previous = { runtimePids: [], appPids: [], processCommands: {}, processCwds: {} };
  // Strict: 501 was resolved as a current holder, but an empty identity from a
  // process that no longer exists is not a foreign executable.
  await terminateVerified([501, 16529], previous, quiesceConfig, deps);
  assert.deepEqual(signals, [[16529, "SIGTERM"]]);
});

test("quiesce re-resolves the harness when its pid changed between capture and quiesce", async () => {
  // Capture recorded harness pid 233.  By quiesce that harness is gone, 233
  // names an unrelated process, and the replacement harness 16529 holds the
  // database and answers port 8799.
  const { table, signals, deps } = processTable({
    233: { command: "/usr/libexec/unrelated-daemon --serve", cwd: "/" },
    16529: { command: checkoutHarness, cwd: quiesceConfig.checkout },
  });
  const previous = {
    runtimePids: [233],
    appPids: [],
    processCommands: { 233: checkoutHarness },
    processCwds: { 233: quiesceConfig.checkout },
  };
  await terminateVerified([...previous.runtimePids, 16529], previous, quiesceConfig, { current: [16529], ...deps });
  assert.deepEqual(signals, [[16529, "SIGTERM"]], "the replacement is stopped and the recycled pid is never signalled");
  assert.equal(table.get(233).alive, true, "the unrelated process is left alone and not waited on");
  // A captured pid that has simply exited is dropped by the liveness filter.
  const exited = processTable({ 16529: { command: checkoutHarness, cwd: quiesceConfig.checkout } });
  await terminateVerified([233, 16529], previous, quiesceConfig, { current: [16529], ...exited.deps });
  assert.deepEqual(exited.signals, [[16529, "SIGTERM"]]);
  // No false success: a process resolved NOW as holding BotFleet state must
  // still verify, whether quiesce names it current or rollback calls strictly.
  const holder = processTable({ 233: { command: "/usr/libexec/unrelated-daemon --serve", cwd: "/" } });
  await assert.rejects(
    terminateVerified([233], previous, quiesceConfig, { current: [233], ...holder.deps }),
    /Process 233 still holds BotFleet state but its executable is not an expected BotFleet path/,
  );
  await assert.rejects(
    terminateVerified([233], previous, quiesceConfig, holder.deps),
    /Process 233 still holds BotFleet state/,
  );
  assert.deepEqual(holder.signals, []);
});

test("quiesce still refuses a process that rejects or survives SIGTERM, and never escalates to SIGKILL", async () => {
  const eperm = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
  const refused = processTable({ 501: { command: electronMain, cwd: "/", killError: eperm } });
  await assert.rejects(
    terminateVerified([501], { processCommands: {}, processCwds: {} }, quiesceConfig, { current: [501], ...refused.deps }),
    /Could not send SIGTERM to BotFleet process 501: kill EPERM/,
  );
  const stubborn = processTable({ 501: { command: electronMain, cwd: "/", ignoresTerm: true } });
  await assert.rejects(
    terminateVerified([501], { processCommands: {}, processCwds: {} }, quiesceConfig, { current: [501], ...stubborn.deps }),
    /BotFleet did not exit after graceful quit and SIGTERM \(pid 501\); refusing SIGKILL/,
  );
  assert.deepEqual(stubborn.signals, [[501, "SIGTERM"]]);
});

test("quiesce confirms a harness bootout with launchctl print and boots out a job loaded since capture", async () => {
  const config = {
    domain: "gui/501",
    label: "app.botfleet.server",
    legacyLabel: "com.jay.botfleet-server",
    plist: "/Users/test/Library/LaunchAgents/app.botfleet.server.plist",
    legacyPlist: "/Users/test/Library/LaunchAgents/com.jay.botfleet-server.plist",
  };
  const launchctl = (loadedNow, { absentAfterBootout = true } = {}) => {
    const booted = [];
    return {
      booted,
      deps: {
        print: async (label) => ({ code: loadedNow.includes(label) ? 0 : 113 }),
        // bootout exits nonzero even when it worked or the job was already gone.
        bootout: async (label) => { booted.push(label); return { code: 5 }; },
        confirmAbsent: async () => absentAfterBootout,
      },
    };
  };
  // Captured loaded, already gone by quiesce: a nonzero bootout is not a refusal.
  const gone = launchctl([]);
  const capturedLoaded = { launchdLoaded: true, legacyLaunchdLoaded: false };
  await bootOutHarnessForQuiesce(config, capturedLoaded, gone.deps);
  assert.deepEqual(gone.booted, [config.label]);
  // Still loaded after bootout: refuse rather than install under KeepAlive.
  const stuck = launchctl([config.label], { absentAfterBootout: false });
  await assert.rejects(
    bootOutHarnessForQuiesce(config, { launchdLoaded: true, legacyLaunchdLoaded: false }, stuck.deps),
    /Could not boot out app\.botfleet\.server before install: gui\/501\/app\.botfleet\.server is still loaded/,
  );
  // Not loaded at capture, bootstrapped since (a watchdog restart): booted out
  // now, and recorded so rollback restores it like a captured job.
  const restarted = launchctl([config.label]);
  const capturedStopped = { launchdLoaded: false, legacyLaunchdLoaded: false };
  await bootOutHarnessForQuiesce(config, capturedStopped, restarted.deps);
  assert.deepEqual(restarted.booted, [config.label]);
  assert.equal(capturedStopped.launchdLoaded, true);
  assert.deepEqual(
    rollbackHarnessBootstrapPlists(config, capturedStopped, { plistExists: true, legacyPlistExists: true }),
    [config.plist],
  );
  // The aliased configuration still boots its one label out exactly once.
  const aliased = { ...config, label: config.legacyLabel };
  const once = launchctl([config.legacyLabel]);
  await bootOutHarnessForQuiesce(aliased, { launchdLoaded: false, legacyLaunchdLoaded: false }, once.deps);
  assert.deepEqual(once.booted, [config.legacyLabel]);
});

test("quiesce re-resolves current holders, bundle processes and port owners before signalling", async () => {
  const source = await readFile(join(scripts, "update-botfleet-mac.mjs"), "utf8");
  const quiesce = source.indexOf("quiesce: async (previous) => {");
  const assertQuiesced = source.indexOf("assertQuiesced: async () => {", quiesce);
  assert.ok(quiesce >= 0 && assertQuiesced > quiesce);
  const body = source.slice(quiesce, assertQuiesced);
  assert.match(body, /await bootOutHarnessForQuiesce\(config, previous\)/);
  assert.match(body, /Promise\.all\(config\.ports\.map\(probeHealth\)\)/);
  assert.match(body, /ownedRuntimePids\(\{ holders: currentHolders, bundlePids: currentBundlePids, health \}\)/);
  assert.match(body, /\{ current \}/);
});

test("rollback verifies each bootout with launchctl print before restoring files", async () => {
  const source = await readFile(join(scripts, "update-botfleet-mac.mjs"), "utf8");
  const rollback = source.indexOf("rollback: async (prepared, previous, originalError) => {");
  assert.ok(rollback >= 0, "the transaction has a rollback step");
  const restore = source.indexOf("Restore only from copies THIS run put at the rollback paths", rollback);
  assert.ok(restore > rollback);
  const bootout = source.indexOf("for (const label of rollbackHarnessBootoutLabels(config, previous))", rollback);
  const verify = source.indexOf("waitForLaunchdBootout(config.domain, label)", bootout);
  assert.ok(bootout > rollback && verify > bootout && verify < restore,
    "every bootout label is confirmed absent before any file is restored");
  const stopCheck = source.indexOf("if (stopErrors.length) throw new AggregateError(", rollback);
  assert.ok(verify < stopCheck && stopCheck < restore,
    "a label that survives bootout aborts the rollback before the restore");
});

test("startHarness records the started label before bootstrap and rollback boots it out before restoring files", async () => {
  const source = await readFile(join(scripts, "update-botfleet-mac.mjs"), "utf8");
  const start = source.indexOf("startHarness: async (prepared, previous) => {");
  assert.ok(start >= 0, "startHarness receives the transaction's previous state");
  const recordLabel = source.indexOf("previous.startedHarnessLabel = await startedHarnessLabel(config, plist)", start);
  const bootstrap = source.indexOf('run("launchctl", ["bootstrap", config.domain, plist])', start);
  assert.ok(recordLabel > start && recordLabel < bootstrap, "the started label is recorded before the bootstrap can fail");
  const rollback = source.indexOf("rollback: async (prepared, previous, originalError) => {");
  const bootout = source.indexOf("for (const label of rollbackHarnessBootoutLabels(config, previous))", rollback);
  const restore = source.indexOf("Restore only from copies THIS run put at the rollback paths", rollback);
  assert.ok(bootout > rollback && bootout < restore, "rollback boots out every started label before restoring files");
  assert.doesNotMatch(
    source.slice(rollback, restore),
    /\["bootout", `\$\{config\.domain\}\/\$\{config\.label\}`\]/,
    "rollback no longer boots out only the renamed label",
  );
});

test("production updater has no force-kill or unrelated desktop-process cleanup", async () => {
  const source = await readFile(join(scripts, "update-botfleet-mac.mjs"), "utf8");
  for (const forbidden of ["pkill", "killall", '"Dock"', '"Finder"', '"System Settings"']) {
    assert.equal(source.includes(forbidden), false, `must not contain ${forbidden}`);
  }
  assert.doesNotMatch(source, /process\.kill\([^\n]+"SIGKILL"/);
  assert.doesNotMatch(source, /signalProcess\([^\n]+"SIGKILL"/);
  assert.match(source, /signalProcess\(pid, "SIGTERM", kill\)/);
  assert.match(source, /kill = \(target, name\) => process\.kill\(target, name\)/);
  assert.match(source, /runtime\.safeToRestart !== true/);
  assert.match(source, /runtime\.sourceCommit !== expectedBuild\.targetCommit/);
  assert.match(source, /Database ownership is ambiguous/);
  assert.match(source, /manual first adoption is required/);
  assert.match(source, /rollback was deferred without interrupting it/);
  assert.doesNotMatch(source, /legacyPreflight/);
  assert.match(source, /LEGACY_LAUNCH_AGENT_LABEL = "com\.jay\.botfleet-server"/);
  assert.match(source, /legacyLaunchdLoaded: legacyLaunchd\.code === 0/);
  assert.match(source, /for \(const label of quiesceBootoutLabels\(config, previous\)\)/);
  assert.match(source, /previous\.legacyLaunchdLoaded[\s\S]*bootstrap[\s\S]*config\.legacyPlist/);
  assert.match(source, /POST/);
  assert.match(source, /update-botfleet\.sh unquiesce/);
});

test("desktop local-update UI does not report normal packaging latency as failure", async () => {
  const source = await readFile(join(scripts, "../electron/updater.mjs"), "utf8");
  assert.match(source, /LOCAL_UPDATE_PROGRESS_MS = 2 \* 60 \* 1000/);
  assert.match(source, /LOCAL_UPDATE_LONG_RUNNING_MS = 60 \* 60 \* 1000/);
  assert.match(source, /still preparing/);
  assert.match(source, /updater lock before retrying/);
  assert.match(source, /still preparing\.\\u00A0 Do not start another update/);
  assert.match(source, /expected\.\\u00A0 Check its updater lock/);
  assert.match(source, /status: "installing",\r?\n\s+message: "The local updater is taking longer/);
  assert.doesNotMatch(source, /did not finish\. Quit the app and try again/);
});

test("process verification binds relative server commands to the live checkout cwd", async () => {
  const config = { appPath: "/Applications/BotFleet.app", checkout: "/Users/test/apps/botfleet-server" };
  assert.equal(
    await isExpectedBotFleetProcess("/opt/homebrew/bin/node --experimental-strip-types server/index.ts", config.checkout, config),
    true,
  );
  assert.equal(
    await isExpectedBotFleetProcess("/opt/homebrew/bin/node --experimental-strip-types server/index.ts", "/tmp/decoy", config),
    false,
  );
  assert.equal(await isExpectedBotFleetProcess("/usr/bin/python3 server/index.ts", config.checkout, config), false);
  assert.equal(await isExpectedBotFleetProcess("/Applications/Other.app/Contents/MacOS/BotFleet", "/", config), false);
  assert.equal(await isExpectedBotFleetProcess("/Applications/BotFleet.app/Contents/MacOS/BotFleet", "/", config), true);
});

test("the updater covers every desktop harness fallback port", () => {
  assert.deepEqual(DEFAULT_PORTS, [8799, 18799, 28799]);
});

test("unused foreign fallback ports do not hide one valid BotFleet owner", () => {
  const owner = { kind: "botfleet", pid: 42, port: 18799, static: false };
  assert.deepEqual(
    healthTopologyResult([{ kind: "foreign" }, owner, { kind: "none" }]),
    { safe: true, pid: 42, pids: [42], port: 18799, health: [owner] },
  );
  assert.match(healthTopologyResult([{ kind: "foreign" }, { kind: "none" }]).reason, /No BotFleet harness/);
  assert.equal(healthTopologyResult([{ kind: "http", status: 404 }, owner]).safe, true);
  assert.match(healthTopologyResult([owner, { kind: "unavailable" }]).reason, /unavailable or ambiguous/);
});

test("a post-fence ownership exception releases runtime admission", async () => {
  const releases = [];
  const owner = { version: 1, pid: 42, port: 8799, nonce: "a".repeat(64) };
  const result = await fenceRuntimeAdmission(
    { dataDirectory: "/private/data", ports: [8799] },
    {
      readOwner: async () => owner,
      requestJson: async () => ({ kind: "ok", status: 200, body: {
        app: "botfleet", pid: 42, dataOwner: { pid: 42, port: 8799 },
        sourceCommit: "b".repeat(40), sourceDirty: false,
        safeToRestart: true, activeWorkCount: 0, quiescing: true,
      } }),
      healthTopology: async () => { throw new Error("injected topology failure"); },
      sqliteHolders: async () => [42],
      releaseRuntimeAdmission: async (config) => releases.push(config),
    },
  );
  assert.equal(result.safe, false);
  assert.match(result.reason, /could not be verified after the admission fence/);
  assert.equal(releases.length, 1);
});

test("desktop verification requires one stable installed-application process after open", () => {
  assert.equal(stableApplicationProcessError([41], [41], true), null);
  assert.match(stableApplicationProcessError([], [], true), /did not remain running/);
  assert.match(stableApplicationProcessError([41], [42], true), /did not remain running/);
  assert.equal(stableApplicationProcessError([], [], false), null);
});

test("a Mac with only the legacy LaunchAgent plist still bootstraps the updated harness", () => {
  const config = {
    label: "app.botfleet.server",
    plist: "/Users/test/Library/LaunchAgents/app.botfleet.server.plist",
    legacyLabel: "com.jay.botfleet-server",
    legacyPlist: "/Users/test/Library/LaunchAgents/com.jay.botfleet-server.plist",
  };
  // The first automatic update on a renamed install: only the legacy plist
  // exists, and bootstrapping the missing renamed one used to roll the
  // transaction back.  The legacy plist launches the same advanced checkout.
  assert.equal(
    harnessBootstrapPlist(config, { plistExists: false, legacyPlistExists: true }),
    config.legacyPlist,
  );
  // Once the migration materializes the renamed plist, it wins.
  assert.equal(
    harnessBootstrapPlist(config, { plistExists: true, legacyPlistExists: true }),
    config.plist,
  );
  assert.equal(
    harnessBootstrapPlist(config, { plistExists: true, legacyPlistExists: false }),
    config.plist,
  );
  // Neither plist on disk keeps the original loud failure against the
  // renamed path instead of silently starting nothing.
  assert.equal(
    harnessBootstrapPlist(config, { plistExists: false, legacyPlistExists: false }),
    config.plist,
  );
});

test("rollback restores a new-label harness from its legacy-named plist", () => {
  const config = {
    label: "app.botfleet.server",
    plist: "/Users/test/Library/LaunchAgents/app.botfleet.server.plist",
    legacyLabel: "com.jay.botfleet-server",
    legacyPlist: "/Users/test/Library/LaunchAgents/com.jay.botfleet-server.plist",
  };
  assert.deepEqual(
    rollbackHarnessBootstrapPlists(
      config,
      { launchdLoaded: true, legacyLaunchdLoaded: false },
      { plistExists: false, legacyPlistExists: true },
    ),
    [config.legacyPlist],
  );
});

test("rollback restores an aliased legacy-label harness once, from its configured plist", () => {
  // BOTFLEET_LAUNCH_AGENT_LABEL names the legacy label and
  // BOTFLEET_LAUNCH_AGENT_PLIST points at a custom plist: capture sees one
  // job as both launchdLoaded and legacyLaunchdLoaded.
  const config = {
    label: "com.jay.botfleet-server",
    plist: "/Users/test/custom/botfleet-server.plist",
    legacyLabel: "com.jay.botfleet-server",
    legacyPlist: "/Users/test/Library/LaunchAgents/com.jay.botfleet-server.plist",
  };
  const both = { launchdLoaded: true, legacyLaunchdLoaded: true };
  // Custom plist present, legacy plist missing: restore only the custom one,
  // never the missing legacy path.
  assert.deepEqual(
    rollbackHarnessBootstrapPlists(config, both, { plistExists: true, legacyPlistExists: false }),
    [config.plist],
  );
  // Both present: one bootstrap of the configured plist, not a second
  // bootstrap of the already-loaded label from the legacy path.
  assert.deepEqual(
    rollbackHarnessBootstrapPlists(config, both, { plistExists: true, legacyPlistExists: true }),
    [config.plist],
  );
  // Custom plist missing: fall back to the legacy plist exactly once.
  assert.deepEqual(
    rollbackHarnessBootstrapPlists(config, both, { plistExists: false, legacyPlistExists: true }),
    [config.legacyPlist],
  );
  // Only the legacy flag recorded still restores the one job.
  assert.deepEqual(
    rollbackHarnessBootstrapPlists(config, { launchdLoaded: false, legacyLaunchdLoaded: true }, { plistExists: true, legacyPlistExists: false }),
    [config.plist],
  );
  assert.deepEqual(
    rollbackHarnessBootstrapPlists(config, { launchdLoaded: false, legacyLaunchdLoaded: false }, { plistExists: true, legacyPlistExists: true }),
    [],
  );
});

test("rollback restores a legacy-label harness from a configured custom plist", () => {
  // BOTFLEET_LAUNCH_AGENT_PLIST points at a custom plist on a pre-transition
  // Mac: the only job runs under the legacy label while config.label keeps
  // the renamed default, so the job used to be restored from the hardcoded
  // legacy path -- a file this Mac never had, leaving the harness down.
  const config = {
    label: "app.botfleet.server",
    plist: "/Users/test/custom/botfleet-server.plist",
    customPlist: true,
    legacyLabel: "com.jay.botfleet-server",
    legacyPlist: "/Users/test/Library/LaunchAgents/com.jay.botfleet-server.plist",
  };
  // The legacy job comes back from the configured plist it was loaded from,
  // not the missing hardcoded legacy path.
  assert.deepEqual(
    rollbackHarnessBootstrapPlists(config, { launchdLoaded: false, legacyLaunchdLoaded: true }, { plistExists: true, legacyPlistExists: false }),
    [config.plist],
  );
  // Both distinct labels recorded: the custom plist can only carry one of
  // them, so the renamed job comes back from it and the legacy job from the
  // legacy plist -- two bootstraps, not one deduped entry.
  assert.deepEqual(
    rollbackHarnessBootstrapPlists(config, { launchdLoaded: true, legacyLaunchdLoaded: true }, { plistExists: true, legacyPlistExists: true }),
    [config.plist, config.legacyPlist],
  );
  // A configured plist that vanished mid-transaction falls back to the
  // legacy path that does exist.
  assert.deepEqual(
    rollbackHarnessBootstrapPlists(config, { launchdLoaded: false, legacyLaunchdLoaded: true }, { plistExists: false, legacyPlistExists: true }),
    [config.legacyPlist],
  );
  // Without a configured plist the legacy job still comes from the hardcoded
  // legacy path, exactly as before.
  const stock = { ...config, customPlist: false };
  assert.deepEqual(
    rollbackHarnessBootstrapPlists(stock, { launchdLoaded: false, legacyLaunchdLoaded: true }, { plistExists: true, legacyPlistExists: false }),
    [stock.legacyPlist],
  );
});

test("rollback restores both distinct loaded labels when a custom plist exists", () => {
  // Both the renamed and the legacy label were loaded before the
  // transaction and BOTFLEET_LAUNCH_AGENT_PLIST points at a custom plist.
  // Both flags used to resolve to config.plist, the Set deduped them, and
  // only one job came back.
  const config = {
    label: "app.botfleet.server",
    plist: "/Users/test/custom/botfleet-server.plist",
    customPlist: true,
    legacyLabel: "com.jay.botfleet-server",
    legacyPlist: "/Users/test/Library/LaunchAgents/com.jay.botfleet-server.plist",
  };
  const both = { launchdLoaded: true, legacyLaunchdLoaded: true };
  // Custom plist declares the renamed label: legacy job from the legacy plist.
  assert.deepEqual(
    rollbackHarnessBootstrapPlists(config, both, { plistExists: true, legacyPlistExists: true, plistLabel: config.label }),
    [config.plist, config.legacyPlist],
  );
  // Label unreadable: still two distinct restores.
  assert.deepEqual(
    rollbackHarnessBootstrapPlists(config, both, { plistExists: true, legacyPlistExists: true, plistLabel: null }),
    [config.plist, config.legacyPlist],
  );
  // Custom plist missing: renamed job falls back to the legacy plist, which
  // is also the legacy job's plist, so it is bootstrapped once.
  assert.deepEqual(
    rollbackHarnessBootstrapPlists(config, both, { plistExists: false, legacyPlistExists: true }),
    [config.legacyPlist],
  );
  // Only the legacy job loaded and the custom plist declares the legacy
  // label: it is restored from the custom plist.
  assert.deepEqual(
    rollbackHarnessBootstrapPlists(config, { launchdLoaded: false, legacyLaunchdLoaded: true }, { plistExists: true, legacyPlistExists: false, plistLabel: config.legacyLabel }),
    [config.plist],
  );
  // Only the legacy job loaded but the custom plist declares the renamed
  // label: it cannot be the legacy job's source.
  assert.deepEqual(
    rollbackHarnessBootstrapPlists(config, { launchdLoaded: false, legacyLaunchdLoaded: true }, { plistExists: true, legacyPlistExists: true, plistLabel: config.label }),
    [config.legacyPlist],
  );
});

test("launchAgentPlistLabel reads the plist Label and tolerates failures", async () => {
  const calls = [];
  const ok = async (command, args) => { calls.push([command, args]); return { code: 0, stdout: "com.jay.botfleet-server\n", stderr: "" }; };
  assert.equal(await launchAgentPlistLabel("/tmp/x.plist", ok), "com.jay.botfleet-server");
  assert.deepEqual(calls, [["plutil", ["-extract", "Label", "raw", "-o", "-", "/tmp/x.plist"]]]);
  assert.equal(await launchAgentPlistLabel("/tmp/x.plist", async () => ({ code: 1, stdout: "", stderr: "no Label" })), null);
  assert.equal(await launchAgentPlistLabel("/tmp/x.plist", async () => { throw new Error("spawn ENOENT"); }), null);
});

test("desktop attachment requires a static harness or a second same-owner UI endpoint", () => {
  assert.equal(applicationAttachmentError({ health: [{ port: 8799, static: true }] }, true), null);
  assert.equal(applicationAttachmentError({ health: [{ port: 8799 }, { port: 18799 }] }, true), null);
  assert.match(applicationAttachmentError({ health: [{ port: 8799, static: false }] }, true), /did not expose its bundled UI/);
  assert.equal(applicationAttachmentError({ health: [{ port: 8799, static: false }] }, false), null);
});

test("rollback refuses to interrupt an active or unprovable replacement", () => {
  assert.equal(rollbackReadinessError(0, { safe: false, reason: "no runtime" }), null);
  assert.equal(rollbackReadinessError(1, { safe: true }), null);
  assert.equal(rollbackReadinessError(1, { safe: false, reason: "1 active operation" }), "1 active operation");
  assert.match(pendingRecoveryReceiptPath({ stageDirectory: "/private/stage" }), /pending-recovery\.json$/);
  assert.equal(
    credentialPreparationReceiptPath({ stageDirectory: "/private/stage" }),
    join("/private/stage", "credential-migration.json"),
  );
});

test("post-start identity accepts new work while the pre-install readiness gate still refuses it", () => {
  const owner = { pid: 42, port: 8799 };
  const prepared = {
    targetCommit: "b".repeat(40),
    version: "1.0.30",
    apiVersion: 1,
    uiHash: "c".repeat(64),
  };
  const runtime = {
    app: "botfleet",
    pid: owner.pid,
    dataOwner: owner,
    sourceCommit: prepared.targetCommit,
    sourceDirty: false,
    version: prepared.version,
    apiVersion: prepared.apiVersion,
    uiHash: null,
    safeToRestart: false,
    activeWorkCount: 1,
  };
  assert.match(authenticatedRuntimeError(runtime, owner, prepared, { requireIdle: true }), /active operations/);
  assert.equal(authenticatedRuntimeError(runtime, owner, prepared, { requireIdle: false }), null);
  assert.match(
    authenticatedRuntimeError({ ...runtime, uiHash: "d".repeat(64) }, owner, prepared, { requireIdle: false }),
    /does not match the prepared application build/,
  );
});

// A crashed or booted-out harness leaves harness-owner.json behind naming a pid
// that is gone.  That is a stopped app, not a machine that has never adopted
// this build, and the refusal has to say so: the old text sent an operator
// looking for a first-adoption procedure that does not exist for a crash.
// Skipped on Windows like the other owner-record tests here: assertPrivateRegularFile
// compares st_uid against process.getuid(), which is undefined there, so it throws
// before the classification under test is ever reached.
test("preflight names a stale owner record as a stopped harness, not a first adoption", { skip: process.platform === "win32" ? "Mac updater requires POSIX ownership and modes" : false }, async (t) => {
  const dead = spawn(process.execPath, ["-e", ""]);
  const deadPid = dead.pid;
  await once(dead, "exit");

  const dataDirectory = await mkdtemp(join(tmpdir(), "ubf-stale-owner-"));
  await chmod(dataDirectory, 0o700);
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const record = join(dataDirectory, "harness-owner.json");
  await writeFile(record, JSON.stringify({ version: 1, pid: deadPid, port: 8799, nonce: "a".repeat(64) }));
  await chmod(record, 0o600);

  const stale = await runtimePreflight({ dataDirectory }, null);
  assert.equal(stale.safe, false);
  assert.match(stale.reason, new RegExp(`harness \\(pid ${deadPid}\\) is not running`));
  assert.doesNotMatch(stale.reason, /first adoption/);
  // Descriptive only.  applyPreparedUpdate starts the harness and then polls
  // it, so this text reaches an operator at a moment when the updater has
  // already started the app; an imperative would contradict that.
  assert.doesNotMatch(stale.reason, /start the app/i);

  // With no record at all the genuine first-adoption text still applies, so the
  // fix narrows the message instead of replacing it.
  await rm(record);
  const absent = await runtimePreflight({ dataDirectory }, null);
  assert.equal(absent.safe, false);
  assert.match(absent.reason, /first adoption/);

  // A record carrying a field the owner contract does not define is refused
  // rather than partially believed.  Extra keys used to pass validation and
  // were then ignored downstream, so nothing was exploitable; refusing them
  // means a malformed or tampered record cannot be half-honoured.
  await writeFile(record, JSON.stringify({ version: 1, pid: deadPid, port: 8799, nonce: "a".repeat(64), extra: 1 }));
  await chmod(record, 0o600);
  await assert.rejects(
    () => runtimePreflight({ dataDirectory }, null),
    /Harness owner record is invalid/,
  );
});

test("packaged identity comes from the build output rather than an ambient label", async () => {
  const source = await readFile(join(scripts, "update-botfleet-mac.mjs"), "utf8");
  const builder = await readFile(join(scripts, "../electron-builder.yml"), "utf8");
  assert.match(source, /Contents\/Resources\/server\/build-identity\.json/);
  assert.match(source, /build\.sourceDirty !== false/);
  assert.match(source, /EXPECTED_SIGN_IDENTITY = "Developer ID Application: Jay Wedgeworth, LLC \(CC8UTF7ATG\)"/);
  assert.match(source, /BUILDER_SIGN_SELECTOR = "Jay Wedgeworth, LLC \(CC8UTF7ATG\)"/);
  assert.match(source, /PREPARED_SCHEMA_VERSION = 2/);
  assert.match(builder, /identity: "Jay Wedgeworth, LLC \(CC8UTF7ATG\)"/);
  assert.doesNotMatch(builder, /identity: "Developer ID Application:/);
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

test("a settled run id is recognised, and a different run's outcome is not", () => {
  const finished = {
    schemaVersion: 1,
    runId: "run_one",
    startedAt: "2026-09-16T11:00:00.000Z",
    finishedAt: "2026-09-16T11:04:00.000Z",
    outcome: "failed",
    message: "The update could not be packaged.",
  };
  assert.deepEqual(settledRunOutcome(finished, "run_one"), {
    outcome: "failed",
    message: "The update could not be packaged.",
  });
  // A run still going is not settled, and neither is one that never wrote an
  // outcome - those are the two cases a relaunch is allowed to resume rather
  // than skip.
  assert.equal(settledRunOutcome({ ...finished, finishedAt: null, outcome: null }, "run_one"), null);
  assert.equal(settledRunOutcome({ ...finished, outcome: null }, "run_one"), null);
  // Another run's record says nothing about this one.
  assert.equal(settledRunOutcome(finished, "run_two"), null);
  assert.equal(settledRunOutcome(finished, undefined), null);
  // Anything torn, missing or the wrong shape is not evidence of a finish.
  assert.equal(settledRunOutcome(null, "run_one"), null);
  assert.equal(settledRunOutcome("{}", "run_one"), null);
  assert.equal(settledRunOutcome([finished], "run_one"), null);
});

test("a relaunch of a finished run does nothing and exits successfully", async (t) => {
  // launchd keeps a `submit`ted job alive on failure, so a run that fails is
  // relaunched under the SAME run id and progress file.  The harness removes
  // the label when it sees the run settle; this is the guard for a relaunch
  // that beats the removal.
  const root = await mkdtemp(join(tmpdir(), "bf-update-relaunch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const progressPath = join(root, "run.progress.json");
  const record = {
    schemaVersion: 1,
    runId: "run_one",
    command: "update",
    pid: 4321,
    startedAt: "2026-09-16T11:00:00.000Z",
    updatedAt: "2026-09-16T11:04:00.000Z",
    step: "buildBundle",
    progress: 0.4,
    targetCommit: "b".repeat(40),
    receiptPath: null,
    finishedAt: "2026-09-16T11:04:00.000Z",
    outcome: "failed",
    message: "The update could not be packaged.",
  };
  const written = `${JSON.stringify(record, null, 2)}\n`;
  await writeFile(progressPath, written);

  // Everything the config would resolve points at scratch, so a guard that
  // regressed cannot reach this machine's real checkout, lock or app.
  const scratch = {
    BOTFLEET_UPDATE_ALLOW_NON_DARWIN: "1",
    BOTFLEET_CHECKOUT: join(root, "checkout"),
    BOTFLEET_APP_PATH: join(root, "BotFleet.app"),
    BOTFLEET_DATA_DIR: join(root, "data"),
    BOTFLEET_UPDATE_LOCK: join(root, "update.lock"),
    BOTFLEET_UPDATE_ROOT: join(root, "updates"),
  };
  const restore = Object.fromEntries(Object.keys(scratch).map((key) => [key, process.env[key]]));
  Object.assign(process.env, scratch);
  t.after(() => {
    for (const [key, value] of Object.entries(restore)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  await main(["update", "--progress", progressPath, "--run-id", "run_one"]);
  // Untouched: the recorder rewrites this file the moment it is created, so
  // an unchanged record is proof nothing started.
  assert.equal(await readFile(progressPath, "utf8"), written);
  assert.equal(process.exitCode, undefined);
});

// The wrapper bootstraps the updater into `mktemp -d "${TMPDIR}/..."`.  On
// macOS TMPDIR is under /var/folders and /var is a symlink to /private/var.
// Node's ESM loader realpaths the entry module, so import.meta.url named
// /private/var/... while process.argv[1] kept /var/..., the entry guard was
// false, main() never ran, and every ubf run exited 0 without a word.  This
// test reproduces that with an explicit symlinked directory so it fails on any
// platform that can create one, not only on a Mac.
async function symlinkedCopy(t, files) {
  const root = await mkdtemp(join(tmpdir(), "botfleet-entry-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const physical = join(root, "physical");
  const linked = join(root, "linked");
  for (const file of files) {
    const target = join(physical, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(scripts, "..", file), target);
  }
  // "junction" is ignored on POSIX and lets Windows create the link without
  // elevated privileges.
  await symlink(physical, linked, "junction");
  // Guard the premise: the two spellings must really differ.
  assert.notEqual(await realpath(linked), linked);
  return { linked, root };
}

test("the updater runs its entry point when invoked through a symlinked directory", async (t) => {
  // Exactly the files the wrapper archives into its bootstrap directory, laid
  // out the same way.  Keeping the list here also proves the entry module
  // stays self-contained: a new import would fail to resolve in this copy.
  const { linked, root } = await symlinkedCopy(t, [
    "scripts/update-botfleet-mac.mjs",
    "scripts/mac-update-transaction.mjs",
    "scripts/update-progress.mjs",
    "electron/update-credential-preparation.mjs",
  ]);
  // --help returns before any configuration, lock, network or data directory
  // is touched.  HOME and the BotFleet paths still point at scratch so a
  // regression elsewhere cannot reach this machine's real checkout or app.
  const result = await run(process.execPath, [join(linked, "scripts", "update-botfleet-mac.mjs"), "--help"], {
    env: {
      HOME: join(root, "home"),
      BOTFLEET_UPDATE_ALLOW_NON_DARWIN: "1",
      BOTFLEET_CHECKOUT: join(root, "checkout"),
      BOTFLEET_APP_PATH: join(root, "BotFleet.app"),
      BOTFLEET_DATA_DIR: join(root, "data"),
      BOTFLEET_UPDATE_LOCK: join(root, "update.lock"),
      BOTFLEET_UPDATE_ROOT: join(root, "updates"),
    },
    allowFailure: true,
  });
  assert.equal(result.code, 0, result.stderr);
  // A silent exit 0 is the bug, so the exit code alone proves nothing.
  assert.match(result.stdout, /^Usage:/m, "main() must run and print the usage text");
  assert.match(result.stdout, /pending-update-resume\.json/, "usage must say what --force interrupts");
});

test("another script with the same entry guard runs through a symlinked directory", async (t) => {
  const { linked } = await symlinkedCopy(t, ["scripts/verify-release-tag.mjs"]);
  const result = await run(process.execPath, [join(linked, "scripts", "verify-release-tag.mjs")], {
    env: { GH_TOKEN: "" },
    allowFailure: true,
  });
  // Reaching the token check proves the guard fired.  It never gets as far as
  // a network request without a token.
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /GH_TOKEN is required to verify the release tag/);
});
