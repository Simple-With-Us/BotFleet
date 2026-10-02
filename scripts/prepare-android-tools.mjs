// Stage Google's official Android Platform Tools beside the packaged app so
// USB phone support works on a clean machine without Homebrew or an SDK.
//
// The download is the LAST resort rather than the first move.  The Mac
// updater builds every release from a fresh copy of the source in a new stage
// directory, so the `dist-native` short-circuit below never fires for it and
// every packaging run used to re-download 15 MB from Google.  On a slow or
// flaky connection that download is the single most likely step to fail, and
// when it failed it took the whole update with it.  So: look for a copy this
// machine already has — the explicit override, the shared cache, the app that
// is installed right now, the always-on checkout — and only reach for the
// network when there is genuinely nothing to copy.  A download that does work
// is written into the shared cache, so the next stage copies it instead.
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PLATFORM_NAMES = { darwin: "darwin", linux: "linux", win32: "win32" };
export const ARCHIVE_NAMES = { darwin: "darwin", linux: "linux", win32: "windows" };
/** One slow download beats three fast failures.  The old 30 s budget was
 * shorter than this archive takes on a 40 KB/s link, so the run aborted a
 * transfer that was working. */
export const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
export const DOWNLOAD_ATTEMPTS = 3;
export const DOWNLOAD_RETRY_DELAY_MS = 5_000;

export function adbName(platform) {
  return platform === "win32" ? "adb.exe" : "adb";
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Where a successful download is kept for the next staged copy of the source.
 *
 * Deliberately outside the checkout: the updater stages a brand new copy of
 * the source for every run, and anything inside a checkout would also show up
 * as untracked in `git status --porcelain`, which the updater's dirty-checkout
 * guard reads as a reason to refuse.
 */
export function sharedCacheDirectory({ platform, env = {}, home = homedir() }) {
  if (env.BOTFLEET_ANDROID_TOOLS_CACHE) return env.BOTFLEET_ANDROID_TOOLS_CACHE;
  if (platform === "darwin") return join(home, "Library", "Caches", "BotFleet", "android-platform-tools");
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
    return join(local, "BotFleet", "Cache", "android-platform-tools");
  }
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "botfleet", "android-platform-tools");
}

/** Where the installed application keeps its copy, per `electron-builder.yml`
 * (`dist-native/android-platform-tools` → `Resources/android-platform-tools`). */
function installedApplicationDirectories({ platform, env, home }) {
  if (platform === "darwin") {
    return [
      join("/Applications", "BotFleet.app", "Contents", "Resources", "android-platform-tools"),
      join(home, "Applications", "BotFleet.app", "Contents", "Resources", "android-platform-tools"),
    ];
  }
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
    const programs = env.ProgramFiles || "C:\\Program Files";
    return [
      join(local, "Programs", "BotFleet", "resources", "android-platform-tools"),
      join(programs, "BotFleet", "resources", "android-platform-tools"),
    ];
  }
  return [
    join("/opt", "BotFleet", "resources", "android-platform-tools"),
    join("/usr", "lib", "botfleet", "resources", "android-platform-tools"),
  ];
}

/**
 * Every place a usable copy might already be, nearest and most trustworthy
 * first.  Each entry names the leaf directory that holds `adb` itself, so one
 * `existsSync` decides whether it is worth copying.
 */
export function platformToolsSources({ platform, env = {}, home = homedir(), checkout }) {
  const sources = [];
  if (env.OMB_ANDROID_PLATFORM_TOOLS_SOURCE) {
    sources.push({ label: "OMB_ANDROID_PLATFORM_TOOLS_SOURCE", path: env.OMB_ANDROID_PLATFORM_TOOLS_SOURCE });
  }
  sources.push({
    label: "the shared platform-tools cache",
    path: join(sharedCacheDirectory({ platform, env, home }), platform),
  });
  for (const directory of installedApplicationDirectories({ platform, env, home })) {
    sources.push({ label: "the installed BotFleet application", path: join(directory, platform) });
  }
  const server = checkout || env.BOTFLEET_CHECKOUT || join(home, "apps", "botfleet-server");
  sources.push({
    label: "the always-on checkout",
    path: join(server, "dist-native", "android-platform-tools", platform),
  });
  return sources;
}

/** The sources that actually hold an `adb` right now, in the same order. */
export function usableSources(sources, { platform, exists = existsSync }) {
  return sources.filter((source) => exists(join(source.path, adbName(platform))));
}

/** A network failure a person can act on: "timed out" and "getaddrinfo
 * ENOTFOUND" are different problems with different fixes. */
export function describeDownloadFailure(error, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return `the download timed out after ${Math.round(timeoutMs / 1000)}s`;
  }
  const message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
  return message || "the download failed";
}

/**
 * Fetch the archive, with retries.  A slow link drops one transfer and
 * completes the next, so a single attempt reports a permanent failure for
 * something that is merely intermittent.
 */
export async function downloadArchive(url, options = {}) {
  const {
    fetchImpl = fetch,
    attempts = DOWNLOAD_ATTEMPTS,
    timeoutMs = DOWNLOAD_TIMEOUT_MS,
    retryDelayMs = DOWNLOAD_RETRY_DELAY_MS,
    wait = sleep,
    log = console.error,
  } = options;
  let failure = "the download failed";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      failure = describeDownloadFailure(error, timeoutMs);
      if (attempt < attempts) {
        log(`Android Platform Tools download attempt ${attempt} failed: ${failure} — retrying`);
        await wait(retryDelayMs);
      }
    }
  }
  throw new Error(`could not download Android Platform Tools: ${failure}`);
}

