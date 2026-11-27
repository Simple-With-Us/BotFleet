// The release-side native host verifier's own tests.
//
// scripts/verify-native-host-artifact.mjs is what the native release workflow
// runs over the packaged host before anything is uploaded or attached, so every
// rule it applies is decided here, on every host, against synthetic binaries
// and stand-ins for the mounted disk image.  The real image, mounted read-only,
// is proved on a Mac by the recipe in docs/verification/native-host-package.md
// and by the release run itself.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hostArtifactName, sha256 } from "./native-host-artifact.mjs";
import { build, identity, source, thin, universal } from "./native-host-macho.fixture.mjs";
import { readHostReceipt, unmountDiskImage, verifyHostPayload, verifyHostRelease } from "./verify-native-host-artifact.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "verify-native-host-artifact.mjs");
const REFUSAL = /Native host artifact verification refused/;
const EXECUTABLE = "bin/BotFleetNativeHost";
const signature = () => ({ codeIdentifier: "BotFleetNativeHost", teamIdentifier: "CC8UTF7ATG", adHoc: false, hardenedRuntime: true });
const executableWith = (stamp) => universal(thin({ stamp }), thin({ arch: "x86_64", stamp }));

/** A directory holding one universal executable: what a mounted image or an opened archive presents. */
function payloadDirectory(bytes = universal()) {
  const root = mkdtempSync(join(tmpdir(), "bf-host-payload-"));
  mkdirSync(join(root, "bin"), { mode: 0o755 });
  writeFileSync(join(root, EXECUTABLE), bytes, { mode: 0o755 });
  return root;
}

/**
 * A stand-in for a release directory: artifact.json laid out as the packager
 * writes it, the disk image it names, and the payload that mounting the image
 * presents. `receipt` and `stamp` override single fields of each.
 */
function releaseFixture({ receipt = {}, stamp = {}, bytes = Buffer.from("disk-image-bytes"), imageBytes } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bf-host-release-")), artifact = hostArtifactName(build);
  const executable = imageBytes ?? universal(), digest = sha256(executable);
  const written = { identity: { ...identity(), ...stamp }, architectures: ["arm64", "x86_64"], binarySha256: digest,
    files: [{ path: EXECUTABLE, sha256: digest }], signatureVerified: true, distributable: true,
    artifact, artifactSha256: sha256(bytes), notice: "Notarized container; installation is separate", ...receipt };
  writeFileSync(join(root, artifact), bytes);
  writeFileSync(join(root, "artifact.json"), JSON.stringify(written, null, 2) + "\n");
  const image = payloadDirectory(executable);
  // The mount pair the verifier calls: mounting hands over the payload, and
  // every detach is recorded.
  const detached = [], mount = () => image, unmount = (path) => { detached.push(path); };
  return { root, artifact, bytes, receipt: written, image, mount, unmount, detached,
    remove: () => { rmSync(root, { recursive: true, force: true }); rmSync(image, { recursive: true, force: true }); } };
}

test("a release directory with matching pins, bytes and mounted executable passes, and the image is detached", async () => {
  const f = releaseFixture();
  try {
    const result = await verifyHostRelease({ directory: f.root, expectedSource: source, expectedBuild: build,
      mountImage: f.mount, unmountImage: f.unmount, inspectSignature: () => signature() });
    assert.equal(result.artifact, f.artifact);
    assert.equal(result.artifactSha256, sha256(f.bytes));
    assert.deepEqual(result.receipt, f.receipt);
    assert.equal(result.verified.identity.sourceCommit, source);
    assert.equal(result.verified.identity.build, build);
    assert.equal(result.verified.signatureVerified, true);
    assert.deepEqual(result.verified.architectures, ["arm64", "x86_64"]);
    assert.deepEqual(f.detached, [f.image]);
  } finally { f.remove(); }
});

test("the image is detached on every path out, including a failed verification", async () => {
  const stray = releaseFixture();
  try {
    // A stray file makes the image something other than the payload verified.
    writeFileSync(join(stray.image, "stray"), "x");
    await assert.rejects(verifyHostRelease({ directory: stray.root, expectedSource: source, expectedBuild: build,
      mountImage: stray.mount, unmountImage: stray.unmount, inspectSignature: () => signature() }), REFUSAL);
    assert.deepEqual(stray.detached, [stray.image]);
  } finally { stray.remove(); }
  const substituted = releaseFixture({ receipt: { binarySha256: "0".repeat(64) } });
  try {
    // The mounted binary verifies on its own, but it is not the one the receipt names.
    await assert.rejects(verifyHostRelease({ directory: substituted.root, expectedSource: source, expectedBuild: build,
      mountImage: substituted.mount, unmountImage: substituted.unmount, inspectSignature: () => signature() }),
    /executable in the image is not the one the receipt names/);
    assert.deepEqual(substituted.detached, [substituted.image]);
  } finally { substituted.remove(); }
});

