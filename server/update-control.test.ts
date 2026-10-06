// The four things that decide whether "install the update" is safe: the
// status shape both clients render, the refusals, what the launcher actually
// runs, and the reconcile that lets a run survive the restart it performs.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  availableIsStale,
  BUSY_REFUSAL,
  createUpdateControl,
  launchdJobIsAlive,
  launchPlanCommand,
  listLaunchJobCommand,
  parseProgressRecord,
  pruneRunArtifacts,
  pruneUpdateStages,
  removeLaunchJobCommand,
  runRefusal,
  stagesToPrune,
  stageStamp,
  stepLabel,
  type CommandResult,
  type LaunchPlan,
  type RuntimeReadiness,
  type UpdateCapabilities,
  type UpdateControl,
  type UpdateStatus,
} from "./update-control.ts";
// Test-only import of the updater's own step list.  It keeps the two files
// honest about each other without the production bundle depending on a script.
import { APPLY_STEPS, PREPARE_STEPS } from "../scripts/mac-update-transaction.mjs";
import { UPDATE_STEP_LABELS } from "./update-control.ts";

const INSTALLED_COMMIT = "a".repeat(40);
const NEW_COMMIT = "b".repeat(40);
const UNIT = "\u001f";

const roots: string[] = [];
const controls: UpdateControl[] = [];

afterEach(() => {
  for (const control of controls.splice(0)) control.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A temp Mac: an always-on checkout with a `.git`, an updater script, and an
 * empty state directory. */
function rig() {
  const root = mkdtempSync(join(tmpdir(), "bf-update-control-"));
  roots.push(root);
  const checkout = join(root, "checkout");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  const scriptPath = join(root, "update-botfleet.sh");
  writeFileSync(scriptPath, "#!/bin/bash\n", { mode: 0o700 });
  return {
    root,
    checkout,
    scriptPath,
    stateDirectory: join(root, "state"),
    updatesDirectory: join(root, "updates"),
  };
}

/** One stage directory under the updates root, named the way the updater
 * names them: the target commit, then the epoch millisecond it was made. */
function stage(paths: ReturnType<typeof rig>, commit: string, stamp: number, names: string[] = ["source"]) {
  const path = join(paths.updatesDirectory, `${commit}-${stamp}`);
  mkdirSync(path, { recursive: true });
  for (const name of names) {
    if (name.endsWith(".json")) writeFileSync(join(path, name), "{}\n");
    else mkdirSync(join(path, name), { recursive: true });
  }
  return path;
}

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
const fail = (): CommandResult => ({ code: 1, stdout: "", stderr: "boom" });

interface Harness {
  control: UpdateControl;
  launched: LaunchPlan[];
  emitted: UpdateStatus[];
  git: string[][];
  /** Every command the controller ran itself — only ever `launchctl`. */
  ran: { command: string; args: string[] }[];
}

function build(
  paths: ReturnType<typeof rig>,
  options: {
    platform?: string;
    git?: (args: string[]) => CommandResult;
    processAlive?: (pid: number) => boolean;
    updaterReportsProgress?: boolean;
    readiness?: RuntimeReadiness;
    launchDelay?: () => Promise<void>;
    installedAt?: string;
    writeState?: (path: string, value: unknown) => void;
    now?: () => Date;
    installedCommit?: string;
    launcher?: "launchd" | "detached";
    exec?: (command: string, args: string[]) => CommandResult;
  } = {},
): Harness {
  const launched: LaunchPlan[] = [];
  const emitted: UpdateStatus[] = [];
  const git: string[][] = [];
  const ran: { command: string; args: string[] }[] = [];
  const control = createUpdateControl({
    installed: {
      version: "1.0.30",
      sourceCommit: options.installedCommit ?? INSTALLED_COMMIT,
      ...(options.installedAt ? { installedAt: options.installedAt } : {}),
    },
    checkout: paths.checkout,
    stateDirectory: paths.stateDirectory,
    updatesDirectory: paths.updatesDirectory,
    scriptPath: paths.scriptPath,
    platform: options.platform ?? "darwin",
    nodeDirectory: "/opt/homebrew/bin",
    now: options.now ?? (() => new Date("2026-09-13T12:00:00.000Z")),
    git: async (args) => {
      git.push(args);
      return options.git ? options.git(args) : ok();
    },
    launch: async (plan) => {
      if (options.launchDelay) await options.launchDelay();
      launched.push(plan);
      return { launcher: options.launcher ?? "launchd" };
    },
    exec: async (command, args) => {
      ran.push({ command, args });
      return options.exec ? options.exec(command, args) : ok();
    },
    readiness: () => options.readiness ?? { safeToRestart: true, activeWorkCount: 0 },
    ...(options.writeState ? { writeState: options.writeState } : {}),
    processAlive: options.processAlive ?? (() => true),
    updaterReportsProgress: () => options.updaterReportsProgress ?? true,
    newRunId: () => "run_one",
    emit: (status) => emitted.push(status),
    pollIntervalMs: 50,
  });
  controls.push(control);
  return { control, launched, emitted, git, ran };
}

/** One run's progress file, as `scripts/update-progress.mjs` writes it. */
function writeProgress(paths: ReturnType<typeof rig>, runId: string, patch: Record<string, unknown>) {
  const file = join(paths.stateDirectory, "runs", `${runId}.progress.json`);
  mkdirSync(join(paths.stateDirectory, "runs"), { recursive: true });
  writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    runId,
    command: "update",
    pid: 4321,
    startedAt: "2026-09-13T11:55:00.000Z",
    updatedAt: "2026-09-13T11:58:00.000Z",
    step: null,
    progress: null,
    targetCommit: NEW_COMMIT,
    receiptPath: null,
    finishedAt: null,
    outcome: null,
    message: null,
    ...patch,
  }));
  return file;
}

function writeCurrentRun(paths: ReturnType<typeof rig>, runId: string, launcher = "launchd") {
  mkdirSync(paths.stateDirectory, { recursive: true });
  writeFileSync(join(paths.stateDirectory, "current-run.json"), JSON.stringify({
    runId,
    startedAt: "2026-09-13T11:55:00.000Z",
    progressPath: join(paths.stateDirectory, "runs", `${runId}.progress.json`),
    logPath: join(paths.stateDirectory, "runs", `${runId}.log`),
    launcher,
    targetCommit: NEW_COMMIT,
  }));
}

