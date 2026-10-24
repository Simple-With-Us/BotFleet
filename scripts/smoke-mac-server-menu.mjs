#!/usr/bin/env node
// Packaged-app smoke for the Server menu.
//
// The Server menu is the only way an owner sees where the desktop app points
// and the only way the app reads that point again, and it cannot be reached
// by a unit test: it needs a packaged app, a real application menu and a real
// window.  This script launches the packaged app with a throwaway HOME,
// drives the menu handlers through the app's own smoke hook, and asserts
// what came back.
//
// What it proves:
//   - the app reads its server target from Infisical and nowhere else;
//   - a runner with no Infisical read token in the Keychain runs against
//     the server on this Mac, and the menu says so;
//   - the old server-target.json is ignored: it is flagged, never read, and
//     never rewritten;
//   - the Server menu offers "This Mac", the Infisical status line and
//     "Reload from Infisical", and no longer offers "Set Remote Server…";
//   - "Reload from Infisical" is safe to click: the app keeps running.
//
// What it never does: it never contacts a real server and it never reaches
// the owner's Keychain, its user data or its server target.
//
// Usage: node scripts/smoke-mac-server-menu.mjs <path to BotFleet.app>

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

// The budget covers the app's own worst case before it prints the line.  A
// runner with no Infisical read token runs against the server on this Mac,
// so the app boots its local harness before the window exists, and that boot
// may take two passes over three ports with a 60s health wait each (6 min)
// before the app gives up and shows its error page.  Then the window load
// (20s at most), the health probe (15s) and the Keychain read on reload
// (10s).  The old 120s budget was set when the smoke ran in remote mode and
// never booted the harness; it timed out before the window was ever made.
const SMOKE_TIMEOUT_MS = 480_000;

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

// A throwaway HOME: the app writes its user-data there, so a run never
// touches the real one.
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

// The old target file, written before the launch.  The app must ignore it:
// it is flagged, it is never read, and it is never rewritten.  The token in
// it is generated at run time — a literal that looks like a secret would be
// a secret in the repository.
const legacyTargetFile = join(userDataDir, "server-target.json");
const legacyTarget = {
  mode: "remote",
  url: "http://127.0.0.1:9",
  token: randomBytes(16).toString("hex"),
};
const legacyTargetText = `${JSON.stringify(legacyTarget, null, 2)}\n`;
writeFileSync(legacyTargetFile, legacyTargetText);

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
    // Where the app must keep its user data.
    OMB_SMOKE_USER_DATA_DIR: userDataDir,
    // Where the app and the harness keep their own data.
    OMB_DATA_DIR: dataDir,
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

// "Never started" and "exited early" are different failures:  a spawn error
// is reported on its own, and is never also counted as a crash.
const exitedEarly = spawnError === null && !running();
await stopProcess();

// The app's own log, from the throwaway user-data directory.  The app writes
// its startup steps (server target, harness boot, window) there and not to
// stdout, so without it a timeout says nothing about where the app stopped.
// The runner holds no secrets, and the only token-shaped value in this run
// is the random one in the legacy file, which the app never reads.
let appLog = "";
try {
  appLog = readFileSync(join(userDataDir, "logs", "server.log"), "utf8");
} catch {
  appLog = "(the app wrote no server.log)\n";
}

if (logPath) {
  try {
    mkdirSync(runnerTemp, { recursive: true });
    writeFileSync(logPath, `${output}\n--- app server.log ---\n${appLog}`);
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
  // The runner has no Infisical read token in its Keychain, so the app runs
  // against the server on this Mac and says where that came from.
  check(
    report.serverMode === "local",
    `serverMode must be "local", got ${JSON.stringify(report.serverMode)}`,
  );
  check(
    report.source === "not-enrolled",
    `source must be "not-enrolled", got ${JSON.stringify(report.source)}`,
  );
  check(report.legacyFile === true, `legacyFile must be true, got ${JSON.stringify(report.legacyFile)}`);
  check(report.error === null || report.error === undefined, `the smoke reported an error: ${report.error}`);

  const labels = report.serverMenu?.labels ?? [];
  check(labels.includes("This Mac"), `the Server menu must offer "This Mac", got ${JSON.stringify(labels)}`);
  check(
    labels.includes("No Infisical read token in the Keychain"),
    `the Server menu must say it has no Infisical read token, got ${JSON.stringify(labels)}`,
  );
  check(
    labels.includes("Reload from Infisical"),
    `the Server menu must offer "Reload from Infisical", got ${JSON.stringify(labels)}`,
  );
  check(
    !labels.some((label) => label.includes("Set Remote Server")),
    `the Server menu must no longer offer "Set Remote Server…", got ${JSON.stringify(labels)}`,
  );

  // The reload reads Infisical again.  Nothing changed, so the app has to be
  // exactly where it was.
  const reloadLabels = report.reload?.labels ?? [];
  check(
    reloadLabels.includes("Reload from Infisical"),
    `the Server menu must still offer "Reload from Infisical" after the reload, got ${JSON.stringify(reloadLabels)}`,
  );
  check(
    report.reload?.mode === "local",
    `the server mode after the reload must be "local", got ${JSON.stringify(report.reload?.mode)}`,
  );

  // The old target file is ignored: the app flagged it, read nothing from it
  // and wrote nothing back to it.
  check(existsSync(legacyTargetFile), `the legacy target file must still be there at ${legacyTargetFile}`);
  if (existsSync(legacyTargetFile)) {
    const after = readFileSync(legacyTargetFile, "utf8");
    check(after === legacyTargetText, "the app must not rewrite the legacy target file");
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
  console.error("--- app server.log ---");
  console.error(appLog);
  process.exit(1);
}

console.log(
  `PASS: server mode ${report.serverMode} (${report.source}), legacy file ${report.legacyFile}, ` +
    `menu [${report.serverMenu.labels.join(", ")}], ` +
    `reload mode ${report.reload.mode}.`,
);
