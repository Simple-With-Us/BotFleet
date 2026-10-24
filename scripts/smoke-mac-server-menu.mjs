#!/usr/bin/env node
// Packaged-app smoke for the Server menu.
//
// The Server menu is the only way an owner points the desktop app at another
// BotFleet server, and it cannot be reached by a unit test: it needs a
// packaged app, a real application menu and a real window.  This script
// launches the packaged app with a throwaway HOME, drives the menu handlers
// through the app's own smoke hook, and asserts what came back.
//
// What it proves:
//   - the app starts in remote mode and points at the configured server;
//   - a server that cannot be reached answers with a clean 502 JSON, so a
//     wrong address is a message and not a crash;
//   - the Server menu offers "This Mac" and "Set Remote Server…";
//   - the target file is written, and switching to a remote server and back
//     to this Mac leaves it in the state the menu claims.
//
// What it never does: it never contacts a real server.  The remote address is
// under the reserved .invalid TLD, so nothing can resolve it.
//
// Usage: node scripts/smoke-mac-server-menu.mjs <path to BotFleet.app>

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const REMOTE_URL = "https://botfleet-smoke.invalid:8799";
const SMOKE_TIMEOUT_MS = 120_000;
const EXPECTED_REMOTE_LABEL = `Remote: ${REMOTE_URL}`;

const appPath = process.argv[2];
if (!appPath) {
  console.error("usage: node scripts/smoke-mac-server-menu.mjs <path to BotFleet.app>");
  process.exit(2);
}

// Absolute, because the app is spawned with its cwd in the temp HOME.
const executable = resolve(appPath, "Contents", "MacOS", "BotFleet");
if (!existsSync(executable)) {
  console.error(`no executable at ${executable}`);
  process.exit(1);
}

// A throwaway HOME: the app writes its user-data (and the target file) there,
// so a run never touches the real one.
const home = mkdtempSync(join(tmpdir(), "bf-server-menu-smoke-"));
// macOS resolves the home directory from the password database, not from
// $HOME, so overriding HOME alone would leave `app.getPath("userData")`
// pointing at the owner's real directory and the smoke would overwrite their
// configured server target.  The app is therefore told exactly where its
// user data goes, inside the throwaway HOME.
const userDataDir = join(home, "userData");
mkdirSync(userDataDir, { recursive: true });
// The data directory the harness and the app share, also inside the
// throwaway HOME.
const dataDir = join(home, ".botfleet");
mkdirSync(dataDir, { recursive: true });
// The one thing this script must never do is point the app at a directory
// outside its own throwaway home.  Refuse instead of risking the owner's
// real user data.
if (!resolve(userDataDir).startsWith(`${resolve(home)}${sep}`)) {
  console.error(
    `refusing to run: the smoke user-data directory ${userDataDir} is outside the temporary home ${home}`,
  );
  process.exit(2);
}
const runnerTemp = process.env.RUNNER_TEMP;
const logPath = runnerTemp ? join(runnerTemp, "server-menu-smoke.log") : null;

let output = "";
let report = null;

