import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { controlBuildVersion } from "./control-build-version.mjs";
import { installServerControls } from "./server-controls.mjs";
import { readSourceBuildIdentity } from "./runtime-identity.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
const bundle = path.join(project, "electron/resources/BotFleet Control.app");
// Keep Swift's architecture-keyed module cache between builds.  Recompiling
// the entire SDK for tests and each release slice wastes minutes on every run.
const scratch = path.join(project, "mac-control/.build");
export async function bundleOfflineVmHelper(resources) {
  mkdirSync(resources, { recursive: true });
  writeFileSync(path.join(resources, "build-identity.json"), JSON.stringify(readSourceBuildIdentity(project, { requireGit: true })) + "\n");
  // The helper reads the vm-cli manifest at runtime, and it resolves it
  // against the directory it runs from.  scripts/bundle-server.mjs ships the
  // same file for the server bundle; without it here the offline Local VM
  // actions fail with ENOENT on a path that does not exist inside the app.
  const vmCliManifestDir = path.join(resources, "computer-vm-cli");
  mkdirSync(vmCliManifestDir, { recursive: true });
  copyFileSync(
    path.join(project, "scripts", "computer-vm-cli", "manifest.json"),
    path.join(vmCliManifestDir, "manifest.json"),
  );
  await build({
    entryPoints: [path.join(project, "server/local-vm-offline-cli.ts")],
    outfile: path.join(resources, "botfleet-vm-control.mjs"),
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    plugins: [{
      name: "yaml-esm",
      setup(bundle) {
        bundle.onResolve({ filter: /^yaml$/ }, () => ({ path: path.join(project, "node_modules/yaml/browser/index.js") }));
      },
    }],
  });
}

async function buildControlApp() {
  if (process.argv.includes("--helper-only")) {
    await bundleOfflineVmHelper(path.join(bundle, "Contents/Resources"));
    return;
  }
  execFileSync("/usr/bin/swift", ["test", "--package-path", path.join(project, "mac-control"), "--scratch-path", scratch, "--jobs", "2"], { stdio: "inherit", timeout: 600_000 });
  const slices = [];
  for (const arch of ["arm64", "x86_64"]) {
    const args = ["build", "--package-path", path.join(project, "mac-control"), "--configuration", "release", "--arch", arch, "--scratch-path", scratch, "--jobs", "2"];
    execFileSync("/usr/bin/swift", args, { stdio: "inherit", timeout: 600_000 });
    const bin = execFileSync("/usr/bin/swift", [...args, "--show-bin-path"], { encoding: "utf8", timeout: 30_000 }).trim();
    // New Swift build systems can report one Products/Release path for both
    // architectures.  Preserve each result before the next build replaces it.
    const sliceDirectory = path.join(scratch, "control-slices", arch);
    mkdirSync(sliceDirectory, { recursive: true });
    const slice = path.join(sliceDirectory, "BotFleetControl");
    copyFileSync(path.join(bin, "BotFleetControl"), slice);
    const sliceArchs = execFileSync("/usr/bin/lipo", ["-archs", slice], { encoding: "utf8" }).trim().split(/\s+/);
    if (sliceArchs.length !== 1 || sliceArchs[0] !== arch) throw new Error(`Expected a ${arch} control slice, found ${sliceArchs.join(", ")}`);
    slices.push(slice);
  }
  const contents = path.join(bundle, "Contents");
  mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  mkdirSync(path.join(contents, "Resources"), { recursive: true });
  copyFileSync(path.join(project, "build/icon.icns"), path.join(contents, "Resources", "icon.icns"));
  for (const name of ["LICENSE", "NOTICE"]) copyFileSync(path.join(project, name), path.join(contents, "Resources", name));
  await bundleOfflineVmHelper(path.join(contents, "Resources"));
  // Control carries the version the workflow pinned in BOTFLEET_BUILD_VERSION
  // when there is one, which is the app's own, and otherwise the same stamp
  // the app's release path uses: the commit count with the package.json
  // floor, never the count of a shallow clone.
  const { version, build: buildNumber, source } = controlBuildVersion({ repoRoot: project });
  writeFileSync(path.join(contents, "Resources", "build-identity.json"), JSON.stringify(
    readSourceBuildIdentity(project, { requireGit: true, version, build: buildNumber }),
  ) + "\n");
  writeFileSync(path.join(contents, "Resources", "control-update-protocol.json"), JSON.stringify({ protocolVersion: 1 }) + "\n");
  console.log(`BotFleet Control version ${version} (${source})`);
  writeFileSync(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.botfleet.control.macos</string>
<key>CFBundleName</key><string>BotFleet Control</string>
<key>CFBundleDisplayName</key><string>BotFleet Control</string>
<key>CFBundleExecutable</key><string>BotFleetControl</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${buildNumber}</string>
<key>CFBundleIconFile</key><string>icon.icns</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
</dict></plist>
`);
  const executable = path.join(contents, "MacOS", "BotFleetControl");
  execFileSync("/usr/bin/lipo", ["-create", ...slices, "-output", executable], { stdio: "inherit" });
  const archs = new Set(execFileSync("/usr/bin/lipo", ["-archs", executable], { encoding: "utf8" }).trim().split(/\s+/));
  if (archs.size !== 2 || !archs.has("arm64") || !archs.has("x86_64")) throw new Error("Control app must be universal");
  execFileSync("/usr/bin/plutil", ["-lint", path.join(contents, "Info.plist")], { stdio: "inherit" });
  execFileSync("/usr/bin/codesign", ["--force", "--sign", process.env.BOTFLEET_CONTROL_SIGN_IDENTITY || "-", "--options", "runtime", bundle], { stdio: "inherit" });
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", bundle], { stdio: "inherit" });
  if (process.argv.includes("--install")) console.log(`Installed ${installServerControls(bundle)}`);
  else console.log(`Built ${bundle}`);
}

// The build runs when this file is the entry point, and only then: the
// offline helper bundling is exported so a test can build the same bundle the
// app ships and check what landed in it.  Both sides go through the real
// path, because a lane that lives behind a symlink gives the loader the
// resolved module URL and the command line the unresolved one.
const isEntryPoint = process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) await buildControlApp();
