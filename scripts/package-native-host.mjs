// Produces a separate optional-service artifact; never installs, starts or registers it.
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, realpathSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encodeHostIdentity, HOST_CAPABILITIES, HOST_CODE_ID, inspectHostMachO, sha256, verifyNativeHostArtifact } from "./native-host-artifact.mjs";

function refused() { throw new Error("Native host packaging refused; no distributable artifact was accepted."); }
export function runHostPackagingCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
  if (result.status !== 0) {
    console.error(`Native host packaging command ${basename(command)} failed (${result.error?.code ?? result.status}).`);
    refused();
  }
  return result.stdout ?? "";
}

export async function nativeHostNotaryCredentials({ env = process.env, fetchImpl = fetch } = {}) {
  const token = String(env.INFISICAL_NATIVE_RELEASE_READ_TOKEN ?? "").trim();
  if (!token) refused();
  try {
    const helper = await import("./infisical-fetch.mjs");
    // The dependency on published #1551 fails closed on the older unscoped helper.
    if (!helper.verifyServiceTokenMetadata || !helper.isUnresolvedReference) refused();
    const names = ["APPLE_API_KEY_P8_BASE64", "APPLE_API_KEY_ID", "APPLE_API_ISSUER_ID"];
    const values = await helper.listSecretsRaw({ siteUrl: "https://app.infisical.com", token,
      projectId: "836aebe2-c8f7-4e09-978e-7e3e82500bce", environment: "prod", secretPath: "/",
      names, fetchImpl, log: () => {} });
    for (const name of names) if (!values.get(name) || helper.isUnresolvedReference(values.get(name))) refused();
    const encoded = values.get(names[0]).replace(/\r?\n/g, "");
    const p8 = Buffer.from(encoded, "base64");
    if (p8.toString("base64") !== encoded || !p8.toString("utf8").includes("-----BEGIN PRIVATE KEY-----")) refused();
    return { p8, keyId: values.get(names[1]), issuerId: values.get(names[2]) };
  } catch { refused(); }
}

