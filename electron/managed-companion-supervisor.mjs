// The launchd-supervised owner of the Companion sidecar.
//
// Until this existed the sidecar was an Electron utilityProcess: `companion.mjs`
// forked it, and forked it again on every relaunch.  Quitting the app therefore
// killed the process that answered :8810, and `agents.botfleet.app` — whose
// Cloudflare connector lands on exactly that port — started returning 502 for as
// long as the app stayed closed.  That is BF-1339, and it is a supervision
// gap rather than a tunnel problem.
//
// This module is the missing supervisor.  launchd keeps it alive, it keeps the
// sidecar alive, and the app becomes a client of a sidecar it no longer owns.
//
// What it deliberately does NOT do is touch the fail-closed guardian.  The
// guardian on :8812 still belongs to Electron, still watches its stdin
// parent-death pipe, still tears down cloudflared before it releases the port,
// and still refuses to start without an ownership-verified target.  A sidecar
// that outlives the app must not become a sidecar that outlives its guardian's
// ownership check, so the supervisor publishes an *identity* and the guardian
// re-proves that identity over the socket before it forwards anything.
//
// Two rules shape the code below:
//
//   1. Never claim a sidecar we have not verified.  Readiness is
//      `companionOriginHealth` answering with the companion identity on the
//      exact socket the guardian will be pointed at — the same proof the app
//      used before it forked the sidecar itself.
//   2. Never keep a dead claim.  The runtime file is cleared on every exit path,
//      including the ones that fail, so a stale pid can never be adopted.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCompanionEntry } from "./companion-entry.mjs";
import {
  cleanupCompanionOriginEndpoint,
  companionOriginHealth,
  createCompanionOriginEndpoint,
} from "./companion-origin-gateway.mjs";
import {
  clearManagedCompanionRuntime,
  writeManagedCompanionRuntime,
} from "./managed-companion-runtime.mjs";

export const SUPERVISED_COMPANION_PORT = 8810;
export const SUPERVISED_COMPANION_CONTROL_PORT = 8811;
export const SUPERVISED_COMPANION_HARNESS_PORT = 8799;

const READY_TIMEOUT_MS = 30_000;
const READY_INTERVAL_MS = 150;
const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 30_000;
const TERMINATE_GRACE_MS = 5_000;

const delay = (milliseconds) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });

/** Environment for the sidecar.  launchd hands this process a small
 * environment, and the sidecar needs HOME for its device registry; everything
 * else is inherited so a dev checkout behaves the way it does under
 * `pnpm companion`.  The two OMB_* origin variables are stripped first: an
 * inherited value would bypass this supervisor's own allocation and point the
 * sidecar at an endpoint it did not create. */
export function supervisedCompanionEnvironment(
  { entry, harnessPort, companionPort, controlPort, socketPath, hostedUrl = null },
  { environment = process.env, platform = process.platform } = {},
) {
  const child = { ...environment };
  delete child.OMB_COMPANION_HOSTED_URL;
  delete child.OMB_COMPANION_INTERNAL_ORIGIN;
  if (hostedUrl) child.OMB_COMPANION_HOSTED_URL = hostedUrl;
  child.OMB_COMPANION_INTERNAL_ORIGIN = socketPath;
  child.OMB_PORT = String(harnessPort);
  child.OMB_COMPANION_PORT = String(companionPort);
  child.OMB_CONTROL_PORT = String(controlPort);
  // The sidecar watches this pipe and shuts itself down when it closes. Without
  // it a SIGKILLed supervisor leaves an orphan still holding the device port.
  child.OMB_COMPANION_PARENT_STDIN = "1";
  if (platform === "win32") {
    delete child.ELECTRON_RUN_AS_NODE;
  }
  return child;
}

/** Ask the sidecar's own control server who it is.  Same API the Settings
 * panel and the standalone page use, so one port answers for all of them. */
async function controlState(controlPort, { timeoutMs = 4_000 } = {}) {
  const response = await fetch(`http://127.0.0.1:${controlPort}/state`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`companion control ${response.status}`);
  return response.json();
}

function terminate(child, graceMs = TERMINATE_GRACE_MS) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", finish);
    child.once("close", finish);
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish();
    }, graceMs);
    timer.unref?.();
    try {
      child.kill("SIGTERM");
    } catch {}
  });
}

/**
 * Run one sidecar lifetime: fork it, prove ownership, publish the claim, and
 * resolve when the sidecar exits.  Exported for deterministic tests, which
 * drive it with a fake spawn and a stubbed ownership probe.
 */
