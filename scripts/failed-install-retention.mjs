import { basename, dirname, join } from "node:path";

/**
 * Failed-install bundle retention — shared by the Mac updater and the harness
 * boot sweep so they agree on names, caps, and which paths are ours to delete.
 */

/**
 * How many failed-install bundles to keep beside the installed app.
 *
 * Three is enough to diagnose a bad update without letting a flapping updater
 * fill the disk.  Each one is a full copy of the app.
 */
export const FAILED_INSTALL_KEEP = 3;

export function failedInstallBundles(names, bundleName) {
  return names.filter((name) => name.startsWith(`${bundleName}.failed-`));
}

export function failedInstallStamp(name, bundleName) {
  const prefix = `${bundleName}.failed-`;
  if (!name.startsWith(prefix)) return null;
  const stamp = Number(name.slice(prefix.length));
  return Number.isSafeInteger(stamp) && stamp > 0 ? stamp : null;
}

/**
 * Which failed-install bundle names are past the retention cap: the oldest
 * ones, keeping the `keep` newest.  A bundle whose stamp does not parse is
 * never pruned.
 */
export function failedInstallBundlesToPrune(names, bundleName, keep = FAILED_INSTALL_KEEP) {
  const stamped = [];
  for (const name of names) {
    const stamp = failedInstallStamp(name, bundleName);
    if (stamp !== null) stamped.push({ name, stamp });
  }
  stamped.sort((a, b) => b.stamp - a.stamp);
  return stamped.slice(Math.max(0, keep)).map((entry) => entry.name);
}

/**
 * Remove expired failed-install bundles from disk.  Only names this updater
 * recognises beside `appPath` are considered; returns paths removed.
 */
export function pruneFailedInstallBundles(appPath, options = {}) {
  const { keep = FAILED_INSTALL_KEEP, listNames, remove } = options;
  const bundleName = basename(appPath);
  const appDir = dirname(appPath);
  if (!bundleName) return { removed: [], failures: [] };
  const present = listNames(appDir);
  const removed = [];
  const failures = [];
  for (const name of failedInstallBundlesToPrune(present, bundleName, keep)) {
    const path = join(appDir, name);
    if (dirname(path) !== appDir) continue;
    try {
      remove(path);
      removed.push(path);
    } catch (error) {
      failures.push({ path, error });
    }
  }
  return { removed, failures };
}
