// In-app auto-updater (electron-updater). Downloads are user-driven; macOS
// stages the downloaded ZIP immediately and the explicit restart applies it.
// One state object is broadcast on every transition.
//
// Only runs in the packaged, signed+notarized app (mac auto-update requires
// signing). In dev it's a no-op so the browser/dev shell is unaffected.
// electron-updater is vendored (electron/vendor/electron-updater.cjs) because
// the packaged app ships no node_modules.
import { app, ipcMain } from "electron";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";
import {
  AUTO_CHECK_THROTTLE_MS,
  macAppFingerprint,
  readAutoUpdateConfig,
  recordAutomaticCheck,
  shouldRunAutomaticCheck,
} from "./updater-throttle.mjs";

const require = createRequire(import.meta.url);

// Throttle window: the auto-check interval is a poll, not a contract.  The
// user-visible cadence is "no more than once per 6 hours", so the timers
// stay short (so the user sees a fresh result quickly after turning the
// setting on) but every tick consults `shouldRunAutomaticCheck` first.
const POLL_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 15_000;

let autoUpdater = null;
let win = null;
// status: idle | checking | available | downloading | downloaded | installing | error
let state = { status: "idle", canLocalUpdate: false };
let updaterCoordinator = null;
let autoUpdateEnabled = false;

function localUpdateScript() {
  return join(homedir(), "apps", "update-botfleet.sh");
}

function canLocalUpdate() {
  return process.platform === "darwin" && existsSync(localUpdateScript());
}