describe("status", () => {
  it("describes a Mac that has never checked", () => {
    const paths = rig();
    const status = build(paths).control.status();
    expect(status).toMatchObject({
      installed: { version: "1.0.30", sourceCommit: INSTALLED_COMMIT },
      available: null,
      checkedAt: null,
      checkError: null,
      running: null,
      lastRun: null,
      capabilities: { canCheck: true, canRun: true, reasons: [], codes: [] },
    });
  });

  it("says why it cannot, one reason at a time", () => {
    const paths = rig();
    expect(build(paths, { platform: "win32" }).control.status().capabilities).toEqual({
      canCheck: false,
      canRun: false,
      reasons: ["Updating from this computer is macOS only."],
      codes: ["not-darwin"],
    });

    const noCheckout = rig();
    rmSync(join(noCheckout.checkout, ".git"), { recursive: true, force: true });
    const capabilities = build(noCheckout).control.status().capabilities;
    expect(capabilities.canCheck).toBe(false);
    expect(capabilities.reasons[0]).toContain(noCheckout.checkout);
    expect(capabilities.codes[0]).toBe("checkout-missing");

    const stale = build(rig(), { updaterReportsProgress: false }).control.status().capabilities;
    expect(stale).toMatchObject({ canCheck: true, canRun: false });
    expect(stale.reasons[0]).toContain("predates this build");
    expect(stale.codes[0]).toBe("updater-outdated");

    const noScript = rig();
    rmSync(noScript.scriptPath, { force: true });
    const script = build(noScript).control.status().capabilities;
    expect(script).toMatchObject({ canCheck: true, canRun: false });
    expect(script.reasons[0]).toContain(noScript.scriptPath);
    expect(script.codes[0]).toBe("updater-missing");
  });
});

describe("check", () => {
  const gitFor = (head: string) => (args: string[]): CommandResult => {
    if (args[0] === "rev-parse") return ok(`${head}\n`);
    if (args[0] === "rev-list") return ok("12\n");
    if (args[0] === "log") {
      return ok([
        `${NEW_COMMIT}${UNIT}feat(engines): room turns on the HTTP lane`,
        `${"c".repeat(40)}${UNIT}fix(usage): dual-window quota display`,
      ].join("\n"));
    }
    if (args[0] === "show") return ok(JSON.stringify({ version: "1.0.31" }));
    return ok();
  };

  it("reports what origin/main is ahead by, with subjects and a version", async () => {
    const paths = rig();
    const harness = build(paths, { git: gitFor(NEW_COMMIT) });
    const status = await harness.control.check();
    expect(harness.git[0]).toEqual(["fetch", "origin", "main"]);
    expect(status.checkedAt).toBe("2026-09-13T12:00:00.000Z");
    expect(status.available).toEqual({
      sourceCommit: NEW_COMMIT,
      version: "1.0.31",
      aheadBy: 12,
      commits: [
        { sha: NEW_COMMIT, subject: "feat(engines): room turns on the HTTP lane" },
        { sha: "c".repeat(40), subject: "fix(usage): dual-window quota display" },
      ],
    });
    // A second control reads the same answer back without a fetch.
    expect(build(paths).control.status().available?.sourceCommit).toBe(NEW_COMMIT);
  });

  it("clears the answer once the installed commit is origin/main", async () => {
    const paths = rig();
    const harness = build(paths, { git: gitFor(NEW_COMMIT) });
    await harness.control.check();
    const caughtUp = build(paths, { git: gitFor(NEW_COMMIT), installedCommit: NEW_COMMIT });
    expect((await caughtUp.control.check()).available).toBeNull();
  });

  it("keeps the previous answer when git cannot resolve origin/main", async () => {
    const paths = rig();
    const harness = build(paths, { git: gitFor(NEW_COMMIT) });
    await harness.control.check();
    const offline = build(paths, { git: () => fail() });
    const status = await offline.control.check();
    expect(status.available?.sourceCommit).toBe(NEW_COMMIT);
    expect(status.checkedAt).toBe("2026-09-13T12:00:00.000Z");
  });
});

describe("refusals", () => {
  const capabilities: UpdateCapabilities = { canCheck: true, canRun: true, reasons: [], codes: [] };
  const available = { sourceCommit: NEW_COMMIT, aheadBy: 3, commits: [] };
  const running = { runId: "run_one", startedAt: "", step: "Building", logTail: [] };
  const idle: RuntimeReadiness = { safeToRestart: true, activeWorkCount: 0 };
  const busy: RuntimeReadiness = { safeToRestart: false, activeWorkCount: 2 };
  const ask = (patch: Partial<Parameters<typeof runRefusal>[0]>) => runRefusal({
    capabilities,
    running: null,
    available,
    readiness: idle,
    dirty: false,
    force: false,
    ...patch,
  });

  it("names the one blocking reason", () => {
    expect(ask({ running })).toBe("An update is already running.");
    expect(ask({
      capabilities: { canCheck: false, canRun: false, reasons: ["Updating from this computer is macOS only."], codes: ["not-darwin"] },
    })).toBe("Updating from this computer is macOS only.");
    expect(ask({ dirty: true })).toContain("uncommitted changes");
    expect(ask({ available: null })).toBe("BotFleet is already on the newest build.");
    expect(ask({ available: null, force: true })).toBeNull();
    expect(ask({})).toBeNull();
  });

  it("will not re-offer the build that is already installed", () => {
    expect(ask({ available: null })).toBe("BotFleet is already on the newest build.");
    expect(ask({ available: null, force: true })).toBeNull();
  });

  it("calls an answer stale when it cannot describe anything newer", () => {
    const at = (iso: string) => iso;
    const answer = { sourceCommit: NEW_COMMIT, aheadBy: 3, commits: [] };
    const base = {
      available: answer,
      installedCommit: INSTALLED_COMMIT,
      checkedAt: at("2026-09-13T12:00:00.000Z"),
    };
    expect(availableIsStale(base)).toBe(false);
    expect(availableIsStale({ ...base, available: null })).toBe(true);
    // Names the commit now installed: this process IS the result.
    expect(availableIsStale({ ...base, installedCommit: NEW_COMMIT })).toBe(true);
    // Recorded before this build was installed, so it cannot describe
    // anything newer than it — the X-then-Y case, where check() saw X,
    // origin/main moved to Y, and Y is what got installed.
    expect(availableIsStale({ ...base, installedAt: at("2026-09-13T12:30:00.000Z") })).toBe(true);
    expect(availableIsStale({ ...base, installedAt: at("2026-09-13T11:30:00.000Z") })).toBe(false);
    // A source build has no installedAt; a VERIFIED run's finish is the same line.
    expect(availableIsStale({ ...base, verifiedRunFinishedAt: at("2026-09-13T12:30:00.000Z") })).toBe(true);
    // An answer with no usable timestamp cannot be placed, so it is not acted on.
    expect(availableIsStale({ ...base, checkedAt: null })).toBe(true);
    expect(availableIsStale({ ...base, checkedAt: "not a date" })).toBe(true);
  });

  it("will not interrupt a turn, and force is the one thing that talks past it", () => {
    expect(ask({ readiness: busy })).toBe(BUSY_REFUSAL);
    expect(ask({ readiness: busy, force: true })).toBeNull();
    // Busy closes canRun too, and forcing past busy must not then trip over
    // the reason busy itself put in the list.
    expect(ask({
      readiness: busy,
      capabilities: { canCheck: true, canRun: false, reasons: [BUSY_REFUSAL], codes: ["busy"] },
      force: true,
    })).toBeNull();
    // A structural reason still wins, forced or not.
    expect(ask({
      readiness: busy,
      capabilities: { canCheck: true, canRun: false, reasons: [BUSY_REFUSAL, "The updater is not installed."], codes: ["busy", "updater-missing"] },
      force: true,
    })).toBe("The updater is not installed.");
  });

  it("refuses to launch with nothing to install, and force overrides it", async () => {
    const paths = rig();
    const harness = build(paths);
    const refused = await harness.control.start();
    expect(refused).toMatchObject({ ok: false, error: "BotFleet is already on the newest build." });
    expect(harness.launched).toHaveLength(0);

    const forced = await harness.control.start({ force: true });
    expect(forced.ok).toBe(true);
    expect(harness.launched).toHaveLength(1);
  });

  it("refuses while the always-on checkout is dirty", async () => {
    const paths = rig();
    const harness = build(paths, {
      git: (args) => (args[0] === "status" ? ok(" M electron/vendor/electron-updater.cjs\n") : ok()),
    });
    const refused = await harness.control.start({ force: true });
    expect(refused.ok).toBe(false);
    expect(harness.launched).toHaveLength(0);
  });

  it("refuses while a turn is in flight, and says so in the capabilities", async () => {
    const paths = rig();
    const harness = build(paths, { readiness: { safeToRestart: false, activeWorkCount: 3 } });
    const status = harness.control.status();
    expect(status.capabilities.canRun).toBe(false);
    expect(status.capabilities.reasons).toContain(BUSY_REFUSAL);
    expect(status.capabilities.canCheck).toBe(true);
    // `codes` walks `reasons` in lockstep, so a client can match the busy
    // refusal by code instead of comparing the sentence.
    expect(status.capabilities.codes).toEqual(["busy"]);
    const refused = await harness.control.start({ force: true });
    // force is allowed past readiness; the refusal here is only that there is
    // nothing newer, which proves readiness was not the blocker.
    expect(refused.ok).toBe(true);

    const blocked = build(rig(), { readiness: { safeToRestart: false, activeWorkCount: 3 } });
    expect(await blocked.control.start()).toMatchObject({ ok: false, error: BUSY_REFUSAL });
    expect(blocked.launched).toHaveLength(0);
  });

  it("takes the caller's readiness over its own when one is given", async () => {
    const paths = rig();
    // The route excludes the admission it holds itself; without that override
    // every run would see its own request as work it must not interrupt.
    const harness = build(paths, { readiness: { safeToRestart: false, activeWorkCount: 1 } });
    const started = await harness.control.start({
      force: true,
      readiness: { safeToRestart: true, activeWorkCount: 0 },
    });
    expect(started.ok).toBe(true);
    expect(harness.launched).toHaveLength(1);
  });

  it("checks the checkout even on a busy machine a caller is forcing past", async () => {
    // `force` talks past readiness, which used to skip the dirty precheck
    // with it — so a forced run on a dirty checkout launched a whole
    // transaction for the updater to refuse a minute later.
    const paths = rig();
    const harness = build(paths, {
      readiness: { safeToRestart: false, activeWorkCount: 2 },
      git: (args) => (args[0] === "status" ? ok(" M electron/vendor/electron-updater.cjs\n") : ok()),
    });
    const refused = await harness.control.start({ force: true });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toContain("uncommitted changes");
    expect(harness.launched).toHaveLength(0);
  });

  it("refuses a second run while one is in flight", async () => {
    const paths = rig();
    const harness = build(paths);
    expect((await harness.control.start({ force: true })).ok).toBe(true);
    writeProgress(paths, "run_one", { step: "buildBundle", progress: 0.25 });
    const second = await harness.control.start({ force: true });
    expect(second).toMatchObject({ ok: false, error: "An update is already running." });
    expect(harness.launched).toHaveLength(1);
  });
});

