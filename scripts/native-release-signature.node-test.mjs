import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { generateAppcast, nativeArtifactNames } from "./native-appcast.mjs";
import { verifyNativeArchiveSignature, verifyNativeRelease } from "./verify-native-release.mjs";

function fixtureKey(byte) {
  const seed = Buffer.alloc(32, byte);
  const privateKey = createPrivateKey({ key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"), seed,
  ]), format: "der", type: "pkcs8" });
  return { seed, privateKey, publicKey: createPublicKey(privateKey)
    .export({ format: "der", type: "spki" }).subarray(-32).toString("base64") };
}
const bytes = Buffer.from("504b0506000000000000000000000000000000000000", "hex");

test("Ed25519 verifies the final archive and refuses signature, same-length archive, key and encoding tampering", () => {
  const key = fixtureKey(41), signature = sign(null, bytes, key.privateKey).toString("base64");
  assert.doesNotThrow(() => verifyNativeArchiveSignature(bytes, signature, key.publicKey));
  const changed = Buffer.from(bytes); changed[0] ^= 1;
  const badSignature = Buffer.from(signature, "base64"); badSignature[0] ^= 1;
  for (const args of [[changed, signature, key.publicKey], [bytes, badSignature.toString("base64"), key.publicKey],
    [bytes, signature, fixtureKey(42).publicKey], [bytes, signature, undefined],
    [bytes, signature + "\n", key.publicKey], [bytes, signature, key.publicKey + "\n"]]) {
    assert.throws(() => verifyNativeArchiveSignature(...args), /Ed25519 signature verification failed/);
  }
});

test("release acceptance verifies actual ZIP bytes rather than signature presence or matching length", () => {
  const directory = mkdtempSync(join(tmpdir(), "bf-native-crypto-"));
  try {
    const version = "1.0.2200", key = fixtureKey(41), { zip, dmg } = nativeArtifactNames(version);
    writeFileSync(join(directory, zip), bytes); writeFileSync(join(directory, dmg), "fixture-dmg");
    writeFileSync(join(directory, `${zip}.edsig`), sign(null, bytes, key.privateKey).toString("base64"));
    generateAppcast({ releaseDir: directory, version });
    assert.equal(verifyNativeRelease(directory, version, { requireSignature: true, publicKey: key.publicKey }).signed, true);
    assert.equal(verifyNativeRelease(directory, version).signed, false);
    assert.throws(() => verifyNativeRelease(directory, version, { requireSignature: true }), /Ed25519/);
    const changed = Buffer.from(bytes); changed[0] ^= 1;
    writeFileSync(join(directory, zip), changed);
    assert.throws(() => verifyNativeRelease(directory, version, { requireSignature: true, publicKey: key.publicKey }), /Ed25519/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the actual CLI refuses a public-key flag without a value rather than accepting unsigned mode", () => {
  const directory = mkdtempSync(join(tmpdir(), "bf-native-cli-key-"));
  try {
    const version = "1.0.2200", { zip, dmg } = nativeArtifactNames(version);
    writeFileSync(join(directory, zip), bytes); writeFileSync(join(directory, dmg), "fixture-dmg");
    generateAppcast({ releaseDir: directory, version });
    const cli = fileURLToPath(new URL("./verify-native-release.mjs", import.meta.url));
    const plain = spawnSync(process.execPath, [cli, directory, version], { env: {}, encoding: "utf8" });
    assert.equal(plain.status, 0);
    for (const args of [["--public-key"], ["--public-key", ""],
      ["--public-key", "--build", "2200"], ["--public-key", "--require-signature"]]) {
      const result = spawnSync(process.execPath, [cli, directory, version, ...args], { env: {}, encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /--public-key requires a value/);
      assert.doesNotMatch(result.stdout, /DMG, ZIP and appcast agree/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// The explicit tool path is provided only for the owned Mac validation fixture.
// sign_update always receives this synthetic key file, so it never reads Keychain.
test("pinned Sparkle 2.9.6 sign_update and Node cross-verify raw archive signatures", {
  skip: !process.env.BOTFLEET_TEST_SPARKLE_SIGN_UPDATE,
}, () => {
  const directory = mkdtempSync(join(tmpdir(), "bf-sparkle-cross-oracle-"));
  try {
    const key = fixtureKey(41), otherKey = fixtureKey(42);
    const archive = join(directory, "fixture.zip"), keyFile = join(directory, "fixture-key");
    const otherKeyFile = join(directory, "other-fixture-key");
    writeFileSync(archive, bytes);
    writeFileSync(keyFile, key.seed.toString("base64"), { mode: 0o600 });
    writeFileSync(otherKeyFile, otherKey.seed.toString("base64"), { mode: 0o600 });
    const tool = process.env.BOTFLEET_TEST_SPARKLE_SIGN_UPDATE;
    const signed = spawnSync(tool, ["--ed-key-file", keyFile, "-p", archive], { encoding: "utf8" });
    assert.equal(signed.status, 0, "Pinned Sparkle fixture signing must succeed with the explicit synthetic seed");
    const sparkleSignature = signed.stdout.trim();
    verifyNativeArchiveSignature(readFileSync(archive), sparkleSignature, key.publicKey);
    const nodeSignature = sign(null, bytes, key.privateKey).toString("base64");
    assert.equal(sparkleSignature, nodeSignature);
    const verify = (signature, path = keyFile) => spawnSync(tool,
      ["--verify", "--ed-key-file", path, archive, signature], { encoding: "utf8" }).status;
    assert.equal(verify(nodeSignature), 0);
    assert.notEqual(verify(nodeSignature, otherKeyFile), 0);
    const tampered = Buffer.from(nodeSignature, "base64"); tampered[0] ^= 1;
    assert.notEqual(verify(tampered.toString("base64")), 0);
    const changed = Buffer.from(bytes); changed[0] ^= 1;
    writeFileSync(archive, changed);
    assert.notEqual(verify(nodeSignature), 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
