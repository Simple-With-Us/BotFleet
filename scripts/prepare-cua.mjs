// Stage the macOS CUA executable and native SDK outside ASAR. The npm SDK
// deliberately does not ship the `cua-driver` CLI, so packaging must fail
// loudly instead of producing an app whose "This computer" option can never
// work. CUA_DRIVER_PATH is the CI/release override; otherwise an exact-version
// installed binary or the checksummed official release asset is used.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, chmod, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { resolveCuaMacArches } from "./cua-mac-arches.mjs";
import { nativeProbeFailureMessage, probeNativeVersion } from "./native-version-probe.mjs";

export const CUA_RELEASE = Object.freeze({
  version: "0.20.0",
  file: "cua-driver-rs-0.20.0-darwin-universal-binary.tar.gz",
  sha256: "07a88ea2c28a9ead66b2d9f6f93fab4b1189a1f7c704d2cd7b6d12c30eee9984",
});

export const CUA_VERSION_OUTPUT = /cua-driver\s+([\d.]+)/;

export function matchCuaDriverVersion(output) {
  return String(output ?? "").match(CUA_VERSION_OUTPUT)?.[1] ?? null;
}

/** Ask the staged driver what it is.  This used to be a 5s `execFile` whose
 * only answer was `null` for everything that could go wrong, which is the same
 * trap #780 removed from the cloudflared packaging step: on a saturated host
 * a perfectly good pinned binary was reported as the wrong version.  It is now
 * a classified probe -- 60s, one retry on timeout, and the cause named. */
export function probeCuaDriver(candidate, options = {}) {
  if (!candidate || !existsSync(candidate)) {
    return { ok: false, reason: "missing", version: null, result: {}, attempt: 0, attempts: 0 };
  }
  return probeNativeVersion(candidate, {
    ...options,
    args: ["--version"],
    matchVersion: matchCuaDriverVersion,
  });
}

export function cuaDriverFailureMessage(candidate, probe, expected) {
  return nativeProbeFailureMessage(
    `cua-driver at ${candidate} did not identify as cua-driver ${expected}`,
    probe,
  );
}

/** What an unverified cached driver should trigger.
 *
 * The old code re-downloaded on every non-`null`-looking answer, including a
 * timeout.  That is backwards twice over: the cache is keyed to a pinned
 * sha256, so re-downloading the same release yields byte-identical bytes and
 * probes them again, and the second probe on the same busy host is the one
 * most likely to time out as well.  A busy host therefore spent a full release
 * transfer and then threw "downloaded CUA Driver does not report version",
 * naming a download that had just been checksum-verified as corrupt.  Only a
 * genuine mismatch or an unrunnable file justifies discarding the cache. */
export function cachedDriverAction(probe) {
  if (probe.ok) return { reuse: true, redownload: false, reason: "verified" };
  if (probe.reason === "timeout") return { reuse: false, redownload: false, reason: "timeout" };
  return { reuse: false, redownload: true, reason: probe.reason };
}

