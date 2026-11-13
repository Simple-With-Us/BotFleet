import { closeSync, constants, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const bundleName = "BotFleet Control.app";
const bundleId = "app.botfleet.control.macos";
export const UPDATE_CONTROL_ARGUMENT = "--update-control";

function controlIsRunning() {
  try { execFileSync("/usr/bin/pgrep", ["-x", "BotFleetControl"], { stdio: "ignore" }); return true; }
  catch (error) { if (error.status === 1) return false; throw error; }
}

export async function shutdownAttachedServer(port, { request = fetch, timeout = 300_000 } = {}) {
  let response;
  try {
    response = await request(`http://127.0.0.1:${port}/api/system/control/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(timeout),
      redirect: "error",
    });
  } catch (error) {
    // A refused loopback connection means the server has already stopped.
    if (error instanceof TypeError && /fetch failed|ECONNREFUSED/i.test(error.message)) return;
    throw error;
  }
  const report = await response.json();
  if (!response.ok || report?.ok !== true) {
    throw new Error(report?.error || report?.detail?.localVmNote || "The server did not confirm shutdown");
  }
}

function checkBundle(bundle) {
  if (lstatSync(bundle).isSymbolicLink()) throw new Error("The control app must be a regular app bundle");
  const plistPath = path.join(bundle, "Contents", "Info.plist");
  const fd = openSync(plistPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let plist;
  try {
    const handle = fstatSync(fd);
    const current = statSync(plistPath);
    if (!handle.isFile() || handle.nlink !== 1 || handle.dev !== current.dev || handle.ino !== current.ino) {
      throw new Error("Unsafe control app metadata path");
    }
    plist = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  if (!plist.includes(`<string>${bundleId}</string>`)) throw new Error("Unexpected control app identity");
  return plist;
}

// Install only on an explicit owner action.  A running copy stays in place;
// the next open after it quits can adopt the new packaged version safely.
export function installServerControls(source, {
  applications = path.join(os.homedir(), "Applications"),
  isRunning = controlIsRunning,
  requireStopped = false,
  expectedRelease = null,
} = {}) {
  checkBundle(source);
  const target = path.join(applications, bundleName);
  if (existsSync(target)) {
    checkBundle(target);
    if (isRunning()) {
      if (requireStopped) throw new Error("Control is still running, so its bundle was not replaced.");
      return target;
    }
  }
  mkdirSync(applications, { recursive: true });
  const staging = path.join(applications, `.BotFleet-Control-${process.pid}.app`);
  const previous = path.join(applications, `.BotFleet-Control-${process.pid}.previous`);
  if (existsSync(staging) || existsSync(previous)) throw new Error("A control app installation is already staged");
  try {
    cpSync(source, staging, { recursive: true, dereference: false });
    if (expectedRelease) {
      const staged = controlRelease(staging);
      if (!staged || staged.version !== expectedRelease.version || staged.build !== expectedRelease.build) {
        throw new Error("The bundled Control release changed during the update, so no bundle was replaced.");
      }
    }
    if (requireStopped && isRunning()) throw new Error("Control restarted while its update was staged, so its bundle was not replaced.");
    if (existsSync(target)) renameSync(target, previous);
    try { renameSync(staging, target); }
    catch (error) {
      if (existsSync(previous)) renameSync(previous, target);
      throw error;
    }
    rmSync(previous, { recursive: true, force: true });
    return target;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Read only numeric release metadata, never a server-supplied install path. */
export function controlRelease(bundle) {
  const plist = checkBundle(bundle);
  const value = (key) => new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(plist)?.[1];
  const version = value("CFBundleShortVersionString");
  const build = value("CFBundleVersion");
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "") || !/^\d+(?:\.\d+){0,2}$/.test(build ?? "") ||
      version.length > 64 || build.length > 64) return null;
  return { version, build };
}

function compareBuild(left, right) {
  const a = left.split(".").map(BigInt);
  const b = right.split(".").map(BigInt);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const first = a[index] ?? 0n;
    const second = b[index] ?? 0n;
    if (first !== second) return first > second ? 1 : -1;
  }
  return 0;
}

/** The explicit update transaction: confirm, quit normally, observe exit,
 * then reuse the staged installer and reopen the installed Control app. */
export async function updateServerControls({
  source, shell, dialog,
  applications = path.join(os.homedir(), "Applications"),
  isRunning = controlIsRunning,
  requestQuit = () => execFileSync("/usr/bin/osascript", ["-e", 'tell application id "app.botfleet.control.macos" to quit'], { timeout: 10_000, stdio: "ignore" }),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  try {
    const replacement = controlRelease(source);
    const target = path.join(applications, bundleName);
    const installed = existsSync(target) ? controlRelease(target) : null;
    if (!replacement || (existsSync(target) && !installed)) {
      throw new Error("Control's release version or build is unknown, so no bundle was replaced.");
    }
    if (installed && compareBuild(replacement.build, installed.build) <= 0) {
      throw new Error("The bundled Control package is not newer than the installed Control app.\u00A0 Update BotFleet to obtain a newer bundled package.");
    }
    const selection = await dialog.showMessageBox({
      type: "question",
      title: "Update Control",
      message: `Install Control ${replacement.version} (build ${replacement.build})?`,
      detail: "Control will quit and reopen after its bundled update is installed.\u00A0 Saved servers and tokens stay in place.\u00A0 The server keeps running.",
      buttons: ["Cancel", "Update Control"], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (selection.response !== 1) return false;
    if (isRunning()) await requestQuit();
    for (let attempt = 0; attempt < 40 && isRunning(); attempt += 1) await sleep(250);
    if (isRunning()) throw new Error("Control did not quit, so its bundle was not replaced.\u00A0 Finish any active Control action and try again.");
    const current = existsSync(target) ? controlRelease(target) : null;
    if (JSON.stringify(current) !== JSON.stringify(installed)) {
      throw new Error("The installed Control release changed during the update, so no bundle was replaced.");
    }
    const bundle = installServerControls(source, { applications, isRunning, requireStopped: true, expectedRelease: replacement });
    const error = await shell.openPath(bundle);
    if (error) throw new Error(error);
    return true;
  } catch (error) {
    dialog.showErrorBox("Could Not Update Control", error instanceof Error ? error.message : String(error));
    return false;
  }
}

export async function openServerControls({ source, shell, dialog }) {
  try {
    const installed = installServerControls(source);
    const error = await shell.openPath(installed);
    if (error) throw new Error(error);
  } catch (error) {
    dialog.showErrorBox("Could Not Open Server Controls", error instanceof Error ? error.message : String(error));
  }
}
