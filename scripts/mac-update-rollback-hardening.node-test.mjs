import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import {
  abandonedStages,
  failedInstallBundles,
  generationBelongsToApp,
  ownedRuntimePids,
  prunablePath,
  quiescedPortError,
  reconcilableGenerations,
  resolveRollbackPlacement,
  rollbackGenerations,
  rollbackGenerationsToPrune,
  run,
  stageEntries,
  stageStamp,
  staleCandidateNames,
  swapPreparedFiles,
  txtHolderPids,
  unclaimedGenerations,
} from "./update-botfleet-mac.mjs";

const macOnly = { skip: process.platform === "darwin" ? false : "needs macOS: spawns a Mach-O binary and reads open file references" };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "botfleet-rollback-hardening-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function receipt(fields) {
  return { schemaVersion: 1, status: "verified", ...fields };
}

async function writeReceipt(path, fields) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(receipt(fields), null, 2)}\n`);
}

// P1 — a reused stage must not collide two runs onto one rollback path.

test("each run gets its own rollback directory inside a reused stage", async (t) => {
  const root = await fixture(t);
  const stage = join(root, "stage");
  await mkdir(stage, { recursive: true });
  const place = (generation) => resolveRollbackPlacement({
    livePath: join(root, "Applications", "BotFleet.app"),
    stageDirectory: stage,
    stageName: "BotFleet.app",
    generation,
    adjacentPath: join(root, "Applications", `.BotFleet.rollback-${generation}.app`),
  });
  const first = await place("1757600000000-2246f19e9de8");
  const second = await place("1757700000000-ae8abe7d5d59");
  assert.notEqual(first.path, second.path);
  assert.notEqual(first.directory, second.directory);
  // The bundle still carries its real name, so nothing shows a rollback name.
  assert.equal(basename(first.path), "BotFleet.app");
  assert.equal(basename(second.path), "BotFleet.app");
});

test("the swap reports whether the rollback paths actually hold this run's copies", async (t) => {
  const root = await fixture(t);
  const paths = {
    appPath: join(root, "BotFleet.app"),
    candidateApp: join(root, ".candidate.app"),
    rollbackApp: join(root, "rollback", "BotFleet.app"),
    liveDependencies: join(root, "node_modules"),
    candidateDependencies: join(root, ".candidate-node_modules"),
    rollbackDependencies: join(root, ".rollback-node_modules"),
  };
  await mkdir(join(root, "rollback"), { recursive: true });
  for (const [path, marker] of [
    [paths.appPath, "old-app"],
    [paths.candidateApp, "new-app"],
    [paths.liveDependencies, "old-deps"],
    [paths.candidateDependencies, "new-deps"],
  ]) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "marker"), marker);
  }

  const progress = {};
  await swapPreparedFiles({ ...paths, progress });
  assert.deepEqual(progress, { rollbackAppHolds: true, rollbackDependenciesHold: true });

  // Put it back and fail the swap partway: the flags must end up false,
  // because the restore already returned the prior copies to their places.
  await rename(paths.appPath, paths.candidateApp);
  await rename(paths.rollbackApp, paths.appPath);
  await rename(paths.liveDependencies, paths.candidateDependencies);
  await rename(paths.rollbackDependencies, paths.liveDependencies);
  const failed = {};
  let calls = 0;
  await assert.rejects(
    swapPreparedFiles({ ...paths, progress: failed }, async (from, to) => {
      calls += 1;
      if (calls === 3) throw new Error("injected candidate rename failure");
      await rename(from, to);
    }),
    /injected candidate rename failure/,
  );
  assert.deepEqual(failed, { rollbackAppHolds: false, rollbackDependenciesHold: false });
  assert.equal(await readFile(join(paths.appPath, "marker"), "utf8"), "old-app");
});

test("a rollback bundle this run did not move is never promoted over the installed app", async (t) => {
  const root = await fixture(t);
  // This mirrors what `rollback()` does: restore only when the swap recorded
  // that it moved the live copies.  A bundle left at the rollback path by an
  // earlier run must stay there.
  const appPath = join(root, "BotFleet.app");
  const rollbackApp = join(root, "rollback", "BotFleet.app");
  await mkdir(appPath, { recursive: true });
  await mkdir(rollbackApp, { recursive: true });
  await writeFile(join(appPath, "marker"), "current");
  await writeFile(join(rollbackApp, "marker"), "two-generations-old");

  const restore = async (swap) => {
    if (swap?.rollbackAppHolds) await rename(rollbackApp, appPath);
  };
  await restore({});
  assert.equal(await readFile(join(appPath, "marker"), "utf8"), "current");
  assert.equal(await readFile(join(rollbackApp, "marker"), "utf8"), "two-generations-old");
});

// P1 — argv does not follow a rename; the kernel's open reference does.

test("a process keeps its bundle open across a rename, and only the open reference finds it", macOnly, async (t) => {
  const root = await fixture(t);
  const executable = join(root, "App.app", "Contents", "MacOS", "BotFleet");
  await mkdir(dirname(executable), { recursive: true });
  await copyFile("/bin/sleep", executable);
  // A copied Apple binary loses its signature and is killed on launch, so
  // give it an ad-hoc one.
  await run("codesign", ["-f", "-s", "-", executable]);

  const child = spawn(executable, ["120"], { stdio: "ignore" });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
  await new Promise((done) => setTimeout(done, 800));
  assert.equal(child.exitCode, null, "the signed copy should still be running");

  const renamed = join(root, ".App.rollback.app");
  await rename(join(root, "App.app"), renamed);
  const renamedExecutable = join(renamed, "Contents", "MacOS", "BotFleet");

  // What `ps` reports is the path recorded at exec, which no longer exists.
  const arguments_ = await run("ps", ["-axo", "pid=,command="], { allowFailure: true });
  const argumentLines = arguments_.stdout.split("\n").filter((line) => line.includes(`${child.pid} `));
  assert.equal(
    argumentLines.some((line) => line.includes(renamedExecutable)),
    false,
    "arguments must still name the pre-rename path, which is why the argv check missed the survivor",
  );

  // lsof resolves the current path of the open vnode, so it finds it.
  const byReference = await run("lsof", ["-t", "--", renamedExecutable], { allowFailure: true });
  assert.deepEqual(
    byReference.stdout.split(/\s+/).filter(Boolean).map(Number),
    [child.pid],
  );

  // And the whole-bundle scan finds it under the renamed bundle too.
  const scan = await run("lsof", ["-F", "pn", "-d", "txt"], { allowFailure: true });
  const { realpath } = await import("node:fs/promises");
  assert.ok(txtHolderPids(scan.stdout, await realpath(renamed)).includes(child.pid));
});

// P1 — processes that live inside the bundle but are not its main binary.

test("the bundle scan finds an embedded driver, not only the main executable", macOnly, async (t) => {
  const root = await fixture(t);
  const bundle = join(root, "BotFleet.app");
  const driver = join(bundle, "Contents", "Resources", "cua-driver");
  await mkdir(dirname(driver), { recursive: true });
  await mkdir(join(bundle, "Contents", "MacOS"), { recursive: true });
  await copyFile("/bin/sleep", driver);
  await run("codesign", ["-f", "-s", "-", driver]);

  const child = spawn(driver, ["120"], { stdio: "ignore" });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
  await new Promise((done) => setTimeout(done, 800));
  assert.equal(child.exitCode, null, "the embedded driver should still be running");

  const { realpath } = await import("node:fs/promises");
  const before = await run("lsof", ["-F", "pn", "-d", "txt"], { allowFailure: true });
  assert.ok(
    txtHolderPids(before.stdout, await realpath(bundle)).includes(child.pid),
    "a process running Contents/Resources/cua-driver holds the bundle",
  );

  // The case that matters is after the swap has renamed the bundle: a helper
  // that outlived quiescence has to be findable in the rollback bundle, and
  // its arguments still name the path it started from.
  const renamed = join(root, ".BotFleet.rollback-1757600000000-2246f19e9de8.app");
  await rename(bundle, renamed);
  const after = await run("lsof", ["-F", "pn", "-d", "txt"], { allowFailure: true });
  assert.ok(
    txtHolderPids(after.stdout, await realpath(renamed)).includes(child.pid),
    "the embedded driver must still be found under the renamed bundle",
  );
  assert.equal(
    txtHolderPids(after.stdout, join(root, "BotFleet.app")).includes(child.pid),
    false,
    "and no longer under the path it was launched from",
  );
  const arguments_ = await run("ps", ["-axo", "pid=,command="], { allowFailure: true });
  assert.equal(
    arguments_.stdout.split("\n").some((line) => line.includes(`${child.pid} `) && line.includes(renamed)),
    false,
    "arguments do not follow the rename, which is why the scan cannot rely on them",
  );
});

test("the txt parser attributes each path to the process that holds it", () => {
  const appPath = (name, ...parts) => join(tmpdir(), "Applications", name, ...parts);
  const output = [
    "p101", "ftxt", `n${appPath("Other.app", "Contents", "MacOS", "Other")}`,
    "p202", "ftxt", `n${appPath("BotFleet.app", "Contents", "MacOS", "BotFleet")}`,
    "ftxt", `n${join(tmpdir(), "usr", "lib", "libSystem.B.dylib")}`,
    "p303", "ftxt", `n${appPath("BotFleet.app", "Contents", "Resources", "cua-driver")}`,
    "p404", "ftxt", `n${appPath("BotFleet.app.backup", "Contents", "MacOS", "BotFleet")}`,
  ].join("\n");
  assert.deepEqual(txtHolderPids(output, appPath("BotFleet.app")), [202, 303]);
  // A sibling whose name merely starts the same way is a different bundle.
  assert.deepEqual(txtHolderPids(output, appPath("Other.app")), [101]);
  assert.deepEqual(txtHolderPids("", appPath("BotFleet.app")), []);
});

// P1/P3 — orphan visibility in the cache placement.

test("a bundle left in a stage rollback directory without a receipt is reported", async (t) => {
  const root = await fixture(t);
  const appPath = join(root, "Applications", "BotFleet.app");
  const updates = join(root, "updates");
  await mkdir(appPath, { recursive: true });

  // Killed after the first rename and before the receipt: a bundle, no receipt.
  const killed = join(updates, "audit-a", "rollback", "1757600000000-2246f19e9de8", "BotFleet.app");
  await mkdir(killed, { recursive: true });
  // A complete generation beside it.
  const complete = join(updates, "audit-b", "rollback", "1757700000000-ae8abe7d5d59", "BotFleet.app");
  await mkdir(complete, { recursive: true });
  await writeReceipt(`${complete}.json`, {
    appPath,
    previousCommit: "a".repeat(40),
    replacementCommit: "b".repeat(40),
    rollbackBundle: complete,
    installedAt: "2026-09-12T11:31:00.000Z",
  });

  const { generations, orphans } = await rollbackGenerations({ appPath, updatesDirectory: updates });
  assert.deepEqual(orphans, [killed]);
  assert.deepEqual(generations.map((item) => item.receiptPath), [`${complete}.json`]);
});

// P2 — legacy receipts belong to nobody.

test("no installation claims a receipt that names no application, in either direction", () => {
  const legacy = { rollbackBundle: "/Applications/.BotFleet.rollback-1757600000000-2246f19e9de8.app" };
  assert.equal(generationBelongsToApp(legacy, "/Applications/BotFleet.app"), false);
  assert.equal(generationBelongsToApp(legacy, "/Applications/BotFleet Beta.app"), false);
  const generations = [
    { receiptPath: "/Applications/.BotFleet.rollback-old.app.json", receipt: legacy },
    { receiptPath: "/updates/a/rollback/g/BotFleet.app.json", receipt: receipt({ appPath: "/Applications/BotFleet.app", rollbackBundle: "/x", installedAt: "2026-09-12T00:00:00.000Z" }) },
    { receiptPath: "/updates/b/rollback/g/BotFleet.app.json", receipt: receipt({ appPath: "/Applications/BotFleet.app", rollbackBundle: "/y", installedAt: "2026-09-11T00:00:00.000Z" }) },
  ];
  for (const appPath of ["/Applications/BotFleet.app", "/Applications/BotFleet Beta.app"]) {
    assert.equal(
      rollbackGenerationsToPrune(generations, { appPath }).some((item) => item.receipt === legacy),
      false,
      `${appPath} must not prune a receipt it cannot prove is its own`,
    );
  }
  assert.deepEqual(unclaimedGenerations(generations).map((item) => item.receiptPath), [
    "/Applications/.BotFleet.rollback-old.app.json",
  ]);
});

// P2 — dependency candidates beside the checkout are swept too.

test("abandoned dependency candidates are swept, and unparseable names are only reported", () => {
  const names = [
    "botfleet-server",
    ".botfleet-server.node_modules.rollback-1757600000000-2246f19e9de8",
    ".botfleet-server.node_modules.update-4242-1757000000000",
    ".botfleet-server.node_modules.update-9999-1757000000001",
    ".botfleet-server.node_modules.update-7777-1757000000002",
    ".botfleet-server.node_modules.update-ae8abe7d-20260912",
  ];
  assert.deepEqual(
    staleCandidateNames(names, {
      prefix: ".botfleet-server.node_modules.update-",
      keepNames: [".botfleet-server.node_modules.update-7777-1757000000002"],
      isAlive: (pid) => pid === 4242,
    }),
    {
      stale: [".botfleet-server.node_modules.update-9999-1757000000001"],
      // Written by something that is not this updater, so it is never deleted.
      unrecognised: [".botfleet-server.node_modules.update-ae8abe7d-20260912"],
    },
  );
  // The dependency prefix must not swallow the rollback copies beside it.
  assert.equal(
    staleCandidateNames(names, { prefix: ".botfleet-server.node_modules.update-", isAlive: () => false })
      .stale.includes(".botfleet-server.node_modules.rollback-1757600000000-2246f19e9de8"),
    false,
  );
});

// P2 — a receipt stranded at "installing" can be settled with evidence.

test("an interrupted receipt is settled only when it names the build that was installed", () => {
  const appPath = "/Applications/BotFleet.app";
  const installedCommit = "b".repeat(40);
  const generations = [
    { receiptPath: "/stranded.json", receipt: { appPath, status: "installing", replacementCommit: installedCommit, rollbackBundle: "/x" } },
    { receiptPath: "/unrelated.json", receipt: { appPath, status: "installing", replacementCommit: "c".repeat(40), rollbackBundle: "/y" } },
    { receiptPath: "/other-app.json", receipt: { appPath: "/Applications/BotFleet Beta.app", status: "installing", replacementCommit: installedCommit, rollbackBundle: "/z" } },
    { receiptPath: "/done.json", receipt: receipt({ appPath, replacementCommit: installedCommit, rollbackBundle: "/w" }) },
  ];
  assert.deepEqual(
    reconcilableGenerations(generations, { appPath, installedCommit }).map((item) => item.receiptPath),
    ["/stranded.json"],
  );
  // With no readable build identity nothing is settled on guesswork.
  assert.deepEqual(reconcilableGenerations(generations, { appPath, installedCommit: null }), []);
});

// P3 — an explicit stage outside the updates root.

test("a stage named explicitly is discovered, and prune refuses when the kept generation is not", async (t) => {
  const root = await fixture(t);
  const appPath = join(root, "Applications", "BotFleet.app");
  const updates = join(root, "updates");
  const explicitStage = join(root, "elsewhere", "stage");
  await mkdir(appPath, { recursive: true });

  const older = join(updates, "audit-a", "rollback", "1757600000000-2246f19e9de8", "BotFleet.app");
  await mkdir(older, { recursive: true });
  await writeReceipt(`${older}.json`, {
    appPath, previousCommit: "0".repeat(40), rollbackBundle: older, installedAt: "2026-09-11T21:01:00.000Z",
  });
  const current = join(explicitStage, "rollback", "1757700000000-ae8abe7d5d59", "BotFleet.app");
  await mkdir(current, { recursive: true });
  await writeReceipt(`${current}.json`, {
    appPath, previousCommit: "a".repeat(40), rollbackBundle: current, installedAt: "2026-09-12T11:31:00.000Z",
  });

  // Without the explicit stage the new generation is invisible, and the prune
  // must refuse rather than keep some unrelated generation instead.
  const blind = await rollbackGenerations({ appPath, updatesDirectory: updates });
  assert.deepEqual(blind.generations.map((item) => item.receiptPath), [`${older}.json`]);
  assert.deepEqual(rollbackGenerationsToPrune(blind.generations, { appPath, keepReceiptPath: `${current}.json` }), []);

  // With it, the older generation is pruned and the new one kept.
  const seeing = await rollbackGenerations({ appPath, updatesDirectory: updates }, { stageDirectories: [explicitStage] });
  assert.deepEqual(seeing.generations.map((item) => item.receiptPath).sort(), [`${current}.json`, `${older}.json`].sort());
  assert.deepEqual(
    rollbackGenerationsToPrune(seeing.generations, { appPath, keepReceiptPath: `${current}.json` })
      .map((item) => item.receiptPath),
    [`${older}.json`],
  );
  // And that stage has to be a prunable root, or its paths could never be removed.
  assert.equal(prunablePath(older, [dirname(appPath), updates, explicitStage]), true);
  assert.equal(prunablePath(current, [dirname(appPath), updates]), false);
  assert.equal(prunablePath(current, [dirname(appPath), updates, explicitStage]), true);
});

test("the updater passes its own stage to discovery and to the prunable roots", async () => {
  const source = await readFile(new URL("./update-botfleet-mac.mjs", import.meta.url), "utf8");
  assert.match(source, /rollbackGenerations\(config, \{ stageDirectories \}\)/);
  assert.match(source, /Refusing to prune: the rollback generation just written/);
  assert.match(source, /previous\.swap\?\.rollbackAppHolds/);
  assert.match(source, /bundleProcessPids\(previous\.rollbackPath\)/);
  assert.match(source, /Rollback path already exists before install/);
});

// Found by a real `ubf` run during this work, not by reading the code.

test("the receipt names the build the rollback bundle actually is, not just the checkout commit", async () => {
  const source = await readFile(new URL("./update-botfleet-mac.mjs", import.meta.url), "utf8");
  // A live run recorded previousCommit 69128228 from the git checkout while the
  // bundle it displaced was ae8abe7d, because `ubf --force` exists exactly for
  // the case where the checkout has moved and the installed app has not.
  assert.match(source, /previousInstalledCommit: previous\.installedCommit \?\? null/);
  assert.match(source, /installedCommit = await installedBuildCommit\(config\.appPath\)/);
  // Reconciliation keys on the installed build for the same reason.
  assert.match(source, /installedCommit: previous\?\.installedCommit/);
});

test("bundles left behind by a failed install are reported, never deleted", () => {
  const names = [
    "BotFleet.app",
    "BotFleet.app.failed-1789260170446",
    "BotFleet.app.failed-1789111111111",
    ".BotFleet.update-4242-1757000000000.app",
    "BotFleet Beta.app.failed-1789260170446",
  ];
  assert.deepEqual(failedInstallBundles(names, "BotFleet.app"), [
    "BotFleet.app.failed-1789260170446",
    "BotFleet.app.failed-1789111111111",
  ]);
  assert.deepEqual(failedInstallBundles(names, "BotFleet Beta.app"), ["BotFleet Beta.app.failed-1789260170446"]);
  // They are evidence, so they must not be reachable by the candidate sweep.
  assert.deepEqual(
    staleCandidateNames(names, { prefix: ".BotFleet.update-", suffix: ".app", isAlive: () => false }).stale,
    [".BotFleet.update-4242-1757000000000.app"],
  );
});

// Second review round.

test("a failed dependency tree is set aside beside the checkout, never inside it", async () => {
  const source = await readFile(new URL("./update-botfleet-mac.mjs", import.meta.url), "utf8");
  // Anything left inside the checkout is untracked, and capturePrevious reads
  // `git status --porcelain` with untracked files included, so it would refuse
  // every later update until somebody found and removed it.
  assert.doesNotMatch(source, /\$\{liveDependencies\}\.failed-/);
  assert.match(source, /FAILED_DEPENDENCY_PREFIX = "\.botfleet-server\.node_modules\.failed-"/);
  assert.match(source, /const setAside = join\(dirname\(config\.checkout\), `\$\{FAILED_DEPENDENCY_PREFIX\}\$\{process\.pid\}-\$\{Date\.now\(\)\}`\)/);
  assert.match(source, /The failed replacement's dependency tree was set aside at/);
  // It carries a pid, so the ordinary candidate rule reaches it.
  assert.match(source, /sweepCandidates\(dirname\(config\.checkout\), FAILED_DEPENDENCY_PREFIX/);
  // And a dirty checkout says which paths are dirty.
  assert.match(source, /Live always-on checkout has changes; refusing update:\\n\$\{dirty\}/);
});

test("a set-aside dependency tree is swept by the same rule as a candidate", () => {
  const names = [
    "botfleet-server",
    ".botfleet-server.node_modules.failed-4242-1789260170446",
    ".botfleet-server.node_modules.failed-9999-1789260170447",
    ".botfleet-server.node_modules.update-9999-1789260170448",
  ];
  assert.deepEqual(
    staleCandidateNames(names, { prefix: ".botfleet-server.node_modules.failed-", isAlive: (pid) => pid === 4242 }),
    { stale: [".botfleet-server.node_modules.failed-9999-1789260170447"], unrecognised: [] },
  );
  // The failed prefix must not reach the update candidates or vice versa.
  assert.deepEqual(
    staleCandidateNames(names, { prefix: ".botfleet-server.node_modules.update-", isAlive: () => false }).stale,
    [".botfleet-server.node_modules.update-9999-1789260170448"],
  );
});

test("the provisional receipt survives a dependency restore that failed under a bundle restore that did not", () => {
  // rollback() runs the dependency restore first and the bundle restore
  // second, each clearing its own flag only on success.  A dependency restore
  // that throws therefore leaves its flag set while the bundle restore clears
  // its own, and that dependency tree is then the only copy in existence.
  const keeps = (swap) => Boolean(swap?.rollbackAppHolds || swap?.rollbackDependenciesHold);
  assert.equal(keeps({ rollbackAppHolds: false, rollbackDependenciesHold: true }), true);
  assert.equal(keeps({ rollbackAppHolds: true, rollbackDependenciesHold: false }), true);
  assert.equal(keeps({ rollbackAppHolds: true, rollbackDependenciesHold: true }), true);
  // Both restored, or the swap failed on its first rename and neither moved.
  assert.equal(keeps({ rollbackAppHolds: false, rollbackDependenciesHold: false }), false);

  return readFile(new URL("./update-botfleet-mac.mjs", import.meta.url), "utf8").then((source) => {
    assert.match(source, /if \(previous\.swap\?\.rollbackAppHolds \|\| previous\.swap\?\.rollbackDependenciesHold\) return;/);
  });
});

test("a port tells three different stories and only one of them is a failed shutdown", () => {
  assert.equal(quiescedPortError([{ kind: "none", port: 8799 }, { kind: "none", port: 18799 }]), null);
  assert.match(
    quiescedPortError([{ kind: "botfleet", pid: 42, port: 8799 }, { kind: "none", port: 18799 }]),
    /BotFleet still answers on port 8799 \(pid 42\) after graceful shutdown/,
  );
  // A stranger on a fallback port is named, so the operator knows what to free.
  assert.match(
    quiescedPortError([{ kind: "none", port: 8799 }, { kind: "foreign", port: 18799 }]),
    /Another service answers port 18799 \(a health response that is not BotFleet's\); free that port/,
  );
  assert.match(
    quiescedPortError([{ kind: "http", status: 503, port: 28799 }]),
    /port 28799 \(HTTP 503\)/,
  );
  // An ambiguous probe is reported as ambiguous, not as ownership.
  assert.match(
    quiescedPortError([{ kind: "unavailable", reason: "UND_ERR_CONNECT_TIMEOUT", port: 8799 }]),
    /did not answer conclusively after retries \(UND_ERR_CONNECT_TIMEOUT\)/,
  );
  // BotFleet outranks the rest: that is the one that means shutdown failed.
  assert.match(
    quiescedPortError([{ kind: "botfleet", pid: 7, port: 8799 }, { kind: "foreign", port: 18799 }]),
    /BotFleet still answers/,
  );
});

test("rollback waits on processes the transaction owns, never on a stranger's port", () => {
  assert.deepEqual(ownedRuntimePids({}), []);
  // A stranger and a timed-out probe are not the transaction's business.
  assert.deepEqual(
    ownedRuntimePids({ health: [{ kind: "foreign", port: 18799 }, { kind: "unavailable", port: 28799 }] }),
    [],
  );
  assert.deepEqual(
    ownedRuntimePids({
      holders: [11],
      bundlePids: [22, 11],
      health: [{ kind: "botfleet", pid: 33, port: 8799 }, { kind: "foreign", port: 18799 }],
      ownerPid: 44,
    }),
    [11, 22, 33, 44],
  );
  assert.deepEqual(ownedRuntimePids({ ownerPid: undefined, holders: [5] }), [5]);
});

test("the retrying probe asks again only when the answer was ambiguous", async () => {
  const source = await readFile(new URL("./update-botfleet-mac.mjs", import.meta.url), "utf8");
  assert.match(source, /if \(result\.kind !== "unavailable"\) return \{ \.\.\.result, port \};/);
  assert.match(source, /await sleep\(backoffMs \* \(attempt \+ 1\)\)/);
  // Both gates go through the retrying probe.
  assert.equal(source.split("probeHealthWithRetry(port)").length - 1 >= 2, true);
  // And rollback no longer refuses on port state alone.
  assert.doesNotMatch(source, /Rollback cannot mutate files while a BotFleet process, port, or database owner remains/);
  assert.match(source, /rollback is not waiting on it/);
});

test("leftover stages are pruned only when empty or entirely this updater's own work", () => {
  const now = 1789300000000;
  const day = 24 * 60 * 60 * 1000;
  const entry = (name, names, extra = {}) => ({
    name, path: `/updates/${name}`, names, mtimeMs: now, hasPrepared: names.includes("prepared.json"), hasGeneration: false, ...extra,
  });
  const entries = [
    entry(`empty-${now - 60_000}`, []),
    entry(`stale-${now - 2 * day}`, ["BotFleet.app", "node_modules"]),
    entry(`recent-${now - 60_000}`, ["BotFleet.app", "node_modules"]),
    // A person put evidence in this one, so it is only ever reported.
    entry(`evidence-${now - 2 * day}`, ["failed-BotFleet.app", "failed-BotFleet.app.json"]),
    entry(`prepared-${now - 5 * day}`, ["prepared.json", "BotFleet.app", "node_modules"]),
    entry(`generation-${now - 5 * day}`, ["rollback"], { hasGeneration: true }),
    entry(`referenced-${now - 5 * day}`, ["rollback"]),
  ];
  const { prune, report } = abandonedStages(entries, { now, referenced: ["/updates/referenced-" + (now - 5 * day)] });
  assert.deepEqual(prune, [`/updates/empty-${now - 60_000}`, `/updates/stale-${now - 2 * day}`]);
  assert.deepEqual(report, [`/updates/recent-${now - 60_000}`, `/updates/evidence-${now - 2 * day}`]);
  // A stage with a prepared manifest, one holding a generation, and one named
  // by a receipt are all left entirely alone.
  for (const kept of ["prepared", "generation", "referenced"]) {
    assert.equal([...prune, ...report].some((path) => path.includes(kept)), false, `${kept} must be untouched`);
  }
});

test("a stage the ci policy built is sweepable, because the hosted tree is ours", () => {
  const now = 1789300000000;
  const day = 24 * 60 * 60 * 1000;
  // The default `ci` policy unpacks the hosted build into `<stage>/hosted`
  // before `persistPrepared` copies the bundle to `<stage>/BotFleet.app`.  If
  // `hosted` were not on the allowlist, every stage the new default produces
  // would read as "holds files this updater did not write" and leak a full
  // extra copy of the app plus node_modules in the updates cache forever.
  const entry = {
    name: `hosted-${now - 2 * day}`,
    path: `/updates/hosted-${now - 2 * day}`,
    names: ["hosted", "BotFleet.app", "node_modules"],
    mtimeMs: now,
    hasPrepared: false,
    hasGeneration: false,
  };
  const { prune, report } = abandonedStages([entry], { now });
  assert.deepEqual(prune, [`/updates/hosted-${now - 2 * day}`]);
  assert.deepEqual(report, []);
});

test("stage age comes from the name the updater gave it", () => {
  assert.equal(stageStamp("4e3459758b67-1789257579801"), 1789257579801);
  // A hand-made directory ending in a date parses as a number too, and
  // reading it as epoch milliseconds would date the stage to 1970 and make it
  // look old enough to sweep.
  assert.equal(stageStamp("audit-ae8abe7d-v2-20260912"), null);
  assert.equal(stageStamp("audit-4ad1bc91-20260912"), null);
  assert.equal(stageStamp("no-stamp-here"), null);
  assert.equal(stageStamp("short-123"), null);
});

test("stage discovery never counts a stage that holds a rollback generation as leftover", async (t) => {
  const root = await fixture(t);
  const updates = join(root, "updates");
  const appPath = join(root, "Applications", "BotFleet.app");
  await mkdir(appPath, { recursive: true });
  const generationBundle = join(updates, "a-1789257579801", "rollback", "1789257579801-2246f19e9de8", "BotFleet.app");
  await mkdir(generationBundle, { recursive: true });
  await writeReceipt(`${generationBundle}.json`, {
    appPath, rollbackBundle: generationBundle, stageDirectory: join(updates, "a-1789257579801"), installedAt: "2026-09-12T00:00:00.000Z",
  });
  await mkdir(join(updates, "b-1789257579802"), { recursive: true });

  const { generations } = await rollbackGenerations({ appPath, updatesDirectory: updates });
  const { entries, referenced } = await stageEntries({ updatesDirectory: updates }, generations);
  const holder = entries.find((item) => item.name === "a-1789257579801");
  assert.equal(holder.hasGeneration, true);
  assert.ok(referenced.includes(join(updates, "a-1789257579801")));
  const { prune } = abandonedStages(entries, { referenced });
  // Only the genuinely empty one goes.
  assert.deepEqual(prune, [join(updates, "b-1789257579802")]);
});