export async function prepareCua({ root = join(dirname(fileURLToPath(import.meta.url)), "..") } = {}) {
  if (process.platform !== "darwin") throw new Error("prepare-cua is macOS-only");
  const run = promisify(execFile);
  const stage = join(root, "dist-native");
  const sdkEntry = fileURLToPath(import.meta.resolve("@trycua/cua-driver"));
  const sdkRoot = realpathSync(join(dirname(sdkEntry), ".."));
  const dependencyRoot = join(sdkRoot, "..", "..");
  const sdkPackage = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8"));
  const expectedVersion = String(sdkPackage.version);
  if (expectedVersion !== CUA_RELEASE.version) {
    throw new Error(
      `CUA SDK ${expectedVersion} has no pinned executable asset in prepare-cua.mjs; update the release checksum first`,
    );
  }

  async function officialBinary() {
    const cache = join(root, "node_modules", ".cache", "botfleet", `cua-driver-${CUA_RELEASE.version}`);
    const cachedBinary = join(cache, "cua-driver");
    const cached = probeCuaDriver(cachedBinary);
    const action = cachedDriverAction(cached);
    if (action.reuse) return cachedBinary;
    if (!action.redownload) {
      throw new Error(
        `${cuaDriverFailureMessage(cachedBinary, cached, expectedVersion)}. ` +
          "Its bytes are already the pinned release, so downloading it again cannot change this — re-run the build at a quieter moment.",
      );
    }

    await rm(cache, { recursive: true, force: true });
    await mkdir(cache, { recursive: true });
    const url = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_RELEASE.version}/${CUA_RELEASE.file}`;
    console.log(`Downloading CUA Driver ${CUA_RELEASE.version} from the official release…`);
    const response = await fetch(url, { headers: { "user-agent": "BotFleet-packager" } });
    if (!response.ok) throw new Error(`CUA Driver download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== CUA_RELEASE.sha256) {
      throw new Error(`CUA Driver checksum mismatch: expected ${CUA_RELEASE.sha256}, got ${digest}`);
    }
    const archive = join(cache, CUA_RELEASE.file);
    await writeFile(archive, bytes);
    await run("/usr/bin/tar", ["-xzf", archive, "-C", cache, "cua-driver"]);
    await chmod(cachedBinary, 0o755);
    const downloaded = probeCuaDriver(cachedBinary);
    if (!downloaded.ok) {
      throw new Error(
        `${cuaDriverFailureMessage(cachedBinary, downloaded, expectedVersion)}. ` +
          `The release archive matched its pinned sha256 (${CUA_RELEASE.sha256}), so the bytes are correct and the host was too busy to run them.`,
      );
    }
    return cachedBinary;
  }

  let binary;
  if (process.env.CUA_DRIVER_PATH) {
    const supplied = probeCuaDriver(process.env.CUA_DRIVER_PATH);
    if (supplied.version !== expectedVersion) {
      throw new Error(
        `CUA_DRIVER_PATH must point to cua-driver ${expectedVersion}: ` +
          cuaDriverFailureMessage(process.env.CUA_DRIVER_PATH, supplied, expectedVersion),
      );
    }
    binary = process.env.CUA_DRIVER_PATH;
  } else {
    // The locally installed app may be a single-arch build; both shipped arches
    // need it, so fall back to the official universal binary rather than fail.
    const installed = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
    const installedUniversal = async () => {
      try {
        const { stdout } = await run("/usr/bin/lipo", ["-archs", installed]);
        return stdout.includes("arm64") && stdout.includes("x86_64");
      } catch {
        return false;
      }
    };
    binary =
      probeCuaDriver(installed).version === expectedVersion && (await installedUniversal())
        ? installed
        : await officialBinary();
  }
  const details = await stat(binary);
  if (!details.isFile() || (details.mode & 0o111) === 0) {
    throw new Error(`cua-driver is not an executable file: ${binary}`);
  }

  // The mac app ships for two architectures, each with its own staging dir that
  // electron-builder selects via ${arch} in extraResources. The driver
  // executable is the official universal binary (same bytes in both dirs, and
  // asserted universal below so a future non-universal pin fails loudly here,
  // not on a user's Intel Mac); the SDK's dylib/.node are genuinely per-arch,
  // pulled from the two darwin native packages that pnpm installs because of
  // supportedArchitectures in package.json.
  const MAC_ARCHES = resolveCuaMacArches(process.env);

  const { stdout: archList } = await run("/usr/bin/lipo", ["-archs", binary]);
  for (const arch of MAC_ARCHES) {
    const lipoName = arch === "x64" ? "x86_64" : arch;
    if (!archList.trim().split(/\s+/).includes(lipoName)) {
      throw new Error(`cua-driver at ${binary} is not universal: has [${archList.trim()}], needs ${lipoName}`);
    }
  }

  for (const arch of MAC_ARCHES) {
    const archStage = join(stage, arch);
    await rm(archStage, { recursive: true, force: true });
    await mkdir(archStage, { recursive: true });
    await copyFile(binary, join(archStage, "cua-driver"));
    await chmod(join(archStage, "cua-driver"), 0o755);
    // A binary copied out of CuaDriver.app retains a bundle-relative signature
    // whose Info.plist no longer exists at the new path. Give the staged file a
    // valid temporary signature; electron-builder replaces it with the enclosing
    // app's identity during its nested-code signing pass.
    await run("/usr/bin/codesign", ["--force", "--sign", "-", "--options", "runtime", join(archStage, "cua-driver")]);

    const nativeDir = join(archStage, "cua-sdk", "native");
    const nativePackage = join(dependencyRoot, "@trycua", `cua-driver-darwin-${arch}`);
    if (!existsSync(nativePackage)) {
      throw new Error(
        `required CUA darwin-${arch} native package is missing — is pnpm.supportedArchitectures.cpu set in package.json?`,
      );
    }
    await mkdir(nativeDir, { recursive: true });
    await Promise.all([
      copyFile(join(realpathSync(nativePackage), "libcua_driver_sdk.dylib"), join(nativeDir, "libcua_driver_sdk.dylib")),
      copyFile(join(realpathSync(nativePackage), "cua_driver_node_runtime.node"), join(nativeDir, "cua_driver_node_runtime.node")),
    ]);
  }

  // Bundle the JS side into one ESM file so electron-builder's intentional
  // node_modules exclusion cannot drop it. The SDK resolves its native library
  // through @ubjs at runtime; redirect those generated lookups to the native
  // files staged beside the bundle. The bundle is pure JS — built once, shipped
  // in both arch dirs.
  const bundle = join(stage, MAC_ARCHES[0], "cua-sdk", "cua-sdk.mjs");
  await build({
    stdin: {
      contents: [
        'export { EmbeddedCuaDriverHost } from "@trycua/cua-driver/embedded";',
        'export { requestMacOSPermissions, hasRequiredMacOSPermissions } from "@trycua/cua-driver/electron";',
      ].join("\n"),
      resolveDir: root,
      sourcefile: "botfleet-cua-entry.mjs",
      loader: "js",
    },
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    banner: {
      js: 'import { createRequire as __botfleetCreateRequire } from "node:module"; const require = __botfleetCreateRequire(import.meta.url);',
    },
    outfile: bundle,
    logLevel: "silent",
  });
  const bundledSource = await readFile(bundle, "utf8");
  const resolverPattern = /function resolveLibPath\d*\(opts\) \{/g;
  const resolvers = bundledSource.match(resolverPattern) ?? [];
  if (resolvers.length !== 1) {
    throw new Error("could not patch the bundled CUA native-library resolver");
  }
  await writeFile(
    bundle,
    bundledSource.replace(
      resolverPattern,
      `${resolvers[0]}\n      if (process.env.BOTFLEET_CUA_SDK_LIBRARY) return resolveOverride(opts.crateName, process.env.BOTFLEET_CUA_SDK_LIBRARY);`,
    ),
  );

  for (const arch of MAC_ARCHES.slice(1)) {
    await copyFile(bundle, join(stage, arch, "cua-sdk", "cua-sdk.mjs"));
  }

  console.log(`Staged CUA for ${MAC_ARCHES.join(" + ")} from ${binary}`);
}

// Node's ESM loader realpaths the entry module while process.argv[1] keeps
// whatever spelling the caller used, so a launcher running this through a
// symlinked path would never reach the body below. Compare physical paths, the
// same guard prepare-cloudflared.mjs uses. It is also what keeps this module
// importable from the test suite, which exercises the probe and the cache
// decision without downloading a 40MB release on a Linux runner.
function isEntryModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  await prepareCua();
}