describe("checking when the fetch does not work", () => {
  it("reports the failure instead of reading a stale origin/main as up to date", async () => {
    const paths = rig();
    // Offline: `git fetch` fails, but `origin/main` is still on disk from the
    // last time it worked — and it happens to equal what is installed.
    const harness = build(paths, {
      git: (args) => {
        if (args[0] === "fetch") return { code: 1, stdout: "", stderr: "fatal: unable to access 'https://…': could not resolve host\n" };
        if (args[0] === "rev-parse") return ok(`${INSTALLED_COMMIT}\n`);
        return ok();
      },
    });
    const status = await harness.control.check();
    expect(status.checkedAt).toBeNull();
    expect(status.checkError).toContain("Could not reach the update source.");
    expect(status.checkError).toContain("could not resolve host");
    expect(status.available).toBeNull();
  });

  it("keeps the previous answer, and its timestamp, when a check fails", async () => {
    const paths = rig();
    const online = (args: string[]): CommandResult => {
      if (args[0] === "rev-parse") return ok(`${NEW_COMMIT}\n`);
      if (args[0] === "rev-list") return ok("4\n");
      if (args[0] === "log") return ok(`${NEW_COMMIT}${UNIT}feat: something`);
      if (args[0] === "show") return ok(JSON.stringify({ version: "1.0.31" }));
      return ok();
    };
    let offline = false;
    const harness = build(paths, {
      git: (args) => (offline && args[0] === "fetch" ? fail() : online(args)),
    });
    const good = await harness.control.check();
    expect(good.checkedAt).toBe("2026-09-13T12:00:00.000Z");
    expect(good.checkError).toBeNull();
    offline = true;
    const bad = await harness.control.check();
    expect(bad.checkedAt).toBe("2026-09-13T12:00:00.000Z");
    expect(bad.checkError).toContain("Could not reach the update source.");
    expect(bad.available?.sourceCommit).toBe(NEW_COMMIT);
  });

  it("says so when origin/main cannot be resolved even after a good fetch", async () => {
    const paths = rig();
    const harness = build(paths, {
      git: (args) => (args[0] === "rev-parse" ? fail() : ok()),
    });
    const status = await harness.control.check();
    expect(status.checkedAt).toBeNull();
    expect(status.checkError).toContain("Could not read origin/main");
  });

  it("clears the failure once a check works again", async () => {
    const paths = rig();
    let offline = true;
    const harness = build(paths, {
      git: (args) => {
        if (args[0] === "fetch") return offline ? fail() : ok();
        if (args[0] === "rev-parse") return ok(`${INSTALLED_COMMIT}\n`);
        return ok();
      },
    });
    expect((await harness.control.check()).checkError).not.toBeNull();
    offline = false;
    const recovered = await harness.control.check();
    expect(recovered.checkError).toBeNull();
    expect(recovered.checkedAt).toBe("2026-09-13T12:00:00.000Z");
  });
});

describe("an unsuccessful run", () => {
  const seedLastRun = (paths: ReturnType<typeof rig>, outcome: string) => {
    mkdirSync(paths.stateDirectory, { recursive: true });
    writeFileSync(join(paths.stateDirectory, "last-run.json"), JSON.stringify({
      runId: "run_prior",
      startedAt: "2026-09-13T12:20:00.000Z",
      finishedAt: "2026-09-13T12:30:00.000Z",
      outcome,
      message: "whatever happened",
    }));
    writeFileSync(join(paths.stateDirectory, "available.json"), JSON.stringify({
      checkedAt: "2026-09-13T12:00:00.000Z",
      available: { sourceCommit: NEW_COMMIT, version: "1.0.31", aheadBy: 4, commits: [] },
    }));
  };

  it("leaves the available answer alone — it installed nothing", () => {
    // Refused, failed and rolled-back runs all have a finishedAt, and none of
    // them changed what is installed.  Treating them as the staleness
    // boundary threw away a good answer every time a run was declined.
    for (const outcome of ["refused", "failed", "rolled-back"]) {
      const paths = rig();
      seedLastRun(paths, outcome);
      const status = build(paths).control.status();
      expect(status.lastRun?.outcome, outcome).toBe(outcome);
      expect(status.available?.sourceCommit, outcome).toBe(NEW_COMMIT);
    }
  });

  it("but a verified one does move the line", () => {
    const paths = rig();
    seedLastRun(paths, "verified");
    const status = build(paths).control.status();
    expect(status.available).toBeNull();
  });
});