const child = spawn(executable, [], {
  cwd: home,
  detached: true,
  env: {
    ...process.env,
    HOME: home,
    // The smoke hook itself.
    OMB_SMOKE_SERVER_MENU: "1",
    // Where the app must keep its user data (and the target file it writes).
    OMB_SMOKE_USER_DATA_DIR: userDataDir,
    // Where the app and the harness keep their own data.
    OMB_DATA_DIR: dataDir,
    // The server this launch talks to: unreachable on purpose.
    BOTFLEET_SERVER_URL: REMOTE_URL,
    // The server the menu should switch to.
    OMB_SMOKE_SERVER_URL: REMOTE_URL,
    // No signing identity is needed for an unsigned local build.
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

// A spawn-level failure (EACCES, ENOEXEC) arrives as an 'error' event.  Record
// it so the smoke reports FAIL instead of crashing on an unhandled event.
let spawnError = null;
child.on("error", (error) => {
  spawnError = error instanceof Error ? error.message : String(error);
});

for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    output += chunk;
    const match = output.match(/\[smoke\] server-menu (\{.*\})\r?\n/);
    if (match && !report) report = JSON.parse(match[1]);
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const running = () => spawnError === null && child.exitCode === null && child.signalCode === null;

// The whole process group goes down together: the app spawns children.
async function stopProcess() {
  if (!running()) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  const deadline = Date.now() + 5_000;
  while (running() && Date.now() < deadline) await delay(50);
  if (running()) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}

const deadline = Date.now() + SMOKE_TIMEOUT_MS;
while (!report && Date.now() < deadline) {
  if (!running()) break;
  await delay(100);
}

const exitedEarly = !running();
await stopProcess();

if (logPath) {
  try {
    mkdirSync(runnerTemp, { recursive: true });
    writeFileSync(logPath, output);
  } catch {
    /* the log is a convenience, never the assertion */
  }
}

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

if (spawnError !== null) {
  failures.push(`the app could not be started: ${spawnError}`);
} else if (!report) {
  failures.push(
    exitedEarly
      ? `the app exited (code ${child.exitCode ?? child.signalCode}) before printing the smoke line`
      : `the app printed no "[smoke] server-menu" line within ${SMOKE_TIMEOUT_MS / 1000}s`,
  );
} else {
  check(report.serverMode === "remote", `serverMode must be "remote", got ${JSON.stringify(report.serverMode)}`);
  check(
    report.health?.status === 502 || report.health?.status === 503,
    `the unreachable server must answer 502 or 503, got ${JSON.stringify(report.health)}`,
  );
  check(report.health?.json === true, `the health body must be JSON, got ${JSON.stringify(report.health)}`);
  check(report.error === null || report.error === undefined, `the smoke reported an error: ${report.error}`);

  const labels = report.serverMenu?.labels ?? [];
  check(labels.includes("This Mac"), `the Server menu must offer "This Mac", got ${JSON.stringify(labels)}`);
  check(
    labels.includes("Set Remote Server…"),
    `the Server menu must offer "Set Remote Server…", got ${JSON.stringify(labels)}`,
  );

  check(
    report.targetFile?.exists === true,
    "the target file must exist after \"Set Remote Server…\" was clicked",
  );

  const remoteLabels = report.remote?.labels ?? [];
  check(
    remoteLabels.includes(EXPECTED_REMOTE_LABEL),
    `the Server menu must list "${EXPECTED_REMOTE_LABEL}", got ${JSON.stringify(remoteLabels)}`,
  );
  check(report.remote?.mode === "remote", `the target file must say "remote", got ${JSON.stringify(report.remote?.mode)}`);

  const localLabels = report.local?.labels ?? [];
  check(report.local?.mode === "local", `the target file must say "local", got ${JSON.stringify(report.local?.mode)}`);
  check(
    localLabels.includes(EXPECTED_REMOTE_LABEL),
    `the Server menu must still list "${EXPECTED_REMOTE_LABEL}" after switching back, got ${JSON.stringify(localLabels)}`,
  );

  // The target file on disk, in the throwaway user-data directory the app
  // was pointed at.  It is checked with explicit assertions instead of a
  // schema: this script is deliberately dependency-free so it can run
  // before the app's dependencies exist, and it asserts on every field it
  // reads.
  const targetFile = join(userDataDir, "server-target.json");
  check(existsSync(targetFile), `the target file must exist at ${targetFile}`);
  if (existsSync(targetFile)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(targetFile, "utf8"));
    } catch (error) {
      check(false, `the target file must be valid JSON: ${String(error?.message ?? error)}`);
    }
    if (parsed !== undefined) {
      check(
        Object.prototype.toString.call(parsed) === "[object Object]",
        `the target file must be a JSON object, got ${JSON.stringify(parsed)}`,
      );
      check(parsed.mode === "local", `the target file must end in "local", got ${JSON.stringify(parsed.mode)}`);
      check(!parsed.token, "the target file must not carry a token");
    }
  }
}

// The app must not have crashed.  It printed the line and was still running
// when the smoke killed it, or it quit by itself with a clean exit code; a
// nonzero exit on its own is a crash.
if (exitedEarly) {
  check(
    child.exitCode === 0,
    `the app exited with code ${child.exitCode ?? child.signalCode} before the smoke finished`,
  );
}

try {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
  /* the OS will reap it; the assertions above are what matter */
}

if (failures.length > 0) {
  console.error("FAIL: the packaged Server menu smoke did not pass:");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error("--- app output ---");
  console.error(output);
  process.exit(1);
}

console.log(
  `PASS: server mode ${report.serverMode}, health ${report.health.status} JSON, ` +
    `menu [${report.serverMenu.labels.join(", ")}], ` +
    `remote mode ${report.remote.mode}, back to ${report.local.mode}.`,
);
