// Pure helpers extracted from updater.mjs so the 6-hour throttle, the Mac
// app fingerprint, and the auto-check decision can be unit-tested without
// importing the `electron` package (which only exists in the packaged
// runtime — the test runner is plain Node).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const AUTO_CHECK_THROTTLE_MS = 6 * 60 * 60 * 1000;

/** The harness- and electron-side read of the persisted autoUpdate config.
 * Always returns an object; a missing file or invalid JSON is "no
 * information", which is the same as the user never having enabled
 * automatic updates. */
export function readAutoUpdateConfig(configPath) {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    return parsed?.autoUpdate ?? {};
  } catch {
    return {};
  }
}

/** Persist a completed automatic-update check to disk: read-modify-write
 * just the `autoUpdate` section of `configPath` so the next tick and the
 * next launch agree on `lastCheckMs` (and `lastAppFingerprint`).
 *
 * A missing or unparsable file is "first write" -- not an error -- since
 * that is the state of a fresh install.  The write is temp-file-then-rename
 * (matching electron/main.mjs's own config migrations) so a crash mid-write
 * leaves the previous config intact instead of truncated JSON the harness
 * can't parse on the next launch.
 *
 * Exported (and pure aside from the fs calls) so it can be exercised
 * against a real temp file without an `electron` runtime -- updater.mjs
 * imports `electron` at module scope, which plain `node --test` cannot
 * load, so the disk I/O for the throttle lives here instead of there. */
export function recordAutomaticCheck(configPath, { enabled, fingerprint } = {}) {
  let disk = {};
  try {
    disk = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    /* first write, or an unreadable file — start fresh */
  }
  disk.autoUpdate = nextAutoUpdateRecord(disk.autoUpdate ?? {}, { fingerprint });
  // preserve the live enabled state — the record helper does not know it
  disk.autoUpdate.enabled = Boolean(enabled);
  const directory = join(configPath, "..");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(disk, null, 2), { mode: 0o600 });
  renameSync(temporary, configPath);
}

/** True when an automatic check is allowed to run right now.  Manual checks
 * bypass this entirely and must not consult it.
 *
 * `config.currentFingerprint`, when supplied alongside a stored
 * `config.lastAppFingerprint`, lets an out-of-band reinstall (a build that
 * landed on disk between two checks, outside the updater's own download +
 * install path) surface immediately instead of waiting out the rest of the
 * 6-hour window: a changed bundle is new information the throttle has not
 * seen yet, so it is treated the same as "never checked". */
export function shouldRunAutomaticCheck(config, nowMs = Date.now()) {
  if (config?.enabled !== true) return false;
  const last = config?.lastCheckMs;
  if (typeof last !== "number" || !Number.isFinite(last) || last < 0) return true;
  if (
    typeof config?.currentFingerprint === "string" &&
    typeof config?.lastAppFingerprint === "string" &&
    config.currentFingerprint !== config.lastAppFingerprint
  ) {
    return true;
  }
  return nowMs - last >= AUTO_CHECK_THROTTLE_MS;
}

/** Extract the CFBundleVersion (the per-build counter the pipeline writes
 * on every ship) from a raw Info.plist XML.  Matches the format
 * electron-builder produces; we don't ship a plist parser dependency
 * because the relevant field is a flat string. */
function extractCFBundleVersion(plistText) {
  const match = plistText.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/);
  return match ? match[1].trim() : null;
}

/** The .app bundle root a macOS executable path launched from, three
 * segments below it (Contents/MacOS/<name>) -- or null when the path
 * doesn't look like a bundled executable (a dev/unpackaged run, for
 * instance).  Used to prefer the bundle this exact process is running
 * from over a static list of "well-known install locations". */
function bundleFromExecPath(execPath) {
  if (typeof execPath !== "string" || !execPath) return null;
  const macosDir = dirname(execPath);
  if (basename(macosDir) !== "MacOS") return null;
  const contentsDir = dirname(macosDir);
  if (basename(contentsDir) !== "Contents") return null;
  const bundle = dirname(contentsDir);
  return bundle.endsWith(".app") ? bundle : null;
}