test("a receipt for another commit or build than the pinned ones is refused before anything is mounted", async () => {
  const f = releaseFixture();
  try {
    for (const [expectedSource, expectedBuild] of [["f".repeat(40), build], [source, "202611031001"]]) {
      await assert.rejects(verifyHostRelease({ directory: f.root, expectedSource, expectedBuild,
        mountImage: () => assert.fail("A mismatched receipt reached the mount"), unmountImage: () => {} }), /another commit or build/);
    }
    // Pins that are not shaped like a commit or a build are refused too.
    for (const [expectedSource, expectedBuild] of [["", build], [source, "1"], ["0".repeat(40), build]]) {
      await assert.rejects(verifyHostRelease({ directory: f.root, expectedSource, expectedBuild, noMount: true }), /release pins/);
    }
    assert.deepEqual(f.detached, []);
  } finally { f.remove(); }
});

test("bytes that are not the ones the receipt names, or not the ones the build job verified, are refused", async () => {
  // A receipt that was written for other bytes than the ones on disk.
  const swapped = releaseFixture();
  try {
    writeFileSync(join(swapped.root, swapped.artifact), "other-bytes");
    await assert.rejects(verifyHostRelease({ directory: swapped.root, expectedSource: source, expectedBuild: build, noMount: true }),
      /does not hash to the digest the receipt names/);
  } finally { swapped.remove(); }
  const f = releaseFixture();
  try {
    await assert.rejects(verifyHostRelease({ directory: f.root, expectedSource: source, expectedBuild: build, noMount: true,
      expectedArtifactSha256: "c".repeat(64) }), /not the one the build job verified/);
    await assert.rejects(verifyHostRelease({ directory: f.root, expectedSource: source, expectedBuild: build, noMount: true,
      expectedArtifactSha256: "not-a-digest" }), /expected artifact digest is not a sha256/);
    // The digest the build job actually reported is accepted.
    const result = await verifyHostRelease({ directory: f.root, expectedSource: source, expectedBuild: build, noMount: true,
      expectedArtifactSha256: sha256(f.bytes) });
    assert.equal(result.artifactSha256, sha256(f.bytes));
    // An artifact that is not a regular file is refused.
    rmSync(join(f.root, f.artifact));
    mkdirSync(join(f.root, f.artifact));
    await assert.rejects(verifyHostRelease({ directory: f.root, expectedSource: source, expectedBuild: build, noMount: true }),
      /not a regular file/);
  } finally { f.remove(); }
});

test("an unsigned development package is not a release, and neither is a Developer ID receipt that claims no verification", async () => {
  const unsigned = releaseFixture({ stamp: { distribution: "unsigned-development" },
    receipt: { artifact: hostArtifactName(build, true), distributable: false, signatureVerified: false, notice: "NOT DISTRIBUTABLE" } });
  try {
    // The receipt is internally consistent, which is what makes it a trap.
    assert.deepEqual(readHostReceipt(unsigned.root), unsigned.receipt);
    await assert.rejects(verifyHostRelease({ directory: unsigned.root, expectedSource: source, expectedBuild: build, noMount: true }),
      /only a Developer ID artifact can join a release/);
  } finally { unsigned.remove(); }
  for (const receipt of [{ signatureVerified: false }, { distributable: false }]) {
    const unverified = releaseFixture({ receipt });
    try {
      await assert.rejects(verifyHostRelease({ directory: unverified.root, expectedSource: source, expectedBuild: build, noMount: true,
        mountImage: () => assert.fail("An unverified receipt reached the mount") }), /verified, distributable artifact/);
    } finally { unverified.remove(); }
  }
});

test("--no-mount checks the receipt and the digest without mounting, and still refuses what does not match", async () => {
  const f = releaseFixture();
  try {
    const result = await verifyHostRelease({ directory: f.root, expectedSource: source, expectedBuild: build, noMount: true,
      platform: "linux", mountImage: () => assert.fail("--no-mount mounted the image") });
    assert.equal(result.verified, null);
    assert.equal(result.artifactSha256, sha256(f.bytes));
    await assert.rejects(verifyHostRelease({ directory: f.root, expectedSource: source, expectedBuild: "202611031001", noMount: true }),
      /another commit or build/);
  } finally { f.remove(); }
});

