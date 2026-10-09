#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
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
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPreparedUpdate, prepareUpdate, runUpdate } from "./mac-update-transaction.mjs";
import {
  createUpdateProgress,
  instrumentOperations,
  outcomeForError,
  outcomeMessage,
} from "./update-progress.mjs";
import { validUpdateCredentialReceipt } from "../electron/update-credential-preparation.mjs";
import { stageIsPrunable } from "./stage-entries.mjs";
import {
  downloadBuiltBundle,
  ResolutionError,
  updateSourcePolicy,
} from "./ci-build-resolver.mjs";

const EXPECTED_TEAM_ID = "CC8UTF7ATG";
// Transition release: main still BUILDS com.botfleet.app (LEGACY_BUNDLE_ID).
// This updater also accepts the renamed app.botfleet.macos candidate so that,
// once this commit is the checkout every Mac runs its updater from, the NEXT
// update (the bundle rename) can be applied by this code.  Candidates stay
// restricted to these two IDs; see applicationIdentitiesCanTransition().  The
// rename PR drops legacy candidates and keeps legacy only as a predecessor.
const EXPECTED_BUNDLE_ID = "app.botfleet.macos";
const LEGACY_BUNDLE_ID = "com.botfleet.app";
export const SAFE_STORAGE_EXPORT_FLAG = "--export-safe-storage-migration";
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
    else if (arg === "--grace") parsed.graceMs = graceSeconds(requiredValue(arg, args.shift()));
    else if (arg.startsWith("--grace=")) parsed.graceMs = graceSeconds(requiredValue("--grace", arg.slice("--grace=".length)));
    else if (arg === "--wait-for-idle") {
      // The minutes are optional: a bare flag waits the default window.
      parsed.waitForIdleMs = /^\d+(\.\d+)?$/.test(args[0] ?? "") ? idleMinutes(args.shift()) : DEFAULT_WAIT_FOR_IDLE_MS;
    }
    else if (arg.startsWith("--wait-for-idle=")) {
      parsed.waitForIdleMs = idleMinutes(requiredValue("--wait-for-idle", arg.slice("--wait-for-idle=".length)));
    }
    else if (arg === "--force" || arg === "-f") parsed.force = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (command === "apply" && !parsed.stage) throw new Error("apply requires --stage <directory>");
  if (command === "unquiesce" && (parsed.target !== "origin/main" || parsed.source || parsed.stage || parsed.bundle ||
      parsed.dependencies || parsed.openApplication === false || parsed.progress || parsed.runId ||
      parsed.graceMs !== undefined || parsed.waitForIdleMs !== undefined)) {
    throw new Error("unquiesce accepts no options");
  }
  if (parsed.force && parsed.waitForIdleMs !== undefined) {
    throw new Error("--force and --wait-for-idle ask for opposite things; pass one");
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

/** `--grace` is in seconds: how long work in flight gets before it is paused. */
function graceSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600) {
    throw new Error("--grace must be a number of seconds from 0 to 600");
  }
  return Math.round(seconds * 1_000);
}

/** `--wait-for-idle` is in minutes, because a person types it. */
function idleMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 360) {
    throw new Error("--wait-for-idle must be a number of minutes above 0 and at most 360");
  }
  return Math.round(minutes * 60_000);
}

function usage() {
  return `Usage:
  update-botfleet-mac.mjs update  [--target REF] [--source PATH] [--stage PATH] [--no-open]
                              [--grace SECONDS | --wait-for-idle [MINUTES] | --force]
  update-botfleet-mac.mjs prepare [--target REF] [--source PATH] [--stage PATH]
                              [--bundle PATH --dependencies PATH]
  update-botfleet-mac.mjs apply   --stage PATH [--no-open]
                              [--grace SECONDS | --wait-for-idle [MINUTES] | --force]
  update-botfleet-mac.mjs unquiesce

Any of update/prepare/apply also accepts --progress PATH [--run-id ID], which records each
step and the final outcome to a JSON file a detached caller can read while the run is going.

prepare builds and validates without touching the live checkout, installed app, or processes.
An existing exact-source build can be imported with --bundle and --dependencies.
apply installs one prepared stage, verifies exact runtime identity, and rolls the prior bundle and
checkout back if any install or startup step fails.
unquiesce is the authenticated recovery action if the updater exits after fencing admission but before shutdown.

Busy bots never block an update.  Before it stops anything, apply asks BotFleet to hold new work
(new turns, routine and webhook runs, job wakes) and gives the work already running a short grace
to finish on its own: 60 seconds, or --grace SECONDS (BOTFLEET_UPDATE_GRACE_MS).  Whatever is
still running then is interrupted, saved to pending-update-resume.json and resumed after the
update.  Held work is queued, never dropped: it runs after the restart.  The one thing that is
never interrupted is a live room turn, because a room turn cannot be resumed without repeating
it; apply waits up to 5 more minutes for rooms to go quiet (BOTFLEET_UPDATE_ROOM_WAIT_MS), and
then lets everything go and stops without updating.

A process that is not BotFleet but holds BotFleet's files or ports (a bot's own sqlite3, node or
curl) is never signalled.  apply waits up to 90 seconds for it to let go
(BOTFLEET_UNKNOWN_HOLDER_WAIT_MS), and names its executable if it is still there after that.

--wait-for-idle [MINUTES] never interrupts anything.  It waits for the work already running to
finish, 20 minutes unless MINUTES says otherwise, and if bots are still busy when the time runs
out, everything held runs now and the update stops without changing anything.

--force (-f, or BOTFLEET_FORCE=1) skips the grace and interrupts at once, and also reinstalls when
the checkout is already current.  Interrupted work is saved to pending-update-resume.json and
resumed after the update.  A live room turn still refuses it.`;
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
export function staleCandidateNames(names, { prefix, suffix = "", keepNames = [], isAlive = processExists } = {}) {
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
// The allowlist lives in scripts/stage-entries.mjs because
// server/update-control.ts sweeps with the same rules, and two copies of it
// already drifted once — which leaked a full copy of the app and a
// multi-gigabyte dependency tree on every update.
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
    if (stale && stageIsPrunable(entry.names)) prune.push(entry.path);
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
      if (Number.isInteger(owner?.pid) && await processIsAlive(owner.pid)) {
        throw new Error(`Another BotFleet update is running (pid ${owner.pid}, phase ${owner.mode || "unknown"})`);
      }
      if (attempt > 0) throw new Error(`Could not recover stale updater lock ${path}`);
      await rename(path, `${path}.stale-${Date.now()}`);
    }
  }
  throw new Error(`Could not acquire updater lock ${path}`);
}

/**
 * The raw signal-0 probe.  ESRCH is the only proof of absence: EPERM means the
 * pid exists and belongs to someone else.  A zombie still has a pid, so this
 * answers true for one; processIsAlive below is the check that knows better.
 */
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

/**
 * A `ps` state column that begins with Z names a zombie: the process has
 * exited and only its pid and exit status remain, waiting for a parent that
 * never reaped it.  On 2026-10-08 a long-running grok CLI left two of
 * BotFleet's bundled `cua-driver` processes in that state, `kill -0` kept
 * answering success for them, and every apply refused to go on with "BotFleet
 * did not exit after graceful quit and SIGTERM ... refusing SIGKILL".
 */
export function isZombieState(state) {
  return String(state ?? "").trim().startsWith("Z");
}

/**
 * The `ps` state column for every pid in one spawn, as a Map of pid to state.
 * `ps` exits nonzero when some listed pid has gone but still prints the rest,
 * so the rows are read whatever the exit code says.  A pid with no row is
 * simply absent from the map.
 */
export async function processStates(pids) {
  const states = new Map();
  if (!pids.length) return states;
  const result = await run("ps", ["-o", "pid=,stat=", "-p", pids.join(",")], { allowFailure: true });
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\S+)$/);
    if (match) states.set(Number(match[1]), match[2]);
  }
  return states;
}

/**
 * The pids in `pids` that are still running.  Every place the updater asks
 * "does anything still hold BotFleet state" goes through this, so a zombie is
 * never captured, waited on, signalled, or reported as a survivor.  A zombie
 * holds no files, no ports and no database handle, so it can never hold
 * BotFleet state, and no signal can make it exit sooner (only its parent
 * reaping it can).
 *
 * `kill -0` runs first (ESRCH is the proof of absence), then ONE `ps` spawn
 * reads the state of everything left, so a poll over N pids costs one spawn,
 * not N.  This fails toward alive: a pid with no `ps` row, or a `ps` that
 * fails, proves nothing, and reading that as "exited" would let the swap
 * proceed under a live process.  Only a state beginning with Z says exited.
 * (A `ps` that hangs blocks this check, as it blocks processCommand; run()
 * has no timeout.)
 *
 * A caller may inject `isAlive`, synchronous or asynchronous.  The verdicts
 * are awaited together because a Promise is always truthy and cannot be
 * filtered on directly.
 */
export async function withoutExitedPids(pids, { isAlive, exists = processExists, statesOf = processStates } = {}) {
  if (isAlive) {
    const verdicts = await Promise.all(pids.map((pid) => isAlive(pid)));
    return pids.filter((_, index) => verdicts[index]);
  }
  const present = pids.filter((pid) => exists(pid));
  if (!present.length) return [];
  let states;
  try {
    states = await statesOf(present);
  } catch {
    return present;
  }
  return present.filter((pid) => !isZombieState(states.get(pid)));
}

/** Is this one pid still running?  See withoutExitedPids; a zombie is not. */
export async function processIsAlive(pid, options) {
  return (await withoutExitedPids([pid], options)).length === 1;
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

async function probeHealth(port, { timeoutMs = 3_000 } = {}) {
  const result = await requestJson(`http://127.0.0.1:${port}/api/health`, { accept: [200], timeoutMs });
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
  // lsof lists open files, which a zombie no longer has, so this filter is
  // belt and braces: a zombie reported here would hold the database "open"
  // forever and no signal could ever close it.
  return withoutExitedPids([...new Set(result.stdout.split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger))]);
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
  const probe = (port) => probeHealth(port, options.timeoutMs ? { timeoutMs: options.timeoutMs } : undefined);
  return healthTopologyResult(await Promise.all(ports.map(probe)), options);
}

/** A loaded Mac (load average in the hundreds) answers, just slowly: the
 *  preflight reads wait this long for each answer instead of three seconds. */
const PATIENT_REQUEST_MS = 10_000;

const OWNER_KEYS = ["version", "pid", "port", "nonce"];

/**
 * Strict on the unknown-key case as well as the field cases, so a record
 * carrying anything beyond the four documented fields is refused rather than
 * partially believed.  The updater is the one module in this directory that
 * imports nothing from node_modules — only node: builtins and two sibling
 * project modules — because it has to run while the app, the checkout and the
 * stage's own dependency tree are all in flux, and it installs that tree
 * itself.  It therefore cannot take a schema package at this trust boundary.
 */
function validOwner(owner) {
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) return false;
  if (Object.keys(owner).some((key) => !OWNER_KEYS.includes(key))) return false;
  return owner.version === 1 && Number.isInteger(owner.pid) && owner.pid > 0 &&
    Number.isInteger(owner.port) && owner.port > 0 && owner.port <= 65535 &&
    typeof owner.nonce === "string" && /^[a-f0-9]{64}$/.test(owner.nonce);
}