/** Compute a short fingerprint of the running Mac app bundle so a
 * reinstall that landed an out-of-band build between checks still shows
 * up as "different from last known" on the next cycle.  Returns null on
 * a non-darwin platform, when the app is not installed, or when the
 * bundle cannot be read — that is a legitimate answer and the timer
 * just won't have anything to compare against.
 *
 * `options` lets tests pass a custom CFBundleVersion reader and stat
 * provider so they do not have to write a real Info.plist to disk. */
export function macAppFingerprint(options = {}) {
  if ((options.platform ?? process.platform) !== "darwin") return null;
  const readVersion = options.readVersion ?? extractCFBundleVersion;
  const statSyncFn = options.statSync ?? statSync;
  const existsSyncFn = options.existsSync ?? existsSync;
  const readFileSyncFn = options.readFileSync ?? readFileSync;
  // The bundle this exact process launched from, when it can be told from
  // Electron's own process.execPath.  Checked FIRST, ahead of the static
  // "well-known install location" list below: two installs can coexist on
  // one Mac (a fresh drag-install into ~/Applications next to an old
  // /Applications copy), and picking "whichever exists first" from a
  // static list in that case fingerprints whichever bundle happens to be
  // listed first -- not necessarily the one actually running -- which can
  // both hide a real reinstall of the running copy and spuriously bypass
  // the throttle over an unrelated, dormant copy changing.
  const runningBundle = bundleFromExecPath(options.processExecPath ?? process.execPath);
  const candidates = options.candidates ?? [
    ...(runningBundle ? [runningBundle] : []),
    "/Applications/BotFleet.app",
    join(options.home ?? process.env.HOME ?? "", "Applications", "BotFleet.app"),
  ];
  let infoPlist = null;
  let matchedBundle = null;
  for (const candidate of candidates) {
    const path = join(candidate, "Contents", "Info.plist");
    if (existsSyncFn(path)) {
      infoPlist = path;
      matchedBundle = candidate;
      break;
    }
  }
  if (!infoPlist) return null;
  let infoPlistBytes;
  try {
    infoPlistBytes = readFileSyncFn(infoPlist);
  } catch {
    return null;
  }
  const plistText = infoPlistBytes.toString("utf8");
  const version = readVersion(plistText) ?? "unknown";
  // Hash the executable from the SAME bundle Info.plist was just read from
  // -- not a hardcoded `/Applications/BotFleet.app`. A user-local install
  // (`~/Applications/BotFleet.app`, which `candidates` already supports)
  // would otherwise always hash a nonexistent or unrelated system-wide
  // binary, so a local rebuild that keeps the same CFBundleVersion could
  // never be told apart from the previous run for that install.
  const execPath = options.execPath ?? join(matchedBundle, "Contents", "MacOS", "BotFleet");
  let size = 0;
  let mtime = 0;
  if (existsSyncFn(execPath)) {
    try {
      const stats = statSyncFn(execPath);
      size = stats.size;
      mtime = Math.floor(stats.mtimeMs);
    } catch {
      /* leave at 0 */
    }
  }
  const execHash = createHash("sha1").update(`${size}:${mtime}`).digest("hex").slice(0, 12);
  return `${version}:${execHash}`;
}

/** Compose a fresh autoUpdate record.  The caller is responsible for
 * merging it into the existing config (other fields like `enabled` must
 * not be lost).  `options.fingerprint` may be a string, `null` (skip
 * the fingerprint), or `undefined` (compute a fresh one). */
export function nextAutoUpdateRecord(currentRecord, options = {}) {
  const next = { ...(currentRecord ?? {}) };
  next.lastCheckMs = options.nowMs ?? Date.now();
  if (options.fingerprint === null) {
    /* explicit skip — caller knows there is no bundle to read */
  } else if (typeof options.fingerprint === "string") {
    next.lastAppFingerprint = options.fingerprint;
  } else {
    const fingerprint = macAppFingerprint();
    if (fingerprint) next.lastAppFingerprint = fingerprint;
  }
  return next;
}