test("mounting is refused off macOS unless the caller says not to", async () => {
  const f = releaseFixture();
  try {
    await assert.rejects(verifyHostRelease({ directory: f.root, expectedSource: source, expectedBuild: build, platform: "linux",
      mountImage: () => assert.fail("A job with no macOS mounted the image"), unmountImage: () => {} }), /--no-mount belongs to a job/);
    assert.deepEqual(f.detached, []);
  } finally { f.remove(); }
});

/** A private directory the way the verifier makes a mount point, holding whatever `entries` names. */
function mountPoint(entries = []) {
  const directory = mkdtempSync(join(tmpdir(), "bf-host-mount-"));
  for (const entry of entries) writeFileSync(join(directory, entry), "x");
  return directory;
}

test("a mount point is removed with whatever was left inside it, once the detach is confirmed twice", () => {
  // The ordinary case: detached, and nothing left behind.
  const empty = mountPoint();
  unmountDiskImage(empty, { detached: () => true, mounted: () => false });
  assert.equal(existsSync(empty), false);
  // Detached, and something left an entry behind: a verification that passed
  // is not failed by the cleaning up.
  const stray = mountPoint(["left-behind"]);
  unmountDiskImage(stray, { detached: () => true, mounted: () => false });
  assert.equal(existsSync(stray), false);
  // With no stand-in, the file system's own answer for an ordinary directory
  // is that nothing is mounted there.
  const ordinary = mountPoint();
  unmountDiskImage(ordinary, { detached: () => true });
  assert.equal(existsSync(ordinary), false);
  // A mount point that is already gone is nothing to remove.
  const gone = mountPoint();
  rmSync(gone, { recursive: true, force: true });
  unmountDiskImage(gone, { detached: () => true });
  assert.equal(existsSync(gone), false);
});

test("a tree that may still be mounted is never removed", () => {
  // hdiutil answers that the detach worked, and the file system answers otherwise.
  const stillMounted = mountPoint(["volume-content"]);
  try {
    assert.throws(() => unmountDiskImage(stillMounted, { detached: () => true, mounted: () => true }), /still mounted after the detach/);
    assert.deepEqual(readdirSync(stillMounted), ["volume-content"]);
  } finally { rmSync(stillMounted, { recursive: true, force: true }); }
  // hdiutil could not detach, so the file system is not asked.
  const busy = mountPoint(["volume-content"]);
  try {
    assert.throws(() => unmountDiskImage(busy, { detached: () => false,
      mounted: () => assert.fail("A failed detach was asked whether anything was still mounted") }), /did not detach/);
    assert.deepEqual(readdirSync(busy), ["volume-content"]);
  } finally { rmSync(busy, { recursive: true, force: true }); }
});

test("a receipt is checked field by field before it is believed", () => {
  const f = releaseFixture();
  const rewrite = (text) => writeFileSync(join(f.root, "artifact.json"), text);
  // The receipt as the packager writes it is accepted.
  const genuine = readHostReceipt(f.root);
  try {
    assert.deepEqual(genuine, f.receipt);
    const variants = [
      ["not JSON", "artifact.json is not here"],
      ["an array", "[]"],
      ["an identity with a key of its own", JSON.stringify({ ...f.receipt, identity: { ...f.receipt.identity, ignored: true } })],
      ["an identity with a numeric build", JSON.stringify({ ...f.receipt, identity: { ...f.receipt.identity, build: Number(build) } })],
      ["an identity missing a key", JSON.stringify({ ...f.receipt, identity: { ...f.receipt.identity, sourceDirty: undefined } })],
      ["an artifact named for another build", JSON.stringify({ ...f.receipt, artifact: hostArtifactName("202611031001") })],
      ["an unsigned archive as the artifact", JSON.stringify({ ...f.receipt, artifact: hostArtifactName(build, true) })],
      ["a digest that is not hex", JSON.stringify({ ...f.receipt, artifactSha256: "z".repeat(64) })],
      ["a missing binary digest", JSON.stringify({ ...f.receipt, binarySha256: undefined })],
      ["architectures that are not a list", JSON.stringify({ ...f.receipt, architectures: "arm64+x86_64" })],
      ["architectures with a non-string", JSON.stringify({ ...f.receipt, architectures: ["arm64", 64] })],
      ["a signature flag that is not a boolean", JSON.stringify({ ...f.receipt, signatureVerified: "true" })],
      ["no notice", JSON.stringify({ ...f.receipt, notice: undefined })],
    ];
    for (const [label, text] of variants) {
      assert.throws(() => { rewrite(text); readHostReceipt(f.root); }, /does not describe a packaged native host artifact/, label);
    }
  } finally { f.remove(); }
});