/**
 * Classify the owner record instead of collapsing it to a boolean.  "No record"
 * and "a record naming a process that is gone" are different operator problems:
 * the first is a machine that has never adopted this build, the second is a
 * harness that crashed or was booted out.  Both used to answer null, so the
 * caller reported the second as a first adoption and named a manual procedure
 * that does not apply to it.
 */
async function ownerRecordState(dataDirectory) {
  const path = join(dataDirectory, "harness-owner.json");
  let owner;
  try {
    await assertPrivateRegularFile(path, "Harness owner record");
    owner = JSON.parse(await readFile(path, "utf8"));
    if (!validOwner(owner)) throw new Error("Harness owner record is invalid");
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "absent" };
    throw error;
  }
  if (!(await processIsAlive(owner.pid))) return { state: "stale", owner };
  return { state: "live", owner };
}

async function readOwner(dataDirectory) {
  const { state, owner } = await ownerRecordState(dataDirectory);
  return state === "live" ? owner : null;
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

/** The topology reason a port that timed out produces: on a loaded Mac that
 *  is a slow harness, not a wrong one, and worth asking again. */
const TOPOLOGY_UNAVAILABLE = /unavailable or ambiguous/;

async function strictRuntimePreflight(config, expectedBuild, { requireIdle }) {
  const { state, owner } = await ownerRecordState(config.dataDirectory);
  // A record naming a dead pid is a stopped or crashed harness, not an
  // unadopted one.  Say which it is, so the operator restarts the app instead
  // of looking for a first-adoption procedure that does not exist.
  //
  // Descriptive only, deliberately.  This reason is shared with
  // runtimeIdentityPreflight, and applyPreparedUpdate starts the harness and
  // then polls it, so a dead pid is the expected state on the first poll
  // before the new one has written its own record.  An imperative here would
  // tell the operator to start the app at the exact moment the updater had
  // already started it, and would contradict the caller's own failure text
  // ("Updated harness did not prove its expected build").
  if (state === "stale") {
    return { safe: false, reason: `BotFleet harness (pid ${owner.pid}) is not running` };
  }
  if (state !== "live") return null;
  const response = await requestJson(`http://127.0.0.1:${owner.port}/api/runtime`, {
    headers: { Authorization: `Bearer ${owner.nonce}` },
    accept: [200],
    timeoutMs: PATIENT_REQUEST_MS,
  });
  if (response.kind === "http" && response.status === 404) return null;
  // `transient` marks the answers a slow harness gives: no answer at all, or
  // a health port that timed out.  runtimePreflight asks again for those.
  if (response.kind !== "ok") {
    return { safe: false, transient: true, reason: "Authenticated runtime readiness could not be verified" };
  }
  const runtime = response.body;
  const identityError = authenticatedRuntimeError(runtime, owner, expectedBuild, { requireIdle });
  if (identityError) return { safe: false, reason: identityError };
  const topology = await healthTopology(config.ports, { timeoutMs: PATIENT_REQUEST_MS });
  if (!topology.safe || topology.pid !== owner.pid) {
    return {
      safe: false,
      transient: TOPOLOGY_UNAVAILABLE.test(topology.reason || ""),
      reason: topology.reason || "Health endpoints do not share the authenticated runtime owner",
    };
  }
  // A bot's own `sqlite3` or `node` holding the database for a moment is
  // waited out, never signalled, and named if it stays (finding 5).
  const settled = await settledDatabaseHolders(config, owner.pid, { report: config.reportDetail });
  if (!settled.holders) return { safe: false, reason: settled.reason };
  const holders = settled.holders;
  if (holders.length !== 1 || holders[0] !== owner.pid) {
    return { safe: false, reason: `Database ownership is ambiguous (${holders.length} live holders)` };
  }
  return { safe: true, mode: "authenticated", pid: owner.pid, port: owner.port, runtime, holders, health: topology.health };
}

/** How long a preflight keeps asking a harness that does not answer. */
export const DEFAULT_PREFLIGHT_RETRY_MS = 60_000;

/**
 * Ask again while the answer is only "too slow to tell", with backoff, inside
 * a bounded window.  A loaded Mac (load average in the hundreds) can miss a
 * three-second request now and then, and one missed request used to abort the
 * whole apply.  A definitive answer — wrong identity, two database holders,
 * no harness — returns at once, and so does the last attempt in the window.
 */
export async function retryTransient(attempt, {
  windowMs = DEFAULT_PREFLIGHT_RETRY_MS,
  now = Date.now,
  wait = sleep,
  firstDelayMs = 1_000,
  maxDelayMs = 10_000,
} = {}) {
  const deadline = now() + Math.max(0, windowMs);
  let delay = firstDelayMs;
  for (;;) {
    const result = await attempt();
    const remaining = deadline - now();
    if (!result?.transient || remaining <= 0) return result;
    await wait(Math.min(delay, remaining));
    delay = Math.min(maxDelayMs, delay * 2);
  }
}

/** The non-interrupting mode: zero, or how long `--wait-for-idle` waits. */
function waitForIdleFor(config) {
  const value = config?.waitForIdleMs;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function forcedRun(config) {
  return Boolean(config?.force || process.env.BOTFLEET_FORCE === "1");
}

/** How the fence step treats work in flight.  See `usage()`.  `now` is one
 *  plain ask with no hold and no grace (a rollback under --wait-for-idle). */
export function fenceMode(config) {
  if (config?.fenceNow === "force") return "force";
  if (config?.fenceNow === "idle") return "now";
  if (forcedRun(config)) return "force";
  return waitForIdleFor(config) > 0 ? "wait-for-idle" : "grace";
}

/**
 * The fence a rollback takes on the replacement: at once, never the hold,
 * grace and pause cycle an update runs.  A replacement that failed its checks
 * should not keep its work waiting 60 seconds before it is paused, and under
 * --wait-for-idle it could otherwise wait hours.  So the forced quiesce runs
 * straight away (the replacement's work is saved and the restored build
 * resumes it) — except under --wait-for-idle, the opt-in that never
 * interrupts: there it asks once, and a busy replacement defers the rollback
 * with a recovery receipt rather than being interrupted.
 */
export function rollbackFenceConfig(config) {
  return { ...config, fenceNow: waitForIdleFor(config) > 0 ? "idle" : "force" };
}

export async function runtimePreflight(config, expectedBuild, adapters = {}) {
  // Work in flight is never a reason to stop here: the fence step decides
  // what happens to it.  What this checks is that the harness is the one this
  // Mac owns, and a harness too slow to say so is asked again.
  const strict = await retryTransient(
    () => (adapters.strictPreflight ?? strictRuntimePreflight)(config, expectedBuild, { requireIdle: false }),
    {
      windowMs: Number.isFinite(config?.preflightRetryMs) ? config.preflightRetryMs : DEFAULT_PREFLIGHT_RETRY_MS,
      now: adapters.now,
      wait: adapters.sleep,
    },
  );
  if (strict) return strict;
  return { safe: false, reason: "Runtime does not expose complete authenticated readiness; manual first adoption is required" };
}

async function runtimeIdentityPreflight(config, expectedBuild) {
  const strict = await strictRuntimePreflight(config, expectedBuild, { requireIdle: false });
  return strict || { safe: false, reason: "Expected build does not expose authenticated runtime identity" };
}

/** How long running work gets to finish on its own before it is paused. */
export const DEFAULT_GRACE_MS = 60_000;
/** How long `--wait-for-idle` waits when no minutes are given. */
export const DEFAULT_WAIT_FOR_IDLE_MS = 20 * 60_000;
/** After the grace, how long the updater keeps trying to pause work that the
 *  harness will not interrupt — a live room turn — before it gives up. */
export const DEFAULT_ROOM_WAIT_MS = 5 * 60_000;
const DEFAULT_DRAIN_POLL_MS = 5_000;
/** Between two forced attempts the harness refused for something other than
 *  a room turn: each one interrupts and resumes, so they are spaced out. */
const FORCE_RETRY_MS = 30_000;
/** A forced quiesce interrupts every busy bot and waits up to 15 s for them
 *  to settle, so its answer can take a while on a loaded Mac. */
const FORCED_QUIESCE_TIMEOUT_MS = 90_000;
const QUIESCE_TIMEOUT_MS = 20_000;
/** How long the hold keeps polling a harness that has stopped answering. */
const DRAIN_SILENCE_LIMIT_MS = 60_000;

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/** "20 minutes", "1 minute", "45 seconds": a window as a person says it. */
export function describeWindow(ms) {
  if (ms >= 60_000 && ms % 60_000 === 0) return plural(ms / 60_000, "minute");
  if (ms >= 60_000) return plural(Math.round(ms / 6_000) / 10, "minute");
  return plural(Math.max(1, Math.round(ms / 1_000)), "second");
}

/** The refusal `--wait-for-idle` ends with when bots stay busy. */
export function waitForIdleTimeoutMessage(ms) {
  return `Bots were still busy after ${describeWindow(ms)}; nothing was interrupted.  `
    + "Try again later, or run without --wait-for-idle to pause and resume them.";
}

/** The refusal the default mode ends with when work would not pause.  The
 *  one known cause is a room conversation, which is never interrupted. */
export function pauseTimeoutMessage(ms, runtime) {
  const rooms = Number.isInteger(runtime?.drain?.rooms) ? runtime.drain.rooms : 0;
  if (rooms > 0) {
    return `A room conversation was still running after ${describeWindow(ms)}, and a room turn cannot be paused `
      + "without repeating it, so the update did not start.  Nothing was interrupted.  Try again when the room is quiet.";
  }
  return `BotFleet could not pause its work within ${describeWindow(ms)}, so the update did not start.  `
    + "Anything it paused was resumed.  Try again in a few minutes.";
}

/** What the update is waiting for, for the progress record and the terminal.
 *  `runtime` is a `/api/runtime` or quiesce answer: a drain-capable harness
 *  reports `drain`, an older one only `activeWorkCount`. */
export function drainProgressDetail(runtime, phase = "wait") {
  const drain = runtime?.drain;
  const bots = Number.isInteger(drain?.bots) ? drain.bots : 0;
  const rooms = Number.isInteger(drain?.rooms) ? drain.rooms : 0;
  const inFlight = Number.isInteger(drain?.inFlight) ? drain.inFlight
    : Number.isInteger(runtime?.activeWorkCount) ? runtime.activeWorkCount : null;
  if (phase === "pause") {
    if (rooms > 0) return `Waiting for ${plural(rooms, "room conversation")} to finish`;
    return bots > 0 ? `Pausing ${plural(bots, "bot")} to resume after the update` : "Pausing work to resume after the update";
  }
  if (bots > 0) return `Waiting for ${plural(bots, "bot")} to finish`;
  if (inFlight !== null && inFlight > 0) return `Waiting for ${plural(inFlight, "operation")} to finish`;
  return "Waiting for work in flight to finish";
}

/**
 * Whether a runtime answer shows a fence this run may use: up, and settled.
 *
 * A forced quiesce still interrupting and saving work can still roll back, so
 * a fence is only usable once the harness says it settled (`fencing: false`).
 * The harness installed before this updater never reports `fencing`, and it
 * raises `quiescing` BEFORE it starts interrupting, so for it the only proof
 * of a settled fence is the work count itself: nothing in flight.  One rule
 * for every path that can meet a fence — a forced answer, a second forced
 * ask, and a fence discovered after an answer was lost.
 */
export function fenceUsable(body) {
  if (body?.quiescing !== true) return false;
  if (body.fencing === false) return true;
  if (body.fencing === true) return false;
  return body.safeToRestart === true && body.activeWorkCount === 0;
}

/** Whether a runtime answer shows a forced quiesce still interrupting and
 *  saving work: the opposite of a settled fence, for a fence that is up. */
export function fenceStillSettling(body) {
  return body?.quiescing === true && !fenceUsable(body);
}

/** A fenced quiesce answer this run may use. */
function runtimeQuiesced(response) {
  return response?.kind === "ok" && response.status === 200 && fenceUsable(response.body);
}

const STOPPED_HOLDING = "BotFleet stopped holding new work before the update could start; nothing was interrupted.  Try again.";

/** How long the harness keeps a fence this run took without hearing from it
 *  (server/index.ts `armFenceLease`).  Long enough for a loaded Mac to miss a
 *  few renewals; short enough that an updater killed between the fence and
 *  the shutdown does not leave every bot refused for long. */
export const FENCE_LEASE_MS = 3 * 60_000;
/** How often this run renews it, from the fence until the harness is gone. */
export const FENCE_LEASE_RENEW_MS = 20_000;
const LEASE_QUERY = `leaseMs=${FENCE_LEASE_MS}`;

/**
 * SIGINT and SIGTERM, watched for the whole fence step: the hold, every
 * request (one that fences after the signal arrived included), the pause,
 * and the checks after the fence.  A signal anywhere in that window lifts
 * what this run took — hold, fence, or a forced quiesce still settling — and
 * ends the run with a refusal, instead of killing the updater with BotFleet
 * fenced until someone runs `unquiesce`.  A listener replaces Node's default
 * exit for these signals, which is why the run must end by returning: every
 * path out of the step checks `stoppedBy`.
 */
export function watchStopSignals(signals) {
  let stoppedBy = null;
  const wakers = new Set();
  const listeners = ["SIGINT", "SIGTERM"].map((signal) => {
    const listener = () => {
      stoppedBy ??= signal;
      for (const wake of [...wakers]) wake();
    };
    signals?.on?.(signal, listener);
    return [signal, listener];
  });
  return {
    get stoppedBy() {
      return stoppedBy;
    },
    /** `sleepFor`, cut short by a signal. */
    sleeper(sleepFor) {
      return (ms) => new Promise((resolve) => {
        if (stoppedBy) return resolve();
        const wake = () => {
          wakers.delete(wake);
          resolve();
        };
        wakers.add(wake);
        sleepFor(ms).then(wake, wake);
      });
    },
    dispose() {
      for (const [signal, listener] of listeners) signals?.off?.(signal, listener);
    },
  };
}

/**
 * Keep the fence's lease alive from the moment this run holds the fence until
 * it lets go or the harness that holds it is gone: refused, restarted (a new
 * nonce), or the fence down.  Renews at once, which also arms a lease the
 * fence answer did not carry.  Runs past the fence step on purpose: the
 * harness lives on through `quiesce` until bootout or SIGTERM reaches it, and
 * an updater killed in between must not leave it fenced.  Only ever started
 * on a harness that reports `lease`: one that predates it would read the
 * renewal as a plain quiesce.  `stop()` waits for a renewal in flight, so a
 * release that follows can never be overtaken by one.
 */
export function keepFenceLease(owner, {
  request = requestJson,
  leaseMs = FENCE_LEASE_MS,
  everyMs = FENCE_LEASE_RENEW_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const url = `http://127.0.0.1:${owner.port}/api/runtime/quiesce?renew=1&leaseMs=${leaseMs}`;
  const headers = { Authorization: `Bearer ${owner.nonce}` };
  let stopped = false;
  let timer = null;
  let inFlight = Promise.resolve();
  let renewals = 0;
  const renew = () => {
    timer = null;
    if (stopped) return;
    renewals += 1;
    inFlight = Promise.resolve()
      .then(() => request(url, { method: "POST", headers, accept: [200], timeoutMs: QUIESCE_TIMEOUT_MS }))
      .then((answer) => {
        const gone = answer.kind === "http" || answer.kind === "none" ||
          (answer.kind === "ok" && (answer.body?.pid !== owner.pid || answer.body?.quiescing !== true));
        if (gone) stopped = true;
      }, () => {})
      .finally(() => {
        if (stopped) return;
        timer = setTimer(renew, everyMs);
        timer?.unref?.();
      });
  };
  renew();
  return {
    get active() {
      return !stopped;
    },
    get renewals() {
      return renewals;
    },
    async stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
      await inFlight;
    },
  };
}

/**
 * Hold new work, give the work in flight its window, then take the fence.
 *
 * Resolves `{ ok: true, response, forced }` with the fenced quiesce answer,
 * or `{ ok: false, reason }` having released whatever it held.  Every way
 * out that is not a fence lifts the hold: the window closing, a signal, a
 * harness that stops answering.  The harness's own lease is the backstop for
 * an updater killed outright (server/update-drain.ts).
 *
 * `grace` (the default): work in flight gets `windowMs` to finish on its own;
 * whatever is still running is then paused with the forced quiesce, saved to
 * pending-update-resume.json and resumed after the restart.  The forced path
 * still will not interrupt a live room turn, so for up to `roomWaitMs` more
 * the updater waits for rooms to go quiet and asks again.
 *
 * `wait-for-idle`: the opt-in that never interrupts.  When `windowMs` runs
 * out with bots still busy, it lets everything go and refuses.
 *
 * A harness that predates drains answers the first request as a plain
 * quiesce, fenced when idle and refused when busy, with no `draining` field.
 * That is the first update to carry this code, so it is not an error: the
 * wait retries the plain fence, and the grace mode then forces as before.
 */
async function holdAndFence(config, owner, deps) {
  const { request, now, pause: sleepFor, report, releaseAdmission, stop, mode, windowMs, roomWaitMs, pollMs } = deps;
  const base = `http://127.0.0.1:${owner.port}`;
  const headers = { Authorization: `Bearer ${owner.nonce}` };
  const quiesce = (query = "", timeoutMs = QUIESCE_TIMEOUT_MS) => request(`${base}/api/runtime/quiesce${query}`, {
    method: "POST",
    headers,
    accept: [200, 409],
    timeoutMs,
  });
  // Every request that can raise the fence asks for its lease.
  const fenceQuiesce = () => quiesce(`?${LEASE_QUERY}`);
  let forcedYet = false;
  const forceQuiesce = () => {
    forcedYet = true;
    return quiesce(`?force=true&${LEASE_QUERY}`, FORCED_QUIESCE_TIMEOUT_MS);
  };
  const pause = stop.sleeper(sleepFor);
  // A signal: lift whatever this run may hold — the hold, a fence an answer
  // raised after the signal arrived, or a forced quiesce still settling
  // (the release waits for it) — and end the run.
  const stopped = async () => {
    const reason = `Stopped by ${stop.stoppedBy} before the update started; `
      + (forcedYet ? "anything paused was resumed." : "nothing was interrupted.");
    try {
      await releaseAdmission(config);
      return { ok: false, reason };
    } catch (error) {
      return {
        ok: false,
        reason: `${reason}  Releasing BotFleet also failed; run update-botfleet.sh unquiesce: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
  const waitDeadline = now() + windowMs;
  const finalDeadline = mode === "grace" ? waitDeadline + roomWaitMs : waitDeadline;
  // The harness holds a little past the updater's whole window, so its lease
  // never runs out under a run that is still deciding.
  const first = await retryTransient(async () => {
    const answer = await quiesce(`?drain=1&timeoutMs=${Math.max(1_000, finalDeadline - now())}`);
    return { ...answer, transient: answer.kind === "unavailable" && !stop.stoppedBy };
  }, { windowMs: DRAIN_SILENCE_LIMIT_MS, now, wait: pause });
  if (stop.stoppedBy) return stopped();
  if (first.kind !== "ok") {
    // The harness may have started holding and only the answer was lost:
    // let go of whatever it holds rather than leave automations waiting on a
    // lease nobody will collect.
    const reason = "Runtime admission fence could not be established";
    try {
      await releaseAdmission(config);
      return { ok: false, reason };
    } catch {
      return { ok: false, reason: `${reason}.  If BotFleet is holding new work, run update-botfleet.sh unquiesce.` };
    }
  }
  if (runtimeQuiesced(first)) return { ok: true, response: first, forced: false };
  const draining = first.body?.draining === true;
  let holding = draining;
  const release = async (reason) => {
    if (!holding) return { ok: false, reason };
    try {
      await releaseAdmission(config);
      holding = false;
      return { ok: false, reason };
    } catch (error) {
      return {
        ok: false,
        reason: `${reason}  Releasing the held work also failed; run update-botfleet.sh unquiesce: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };

  {
    let last = first.body;
    let phase = "wait";
    let silentSince = null;
    let nextForceAt = 0;
    let lastDetail = null;
    for (;;) {
      if (stop.stoppedBy) return stopped();
      if (phase === "wait" && draining && last?.draining === true && last.drain?.inFlight === 0) {
        // Nothing in flight: ask for the fence.  Work can land between the
        // poll and this request; the harness then keeps holding and answers
        // 409, and this simply goes round again.
        const fenced = await fenceQuiesce();
        // A signal that arrived while this was in flight wins over the fence.
        if (stop.stoppedBy) return stopped();
        if (runtimeQuiesced(fenced)) {
          holding = false;
          return { ok: true, response: fenced, forced: false };
        }
        if (fenced.kind === "ok") last = fenced.body;
        if (fenced.kind === "ok" && fenced.body?.draining !== true) {
          holding = false;
          return { ok: false, reason: STOPPED_HOLDING };
        }
      }
      if (phase === "wait" && now() >= waitDeadline) {
        if (mode !== "grace") return release(waitForIdleTimeoutMessage(windowMs));
        phase = "pause";
      }
      if (phase === "pause") {
        const rooms = Number.isInteger(last?.drain?.rooms) ? last.drain.rooms : 0;
        // A live room turn refuses the forced quiesce without touching
        // anything, so asking while one runs only costs a request; an older
        // harness cannot say, so it is simply asked.
        // Never a second forced ask while the first is still fencing.
        if (rooms === 0 && now() >= nextForceAt && last?.fencing !== true) {
          const forced = await forceQuiesce();
          if (stop.stoppedBy) return stopped();
          if (runtimeQuiesced(forced)) {
            holding = false;
            return { ok: true, response: forced, forced: true };
          }
          if (forced.kind === "ok") {
            last = forced.body;
            // A refusal with no room turn interrupted and resumed work; do
            // not churn through that again straight away.
            if (!(Number.isInteger(last?.drain?.rooms) && last.drain.rooms > 0)) nextForceAt = now() + FORCE_RETRY_MS;
          } else {
            // No answer in time.  The harness may still be fencing; the next
            // ask either collects the fence or is refused, so just go round.
            nextForceAt = now() + pollMs;
          }
        }
        if (now() >= finalDeadline) return release(pauseTimeoutMessage(windowMs + roomWaitMs, last));
      }
      const detail = drainProgressDetail(last, phase);
      if (detail !== lastDetail) {
        lastDetail = detail;
        report(detail);
      }
      const deadline = phase === "wait" ? waitDeadline : finalDeadline;
      await pause(Math.max(0, Math.min(pollMs, deadline - now())));
      if (stop.stoppedBy) continue;
      if (!draining) {
        // An older harness: nothing is held, so there is nothing to poll.
        // While waiting, retry the plain fence for an idle moment; the pause
        // phase above asks for the forced one itself.
        if (phase === "wait") {
          const retried = await fenceQuiesce();
          if (stop.stoppedBy) return stopped();
          if (runtimeQuiesced(retried)) return { ok: true, response: retried, forced: false };
          if (retried.kind === "ok") last = retried.body;
        }
        continue;
      }
      const polled = await request(`${base}/api/runtime`, { headers, accept: [200], timeoutMs: QUIESCE_TIMEOUT_MS });
      if (stop.stoppedBy) return stopped();
      if (polled.kind !== "ok") {
        silentSince ??= now();
        if (now() - silentSince >= DRAIN_SILENCE_LIMIT_MS) {
          return release("BotFleet stopped answering while the update waited for bots to finish; nothing was interrupted.");
        }
        continue;
      }
      silentSince = null;
      if (polled.body?.pid !== owner.pid) {
        holding = false;
        return { ok: false, reason: STOPPED_HOLDING };
      }
      if (polled.body?.quiescing === true) {
        // An ask whose answer timed out on this side landed on that one.  A
        // forced fence still interrupting and saving work is not usable yet
        // (it can still roll back), so wait for it to settle; a settled one
        // is this run's fence (`fenceUsable`).  Only a harness that says it
        // settled skips the idle check: it raises the fence idle, or having
        // saved what it interrupted.
        if (!fenceUsable(polled.body)) {
          last = polled.body;
          continue;
        }
        holding = false;
        return { ok: true, response: { kind: "ok", status: 200, body: polled.body }, forced: polled.body.fencing === false };
      }
      if (polled.body?.draining !== true) {
        // The lease ran out, something released it, or the harness restarted.
        // Whatever it held is running again, so there is nothing to release.
        holding = false;
        return { ok: false, reason: STOPPED_HOLDING };
      }
      last = polled.body;
    }
  }
}

/**
 * `--force`: one forced quiesce, watched to its end.  A forced quiesce can take
 * a while (it interrupts every busy bot and waits for them to settle), and on a
 * loaded Mac its answer can miss the timeout while the harness carries on.
 * Asking again would only be told "already fencing", so the runtime is read
 * until the fence settles one way or the other.  Resolves the settled answer,
 * or `{ kind: "unavailable" }` when it never could tell.
 */
async function forceFence(owner, { request, now, wait, pollMs, stop }) {
  const base = `http://127.0.0.1:${owner.port}`;
  const headers = { Authorization: `Bearer ${owner.nonce}` };
  const answer = await request(`${base}/api/runtime/quiesce?force=true&${LEASE_QUERY}`, {
    method: "POST",
    headers,
    accept: [200, 409],
    timeoutMs: FORCED_QUIESCE_TIMEOUT_MS,
  });
  // A signal that arrived while the forced quiesce ran wins over its fence.
  if (stop?.stoppedBy) return { kind: "stopped" };
  if (runtimeQuiesced(answer)) return answer;
  if (answer.kind === "ok" && answer.body?.quiescing !== true) return answer;
  const deadline = now() + FORCED_QUIESCE_TIMEOUT_MS;
  const interval = Number.isFinite(pollMs) && pollMs > 0 ? pollMs : DEFAULT_DRAIN_POLL_MS;
  while (now() < deadline) {
    await wait(Math.min(interval, Math.max(0, deadline - now())));
    if (stop?.stoppedBy) return { kind: "stopped" };
    const polled = await request(`${base}/api/runtime`, { headers, accept: [200], timeoutMs: QUIESCE_TIMEOUT_MS });
    if (stop?.stoppedBy) return { kind: "stopped" };
    if (polled.kind !== "ok" || polled.body?.pid !== owner.pid) continue;
    if (polled.body?.fencing === true) continue;
    // No fence: the forced quiesce rolled itself back (or never started).
    if (polled.body?.quiescing !== true) return { kind: "ok", status: 409, body: polled.body };
    // A fence is only collected once it is settled: the harness says so, or
    // (one that predates `fencing`) nothing is left in flight.  The installed
    // harness raises its fence before it interrupts anything, so a fence seen
    // with work still counted may yet roll back.
    if (fenceUsable(polled.body)) return { kind: "ok", status: 200, body: polled.body };
  }
  return { kind: "unavailable", reason: "forced quiesce did not settle" };
}

export async function fenceRuntimeAdmission(config, adapters = {}) {
  const readRuntimeOwner = adapters.readOwner ?? readOwner;
  const request = adapters.requestJson ?? requestJson;
  const inspectTopology = adapters.healthTopology ?? healthTopology;
  const inspectHolders = adapters.sqliteHolders ?? sqliteHolders;
  const now = adapters.now ?? Date.now;
  const wait = adapters.sleep ?? sleep;
  const releaseAdmission = adapters.releaseRuntimeAdmission ??
    ((cfg) => releaseRuntimeAdmission(cfg, { readOwner: readRuntimeOwner, requestJson: request, now, sleep: wait }));
  const owner = await readRuntimeOwner(config.dataDirectory);
  if (!owner) return { safe: false, reason: "Authenticated runtime owner is unavailable for the admission fence" };
  // One watcher for the whole fenced window (finding 6): from the first ask to
  // the last check after the fence.  Handed back to Node's default the moment
  // this step returns, by which time the run either holds a leased fence or
  // has let go of everything.
  const stop = watchStopSignals(adapters.signals === undefined ? process : adapters.signals);
  try {
    return await fenceWithin(config, owner, {
      request, inspectTopology, inspectHolders, now, wait, releaseAdmission, stop, adapters,
    });
  } finally {
    stop.dispose();
  }
}

async function fenceWithin(config, owner, { request, inspectTopology, inspectHolders, now, wait, releaseAdmission, stop, adapters }) {
  const pause = stop.sleeper(wait);
  const mode = fenceMode(config);
  const stopReason = (what) => `Stopped by ${stop.stoppedBy} before the update started; ${what}`;
  let response;
  let forced = mode === "force";
  if (mode === "force" || mode === "now") {
    response = mode === "force"
      ? await forceFence(owner, { request, now, wait: pause, pollMs: config?.drainPollMs, stop })
      : await request(`http://127.0.0.1:${owner.port}/api/runtime/quiesce?${LEASE_QUERY}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${owner.nonce}` },
        accept: [200, 409],
        timeoutMs: QUIESCE_TIMEOUT_MS,
      });
    if (stop.stoppedBy || response.kind !== "ok") {
      // A signal, or no answer and the harness may be fenced: never leave it
      // that way.  The release waits for a forced quiesce still settling.
      const reason = stop.stoppedBy
        ? stopReason(mode === "force" ? "the fence was released and anything paused was resumed." : "nothing was interrupted.")
        : "Runtime admission fence could not be established";
      try {
        await releaseAdmission(config);
        return { safe: false, reason };
      } catch {
        return { safe: false, reason: `${reason}${stop.stoppedBy ? "" : "."}  If BotFleet is fenced, run update-botfleet.sh unquiesce.` };
      }
    }
  } else {
    const atLeastZero = (value, fallback) => (Number.isFinite(value) && value >= 0 ? value : fallback);
    const held = await holdAndFence(config, owner, {
      request,
      releaseAdmission,
      mode,
      windowMs: mode === "grace" ? atLeastZero(config?.graceMs, DEFAULT_GRACE_MS) : waitForIdleFor(config),
      roomWaitMs: atLeastZero(config?.roomWaitMs, DEFAULT_ROOM_WAIT_MS),
      pollMs: Number.isFinite(config?.drainPollMs) && config.drainPollMs > 0 ? config.drainPollMs : DEFAULT_DRAIN_POLL_MS,
      now,
      pause: wait,
      report: adapters.report ?? config?.reportDetail ?? (() => {}),
      stop,
    });
    if (!held.ok) return { safe: false, reason: held.reason };
    response = held.response;
    forced = held.forced;
  }
  if (response.kind !== "ok") return { safe: false, reason: "Runtime admission fence could not be established" };
  const runtime = response.body;
  const fenceHeld = response.status === 200 && runtime?.quiescing === true;
  // The fence's lease, renewed from now until this run lets go or the harness
  // is gone.  Only a harness that reports `lease` gets renewals.
  const lease = fenceHeld && runtime && Object.hasOwn(runtime, "lease")
    ? keepFenceLease(owner, { request, setTimer: adapters.setTimer, clearTimer: adapters.clearTimer })
    : null;
  const refuseAfterFence = async (reason) => {
    await lease?.stop();
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
  const stoppedAfterFence = () => refuseAfterFence(stopReason("the fence was released and anything paused was resumed."));
  if (stop.stoppedBy) return stoppedAfterFence();
  // A fence taken without forcing must be idle on the harness's own terms;
  // a forced one has interrupted and saved whatever was running.
  const identityError = authenticatedRuntimeError(runtime, owner, undefined, { requireIdle: !forced });
  if (identityError || !fenceHeld) {
    return refuseAfterFence(identityError || "Runtime refused the admission fence because work is active");
  }
  let topology;
  let settled;
  try {
    [topology, settled] = await Promise.all([
      retryTransient(async () => {
        const result = await inspectTopology(config.ports);
        return { ...result, transient: !stop.stoppedBy && !result.safe && TOPOLOGY_UNAVAILABLE.test(result.reason || "") };
      }, { windowMs: 30_000, now, wait: pause }),
      // A bot's own tool holding the database for a moment is waited out,
      // never signalled, and named if it stays (finding 5).
      settledDatabaseHolders(config, owner.pid, {
        inspect: inspectHolders,
        identify: adapters.processIdentity ?? {},
        now,
        wait: pause,
        report: adapters.report ?? config?.reportDetail,
        stopped: () => Boolean(stop.stoppedBy),
      }),
    ]);
  } catch {
    if (stop.stoppedBy) return stoppedAfterFence();
    return refuseAfterFence("Runtime ownership could not be verified after the admission fence");
  }
  if (stop.stoppedBy) return stoppedAfterFence();
  if (!topology.safe || topology.pid !== owner.pid) {
    return refuseAfterFence(topology.reason || "Health endpoints do not share the fenced runtime owner");
  }
  if (!settled.holders) return refuseAfterFence(settled.reason);
  const holders = settled.holders;
  if (holders.length !== 1 || holders[0] !== owner.pid) {
    return refuseAfterFence(`Database ownership is ambiguous after admission fence (${holders.length} live holders)`);
  }
  return { safe: true, mode: "authenticated", pid: owner.pid, port: owner.port, runtime, holders, health: topology.health, lease };
}

/** How long a release waits for a forced quiesce the harness says is settling. */
const RELEASE_SETTLE_MS = FORCED_QUIESCE_TIMEOUT_MS;
/** How long it waits on a harness that predates `fencing` and still counts
 *  work under its fence: it may be interrupting, or rolling back. */
const LEGACY_RELEASE_SETTLE_MS = 30_000;
const RELEASE_POLL_MS = 1_000;

/**
 * Stand the fence down, or lift the hold, and confirm it.
 *
 * Never while a forced quiesce is still settling: a release that lands
 * mid-settle used to stand the fence down under it, so its resume snapshot
 * and held messages landed on an unfenced harness — bots latched stopped,
 * cancelled routine runs left cancelled, held sends waiting for a restart
 * that was not coming.  So this waits for the settle first (bounded), and a
 * harness that still defers the release (`releasePending`) is watched until
 * it has honoured it.  Every caller gets the wait: a hold given up on, a
 * fence refused after its checks, the `--force` give-up, and `unquiesce`.
 */
export async function releaseRuntimeAdmission(config, adapters = {}) {
  const readRuntimeOwner = adapters.readOwner ?? readOwner;
  const request = adapters.requestJson ?? requestJson;
  const now = adapters.now ?? Date.now;
  const wait = adapters.sleep ?? sleep;
  const owner = await readRuntimeOwner(config.dataDirectory);
  if (!owner) throw new Error("Authenticated runtime owner is unavailable for admission recovery");
  const base = `http://127.0.0.1:${owner.port}`;
  const headers = { Authorization: `Bearer ${owner.nonce}` };
  const read = () => request(`${base}/api/runtime`, { headers, accept: [200], timeoutMs: QUIESCE_TIMEOUT_MS });
  /** Poll while `still` holds, up to a window chosen from the first answer.
   *  Resolves the last answer read, or null when none came. */
  const watch = async (still, windowFor) => {
    let deadline = null;
    let last = null;
    for (;;) {
      const answer = await read();
      if (answer.kind !== "ok") {
        // A harness too slow to say: the release itself retries, so go on.
        if (deadline === null) return last;
      } else {
        last = answer.body;
        if (!still(answer.body)) return answer.body;
        deadline ??= now() + windowFor(answer.body);
      }
      if (now() >= deadline) return last;
      await wait(Math.min(RELEASE_POLL_MS, Math.max(0, deadline - now())));
    }
  };
  const settleWindow = (body) => (body?.fencing === true ? RELEASE_SETTLE_MS : LEGACY_RELEASE_SETTLE_MS);
  await watch(fenceStillSettling, settleWindow);
  // Releasing is the one request that must not be lost to a slow harness:
  // a fence or a hold left behind keeps every bot on this Mac waiting.
  const response = await retryTransient(async () => {
    const answer = await request(`${base}/api/runtime/quiesce`, {
      method: "DELETE",
      headers,
      accept: [200],
      timeoutMs: QUIESCE_TIMEOUT_MS,
    });
    return { ...answer, transient: answer.kind === "unavailable" };
  }, { windowMs: 30_000, now, wait });
  let body = response.kind === "ok" ? response.body : null;
  if (body && (body.releasePending === true || body.fencing === true)) {
    // Still settling after all: the harness keeps the release and honours it
    // the moment the forced quiesce settles.  Watch it land.
    body = await watch(
      (current) => current?.quiescing !== false || current?.draining === true || current?.fencing === true,
      () => RELEASE_SETTLE_MS,
    );
  }
  if (body?.quiescing !== false || body?.draining === true) {
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

export function shouldExportSafeStorageBeforeRename(installedBundleId, candidateBundleId) {
  return installedBundleId === LEGACY_BUNDLE_ID && candidateBundleId === EXPECTED_BUNDLE_ID;
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

// ---------------------------------------------------------------------------
// Pre-activation smoke test.
//
// validateBuiltBundle above reads files: it proves the bytes are signed, from
// the expected team, and stamped with the expected commit.  None of that proves
// the artifact runs.  0.1.24 shipped a server that passed every one of those
// checks and died on every launch with ERR_MODULE_NOT_FOUND, because tsc
// leaves bare imports verbatim and the packaged tree carries no node_modules.
// The hosted release pipeline has caught that class of bug since
// (scripts/smoke-packaged-server.mjs), but only for artifacts GitHub built.
// A candidate downloaded from a CI build, imported from a stage, or produced
// by a local fallback has had no equivalent gate on this Mac.
//
// So mirror MCode's validatePrefixPackage here: before the stage is published
// or anything live is touched, actually run the candidate — boot the packaged
// server with no node_modules in reach, wait for real readiness, and prove the
// native SQLite binding initializes.  Three properties, deliberately, because
// a busy Mac produces timeouts and a timeout must never be reported as a
// corrupt artifact.  That mistake shipped twice on this machine already (see
// scripts/native-version-probe.mjs); the classifier below exists so the same
// mistake cannot ship a third time here.
// ---------------------------------------------------------------------------

// Generous on purpose.  prepare runs on the owner's Mac, often while five to
// ten agent seats are compiling; the Sep 17 and Oct 1 outages were both a
// healthy binary plus a starved CPU.  One retry on timeout only — a genuinely
// bad artifact fails identically a second later, so retrying it would only
// delay the real error, and a missing file cannot become present by waiting.
// Not a lesson learned here: fleet recall ("busy host update timeout
// classified as corrupt artifact not a failure", 2026-10-04) returns the Oct 1
// cloudflared probe incident (PR #780, board fd1736f8) and an open board sweep
// for six more short-timeout probes with the same failure.  This is the third
// place that mistake has been paid for.
const SMOKE_BOOT_TIMEOUT_MS = 180_000;
const SMOKE_BOOT_ATTEMPTS = 2;
const SMOKE_SQLITE_TIMEOUT_MS = 60_000;
const SMOKE_HEALTH_REQUEST_TIMEOUT_MS = 3_000;
const SMOKE_OUTPUT_EXCERPT = 2_000;
// What we hold, versus what we show.  Generous enough to keep a full stack trace
// and a boot log, small enough that two failed attempts cannot exhaust memory.
const SMOKE_OUTPUT_CAPTURE = 256 * 1024;

export function smokeTestEnabled(env = process.env) {
  const value = (env.BOTFLEET_UPDATE_SMOKE ?? "").trim().toLowerCase();
  return !(value === "0" || value === "off" || value === "false" || value === "no");
}

/**
 * Turn a failed boot into a cause a human can act on.  The distinction that
 * matters most is "this artifact is broken" versus "this Mac was too busy to
 * finish the probe" — the two look identical to a naive boolean and call for
 * opposite responses, so they must never collapse into one value.  A child
 * still alive with no readiness and no exit is the busy case by elimination,
 * so the default has to be the busy case rather than an unlabelled unknown.
 */
/**
 * Decide readiness from an untrusted response body, strictly.
 *
 * `body?.ready !== false` treats a truncated body, an HTML error page, and a
 * bare `{}` as ready, because every one of them is "not false".  This is a
 * hand-written shape check rather than zod for a structural reason: the updater
 * bootstraps itself by archiving a five-file graph into a temp directory with no
 * node_modules beside it, so it cannot import a third-party validator at all.
 * Every other module in that graph imports nothing but node: builtins.  The rule
 * being satisfied is "never read a field off an untrusted response without
 * checking its shape" — adding zod here would break updater bootstrap on every
 * Mac, which is a far worse failure than a longer predicate.
 */
/* oxlint-disable anti-slop/no-runtime-typeof -- hand-written health body boundary parse; zod is unavailable in the updater bootstrap graph (see comment above). */
export function parseHealthBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  // The health contract is an object with an explicit boolean `ready` and an app
  // name.  Anything else is not a health response we recognise.
  if (typeof body.ready !== "boolean" || typeof body.app !== "string") return false;
  return body.ready;
}
/* oxlint-enable anti-slop/no-runtime-typeof */

export function classifySmokeFailure({ exitCode, signal, spawnError, spawnTimedOut } = {}) {
  if (spawnError) return "spawn-failed";
  if (spawnTimedOut) return "sqlite-probe-timed-out";
  if (exitCode !== null && exitCode !== undefined) return "server-exited";
  if (signal) return `server-killed-${signal}`;
  return "server-never-ready";
}

const SMOKE_CAUSES = {
  "spawn-failed": "could not be started",
  "server-exited": "exited during boot",
  "server-never-ready": "never reported ready",
  "sqlite-probe-timed-out": "timed out initializing its native SQLite binding",
  "sqlite-unavailable": "could not initialize its native SQLite binding",
  "owner-mismatch": "wrote an owner record naming a different process",
};

export function smokeFailureMessage({ cause, exitCode, signal, spawnError, targetCommit, output, bundlePath: _bundlePath }) {
  const summary = SMOKE_CAUSES[cause] || cause;
  const detail = [];
  if (exitCode !== null && exitCode !== undefined) detail.push(`exit=${exitCode}`);
  if (signal) detail.push(`signal=${signal}`);
  if (spawnError) detail.push(`spawn=${spawnError}`);
  detail.push(`commit=${targetCommit?.slice(0, 12) || "unknown"}`);
  const excerpt = (output || "").trim().slice(-SMOKE_OUTPUT_EXCERPT);
  const headline = `Staged BotFleet candidate ${summary} (${detail.join(", ")}); nothing was installed.`;
  if (cause === "server-never-ready" || cause === "sqlite-probe-timed-out") {
    return `${headline}  This Mac may simply have been too busy to finish the probe — re-run when it is quieter before treating the build as bad.${excerpt ? `\n--- candidate output ---\n${excerpt}` : ""}`;
  }
  return `${headline}${excerpt ? `\n--- candidate output ---\n${excerpt}` : ""}`;
}

/**
 * `run` has no timeout, and a probe that can hang forever is worse than no
 * probe at all — it would strand the updater lock.  Bound it explicitly and
 * report a timeout as its own outcome rather than as a non-zero exit, for the
 * same reason the boot classifier has a distinct "too busy" cause.
 */
function runBounded(command, args, { cwd, env, timeoutMs, maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd,
      // A probe this runs must not inherit the updater's real environment.
      // It writes a probe file and, in the SQLite case, touches HOME and the
      // Sentry/OMB variables; a smoke test that can reach the owner's real
      // state, or ship the owner's real telemetry under the updater's key, is
      // not a smoke test.  PATH is carried because the probe needs node; the
    // rest of the ambient environment is not.
      env: env ? { PATH: process.env.PATH, ...env } : { PATH: process.env.PATH },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    // Capped, unlike the sibling helpers' absence of a cap elsewhere: a command
    // that writes without bound would grow these strings until the updater
    // itself ran out of memory, which is a worse outcome than a truncated
    // diagnostic.  `overflow` is reported so the caller can tell a truncated
    // capture from a short one.
    let overflow = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const append = (which, chunk) => {
      if (overflow) return;
      if (stdout.length + stderr.length + chunk.length > maxBytes) {
        overflow = true;
        stdout = stdout.slice(0, Math.max(0, maxBytes - stderr.length));
        stderr = stderr.slice(0, Math.max(0, maxBytes - stdout.length));
        child.kill("SIGKILL");
        return;
      }
      if (which === "out") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on("data", (chunk) => append("out", chunk));
    child.stderr.on("data", (chunk) => append("err", chunk));
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolveRun({ code: null, signal: "SIGKILL", stdout, stderr, timedOut: true, overflow });
    }, timeoutMs);
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun(result);
    };
    child.once("error", (error) => settle({ code: null, signal: null, stdout, stderr, spawnError: error, timedOut: false, overflow }));
    child.once("close", (code, signal) => settle({ code, signal, stdout, stderr, timedOut: false, overflow }));
  });
}

/**
 * Prove `node:sqlite` initializes in the runtime that will actually serve the
 * candidate.  The store opens its database through DatabaseSync from node:sqlite
 * (server/message-db.ts), a native binding that has to load before the harness
 * can run at all — the same reason MCode initializes better-sqlite3 in memory
 * before it trusts a downloaded release.  In-memory keeps the probe from
 * depending on the store's own file lifecycle: a lazy database is not a broken
 * one, and this gate must never fail a healthy build for being lazy.
 */
async function smokeNativeSqlite({ serverDirectory, nodeBin, nodeEnv, runImpl = runBounded }) {
  const script = [
    'import { DatabaseSync } from "node:sqlite";',
    'const db = new DatabaseSync(":memory:");',
    'db.exec("CREATE TABLE smoke (id INTEGER PRIMARY KEY, value TEXT)");',
    'db.prepare("INSERT INTO smoke (value) VALUES (?)").run("botfleet");',
    'const row = db.prepare("SELECT value FROM smoke WHERE id = 1").get();',
    'if (row?.value !== "botfleet") throw new Error(`unexpected row: ${JSON.stringify(row)}`);',
    'db.close();',
    'console.log("sqlite-ok");',
  ].join("\n");
  const probePath = join(serverDirectory, `smoke-sqlite-${process.pid}-${randomUUID()}.mjs`);
  await writeFile(probePath, `${script}\n`, { mode: 0o600 });
  try {
    const result = await runImpl(nodeBin, [probePath], {
      cwd: serverDirectory,
      env: nodeEnv,
      timeoutMs: SMOKE_SQLITE_TIMEOUT_MS,
    });
    if (result.timedOut) return { ok: false, timedOut: true, detail: "probe exceeded its time budget" };
    if (result.spawnError) return { ok: false, timedOut: false, detail: `probe could not start: ${result.spawnError.message}` };
    if (result.stdout.includes("sqlite-ok")) return { ok: true, timedOut: false, detail: null };
    return {
      ok: false,
      timedOut: false,
      detail: `node:sqlite did not initialize (exit=${result.code}, signal=${result.signal}): ${(result.stderr || result.stdout).trim().slice(0, 400)}`,
    };
  } finally {
    await rm(probePath, { force: true });
  }
}

async function freeLoopbackPort() {
  const { createServer } = await import("node:net");
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const chosen = address?.port ?? 0;
      probe.close(() => resolvePort(chosen));
    });
  });
}

