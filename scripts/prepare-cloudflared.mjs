// Stage a pinned Cloudflare Tunnel connector for every desktop architecture
// electron-builder will package on this host. Pass --current for development
// to stage only the platform and architecture running this script. The release
// asset is verified before extraction and the executable is verified again on
// every reuse.
// Nothing is installed globally and cloudflared's own updater stays disabled;
// BotFleet updates this dependency with an ordinary reviewed app release.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** One slow download beats three fast failures.  Mirrors the timeout,
 * attempt count, and delay `prepare-android-tools.mjs` picked up in PR #446
 * for the same class of incident (the Sep 17 update outage traced to this
 * script's single 120s attempt with no retry). */
export const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
export const DOWNLOAD_ATTEMPTS = 3;
export const DOWNLOAD_RETRY_DELAY_MS = 5_000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export const CLOUDFLARED_VERSION = "2026.8.2";

export const CLOUDFLARED_ASSETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    name: "cloudflared-darwin-arm64.tgz",
    sha256: "9042c2c5d8b2de78e60f313d5fb31b6c5c1cebde787a3caf1f2c9588084ac442",
    binarySha256: "b61054d3d6326ea558cb49826eebf5676e0d0a36d51b546975096ca3e0e3c89d",
    archive: true,
  }),
  "darwin-x64": Object.freeze({
    name: "cloudflared-darwin-amd64.tgz",
    sha256: "f1727723c586500e2092368ae21871b3df7ddfd2cb097f22d81bee4a9c458bb4",
    binarySha256: "b0f770e1e0b281399a57219b840fd8eef1cc25387a404124248157ea2073727a",
    archive: true,
  }),
  "linux-x64": Object.freeze({
    name: "cloudflared-linux-amd64",
    sha256: "fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2",
    binarySha256: "fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2",
    archive: false,
  }),
  "win32-x64": Object.freeze({
    name: "cloudflared-windows-amd64.exe",
    sha256: "c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5",
    binarySha256: "c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5",
    archive: false,
  }),
});

export function targetsForHost(platform) {
  if (platform === "darwin") return ["darwin-arm64", "darwin-x64"];
  if (platform === "linux") return ["linux-x64"];
  if (platform === "win32") return ["win32-x64"];
  throw new Error(`Cloudflare Tunnel packaging is unsupported on ${platform}`);
}

export function targetForCurrentHost(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  if (!Object.hasOwn(CLOUDFLARED_ASSETS, target)) {
    throw new Error(`Cloudflare Tunnel development is unsupported on ${target}`);
  }
  return target;
}

