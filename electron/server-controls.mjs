import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const bundleName = "BotFleet Control.app";
const bundleId = "app.botfleet.control.macos";

export async function shutdownAttachedServer(port, { request = fetch, timeout = 300_000 } = {}) {
  const response = await request(`http://127.0.0.1:${port}/api/system/control/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(timeout),
    redirect: "error",
  });
  const report = await response.json();
  if (!response.ok || report?.ok !== true) {
    throw new Error(report?.error || report?.detail?.localVmNote || "The server did not confirm shutdown");
  }
}

function checkBundle(bundle) {
  if (lstatSync(bundle).isSymbolicLink()) throw new Error("The control app must be a regular app bundle");
  const plist = readFileSync(path.join(bundle, "Contents", "Info.plist"), "utf8");
  if (!plist.includes(`<string>${bundleId}</string>`)) throw new Error("Unexpected control app identity");
}

// Install only on an explicit owner action.  A running copy stays in place;
// the next open after it quits can adopt the new packaged version safely.
export function installServerControls(source, {
  applications = path.join(os.homedir(), "Applications"),
  isRunning = () => {
    try { execFileSync("/usr/bin/pgrep", ["-x", "BotFleetControl"], { stdio: "ignore" }); return true; }
    catch (error) { if (error.status === 1) return false; throw error; }
  },
} = {}) {
  checkBundle(source);
  const target = path.join(applications, bundleName);
  if (existsSync(target)) {
    checkBundle(target);
    if (isRunning()) return target;
  }
  mkdirSync(applications, { recursive: true });
  const staging = path.join(applications, `.BotFleet-Control-${process.pid}.app`);
  const previous = path.join(applications, `.BotFleet-Control-${process.pid}.previous`);
  if (existsSync(staging) || existsSync(previous)) throw new Error("A control app installation is already staged");
  try {
    cpSync(source, staging, { recursive: true, dereference: false });
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

export async function openServerControls({ source, shell, dialog }) {
  try {
    const installed = installServerControls(source);
    const error = await shell.openPath(installed);
    if (error) throw new Error(error);
  } catch (error) {
    dialog.showErrorBox("Could Not Open Server Controls", error instanceof Error ? error.message : String(error));
  }
}
