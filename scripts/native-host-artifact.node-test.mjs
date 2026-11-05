import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectHostMachO, verifyNativeHostArtifact, sha256 } from "./native-host-artifact.mjs";
import { packageNativeHost } from "./package-native-host.mjs";
import { build, identity, source, thin, universal } from "./native-host-macho.fixture.mjs";

const signature = () => ({ codeIdentifier: "BotFleetNativeHost", teamIdentifier: "CC8UTF7ATG", adHoc: false, hardenedRuntime: true });
function fixture(bytes = universal()) {
  const root = mkdtempSync(join(tmpdir(), "bf-host-artifact-")); mkdirSync(join(root, "bin"), { mode: 0o755 });
  const executable = join(root, "bin", "BotFleetNativeHost"); writeFileSync(executable, bytes, { mode: 0o755 });
  return { root, executable, options: { executable, stageRoot: root, expectedSource: source, expectedBuild: build,
    inspectSignature: signature }, remove: () => rmSync(root, { recursive: true, force: true }) };
}
test("the binary stamp, both architecture signatures and artifact digest are verified without trusting a sidecar", () => {
  const f = fixture(), inspected = [];
  try {
    writeFileSync(join(f.root, "artifact.json"), JSON.stringify({ sourceCommit: "untrusted-sidecar" }));
    assert.throws(() => verifyNativeHostArtifact(f.options), "an unlisted sidecar must not ship in the payload");
    unlinkSync(join(f.root, "artifact.json"));
    const receipt = verifyNativeHostArtifact({ ...f.options, expectedSha256: sha256(universal()),
      inspectSignature: (file, arch) => { inspected.push([file, arch]); return signature(); } });
    assert.equal(receipt.identity.sourceCommit, source); assert.equal(receipt.signatureVerified, true);
    assert.equal(receipt.distributable, false); // Container notarization is a separate producer gate.
    assert.deepEqual(receipt.architectures, ["arm64", "x86_64"]);
    assert.equal(inspected.length, 2); assert.equal(receipt.files.length, 1);
    assert.throws(() => verifyNativeHostArtifact({ ...f.options, expectedSha256: "0".repeat(64) }));
  } finally { f.remove(); }
});
for (const [label, change] of [["unknown source", { sourceCommit: "0".repeat(40) }], ["dirty", { sourceDirty: true }],
  ["numeric build", { build: Number(build) }], ["wrong marketing", { marketingVersion: "1.0.0" }],
  ["unsupported control", { capabilities: [...identity().capabilities, "checked-control-v1"] }],
  ["extra field", { ignored: "not permitted" }], ["wrong code id", { codeIdentifier: "foreign" }]]) {
  test(`${label} cannot become a trusted identity`, () => {
    const f = fixture(universal(thin({ stamp: identity(change) }), thin({ arch: "x86_64", stamp: identity(change) })));
    try { assert.throws(() => verifyNativeHostArtifact(f.options)); } finally { f.remove(); }
  });
}
test("missing stamps, mismatched slices and expected source/build substitutions are refused", () => {
  for (const bytes of [universal(thin({ stamp: null }), thin({ arch: "x86_64", stamp: null })), thin(),
    universal(thin(), thin({ arch: "x86_64", stamp: identity({ build: "202611031001" }) }))]) {
    const f = fixture(bytes);
    try { assert.throws(() => verifyNativeHostArtifact(f.options)); } finally { f.remove(); }
  }
  const f = fixture();
  try {
    assert.throws(() => verifyNativeHostArtifact({ ...f.options, expectedSource: "a".repeat(40) }));
    assert.throws(() => verifyNativeHostArtifact({ ...f.options, expectedBuild: "202611031001" }));
  } finally { f.remove(); }
});
for (const bad of [{ teamIdentifier: "FOREIGNTEAM" }, { codeIdentifier: "foreign" }, { adHoc: true }, { hardenedRuntime: false }]) {
  test(`a bad x86 signature (${Object.keys(bad)[0]}) is refused even when arm64 is valid`, () => {
    const f = fixture();
    try { assert.throws(() => verifyNativeHostArtifact({ ...f.options,
      inspectSignature: (_, arch) => Object.assign(signature(), arch === "x86_64" ? bad : null) })); }
    finally { f.remove(); }
  });
}
test("malformed fat/slice/section bounds cannot reach signature inspection", () => {
  const mutations = [
    (b) => b.writeUInt32BE(0xfffffff0, 16),
    (b) => b.writeUInt32BE(4096, 36),
    (b) => b.writeUInt32BE(0, 32),
    (b) => b.writeUInt32LE(0, 4096 + 32 + 4),
    (b) => b.writeUInt32LE(0xfffffff0, 4096 + 32 + 120),
    (b) => b.writeBigUInt64LE(5000n, 4096 + 32 + 112),
    (b) => b.writeBigUInt64LE(0n, 4096 + 32 + 104),
  ];
  for (const mutate of mutations) {
    const bytes = universal(); mutate(bytes);
    const f = fixture(bytes);
    try { assert.throws(() => verifyNativeHostArtifact({ ...f.options, inspectSignature: () => assert.fail("Malformed image reached signing") })); }
    finally { f.remove(); }
  }
});
test("full-width Mach-O names are valid, but loader paths still require NUL termination", () => {
  const fullWidth = thin();
  Buffer.from("0123456789abcdef").copy(fullWidth, 32 + 72);
  assert.equal(inspectHostMachO(fullWidth)[0].stamp, undefined);
  const unterminatedLoad = thin({ loads: ["/usr/lib/foo"] });
  Buffer.from("abcdefghijklmnop").copy(unterminatedLoad, 32 + 152 + 24);
  assert.throws(() => inspectHostMachO(unterminatedLoad));
});
test("unused build tool rpaths do not affect relocation, but searchable external roots are refused", () => {
  const rpath = "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift";
  const unused = fixture(universal(thin({ rpaths: [rpath] }), thin({ arch: "x86_64", rpaths: [rpath] })));
  try { assert.equal(verifyNativeHostArtifact(unused.options).files.length, 1); } finally { unused.remove(); }
  const used = fixture(universal(thin({ rpaths: [rpath], loads: ["@rpath/libfixture.dylib"] }),
    thin({ arch: "x86_64", rpaths: [rpath], loads: ["@rpath/libfixture.dylib"] })));
  try { assert.throws(() => verifyNativeHostArtifact(used.options)); } finally { used.remove(); }
});
test("a required loader resource must exist inside the relocated artifact with both slices", () => {
  const load = "@loader_path/../lib/libfixture.dylib";
  const f = fixture(universal(thin({ loads: [load] }), thin({ arch: "x86_64", loads: [load] })));
  try {
    assert.throws(() => verifyNativeHostArtifact(f.options));
    mkdirSync(join(f.root, "lib"), { mode: 0o755 });
    writeFileSync(join(f.root, "lib", "libfixture.dylib"), universal(thin({ stamp: null, fileType: 6 }),
      thin({ arch: "x86_64", stamp: null, fileType: 6 })), { mode: 0o644 });
    assert.equal(verifyNativeHostArtifact(f.options).files.length, 2);
  } finally { f.remove(); }
});
for (const load of ["/usr/lib/../../private/foreign.dylib", "@loader_path/../../foreign.dylib", "/Applications/Xcode.app/build/lib.dylib"]) {
  test(`loader escape ${load} is refused`, () => {
    const f = fixture(universal(thin({ loads: [load] }), thin({ arch: "x86_64", loads: [load] })));
    try { assert.throws(() => verifyNativeHostArtifact(f.options)); } finally { f.remove(); }
  });
}
test("lazy dylib loads and dyld environment commands cannot hide an external dependency", () => {
  for (const command of [0x20, 0x27]) {
    const arm = thin({ loads: ["/Applications/foreign.dylib"] });
    const intel = thin({ arch: "x86_64", loads: ["/Applications/foreign.dylib"] });
    arm.writeUInt32LE(command, 32 + 152);
    intel.writeUInt32LE(command, 32 + 152);
    const f = fixture(universal(arm, intel));
    try { assert.throws(() => verifyNativeHostArtifact(f.options)); }
    finally { f.remove(); }
  }
});
test("a resource symlink cannot point outside the staged tree", { skip: process.platform === "win32" }, () => {
  const load = "@loader_path/../lib.dylib", f = fixture(universal(thin({ loads: [load] }), thin({ arch: "x86_64", loads: [load] })));
  try { symlinkSync(process.execPath, join(f.root, "lib.dylib")); assert.throws(() => verifyNativeHostArtifact(f.options)); }
  finally { f.remove(); }
});
test("explicit unsigned-development mode remains nondistributable and never inspects credentials/signing", () => {
  const stamp = identity({ distribution: "unsigned-development", sourceDirty: true });
  const f = fixture(universal(thin({ stamp }), thin({ arch: "x86_64", stamp })));
  try {
    assert.throws(() => verifyNativeHostArtifact(f.options));
    const receipt = verifyNativeHostArtifact({ ...f.options, unsignedDevelopment: true,
      inspectSignature: () => assert.fail("Developer verification must not read signing material") });
    assert.equal(receipt.distributable, false);
  } finally { f.remove(); }
});
test("packaging refuses a symlinked output parent or dangling output before invoking a build", async () => {
  const root = mkdtempSync(join(tmpdir(), "bf-host-output-"));
  try {
    const repo = join(root, "repo"), alias = join(root, "alias"), dangling = join(root, "dangling");
    mkdirSync(repo);
    symlinkSync(repo, alias);
    symlinkSync(join(root, "missing"), dangling);
    const options = { repoRoot: repo, build, platform: "darwin", unsignedDevelopment: true,
      run: () => assert.fail("An unsafe output reached a build command") };
    await assert.rejects(packageNativeHost({ ...options, output: join(alias, "artifact") }));
    await assert.rejects(packageNativeHost({ ...options, output: dangling }));
    assert.equal(existsSync(join(repo, "artifact")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
