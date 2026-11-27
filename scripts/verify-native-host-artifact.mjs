// Verify a packaged native host artifact against the release's own pins.
//
// The packager (scripts/package-native-host.mjs) verifies while it builds and
// writes artifact.json beside what it produced.  That receipt is the
// packager's word for the result, so the release workflow does not rest on it:
// this script reads the bytes on disk again, holds the receipt to the commit
// and build the run pinned, mounts the notarized disk image read-only and runs
// the artifact verifier on the executable inside it, real signature inspection
// included.  A refusal prints its reason and no pass line, and exits 1.
//
//   payload <dir> --source <sha> --build <build> [--unsigned-development]
//     An unpacked payload: <dir>/bin/BotFleetNativeHost and nothing else.
//   release <dir> --source <sha> --build <build> [--expect-artifact-sha256 <hex>] [--no-mount]
//     artifact.json and the notarized disk image it names.  --no-mount belongs
//     to a job that receives bytes another job already verified mounted;  it
//     still checks the receipt and the digest.
//
// It depends on nothing but node: builtins, so a release job needs no install
// before it runs.  It installs nothing, starts nothing and registers nothing:
// the image is mounted read-only and detached again, and no packaged
// executable is ever run.

import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encodeHostIdentity, HOST_CODE_ID, hostArtifactName, sha256File, verifyNativeHostArtifact } from "./native-host-artifact.mjs";

const PREFIX = "Native host artifact verification refused";
const refuse = (reason) => { throw new Error(`${PREFIX}: ${reason}`); };
const HEX64 = /^[0-9a-f]{64}$/;

function pinned(expectedSource, expectedBuild) {
  if (!/^[0-9a-f]{40}$/.test(expectedSource ?? "") || /^0+$/.test(expectedSource) ||
      !/^[0-9]{12}$/.test(expectedBuild ?? "") || /^0+$/.test(expectedBuild)) {
    refuse("the expected commit and build are not shaped like release pins");
  }
}

// The packager's receipt, with every field this verifier reads checked before
// it is believed.  Hand-validated like the packager's own boundary:  a release
// job runs before any install, so no schema runtime is available.
/* oxlint-disable anti-slop/no-runtime-typeof -- hand-written receipt boundary; zod is unavailable in the release job (see comment above) */
export function readHostReceipt(directory) {
  const malformed = () => refuse("artifact.json does not describe a packaged native host artifact");
  let receipt;
  try { receipt = JSON.parse(readFileSync(join(directory, "artifact.json"), "utf8")); }
  catch { malformed(); }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) malformed();
  const identity = receipt.identity;
  // encodeHostIdentity is the validator the stamp itself passed, so a receipt
  // cannot claim an identity no binary could carry, and comparing against the
  // canonical bytes also refuses a key the schema does not have.
  let canonical;
  try { canonical = encodeHostIdentity(identity).toString("utf8"); }
  catch { malformed(); }
  if (JSON.stringify(identity) !== canonical) malformed();
  if (typeof receipt.artifact !== "string" ||
      receipt.artifact !== hostArtifactName(identity.build, identity.distribution === "unsigned-development") ||
      !HEX64.test(receipt.artifactSha256 ?? "") || !HEX64.test(receipt.binarySha256 ?? "") ||
      !Array.isArray(receipt.architectures) || receipt.architectures.some((arch) => typeof arch !== "string") ||
      typeof receipt.signatureVerified !== "boolean" || typeof receipt.distributable !== "boolean" ||
      typeof receipt.notice !== "string") malformed();
  return receipt;
}
/* oxlint-enable anti-slop/no-runtime-typeof */

/** An unpacked payload against the pins: the identity stamp and both slices, and for a distributable artifact both real signatures. */
export function verifyHostPayload(directory, { expectedSource, expectedBuild, unsignedDevelopment = false, inspectSignature }) {
  pinned(expectedSource, expectedBuild);
  const root = realpathSync(directory);
  return verifyNativeHostArtifact({ executable: join(root, "bin", HOST_CODE_ID), stageRoot: root,
    expectedSource, expectedBuild, unsignedDevelopment, inspectSignature });
}

// Mount an image read-only at a private mount point and hand back that path.
function mountDiskImage(image) {
  const mountpoint = mkdtempSync(join(realpathSync(tmpdir()), "bf-native-host-mount-"));
  const attached = spawnSync("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountpoint, image],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (attached.status !== 0) {
    rmdirSync(mountpoint);
    refuse("the disk image did not mount");
  }
  return mountpoint;
}