export function targetsForPreparation({
  current = false,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  return current ? [targetForCurrentHost(platform, arch)] : targetsForHost(platform);
}

export function parsePrepareCloudflaredArgs(args = []) {
  if (args.length === 0) return { current: false };
  if (args.length === 1 && args[0] === "--current") return { current: true };
  throw new Error("Usage: node scripts/prepare-cloudflared.mjs [--current]");
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function verifySha256(value, expected, label = "cloudflared asset") {
  const actual = sha256(value);
  if (actual !== expected) {
    throw new Error(`${label} failed SHA-256 verification (expected ${expected}, received ${actual})`);
  }
  return actual;
}

const executableName = (target) => (target.startsWith("win32-") ? "cloudflared.exe" : "cloudflared");

/** Identify the exact desktop target from the executable header without
 * invoking untrusted bytes. cloudflared's release checksums are verified
 * before this helper is used, but keeping architecture validation separate
 * prevents a correctly checksummed asset from being staged into the wrong
 * electron-builder resource directory. */
export function executableTarget(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);

  // 64-bit little-endian Mach-O. CPU types include ABI64 (0x01000000).
  if (bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = bytes.readUInt32LE(4);
    if (cpu === 0x0100000c) return "darwin-arm64";
    if (cpu === 0x01000007) return "darwin-x64";
    throw new Error(`unsupported cloudflared Mach-O CPU type 0x${cpu.toString(16)}`);
  }

  // ELF64, little-endian, AMD64 (e_machine 0x3e).
  if (
    bytes.length >= 20 &&
    bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
    bytes[4] === 2 &&
    bytes[5] === 1 &&
    bytes.readUInt16LE(18) === 0x3e
  ) {
    return "linux-x64";
  }

  // PE32+ AMD64. e_lfanew points from the DOS header to PE\0\0.
  if (bytes.length >= 0x40 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const pe = bytes.readUInt32LE(0x3c);
    if (
      pe <= bytes.length - 6 &&
      bytes.subarray(pe, pe + 4).equals(Buffer.from([0x50, 0x45, 0, 0])) &&
      bytes.readUInt16LE(pe + 4) === 0x8664
    ) {
      return "win32-x64";
    }
  }

  throw new Error("cloudflared release has an unsupported executable format or architecture");
}

export function verifyPinnedBinary(value, target) {
  const asset = CLOUDFLARED_ASSETS[target];
  if (!asset) throw new Error(`No pinned cloudflared asset for ${target}`);
  const actualTarget = executableTarget(value);
  if (actualTarget !== target) {
    throw new Error(`cloudflared architecture mismatch (expected ${target}, received ${actualTarget})`);
  }
  return verifySha256(value, asset.binarySha256, `${target} cloudflared executable`);
}

function expectedManifest(target) {
  const asset = CLOUDFLARED_ASSETS[target];
  return {
    version: CLOUDFLARED_VERSION,
    target,
    releaseAsset: asset.name,
    releaseAssetSha256: asset.sha256,
    binarySha256: asset.binarySha256,
  };
}

function targetRunsOnHost(target, platform = process.platform, arch = process.arch) {
  return target === `${platform}-${arch}`;
}

function executableHasPinnedVersion(binary, target) {
  // A dual-architecture macOS package is prepared in one invocation. Do not
  // assume Rosetta is installed or attempt to execute the other architecture;
  // its executable bytes are still pinned and its Mach-O header is checked.
  if (!targetRunsOnHost(target)) return true;
  const result = spawnSync(binary, ["version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  return result.status === 0 && `${result.stdout}\n${result.stderr}`.includes(CLOUDFLARED_VERSION);
}

export function verifyCloudflaredExecutable(binary, target) {
  verifyPinnedBinary(readFileSync(binary), target);
  if (!executableHasPinnedVersion(binary, target)) {
    throw new Error(`${target} executable did not identify as cloudflared ${CLOUDFLARED_VERSION}`);
  }
}

function executableIsCurrent(binary, manifestFile, target) {
  if (!existsSync(binary) || !existsSync(manifestFile)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest(target))) return false;
    verifyCloudflaredExecutable(binary, target);
    return true;
  } catch {
    return false;
  }
}

function extractionFailure(result) {
  return result.error?.message ?? String(result.stderr || result.stdout || `exit status ${result.status}`).trim();
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
 * Fetch a release asset, with retries.  A slow link drops one transfer and
 * completes the next, so a single attempt (the prior behaviour: one 120s
 * fetch, no retry) reports a permanent failure for something that is merely
 * intermittent -- the Sep 17 update outage traced to exactly this.
 */
export async function downloadRelease(url, label, options = {}) {
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
      const response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      failure = describeDownloadFailure(error, timeoutMs);
      if (attempt < attempts) {
        log(`${label} download attempt ${attempt} failed: ${failure} — retrying`);
        await wait(retryDelayMs);
      }
    }
  }
  throw new Error(`could not download ${label}: ${failure}`);
}

/** Where a successfully downloaded release archive is kept for the next
 * `stageTarget` call to reuse, across dev runs and packaging jobs alike.
 * `OMB_CLOUDFLARED_ARCHIVE_DIR` (documented in third_party/cloudflared/README.md)
 * still wins when set; nothing set it by default before this, so the cache
 * was always empty and every run re-downloaded. */
export function cloudflaredArchiveCacheDirectory({
  platform = process.platform,
  env = process.env,
  home = homedir(),
} = {}) {
  if (env.OMB_CLOUDFLARED_ARCHIVE_DIR) return env.OMB_CLOUDFLARED_ARCHIVE_DIR;
  if (platform === "darwin") return join(home, "Library", "Caches", "BotFleet", "cloudflared-archives");
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
    return join(local, "BotFleet", "Cache", "cloudflared-archives");
  }
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "botfleet", "cloudflared-archives");
}