test("payload verifies an unpacked payload in the unsigned development mode and refuses the wrong pins", () => {
  const unsigned = payloadDirectory(executableWith(identity({ distribution: "unsigned-development" })));
  try {
    const verified = verifyHostPayload(unsigned, { expectedSource: source, expectedBuild: build, unsignedDevelopment: true });
    assert.equal(verified.identity.distribution, "unsigned-development");
    assert.equal(verified.signatureVerified, false);
    assert.throws(() => verifyHostPayload(unsigned, { expectedSource: source, expectedBuild: "202611031001", unsignedDevelopment: true }), REFUSAL);
    // Held to the distributable standard instead, it is refused:  the verifier
    // asks the real signature inspector, which finds no signature to trust.
    assert.throws(() => verifyHostPayload(unsigned, { expectedSource: source, expectedBuild: build }), REFUSAL);
  } finally { rmSync(unsigned, { recursive: true, force: true }); }
});

/** Run the verifier's command line and hand back its status and both streams. */
async function cli(args) {
  try {
    const out = await promisify(execFile)(process.execPath, [SCRIPT, ...args]);
    return { status: 0, stdout: out.stdout, stderr: out.stderr };
  } catch (error) {
    return { status: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test("the command line prints a pass line only on success, and a refusal never carries one", async () => {
  const unsigned = payloadDirectory(executableWith(identity({ distribution: "unsigned-development" })));
  const f = releaseFixture();
  try {
    const payload = await cli(["payload", unsigned, "--source", source, "--build", build, "--unsigned-development"]);
    assert.equal(payload.status, 0, payload.stderr);
    assert.equal(payload.stdout.trim(), `PASS native host payload: source ${source}, build ${build}, arm64+x86_64, unsigned-development.`);
    const wrongBuild = await cli(["payload", unsigned, "--source", source, "--build", "202611031001", "--unsigned-development"]);
    assert.equal(wrongBuild.status, 1);
    assert.equal(wrongBuild.stdout, "");
    assert.match(wrongBuild.stderr, REFUSAL);

    const release = await cli(["release", f.root, "--source", source, "--build", build, "--no-mount"]);
    assert.equal(release.status, 0, release.stderr);
    assert.equal(release.stdout, `PASS native host artifact ${f.artifact}: source ${source}, build ${build}, arm64+x86_64, ` +
      `developer-id, signature verified, bytes matched to the build job's digest.\nartifact=${f.artifact}\n` +
      `artifact_sha256=${sha256(f.bytes)}\n`);
    // The digest another job reported is honoured on the command line as well.
    const pinned = await cli(["release", f.root, "--source", source, "--build", build, "--no-mount",
      "--expect-artifact-sha256", "c".repeat(64)]);
    assert.equal(pinned.status, 1);
    assert.equal(pinned.stdout, "");
    assert.match(pinned.stderr, /not the one the build job verified/);
    // No release without pins, no release from an unsigned package, and no
    // silent fallback for a command line that is not understood.  (The case
    // that omits --no-mount is decided in the function above, on the platform,
    // so that no host ever asks hdiutil to mount these fixture bytes.)
    for (const args of [
      ["release", f.root, "--build", build, "--no-mount"],
      ["release", f.root, "--source", source, "--build", build, "--no-mount", "--unsigned-development"],
      ["release", f.root, "--source", source, "--build", build, "--no-mount", "--unsigned"],
      ["payload", unsigned, "--source", source, "--build", build, "--unsigned-development", "--no-mount"],
      ["payload", unsigned, "--source", source, "--source", source, "--build", build],
      ["release"],
    ]) {
      const refused = await cli(args);
      assert.equal(refused.status, 1, args.join(" "));
      assert.equal(refused.stdout, "", args.join(" "));
      assert.match(refused.stderr, REFUSAL);
    }
  } finally { f.remove(); rmSync(unsigned, { recursive: true, force: true }); }
});

test("the native-release chain runs this file, and the release workflow runs the verifier on the host it packages", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts["test:native-release"], /scripts\/verify-native-host-artifact\.node-test\.mjs/);
  assert.match(pkg.scripts.test, /pnpm test:native-release/);
  const workflow = readFileSync(new URL("../.github/workflows/native-mac-release.yml", import.meta.url), "utf8");
  assert.equal(workflow.split("node scripts/verify-native-host-artifact.mjs release").length - 1, 2);
  // The receipt this verifier reads is the one the packager writes:  its
  // identity and file digests come from the artifact verifier, and only the
  // distributable flag and the name differ between the two distributions.
  const packager = readFileSync(new URL("./package-native-host.mjs", import.meta.url), "utf8");
  assert.match(packager, /const receipt = \{ \.\.\.verified, distributable: !unsignedDevelopment, artifact: /);
  assert.match(packager, /artifactSha256: await sha256File\(artifact\)/);
});