/**
 * The attempt policy, separated from the probe so it can be tested without a
 * real candidate.  Retry exactly one readiness timeout and nothing else: a
 * candidate that exited, or whose native SQLite binding will not load, fails
 * identically a second later, so waiting again would only delay the real
 * diagnosis.  A busy Mac and a broken build must not produce the same verdict.
 */
export async function runStagedSmokeTest({ builtBundle, targetCommit, smokeImpl, attempts = SMOKE_BOOT_ATTEMPTS, onRetry } = {}) {
  const scratchRoot = join(tmpdir(), "botfleet-update-smoke");
  await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
  let lastFailure = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // A structural problem (no entry point, ditto failed, no free port) is not
    // a busy-host symptom, so it propagates without earning a retry.
    const result = await smokeImpl({ bundlePath: builtBundle, targetCommit, attempt, scratchRoot });
    if (result.ready && result.sqlite?.ok) return { ok: true, attempts: attempt };
    if (result.ready && result.sqlite?.timedOut) {
      lastFailure = { cause: "sqlite-probe-timed-out", output: result.output };
    } else if (result.ready) {
      // Booted, but the native binding would not initialize.  That is a real
      // defect in the artifact, and the probe's own detail is the diagnosis.
      lastFailure = { cause: "sqlite-unavailable", output: `${result.output}\n${result.sqlite?.detail || ""}` };
    } else {
      // The probe may know more than the process state does (an owner record
      // that names the wrong pid looks exactly like a live, unready child).
      // Its explicit cause wins; otherwise classify from what the process did.
      lastFailure = {
        cause: result.cause || classifySmokeFailure({
          exitCode: result.exitCode,
          signal: result.signal,
          spawnError: result.spawnError,
        }),
        exitCode: result.exitCode,
        signal: result.signal,
        spawnError: result.spawnError,
        output: result.output,
      };
    }
    if (lastFailure.cause !== "server-never-ready" || attempt === attempts) break;
    onRetry?.({ attempt, attempts });
  }
  throw new Error(smokeFailureMessage({ ...lastFailure, targetCommit, bundlePath: builtBundle }));
}