export async function runSupervisedCompanion({
  entry,
  execArgv = [],
  harnessPort = SUPERVISED_COMPANION_HARNESS_PORT,
  companionPort = SUPERVISED_COMPANION_PORT,
  controlPort = SUPERVISED_COMPANION_CONTROL_PORT,
  endpoint,
  hostedUrl = null,
  environment = process.env,
  spawnProcess = spawn,
  probeOwnership = companionOriginHealth,
  readControlState = controlState,
  home,
  readyTimeoutMs = READY_TIMEOUT_MS,
  readyIntervalMs = READY_INTERVAL_MS,
  log = () => {},
} = {}) {
  // A missing entry has to be a refusal, not a spawn TypeError: this runs
  // unattended under launchd, where an unhandled throw is a restart loop with
  // no explanation in the log.
  if (typeof entry !== "string" || !path.isAbsolute(entry)) {
    throw new Error("The companion entry is not an absolute path");
  }
  const childEnvironment = supervisedCompanionEnvironment(
    { entry, harnessPort, companionPort, controlPort, socketPath: endpoint.socketPath, hostedUrl },
    { environment },
  );

  let child;
  try {
    child = spawnProcess(entry, [], {
      env: childEnvironment,
      execArgv,
      shell: false,
      windowsHide: true,
      // stdin is the parent-death pipe and must stay open for this sidecar's
      // whole life: closing it early is exactly the signal that makes the
      // sidecar stop.
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    cleanupCompanionOriginEndpoint(endpoint);
    throw error;
  }
  child.stdin?.on?.("error", () => {
    // A sidecar that already exited takes the read end with it; the exit
    // handler owns the restart, so this only has to not crash the supervisor.
  });
  child.stdout?.on("data", (data) => log(`[companion] ${String(data).trimEnd()}`));
  child.stderr?.on("data", (data) => log(`[companion err] ${String(data).trimEnd()}`));

  let exited = false;
  const exit = new Promise((resolve) => {
    child.once("exit", (code) => {
      exited = true;
      resolve(code ?? 1);
    });
    child.once("error", () => {
      // A spawn failure has no process to wait for; once a pid exists an error
      // event alone does not prove the OS process is gone.
      if (!Number.isSafeInteger(child.pid) && !exited) {
        exited = true;
        resolve(1);
      }
    });
  });

  const deadline = Date.now() + readyTimeoutMs;
  let target = null;
  let failure = null;
  while (!exited && Date.now() < deadline) {
    try {
      const state = await readControlState(controlPort);
      // A listener on the control port proves something is running, not that it
      // is the process we just forked.  Matching the pid is what keeps a
      // hand-started or leftover sidecar from being adopted as ours.
      if (Number.isSafeInteger(child.pid) && child.pid > 0 && state?.pid === child.pid) {
        target = { pid: child.pid, socketPath: endpoint.socketPath };
        if (await probeOwnership(target)) break;
        target = null;
      }
    } catch {
      /* not up yet */
    }
    await delay(readyIntervalMs);
  }

  if (!target) {
    failure = exited
      ? "the companion sidecar exited before it answered"
      : "the companion sidecar did not become verifiable in time";
    await terminate(child);
    cleanupCompanionOriginEndpoint(endpoint);
    return { status: "unverified", reason: failure };
  }

  let published = null;
  try {
    published = writeManagedCompanionRuntime(
      {
        version: 1,
        supervisorPid: process.pid,
        sidecarPid: child.pid,
        socketPath: endpoint.socketPath,
        companionPort,
        controlPort,
        startedAt: new Date().toISOString(),
      },
      { home },
    );
  } catch (error) {
    // Without a published identity the app cannot adopt this sidecar, so it
    // would fork a second one against the same port.  Stop rather than run
    // unsupervised.
    await terminate(child);
    cleanupCompanionOriginEndpoint(endpoint);
    return { status: "unpublished", reason: "the companion runtime state could not be written" };
  }

  log(`companion sidecar pid=${child.pid} origin=${published.socketPath}`);
  const code = await exit;
  clearManagedCompanionRuntime({ home });
  cleanupCompanionOriginEndpoint(endpoint);
  return { status: "exited", code };
}

export function supervisorArguments(argv) {
  const options = { harnessPort: SUPERVISED_COMPANION_HARNESS_PORT };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`The supervisor argument ${flag} has no value`);
    if (flag === "--harness-port") options.harnessPort = Number(value);
    else if (flag === "--hosted-url") options.hostedUrl = value;
    else throw new Error(`The supervisor argument ${flag} is not supported`);
  }
  if (!Number.isInteger(options.harnessPort) || options.harnessPort <= 0) {
    throw new Error("The supervisor harness port is invalid");
  }
  return options;
}