function updaterLogger() {
  const directory = app.getPath("logs");
  const file = join(directory, "updater.log");
  const write = (level, values) => {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const message = values
        .map((value) => (value instanceof Error ? value.stack ?? value.message : String(value)))
        .join(" ");
      appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${message}\n`, { mode: 0o600 });
    } catch {
      // Logging must never make updating unavailable.
    }
  };
  return Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [level, (...values) => write(level, values)]));
}

function setState(patch) {
  state = { ...state, canLocalUpdate: canLocalUpdate(), ...patch };
  try {
    win?.webContents?.send("update:state", state);
  } catch {
    /* window gone */
  }
}

function configPath() {
  return join(
    process.env.OMB_DATA_DIR || process.env.BOTFLEET_DATA_DIR || join(homedir(), ".botfleet"),
    "config.json",
  );
}

function recordSuccessfulAutoCheck() {
  if (!autoUpdateEnabled) return;
  // PATCH the same file the harness reads so the next tick and the next
  // launch agree.  The actual read-modify-write lives in
  // updater-throttle.mjs's `recordAutomaticCheck` so it can be unit-tested
  // against a real temp file without an `electron` runtime (this module
  // imports `electron` at the top, which plain `node --test` can't load).
  //
  // Previously this stopped at `appendFileSync(path, "")` — a no-op touch
  // that never wrote `disk` back, so `lastCheckMs` never reached disk and
  // the 6-hour throttle never actually engaged.
  try {
    recordAutomaticCheck(configPath(), { enabled: autoUpdateEnabled, fingerprint: macAppFingerprint() });
  } catch {
    /* never let the check fail because we could not persist */
  }
}

export function registerUpdaterIpc() {
  ipcMain.handle("update:get-state", () => state);
  // Manual check always bypasses the 6-hour throttle — the whole point
  // of the button is "ask now", and the Settings copy says so.
  ipcMain.handle("update:check", () => updaterCoordinator?.check(true));
  ipcMain.handle("update:download", () => updaterCoordinator?.download());
  ipcMain.handle("update:install", () => updaterCoordinator?.install());
  ipcMain.handle("update:set-enabled", (_event, enabled) => {
    autoUpdateEnabled = Boolean(enabled);
    // manual=true: the coordinator only reports a failure back to the
    // renderer (vs. silently going idle) when the caller is manual. Flipping
    // the toggle on is a user-initiated action just like pressing "Check for
    // updates", so it should surface an error the same way instead of
    // swallowing it.
    if (autoUpdateEnabled) void updaterCoordinator?.check(true);
  });
  ipcMain.handle("update:local", () => {
    const script = localUpdateScript();
    if (!canLocalUpdate()) {
      setState({ status: "error", message: "No local update script on this Mac." });
      return;
    }
    setState({ status: "installing", message: "Updating from this Mac…" });
    const child = spawn("/bin/bash", [script], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, BOTFLEET_CHECKOUT: join(homedir(), "apps", "botfleet-server") },
    });
    const LOCAL_UPDATE_TIMEOUT_MS = 2 * 60 * 1000;
    const timer = setTimeout(() => {
      setState({
        status: "error",
        message: "The local update did not finish. Quit the app and try again.",
      });
    }, LOCAL_UPDATE_TIMEOUT_MS);
    timer.unref?.();
    child.on("error", (error) => {
      clearTimeout(timer);
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "The local update could not start.",
      });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code && code !== 0) {
        setState({
          status: "error",
          message: `The local update exited ${code}. Try again from this Mac.`,
        });
      }
    });
    child.unref();
  });
}

export function startUpdater(mainWindow) {
  win = mainWindow;
  // dev / unsigned builds can't auto-update — leave the banner dormant
  if (!app.isPackaged) {
    updaterCoordinator = null;
    setState({ status: "idle" });
    return;
  }

  try {
    const config = readAutoUpdateConfig(configPath());
    // Always wire the coordinator in packaged apps so enabling the setting
    // or pressing Check for updates works without a restart. Automatic
    // periodic checks still honor autoUpdate.enabled below.
    autoUpdateEnabled = config.enabled === true;
  } catch (e) {
    autoUpdateEnabled = false;
  }

  try {
    ({ autoUpdater } = require("./vendor/electron-updater.cjs"));
  } catch {
    updaterCoordinator = null;
    setState({ status: "error", message: "updater unavailable" });
    return;
  }
  autoUpdater.autoDownload = false; // button-driven download
  // Squirrel.Mac has a second, native staging pass after the ZIP download.
  // Start it immediately so "Restart to update" never has to begin that slow
  // pass and wait indefinitely. Windows keeps the explicit installer click.
  autoUpdater.autoInstallOnAppQuit = process.platform === "darwin";
  autoUpdater.logger = updaterLogger();

  updaterCoordinator = createUpdaterCoordinator(autoUpdater, setState);

  // Wrap the coordinator so a successful check is what actually counts
  // as "last checked".  The coordinator's `check` resolves to `{ ok }`
  // rather than throwing, so a rejected `checkForUpdates()` (network
  // hiccup, update-service outage) resolves `ok: false` and must not be
  // recorded — recording it would throttle every automatic retry for the
  // next 6 hours over one transient failure.  Only the timer-driven ticks
  // route through here; the manual "Check for updates" button and the
  // set-enabled handler call the coordinator directly and do not persist
  // a timestamp themselves.
  const trackedCheck = (manual) => {
    const promise = updaterCoordinator?.check(manual);
    if (promise && typeof promise.then === "function") {
      promise.then((result) => {
        if (result?.ok !== false) recordSuccessfulAutoCheck();
      }).catch(() => {});
    }
    return promise;
  };

  // Re-read the persisted record and compare it against the fingerprint of
  // the bundle running *right now*.  A mismatch means an out-of-band
  // reinstall landed since the last recorded check — new information the
  // 6-hour window has not seen — so it bypasses the throttle the same way
  // "never checked" does.
  const dueForAutomaticCheck = () => {
    const record = readAutoUpdateConfig(configPath());
    return shouldRunAutomaticCheck({
      enabled: autoUpdateEnabled,
      lastCheckMs: record.lastCheckMs,
      lastAppFingerprint: record.lastAppFingerprint,
      currentFingerprint: macAppFingerprint(),
    });
  };

  // First automatic check ~15s after launch (let the app settle), then
  // hourly — both silent on failure.  Every tick consults
  // `shouldRunAutomaticCheck`, which combines the toggle, the 6-hour
  // throttle, and the bundle-fingerprint bypass into a single decision.
  // Manual "Check for updates" always works once the coordinator exists.
  // Timers stay armed so enabling the setting later takes effect without
  // a restart; they no-op while autoUpdateEnabled is false.
  setTimeout(() => {
    if (dueForAutomaticCheck()) {
      void trackedCheck(false);
    }
  }, FIRST_CHECK_DELAY_MS).unref?.();
  setInterval(() => {
    if (dueForAutomaticCheck()) {
      void trackedCheck(false);
    }
  }, POLL_INTERVAL_MS).unref?.();
}

// Exposed for tests; the helpers themselves live in updater-throttle.mjs.
export { AUTO_CHECK_THROTTLE_MS };