describe("the launcher", () => {
  it("submits a one-shot launchd job that outlives both parents", () => {
    const { command, args } = launchPlanCommand({
      runId: "run_one",
      progressPath: "/tmp/state/runs/run_one.progress.json",
      logPath: "/tmp/state/runs/run_one.log",
      scriptPath: "/Users/jay/apps/update-botfleet.sh",
      label: "com.jay.botfleet-update",
      nodeDirectory: "/opt/homebrew/bin",
    });
    expect(command).toBe("/bin/launchctl");
    expect(args.slice(0, 8)).toEqual([
      "submit",
      "-l",
      "com.jay.botfleet-update",
      "-o",
      "/tmp/state/runs/run_one.log",
      "-e",
      "/tmp/state/runs/run_one.log",
      "--",
    ]);
    expect(args[8]).toBe("/bin/bash");
    expect(args[9]).toBe("-c");
    // launchd hands a job the system PATH, which has no Homebrew on it.
    expect(args[10]).toContain("export PATH='/opt/homebrew/bin'");
    expect(args[10]).toContain("--progress '/tmp/state/runs/run_one.progress.json'");
    expect(args[10]).toContain("--run-id 'run_one'");
  });

  it("records the run before launching it, and launches nothing it cannot record", async () => {
    const paths = rig();
    const order: string[] = [];
    const harness = build(paths, {
      writeState: (path, value) => {
        order.push(`write:${path.endsWith("current-run.json") ? "current-run" : "other"}`);
        mkdirSync(join(paths.stateDirectory, "runs"), { recursive: true });
        writeFileSync(path, JSON.stringify(value));
      },
      launchDelay: async () => void order.push("launch"),
    });
    expect((await harness.control.start({ force: true })).ok).toBe(true);
    // Written afterwards, a failed write left a real updater running that no
    // harness knew about.
    expect(order.indexOf("write:current-run")).toBeLessThan(order.indexOf("launch"));

    const refusing = build(rig(), {
      writeState: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    const blocked = await refusing.control.start({ force: true });
    expect(blocked.ok).toBe(false);
    expect(blocked.ok === false && blocked.error).toContain("could not be recorded");
    expect(refusing.launched).toHaveLength(0);
  });

  it("does not leave a record behind when the launch itself fails", async () => {
    const paths = rig();
    const harness = build(paths, {
      launchDelay: async () => {
        throw new Error("A com.jay.botfleet-update job is already running on this Mac.");
      },
    });
    const failed = await harness.control.start({ force: true });
    expect(failed.ok).toBe(false);
    expect(failed.ok === false && failed.error).toContain("could not be started");
    expect(harness.control.status().running).toBeNull();
    expect(existsSync(join(paths.stateDirectory, "current-run.json"))).toBe(false);
    // And a later harness does not find a phantom run either.
    expect(build(paths).control.status().running).toBeNull();
  });

  it("starts exactly one job when two callers race", async () => {
    const paths = rig();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = build(paths, { launchDelay: () => gate });
    // Both land before either has written current-run.json.  Without a
    // synchronous guard both would launch, and the second submit's
    // `launchctl remove` would SIGTERM the first mid-install.
    const first = harness.control.start({ force: true });
    const second = await harness.control.start({ force: true });
    expect(second).toMatchObject({ ok: false, error: "An update is already running." });
    release!();
    expect((await first).ok).toBe(true);
    expect(harness.launched).toHaveLength(1);
  });

  it("reads a live launchd job as alive, and a merely registered one as not", () => {
    const listed = (stdout: string, code = 0) => ({ code, stdout, stderr: "" });
    expect(launchdJobIsAlive(listed('{\n\t"PID" = 4321;\n\t"Label" = "com.jay.botfleet-update";\n};'))).toBe(true);
    // Registered, already exited — safe to clear before the next submit.
    expect(launchdJobIsAlive(listed('{\n\t"LastExitStatus" = 0;\n\t"Label" = "com.jay.botfleet-update";\n};')))
      .toBe(false);
    // No such label at all.
    expect(launchdJobIsAlive(listed("Could not find service\n", 113))).toBe(false);
  });

  it("hands the run its own progress file and log, and remembers it", async () => {
    const paths = rig();
    const harness = build(paths);
    const started = await harness.control.start({ force: true });
    expect(started.ok && started.runId).toBe("run_one");
    expect(harness.launched[0]).toMatchObject({
      runId: "run_one",
      scriptPath: paths.scriptPath,
      label: "com.jay.botfleet-update",
    });
    // A fresh control — a restarted harness — still sees the run.
    const reborn = build(paths);
    expect(reborn.control.status().running?.runId).toBe("run_one");
  });
});

describe("reconcile on boot", () => {
  it("describes a run started before this process existed", () => {
    const paths = rig();
    writeCurrentRun(paths, "run_prior");
    writeProgress(paths, "run_prior", { step: "startHarness", progress: 0.8 });
    writeFileSync(join(paths.stateDirectory, "runs", "run_prior.log"), "Prepared bbbbbbbbbbbb\nstarting harness\n");
    const status = build(paths).control.status();
    expect(status.running).toMatchObject({
      runId: "run_prior",
      step: "Starting the harness",
      progress: 0.8,
    });
    expect(status.running?.logTail).toEqual(["Prepared bbbbbbbbbbbb", "starting harness"]);
    // A run in flight closes the door on a second one.
    expect(status.capabilities.canRun).toBe(false);
  });

  /** A state directory carrying an answer this process must drop — the case
   * that used to write during construction. */
  function seedStaleAnswer(paths: ReturnType<typeof rig>) {
    mkdirSync(paths.stateDirectory, { recursive: true });
    writeFileSync(join(paths.stateDirectory, "available.json"), JSON.stringify({
      checkedAt: "2026-09-13T11:00:00.000Z",
      available: { sourceCommit: INSTALLED_COMMIT, version: "1.0.30", aheadBy: 1, commits: [] },
    }));
  }

  async function expectSurvivesUnwritableState(harness: Harness, paths: ReturnType<typeof rig>) {
    const status = harness.control.status();
    expect(status.available).toBeNull();
    expect(status.installed.version).toBe("1.0.30");
    expect(status.capabilities.canRun).toBe(true);
    // A run still refuses for the right reason rather than throwing.
    expect(await harness.control.start()).toMatchObject({
      ok: false,
      error: "BotFleet is already on the newest build.",
    });
    // The write really did fail — the stale answer is still on disk.
    const onDisk = JSON.parse(readFileSync(join(paths.stateDirectory, "available.json"), "utf8"));
    expect(onDisk.available?.sourceCommit).toBe(INSTALLED_COMMIT);
  }

  it("still boots and answers when a state write throws", async () => {
    // `createUpdateControl` runs at module scope in server/index.ts, so a
    // throw on this path is a harness that does not start.  The failure is
    // injected rather than arranged with directory permissions: what matters
    // is that a throwing write is survived, and `chmod 0o500` does not deny
    // a directory write on Windows at all.
    const paths = rig();
    seedStaleAnswer(paths);
    const warnings: unknown[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      const harness = build(paths, {
        writeState: () => {
          throw Object.assign(new Error("EACCES: permission denied, open 'available.json'"), { code: "EACCES" });
        },
      });
      await expectSurvivesUnwritableState(harness, paths);
      expect(warnings.length).toBeGreaterThan(0);
    } finally {
      console.warn = warn;
    }
  });

  // The same property against the real filesystem, where permissions mean
  // what this asks of them.  Windows ignores the mode, and root is not
  // denied by it either.
  const permissionsApply = process.platform !== "win32" && process.getuid?.() !== 0;
  it.skipIf(!permissionsApply)("survives a state directory the OS will not let it write", async () => {
    const paths = rig();
    seedStaleAnswer(paths);
    const warn = console.warn;
    console.warn = () => {};
    chmodSync(paths.stateDirectory, 0o500);
    try {
      await expectSurvivesUnwritableState(build(paths), paths);
    } finally {
      console.warn = warn;
      chmodSync(paths.stateDirectory, 0o700);
    }
  });

  it("refuses to start a run it would not be able to describe", async () => {
    // The runs directory is the one write that IS load-bearing: with nowhere
    // to put the progress file the run would be one nothing could report on,
    // which is the failure this whole module exists to prevent.  A plain file
    // where the state directory should be denies the mkdir on every platform.
    const base = rig();
    const blocker = join(base.root, "blocked");
    writeFileSync(blocker, "not a directory");
    const harness = build({ ...base, stateDirectory: blocker });
    const started = await harness.control.start({ force: true });
    expect(started.ok).toBe(false);
    expect(started.ok === false && started.error).toContain("could not be recorded");
    expect(harness.launched).toHaveLength(0);
  });

  it("drops an available answer that names the commit now installed", async () => {
    const paths = rig();
    const gitFor = (args: string[]): CommandResult => {
      if (args[0] === "rev-parse") return ok(`${NEW_COMMIT}\n`);
      if (args[0] === "rev-list") return ok("4\n");
      if (args[0] === "log") return ok(`${NEW_COMMIT}${UNIT}feat: something`);
      if (args[0] === "show") return ok(JSON.stringify({ version: "1.0.31" }));
      return ok();
    };
    const before = build(paths, { git: gitFor });
    expect(before.control.status().available).toBeNull();
    expect((await before.control.check()).available?.sourceCommit).toBe(NEW_COMMIT);

    // Now the harness restarts, running the build that was on offer.
    const after = build(paths, { git: gitFor, installedCommit: NEW_COMMIT });
    expect(after.control.status().available).toBeNull();
    // And the invalidation reaches disk, so the next boot never sees it.
    const third = build(paths, { git: gitFor, installedCommit: NEW_COMMIT });
    expect(third.control.status().available).toBeNull();
    // Install must not start a whole transaction to arrive where it is.
    expect(await after.control.start()).toMatchObject({
      ok: false,
      error: "BotFleet is already on the newest build.",
    });
    expect(after.launched).toHaveLength(0);
  });

  it("drops an answer recorded before the build that is now installed", async () => {
    // check() records X.  origin/main moves on to Y.  The install that runs
    // takes Y, and X is now BEHIND us — a different commit from the installed
    // one, and still nothing to install.
    const paths = rig();
    const OLDER = "d".repeat(40);
    const gitForX = (args: string[]): CommandResult => {
      if (args[0] === "rev-parse") return ok(`${OLDER}\n`);
      if (args[0] === "rev-list") return ok("2\n");
      if (args[0] === "log") return ok(`${OLDER}${UNIT}feat: x`);
      if (args[0] === "show") return ok(JSON.stringify({ version: "1.0.31" }));
      return ok();
    };
    const early = build(paths, {
      git: gitForX,
      now: () => new Date("2026-09-13T12:00:00.000Z"),
    });
    expect((await early.control.check()).available?.sourceCommit).toBe(OLDER);

    // The harness comes back as Y, installed after that answer was recorded.
    const gitCalls: string[][] = [];
    const later = build(paths, {
      installedCommit: NEW_COMMIT,
      installedAt: "2026-09-13T12:30:00.000Z",
      git: (args) => {
        gitCalls.push(args);
        return args[0] === "merge-base" ? ok() : gitForX(args);
      },
    });
    expect(later.control.status().available).toBeNull();
    expect(await later.control.start()).toMatchObject({
      ok: false,
      error: "BotFleet is already on the newest build.",
    });
    expect(later.launched).toHaveLength(0);
  });

  it("asks git before launching, and refuses an answer already contained in this build", async () => {
    const paths = rig();
    const OLDER = "d".repeat(40);
    // Timestamps say the answer is fresh, so only git can catch this one.
    const harness = build(paths, {
      git: (args) => {
        if (args[0] === "rev-parse") return ok(`${OLDER}\n`);
        if (args[0] === "rev-list") return ok("2\n");
        if (args[0] === "log") return ok(`${OLDER}${UNIT}feat: x`);
        if (args[0] === "show") return ok(JSON.stringify({ version: "1.0.31" }));
        // `merge-base --is-ancestor` exits 0: already in this build.
        if (args[0] === "merge-base") return ok();
        return ok();
      },
    });
    await harness.control.check();
    expect(harness.control.status().available?.sourceCommit).toBe(OLDER);
    const refused = await harness.control.start();
    expect(refused).toMatchObject({ ok: false, error: "BotFleet is already on the newest build." });
    expect(harness.launched).toHaveLength(0);
    // And the answer is gone afterwards, not re-offered on the next status.
    expect(harness.control.status().available).toBeNull();
  });

  it("folds a finished run into lastRun and forgets the current one", () => {
    const paths = rig();
    writeCurrentRun(paths, "run_prior");
    writeProgress(paths, "run_prior", {
      finishedAt: "2026-09-13T11:59:00.000Z",
      outcome: "verified",
      message: "The update installed and verified.",
      receiptPath: "/Users/jay/Library/Caches/BotFleet/updates/bbbb-1/prepared.json",
    });
    const status = build(paths).control.status();
    expect(status.running).toBeNull();
    expect(status.lastRun).toEqual({
      runId: "run_prior",
      startedAt: "2026-09-13T11:55:00.000Z",
      finishedAt: "2026-09-13T11:59:00.000Z",
      outcome: "verified",
      message: "The update installed and verified.",
      receiptPath: "/Users/jay/Library/Caches/BotFleet/updates/bbbb-1/prepared.json",
    });
    expect(status.capabilities.canRun).toBe(true);
    // And it stays folded for the next harness after this one.
    expect(build(paths).control.status().lastRun?.outcome).toBe("verified");
  });

  it("closes out a run whose process is gone without an outcome", () => {
    const paths = rig();
    writeCurrentRun(paths, "run_prior");
    writeProgress(paths, "run_prior", { step: "buildBundle" });
    const status = build(paths, { processAlive: () => false }).control.status();
    expect(status.running).toBeNull();
    expect(status.lastRun?.outcome).toBe("failed");
    expect(status.lastRun?.message).toContain("without recording an outcome");
  });

  it("gives a just-launched run time to write its first record", () => {
    const paths = rig();
    writeCurrentRun(paths, "run_prior");
    const young = build(paths, { now: () => new Date("2026-09-13T11:55:30.000Z") });
    expect(young.control.status().running?.step).toBe("Starting the updater");

    const old = build(paths, { now: () => new Date("2026-09-13T12:05:00.000Z") });
    expect(old.control.status().running).toBeNull();
    expect(old.control.status().lastRun?.message).toContain("never started");
  });

  it("pushes a status only when it changed", async () => {
    const paths = rig();
    const harness = build(paths);
    expect(harness.emitted).toHaveLength(0);
    await harness.control.start({ force: true });
    expect(harness.emitted).toHaveLength(1);
    harness.control.reconcile();
    expect(harness.emitted).toHaveLength(1);
    writeProgress(paths, "run_one", { step: "buildBundle", progress: 0.25 });
    harness.control.reconcile();
    expect(harness.emitted).toHaveLength(2);
    expect(harness.emitted[1].running?.step).toBe("Building and signing the app");
  });
});

describe("reading what another process wrote", () => {
  it("refuses a record it does not recognise, rather than throwing", () => {
    expect(parseProgressRecord(null)).toBeNull();
    expect(parseProgressRecord("{}")).toBeNull();
    expect(parseProgressRecord({ schemaVersion: 99, runId: "x", startedAt: "t" })).toBeNull();
    expect(parseProgressRecord({ schemaVersion: 1, runId: "", startedAt: "t" })).toBeNull();
    expect(parseProgressRecord({ schemaVersion: 1, runId: "x", startedAt: "t", outcome: "exploded" }))
      .toMatchObject({ outcome: null });
    expect(parseProgressRecord({ schemaVersion: 1, runId: "x", startedAt: "t", progress: 7 }))
      .toMatchObject({ progress: 1 });
  });

  it("names a step in words, and falls back to the raw name", () => {
    expect(stepLabel("installDependencies")).toBe("Installing dependencies");
    // Every step the updater can report needs a sentence, or the Mac and the
    // phone show the raw camelCase op name to the person waiting.
    expect(stepLabel("smokeTestBundle")).toBe("Verifying the new build actually starts");
    expect(stepLabel("somethingNew")).toBe("somethingNew");
    expect(stepLabel(null)).toBe("Working");
  });
});

describe("a run that settles takes its launchd label with it", () => {
  // `launchctl submit` keeps a job ALIVE ON FAILURE — every non-zero exit is
  // relaunched — so a run that fails deterministically is restarted forever
  // unless the label goes when the run does.  On this Mac it ran 204 times in
  // a day, staging a fresh copy of the source each time.
  it("removes the label the moment a finished run is folded in", () => {
    const paths = rig();
    writeCurrentRun(paths, "run_prior");
    writeProgress(paths, "run_prior", {
      finishedAt: "2026-09-13T11:59:00.000Z",
      outcome: "failed",
      message: "The update could not be packaged.",
    });
    const harness = build(paths);
    expect(harness.control.status().lastRun?.outcome).toBe("failed");
    expect(harness.ran).toContainEqual({ command: "/bin/launchctl", args: ["remove", "com.jay.botfleet-update"] });
    // Once, not once per status: the run is already settled in memory.
    harness.control.status();
    expect(harness.ran).toHaveLength(1);
  });

  it("removes it for a verified run too, and for one that died without an outcome", () => {
    const verified = rig();
    writeCurrentRun(verified, "run_prior");
    writeProgress(verified, "run_prior", {
      finishedAt: "2026-09-13T11:59:00.000Z",
      outcome: "verified",
      message: "The update installed and verified.",
    });
    expect(build(verified).ran).toHaveLength(1);

    const died = rig();
    writeCurrentRun(died, "run_prior");
    writeProgress(died, "run_prior", { step: "buildBundle" });
    const harness = build(died, { processAlive: () => false });
    expect(harness.control.status().lastRun?.outcome).toBe("failed");
    expect(harness.ran).toHaveLength(1);

    // A run that never wrote a record at all is still a registered label.
    const never = rig();
    writeCurrentRun(never, "run_prior");
    const late = build(never, { now: () => new Date("2026-09-13T12:05:00.000Z") });
    expect(late.control.status().lastRun?.message).toContain("never started");
    expect(late.ran).toHaveLength(1);
  });

  it("leaves launchctl alone for a detached fallback run, and off macOS", () => {
    const detached = rig();
    writeCurrentRun(detached, "run_prior", "detached");
    writeProgress(detached, "run_prior", { finishedAt: "2026-09-13T11:59:00.000Z", outcome: "failed" });
    // The fallback spawn registers no label, so there is nothing to remove —
    // and `launchctl remove` on a label this harness never submitted could
    // take out something else that happens to own it.
    expect(build(detached).ran).toEqual([]);

    const elsewhere = rig();
    writeCurrentRun(elsewhere, "run_prior");
    writeProgress(elsewhere, "run_prior", { finishedAt: "2026-09-13T11:59:00.000Z", outcome: "failed" });
    expect(build(elsewhere, { platform: "linux" }).ran).toEqual([]);
  });

  it("names the label to unregister", () => {
    expect(removeLaunchJobCommand("com.jay.botfleet-update"))
      .toEqual({ command: "/bin/launchctl", args: ["remove", "com.jay.botfleet-update"] });
  });
});

describe("sweeping what failed runs leave on disk", () => {
  const entry = (name: string, stamp: number, names: string[]) => ({ path: `/updates/${name}`, name, stamp, names });

  it("dates a stage from the updater's own suffix, and only from that", () => {
    expect(stageStamp("82d58b454022-1789548405337")).toBe(1789548405337);
    // A hand-made directory ending in a date parses as a number too, and
    // reading that as epoch milliseconds would date the stage to 1970.
    expect(stageStamp("keep-me-20260912")).toBeNull();
    expect(stageStamp("source")).toBeNull();
  });

  it("keeps the three newest wrecks and never a stage that is load-bearing", () => {
    const now = 2_000_000_000_000;
    const old = now - 60 * 60 * 1000;
    const entries = [
      entry("aaaaaaaaaaaa-1", old + 5, ["source", "node_modules"]),
      entry("bbbbbbbbbbbb-2", old + 4, ["source"]),
      entry("cccccccccccc-3", old + 3, ["source"]),
      entry("dddddddddddd-4", old + 2, ["source"]),
      entry("eeeeeeeeeeee-5", old + 1, ["source", "BotFleet.app"]),
    ];
    expect(stagesToPrune(entries, { now })).toEqual(["/updates/dddddddddddd-4", "/updates/eeeeeeeeeeee-5"]);

    // A prepared build a later `apply` can still install, and the rollback
    // bundle the installed app would be rolled back to, are both untouchable
    // — however old and however far down the list they are.
    const protectedEntries = [
      ...entries,
      entry("ffffffffffff-6", old, ["source", "prepared.json"]),
      entry("gggggggggggg-7", old - 1, ["source", "rollback"]),
      // Anything a person put there is reported by being left alone.
      entry("hhhhhhhhhhhh-8", old - 2, ["source", "notes.txt"]),
    ];
    expect(stagesToPrune(protectedEntries, { now }))
      .toEqual(["/updates/dddddddddddd-4", "/updates/eeeeeeeeeeee-5"]);
  });

  it("will not touch a stage young enough to belong to a run in flight", () => {
    const now = 2_000_000_000_000;
    const entries = [
      entry("aaaaaaaaaaaa-1", now - 1_000, ["source"]),
      entry("bbbbbbbbbbbb-2", now - 2_000, ["source"]),
      entry("cccccccccccc-3", now - 3_000, ["source"]),
      entry("dddddddddddd-4", now - 4_000, ["source"]),
    ];
    expect(stagesToPrune(entries, { now })).toEqual([]);
    expect(stagesToPrune(entries, { now, graceMs: 0 })).toEqual(["/updates/dddddddddddd-4"]);
    expect(stagesToPrune(entries, { now, graceMs: 0, keep: 1 }))
      .toEqual(["/updates/bbbbbbbbbbbb-2", "/updates/cccccccccccc-3", "/updates/dddddddddddd-4"]);
    expect(stagesToPrune(entries, { now, graceMs: 0, keep: 0, protect: ["/updates/aaaaaaaaaaaa-1"] }))
      .toEqual(["/updates/bbbbbbbbbbbb-2", "/updates/cccccccccccc-3", "/updates/dddddddddddd-4"]);
  });

  it("removes them from disk on boot, and leaves the kept ones alone", () => {
    const paths = rig();
    const old = Date.parse("2026-09-13T12:00:00.000Z") - 24 * 60 * 60 * 1000;
    const stages = [1, 2, 3, 4, 5].map((n) => stage(paths, `commit${n}`, old + n));
    const prepared = stage(paths, "commit6", old, ["source", "prepared.json"]);
    build(paths);
    // The three newest wrecks stay: a person reads the most recent failure,
    // not the fortieth.
    expect(stages.slice(2).every((path) => existsSync(path))).toBe(true);
    expect(existsSync(stages[0])).toBe(false);
    expect(existsSync(stages[1])).toBe(false);
    expect(existsSync(prepared)).toBe(true);
  });

  it("sweeps again before a run, so the disk is clear before it stages another", async () => {
    const paths = rig();
    const old = Date.parse("2026-09-13T12:00:00.000Z") - 24 * 60 * 60 * 1000;
    const harness = build(paths);
    const later = [1, 2, 3, 4].map((n) => stage(paths, `after${n}`, old + n));
    await harness.control.start({ force: true });
    expect(existsSync(later[0])).toBe(false);
    expect(later.slice(1).every((path) => existsSync(path))).toBe(true);
    expect(harness.launched).toHaveLength(1);
  });

  it("does nothing at all when there is no updates root yet", () => {
    const paths = rig();
    expect(() => build(paths)).not.toThrow();
    expect(pruneUpdateStages(join(paths.root, "nowhere"))).toEqual([]);
  });

  it("keeps the newest run logs and forgets the rest, run by run", () => {
    const paths = rig();
    const runs = join(paths.stateDirectory, "runs");
    mkdirSync(runs, { recursive: true });
    // Four writes can land inside one filesystem timestamp tick, so the
    // order the prune sees is set here, not left to the disk.
    const base = Date.parse("2026-09-13T12:00:00.000Z");
    for (let n = 1; n <= 4; n += 1) {
      const stamp = new Date(base + n * 1000);
      for (const file of [`run_${n}.log`, `run_${n}.progress.json`]) {
        const path = join(runs, file);
        writeFileSync(path, file.endsWith(".log") ? "x\n" : "{}\n");
        utimesSync(path, stamp, stamp);
      }
    }
    const removed = pruneRunArtifacts(runs, { keep: 2, protect: ["run_1"] });
    // A run's log and its progress file go together or not at all.
    expect(removed).toHaveLength(2);
    expect(existsSync(join(runs, "run_1.log"))).toBe(true);
    expect(existsSync(join(runs, "run_4.log"))).toBe(true);
    expect(existsSync(join(runs, "run_4.progress.json"))).toBe(true);
  });
});

describe("a caller that holds an update admission of its own", () => {
  const BUSY: RuntimeReadiness = { safeToRestart: false, activeWorkCount: 1 };
  const IDLE: RuntimeReadiness = { safeToRestart: true, activeWorkCount: 0 };
  const ahead = (args: string[]): CommandResult => {
    if (args[0] === "rev-parse") return ok(`${NEW_COMMIT}\n`);
    if (args[0] === "rev-list") return ok("3\n");
    if (args[0] === "log") return ok(`${NEW_COMMIT}${UNIT}feat: something newer`);
    if (args[0] === "show") return ok(JSON.stringify({ version: "1.0.31" }));
    return ok();
  };

  // `POST /api/update/check` is a mutating request, so the route holds an
  // admission for the whole handler and the harness-wide reading counts it.
  // The answer that had just found the update therefore also said this Mac
  // was busy, and both clients hide Install Update on `canRun` — so the
  // button never appeared after the check that found the update.
  it("lets check() describe the machine rather than the request asking", async () => {
    const paths = rig();
    const harness = build(paths, { readiness: BUSY, git: ahead });

    const uncorrected = await harness.control.check();
    expect(uncorrected.available?.sourceCommit).toBe(NEW_COMMIT);
    expect(uncorrected.capabilities.canRun).toBe(false);
    expect(uncorrected.capabilities.reasons).toContain(BUSY_REFUSAL);

    const corrected = await harness.control.check({ readiness: IDLE });
    expect(corrected.available?.sourceCommit).toBe(NEW_COMMIT);
    expect(corrected.capabilities.canRun).toBe(true);
    expect(corrected.capabilities.reasons).not.toContain(BUSY_REFUSAL);
    // And what every other client is told, not only the answer to this one.
    expect(harness.emitted.at(-1)?.capabilities.canRun).toBe(true);
  });

  it("lets a refusal from start() describe the machine too", async () => {
    const paths = rig();
    const harness = build(paths, {
      readiness: BUSY,
      git: (args) => (args[0] === "status" ? ok(" M server/index.ts\n") : ahead(args)),
    });
    await harness.control.check({ readiness: IDLE });

    const refused = await harness.control.start({ readiness: IDLE });
    expect(refused.ok).toBe(false);
    expect(refused).toMatchObject({ error: expect.stringContaining("uncommitted changes") });
    // The refusal is about the checkout.  A status that ALSO said the Mac was
    // busy is stored by the client, which then stops offering Install Update
    // until something unrelated refreshes it.
    expect(refused.status.capabilities.canRun).toBe(true);
    expect(refused.status.capabilities.reasons).not.toContain(BUSY_REFUSAL);
  });
});

describe("a run whose progress file stops advancing", () => {
  /** Long enough after the last progress write to be stale, and the pid still
   * reads as alive — which is what happens when the number is reused. */
  const LATER = () => new Date("2026-09-13T12:20:00.000Z");
  const STALLED = { step: "buildBundle", updatedAt: "2026-09-13T11:58:00.000Z" };
  const LISTED_ALIVE = '{\n\t"Label" = "com.jay.botfleet-update";\n\t"PID" = 8123;\n};\n';
  const settled = () => new Promise((resolve) => setTimeout(resolve, 10));

  it("settles it once launchd says nothing is running under the label", async () => {
    const paths = rig();
    writeCurrentRun(paths, "run_prior");
    writeProgress(paths, "run_prior", STALLED);
    const harness = build(paths, { now: LATER, processAlive: () => true });
    // The probe is asynchronous, so the run is still described until it lands.
    expect(harness.control.status().running).not.toBeNull();
    await settled();
    const status = harness.control.status();
    expect(status.running).toBeNull();
    expect(status.lastRun).toMatchObject({ runId: "run_prior", outcome: "failed" });
    expect(status.lastRun?.message).toContain("com.jay.botfleet-update");
    expect(harness.ran[0]).toEqual({
      command: "/bin/launchctl",
      args: ["list", "com.jay.botfleet-update"],
    });
    // Settling takes the label away, the same as every other settle.
    expect(harness.ran).toContainEqual({
      command: "/bin/launchctl",
      args: ["remove", "com.jay.botfleet-update"],
    });
    // And the wedge it clears is the one that refused every later install.
    expect(status.capabilities.reasons).not.toContain("An update is already running.");
  });

  it("leaves it alone while launchd still has a process for it", async () => {
    const paths = rig();
    writeCurrentRun(paths, "run_prior");
    writeProgress(paths, "run_prior", STALLED);
    const harness = build(paths, { now: LATER, exec: () => ok(LISTED_ALIVE) });
    await settled();
    expect(harness.control.status().running).not.toBeNull();
    // Asked once, not once per poll or per status.
    harness.control.status();
    await settled();
    expect(harness.ran.filter((one) => one.args[0] === "list")).toHaveLength(1);
  });

  it("asks nothing while the progress file is still moving", async () => {
    const paths = rig();
    writeCurrentRun(paths, "run_prior");
    writeProgress(paths, "run_prior", { step: "buildBundle", updatedAt: "2026-09-13T11:58:00.000Z" });
    // Two minutes on: a long step is not a dead run.
    const harness = build(paths, { now: () => new Date("2026-09-13T12:00:00.000Z") });
    await settled();
    expect(harness.control.status().running).not.toBeNull();
    expect(harness.ran).toEqual([]);
  });

  it("asks nothing for a detached run, which has no label to ask about", async () => {
    const paths = rig();
    writeCurrentRun(paths, "run_prior", "detached");
    writeProgress(paths, "run_prior", STALLED);
    const harness = build(paths, { now: LATER });
    await settled();
    expect(harness.control.status().running).not.toBeNull();
    expect(harness.ran).toEqual([]);
  });

  it("names the label to ask about", () => {
    expect(listLaunchJobCommand("com.jay.botfleet-update"))
      .toEqual({ command: "/bin/launchctl", args: ["list", "com.jay.botfleet-update"] });
  });
});

describe("an origin/main that differs without being ahead", () => {
  const BEHIND = "e".repeat(40);

  it("offers nothing, rather than an update Install would refuse", async () => {
    const paths = rig();
    const harness = build(paths, {
      git: (args) => {
        if (args[0] === "rev-parse") return ok(`${BEHIND}\n`);
        // A locally built app from a lane branch: origin/main is a different
        // commit, and none of it is ahead of what is installed.
        if (args[0] === "rev-list") return ok("0\n");
        return ok();
      },
    });
    const status = await harness.control.check();
    expect(status.checkError).toBeNull();
    expect(status.checkedAt).toBe("2026-09-13T12:00:00.000Z");
    expect(status.available).toBeNull();
    // Nothing to describe, so it never asked for the subjects or the version.
    expect(harness.git.some((args) => args[0] === "log")).toBe(false);
    expect(harness.git.some((args) => args[0] === "show")).toBe(false);
  });

  it("still offers when the count could not be taken at all", async () => {
    const paths = rig();
    // An installed commit this checkout has never seen — a force-pushed
    // branch.  `rev-list` fails, and a failed count says nothing about
    // distance, so the offer stands rather than being silently withdrawn.
    const harness = build(paths, {
      git: (args) => {
        if (args[0] === "rev-parse") return ok(`${NEW_COMMIT}\n`);
        if (args[0] === "rev-list") return fail();
        return ok();
      },
    });
    const status = await harness.control.check();
    expect(status.available?.sourceCommit).toBe(NEW_COMMIT);
    expect(status.available?.aheadBy).toBe(0);
  });
});

describe("paths named by current-run.json", () => {
  it("publishes a log tail only from inside the runs directory", () => {
    const paths = rig();
    const outside = join(paths.root, "not-the-updaters.log");
    writeFileSync(outside, "a line from a file this route must never publish\n");
    mkdirSync(paths.stateDirectory, { recursive: true });
    // A planted record: the status route reads `logPath` and publishes its
    // tail to every client and to the paired phone, so a record naming any
    // other file would turn a same-user write into a remote read.
    writeFileSync(join(paths.stateDirectory, "current-run.json"), JSON.stringify({
      runId: "run_prior",
      startedAt: "2026-09-13T11:55:00.000Z",
      progressPath: join(paths.root, "not-the-updaters.json"),
      logPath: outside,
      launcher: "launchd",
      targetCommit: NEW_COMMIT,
    }));
    writeFileSync(join(paths.root, "not-the-updaters.json"), JSON.stringify({
      schemaVersion: 1,
      runId: "run_prior",
      startedAt: "2026-09-13T11:55:00.000Z",
      updatedAt: "2026-09-13T11:58:00.000Z",
      pid: 4321,
      step: "somewhere else entirely",
    }));
    writeProgress(paths, "run_prior", { step: "buildBundle" });

    const running = build(paths).control.status().running;
    expect(running?.runId).toBe("run_prior");
    // Both paths fell back to the ones this run id would have had: the tail
    // is empty because no log was written there, and the step came from the
    // real progress file rather than the planted one.
    expect(running?.logTail).toEqual([]);
    expect(running?.step).toBe(stepLabel("buildBundle"));
  });
});

describe("update step labels", () => {
  it("covers every step the updater can report, so no raw op name reaches a person", () => {
    const uncovered = [...PREPARE_STEPS, ...APPLY_STEPS]
      .filter((step) => !UPDATE_STEP_LABELS[step]);
    expect(uncovered).toEqual([]);
  });

  it("uses Title Case sentences rather than op names", () => {
    // A label that is just the step name is the bug this whole table exists to
    // prevent, so assert on the shape rather than trusting a reviewer's eye.
    for (const [step, label] of Object.entries(UPDATE_STEP_LABELS)) {
      expect(label, `${step} label is the raw step name`).not.toBe(step);
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