// Detach, then remove the mount point, and only once the detach is confirmed:
// a tree that may still be mounted is never removed.
function unmountDiskImage(mountpoint) {
  const detached = spawnSync("/usr/bin/hdiutil", ["detach", mountpoint], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (detached.status !== 0) refuse("the disk image did not detach");
  rmdirSync(mountpoint);
}

/**
 * A release directory: artifact.json and the notarized disk image it names.
 *
 * The receipt has to describe a Developer ID artifact for exactly the pinned
 * commit and build, the image on disk has to hash to the digest the receipt
 * names (and to the digest another job verified, when one is given), and the
 * mounted image has to hold the executable the receipt names with its
 * signature intact.  Only a Developer ID artifact is accepted here:  an
 * unsigned development package is not a release, whatever it is renamed to.
 */
export async function verifyHostRelease({ directory, expectedSource, expectedBuild, expectedArtifactSha256,
  noMount = false, platform = process.platform, mountImage = mountDiskImage, unmountImage = unmountDiskImage,
  inspectSignature }) {
  pinned(expectedSource, expectedBuild);
  if (expectedArtifactSha256 !== undefined && !HEX64.test(expectedArtifactSha256)) refuse("the expected artifact digest is not a sha256");
  const root = realpathSync(directory), receipt = readHostReceipt(root);
  if (receipt.identity.distribution !== "developer-id") refuse("only a Developer ID artifact can join a release");
  if (receipt.identity.sourceCommit !== expectedSource || receipt.identity.build !== expectedBuild) {
    refuse("the receipt describes another commit or build than the pinned ones");
  }
  if (!receipt.distributable || !receipt.signatureVerified) refuse("the receipt does not describe a verified, distributable artifact");
  const artifact = join(root, receipt.artifact);
  let info;
  try { info = lstatSync(artifact); }
  catch { refuse("the artifact the receipt names is not there"); }
  if (!info.isFile()) refuse("the artifact the receipt names is not a regular file");
  const artifactSha256 = await sha256File(artifact);
  if (artifactSha256 !== receipt.artifactSha256) refuse("the artifact does not hash to the digest the receipt names");
  if (expectedArtifactSha256 !== undefined && artifactSha256 !== expectedArtifactSha256) {
    refuse("the artifact is not the one the build job verified");
  }
  let verified = null;
  if (!noMount) {
    if (platform !== "darwin") {
      refuse("mounting the disk image needs macOS; --no-mount belongs to a job that receives bytes another job verified");
    }
    // The image is detached on every path out, including a failed verification.
    const mountpoint = mountImage(artifact);
    try {
      verified = verifyNativeHostArtifact({ executable: join(mountpoint, "bin", HOST_CODE_ID), stageRoot: mountpoint,
        expectedSource, expectedBuild, inspectSignature });
    } finally { unmountImage(mountpoint); }
    if (verified.binarySha256 !== receipt.binarySha256) refuse("the executable in the image is not the one the receipt names");
  }
  return { receipt, artifact: receipt.artifact, artifactSha256, verified };
}

// Only this script's own refusal text is ever printed.  Anything else, such as
// a parse error quoting the bytes it choked on, is reduced to the bare refusal.
function refusalText(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(PREFIX) ? message : `${PREFIX}.`;
}

function isEntryModule() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isEntryModule()) {
  const [command, directory, ...rest] = process.argv.slice(2);
  const names = { "--source": "expectedSource", "--build": "expectedBuild", "--expect-artifact-sha256": "expectedArtifactSha256" };
  try {
    const options = {};
    let noMount = false, unsignedDevelopment = false;
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === "--no-mount") { noMount = true; continue; }
      if (rest[index] === "--unsigned-development") { unsignedDevelopment = true; continue; }
      const key = names[rest[index]];
      if (!key || !rest[index + 1] || rest[index + 1].startsWith("--") || Object.hasOwn(options, key)) {
        refuse("the command line is not understood");
      }
      options[key] = rest[++index];
    }
    if (!directory) refuse("a directory is required");
    if (command === "payload") {
      if (noMount || Object.hasOwn(options, "expectedArtifactSha256")) refuse("payload takes no mount or digest options");
      const verified = verifyHostPayload(directory, { ...options, unsignedDevelopment });
      console.log(`PASS native host payload: source ${verified.identity.sourceCommit}, build ${verified.identity.build}, ` +
        `${verified.architectures.join("+")}, ${verified.identity.distribution}` +
        `${unsignedDevelopment ? "" : ", signature verified"}.`);
    } else if (command === "release") {
      if (unsignedDevelopment) refuse("an unsigned development package is not a release; verify its payload instead");
      const { receipt, artifact, artifactSha256 } = await verifyHostRelease({ ...options, directory, noMount });
      console.log(`PASS native host artifact ${artifact}: source ${receipt.identity.sourceCommit}, build ${receipt.identity.build}, ` +
        `${receipt.architectures.join("+")}, developer-id, signature verified` +
        `${noMount ? ", bytes matched to the build job's digest" : ", mounted and verified"}.`);
      console.log(`artifact=${artifact}`);
      console.log(`artifact_sha256=${artifactSha256}`);
    } else {
      refuse("usage: verify-native-host-artifact.mjs payload <dir> | release <dir> --source <sha> --build <build> [--no-mount]");
    }
  } catch (error) {
    console.error(refusalText(error));
    process.exitCode = 1;
  }
}