/**
 * Boot the candidate's packaged server with no node_modules in reach and wait
 * for genuine readiness.  Health answers as soon as the port binds, which is
 * before boot work finishes, so `ready` — not the first 200 — is the signal.
 * Readiness plus the owner record together are the same contract
 * scripts/smoke-packaged-server.mjs asserts in CI; proving it locally is what
 * makes a CI-built or imported candidate as trustworthy as a locally built one.
 */
export async function smokeStagedServer({ bundlePath, targetCommit, attempt, scratchRoot }) {
  const serverDirectory = join(bundlePath, "Contents/Resources/server");
  if (!(await exists(join(serverDirectory, "index.js")))) {
    throw new Error(`Staged BotFleet candidate has no packaged server entry point: ${serverDirectory}/index.js`);
  }
  // Checked BEFORE any scratch directory exists.  This used to sit after the
  // ditto below, so a candidate with no packaged executable threw with a full
  // copy of Contents/Resources/server already on disk, and the cleanup
  // finally-block had not been entered yet — a structural throw is not retried,
  // so every imported --bundle candidate without that binary leaked a /tmp
  // directory for the life of the machine.
  const packagedBinary = join(bundlePath, "Contents/MacOS/BotFleet");
  if (!(await exists(packagedBinary))) {
    throw new Error(`Staged BotFleet candidate has no packaged executable: ${packagedBinary}`);
  }
  const scratch = join(scratchRoot, `smoke-${targetCommit.slice(0, 12)}-${attempt}-${randomUUID()}`);
  const staging = join(scratch, "server");
  const home = join(scratch, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  // Copy out of the bundle before running, exactly as the CI smoke test does.
  // A bare import resolves differently depending on what sits above the tree,
  // and the point of the probe is the layout the candidate will really ship.
  await run("ditto", [serverDirectory, staging]);
  const port = await freeLoopbackPort();
  if (!port || DEFAULT_PORTS.includes(port)) {
    throw new Error(`Could not reserve a loopback port for the staged smoke test (got ${port})`);
  }

  // Run the candidate on the runtime that will actually serve it: the packaged
  // Electron binary under ELECTRON_RUN_AS_NODE=1, which is exactly how the
  // harness launches it (server/index.ts's AGENTS_NODE_FLAG) and why
  // electron-builder.yml keeps the runAsNode fuse on.  Using the updater's own
  // Node would test a different runtime than the one under test — the
  // Homebrew/nvm Node could have node:sqlite while Electron's bundled Node does
  // not, or the reverse, and the probe would be answering a question nobody
  // asked.  Dropping the flag would launch GUI Electron instead of the server.
  const child = spawn(packagedBinary, [join(staging, "index.js")], {
    cwd: staging,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      ELECTRON_RUN_AS_NODE: "1",
      OMB_PORT: String(port),
      // No Sentry configuration at all, deliberately.  This child environment is
      // built from scratch rather than inherited, so omitting the variable is
      // what guarantees the probe cannot reach a real project.  A hard-coded
      // loopback DSN would still be a DSN in source, and still one edit away
      // from a real one.
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Bounded, because only the tail is ever rendered (SMOKE_OUTPUT_EXCERPT) and a
  // candidate stuck in a crash loop — precisely the case this gate exists to
  // diagnose — would otherwise append to this for two full boot windows and get
  // the updater OOM-killed by the thing it was diagnosing.  Keep the tail: that
  // is the part that names the failure.
  let output = "";
  const capture = (chunk) => {
    output = (output + chunk).slice(-SMOKE_OUTPUT_CAPTURE);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  try {
    const deadline = Date.now() + SMOKE_BOOT_TIMEOUT_MS;
    let ready = false;
    let spawnError = null;
    child.on("error", (error) => { spawnError = error; });
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null) break;
      try {
        // Bound each request, not just the loop: the deadline is only checked
        // between iterations, so a candidate that accepts the connection and
        // never answers would otherwise hold the updater lock for undici's
        // default 300s headers timeout instead of returning at 180s.
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(SMOKE_HEALTH_REQUEST_TIMEOUT_MS),
        });
        if (response.ok && parseHealthBody(await response.json().catch(() => null))) {
          ready = true;
          break;
        }
      } catch {
        /* not up yet */
      }
      await sleep(300);
    }
    if (!ready) {
      return { ready: false, output, spawnError, exitCode: child.exitCode, signal: child.signalCode };
    }
    // The owner record is written at the end of a successful boot, so its
    // presence and matching pid prove the candidate finished starting rather
    // than merely binding a port.
    const owner = await parseJsonFile(join(home, ".botfleet", "harness-owner.json"), "Staged runtime owner record");
    if (owner?.pid !== child.pid) {
      // A wrong owner record is a real defect, not a slow host, so it carries
      // its own cause: without this it would classify as a readiness timeout,
      // earn a retry, and be reported as "too busy".
      return {
        ready: false,
        cause: "owner-mismatch",
        output: `${output}\nowner record pid ${owner?.pid} does not match the staged server pid ${child.pid}`,
        exitCode: child.exitCode,
        signal: child.signalCode,
      };
    }
    const sqlite = await smokeNativeSqlite({
      serverDirectory: staging,
      nodeBin: packagedBinary,
      nodeEnv: { ELECTRON_RUN_AS_NODE: "1" },
    });
    return { ready: true, output, sqlite };
  } finally {
    child.kill("SIGKILL");
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}


/**
 * The pids in `ps -axo pid=,stat=,command=` output whose arguments name
 * `executable`.  Rows in a zombie state are skipped: the process is gone, and
 * `ps` may keep printing its recorded command line until the parent reaps it.
 */
export function exactAppPidsFromPs(psOutput, executable) {
  return psOutput.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
    if (!match || isZombieState(match[2])) return [];
    return match[3] === executable || match[3].startsWith(`${executable} `) ? [Number(match[1])] : [];
  });
}

