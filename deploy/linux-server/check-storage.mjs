import { realpathSync, statSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

export const STORAGE_OFFLINE_EXIT_CODE = 78;

/** Reads device identity without creating a missing directory. */
export function checkStorageDevice(dataDir, stat = statSync, expectedDevice) {
  let rootDevice = null;
  let dataDevice = null;
  try {
    const identity = (path) => {
      const value = stat(path).dev;
      if (typeof value === "bigint" ? value < 0n : !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid device identity");
      return String(value);
    };
    rootDevice = identity("/");
    dataDevice = identity(dataDir);
  } catch {
    return { online: false, dataDevice, rootDevice, reason: `data dir ${dataDir} is unavailable; refusing to start` };
  }
  if (dataDevice === rootDevice) return { online: false, dataDevice, rootDevice, reason: `data dir ${dataDir} is on the root device; refusing to start` };
  if (expectedDevice !== undefined && dataDevice !== expectedDevice) return { online: false, dataDevice, rootDevice, reason: `data dir ${dataDir} changed device; refusing new jobs until the server restarts` };
  return { online: true, dataDevice, rootDevice };
}

export function storageDeviceGuard(dataDir, stat = statSync) {
  const initial = checkStorageDevice(dataDir, stat);
  const expected = initial.online ? initial.dataDevice : undefined;
  return { initial, sample: () => checkStorageDevice(dataDir, stat, expected) };
}

let entry = false;
try {
  const modulePath = fileURLToPath(import.meta.url);
  entry = basename(modulePath) === "check-storage.mjs" && realpathSync(process.argv[1]) === realpathSync(modulePath);
} catch { /* imported or bundled into the harness */ }
if (entry) {
  if (process.argv.length !== 3 || !process.argv[2].startsWith("/")) {
    console.error("usage: node deploy/linux-server/check-storage.mjs /absolute/data-directory");
    process.exitCode = 2;
  } else {
    const state = checkStorageDevice(process.argv[2]);
    if (!state.online) {
      console.error(state.reason);
      process.exitCode = STORAGE_OFFLINE_EXIT_CODE;
    }
  }
}
