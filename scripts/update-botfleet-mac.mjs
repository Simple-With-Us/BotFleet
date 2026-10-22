#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
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
import {
  createUpdateProgress,
  instrumentOperations,
  outcomeForError,
  outcomeMessage,
} from "./update-progress.mjs";
import { validUpdateCredentialReceipt } from "../electron/update-credential-preparation.mjs";

const EXPECTED_TEAM_ID = "CC8UTF7ATG";
// Transition release: main still BUILDS com.botfleet.app (LEGACY_BUNDLE_ID).
// This updater also accepts the renamed app.botfleet.macos candidate so that,
// once this commit is the checkout every Mac runs its updater from, the NEXT
// update (the bundle rename) can be applied by this code.  Candidates stay
// restricted to these two IDs; see applicationIdentitiesCanTransition().  The
// rename PR drops legacy candidates and keeps legacy only as a predecessor.
const EXPECTED_BUNDLE_ID = "app.botfleet.macos";
const LEGACY_BUNDLE_ID = "com.botfleet.app";
const LEGACY_LAUNCH_AGENT_LABEL = "com.jay.botfleet-server";
const PREPARED_SCHEMA_VERSION = 2;
const EXPECTED_SIGN_IDENTITY = "Developer ID Application: Jay Wedgeworth, LLC (CC8UTF7ATG)";
const BUILDER_SIGN_SELECTOR = "Jay Wedgeworth, LLC (CC8UTF7ATG)";
export const DEFAULT_PORTS = [8799, 18799, 28799];
const BUILD_MANIFEST_RELATIVE = "Contents/Resources/server/build-identity.json";
const GENERATED_PATHS = [
  "electron/resources/BotFleet Recorder.app/Contents/MacOS/recorder-helper",
  "electron/resources/BotFleet Speech.app/Contents/MacOS/speech-helper",
  "electron/vendor/electron-updater.cjs",
];
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
  const command = ["prepare", "apply", "update", "unquiesce"].includes(args[0]) ? args.shift() : "update";
  const parsed = {
    command,
    target: "origin/main",
    source: undefined,
    stage: undefined,
    bundle: undefined,
    dependencies: undefined,
    openApplication: true,
    progress: undefined,
    runId: undefined,
  };
  while (args.length) {
    const arg = args.shift();
    if (arg === "--target") parsed.target = requiredValue(arg, args.shift());
    else if (arg.startsWith("--target=")) parsed.target = requiredValue("--target", arg.slice("--target=".length));
    else if (arg === "--source") parsed.source = resolve(requiredValue(arg, args.shift()));
    else if (arg === "--stage") parsed.stage = resolve(requiredValue(arg, args.shift()));
    else if (arg === "--bundle") parsed.bundle = resolve(requiredValue(arg, args.shift()));
    else if (arg === "--dependencies") parsed.dependencies = resolve(requiredValue(arg, args.shift()));
    else if (arg === "--progress") parsed.progress = resolve(requiredValue(arg, args.shift()));
    else if (arg === "--run-id") parsed.runId = requiredValue(arg, args.shift());
    else if (arg === "--no-open") parsed.openApplication = false;
    else if (arg === "--force" || arg === "-f") parsed.force = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (command === "apply" && !parsed.stage) throw new Error("apply requires --stage <directory>");
  if (command === "unquiesce" && (parsed.target !== "origin/main" || parsed.source || parsed.stage || parsed.bundle ||
      parsed.dependencies || parsed.openApplication === false || parsed.progress || parsed.runId)) {
    throw new Error("unquiesce accepts no options");
  }
  if (command === "apply" && (parsed.bundle || parsed.dependencies || parsed.source)) {
    throw new Error("apply accepts only a prepared --stage");
  }
  if (Boolean(parsed.bundle) !== Boolean(parsed.dependencies)) {
    throw new Error("--bundle and --dependencies must be supplied together");
  }
  if (parsed.bundle && !parsed.source) {
    throw new Error("importing a built bundle requires its exact --source checkout");
  }
  if (parsed.runId !== undefined) {
    if (!parsed.progress) throw new Error("--run-id requires --progress <path>");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(parsed.runId)) throw new Error("--run-id must be a short identifier");
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
  update-botfleet-mac.mjs unquiesce

Any of update/prepare/apply also accepts --progress PATH [--run-id ID], which records each
step and the final outcome to a JSON file a detached caller can read while the run is going.

prepare builds and validates without touching the live checkout, installed app, or processes.
An existing exact-source build can be imported with --bundle and --dependencies.
apply performs a fresh active-work check, installs one prepared stage, verifies exact runtime identity,
and rolls the prior bundle and checkout back if any install or startup step fails.
unquiesce is the authenticated recovery action if the updater exits after fencing admission but before shutdown.`;
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

async function existingAncestor(path) {
  let current = resolve(path);
  for (;;) {
    if (await exists(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/**
 * A rename is atomic only inside one filesystem, so the rollback bundle may
 * live in the update cache only when that cache shares a volume with the
 * installed application.  Neither path needs to exist yet; the nearest
 * existing ancestor carries the same device number.
 */
export async function sameVolume(left, right, statPath = stat) {
  const [leftDetails, rightDetails] = await Promise.all([
    statPath(await existingAncestor(left)),
    statPath(await existingAncestor(right)),
  ]);
  return leftDetails.dev === rightDetails.dev;
}

/**
 * Prefer the update's own private cache directory so a hidden bundle never
 * sits in /Applications, where Spotlight and Launchpad still index it and
 * where a process whose bundle was renamed underneath it shows the rollback
 * name in the Dock.  Fall back to the adjacent hidden name only when an
 * atomic rename into the cache would cross a volume, and say so in the receipt.
 */
export async function resolveRollbackPlacement(
  { livePath, stageDirectory, stageName, generation, adjacentPath },
  sameVolumeCheck = sameVolume,
) {
  // A stage can be reused across applies (`--stage` names one explicitly), so
  // the cache placement carries the same per-run generation the adjacent name
  // has always carried.  Without it a second apply into one stage would find
  // its rollback path already occupied by the first apply's bundle.
  const stageRollbackDirectory = join(stageDirectory, "rollback", generation);
  if (await sameVolumeCheck(stageRollbackDirectory, livePath)) {
    return {
      path: join(stageRollbackDirectory, stageName),
      directory: stageRollbackDirectory,
      placement: "stage",
      crossVolume: false,
    };
  }
  return {
    path: adjacentPath,
    directory: dirname(adjacentPath),
    placement: "adjacent",
    crossVolume: true,
    crossVolumeReason: `${stageRollbackDirectory} is on a different volume than ${livePath}, so an atomic rename into the update cache is not possible`,
  };
}

/**
 * Receipts written before this change carried no status and were only ever
 * written after a verified install, so a missing status still means verified.
 */
export function rollbackGenerationStatus(receipt) {
  const status = receipt?.status;
  if (status === undefined || status === null || status === "verified") return "verified";
  return String(status);
}

/**
 * A receipt written before placement was recorded names no app path, and its
 * bundle name cannot supply one: the earlier code spelled `.BotFleet.rollback-`
 * literally no matter what `BOTFLEET_APP_PATH` pointed at, so two installs
 * sharing a folder produced indistinguishable copies.  Testing the claimant's
 * own basename only decided which of them got to delete the other's bundle.
 * Nothing may claim such a receipt; `unclaimedGenerations` reports them for a
 * person to remove deliberately.
 */
export function generationBelongsToApp(receipt, appPath) {
  if (!appPath) return true;
  return typeof receipt?.appPath === "string" && receipt.appPath === appPath;
}

export function unclaimedGenerations(generations) {
  return generations.filter((item) => typeof item.receipt?.appPath !== "string");
}

/**
 * Keep exactly one rollback generation per installed app path.  An unverified
 * or still-installing generation is never a prune candidate and never counts
 * as the generation being kept: its bundle may be the only way back.  When a
 * specific generation must be kept and it is not among those discovered,
 * nothing is pruned — deleting on the strength of a list that does not contain
 * the copy just made is how the newest bundle gets destroyed.
 */
export function rollbackGenerationsToPrune(generations, { appPath, keepReceiptPath } = {}) {
  const mine = generations.filter((item) => generationBelongsToApp(item.receipt, appPath));
  const verified = mine.filter((item) => rollbackGenerationStatus(item.receipt) === "verified");
  const ordered = [...verified].sort((left, right) =>
    String(right.receipt?.installedAt || "").localeCompare(String(left.receipt?.installedAt || "")));
  if (keepReceiptPath) {
    if (!ordered.some((item) => item.receiptPath === keepReceiptPath)) return [];
    return ordered.filter((item) => item.receiptPath !== keepReceiptPath);
  }
  return ordered.slice(1);
}

/**
 * A receipt names the paths to remove, so refuse any that a corrupted or
 * hostile receipt could point outside the three roots this updater owns.
 */
export function prunablePath(path, roots) {
  if (typeof path !== "string" || !path) return false;
  const target = resolve(path);
  return roots.some((root) => {
    const base = resolve(root);
    return target !== base && target.startsWith(`${base}${sep}`);
  });
}

/**
 * A candidate is named after the updater process that staged it, so an
 * interrupted run leaves one behind with no receipt.  Remove only the ones
 * whose updater is provably gone: a name whose pid segment does not parse
 * was written by something other than this updater and is reported, never
 * deleted.  Both kinds are swept — the bundle beside the installed app and
 * the dependency tree beside the live checkout.
 */
export function staleCandidateNames(names, { prefix, suffix = "", keepNames = [], isAlive = processIsAlive } = {}) {
  const stale = [];
  const unrecognised = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix) || name.length <= prefix.length + suffix.length) continue;
    if (keepNames.includes(name)) continue;
    const pid = Number(name.slice(prefix.length).split("-")[0]);
    if (!Number.isInteger(pid) || pid <= 0) unrecognised.push(name);
    else if (!isAlive(pid)) stale.push(name);
  }
  return { stale, unrecognised };
}

export const CANDIDATE_BUNDLE_PREFIX = ".BotFleet.update-";
export const CANDIDATE_DEPENDENCY_PREFIX = ".botfleet-server.node_modules.update-";
// A failed replacement's dependency tree is set aside beside the checkout, not
// inside it: anything left in the checkout shows up as untracked in
// `git status --porcelain`, and the dirty-checkout guard would then refuse
// every later update forever.  It carries the updater's pid so the ordinary
// candidate rule sweeps it once that process is gone.
export const FAILED_DEPENDENCY_PREFIX = ".botfleet-server.node_modules.failed-";
// Entries a stage directory is allowed to contain and still be swept
// unattended.  Anything else in there was put there by a person, and a person
// gets to decide when it goes.
const KNOWN_STAGE_ENTRIES = new Set([
  "BotFleet.app", "node_modules", "prepared.json", "rollback", "source",
  "pending-recovery.json", "credential-migration.json",
]);
export const ABANDONED_STAGE_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * A port that answers is not by itself a reason to refuse or to keep waiting.
 * Three cases are genuinely different: BotFleet still owns the port, something
 * else owns it, or the probe could not tell.  Only the first says the shutdown
 * did not finish.
 */
export function quiescedPortError(results) {
  const named = (items) => items.map((item) => `${item.port}`).join(", ");
  const botfleet = results.filter((item) => item.kind === "botfleet");
  if (botfleet.length) {
    return `BotFleet still answers on port ${named(botfleet)} (pid ${[...new Set(botfleet.map((item) => item.pid))].join(", ")}) after graceful shutdown`;
  }
  const foreign = results.filter((item) => item.kind === "foreign" || item.kind === "http");
  if (foreign.length) {
    const detail = foreign
      .map((item) => `${item.port} (${item.kind === "http" ? `HTTP ${item.status}` : "a health response that is not BotFleet's"})`)
      .join(", ");
    return `Another service answers port ${detail}; free that port or point BOTFLEET_UPDATE_PORTS elsewhere before updating`;
  }
  const unavailable = results.filter((item) => item.kind === "unavailable");
  if (unavailable.length) {
    return `Port ${named(unavailable)} did not answer conclusively after retries (${unavailable.map((item) => item.reason || "unknown").join(", ")})`;
  }
  return null;
}

/**
 * After the boundary the question is not whether a port answers but whether
 * anything this transaction owns is still alive.  A stranger on one of the
 * fallback ports, or a probe that timed out once, must never hold a rollback
 * open — that would leave the Mac mid-install waiting on something the update
 * has no relationship with.
 */
export function ownedRuntimePids({ holders = [], bundlePids = [], health = [], ownerPid } = {}) {
  const fromHealth = health.filter((item) => item.kind === "botfleet").map((item) => item.pid);
  return [...new Set([...holders, ...bundlePids, ...fromHealth, ownerPid].filter(Number.isInteger))];
}

/**
 * Stage directories this updater creates end in `Date.now()`.  The suffix has
 * to be exactly that and nothing else: a hand-made directory ending in a date
 * like `-20260912` parses as a number too, and reading it as epoch
 * milliseconds would date that stage to 1970 and make it look ancient.
 */
export function stageStamp(name) {
  const last = name.split("-").at(-1);
  return /^\d{13}$/.test(last) ? Number(last) : null;
}

/**
 * A stage nobody references, with no prepared manifest and no rollback
 * generation, is leftover.  An empty one goes immediately.  A stale one goes
 * only when everything still inside it is something this updater wrote; a
 * stage holding anything else was arranged by a person and is only reported.
 */
export function abandonedStages(entries, { now = Date.now(), referenced = [], ageMs = ABANDONED_STAGE_AGE_MS } = {}) {
  const prune = [];
  const report = [];
  for (const entry of entries) {
    if (referenced.includes(entry.path)) continue;
    if (entry.hasPrepared || entry.hasGeneration) continue;
    if (!entry.names.length) {
      prune.push(entry.path);
      continue;
    }
    const stamp = stageStamp(entry.name) ?? entry.mtimeMs;
    const stale = Number.isFinite(stamp) && now - stamp > ageMs;
    if (stale && entry.names.every((name) => KNOWN_STAGE_ENTRIES.has(name))) prune.push(entry.path);
    else report.push(entry.path);
  }
  return { prune, report };
}

/**
 * A run killed between the swap and its verification leaves a receipt stuck at
 * `installing`, which prune must never touch.  It can still be settled with
 * evidence rather than left forever: if it names as its replacement exactly the
 * build that was installed and running when this run captured the previous
 * state, that install plainly succeeded — the preflight proved that bundle was
 * a healthy, single-owner runtime before anything moved.
 */
export function reconcilableGenerations(generations, { appPath, installedCommit } = {}) {
  if (!installedCommit) return [];
  return generations.filter((item) =>
    generationBelongsToApp(item.receipt, appPath) &&
    rollbackGenerationStatus(item.receipt) === "installing" &&
    item.receipt?.replacementCommit === installedCommit);
}

/**
 * `ps` reports the arguments captured at exec, and they do not follow a later
 * rename of the bundle, so an argv match cannot find a process still running
 * out of a bundle this updater just renamed.  The kernel's open reference does
 * follow it: the running binary and everything it maps stay open as `txt`
 * descriptors, and lsof prints their current paths.
 */
export function txtHolderPids(lsofOutput, bundleRealPath) {
  const prefix = `${bundleRealPath}${sep}`;
  const pids = new Set();
  let pid = null;
  for (const line of lsofOutput.split("\n")) {
    if (line.startsWith("p")) {
      const value = Number(line.slice(1));
      pid = Number.isInteger(value) && value > 0 ? value : null;
      continue;
    }
    if (pid === null || !line.startsWith("n")) continue;
    if (line.slice(1).startsWith(prefix)) pids.add(pid);
  }
  return [...pids];
}

/**
 * macOS binds a running process to the bundle it was launched from, so a
 * process that survives the swap keeps running out of the renamed bundle and
 * shows that name in the Dock and menu bar until it is relaunched.
 */
/**
 * A failed install leaves the replacement behind as `<name>.failed-<stamp>`
 * so it can be examined.  Nothing ever removes them, and nothing mentioned
 * them either.  They are evidence of a failed update, so they are reported
 * rather than deleted.
 */
export function failedInstallBundles(names, bundleName) {
  return names.filter((name) => name.startsWith(`${bundleName}.failed-`));
}

export function survivingRollbackProcessError(pids, rollbackPath) {
  if (!pids.length) return null;
  return `BotFleet process ${pids.join(", ")} still runs from the prior bundle ${rollbackPath}; it would keep showing that bundle's name until relaunch`;
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

export function run(command, args, { cwd, env, allowFailure = false, inherit = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (!inherit) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
    }
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      rejectRun(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
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

export async function dependencyFingerprint(nodeModulesPath) {
  const details = await lstat(nodeModulesPath);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`Staged dependency root must be a real directory: ${nodeModulesPath}`);
  }
  const digest = createHash("sha256");
  const frame = (kind, relativePath, value = "") => {
    digest.update(`${kind}\0${Buffer.byteLength(relativePath)}\0${relativePath}\0${Buffer.byteLength(value)}\0${value}\0`);
  };
  const walk = async (directory, relativeDirectory = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      const entryDetails = await lstat(path);
      const mode = String(entryDetails.mode & 0o777);
      if (entryDetails.isSymbolicLink()) {
        frame("link", relativePath, `${mode}\0${await readlink(path)}`);
      } else if (entryDetails.isDirectory()) {
        frame("directory", relativePath, mode);
        await walk(path, relativePath);
      } else if (entryDetails.isFile()) {
        frame("file", relativePath, `${mode}\0${entryDetails.size}`);
        for await (const chunk of createReadStream(path)) digest.update(chunk);
        digest.update("\0");
      } else {
        throw new Error(`Unsupported entry in staged dependency tree: ${path}`);
      }
    }
  };
  frame("root", "", String(details.mode & 0o777));
  await walk(nodeModulesPath);
  return digest.digest("hex");
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

async function requestJson(url, { headers = {}, method = "GET", timeoutMs = 3_000, accept = [200] } = {}) {
  let response;
  try {
    response = await fetch(url, {
      headers,
      method,
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

async function probeHealthWithRetry(port, { attempts = 3, backoffMs = 250 } = {}) {
  let result;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    result = await probeHealth(port);
    // none, botfleet, foreign and http are all definitive; only an
    // unreachable or ambiguous response is worth asking again, because a
    // single three-second timeout is not evidence that a port is owned.
    if (result.kind !== "unavailable") return { ...result, port };
    if (attempt + 1 < attempts) await sleep(backoffMs * (attempt + 1));
  }
  return { ...result, port };
}

async function probeHealth(port) {
  const result = await requestJson(`http://127.0.0.1:${port}/api/health`, { accept: [200] });
  if (result.kind !== "ok") return result;
  if (result.body?.app !== "botfleet" || !Number.isInteger(result.body?.pid) || result.body.pid <= 0) {
    return { kind: "foreign" };
  }
  // The harness binds its port before the boot work and answers health with
  // `ready: false` until that work finishes, 503-ing every other route
  // meanwhile.  Alive but not yet serving is exactly what "unavailable" means
  // here — and it is the one kind probeHealthWithRetry asks again about.
  if (result.body.ready === false || result.body.booting === true) {
    return { kind: "unavailable", reason: "booting", port };
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

export function healthTopologyResult(results, { allowMultiple = false } = {}) {
  if (results.some((item) => item.kind === "unavailable")) {
    return { safe: false, reason: "A BotFleet port returned an unavailable or ambiguous response" };
  }
  const botfleet = results.filter((item) => item.kind === "botfleet");
  if (!botfleet.length) return { safe: false, reason: "No BotFleet harness answered the expected ports" };
  const pids = [...new Set(botfleet.map((item) => item.pid))];
  if (!allowMultiple && pids.length !== 1) {
    return { safe: false, reason: `Multiple BotFleet runtime owners answered (${pids.length})` };
  }
  return { safe: true, pid: pids[0], pids, port: botfleet[0].port, health: botfleet };
}

async function healthTopology(ports, options = {}) {
  return healthTopologyResult(await Promise.all(ports.map(probeHealth)), options);
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

export function authenticatedRuntimeError(runtime, owner, expectedBuild, { requireIdle }) {
  const activeWorkCount = runtime?.activeWorkCount ?? runtime?.activeWork?.count;
  if (runtime?.app !== "botfleet" || runtime?.pid !== owner.pid ||
      runtime?.dataOwner?.pid !== owner.pid || runtime?.dataOwner?.port !== owner.port) {
    return "Authenticated runtime identity does not match the data owner";
  }
  if (typeof runtime.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(runtime.sourceCommit)) {
    return "Authenticated runtime did not report an exact source commit";
  }
  if (runtime.sourceDirty !== false) {
    return "Authenticated runtime reports a dirty or unknown source checkout";
  }
  if (expectedBuild && runtime.sourceCommit !== expectedBuild.targetCommit) {
    return `Harness is running ${runtime.sourceCommit.slice(0, 12)}, expected ${expectedBuild.targetCommit.slice(0, 12)}`;
  }
  if (expectedBuild && (runtime.version !== expectedBuild.version || runtime.apiVersion !== expectedBuild.apiVersion ||
      (runtime.uiHash !== null && runtime.uiHash !== expectedBuild.uiHash))) {
    return "Harness runtime identity does not match the prepared application build";
  }
  if (requireIdle && (runtime.safeToRestart !== true || activeWorkCount !== 0)) {
    return `${Number.isInteger(activeWorkCount) ? activeWorkCount : "Unknown"} active operations prevent update`;
  }
  return null;
}

async function strictRuntimePreflight(config, expectedBuild, { requireIdle }) {
  const owner = await readOwner(config.dataDirectory);
  if (!owner) return null;
  const response = await requestJson(`http://127.0.0.1:${owner.port}/api/runtime`, {
    headers: { Authorization: `Bearer ${owner.nonce}` },
    accept: [200],
  });
  if (response.kind === "http" && response.status === 404) return null;
  if (response.kind !== "ok") return { safe: false, reason: "Authenticated runtime readiness could not be verified" };
  const runtime = response.body;
  const identityError = authenticatedRuntimeError(runtime, owner, expectedBuild, { requireIdle });
  if (identityError) return { safe: false, reason: identityError };
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

export async function runtimePreflight(config, expectedBuild) {
  const requireIdle = !config?.force && process.env.BOTFLEET_FORCE !== "1";
  const strict = await strictRuntimePreflight(config, expectedBuild, { requireIdle });
  if (strict) return strict;
  return { safe: false, reason: "Runtime does not expose complete authenticated readiness; manual first adoption is required" };
}

async function runtimeIdentityPreflight(config, expectedBuild) {
  const strict = await strictRuntimePreflight(config, expectedBuild, { requireIdle: false });
  return strict || { safe: false, reason: "Expected build does not expose authenticated runtime identity" };
}

export async function fenceRuntimeAdmission(config, adapters = {}) {
  const readRuntimeOwner = adapters.readOwner ?? readOwner;
  const request = adapters.requestJson ?? requestJson;
  const inspectTopology = adapters.healthTopology ?? healthTopology;
  const inspectHolders = adapters.sqliteHolders ?? sqliteHolders;
  const releaseAdmission = adapters.releaseRuntimeAdmission ?? releaseRuntimeAdmission;
  const owner = await readRuntimeOwner(config.dataDirectory);
  if (!owner) return { safe: false, reason: "Authenticated runtime owner is unavailable for the admission fence" };
  const forceQuery = (config?.force || process.env.BOTFLEET_FORCE === "1") ? "?force=true" : "";
  const response = await request(`http://127.0.0.1:${owner.port}/api/runtime/quiesce${forceQuery}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${owner.nonce}` },
    accept: [200, 409],
  });
  if (response.kind !== "ok") return { safe: false, reason: "Runtime admission fence could not be established" };
  const runtime = response.body;
  const fenceHeld = response.status === 200 && runtime?.quiescing === true;
  const refuseAfterFence = async (reason) => {
    if (!fenceHeld) return { safe: false, reason };
    try {
      await releaseAdmission(config);
      return { safe: false, reason };
    } catch (error) {
      return {
        safe: false,
        reason: `${reason}.  Admission recovery also failed; run update-botfleet.sh unquiesce before retrying: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
  const requireIdle = !config?.force && process.env.BOTFLEET_FORCE !== "1";
  const identityError = authenticatedRuntimeError(runtime, owner, undefined, { requireIdle });
  if (identityError || !fenceHeld) {
    return refuseAfterFence(identityError || "Runtime refused the admission fence because work is active");
  }
  let topology;
  let holders;
  try {
    [topology, holders] = await Promise.all([
      inspectTopology(config.ports),
      inspectHolders(config.dataDirectory),
    ]);
  } catch {
    return refuseAfterFence("Runtime ownership could not be verified after the admission fence");
  }
  if (!topology.safe || topology.pid !== owner.pid) {
    return refuseAfterFence(topology.reason || "Health endpoints do not share the fenced runtime owner");
  }
  if (holders.length !== 1 || holders[0] !== owner.pid) {
    return refuseAfterFence(`Database ownership is ambiguous after admission fence (${holders.length} live holders)`);
  }
  return { safe: true, mode: "authenticated", pid: owner.pid, port: owner.port, runtime, holders, health: topology.health };
}

export async function releaseRuntimeAdmission(config) {
  const owner = await readOwner(config.dataDirectory);
  if (!owner) throw new Error("Authenticated runtime owner is unavailable for admission recovery");
  const response = await requestJson(`http://127.0.0.1:${owner.port}/api/runtime/quiesce`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${owner.nonce}` },
    accept: [200],
  });
  if (response.kind !== "ok" || response.body?.quiescing !== false) {
    throw new Error("Runtime admission fence could not be released");
  }
}

async function signatureIdentity(bundlePath, { allowLegacyBundleId = false } = {}) {
  await run("codesign", ["--verify", "--deep", "--strict", bundlePath]);
  const details = await run("codesign", ["-dvv", bundlePath], { allowFailure: true });
  const text = `${details.stdout}\n${details.stderr}`;
  const teamIdentifier = text.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  const identifier = text.match(/^Identifier=(.+)$/m)?.[1]?.trim();
  const acceptedBundleIds = allowLegacyBundleId
    ? [EXPECTED_BUNDLE_ID, LEGACY_BUNDLE_ID]
    : [EXPECTED_BUNDLE_ID];
  if (teamIdentifier !== EXPECTED_TEAM_ID || !acceptedBundleIds.includes(identifier)) {
    throw new Error(`BotFleet signature identity mismatch (team ${teamIdentifier || "missing"}, bundle ${identifier || "missing"})`);
  }
  const requirement = await run("codesign", ["-dr", "-", bundlePath], { allowFailure: true });
  const designatedRequirement = designatedRequirementFromOutput(`${requirement.stdout}\n${requirement.stderr}`);
  if (!designatedRequirement.includes(`identifier "${identifier}"`) ||
      !designatedRequirement.includes(`certificate leaf[subject.OU] = ${EXPECTED_TEAM_ID}`)) {
    throw new Error("BotFleet designated signing requirement is missing its stable bundle or team identity");
  }
  return { teamIdentifier, bundleIdentifier: identifier, designatedRequirement: sha256(designatedRequirement) };
}

export function applicationIdentitiesCanTransition(installed, candidate) {
  if (candidate.teamIdentifier !== EXPECTED_TEAM_ID || installed.teamIdentifier !== EXPECTED_TEAM_ID) return false;
  const sameRequirement = installed.designatedRequirement === candidate.designatedRequirement;
  // Transition release only: a legacy-ID candidate (what main builds until the
  // rename lands) may replace a legacy-ID install with the same designated
  // requirement -- exactly the pre-transition rule.  It may never replace a
  // renamed install (no identity downgrade).
  if (candidate.bundleIdentifier === LEGACY_BUNDLE_ID) {
    return installed.bundleIdentifier === LEGACY_BUNDLE_ID && sameRequirement;
  }
  return candidate.bundleIdentifier === EXPECTED_BUNDLE_ID &&
    (installed.bundleIdentifier === EXPECTED_BUNDLE_ID || installed.bundleIdentifier === LEGACY_BUNDLE_ID) &&
    (installed.bundleIdentifier === LEGACY_BUNDLE_ID || sameRequirement);
}

export function designatedRequirementFromOutput(outputText) {
  return outputText
    .split("\n")
    .find((line) => line.startsWith("designated => "))
    ?.trim() || "";
}

export async function validateBuiltBundle(bundlePath, expectedCommit) {
  if (!(await exists(bundlePath))) throw new Error(`Packaged app is missing: ${bundlePath}`);
  const details = await lstat(bundlePath);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`Packaged app must be a real directory: ${bundlePath}`);
  }
  const build = await parseJsonFile(join(bundlePath, BUILD_MANIFEST_RELATIVE), "Packaged build manifest");
  if (build?.sourceCommit !== expectedCommit || !/^[a-f0-9]{40}$/.test(build?.sourceCommit || "")) {
    throw new Error("Packaged app does not contain the expected source commit");
  }
  if (build.app !== "botfleet" || build.sourceDirty !== false ||
      typeof build.version !== "string" || !Number.isInteger(build.apiVersion) ||
      typeof build.uiHash !== "string" || !/^[a-f0-9]{64}$/.test(build.uiHash)) {
    throw new Error("Packaged build manifest is dirty or missing application, version, API, or UI identity");
  }
  // Transition release: main still builds the legacy bundle ID, so a built
  // candidate may carry either accepted ID; applicationIdentitiesCanTransition()
  // decides which installed app it may replace.
  return { ...(await signatureIdentity(bundlePath, { allowLegacyBundleId: true })), version: build.version, apiVersion: build.apiVersion, uiHash: build.uiHash };
}

async function exactAppPids(appPath) {
  const result = await run("ps", ["-axo", "pid=,command="], { allowFailure: true });
  const executable = join(appPath, "Contents/MacOS/BotFleet");
  return result.stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match && (match[2] === executable || match[2].startsWith(`${executable} `)) ? [Number(match[1])] : [];
  });
}

/**
 * Every process holding any executable or mapped library inside the bundle, by
 * the kernel's open reference rather than by recorded arguments.  This is what
 * finds a bundle this updater has already renamed, and it is also what finds
 * the processes that live inside the bundle but are not its main binary — the
 * embedded computer-use driver at `Contents/Resources/cua-driver` and the
 * `BotFleet Speech.app` / `BotFleet Recorder.app` helpers.  Renaming the
 * bundle while any of them runs is the thing to avoid.
 */
async function bundleHolderPids(bundlePath) {
  let root;
  try {
    root = await realpath(bundlePath);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const result = await run("lsof", ["-F", "pn", "-d", "txt"], { allowFailure: true });
  if (![0, 1].includes(result.code)) throw new Error("Could not inspect BotFleet bundle ownership with lsof");
  return txtHolderPids(result.stdout, root);
}

/**
 * The union of what the kernel knows and what the process arguments say.  The
 * argument match stays as a second signal before any rename, where it is still
 * accurate and does not depend on lsof being able to see the process.
 */
async function bundleProcessPids(bundlePath) {
  const [holders, byArguments] = await Promise.all([bundleHolderPids(bundlePath), exactAppPids(bundlePath)]);
  return [...new Set([...holders, ...byArguments])].filter(Number.isInteger);
}

async function installedBuildCommit(appPath) {
  try {
    const build = JSON.parse(await readFile(join(appPath, BUILD_MANIFEST_RELATIVE), "utf8"));
    return /^[a-f0-9]{40}$/.test(build?.sourceCommit || "") ? build.sourceCommit : null;
  } catch {
    return null;
  }
}

async function processCommand(pid) {
  const result = await run("ps", ["-p", String(pid), "-o", "command="], { allowFailure: true });
  return result.code === 0 ? result.stdout.trim() : "";
}

async function processCwd(pid) {
  const result = await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { allowFailure: true });
  return result.code === 0 ? result.stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1) || "" : "";
}

export function isExpectedBotFleetProcess(command, cwd, config) {
  const appExecutable = join(config.appPath, "Contents/MacOS/BotFleet");
  if (command === appExecutable || command.startsWith(`${appExecutable} `) || command.startsWith(`${config.appPath}/Contents/`)) {
    return true;
  }
  const executable = command.trim().split(/\s+/)[0] || "";
  const isNode = ["node", "nodejs"].includes(basename(executable));
  const serverArgument = command.split(/\s+/).some((argument) => argument === "server/index.ts" || argument === join(config.checkout, "server/index.ts"));
  return isNode && serverArgument && cwd === config.checkout;
}

export function stableApplicationProcessError(firstPids, secondPids, openApplication) {
  if (!openApplication) return null;
  if (firstPids.length !== 1 || secondPids.length !== 1 || firstPids[0] !== secondPids[0]) {
    return "Updated BotFleet application did not remain running as one exact installed-bundle process";
  }
  return null;
}

/**
 * Which LaunchAgent plist should the post-install harness start bootstrap?
 *
 * The bundle rename left already-installed Macs with only the legacy
 * com.jay.botfleet-server.plist on disk; the renamed
 * app.botfleet.server.plist is materialized by the migration that can only
 * run once the updated harness is up.  Bootstrapping a plist that does not
 * exist fails the transaction, so the first automatic update on a
 * legacy-only Mac rolled itself back.  Until the renamed plist lands, keep
 * bootstrapping the legacy one -- it launches the same live checkout this
 * transaction just advanced.  With neither plist present, keep the original
 * loud failure against the renamed path rather than silently starting
 * nothing.
 */
export function harnessBootstrapPlist(config, { plistExists, legacyPlistExists }) {
  if (plistExists || !legacyPlistExists) return config.plist;
  return config.legacyPlist;
}

/**
 * Restore every harness that was loaded before the transaction from a plist
 * that actually exists.  During the bundle-label migration the new launchd
 * label can still have been bootstrapped from the legacy-named plist, so the
 * loaded label alone does not identify the plist path to restore.
 */
export function rollbackHarnessBootstrapPlists(config, previous, existence) {
  const plists = [];
  // BOTFLEET_LAUNCH_AGENT_LABEL may name the legacy label itself.  Capture
  // then reports the same job as both launchdLoaded and legacyLaunchdLoaded;
  // treat it as one job and restore it once, from the plist startHarness
  // would use, instead of also queueing the hardcoded legacy plist (which may
  // be missing, or would double-bootstrap an already-loaded label).
  if (config.label === config.legacyLabel) {
    if (previous.launchdLoaded || previous.legacyLaunchdLoaded) plists.push(harnessBootstrapPlist(config, existence));
    return plists;
  }
  if (previous.launchdLoaded) plists.push(harnessBootstrapPlist(config, existence));
  if (previous.legacyLaunchdLoaded) plists.push(legacyJobRollbackPlist(config, previous, existence));
  return [...new Set(plists)];
}

/**
 * The plist the legacy-label job is restored from when config.label is the
 * renamed label.  BOTFLEET_LAUNCH_AGENT_PLIST may point at a custom plist
 * whose job runs under the legacy label on a pre-transition Mac; the
 * hardcoded legacy path was never written there, so restoring from it
 * bootstraps nothing and the harness never comes back.  But a plist carries
 * exactly one Label: when the renamed and legacy jobs were both loaded, the
 * custom plist cannot be the source of both, and restoring both from it
 * collapses into a single bootstrap that leaves one job down.  So the custom
 * plist restores the legacy job only when it actually carries the legacy
 * label -- read from the file when available, otherwise inferred from the
 * renamed job not also having been loaded.
 */
function legacyJobRollbackPlist(config, previous, { plistExists, plistLabel }) {
  if (!config.customPlist || !plistExists) return config.legacyPlist;
  if (plistLabel) return plistLabel === config.legacyLabel ? config.plist : config.legacyPlist;
  return previous.launchdLoaded ? config.legacyPlist : config.plist;
}

/**
 * The launchd Label a plist declares, or null when it cannot be read.
 */
export async function launchAgentPlistLabel(plist, runCommand = run) {
  try {
    const result = await runCommand("plutil", ["-extract", "Label", "raw", "-o", "-", plist], { allowFailure: true });
    const label = result.code === 0 ? result.stdout.trim() : "";
    return label || null;
  } catch {
    return null;
  }
}

/**
 * The launchd label a bootstrap of `plist` loads.  The legacy-named plist
 * still carries the legacy label, so a harness started from the fallback runs
 * as com.jay.botfleet-server, not as the renamed label.
 */
export function harnessLaunchdLabel(config, plist) {
  return plist === config.legacyPlist ? config.legacyLabel : config.label;
}

/**
 * The label startHarness() is about to bootstrap from `plist`.  A custom
 * BOTFLEET_LAUNCH_AGENT_PLIST can declare any Label, including the legacy
 * com.jay.botfleet-server, so the path alone does not say which job launchctl
 * starts: read the Label the plist declares, as the rollback restore does,
 * and fall back to the path mapping only when it cannot be read.
 */
export async function startedHarnessLabel(config, plist, readLabel = launchAgentPlistLabel) {
  if (config.customPlist && plist === config.plist) {
    const declared = await readLabel(plist);
    if (declared) return declared;
  }
  return harnessLaunchdLabel(config, plist);
}

/**
 * Every label rollback has to boot out before it may restore files: the
 * renamed label, plus whichever label startHarness() actually bootstrapped.
 * Booting out only the renamed label would leave a legacy-label replacement
 * loaded, and its KeepAlive would restart the failed replacement while
 * rollback waits for ownership to clear.  A quiesce that fails before
 * startHarness runs leaves startedHarnessLabel unset, so the labels the
 * capture found loaded are retried from the recorded launchd state too.
 */
export function rollbackHarnessBootoutLabels(config, previous) {
  const labels = [config.label];
  if (previous?.launchdLoaded) labels.push(config.label);
  if (previous?.legacyLaunchdLoaded) labels.push(config.legacyLabel);
  labels.push(previous?.startedHarnessLabel);
  return [...new Set(labels.filter(Boolean))];
}

/**
 * Labels quiesce must boot out before install, deduplicated: the renamed
 * label and the legacy label, each once.  BOTFLEET_LAUNCH_AGENT_LABEL may
 * name the legacy label itself; deduping first keeps that configuration
 * from matching the skip condition on every pass and never booting out.
 */
export function quiesceBootoutLabels(config, previous) {
  const labels = new Set();
  if (previous?.launchdLoaded) labels.add(config.label);
  if (previous?.legacyLaunchdLoaded) labels.add(config.legacyLabel);
  return [...labels];
}

/**
 * `launchctl bootout` exits nonzero when the job was already gone, so its
 * exit code cannot separate "removed" from "failed".  Confirm with
 * `launchctl print` that the job is actually absent, retrying briefly while
 * launchd tears it down: a job that survives bootout can be relaunched by
 * KeepAlive while rollback is restoring files.
 */
export async function waitForLaunchdBootout(domain, label, {
  attempts = 5,
  delayMs = 500,
  probe = () => run("launchctl", ["print", `${domain}/${label}`], { allowFailure: true }),
  wait = sleep,
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const printed = await probe();
    if (printed.code !== 0) return true;
    if (attempt + 1 < attempts) await wait(delayMs);
  }
  return false;
}

export function applicationAttachmentError(snapshot, openApplication) {
  if (!openApplication) return null;
  const health = Array.isArray(snapshot?.health) ? snapshot.health : [];
  if (health.some((item) => item?.static === true) || health.length >= 2) return null;
  return "Updated BotFleet application stayed open but did not expose its bundled UI through the verified harness";
}

export function rollbackReadinessError(runningProcessCount, snapshot) {
  if (runningProcessCount === 0 || snapshot?.safe === true) return null;
  return snapshot?.reason || "Current BotFleet work state is unavailable";
}

export function pendingRecoveryReceiptPath(prepared) {
  return join(prepared.stageDirectory, "pending-recovery.json");
}

export function credentialPreparationReceiptPath(prepared) {
  return join(prepared.stageDirectory, "credential-migration.json");
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
    const cwd = await processCwd(pid);
    const verified = (previous.processCommands?.[pid] && previous.processCommands[pid] === command &&
        previous.processCwds?.[pid] === cwd) || isExpectedBotFleetProcess(command, cwd, config);
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
  progress = {},
}, renamePath = rename) {
  // `progress` records whether the rollback paths actually hold the prior
  // copies right now.  Recovery must restore from them only when THIS run put
  // them there: a bundle left at a rollback path by some earlier run belongs
  // to an older generation, and promoting it over the live app would install
  // software nobody asked for.
  progress.rollbackAppHolds = false;
  progress.rollbackDependenciesHold = false;
  let newAppMoved = false;
  let newDependenciesMoved = false;
  try {
    await renamePath(appPath, rollbackApp);
    progress.rollbackAppHolds = true;
    await renamePath(liveDependencies, rollbackDependencies);
    progress.rollbackDependenciesHold = true;
    await renamePath(candidateApp, appPath);
    newAppMoved = true;
    await renamePath(candidateDependencies, liveDependencies);
    newDependenciesMoved = true;
  } catch (error) {
    if (newDependenciesMoved) await renamePath(liveDependencies, candidateDependencies);
    if (newAppMoved) await renamePath(appPath, candidateApp);
    if (progress.rollbackDependenciesHold) {
      await renamePath(rollbackDependencies, liveDependencies);
      progress.rollbackDependenciesHold = false;
    }
    if (progress.rollbackAppHolds) {
      await renamePath(rollbackApp, appPath);
      progress.rollbackAppHolds = false;
    }
    throw error;
  }
}

/**
 * One receipt shape for both writes.  Every key the first schema carried stays
 * in place and keeps its meaning, so an older reader still resolves the prior
 * bundle, dependency tree, and commit; the added keys describe placement and
 * whether the install has been verified yet.
 */
function rollbackReceipt(prepared, previous, config, extra) {
  return {
    schemaVersion: 1,
    previousCommit: previous.checkoutCommit,
    // The checkout commit and the installed build can disagree: `ubf --force`
    // exists precisely because the checkout can sit at origin/main while the
    // installed app still carries older code.  `previousCommit` keeps its
    // original meaning, the checkout, and this names what the rollback bundle
    // actually is — the build anyone recovering from it would get.
    previousInstalledCommit: previous.installedCommit ?? null,
    replacementCommit: prepared.targetCommit,
    rollbackBundle: previous.rollbackPath,
    rollbackDependencies: previous.rollbackDependencies,
    installedAt: previous.installedAt,
    appPath: config.appPath,
    stageDirectory: prepared.stageDirectory,
    rollbackPlacement: previous.rollbackPlacement,
    crossVolume: previous.crossVolume === true,
    ...(previous.crossVolumeReason ? { crossVolumeReason: previous.crossVolumeReason } : {}),
    candidateBundle: previous.candidatePath,
    candidateDependencies: previous.candidateDependencies,
    ...extra,
  };
}

async function readRollbackReceipt(receiptPath) {
  let receipt;
  try {
    receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch {
    return null;
  }
  if (!receipt || typeof receipt.rollbackBundle !== "string") return null;
  return { receiptPath, receipt };
}

async function listDirectory(path) {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

/**
 * Rollback generations are discovered through their receipts rather than by
 * globbing, so a bundle whose receipt is missing is reported instead of
 * deleted.  Both placements are covered: the cache directory this change
 * introduces and the adjacent hidden bundles earlier updates left behind.
 */
export async function rollbackGenerations(config, { stageDirectories = [] } = {}) {
  const applicationsDirectory = dirname(config.appPath);
  const bundleName = basename(config.appPath);
  const found = [];
  const orphans = [];
  const receiptPaths = [];
  const consider = async (bundlePath) => {
    const receiptPath = `${bundlePath}.json`;
    const [hasBundle, hasReceipt] = await Promise.all([exists(bundlePath), exists(receiptPath)]);
    if (hasReceipt) receiptPaths.push(receiptPath);
    else if (hasBundle) orphans.push(bundlePath);
  };
  for (const name of await listDirectory(applicationsDirectory)) {
    if (!name.startsWith(".BotFleet.rollback-") || !name.endsWith(".app")) continue;
    await consider(join(applicationsDirectory, name));
  }
  // A stage named with `--stage` need not sit under the updates root, so the
  // caller passes the stages it knows about as well.  Each stage's rollback
  // directory is scanned for bundles rather than assumed, so a run killed
  // between the first rename and its receipt leaves a reported orphan instead
  // of an invisible one.
  const stages = [...new Set([
    ...(await listDirectory(config.updatesDirectory)).map((name) => join(config.updatesDirectory, name)),
    ...stageDirectories.map((path) => resolve(path)),
  ])];
  for (const stage of stages) {
    const rollbackRoot = join(stage, "rollback");
    // The flat layout predates per-run generations; both are read.
    await consider(join(rollbackRoot, bundleName));
    for (const name of await listDirectory(rollbackRoot)) {
      if (name === bundleName || name === `${bundleName}.json`) continue;
      await consider(join(rollbackRoot, name, bundleName));
    }
  }
  for (const receiptPath of [...new Set(receiptPaths)]) {
    const generation = await readRollbackReceipt(receiptPath);
    if (generation) found.push(generation);
  }
  return { generations: found, orphans: [...new Set(orphans)] };
}

/**
 * One entry per stage directory under the updates root, with just enough to
 * decide whether it is leftover: whether it still carries a prepared manifest,
 * whether any rollback generation lives in it, and what else is inside.
 */
export async function stageEntries(config, generations = []) {
  const referencedStages = new Set();
  for (const item of generations) {
    if (typeof item.receipt?.stageDirectory === "string") referencedStages.add(resolve(item.receipt.stageDirectory));
    referencedStages.add(resolve(dirname(dirname(item.receiptPath))));
    referencedStages.add(resolve(dirname(dirname(dirname(item.receiptPath)))));
  }
  const entries = [];
  for (const name of await listDirectory(config.updatesDirectory)) {
    const path = join(config.updatesDirectory, name);
    let details;
    try {
      details = await lstat(path);
    } catch {
      continue;
    }
    if (!details.isDirectory() || details.isSymbolicLink()) continue;
    const names = await listDirectory(path);
    entries.push({
      name,
      path,
      names,
      mtimeMs: details.mtimeMs,
      hasPrepared: names.includes("prepared.json"),
      hasGeneration: generations.some((item) => resolve(item.receiptPath).startsWith(`${resolve(path)}${sep}`)),
    });
  }
  return { entries, referenced: [...referencedStages] };
}

function createConfig(parsed) {
  const home = homedir();
  return {
    checkout: resolve(process.env.BOTFLEET_CHECKOUT || join(home, "apps/botfleet-server")),
    appPath: resolve(process.env.BOTFLEET_APP_PATH || "/Applications/BotFleet.app"),
    dataDirectory: resolve(process.env.BOTFLEET_DATA_DIR || join(home, ".botfleet")),
    plist: resolve(process.env.BOTFLEET_LAUNCH_AGENT_PLIST || join(home, "Library/LaunchAgents/app.botfleet.server.plist")),
    customPlist: Boolean(process.env.BOTFLEET_LAUNCH_AGENT_PLIST),
    label: process.env.BOTFLEET_LAUNCH_AGENT_LABEL || "app.botfleet.server",
    legacyPlist: join(home, `Library/LaunchAgents/${LEGACY_LAUNCH_AGENT_LABEL}.plist`),
    legacyLabel: LEGACY_LAUNCH_AGENT_LABEL,
    domain: `gui/${process.getuid()}`,
    lockDirectory: resolve(process.env.BOTFLEET_UPDATE_LOCK || join(home, "Library/Caches/BotFleet/update.lock")),
    updatesDirectory: resolve(process.env.BOTFLEET_UPDATE_ROOT || join(home, "Library/Caches/BotFleet/updates")),
    ports: (process.env.BOTFLEET_UPDATE_PORTS || DEFAULT_PORTS.join(",")).split(",").map(Number),
    gracefulExitMs: Number(process.env.BOTFLEET_GRACEFUL_EXIT_MS || 20_000),
    termExitMs: Number(process.env.BOTFLEET_TERM_EXIT_MS || 20_000),
    startupTimeoutMs: Number(process.env.BOTFLEET_STARTUP_TIMEOUT_MS || 90_000),
    force: Boolean(parsed.force || process.env.BOTFLEET_FORCE === "1"),
    parsed,
  };
}

function createOperations(config) {
  let lastPreflight;
  const git = (cwd, args, options) => run("git", ["-C", cwd, ...args], options);
  const gitOutput = (cwd, args, options) => output("git", ["-C", cwd, ...args], options);

  const sweepCandidates = async (directory, prefix, suffix, keepNames, roots) => {
    const { stale, unrecognised } = staleCandidateNames(await listDirectory(directory), { prefix, suffix, keepNames });
    for (const name of stale) {
      const path = join(directory, name);
      if (!prunablePath(path, roots)) continue;
      await rm(path, { recursive: true, force: true });
      console.log(`Removed the abandoned update candidate ${path}`);
    }
    for (const name of unrecognised) {
      console.error(`Update candidate ${join(directory, name)} does not name an updater process; it was left in place for manual review.`);
    }
  };

  const pruneSuperseded = async (keepReceiptPath, prepared, previous) => {
    const stageDirectories = prepared?.stageDirectory ? [prepared.stageDirectory] : [];
    const roots = [
      dirname(config.appPath),
      dirname(config.checkout),
      config.updatesDirectory,
      ...stageDirectories.map((path) => resolve(path)),
    ];
    const { generations, orphans } = await rollbackGenerations(config, { stageDirectories });

    // Settle anything an interrupted run left at `installing` before choosing
    // what to keep, so a stranded receipt does not sit there forever.
    for (const item of reconcilableGenerations(generations, {
      appPath: config.appPath,
      installedCommit: previous?.installedCommit,
    })) {
      const settled = {
        ...item.receipt,
        status: "verified",
        verifiedAt: new Date().toISOString(),
        reconciled: `Settled by a later update: this receipt's replacement ${String(item.receipt.replacementCommit).slice(0, 12)} was the installed, health-verified build when that update began.`,
      };
      await atomicJson(item.receiptPath, settled);
      item.receipt = settled;
      console.log(`Settled the interrupted rollback receipt ${item.receiptPath} as verified.`);
    }

    if (keepReceiptPath && !generations.some((item) => item.receiptPath === keepReceiptPath)) {
      console.error(`Refusing to prune: the rollback generation just written (${keepReceiptPath}) was not among those discovered.`);
    } else {
      for (const item of rollbackGenerationsToPrune(generations, { appPath: config.appPath, keepReceiptPath })) {
        for (const path of [item.receipt.rollbackBundle, item.receipt.rollbackDependencies]) {
          if (!prunablePath(path, roots)) continue;
          await rm(path, { recursive: true, force: true });
        }
        await rm(item.receiptPath, { force: true });
        const prunedBuild = item.receipt.previousInstalledCommit || item.receipt.previousCommit || "unknown";
        console.log(`Pruned the superseded rollback copy of ${String(prunedBuild).slice(0, 12)} (${item.receipt.rollbackBundle})`);
      }
    }

    await sweepCandidates(
      dirname(config.appPath),
      CANDIDATE_BUNDLE_PREFIX,
      ".app",
      previous?.candidatePath ? [basename(previous.candidatePath)] : [],
      roots,
    );
    await sweepCandidates(
      dirname(config.checkout),
      CANDIDATE_DEPENDENCY_PREFIX,
      "",
      previous?.candidateDependencies ? [basename(previous.candidateDependencies)] : [],
      roots,
    );
    // A dependency tree set aside by a failed rollback carries the pid of the
    // updater that parked it, so the same rule applies: gone once that process
    // is.  These are large, and unlike a failed application bundle there is
    // nothing in one to examine.
    await sweepCandidates(dirname(config.checkout), FAILED_DEPENDENCY_PREFIX, "", [], roots);

    const { entries, referenced } = await stageEntries(config, generations);
    const stages = abandonedStages(entries, { referenced: [...referenced, ...stageDirectories.map((path) => resolve(path))] });
    for (const path of stages.prune) {
      if (!prunablePath(path, [config.updatesDirectory])) continue;
      await rm(path, { recursive: true, force: true });
      console.log(`Removed the leftover update stage ${path}`);
    }
    for (const path of stages.report) {
      console.error(`Update stage ${path} has no prepared manifest and no rollback generation, and holds files this updater did not write; it was left in place for manual review.`);
    }

    for (const orphan of orphans) {
      console.error(`Rollback bundle ${orphan} has no receipt; it was left in place for manual review.`);
    }
    for (const item of unclaimedGenerations(generations)) {
      console.error(`Rollback receipt ${item.receiptPath} names no installed application; it was left in place for manual review.`);
    }
    for (const name of failedInstallBundles(await listDirectory(dirname(config.appPath)), basename(config.appPath))) {
      console.error(`A previous update left ${join(dirname(config.appPath), name)} behind; it is evidence of that failure and was left in place for manual review.`);
    }
  };

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
        `-c.mac.identity=${BUILDER_SIGN_SELECTOR}`,
        "-c.mac.timestamp=none",
      ];
      try {
        await run("bash", args, {
          cwd: source.path,
          inherit: true,
          // This packages --arm64 --dir for the machine applying the update
          // (never --x64), so staging both cloudflared architectures here
          // downloads one only to discard it every run.  See
          // scripts/prepare-cloudflared.mjs's currentOnlyFromEnv().
          env: { CSC_IDENTITY_AUTO_DISCOVERY: "true", OMB_CLOUDFLARED_CURRENT: "1" },
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
        schemaVersion: PREPARED_SCHEMA_VERSION,
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

    fence: async () => fenceRuntimeAdmission(config),

    capturePrevious: async (prepared) => {
      const checkoutCommit = await gitOutput(config.checkout, ["rev-parse", "HEAD"]);
      const dirty = await gitOutput(config.checkout, ["status", "--porcelain"]);
      if (dirty) {
        // Name them.  An untracked directory left by an earlier failure blocks
        // every later update, and a refusal that does not say which path is at
        // fault gives the operator nothing to act on.
        throw new Error(`Live always-on checkout has changes; refusing update:\n${dirty}`);
      }
      if (!(await exists(config.appPath))) throw new Error(`Installed BotFleet app is missing: ${config.appPath}`);
      const liveDependencies = join(config.checkout, "node_modules");
      const dependencyDetails = await lstat(liveDependencies);
      if (!dependencyDetails.isDirectory() || dependencyDetails.isSymbolicLink()) {
        throw new Error(`Live dependency tree must be a real directory: ${liveDependencies}`);
      }
      const installedIdentity = await signatureIdentity(config.appPath, { allowLegacyBundleId: true });
      const installedCommit = await installedBuildCommit(config.appPath);
      const installedDependencyFingerprint = await dependencyFingerprint(liveDependencies);
      const [launchd, legacyLaunchd] = await Promise.all([
        run("launchctl", ["print", `${config.domain}/${config.label}`], { allowFailure: true }),
        run("launchctl", ["print", `${config.domain}/${config.legacyLabel}`], { allowFailure: true }),
      ]);
      // Every process inside the bundle, not only its main binary: the swap
      // renames the whole directory, so an embedded driver or helper app has
      // to be accounted for too.
      const appPids = await bundleProcessPids(config.appPath);
      const holders = await sqliteHolders(config.dataDirectory);
      const runtimePids = [...new Set([...(lastPreflight?.pids || []), lastPreflight?.pid, ...holders].filter(Number.isInteger))];
      const processCommands = {};
      const processCwds = {};
      for (const pid of new Set([...runtimePids, ...appPids])) {
        const command = await processCommand(pid);
        const cwd = await processCwd(pid);
        if (!isExpectedBotFleetProcess(command, cwd, config)) {
          throw new Error(`Process ${pid} owns BotFleet state but does not match an expected BotFleet executable and working directory`);
        }
        processCommands[pid] = command;
        processCwds[pid] = cwd;
      }
      const stamp = Date.now();
      const generation = `${stamp}-${checkoutCommit.slice(0, 12)}`;
      const rollback = await resolveRollbackPlacement({
        livePath: config.appPath,
        stageDirectory: prepared.stageDirectory,
        stageName: basename(config.appPath),
        generation,
        adjacentPath: join(dirname(config.appPath), `.BotFleet.rollback-${generation}.app`),
      });
      const rollbackDependencies = join(dirname(config.checkout), `.botfleet-server.node_modules.rollback-${generation}`);
      // Refuse here, before the interruption boundary, rather than at the
      // install step: after the boundary this refusal would run rollback(),
      // and rollback() restores whatever sits at the rollback path — which in
      // that case is an older generation, not this run's prior bundle.
      if (await exists(rollback.path)) {
        throw new Error(`Rollback path already exists before install: ${rollback.path}`);
      }
      if (await exists(rollbackDependencies)) {
        throw new Error(`Dependency rollback path already exists before install: ${rollbackDependencies}`);
      }
      return {
        checkoutCommit,
        installedIdentity,
        installedCommit,
        installedDependencyFingerprint,
        swap: {},
        launchdLoaded: launchd.code === 0,
        legacyLaunchdLoaded: legacyLaunchd.code === 0,
        appWasRunning: appPids.length > 0,
        runtimePids,
        appPids,
        processCommands,
        processCwds,
        rollbackPath: rollback.path,
        rollbackDirectory: rollback.directory,
        rollbackPlacement: rollback.placement,
        crossVolume: rollback.crossVolume,
        crossVolumeReason: rollback.crossVolumeReason,
        candidatePath: join(dirname(config.appPath), `${CANDIDATE_BUNDLE_PREFIX}${process.pid}-${stamp}.app`),
        rollbackDependencies,
        candidateDependencies: join(dirname(config.checkout), `${CANDIDATE_DEPENDENCY_PREFIX}${process.pid}-${stamp}`),
      };
    },

    materializeCandidate: async (prepared, previous) => {
      await rm(previous.candidatePath, { recursive: true, force: true });
      await run("ditto", [prepared.bundlePath, previous.candidatePath]);
      const identity = await validateBuiltBundle(previous.candidatePath, prepared.targetCommit);
      if (identity.designatedRequirement !== prepared.designatedRequirement ||
          !applicationIdentitiesCanTransition(previous.installedIdentity, identity)) {
        throw new Error("Candidate and installed app do not share an accepted signing identity");
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
      // BOTFLEET_LAUNCH_AGENT_LABEL may name the legacy label itself; the
      // deduplicated list boots each loaded label out exactly once.
      for (const label of quiesceBootoutLabels(config, previous)) {
        const stopped = await run("launchctl", ["bootout", `${config.domain}/${label}`], { allowFailure: true });
        if (stopped.code !== 0) throw new Error(`Could not boot out ${label} before install`);
      }
      await run("osascript", ["-e", 'if application "BotFleet" is running then tell application "BotFleet" to quit'], { allowFailure: true });
      const currentHolders = await sqliteHolders(config.dataDirectory);
      // Re-read the bundle's processes here rather than trusting the capture:
      // the embedded driver and the helper apps are started on demand, so one
      // can appear between the capture and the shutdown.
      const currentBundlePids = await bundleProcessPids(config.appPath);
      await terminateVerified(
        [...previous.runtimePids, ...previous.appPids, ...currentBundlePids, ...currentHolders],
        previous,
        config,
      );
    },

    assertQuiesced: async () => {
      const holders = await sqliteHolders(config.dataDirectory);
      if (holders.length) throw new Error(`BotFleet database still has ${holders.length} live holders after graceful shutdown`);
      // A process can hold no database handle and answer no port while still
      // running out of the installed bundle.  Renaming that bundle under it is
      // exactly what leaves the owner looking at a rollback name, so the swap
      // waits for the bundle to be empty of processes, not only for its state
      // — and that means the whole bundle: the main binary, the embedded
      // computer-use driver, and the speech and recorder helper apps.
      const appPids = await bundleProcessPids(config.appPath);
      if (appPids.length) {
        throw new Error(`BotFleet process ${appPids.join(", ")} still runs from inside ${config.appPath} after graceful shutdown`);
      }
      const health = await Promise.all(config.ports.map((port) => probeHealthWithRetry(port)));
      const portError = quiescedPortError(health);
      if (portError) throw new Error(portError);
    },

    advanceCheckout: async (targetCommit) => {
      await git(config.checkout, ["checkout", "--detach", targetCommit]);
      const head = await gitOutput(config.checkout, ["rev-parse", "HEAD"]);
      if (head !== targetCommit) throw new Error("Live checkout did not advance to the prepared commit");
    },

    installCandidate: async (prepared, previous) => {
      // capturePrevious already refused a pre-existing rollback path before the
      // boundary; this repeats the check because the window between them is
      // where a concurrent run would have to have raced the updater lock.
      if (await exists(previous.rollbackPath)) throw new Error(`Rollback path already exists: ${previous.rollbackPath}`);
      if (await exists(previous.rollbackDependencies)) throw new Error(`Dependency rollback path already exists: ${previous.rollbackDependencies}`);
      await mkdir(previous.rollbackDirectory, { recursive: true, mode: 0o700 });
      // Written before the first rename, so a run killed mid-swap leaves a
      // record naming which application the displaced bundle came from and
      // what commit it is, not just a directory somebody has to identify.
      previous.installedAt = new Date().toISOString();
      const receiptPath = `${previous.rollbackPath}.json`;
      await atomicJson(receiptPath, rollbackReceipt(prepared, previous, config, { status: "installing" }));
      const liveDependencies = join(config.checkout, "node_modules");
      await swapPreparedFiles({
        appPath: config.appPath,
        candidateApp: previous.candidatePath,
        rollbackApp: previous.rollbackPath,
        liveDependencies,
        candidateDependencies: previous.candidateDependencies,
        rollbackDependencies: previous.rollbackDependencies,
        progress: previous.swap,
      });
      await atomicJson(receiptPath, rollbackReceipt(prepared, previous, config, { status: "installing" }));
      await run("touch", [config.appPath]);
      const register = "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister";
      await run(register, ["-f", config.appPath], { allowFailure: true });
    },

    prepareCredentials: async (prepared) => {
      const receiptPath = credentialPreparationReceiptPath(prepared);
      await rm(receiptPath, { force: true });
      const executable = join(config.appPath, "Contents/MacOS/BotFleet");
      await run(executable, [`--prepare-update-credentials=${receiptPath}`]);
      await assertPrivateRegularFile(receiptPath, "Credential migration receipt");
      const receipt = await parseJsonFile(receiptPath, "Credential migration receipt");
      if (!validUpdateCredentialReceipt(receipt, prepared.targetCommit)) {
        throw new Error("Installed candidate did not prove durable credential marker preparation");
      }
    },

    startHarness: async (prepared, previous) => {
      const plist = harnessBootstrapPlist(config, {
        plistExists: await exists(config.plist),
        legacyPlistExists: await exists(config.legacyPlist),
      });
      if (plist === config.legacyPlist) {
        console.error(`LaunchAgent ${config.label} is not installed at ${config.plist} yet; bootstrapping the legacy ${config.legacyLabel} plist until the migration materializes it.`);
      }
      // Recorded before the bootstrap: a bootstrap that errors can still have
      // loaded the job, and rollback must boot out the label that is running.
      if (previous) previous.startedHarnessLabel = await startedHarnessLabel(config, plist);
      await run("launchctl", ["bootstrap", config.domain, plist]);
    },

    verifyHarness: async (prepared) => {
      const deadline = Date.now() + config.startupTimeoutMs;
      let snapshot;
      while (Date.now() < deadline) {
        snapshot = await runtimeIdentityPreflight(config, prepared);
        if (snapshot.safe) return;
        await sleep(500);
      }
      throw new Error(snapshot?.reason || "Updated harness did not prove its expected build and ownership before timeout");
    },

    startApplication: async (_prepared, previous, options) => {
      // open(1) activates an already-running instance of the bundle identifier
      // instead of launching a second one, so a survivor from the renamed
      // bundle would simply come forward under the rollback name.  Refuse
      // before opening anything and let the transaction roll back.
      const survivors = await bundleProcessPids(previous.rollbackPath);
      const survivingError = survivingRollbackProcessError(survivors, previous.rollbackPath);
      if (survivingError) throw new Error(survivingError);
      if (options.openApplication !== false) await run("open", [config.appPath]);
    },

    verifySingleOwner: async (prepared, previous) => {
      let firstAppPids = [];
      let secondAppPids = [];
      if (config.parsed.openApplication !== false) {
        await sleep(2_000);
        firstAppPids = await exactAppPids(config.appPath);
        await sleep(1_000);
        secondAppPids = await exactAppPids(config.appPath);
      }
      const appError = stableApplicationProcessError(
        firstAppPids,
        secondAppPids,
        config.parsed.openApplication !== false,
      );
      if (appError) throw new Error(appError);
      const snapshot = await runtimeIdentityPreflight(config, prepared);
      if (!snapshot.safe || snapshot.mode !== "authenticated") {
        throw new Error(snapshot.reason || "Updated application did not attach to the authenticated single data owner");
      }
      const attachmentError = applicationAttachmentError(snapshot, config.parsed.openApplication !== false);
      if (attachmentError) throw new Error(attachmentError);
      const survivors = await bundleProcessPids(previous.rollbackPath);
      const survivingError = survivingRollbackProcessError(survivors, previous.rollbackPath);
      if (survivingError) throw new Error(survivingError);
    },

    finish: async (prepared, previous) => {
      const receiptPath = `${previous.rollbackPath}.json`;
      await atomicJson(receiptPath, rollbackReceipt(prepared, previous, config, {
        status: "verified",
        verifiedAt: new Date().toISOString(),
      }));
      console.log(`Updated BotFleet to ${prepared.targetCommit.slice(0, 12)}.`);
      console.log(`Recoverable prior bundle: ${previous.rollbackPath}`);
      console.log(`Recoverable prior dependency tree: ${previous.rollbackDependencies}`);
      console.log(`Recoverable prior checkout commit: ${previous.checkoutCommit}`);
      if (previous.rollbackPlacement === "adjacent") {
        console.log(`The prior bundle stayed beside the installed app: ${previous.crossVolumeReason}`);
      }
      // The update is verified, so everything older than this generation is
      // now dead weight.  A prune failure is reported but never fails a good
      // install: the new bundle is already running.
      try {
        await pruneSuperseded(receiptPath, prepared, previous);
      } catch (error) {
        console.error(`Could not prune superseded BotFleet rollback copies: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    rollback: async (prepared, previous, originalError) => {
      const [holders, appPids, health] = await Promise.all([
        sqliteHolders(config.dataDirectory),
        bundleProcessPids(config.appPath),
        Promise.all(config.ports.map(probeHealth)),
      ]);
      const runtimePids = health.filter((item) => item.kind === "botfleet").map((item) => item.pid);
      const runningPids = [...new Set([...holders, ...appPids, ...runtimePids])];
      let readiness = { safe: true };
      if (runningPids.length) {
        try {
          readiness = await fenceRuntimeAdmission(config);
        } catch (error) {
          readiness = { safe: false, reason: error instanceof Error ? error.message : String(error) };
        }
      }
      const refusal = rollbackReadinessError(runningPids.length, readiness);
      if (refusal) {
        const receiptPath = pendingRecoveryReceiptPath(prepared);
        try {
          await atomicJson(receiptPath, {
            schemaVersion: 1,
            status: "pending-recovery",
            reason: refusal,
            updateError: originalError instanceof Error ? originalError.message : String(originalError),
            replacementCommit: prepared.targetCommit,
            previousCommit: previous.checkoutCommit,
            installedApp: config.appPath,
            rollbackBundle: previous.rollbackPath,
            rollbackPlacement: previous.rollbackPlacement,
            liveDependencies: join(config.checkout, "node_modules"),
            rollbackDependencies: previous.rollbackDependencies,
            candidateBundle: previous.candidatePath,
            candidateDependencies: previous.candidateDependencies,
            rollbackBundleHoldsPriorCopy: previous.swap?.rollbackAppHolds === true,
            rollbackDependenciesHoldPriorCopy: previous.swap?.rollbackDependenciesHold === true,
            liveCheckout: config.checkout,
            runningPids,
            observedAt: new Date().toISOString(),
          });
        } catch (receiptError) {
          throw new AggregateError(
            [new Error(refusal), receiptError],
            "Replacement may own active work; rollback was deferred and its recovery receipt could not be written",
          );
        }
        throw new Error(`Replacement may own active work; rollback was deferred without interrupting it.  Recovery receipt: ${receiptPath}`);
      }

      const stopErrors = [];
      const recordStop = async (operation) => {
        try { await operation(); } catch (error) { stopErrors.push(error); }
      };
      for (const label of rollbackHarnessBootoutLabels(config, previous)) {
        await recordStop(async () => {
          await run("launchctl", ["bootout", `${config.domain}/${label}`], { allowFailure: true });
          // bootout exits nonzero when the job was already gone, so its exit
          // code cannot separate "removed" from "failed".  Confirm the job
          // is absent before any file moves, or its KeepAlive can relaunch
          // the failed replacement over the restore.
          if (!(await waitForLaunchdBootout(config.domain, label))) {
            throw new Error(`Could not boot out ${label} for rollback: ${config.domain}/${label} is still loaded`);
          }
        });
      }
      await recordStop(async () => { await run("osascript", ["-e", 'if application "BotFleet" is running then tell application "BotFleet" to quit'], { allowFailure: true }); });
      await recordStop(async () => {
        const holders = await sqliteHolders(config.dataDirectory);
        const appPids = await bundleProcessPids(config.appPath);
        await terminateVerified([...holders, ...appPids], { ...previous, runtimePids: [...new Set([...previous.runtimePids, ...holders])] }, config);
      });
      await recordStop(async () => {
        const [holders, bundlePids, health, owner] = await Promise.all([
          sqliteHolders(config.dataDirectory),
          bundleProcessPids(config.appPath),
          Promise.all(config.ports.map((port) => probeHealthWithRetry(port))),
          readOwner(config.dataDirectory).catch(() => null),
        ]);
        const stranger = health.filter((item) => item.kind === "foreign" || item.kind === "http");
        if (stranger.length) {
          console.error(`Something other than BotFleet answers port ${stranger.map((item) => item.port).join(", ")}; rollback is not waiting on it.`);
        }
        const owned = ownedRuntimePids({ holders, bundlePids, health, ownerPid: owner?.pid });
        if (owned.length) {
          throw new Error(`Rollback cannot mutate files while BotFleet process ${owned.join(", ")} still owns its bundle, database, or health endpoint`);
        }
      });
      if (stopErrors.length) throw new AggregateError(stopErrors, "Could not quiesce the failed replacement for safe rollback");

      const errors = [];
      const record = async (operation) => {
        try { await operation(); } catch (error) { errors.push(error); }
      };
      // Restore only from copies THIS run put at the rollback paths.  A bundle
      // that was already sitting there belongs to an older generation, and
      // promoting it over the installed app would silently downgrade the Mac
      // by two releases instead of undoing one failed install.
      await record(async () => {
        const liveDependencies = join(config.checkout, "node_modules");
        if (previous.swap?.rollbackDependenciesHold && await exists(previous.rollbackDependencies)) {
          if (await exists(liveDependencies)) {
            // Beside the checkout, never inside it.  `.gitignore` covers
            // `node_modules` exactly, so a sibling named `node_modules.failed-…`
            // is untracked, and the dirty-checkout guard would then refuse
            // every later update until somebody found and removed it.
            const setAside = join(dirname(config.checkout), `${FAILED_DEPENDENCY_PREFIX}${process.pid}-${Date.now()}`);
            await rename(liveDependencies, setAside);
            console.error(`The failed replacement's dependency tree was set aside at ${setAside}`);
          }
          await rename(previous.rollbackDependencies, liveDependencies);
          previous.swap.rollbackDependenciesHold = false;
        }
      });
      await record(async () => {
        if (previous.swap?.rollbackAppHolds && await exists(previous.rollbackPath)) {
          if (await exists(config.appPath)) await rename(config.appPath, `${config.appPath}.failed-${Date.now()}`);
          await rename(previous.rollbackPath, config.appPath);
          previous.swap.rollbackAppHolds = false;
        }
      });
      await record(async () => { await git(config.checkout, ["checkout", "--detach", previous.checkoutCommit]); });
      await record(async () => { await rm(previous.candidatePath, { recursive: true, force: true }); });
      await record(async () => { await rm(previous.candidateDependencies, { recursive: true, force: true }); });
      // The receipt describes two copies, the bundle and the dependency tree,
      // so it may only go when neither is still parked at a rollback path.
      // Each restore clears its own flag on success; a dependency restore that
      // throws leaves its flag set even though the bundle restore afterwards
      // succeeds, and that tree is then the only copy there is.  Deleting the
      // receipt is right when both flags are clear: either both copies were
      // restored, or the swap failed on its first rename and neither ever left
      // its place, which the provisional receipt cannot know when it is written.
      await record(async () => {
        if (previous.swap?.rollbackAppHolds || previous.swap?.rollbackDependenciesHold) return;
        await rm(`${previous.rollbackPath}.json`, { force: true });
      });
      await record(async () => {
        const head = await gitOutput(config.checkout, ["rev-parse", "HEAD"]);
        if (head !== previous.checkoutCommit) throw new Error("Rollback did not restore the prior checkout commit");
        const identity = await signatureIdentity(config.appPath, {
          allowLegacyBundleId: previous.installedIdentity.bundleIdentifier === LEGACY_BUNDLE_ID,
        });
        if (identity.designatedRequirement !== previous.installedIdentity.designatedRequirement) {
          throw new Error("Rollback did not restore the prior application identity");
        }
        const fingerprint = await dependencyFingerprint(join(config.checkout, "node_modules"));
        if (fingerprint !== previous.installedDependencyFingerprint) {
          throw new Error("Rollback did not restore the prior dependency tree");
        }
      });
      if (errors.length) throw new AggregateError(errors, "One or more rollback file restorations failed");

      const rollbackPlistExists = await exists(config.plist);
      const rollbackHarnessPlists = rollbackHarnessBootstrapPlists(config, previous, {
        plistExists: rollbackPlistExists,
        legacyPlistExists: await exists(config.legacyPlist),
        plistLabel: config.customPlist && rollbackPlistExists ? await launchAgentPlistLabel(config.plist) : null,
      });
      for (const plist of rollbackHarnessPlists) {
        await record(async () => { await run("launchctl", ["bootstrap", config.domain, plist]); });
      }
      if (previous.appWasRunning) await record(async () => { await run("open", [config.appPath]); });
      if (previous.launchdLoaded || previous.legacyLaunchdLoaded || previous.appWasRunning) await record(async () => {
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
  if (manifest?.schemaVersion !== PREPARED_SCHEMA_VERSION || !/^[a-f0-9]{40}$/.test(manifest?.sourceCommit || "") ||
      manifest?.teamIdentifier !== EXPECTED_TEAM_ID ||
      (manifest?.bundleIdentifier !== EXPECTED_BUNDLE_ID && manifest?.bundleIdentifier !== LEGACY_BUNDLE_ID) ||
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

/**
 * Has this run already finished?
 *
 * The second of two guards against a relaunch loop.  `launchctl submit` keeps
 * a job ALIVE ON FAILURE, so every non-zero exit is relaunched by launchd —
 * and a deterministic failure is then retried forever, each attempt staging
 * another full copy of the source.  The harness removes the label as soon as
 * it sees a run settle (`server/update-control.ts`), but a relaunch can race
 * that removal, so the relaunched process asks the progress record it was
 * pointed at whether this run id is already over.  A different run id is a
 * different run and says nothing about this one.
 */
export function settledRunOutcome(record, runId) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if (!runId || record.runId !== runId) return null;
  if (typeof record.finishedAt !== "string" || !record.finishedAt) return null;
  if (typeof record.outcome !== "string" || !record.outcome) return null;
  return { outcome: record.outcome, message: typeof record.message === "string" ? record.message : "" };
}

/** The progress record on disk, or null for anything unreadable or torn.  A
 * record nobody can parse is not evidence that the run finished. */
async function readProgressRecord(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
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
  // Before anything is created, touched or locked: a relaunch of a run that
  // already has an outcome does nothing at all and exits 0, which is also
  // what tells launchd to stop relaunching it.
  if (parsed.progress && parsed.runId) {
    const settled = settledRunOutcome(await readProgressRecord(parsed.progress), parsed.runId);
    if (settled) {
      console.log(
        `Update run ${parsed.runId} already finished as ${settled.outcome}; this relaunch is doing nothing.${
          settled.message ? `  ${settled.message}` : ""}`,
      );
      return;
    }
  }
  const config = createConfig(parsed);
  if (parsed.command === "unquiesce") {
    const lock = await acquireDirectoryLock(config.lockDirectory, "unquiesce");
    try {
      await releaseRuntimeAdmission(config);
    } finally {
      await lock.release();
    }
    console.log("Released the BotFleet runtime admission fence.");
    return;
  }
  const bare = createOperations(config);
  // The detached run is the only kind the desktop app and the phone can
  // start, and neither can be its parent — so a progress file is the whole
  // channel.  Instrumenting the adapter keeps the coordinator untouched.
  // Creating the recorder writes that file once, and throws if it cannot:
  // the channel is proven here, before `perform` touches anything, because an
  // install nobody can report on is worse than an install that never ran.
  const progress = parsed.progress
    ? createUpdateProgress({
        path: parsed.progress,
        runId: parsed.runId || randomUUID(),
        command: parsed.command,
        target: parsed.target,
      })
    : null;
  const operations = progress ? instrumentOperations(bare, progress) : bare;
  const perform = async () => {
    if (parsed.command === "prepare") return prepareUpdate(parsed, operations);
    if (parsed.command === "apply") {
      return applyPreparedUpdate(await loadPrepared(parsed.stage), parsed, operations);
    }
    return runUpdate(parsed, parsed, operations);
  };
  if (!progress) {
    await perform();
    return;
  }
  try {
    await perform();
    progress.finish("verified", parsed.command === "prepare"
      ? "The update was prepared."
      : "The update installed and verified.");
  } catch (error) {
    progress.finish(
      outcomeForError(error, { rolledBack: progress.record.rolledBack }),
      outcomeMessage(error),
    );
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(`BotFleet update failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}


