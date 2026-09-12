#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { applyPreparedUpdate, prepareUpdate, runUpdate } from "./mac-update-transaction.mjs";

const EXPECTED_TEAM_ID = "CC8UTF7ATG";
const EXPECTED_BUNDLE_ID = "com.botfleet.app";
const EXPECTED_SIGN_IDENTITY = "Developer ID Application: Jay Wedgeworth, LLC (CC8UTF7ATG)";
const BUILD_MANIFEST_RELATIVE = "Contents/Resources/server/build-identity.json";
const GENERATED_PATHS = [
  "electron/resources/BotFleet Recorder.app/Contents/MacOS/recorder-helper",
  "electron/resources/BotFleet Speech.app/Contents/MacOS/speech-helper",
];
const TERMINAL_ROUTINE_STATES = new Set(["completed", "failed", "cancelled", "canceled", "interrupted", "missed", "skipped"]);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export class CommandError extends Error {
  constructor(command, args, result) {
    super(`${command} ${args.join(" ")} failed with exit ${result.code}`);
    this.name = "CommandError";
    this.command = command;
    this.args = args;
    this.code = result.code;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

export function parseArguments(argv) {
  const args = [...argv];
  const command = ["prepare", "apply", "update"].includes(args[0]) ? args.shift() : "update";
  const parsed = {
    command,
    target: "origin/main",
    source: undefined,
    stage: undefined,
    bundle: undefined,
    dependencies: undefined,
    openApplication: true,
  };
  while (args.length) {
    const arg = args.shift();
    if (arg === "--target") parsed.target = requiredValue(arg, args.shift());
    else if (arg === "--source") parsed.source = resolve(requiredValue(arg, args.shift()));
    else if (arg === "--stage") parsed.stage = resolve(requiredValue(arg, args.shift()));
    else if (arg === "--bundle") parsed.bundle = resolve(requiredValue(arg, args.shift()));
    else if (arg === "--dependencies") parsed.dependencies = resolve(requiredValue(arg, args.shift()));
    else if (arg === "--no-open") parsed.openApplication = false;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (command === "apply" && !parsed.stage) throw new Error("apply requires --stage <directory>");
  if (command === "apply" && (parsed.bundle || parsed.dependencies || parsed.source)) {
    throw new Error("apply accepts only a prepared --stage");
  }
  if (Boolean(parsed.bundle) !== Boolean(parsed.dependencies)) {
    throw new Error("--bundle and --dependencies must be supplied together");
  }
  if (parsed.bundle && !parsed.source) {
    throw new Error("importing a built bundle requires its exact --source checkout");
  }
  return parsed;
}

function requiredValue(flag, value) {
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function usage() {
  return `Usage:
  update-botfleet-mac.mjs update  [--target REF] [--source PATH] [--stage PATH] [--no-open]
  update-botfleet-mac.mjs prepare [--target REF] [--source PATH] [--stage PATH]
                              [--bundle PATH --dependencies PATH]
  update-botfleet-mac.mjs apply   --stage PATH [--no-open]

prepare builds and validates without touching the live checkout, installed app, or processes.
An existing exact-source build can be imported with --bundle and --dependencies.
apply performs a fresh active-work check, installs one prepared stage, verifies exact runtime identity,
and rolls the prior bundle and checkout back if any install or startup step fails.`;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function assertPrivateDirectory(path, label) {
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`${label} must be a real directory: ${path}`);
  if (details.uid !== process.getuid()) throw new Error(`${label} must be owned by the current user: ${path}`);
  if ((details.mode & 0o077) !== 0) throw new Error(`${label} must not be accessible by group or other users: ${path}`);
}

async function assertPrivateRegularFile(path, label) {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${path}`);
  if (details.uid !== process.getuid()) throw new Error(`${label} must be owned by the current user: ${path}`);
  if ((details.mode & 0o077) !== 0) throw new Error(`${label} must not be accessible by group or other users: ${path}`);
}

function run(command, args, { cwd, env, allowFailure = false, inherit = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: inherit ? ["inherit", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (!inherit) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
    }
    child.on("error", rejectRun);
    child.on("exit", (code, signal) => {
      const result = { code: code ?? 128, signal, stdout, stderr };
      if (result.code === 0 || allowFailure) resolveRun(result);
      else rejectRun(new CommandError(command, args, result));
    });
  });
}

async function output(command, args, options) {
  return (await run(command, args, options)).stdout.trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
}

async function dependencyFingerprint(nodeModulesPath) {
  const details = await lstat(nodeModulesPath);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`Staged dependency root must be a real directory: ${nodeModulesPath}`);
  }
  const modules = await readFile(join(nodeModulesPath, ".modules.yaml"));
  const virtualLock = await readFile(join(nodeModulesPath, ".pnpm/lock.yaml"));
  return sha256(Buffer.concat([modules, Buffer.from([0]), virtualLock]));
}

async function assertDependenciesMatchSource(nodeModulesPath, sourcePath) {
  const [sourceLock, installedLock] = await Promise.all([
    readFile(join(sourcePath, "pnpm-lock.yaml")),
    readFile(join(nodeModulesPath, ".pnpm/lock.yaml")),
  ]);
  if (!sourceLock.equals(installedLock)) {
    throw new Error("Staged dependency tree does not match the exact source lockfile");
  }
}

async function atomicJson(path, value, mode = 0o600) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temporary, path);
}

async function acquireDirectoryLock(path, mode) {
  await mkdir(dirname(path), { recursive: true });
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(path, { mode: 0o700 });
      await atomicJson(join(path, "owner.json"), { version: 1, pid: process.pid, token, mode, startedAt: Date.now() });
      return {
        release: async () => {
          let owner;
          try { owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8")); } catch { return; }
          if (owner?.token === token) await rm(path, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner;
      try { owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8")); } catch {
        throw new Error(`Updater lock ${path} exists without a readable owner; inspect it before retrying`);
      }
      if (Number.isInteger(owner?.pid) && processIsAlive(owner.pid)) {
        throw new Error(`Another BotFleet update is running (pid ${owner.pid}, phase ${owner.mode || "unknown"})`);
      }
      if (attempt > 0) throw new Error(`Could not recover stale updater lock ${path}`);
      await rename(path, `${path}.stale-${Date.now()}`);
    }
  }
  throw new Error(`Could not acquire updater lock ${path}`);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function parseJsonFile(path, label) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${label} is missing or invalid: ${path}`);
  }
  return value;
}

async function requestJson(url, { headers = {}, timeoutMs = 3_000, accept = [200] } = {}) {
  let response;
  try {
    response = await fetch(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const code = error?.cause?.code || error?.code;
    if (code === "ECONNREFUSED") return { kind: "none" };
    return { kind: "unavailable", reason: code || error?.name || "request failed" };
  }
  let body;
  try { body = await response.json(); } catch { body = null; }
  if (!accept.includes(response.status)) return { kind: "http", status: response.status, body };
  return { kind: "ok", status: response.status, body };
}

async function probeHealth(port) {
  const result = await requestJson(`http://127.0.0.1:${port}/api/health`, { accept: [200] });
  if (result.kind !== "ok") return result;
  if (result.body?.app !== "botfleet" || !Number.isInteger(result.body?.pid) || result.body.pid <= 0) {
    return { kind: "foreign" };
  }
  return { kind: "botfleet", pid: result.body.pid, static: Boolean(result.body.static), port };
}

async function sqliteHolders(dataDirectory) {
  const files = ["messages.db", "messages.db-wal", "messages.db-shm"].map((name) => join(dataDirectory, name));
  const present = [];
  for (const file of files) if (await exists(file)) present.push(file);
  if (!present.length) return [];
  const result = await run("lsof", ["-t", "--", ...present], { allowFailure: true });
  if (![0, 1].includes(result.code)) throw new Error("Could not inspect BotFleet database ownership with lsof");
  return [...new Set(result.stdout.split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger))];
}

async function healthTopology(ports, { allowMultiple = false } = {}) {
  const results = await Promise.all(ports.map(probeHealth));
  if (results.some((item) => item.kind === "unavailable" || item.kind === "foreign" || item.kind === "http")) {
    return { safe: false, reason: "A BotFleet port returned an unavailable, foreign, or ambiguous response" };
  }
  const botfleet = results.filter((item) => item.kind === "botfleet");
  if (!botfleet.length) return { safe: false, reason: "No BotFleet harness answered the expected ports" };
  const pids = [...new Set(botfleet.map((item) => item.pid))];
  if (!allowMultiple && pids.length !== 1) {
    return { safe: false, reason: `Multiple BotFleet runtime owners answered (${pids.length})` };
  }
  return { safe: true, pid: pids[0], pids, port: botfleet[0].port, health: botfleet };
}

function validOwner(owner) {
  return owner?.version === 1 && Number.isInteger(owner.pid) && owner.pid > 0 &&
    Number.isInteger(owner.port) && owner.port > 0 && owner.port <= 65535 &&
    typeof owner.nonce === "string" && /^[a-f0-9]{64}$/.test(owner.nonce);
}

async function readOwner(dataDirectory) {
  const path = join(dataDirectory, "harness-owner.json");
  try {
    await assertPrivateRegularFile(path, "Harness owner record");
    const owner = JSON.parse(await readFile(path, "utf8"));
    if (!validOwner(owner)) throw new Error("Harness owner record is invalid");
    if (!processIsAlive(owner.pid)) return null;
    return owner;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function strictRuntimePreflight(config, expectedBuild) {
  const owner = await readOwner(config.dataDirectory);
  if (!owner) return null;
  const response = await requestJson(`http://127.0.0.1:${owner.port}/api/runtime`, {
    headers: { Authorization: `Bearer ${owner.nonce}` },
    accept: [200],
  });
  if (response.kind === "http" && response.status === 404) return null;
  if (response.kind !== "ok") return { safe: false, reason: "Authenticated runtime readiness could not be verified" };
  const runtime = response.body;
  const activeWorkCount = runtime?.activeWorkCount ?? runtime?.activeWork?.count;
  if (runtime?.app !== "botfleet" || runtime?.pid !== owner.pid ||
      runtime?.dataOwner?.pid !== owner.pid || runtime?.dataOwner?.port !== owner.port) {
    return { safe: false, reason: "Authenticated runtime identity does not match the data owner" };
  }
  if (typeof runtime.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(runtime.sourceCommit)) {
    return { safe: false, reason: "Authenticated runtime did not report an exact source commit" };
  }
  if (runtime.sourceDirty !== false) {
    return { safe: false, reason: "Authenticated runtime reports a dirty or unknown source checkout" };
  }
  if (expectedBuild && runtime.sourceCommit !== expectedBuild.targetCommit) {
    return { safe: false, reason: `Harness is running ${runtime.sourceCommit.slice(0, 12)}, expected ${expectedBuild.targetCommit.slice(0, 12)}` };
  }
  if (expectedBuild && (runtime.version !== expectedBuild.version || runtime.apiVersion !== expectedBuild.apiVersion)) {
    return { safe: false, reason: "Harness runtime identity does not match the prepared application build" };
  }
  if (runtime.safeToRestart !== true || activeWorkCount !== 0) {
    return { safe: false, reason: `${Number.isInteger(activeWorkCount) ? activeWorkCount : "Unknown"} active operations prevent update` };
  }
  const topology = await healthTopology(config.ports);
  if (!topology.safe || topology.pid !== owner.pid) {
    return { safe: false, reason: topology.reason || "Health endpoints do not share the authenticated runtime owner" };
  }
  const holders = await sqliteHolders(config.dataDirectory);
  if (holders.length !== 1 || holders[0] !== owner.pid) {
    return { safe: false, reason: `Database ownership is ambiguous (${holders.length} live holders)` };
  }
  return { safe: true, mode: "authenticated", pid: owner.pid, port: owner.port, runtime, holders, health: topology.health };
}

async function legacyPreflight(config) {
  const topology = await healthTopology(config.ports, { allowMultiple: true });
  if (!topology.safe) return topology;
  const snapshots = await Promise.all(topology.health.map(async ({ port }) => {
    const base = `http://127.0.0.1:${port}`;
    const [fleet, map, routines] = await Promise.all([
      requestJson(`${base}/api/bots?messages=0`),
      requestJson(`${base}/api/team-map`),
      requestJson(`${base}/api/routines`),
    ]);
    return { port, fleet, map, routines };
  }));
  if (snapshots.some(({ fleet, map, routines }) => [fleet, map, routines].some((item) => item.kind !== "ok"))) {
    return { safe: false, reason: "Legacy runtime cannot prove every owner has idle bots, queues, and routines" };
  }
  let activeWorkCount = 0;
  for (const { fleet, map, routines } of snapshots) {
    const bots = Array.isArray(fleet.body?.bots) ? fleet.body.bots : null;
    const groups = Array.isArray(fleet.body?.groups) ? fleet.body.groups : null;
    const queued = Array.isArray(map.body?.queued) ? map.body.queued : null;
    const running = Array.isArray(map.body?.running) ? map.body.running : null;
    const runs = Array.isArray(routines.body?.runs) ? routines.body.runs : null;
    if (!bots || !groups || !queued || !running || !runs) {
      return { safe: false, reason: "Legacy idle-state payload is incomplete" };
    }
    const activeRoutineRuns = runs.filter((item) => !TERMINAL_ROUTINE_STATES.has(String(item?.status || "").toLowerCase()));
    activeWorkCount += bots.filter((item) => item?.busy).length +
      groups.filter((item) => item?.working || item?.busyBotId).length + queued.length + running.length + activeRoutineRuns.length;
  }
  if (activeWorkCount !== 0) return { safe: false, reason: `${activeWorkCount} legacy active operations prevent update` };
  const holders = await sqliteHolders(config.dataDirectory);
  const expectedPids = [...topology.pids].sort((left, right) => left - right);
  const holderPids = [...holders].sort((left, right) => left - right);
  if (holderPids.length !== expectedPids.length || holderPids.some((pid, index) => pid !== expectedPids[index])) {
    return { safe: false, reason: `Legacy database ownership is ambiguous (${holders.length} live holders)` };
  }
  return { safe: true, mode: "legacy", pid: topology.pid, pids: topology.pids, port: topology.port, holders, health: topology.health };
}

export async function runtimePreflight(config, expectedBuild) {
  const strict = await strictRuntimePreflight(config, expectedBuild);
  if (strict) return strict;
  if (expectedBuild) return { safe: false, reason: "Expected build does not expose authenticated runtime identity" };
  const first = await legacyPreflight(config);
  if (!first.safe) return first;
  await sleep(config.legacySettleMs);
  const second = await legacyPreflight(config);
  const firstPids = [...(first.pids || [first.pid])].sort((left, right) => left - right);
  const secondPids = [...(second.pids || [second.pid])].sort((left, right) => left - right);
  if (!second.safe || firstPids.length !== secondPids.length || firstPids.some((pid, index) => pid !== secondPids[index])) {
    return { safe: false, reason: second.reason || "Legacy runtime owner changed during readiness settle" };
  }
  return second;
}

async function signatureIdentity(bundlePath) {
  await run("codesign", ["--verify", "--deep", "--strict", bundlePath]);
  const details = await run("codesign", ["-dvv", bundlePath], { allowFailure: true });
  const text = `${details.stdout}\n${details.stderr}`;
  const teamIdentifier = text.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  const identifier = text.match(/^Identifier=(.+)$/m)?.[1]?.trim();
  if (teamIdentifier !== EXPECTED_TEAM_ID || identifier !== EXPECTED_BUNDLE_ID) {
    throw new Error(`BotFleet signature identity mismatch (team ${teamIdentifier || "missing"}, bundle ${identifier || "missing"})`);
  }
  const requirement = await run("codesign", ["-dr", "-", bundlePath], { allowFailure: true });
  const designatedRequirement = `${requirement.stdout}\n${requirement.stderr}`.trim();
  if (!designatedRequirement.includes(`identifier "${EXPECTED_BUNDLE_ID}"`) ||
      !designatedRequirement.includes(`certificate leaf[subject.OU] = ${EXPECTED_TEAM_ID}`)) {
    throw new Error("BotFleet designated signing requirement is missing its stable bundle or team identity");
  }
  return { teamIdentifier, bundleIdentifier: identifier, designatedRequirement: sha256(designatedRequirement) };
}

async function validateBuiltBundle(bundlePath, expectedCommit) {
  if (!(await exists(bundlePath))) throw new Error(`Packaged app is missing: ${bundlePath}`);
  const build = await parseJsonFile(join(bundlePath, BUILD_MANIFEST_RELATIVE), "Packaged build manifest");
  if (build?.sourceCommit !== expectedCommit || !/^[a-f0-9]{40}$/.test(build?.sourceCommit || "")) {
    throw new Error("Packaged app does not contain the expected source commit");
  }
  if (build.app !== "botfleet" || build.sourceDirty !== false ||
      typeof build.version !== "string" || !Number.isInteger(build.apiVersion) ||
      typeof build.uiHash !== "string" || !/^[a-f0-9]{64}$/.test(build.uiHash)) {
    throw new Error("Packaged build manifest is dirty or missing application, version, API, or UI identity");
  }
  return { ...(await signatureIdentity(bundlePath)), version: build.version, apiVersion: build.apiVersion, uiHash: build.uiHash };
}

async function exactAppPids(appPath) {
  const result = await run("ps", ["-axo", "pid=,command="], { allowFailure: true });
  const executable = join(appPath, "Contents/MacOS/BotFleet");
  return result.stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match && (match[2] === executable || match[2].startsWith(`${executable} `)) ? [Number(match[1])] : [];
  });
}

async function processCommand(pid) {
  const result = await run("ps", ["-p", String(pid), "-o", "command="], { allowFailure: true });
  return result.code === 0 ? result.stdout.trim() : "";
}

async function waitForExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let remaining = pids.filter(processIsAlive);
  while (remaining.length && Date.now() < deadline) {
    await sleep(250);
    remaining = remaining.filter(processIsAlive);
  }
  return remaining;
}

async function terminateVerified(pids, previous, config) {
  let remaining = await waitForExit([...new Set(pids)], config.gracefulExitMs);
  for (const pid of remaining) {
    const command = await processCommand(pid);
    const verified = (previous.processCommands?.[pid] && previous.processCommands[pid] === command) ||
      command.startsWith(join(config.appPath, "Contents/")) ||
      command.includes(`${config.checkout}/`);
    if (!verified) throw new Error(`Process ${pid} still holds BotFleet state but its executable is not an expected BotFleet path`);
    process.kill(pid, "SIGTERM");
  }
  remaining = await waitForExit(remaining, config.termExitMs);
  if (remaining.length) {
    throw new Error(`BotFleet did not exit after graceful quit and SIGTERM (${remaining.length} verified processes remain); refusing SIGKILL`);
  }
}

export async function swapPreparedFiles({
  appPath,
  candidateApp,
  rollbackApp,
  liveDependencies,
  candidateDependencies,
  rollbackDependencies,
}, renamePath = rename) {
  let oldAppMoved = false;
  let oldDependenciesMoved = false;
  let newAppMoved = false;
  let newDependenciesMoved = false;
  try {
    await renamePath(appPath, rollbackApp);
    oldAppMoved = true;
    await renamePath(liveDependencies, rollbackDependencies);
    oldDependenciesMoved = true;
    await renamePath(candidateApp, appPath);
    newAppMoved = true;
    await renamePath(candidateDependencies, liveDependencies);
    newDependenciesMoved = true;
  } catch (error) {
    if (newDependenciesMoved) await renamePath(liveDependencies, candidateDependencies);
    if (newAppMoved) await renamePath(appPath, candidateApp);
    if (oldDependenciesMoved) await renamePath(rollbackDependencies, liveDependencies);
    if (oldAppMoved) await renamePath(rollbackApp, appPath);
    throw error;
  }
}

function createConfig(parsed) {
  const home = homedir();
  return {
    checkout: resolve(process.env.BOTFLEET_CHECKOUT || join(home, "apps/botfleet-server")),
    appPath: resolve(process.env.BOTFLEET_APP_PATH || "/Applications/BotFleet.app"),
    dataDirectory: resolve(process.env.BOTFLEET_DATA_DIR || join(home, ".botfleet")),
    plist: resolve(process.env.BOTFLEET_LAUNCH_AGENT_PLIST || join(home, "Library/LaunchAgents/com.jay.botfleet-server.plist")),
    label: process.env.BOTFLEET_LAUNCH_AGENT_LABEL || "com.jay.botfleet-server",
    domain: `gui/${process.getuid()}`,
    lockDirectory: resolve(process.env.BOTFLEET_UPDATE_LOCK || join(home, "Library/Caches/BotFleet/update.lock")),
    updatesDirectory: resolve(process.env.BOTFLEET_UPDATE_ROOT || join(home, "Library/Caches/BotFleet/updates")),
    ports: (process.env.BOTFLEET_UPDATE_PORTS || "8799,18799").split(",").map(Number),
    legacySettleMs: Number(process.env.BOTFLEET_LEGACY_SETTLE_MS || 2_000),
    gracefulExitMs: Number(process.env.BOTFLEET_GRACEFUL_EXIT_MS || 20_000),
    termExitMs: Number(process.env.BOTFLEET_TERM_EXIT_MS || 20_000),
    startupTimeoutMs: Number(process.env.BOTFLEET_STARTUP_TIMEOUT_MS || 90_000),
    parsed,
  };
}

function createOperations(config) {
  let lastPreflight;
  const git = (cwd, args, options) => run("git", ["-C", cwd, ...args], options);
  const gitOutput = (cwd, args, options) => output("git", ["-C", cwd, ...args], options);

  return {
    acquireLock: (mode) => acquireDirectoryLock(config.lockDirectory, mode),

    resolveTarget: async (plan) => {
      const repository = plan.source || config.checkout;
      await git(repository, ["fetch", "origin", "main"]);
      const commit = await gitOutput(repository, ["rev-parse", "--verify", `${plan.target}^{commit}`]);
      if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error(`Target did not resolve to a full commit: ${plan.target}`);
      const onMain = await git(repository, ["merge-base", "--is-ancestor", commit, "origin/main"], { allowFailure: true });
      if (onMain.code !== 0) throw new Error(`Target ${commit.slice(0, 12)} is not reachable from origin/main`);
      return commit;
    },

    prepareSource: async ({ source, stage, bundle, dependencies, targetCommit }) => {
      const stageDirectory = stage || join(config.updatesDirectory, `${targetCommit.slice(0, 12)}-${Date.now()}`);
      await mkdir(stageDirectory, { recursive: true, mode: 0o700 });
      await assertPrivateDirectory(stageDirectory, "Update stage");
      const live = await realpath(config.checkout);
      const staged = await realpath(stageDirectory);
      if (pathsOverlap(live, staged)) throw new Error("Update stage must be separate from the live always-on checkout");
      if (source) return {
        path: source,
        temporary: false,
        stageDirectory,
        providedBundle: bundle,
        providedDependencies: dependencies,
      };
      const sourcePath = join(stageDirectory, "source");
      await git(config.checkout, ["worktree", "add", "--detach", sourcePath, targetCommit]);
      return { path: sourcePath, temporary: true, stageDirectory };
    },

    assertStagingSource: async (source, targetCommit) => {
      const live = await realpath(config.checkout);
      const staging = await realpath(source.path);
      if (pathsOverlap(live, staging)) throw new Error("Staging source must be separate from the live always-on checkout");
      const liveDependencies = join(config.checkout, "node_modules");
      if (source.providedDependencies && await exists(liveDependencies) &&
          pathsOverlap(await realpath(source.providedDependencies), await realpath(liveDependencies))) {
        throw new Error("Imported dependencies must not be the live dependency tree");
      }
      if (source.providedBundle && await exists(config.appPath) &&
          pathsOverlap(await realpath(source.providedBundle), await realpath(config.appPath))) {
        throw new Error("Imported bundle must not be the installed application");
      }
      const head = await gitOutput(source.path, ["rev-parse", "HEAD"]);
      if (head !== targetCommit) throw new Error("Staging source is not at the requested target commit");
      const dirty = await gitOutput(source.path, ["status", "--porcelain"]);
      if (dirty) throw new Error("Staging source has changes; refusing a non-reproducible package");
    },

    installDependencies: async (source) => {
      if (source.providedDependencies) {
        await dependencyFingerprint(source.providedDependencies);
        await assertDependenciesMatchSource(source.providedDependencies, source.path);
        return;
      }
      console.log(`Installing locked dependencies in staging source ${source.path}`);
      await run("pnpm", ["install", "--frozen-lockfile"], { cwd: source.path, inherit: true, env: { CI: "true" } });
      await assertDependenciesMatchSource(join(source.path, "node_modules"), source.path);
    },

    buildBundle: async (source, targetCommit) => {
      if (source.providedBundle) return source.providedBundle;
      const identities = await output("security", ["find-identity", "-v", "-p", "codesigning"]);
      if (!identities.includes(EXPECTED_SIGN_IDENTITY)) {
        throw new Error(`Required stable signing identity is unavailable: ${EXPECTED_SIGN_IDENTITY}`);
      }
      console.log(`Packaging staged commit ${targetCommit.slice(0, 12)} with the stable BotFleet signing identity`);
      const args = [
        join(source.path, "scripts/with-sentry-dsn.sh"),
        "pnpm",
        "package:mac:local",
        `-c.mac.identity=${EXPECTED_SIGN_IDENTITY}`,
        "-c.mac.timestamp=none",
      ];
      try {
        await run("bash", args, {
          cwd: source.path,
          inherit: true,
          env: { CSC_IDENTITY_AUTO_DISCOVERY: "true" },
        });
      } finally {
        await git(source.path, ["checkout", "--", ...GENERATED_PATHS], { allowFailure: true });
      }
      return join(source.path, "release/mac-arm64/BotFleet.app");
    },

    validateBundle: validateBuiltBundle,

    persistPrepared: async ({ source, targetCommit, builtBundle, identity }) => {
      const bundlePath = join(source.stageDirectory, "BotFleet.app");
      if (resolve(builtBundle) !== resolve(bundlePath)) {
        await rm(bundlePath, { recursive: true, force: true });
        await run("ditto", [builtBundle, bundlePath]);
      }
      const copiedIdentity = await validateBuiltBundle(bundlePath, targetCommit);
      if (copiedIdentity.designatedRequirement !== identity.designatedRequirement) {
        throw new Error("Staged copy changed the BotFleet signing requirement");
      }
      const dependenciesPath = join(source.stageDirectory, "node_modules");
      const sourceDependencies = source.providedDependencies || join(source.path, "node_modules");
      const sourceDependencyFingerprint = await dependencyFingerprint(sourceDependencies);
      if (resolve(sourceDependencies) !== resolve(dependenciesPath)) {
        await rm(dependenciesPath, { recursive: true, force: true });
        await run("/bin/cp", ["-cR", sourceDependencies, dependenciesPath]);
      }
      const copiedDependencyFingerprint = await dependencyFingerprint(dependenciesPath);
      if (copiedDependencyFingerprint !== sourceDependencyFingerprint) {
        throw new Error("Staged dependency tree does not match the packaged source dependencies");
      }
      const manifest = {
        schemaVersion: 1,
        sourceCommit: targetCommit,
        version: identity.version,
        apiVersion: identity.apiVersion,
        uiHash: identity.uiHash,
        teamIdentifier: identity.teamIdentifier,
        bundleIdentifier: identity.bundleIdentifier,
        designatedRequirement: identity.designatedRequirement,
        bundleName: basename(bundlePath),
        dependenciesName: basename(dependenciesPath),
        dependencyFingerprint: copiedDependencyFingerprint,
        createdAt: new Date().toISOString(),
      };
      const manifestPath = join(source.stageDirectory, "prepared.json");
      await atomicJson(manifestPath, manifest, 0o600);
      await chmod(manifestPath, 0o400);
      console.log(`Prepared ${targetCommit.slice(0, 12)} at ${source.stageDirectory}`);
      return { ...manifest, stageDirectory: source.stageDirectory, bundlePath, dependenciesPath, manifestPath, targetCommit };
    },

    releaseSource: async (source) => {
      if (source.temporary) {
        await git(config.checkout, ["worktree", "remove", "--force", source.path], { allowFailure: true });
      }
    },

    validatePrepared: async (prepared) => {
      const identity = await validateBuiltBundle(prepared.bundlePath, prepared.targetCommit);
      if (identity.teamIdentifier !== prepared.teamIdentifier ||
          identity.bundleIdentifier !== prepared.bundleIdentifier ||
          identity.designatedRequirement !== prepared.designatedRequirement ||
          identity.version !== prepared.version || identity.apiVersion !== prepared.apiVersion || identity.uiHash !== prepared.uiHash) {
        throw new Error("Prepared bundle identity no longer matches its immutable manifest");
      }
      if (await dependencyFingerprint(prepared.dependenciesPath) !== prepared.dependencyFingerprint) {
        throw new Error("Prepared dependency tree no longer matches its manifest");
      }
    },

    preflight: async (_prepared) => {
      lastPreflight = await runtimePreflight(config);
      return lastPreflight;
    },

    capturePrevious: async () => {
      const checkoutCommit = await gitOutput(config.checkout, ["rev-parse", "HEAD"]);
      const dirty = await gitOutput(config.checkout, ["status", "--porcelain"]);
      if (dirty) throw new Error("Live always-on checkout has changes; refusing update");
      if (!(await exists(config.appPath))) throw new Error(`Installed BotFleet app is missing: ${config.appPath}`);
      const liveDependencies = join(config.checkout, "node_modules");
      const dependencyDetails = await lstat(liveDependencies);
      if (!dependencyDetails.isDirectory() || dependencyDetails.isSymbolicLink()) {
        throw new Error(`Live dependency tree must be a real directory: ${liveDependencies}`);
      }
      const installedIdentity = await signatureIdentity(config.appPath);
      const installedDependencyFingerprint = await dependencyFingerprint(liveDependencies);
      const launchd = await run("launchctl", ["print", `${config.domain}/${config.label}`], { allowFailure: true });
      const appPids = await exactAppPids(config.appPath);
      const holders = await sqliteHolders(config.dataDirectory);
      const runtimePids = [...new Set([...(lastPreflight?.pids || []), lastPreflight?.pid, ...holders].filter(Number.isInteger))];
      const processCommands = {};
      for (const pid of new Set([...runtimePids, ...appPids])) processCommands[pid] = await processCommand(pid);
      return {
        checkoutCommit,
        installedIdentity,
        installedDependencyFingerprint,
        launchdLoaded: launchd.code === 0,
        appWasRunning: appPids.length > 0,
        runtimePids,
        appPids,
        processCommands,
        rollbackPath: join(dirname(config.appPath), `.BotFleet.rollback-${Date.now()}-${checkoutCommit.slice(0, 12)}.app`),
        candidatePath: join(dirname(config.appPath), `.BotFleet.update-${process.pid}-${Date.now()}.app`),
        rollbackDependencies: join(dirname(config.checkout), `.botfleet-server.node_modules.rollback-${Date.now()}-${checkoutCommit.slice(0, 12)}`),
        candidateDependencies: join(dirname(config.checkout), `.botfleet-server.node_modules.update-${process.pid}-${Date.now()}`),
      };
    },

    materializeCandidate: async (prepared, previous) => {
      await rm(previous.candidatePath, { recursive: true, force: true });
      await run("ditto", [prepared.bundlePath, previous.candidatePath]);
      const identity = await validateBuiltBundle(previous.candidatePath, prepared.targetCommit);
      if (identity.designatedRequirement !== prepared.designatedRequirement ||
          identity.designatedRequirement !== previous.installedIdentity.designatedRequirement) {
        throw new Error("Candidate and installed app do not share the stable signing requirement");
      }
      await rm(previous.candidateDependencies, { recursive: true, force: true });
      await run("/bin/cp", ["-cR", prepared.dependenciesPath, previous.candidateDependencies]);
      if (await dependencyFingerprint(previous.candidateDependencies) !== prepared.dependencyFingerprint) {
        throw new Error("Materialized dependency candidate does not match the prepared tree");
      }
    },

    cleanupCandidate: async (_prepared, previous) => {
      await rm(previous.candidatePath, { recursive: true, force: true });
      await rm(previous.candidateDependencies, { recursive: true, force: true });
    },

    quiesce: async (previous) => {
      if (previous.launchdLoaded) {
        const stopped = await run("launchctl", ["bootout", `${config.domain}/${config.label}`], { allowFailure: true });
        if (stopped.code !== 0) throw new Error(`Could not boot out ${config.label} before install`);
      }
      await run("osascript", ["-e", 'if application "BotFleet" is running then tell application "BotFleet" to quit'], { allowFailure: true });
      const currentHolders = await sqliteHolders(config.dataDirectory);
      await terminateVerified([...previous.runtimePids, ...previous.appPids, ...currentHolders], previous, config);
    },

    assertQuiesced: async () => {
      const holders = await sqliteHolders(config.dataDirectory);
      if (holders.length) throw new Error(`BotFleet database still has ${holders.length} live holders after graceful shutdown`);
      const health = await Promise.all(config.ports.map(probeHealth));
      if (health.some((item) => item.kind !== "none")) {
        throw new Error("A BotFleet port is still owned after graceful shutdown");
      }
    },

    advanceCheckout: async (targetCommit) => {
      await git(config.checkout, ["checkout", "--detach", targetCommit]);
      const head = await gitOutput(config.checkout, ["rev-parse", "HEAD"]);
      if (head !== targetCommit) throw new Error("Live checkout did not advance to the prepared commit");
    },

    installCandidate: async (_prepared, previous) => {
      if (await exists(previous.rollbackPath)) throw new Error(`Rollback path already exists: ${previous.rollbackPath}`);
      if (await exists(previous.rollbackDependencies)) throw new Error(`Dependency rollback path already exists: ${previous.rollbackDependencies}`);
      const liveDependencies = join(config.checkout, "node_modules");
      await swapPreparedFiles({
        appPath: config.appPath,
        candidateApp: previous.candidatePath,
        rollbackApp: previous.rollbackPath,
        liveDependencies,
        candidateDependencies: previous.candidateDependencies,
        rollbackDependencies: previous.rollbackDependencies,
      });
      await run("touch", [config.appPath]);
      const register = "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister";
      await run(register, ["-f", config.appPath], { allowFailure: true });
    },

    startHarness: async () => {
      await run("launchctl", ["bootstrap", config.domain, config.plist]);
    },

    verifyHarness: async (prepared) => {
      const deadline = Date.now() + config.startupTimeoutMs;
      let snapshot;
      while (Date.now() < deadline) {
        snapshot = await runtimePreflight(config, prepared);
        if (snapshot.safe) return;
        await sleep(500);
      }
      throw new Error(snapshot?.reason || "Updated harness did not prove its expected build and ownership before timeout");
    },

    startApplication: async (_prepared, _previous, options) => {
      if (options.openApplication !== false) await run("open", [config.appPath]);
    },

    verifySingleOwner: async (prepared) => {
      if (config.parsed.openApplication !== false) await sleep(2_000);
      const snapshot = await runtimePreflight(config, prepared);
      if (!snapshot.safe || snapshot.mode !== "authenticated") {
        throw new Error(snapshot.reason || "Updated application did not attach to the authenticated single data owner");
      }
    },

    finish: async (prepared, previous) => {
      await atomicJson(`${previous.rollbackPath}.json`, {
        schemaVersion: 1,
        previousCommit: previous.checkoutCommit,
        replacementCommit: prepared.targetCommit,
        rollbackBundle: previous.rollbackPath,
        rollbackDependencies: previous.rollbackDependencies,
        installedAt: new Date().toISOString(),
      });
      console.log(`Updated BotFleet to ${prepared.targetCommit.slice(0, 12)}.`);
      console.log(`Recoverable prior bundle: ${previous.rollbackPath}`);
      console.log(`Recoverable prior dependency tree: ${previous.rollbackDependencies}`);
      console.log(`Recoverable prior checkout commit: ${previous.checkoutCommit}`);
    },

    rollback: async (_prepared, previous) => {
      const stopErrors = [];
      const recordStop = async (operation) => {
        try { await operation(); } catch (error) { stopErrors.push(error); }
      };
      await recordStop(async () => { await run("launchctl", ["bootout", `${config.domain}/${config.label}`], { allowFailure: true }); });
      await recordStop(async () => { await run("osascript", ["-e", 'if application "BotFleet" is running then tell application "BotFleet" to quit'], { allowFailure: true }); });
      await recordStop(async () => {
        const holders = await sqliteHolders(config.dataDirectory);
        const appPids = await exactAppPids(config.appPath);
        await terminateVerified([...holders, ...appPids], { ...previous, runtimePids: [...new Set([...previous.runtimePids, ...holders])] }, config);
      });
      await recordStop(async () => {
        const holders = await sqliteHolders(config.dataDirectory);
        const health = await Promise.all(config.ports.map(probeHealth));
        if (holders.length || health.some((item) => item.kind !== "none")) {
          throw new Error("Rollback cannot mutate files while a BotFleet process, port, or database owner remains");
        }
      });
      if (stopErrors.length) throw new AggregateError(stopErrors, "Could not quiesce the failed replacement for safe rollback");

      const errors = [];
      const record = async (operation) => {
        try { await operation(); } catch (error) { errors.push(error); }
      };
      await record(async () => {
        const liveDependencies = join(config.checkout, "node_modules");
        if (await exists(previous.rollbackDependencies)) {
          if (await exists(liveDependencies)) await rename(liveDependencies, `${liveDependencies}.failed-${Date.now()}`);
          await rename(previous.rollbackDependencies, liveDependencies);
        }
      });
      await record(async () => {
        if (await exists(previous.rollbackPath)) {
          if (await exists(config.appPath)) await rename(config.appPath, `${config.appPath}.failed-${Date.now()}`);
          await rename(previous.rollbackPath, config.appPath);
        }
      });
      await record(async () => { await git(config.checkout, ["checkout", "--detach", previous.checkoutCommit]); });
      await record(async () => { await rm(previous.candidatePath, { recursive: true, force: true }); });
      await record(async () => { await rm(previous.candidateDependencies, { recursive: true, force: true }); });
      await record(async () => {
        const head = await gitOutput(config.checkout, ["rev-parse", "HEAD"]);
        if (head !== previous.checkoutCommit) throw new Error("Rollback did not restore the prior checkout commit");
        const identity = await signatureIdentity(config.appPath);
        if (identity.designatedRequirement !== previous.installedIdentity.designatedRequirement) {
          throw new Error("Rollback did not restore the prior application identity");
        }
        const fingerprint = await dependencyFingerprint(join(config.checkout, "node_modules"));
        if (fingerprint !== previous.installedDependencyFingerprint) {
          throw new Error("Rollback did not restore the prior dependency tree");
        }
      });
      if (errors.length) throw new AggregateError(errors, "One or more rollback file restorations failed");

      if (previous.launchdLoaded) await record(async () => { await run("launchctl", ["bootstrap", config.domain, config.plist]); });
      if (previous.appWasRunning) await record(async () => { await run("open", [config.appPath]); });
      if (previous.launchdLoaded || previous.appWasRunning) await record(async () => {
        const deadline = Date.now() + config.startupTimeoutMs;
        let snapshot;
        while (Date.now() < deadline) {
          snapshot = await runtimePreflight(config);
          if (snapshot.safe) return;
          await sleep(500);
        }
        throw new Error(snapshot?.reason || "Restored BotFleet runtime did not regain safe single ownership");
      });
      if (errors.length) throw new AggregateError(errors, "One or more rollback restart operations failed");
      console.error(`Update failed; restored BotFleet bundle and checkout ${previous.checkoutCommit.slice(0, 12)}.`);
    },
  };
}

export async function loadPrepared(stageDirectory) {
  await assertPrivateDirectory(stageDirectory, "Update stage");
  const manifestPath = join(stageDirectory, "prepared.json");
  await assertPrivateRegularFile(manifestPath, "Prepared update manifest");
  const manifest = await parseJsonFile(manifestPath, "Prepared update manifest");
  if (manifest?.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(manifest?.sourceCommit || "") ||
      manifest?.teamIdentifier !== EXPECTED_TEAM_ID || manifest?.bundleIdentifier !== EXPECTED_BUNDLE_ID ||
      !Number.isInteger(manifest?.apiVersion) || !/^[a-f0-9]{64}$/.test(manifest?.uiHash || "") ||
      typeof manifest?.designatedRequirement !== "string" || manifest?.bundleName !== "BotFleet.app" ||
      manifest?.dependenciesName !== "node_modules" ||
      !/^[a-f0-9]{64}$/.test(manifest?.dependencyFingerprint || "")) {
    throw new Error("Prepared update manifest has an invalid identity");
  }
  return {
    ...manifest,
    targetCommit: manifest.sourceCommit,
    stageDirectory,
    manifestPath,
    bundlePath: join(stageDirectory, manifest.bundleName),
    dependenciesPath: join(stageDirectory, manifest.dependenciesName),
  };
}

export async function main(argv = process.argv.slice(2)) {
  if (process.platform !== "darwin" && process.env.BOTFLEET_UPDATE_ALLOW_NON_DARWIN !== "1") {
    throw new Error("The BotFleet Mac updater only runs on macOS");
  }
  const parsed = parseArguments(argv);
  if (parsed.help) {
    console.log(usage());
    return;
  }
  const config = createConfig(parsed);
  const operations = createOperations(config);
  if (parsed.command === "prepare") {
    await prepareUpdate(parsed, operations);
    return;
  }
  if (parsed.command === "apply") {
    await applyPreparedUpdate(await loadPrepared(parsed.stage), parsed, operations);
    return;
  }
  await runUpdate(parsed, parsed, operations);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(`BotFleet update failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