function extractArchive(zip, extraction) {
  // A bare "tar" is Windows' bundled bsdtar (zip-capable) in cmd/PowerShell
  // but git-bash puts GNU tar (cannot read .zip) ahead of it on PATH, so
  // name the System32 binary absolutely — it extracts zips and understands
  // C:\ paths from any shell.  unzip is the fallback for the rare Windows
  // without System32 tar, and the norm everywhere else.
  const systemTar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  const extractors = process.platform === "win32"
    ? [[systemTar, ["-xf", zip, "-C", extraction]], ["unzip", ["-q", zip, "-d", extraction]]]
    : [["unzip", ["-q", zip, "-d", extraction]]];
  // spawnSync leaves stdout/stderr undefined when the binary itself is
  // missing (ENOENT) — report result.error instead of crashing on .trim().
  const describeFailure = (r) => r.error?.message ?? (`${r.stderr || r.stdout || ""}`.trim() || `exit status ${r.status}`);
  let result;
  for (const [command, args] of extractors) {
    result = spawnSync(command, args, { encoding: "utf8" });
    if (result.status === 0) break;
    console.error(`${command} failed: ${describeFailure(result)} — trying next`);
  }
  if (result.status !== 0) throw new Error(`could not extract Android Platform Tools: ${describeFailure(result)}`);
}

export async function prepareAndroidTools(options = {}) {
  const {
    platform = PLATFORM_NAMES[process.platform],
    archive = ARCHIVE_NAMES[process.platform],
    sourceRoot = root,
    env = process.env,
    home = homedir(),
    log = console.log,
  } = options;
  if (!platform || !archive) {
    throw new Error(`Android Platform Tools are unsupported on ${process.platform}`);
  }
  const adb = adbName(platform);
  const finalDir = join(sourceRoot, "dist-native", "android-platform-tools", platform);
  if (existsSync(join(finalDir, adb))) {
    log(`staged Android Platform Tools already cached at ${finalDir}`);
    return { from: "dist-native", path: finalDir };
  }

  const sources = platformToolsSources({ platform, env, home });
  const override = env.OMB_ANDROID_PLATFORM_TOOLS_SOURCE;
  // An explicit override that names the wrong directory is a mistake worth
  // hearing about, not one to paper over with a download.
  if (override && !existsSync(join(override, adb))) {
    throw new Error(`OMB_ANDROID_PLATFORM_TOOLS_SOURCE has no ${adb}: ${override}`);
  }
  const available = usableSources(sources, { platform });

  const temporary = mkdtempSync(join(tmpdir(), "botfleet-android-tools-"));
  const staged = join(temporary, platform);
  try {
    let from = null;
    const copyFrom = (candidates) => {
      for (const source of candidates) {
        try {
          rmSync(staged, { recursive: true, force: true });
          cpSync(source.path, staged, { recursive: true });
          if (!existsSync(join(staged, adb))) throw new Error(`the copy has no ${adb}`);
          return source;
        } catch (error) {
          console.error(`could not copy Android Platform Tools from ${source.path}: ${error?.message ?? error}`);
        }
      }
      return null;
    };

    from = copyFrom(available);
    let downloaded = false;
    if (!from) {
      const url = `https://dl.google.com/android/repository/platform-tools-latest-${archive}.zip`;
      try {
        const body = await downloadArchive(url);
        const zip = join(temporary, basename(new URL(url).pathname));
        writeFileSync(zip, body);
        const extraction = join(temporary, "extracted");
        mkdirSync(extraction, { recursive: true });
        extractArchive(zip, extraction);
        cpSync(join(extraction, "platform-tools"), staged, { recursive: true });
        from = { label: url, path: url };
        downloaded = true;
      } catch (error) {
        // Belt and braces: a copy may have landed while the download was
        // grinding, and a copy that failed once may copy now.  Only a machine
        // with nothing anywhere fails here.
        from = copyFrom(usableSources(sources, { platform }));
        if (!from) {
          const searched = sources.map((source) => source.path).join(", ");
          throw new Error(
            `${error?.message ?? error}, and no existing copy was found to fall back on.  Looked in: ${searched}`,
          );
        }
      }
    }

    if (!existsSync(join(staged, adb))) throw new Error(`Staged Android Platform Tools do not contain ${adb}`);
    mkdirSync(dirname(finalDir), { recursive: true });
    rmSync(finalDir, { recursive: true, force: true });
    cpSync(staged, finalDir, { recursive: true });
    log(`staged Android Platform Tools at ${finalDir} from ${from.label}`);

    if (downloaded) {
      // The whole point of paying for the download once.
      const cache = join(sharedCacheDirectory({ platform, env, home }), platform);
      try {
        mkdirSync(dirname(cache), { recursive: true });
        rmSync(cache, { recursive: true, force: true });
        cpSync(staged, cache, { recursive: true });
        log(`cached Android Platform Tools at ${cache} for later builds`);
      } catch (error) {
        console.error(`could not cache Android Platform Tools at ${cache}: ${error?.message ?? error}`);
      }
    }
    return { from: from.label, path: finalDir };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

// Compare physical paths.  Node's ESM loader realpaths the entry module, so an
// invocation through a symlinked directory (macOS /var -> /private/var) never
// matches process.argv[1] when compared as text.
function isEntryModule() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  prepareAndroidTools().catch((error) => {
    console.error(`BotFleet could not stage the Android Platform Tools: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