async function exactAppPids(appPath) {
  const result = await run("ps", ["-axo", "pid=,stat=,command="], { allowFailure: true });
  return exactAppPidsFromPs(result.stdout, join(appPath, "Contents/MacOS/BotFleet"));
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
  return withoutExitedPids(txtHolderPids(result.stdout, root));
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

/** The executable a process runs, as a full path where `ps` knows it. */
async function processExecutable(pid) {
  const result = await run("ps", ["-p", String(pid), "-o", "comm="], { allowFailure: true });
  return result.code === 0 ? result.stdout.trim() : "";
}

async function processCwd(pid) {
  const result = await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { allowFailure: true });
  return result.code === 0 ? result.stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1) || "" : "";
}

async function processTxtPaths(pid) {
  const result = await run("lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"], { allowFailure: true });
  return result.code === 0 ? result.stdout.split("\n").filter((line) => line.startsWith("n")).map(line => line.slice(1)) : [];
}

/**
 * Which resolution failures justify quietly packaging on this Mac instead.
 *
 * Only "this commit was never built on CI" is a legitimate reason: the point of
 * `auto` is to install a commit that predates the workflow.  A network failure,
 * a rate limit, or a checksum mismatch must NOT fall back, because a silent
 * 15-minute local build would turn a broken pipeline or a tampered artifact
 * into "it worked, just slowly".
 */