async function releaseBytes(asset) {
  const cacheDirectory = cloudflaredArchiveCacheDirectory();
  const cached = join(cacheDirectory, asset.name);
  if (existsSync(cached)) {
    const bytes = readFileSync(cached);
    if (sha256(bytes) === asset.sha256) return bytes;
    console.error(`cached ${asset.name} failed checksum verification — re-downloading`);
  }

  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset.name}`;
  const bytes = await downloadRelease(url, asset.name);

  try {
    mkdirSync(cacheDirectory, { recursive: true });
    const staged = join(cacheDirectory, `.${asset.name}-${process.pid}-${Date.now()}`);
    writeFileSync(staged, bytes, { mode: 0o600 });
    renameSync(staged, cached);
  } catch (error) {
    // A cache write is an optimization, not a requirement -- the download
    // already succeeded and its checksum is verified by the caller.
    console.error(`could not cache ${asset.name} at ${cacheDirectory}: ${error?.message ?? error}`);
  }
  return bytes;
}

async function stageTarget(root, target) {
  const asset = CLOUDFLARED_ASSETS[target];
  if (!asset) throw new Error(`No pinned cloudflared asset for ${target}`);

  const finalDirectory = join(root, "dist-native", "cloudflared", target);
  const binary = join(finalDirectory, executableName(target));
  const manifestFile = join(finalDirectory, "manifest.json");
  if (executableIsCurrent(binary, manifestFile, target)) {
    console.log(`cloudflared ${CLOUDFLARED_VERSION} already staged for ${target}`);
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), `botfleet-cloudflared-${target}-`));
  try {
    const payload = await releaseBytes(asset);
    verifySha256(payload, asset.sha256, asset.name);

    let candidate;
    if (asset.archive) {
      const archive = join(scratch, basename(asset.name));
      writeFileSync(archive, payload, { mode: 0o600 });
      const extracted = join(scratch, "extracted");
      mkdirSync(extracted, { mode: 0o700 });
      const result = spawnSync("tar", ["-xzf", archive, "-C", extracted], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 60_000,
      });
      if (result.status !== 0) throw new Error(`could not extract ${asset.name}: ${extractionFailure(result)}`);
      candidate = join(extracted, "cloudflared");
    } else {
      candidate = join(scratch, executableName(target));
      writeFileSync(candidate, payload, { mode: 0o700 });
    }
    if (!existsSync(candidate)) throw new Error(`${asset.name} did not contain cloudflared`);
    if (!target.startsWith("win32-")) chmodSync(candidate, 0o700);

    verifyCloudflaredExecutable(candidate, target);

    const parent = dirname(finalDirectory);
    mkdirSync(parent, { recursive: true });
    const stagedDirectory = mkdtempSync(join(parent, `.${target}-`));
    const stagedBinary = join(stagedDirectory, executableName(target));
    copyFileSync(candidate, stagedBinary);
    if (!target.startsWith("win32-")) {
      // copyFile preserves the source mode on Unix in current Node, but make
      // the executable contract explicit instead of depending on that detail.
      chmodSync(stagedBinary, 0o755);
    }
    writeFileSync(
      join(stagedDirectory, "manifest.json"),
      `${JSON.stringify(expectedManifest(target), null, 2)}\n`,
      { mode: 0o600 },
    );
    rmSync(finalDirectory, { recursive: true, force: true });
    renameSync(stagedDirectory, finalDirectory);
    console.log(`staged cloudflared ${CLOUDFLARED_VERSION} for ${target}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function prepareCloudflared({
  root = join(dirname(fileURLToPath(import.meta.url)), ".."),
  platform = process.platform,
  arch = process.arch,
  current = false,
} = {}) {
  for (const target of targetsForPreparation({ current, platform, arch })) {
    await stageTarget(root, target);
  }
}

/** The Mac self-updater always packages `--arm64 --dir` for the machine
 * running the update (`update-botfleet-mac.mjs` -> `pnpm package:mac:local`),
 * so staging both darwin targets there downloads darwin-x64 only to throw it
 * away every run.  `package:mac:local` has no CLI surface to add `--current`
 * to (`build:cloudflared` is shared with `package:mac:release`, which must
 * keep building both architectures for the actual release), so the updater
 * sets this environment variable instead. */
export function currentOnlyFromEnv(env = process.env) {
  return env.OMB_CLOUDFLARED_CURRENT === "1";
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = parsePrepareCloudflaredArgs(process.argv.slice(2));
  await prepareCloudflared({ current: args.current || currentOnlyFromEnv() });
}