// Same resolved-text-then-realpath ladder as the guardian: the ESM loader
// realpaths the entry module, so an invocation through a symlinked directory
// (macOS /var -> /private/var) must not be compared as text.
function isEntryModule() {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  if (path.resolve(process.argv[1]) === path.resolve(modulePath)) return true;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(modulePath);
  } catch {
    return false;
  }
}

/** Is the harness this sidecar will talk to actually serving?
 *
 * The sidecar's private origin answers `/api/health` by asking the harness, so
 * an absent harness makes the ownership probe fail even though the sidecar is
 * perfectly healthy. Checking first means the supervisor waits instead of
 * spawning a sidecar it would immediately give up on — and it converges fast
 * after a desktop quit, when the app's own harness releases the data lease and
 * the always-on harness takes over.
 */
async function harnessIsReady(harnessPort, { timeoutMs = 2_000 } = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:${harnessPort}/api/health`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const text = await response.text();
    return Buffer.byteLength(text) <= 4096;
  } catch {
    return false;
  }
}

/** Supervise the sidecar until launchd stops us, restarting it with backoff.
 * One socket per sidecar generation, because the guardian's target is immutable
 * for its lifetime and a reused path with a new pid would keep answering with a
 * dead liveness check. */
export async function superviseCompanion({
  appPath,
  resourcesPath,
  isPackaged = false,
  hostedUrl = null,
  harnessPort = SUPERVISED_COMPANION_HARNESS_PORT,
  home,
  log = (line) => console.log(line),
  runOne = runSupervisedCompanion,
  allocateEndpoint = createCompanionOriginEndpoint,
  probeHarness = harnessIsReady,
  signalSource = process,
} = {}) {
  const resolved = resolveCompanionEntry({
    isPackaged,
    resourcesPath,
    appPath,
    exists: fs.existsSync,
  });
  if (!resolved) {
    log("companion supervisor: no runnable companion entry in this checkout");
    return { status: "missing" };
  }

  let stopping = false;
  signalSource.once?.("SIGINT", () => {
    stopping = true;
  });
  signalSource.once?.("SIGTERM", () => {
    stopping = true;
  });

  // A previous supervisor may have been killed without running its cleanup, so
  // drop its claim before starting. Left in place it would name a supervisor
  // that no longer exists, and the app would refuse to adopt a perfectly good
  // sidecar purely because of a stale number in a file.
  clearManagedCompanionRuntime({ home });

  let attempt = 0;
  while (!stopping) {
    // Wait for the harness before spending a sidecar generation on it. The
    // first attempt after a desktop quit usually loses this race, because the
    // app's own harness has to release the data lease first.
    if (!(await probeHarness(harnessPort))) {
      if (attempt === 0) {
        log(`companion supervisor: waiting for the harness on :${harnessPort}`);
        attempt = 1;
      }
      await delay(RESTART_BASE_MS);
      continue;
    }

    let endpoint;
    try {
      endpoint = allocateEndpoint();
    } catch (error) {
      log(`companion supervisor: private origin could not be allocated — ${error.message}`);
      return { status: "unavailable" };
    }
    const outcome = await runOne({
      ...resolved,
      harnessPort,
      hostedUrl,
      endpoint,
      home,
      log,
    });
    if (stopping) return { status: "stopped" };
    if (outcome.status !== "exited") log(`companion supervisor: ${outcome.reason}`);
    attempt += 1;
    await delay(Math.min(RESTART_BASE_MS * 2 ** (attempt - 1), RESTART_MAX_MS));
  }
  return { status: "stopped" };
}

if (isEntryModule()) {
  const options = supervisorArguments(process.argv.slice(2));
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  // The supervisor lives beside the app it supervises: `<root>/electron/…`.
  const appPath = path.dirname(moduleDirectory);
  const isPackaged = process.resourcesPath?.endsWith?.(".asar") || false;
  superviseCompanion({
    appPath,
    resourcesPath: isPackaged ? process.resourcesPath : path.join(appPath, "electron"),
    isPackaged,
    hostedUrl: options.hostedUrl ?? null,
    harnessPort: options.harnessPort,
  }).then(
    (result) => {
      console.log(`companion supervisor: ${result.status}`);
      process.exit(result.status === "stopped" ? 0 : 1);
    },
    (error) => {
      console.error(`companion supervisor: ${error.message}`);
      process.exit(1);
    },
  );
}