export function isRecoverableResolutionFailure(error) {
  if (!(error instanceof ResolutionError)) return false;
  if (error.cause === "no-build") return true;
  // Only a run the workflow was *expected* to cancel justifies a local
  // fallback.  A genuinely failed build is a signal: its signature gate, its
  // tests, or its packaging step rejected the commit, and quietly building the
  // same commit locally for 15 minutes would turn a broken pipeline into a
  // deceptively successful install.  `cancelled` is the expected outcome
  // whenever a newer commit lands on main; `in_progress` is worth a moment.
  if (error.cause === "build-failed") {
    return ["cancelled", "in_progress"].includes(error.conclusion);
  }
  // Network, rate limit, checksum, and bad manifest must all surface: a silent
  // local package would turn a broken pipeline or a tampered artifact into "it
  // worked, just slowly".
  return false;
}

export async function isExpectedBotFleetProcess(command, cwd, config, pid, { txtPathsOf = processTxtPaths } = {}) {
  const appExecutable = join(config.appPath, "Contents/MacOS/BotFleet");
  if (command === appExecutable || command.startsWith(`${appExecutable} `) || command.startsWith(`${config.appPath}/Contents/`)) {
    return true;
  }
  const executable = command.trim().split(/\s+/)[0] || "";
  const isNode = ["node", "nodejs"].includes(basename(executable));
  const serverArgument = command.split(/\s+/).some((argument) => argument === "server/index.ts" || argument === join(config.checkout, "server/index.ts"));
  if (isNode && serverArgument && cwd === config.checkout) {
    return true;
  }
  if (pid) {
    const txtPaths = await txtPathsOf(pid);
    const helperPrefix = join(config.appPath, "Contents/Frameworks/BotFleet Helper");
    if (txtPaths.includes(appExecutable) || txtPaths.some((p) => p.startsWith(helperPrefix))) {
      return true;
    }
  }
  return false;
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
 * The launchd label a bootstrap of `plist` is assumed to load when nobody
 * reads its Label.  The legacy-named com.jay.botfleet-server.plist does not
 * reliably carry the legacy label: a pre-transition Mac declares
 * com.jay.botfleet-server in it, but a Mac migrated in place declares
 * app.botfleet.server in that same file (the owner's Mac did on 2026-10-02).
 * Mapping the legacy path to the legacy label is the covering guess, not a
 * fact about the file: rollback boots out config.label unconditionally, so a
 * legacy-named plist that carries the renamed label is stopped either way.
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

/**
 * Boot out every harness job before install: each label loaded now, as well
 * as each label the capture saw.  The capture ran minutes earlier, and a job
 * can have been bootstrapped since (a watchdog restarting the harness it
 * found stopped).  Left loaded, its KeepAlive relaunches the harness the
 * moment quiesce signals it.  A label found loaded here is recorded on
 * `previous`, so rollback restores it exactly like one the capture saw.
 * `launchctl bootout` exits nonzero when the job is already gone, so success
 * is judged by `launchctl print`, as rollback judges it: only a job that is
 * still loaded is a refusal.
 */
export async function bootOutHarnessForQuiesce(config, previous, {
  print = (label) => run("launchctl", ["print", `${config.domain}/${label}`], { allowFailure: true }),
  bootout = (label) => run("launchctl", ["bootout", `${config.domain}/${label}`], { allowFailure: true }),
  confirmAbsent = (label) => waitForLaunchdBootout(config.domain, label),
} = {}) {
  const [loaded, legacyLoaded] = await Promise.all([print(config.label), print(config.legacyLabel)]);
  if (loaded.code === 0) previous.launchdLoaded = true;
  if (legacyLoaded.code === 0) previous.legacyLaunchdLoaded = true;
  // BOTFLEET_LAUNCH_AGENT_LABEL may name the legacy label itself; the
  // deduplicated list boots each loaded label out exactly once.
  for (const label of quiesceBootoutLabels(config, previous)) {
    await bootout(label);
    if (!(await confirmAbsent(label))) {
      throw new Error(`Could not boot out ${label} before install: ${config.domain}/${label} is still loaded`);
    }
  }
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

async function waitForExit(pids, timeoutMs, { isAlive, wait = sleep, now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  let remaining = await withoutExitedPids(pids, { isAlive });
  while (remaining.length && now() < deadline) {
    await wait(250);
    remaining = await withoutExitedPids(remaining, { isAlive });
  }
  return remaining;
}

/**
 * Send `signal` to `pid` and report whether it was delivered.  ESRCH means
 * the process has already exited, which is the outcome a shutdown wants, so
 * it comes back as false rather than as an exception: the 2026-10-02 apply
 * rolled back on a bare "kill ESRCH" because a BotFleet process finished its
 * own quit between being verified and being signalled.  Every other failure,
 * EPERM above all, still throws and names the pid, because a process that
 * refuses the signal is still running.
 */
export function signalProcess(pid, signal, kill = (target, name) => process.kill(target, name)) {
  try {
    kill(pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not send ${signal} to BotFleet process ${pid}: ${reason}`, { cause: error });
  }
}

/**
 * A running process holds BotFleet state — the database, the bundle, a BotFleet
 * port — and is not a BotFleet process.  The updater never signals one.  It is
 * usually brief: a bot's own tool (`sqlite3`, `node`, `curl` against a BotFleet
 * port) opening something for a second, which is why the callers wait it out
 * (`waitOutUnrecognizedHolders`) before they refuse.
 */
export class UnrecognizedHolderError extends Error {
  constructor(pid, executable, message) {
    super(`${message}${executable ? ` (${executable})` : ""}`);
    this.name = "UnrecognizedHolderError";
    this.pid = pid;
    this.executable = executable || "";
  }
}

/** How long apply waits for a non-BotFleet process to let go of BotFleet state. */
export const DEFAULT_UNKNOWN_HOLDER_WAIT_MS = 90_000;
const UNKNOWN_HOLDER_POLL_MS = 2_000;

/**
 * Run `attempt` again while it trips over an unrecognised holder, until the
 * window closes.  `attempt` re-resolves what holds BotFleet state every time,
 * so a holder that has gone simply is not there on the next pass.  One that is
 * still there when the window closes is refused by name, and still never
 * signalled: it is not ours to stop.
 */
export async function waitOutUnrecognizedHolders(attempt, {
  windowMs = DEFAULT_UNKNOWN_HOLDER_WAIT_MS,
  pollMs = UNKNOWN_HOLDER_POLL_MS,
  now = Date.now,
  wait = sleep,
  report = () => {},
  // A signal ends the wait at once; the caller says why it stopped.
  stopped = () => false,
} = {}) {
  const deadline = now() + Math.max(0, windowMs);
  let lastReport = null;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof UnrecognizedHolderError)) throw error;
      if (stopped()) throw error;
      if (now() >= deadline) {
        throw new UnrecognizedHolderError(
          error.pid,
          error.executable,
          `Process ${error.pid} still holds BotFleet state after ${describeWindow(windowMs)} and is not a BotFleet process, `
            + "so the updater will not stop it.  Quit it or let it finish, then update again",
        );
      }
      const line = `Waiting for ${error.executable ? basename(error.executable) : `process ${error.pid}`} to let go of BotFleet's files`;
      if (line !== lastReport) {
        lastReport = line;
        report(line);
      }
      await wait(Math.min(pollMs, Math.max(0, deadline - now())));
    }
  }
}

/**
 * The processes holding the BotFleet database, once any that is not BotFleet
 * has let go.
 *
 * The preflight and the check after the fence used to count every holder and
 * refuse "Database ownership is ambiguous" at once — which is exactly where a
 * bot's own `sqlite3` or `node` reading the database for a second trips an
 * update.  An extra holder that is not a BotFleet process is now waited out
 * the same bounded way capture and quiesce wait (`waitOutUnrecognizedHolders`),
 * never signalled, and named when it stays.  A second holder that IS a
 * BotFleet process is still a definitive ambiguity for the caller to refuse.
 * Resolves `{ holders }`, or `{ holders: null, reason }` when a foreign holder
 * outlasted the window.
 */
export async function settledDatabaseHolders(config, ownerPid, {
  inspect = sqliteHolders,
  identify = {},
  windowMs = Number.isFinite(config?.unknownHolderWaitMs) ? config.unknownHolderWaitMs : DEFAULT_UNKNOWN_HOLDER_WAIT_MS,
  now = Date.now,
  wait = sleep,
  report = () => {},
  stopped = () => false,
} = {}) {
  try {
    const holders = await waitOutUnrecognizedHolders(async () => {
      const current = await inspect(config.dataDirectory);
      const others = current.filter((pid) => pid !== ownerPid);
      if (!others.length) return current;
      // Throws for a live holder that is not BotFleet; drops one that exited.
      const { pids } = await captureProcessIdentities(others, config, identify);
      return current.filter((pid) => pid === ownerPid || pids.includes(pid));
    }, { windowMs, now, wait, report: report ?? (() => {}), stopped });
    return { holders };
  } catch (error) {
    if (error instanceof UnrecognizedHolderError) return { holders: null, reason: error.message };
    throw error;
  }
}

/**
 * Record the identity of every running process that holds BotFleet state, so
 * quiesce can tell the process it captured from a recycled pid.  Exited pids
 * (a zombie above all) are dropped first: they hold nothing, and a zombie's
 * command line and working directory are unreliable or empty, so verifying
 * one would refuse a healthy machine with "owns BotFleet state but does not
 * match an expected BotFleet executable".  Returns the surviving pids too, so
 * the caller records only those.
 */
export async function captureProcessIdentities(pids, config, {
  isAlive,
  commandOf = processCommand,
  cwdOf = processCwd,
  executableOf = processExecutable,
  txtPathsOf = processTxtPaths,
} = {}) {
  const live = await withoutExitedPids([...new Set(pids)], { isAlive });
  const processCommands = {};
  const processCwds = {};
  for (const pid of live) {
    const command = await commandOf(pid);
    const cwd = await cwdOf(pid);
    if (!(await isExpectedBotFleetProcess(command, cwd, config, pid, { txtPathsOf }))) {
      // Gone while it was being described: it holds nothing any more.
      if ((await withoutExitedPids([pid], { isAlive })).length === 0) continue;
      throw new UnrecognizedHolderError(
        pid,
        (await executableOf(pid)) || command.trim().split(/\s+/)[0] || "",
        `Process ${pid} owns BotFleet state but does not match an expected BotFleet executable and working directory`,
      );
    }
    processCommands[pid] = command;
    processCwds[pid] = cwd;
  }
  return { pids: live.filter((pid) => processCommands[pid] !== undefined), processCommands, processCwds };
}

/**
 * Stop the BotFleet processes in `pids`: wait for a graceful exit, SIGTERM
 * whatever is left once its identity checks out, then wait again.  Never
 * SIGKILL.
 *
 * `current` names the pids resolved just now from what holds BotFleet state
 * (database holders, processes inside the bundle, the owner answering a
 * BotFleet port).  Each of those must verify as a BotFleet executable or the
 * step refuses.  Any other pid was recorded at capture, minutes earlier, and
 * is only a hint: its process may have finished its own shutdown since, and
 * the number may now name an unrelated process.  A captured-only pid whose
 * identity no longer matches is therefore not ours any more.  It is skipped,
 * never signalled, and never waited on.  Without `current` every pid is
 * held to the strict rule.
 *
 * A zombie counts as exited.  It has already died and holds nothing; only its
 * parent can reap it, so it is neither waited on nor signalled, and its parent
 * is never touched.  `kill -0` cannot tell the difference, which is how two
 * defunct `cua-driver` processes left by a grok CLI that never reaped them
 * blocked every apply on 2026-10-08 (processIsAlive reads the `ps` state).
 *
 * A process exiting on its own is success at every point.  Under load `ps`
 * and `lsof` take seconds, so a process can pass the liveness check and be
 * gone by the time its identity comes back (empty), or by the time the
 * signal goes out (ESRCH).  Neither is a refusal.  What still has to hold
 * afterwards: every process actually signalled must exit, and the
 * transaction's assertQuiesced step re-reads the database holders, the
 * bundle's processes, and every BotFleet port before anything is installed.
 */
export async function terminateVerified(pids, previous, config, {
  current,
  isAlive,
  commandOf = processCommand,
  cwdOf = processCwd,
  executableOf = processExecutable,
  txtPathsOf = processTxtPaths,
  kill,
  wait = sleep,
  now = Date.now,
} = {}) {
  const timing = { isAlive, wait, now };
  const resolvedNow = current ? new Set(current) : null;
  const survivors = await waitForExit([...new Set(pids)], config.gracefulExitMs, timing);
  // Every survivor is identified before any is signalled, so an unrecognised
  // holder stops the step with nothing half-stopped behind it.
  const verified = [];
  for (const pid of survivors) {
    const command = await commandOf(pid);
    const cwd = await cwdOf(pid);
    const sameAsCaptured = Boolean(previous.processCommands?.[pid]) && previous.processCommands[pid] === command &&
      previous.processCwds?.[pid] === cwd;
    if (!sameAsCaptured && !(await isExpectedBotFleetProcess(command, cwd, config, pid, { txtPathsOf }))) {
      // Exited while ps and lsof were still describing it: there was no
      // process left to describe, so its identity came back empty.
      if ((await withoutExitedPids([pid], { isAlive })).length === 0) continue;
      // A captured pid that now names something else: the process the
      // capture saw is gone, and this one never held BotFleet state.
      if (resolvedNow && !resolvedNow.has(pid)) continue;
      throw new UnrecognizedHolderError(
        pid,
        (await executableOf(pid)) || command.trim().split(/\s+/)[0] || "",
        `Process ${pid} still holds BotFleet state but its executable is not an expected BotFleet path`,
      );
    }
    verified.push(pid);
  }
  const signalled = [];
  for (const pid of verified) {
    if (signalProcess(pid, "SIGTERM", kill)) signalled.push(pid);
  }
  const remaining = await waitForExit(signalled, config.termExitMs, timing);
  if (remaining.length) {
    throw new Error(`BotFleet did not exit after graceful quit and SIGTERM (pid ${remaining.join(", ")}); refusing SIGKILL`);
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
    // How long work in flight gets to finish before apply pauses it, and,
    // only with --wait-for-idle, how long apply waits instead of pausing.
    // A flag wins over the environment; an unreadable value is the default.
    graceMs: parsed.graceMs ?? environmentMs("BOTFLEET_UPDATE_GRACE_MS", DEFAULT_GRACE_MS),
    waitForIdleMs: parsed.waitForIdleMs,
    roomWaitMs: environmentMs("BOTFLEET_UPDATE_ROOM_WAIT_MS", DEFAULT_ROOM_WAIT_MS),
    preflightRetryMs: environmentMs("BOTFLEET_PREFLIGHT_RETRY_MS", DEFAULT_PREFLIGHT_RETRY_MS),
    // How long a process that is not BotFleet may hold BotFleet state before
    // apply refuses (it is never signalled either way).
    unknownHolderWaitMs: environmentMs("BOTFLEET_UNKNOWN_HOLDER_WAIT_MS", DEFAULT_UNKNOWN_HOLDER_WAIT_MS),
    drainPollMs: environmentMs("BOTFLEET_DRAIN_POLL_MS", 5_000),
    force: Boolean(parsed.force || process.env.BOTFLEET_FORCE === "1"),
    // Set by main() once the progress record exists: what the drain is
    // waiting for, for the terminal and for the Mac and the phone.
    reportDetail: undefined,
    parsed,
  };
}

function environmentMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
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
      // Owner ruling 2026-10-01: GitHub's Mac runners do the building, always.
      // `pnpm package:mac:local` below is the 10-15 minute electron-builder run
      // that every recorded update failure was inside, so it is now the
      // explicit bypass rather than the default.
      const policy = updateSourcePolicy();
      if (policy !== "local") {
        try {
          const hosted = await downloadBuiltBundle({
            commit: targetCommit,
            destination: join(source.stageDirectory, "hosted"),
          });
          console.log(`Using the hosted build of ${targetCommit.slice(0, 12)} instead of packaging on this Mac`);
          return hosted.appPath;
        } catch (error) {
          // `ci` must fail loudly: silently falling back to a 15-minute local
          // build would make the ruling a suggestion and hide a broken pipeline.
          if (policy === "ci" || !isRecoverableResolutionFailure(error)) throw error;
          console.error(`No usable hosted build, so packaging on this Mac instead: ${error.message}`);
        }
      }
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

    smokeTestBundle: async (builtBundle, targetCommit) => {
      if (!smokeTestEnabled()) {
        console.log("Skipping the staged smoke test (BOTFLEET_UPDATE_SMOKE=0); the candidate is unproven.");
        return;
      }
      const result = await runStagedSmokeTest({
        builtBundle,
        targetCommit,
        smokeImpl: smokeStagedServer,
        onRetry: ({ attempt, attempts }) =>
          console.log(`Staged candidate did not report ready (attempt ${attempt}/${attempts}); retrying once for a busy host.`),
      });
      console.log(`Staged candidate ${targetCommit.slice(0, 12)} booted, reported ready, and initialized node:sqlite ✓ (attempt ${result.attempts})`);
    },

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
      // The download unpacked into <stage>/hosted and the app was just copied out
      // of it, so that directory is now a second full copy of the bundle sitting
      // in the stage.  A stage holding prepared.json is never prunable — it is a
      // build a later `apply` can still install — so leaving it there means every
      // prepared stage, which is the normal state between two updates, holds a
      // duplicate of the app for as long as it exists.  Removed only after the
      // copy has been validated, so a failure still leaves it for diagnosis.
      const hostedScratch = join(source.stageDirectory, "hosted");
      if (resolve(hostedScratch) !== resolve(bundlePath) && await exists(hostedScratch)) {
        await rm(hostedScratch, { recursive: true, force: true });
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
      // to be accounted for too.  Resolved afresh on every pass: a bot's own
      // tool holding the database for a moment is waited out, not refused
      // (`waitOutUnrecognizedHolders`), and the next pass no longer sees it.
      const { bundlePids, runtimeCandidates, pids: livePids, processCommands, processCwds } =
        await waitOutUnrecognizedHolders(async () => {
          const bundle = await bundleProcessPids(config.appPath);
          const holders = await sqliteHolders(config.dataDirectory);
          const candidates = [...new Set([...(lastPreflight?.pids || []), lastPreflight?.pid, ...holders].filter(Number.isInteger))];
          // Exited processes (zombies above all) are not captured: quiesce
          // would wait on a pid that can never go away, and a defunct process
          // fails the identity check below.
          const captured = await captureProcessIdentities([...candidates, ...bundle], config);
          return { ...captured, bundlePids: bundle, runtimeCandidates: candidates };
        }, { windowMs: config.unknownHolderWaitMs, report: config.reportDetail });
      const runtimePids = runtimeCandidates.filter((pid) => livePids.includes(pid));
      const appPids = bundlePids.filter((pid) => livePids.includes(pid));
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
      await bootOutHarnessForQuiesce(config, previous);
      await run("osascript", ["-e", 'if application "BotFleet" is running then tell application "BotFleet" to quit'], { allowFailure: true });
      // Re-resolve what holds BotFleet state now rather than trusting the
      // capture.  The embedded driver and the helper apps start on demand, so
      // one can appear between the capture and the shutdown; and the harness
      // the capture saw can have been replaced since, so its recorded pid is
      // gone or names someone else while the replacement owns the database
      // and port 8799.  The captured pids still go in, as hints that
      // terminateVerified drops once their identity no longer matches.
      // Re-resolved on every pass, for the same reason as at capture: a
      // non-BotFleet process holding BotFleet state is waited out and never
      // signalled, and a refusal names it.
      await waitOutUnrecognizedHolders(async () => {
        const [currentHolders, currentBundlePids, health] = await Promise.all([
          sqliteHolders(config.dataDirectory),
          bundleProcessPids(config.appPath),
          Promise.all(config.ports.map(probeHealth)),
        ]);
        const current = ownedRuntimePids({ holders: currentHolders, bundlePids: currentBundlePids, health });
        await terminateVerified(
          [...previous.runtimePids, ...previous.appPids, ...current],
          previous,
          config,
          { current },
        );
      }, { windowMs: config.unknownHolderWaitMs, report: config.reportDetail });
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
      // The renamed executable cannot decrypt the Keychain item Electron
      // safeStorage created under com.botfleet.app.  The still-authorized
      // predecessor writes credentials.migration.json before the swap.
      if (shouldExportSafeStorageBeforeRename(
        previous.installedIdentity.bundleIdentifier,
        prepared.bundleIdentifier,
      )) {
        const executable = join(config.appPath, "Contents/MacOS/BotFleet");
        await run(executable, [SAFE_STORAGE_EXPORT_FLAG]);
      }
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
      if (config.parsed.openApplication !== false) {
        const deadline = Date.now() + config.startupTimeoutMs;
        let appError = "Timeout waiting for application to stabilize";
        let attachmentError = "Timeout waiting for UI attachment";
        while (Date.now() < deadline) {
          const firstAppPids = await exactAppPids(config.appPath);
          await sleep(1_000);
          const secondAppPids = await exactAppPids(config.appPath);
          
          appError = stableApplicationProcessError(firstAppPids, secondAppPids, true);
          if (!appError) {
            const snapshot = await runtimeIdentityPreflight(config, prepared);
            if (!snapshot.safe || snapshot.mode !== "authenticated") {
              attachmentError = snapshot.reason || "Updated application did not attach to the authenticated single data owner";
            } else {
              attachmentError = applicationAttachmentError(snapshot, true);
            }
            if (!attachmentError) break;
          }
        }
        if (appError) throw new Error(appError);
        if (attachmentError) throw new Error(attachmentError);
      } else {
        const snapshot = await runtimeIdentityPreflight(config, prepared);
        if (!snapshot.safe || snapshot.mode !== "authenticated") {
          throw new Error(snapshot.reason || "Updated application did not attach to the authenticated single data owner");
        }
      }
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
          // At once: no hold and no grace against the replacement.
          readiness = await fenceRuntimeAdmission(rollbackFenceConfig(config));
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
  config.reportDetail = (detail) => {
    console.log(`${detail}...`);
    progress?.note({ detail });
  };
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

// Node's ESM loader realpaths the entry module, so import.meta.url names the
// physical file while process.argv[1] keeps whatever spelling the caller used.
// On macOS os.tmpdir() is /var/folders/..., and /var is a symlink to
// /private/var, so the wrapper's bootstrap copy under mktemp -d compared
// unequal, main() never ran, and the updater exited 0 without a word.  Compare
// physical paths.  This file must stay self-contained: the installed wrapper
// archives a fixed list of updater files, so a new import here would break the
// bootstrap on every Mac that already has that wrapper.
function isEntryModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  main().catch((error) => {
    console.error(`BotFleet update failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}