export async function packageNativeHost({ repoRoot, output, build, unsignedDevelopment = false,
  signIdentity, keychain, platform = process.platform, run = runHostPackagingCommand,
  inspectSignature, readCredentials = nativeHostNotaryCredentials } = {}) {
  if (platform !== "darwin" || !repoRoot || !output || !/^[0-9]{12}$/.test(build ?? "") || /^0+$/.test(build) ||
      (!unsignedDevelopment && !signIdentity)) refused();
  const repo = realpathSync(repoRoot), requestedOutput = resolve(output);
  const parent = realpathSync(dirname(requestedOutput)), destination = join(parent, basename(requestedOutput));
  const rel = relative(repo, destination);
  if (!rel.startsWith("../") && rel !== "..") refused();
  if (existsSync(destination)) refused();
  try { lstatSync(destination); refused(); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const sourceCommit = run("git", ["-C", repo, "rev-parse", "HEAD"]).trim();
  const sourceDirty = run("git", ["-C", repo, "status", "--porcelain", "--untracked-files=normal"]).trim() !== "";
  const identity = { schemaVersion: 1, codeIdentifier: HOST_CODE_ID, sourceCommit, build,
    marketingVersion: "0.1.0", capabilities: HOST_CAPABILITIES,
    distribution: unsignedDevelopment ? "unsigned-development" : "developer-id", sourceDirty };
  const stamp = encodeHostIdentity(identity);
  const notaryCredentials = unsignedDevelopment ? null : await readCredentials();
  mkdirSync(destination, { mode: 0o700 }); // Exclusive reservation: an existing destination is never replaced.
  const owned = lstatSync(destination), work = mkdtempSync(join(destination, ".work-"));
  const payload = join(destination, "payload"), binary = join(payload, "bin", HOST_CODE_ID);
  let artifact, accepted = false, safeCleanup = true, stage = "source export";
  try {
    mkdirSync(join(payload, "bin"), { recursive: true, mode: 0o755 });
    const source = join(work, "source"); mkdirSync(source);
    const archive = join(work, "source.tar");
    run("git", ["-C", repo, "archive", "--format=tar", "--output", archive, sourceCommit, "ios"]);
    run("/usr/bin/tar", ["-xf", archive, "-C", source]);
    const stampFile = join(work, "identity.json"); writeFileSync(stampFile, stamp, { mode: 0o600, flag: "wx" });
    const executables = [];
    for (const arch of ["arm64", "x86_64"]) {
      stage = `${arch} Swift build`;
      const args = ["build", "--package-path", join(source, "ios"), "--configuration", "release",
        "--product", HOST_CODE_ID, "--scratch-path", join(work, `build-${arch}`), "--arch", arch, "--jobs", "2",
        "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__bf_identity", "-Xlinker", stampFile];
      run("swift", args);
      const binPath = run("swift", [...args, "--show-bin-path"]).trim();
      stage = `${arch} Mach-O identity check`;
      const built = join(binPath, HOST_CODE_ID), slices = inspectHostMachO(readFileSync(built));
      if (slices.length !== 1 || slices[0].arch !== arch || !slices[0].stamp?.equals(stamp)) refused();
      // This product declares no production resource bundle; a changed graph needs explicit packaging support.
      if (readdirSync(binPath).some((name) => name.endsWith(".bundle"))) refused();
      executables.push(built);
    }
    stage = "universal assembly";
    run("/usr/bin/lipo", ["-create", ...executables, "-output", binary]);
    // The universal staging layout is independent of build directories and editable sidecars.
    const verify = () => verifyNativeHostArtifact({ executable: binary, stageRoot: payload,
      expectedSource: sourceCommit, expectedBuild: build, unsignedDevelopment, inspectSignature });
    if (!unsignedDevelopment) {
      stage = "Developer ID signing";
      const signing = ["--force", "--sign", signIdentity, "--identifier", HOST_CODE_ID, "--options", "runtime", "--timestamp"];
      if (keychain) signing.push("--keychain", keychain);
      run("/usr/bin/codesign", [...signing, binary]);
    }
    stage = "payload verification";
    const verified = verify();
    const verifyRelocation = (root) => {
      const relocated = verifyNativeHostArtifact({ executable: join(root, "bin", HOST_CODE_ID), stageRoot: root,
        expectedSource: sourceCommit, expectedBuild: build, expectedSha256: verified.binarySha256,
        unsignedDevelopment, inspectSignature });
      if (JSON.stringify(relocated.files) !== JSON.stringify(verified.files)) refused();
    };
    const stem = `BotFleetNativeHost-0.1.0-${build}`;
    if (unsignedDevelopment) {
      stage = "unsigned archive and relocation";
      artifact = join(destination, `${stem}-UNSIGNED.zip`);
      run("/usr/bin/ditto", ["-c", "-k", "--keepParent", payload, artifact]);
      const relocated = join(work, "relocated"); mkdirSync(relocated);
      run("/usr/bin/ditto", ["-x", "-k", artifact, relocated]);
      verifyRelocation(join(relocated, "payload"));
    } else {
      stage = "signed disk image and notarization";
      const credentials = notaryCredentials;
      artifact = join(destination, `${stem}.dmg`);
      run("/usr/bin/hdiutil", ["create", "-volname", HOST_CODE_ID, "-srcfolder", payload, "-ov", "-format", "UDZO", artifact]);
      const signing = ["--force", "--sign", signIdentity, "--timestamp"];
      if (keychain) signing.push("--keychain", keychain);
      run("/usr/bin/codesign", [...signing, artifact]);
      const keyFile = join(work, "notary.p8"); writeFileSync(keyFile, credentials.p8, { mode: 0o600, flag: "wx" });
      const fd = openSync(keyFile, "r"); unlinkSync(keyFile);
      try {
        const result = JSON.parse(run("/usr/bin/xcrun", ["notarytool", "submit", artifact, "--key", "/dev/fd/3",
          "--key-id", credentials.keyId, "--issuer", credentials.issuerId, "--wait", "--output-format", "json"],
        { stdio: ["ignore", "pipe", "pipe", fd] }));
        if (result.status !== "Accepted") refused();
      } finally { closeSync(fd); }
      run("/usr/bin/xcrun", ["stapler", "staple", artifact]);
      run("/usr/bin/xcrun", ["stapler", "validate", artifact]);
      run("/usr/bin/codesign", ["--verify", "--strict", artifact]);
      if (verify().binarySha256 !== verified.binarySha256) refused();
      const mounted = join(work, "mounted"); mkdirSync(mounted);
      try {
        run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mounted, artifact]);
        verifyRelocation(mounted);
      } finally {
        try { run("/usr/bin/hdiutil", ["detach", mounted]); }
        catch { safeCleanup = false; refused(); } // Never recursively remove a possibly mounted tree.
      }
    }
    const receipt = { ...verified, distributable: !unsignedDevelopment, artifact: artifact.slice(destination.length + 1),
      artifactSha256: sha256(readFileSync(artifact)), notice: unsignedDevelopment ? "NOT DISTRIBUTABLE" : "Notarized container; installation is separate" };
    writeFileSync(join(destination, "artifact.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    accepted = true;
    return receipt;
  } catch (error) {
    console.error(`Native host packaging stopped at ${stage}.`);
    throw error;
  } finally {
    let current;
    try { current = lstatSync(destination); } catch { /* A removed reservation is not ours to recreate. */ }
    if (current?.dev === owned.dev && current?.ino === owned.ino && safeCleanup) {
      rmSync(work, { recursive: true, force: true });
      if (!accepted) {
        rmSync(payload, { recursive: true, force: true });
        if (artifact) rmSync(artifact, { force: true });
        if (readdirSync(destination).length === 0) rmdirSync(destination);
      }
    }
  }
}

function isEntryModule() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isEntryModule()) {
  const args = process.argv.slice(2), options = {};
  const names = { "--repo-root": "repoRoot", "--output": "output", "--build": "build",
    "--sign-identity": "signIdentity", "--keychain": "keychain" };
  try {
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--unsigned-dev") { options.unsignedDevelopment = true; continue; }
      const key = names[args[index]];
      if (!key || !args[index + 1] || args[index + 1].startsWith("--") || Object.hasOwn(options, key)) refused();
      options[key] = args[++index];
    }
    const receipt = await packageNativeHost(options);
    console.log(`${receipt.notice}: ${receipt.artifact}`);
  } catch {
    console.error("Native host packaging refused; no distributable artifact was accepted.");
    process.exitCode = 1;
  }
}
