import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installServerControls } from "./server-controls.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
const bundle = path.join(project, "electron/resources/BotFleet Control.app");
// Keep Swift's architecture-keyed module cache between builds.  Recompiling
// the entire SDK for tests and each release slice wastes minutes on every run.
const scratch = path.join(project, "mac-control/.build");
function buildControlApp() {
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
    execFileSync("/usr/bin/lipo", ["-verify_arch", arch, slice], { stdio: "inherit" });
    slices.push(slice);
  }
  const contents = path.join(bundle, "Contents");
  mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  mkdirSync(path.join(contents, "Resources"), { recursive: true });
  copyFileSync(path.join(project, "build/icon.icns"), path.join(contents, "Resources", "icon.icns"));
  for (const name of ["LICENSE", "NOTICE"]) copyFileSync(path.join(project, name), path.join(contents, "Resources", name));
  const count = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: project, encoding: "utf8" }).trim();
  if (!/^\d+$/.test(count)) throw new Error("Missing commit-count version");
  writeFileSync(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.botfleet.control.macos</string>
<key>CFBundleName</key><string>BotFleet Control</string>
<key>CFBundleDisplayName</key><string>BotFleet Control</string>
<key>CFBundleExecutable</key><string>BotFleetControl</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0.${count}</string>
<key>CFBundleVersion</key><string>${count}</string>
<key>CFBundleIconFile</key><string>icon.icns</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
</dict></plist>
`);
  const executable = path.join(contents, "MacOS", "BotFleetControl");
  execFileSync("/usr/bin/lipo", ["-create", ...slices, "-output", executable], { stdio: "inherit" });
  const archs = execFileSync("/usr/bin/lipo", ["-archs", executable], { encoding: "utf8" });
  if (!archs.includes("arm64") || !archs.includes("x86_64")) throw new Error("Control app must be universal");
  execFileSync("/usr/bin/plutil", ["-lint", path.join(contents, "Info.plist")], { stdio: "inherit" });
  execFileSync("/usr/bin/codesign", ["--force", "--sign", process.env.BOTFLEET_CONTROL_SIGN_IDENTITY || "-", "--options", "runtime", bundle], { stdio: "inherit" });
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", bundle], { stdio: "inherit" });
  if (process.argv.includes("--install")) console.log(`Installed ${installServerControls(bundle)}`);
  else console.log(`Built ${bundle}`);
}

buildControlApp();
