import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { HOST_CAPABILITIES, hostArtifactName, inspectHostMachO, verifyNativeHostArtifact, sha256 } from "./native-host-artifact.mjs";
import { nativeHostNotaryCredentials, packageNativeHost } from "./package-native-host.mjs";
import { build, identity, source, thin, universal } from "./native-host-macho.fixture.mjs";

// The wiring claim is about package.json, so the file is parsed through a
// schema instead of a bare JSON.parse: a shape that does not match is
// refused rather than read by accident.
//
// Only the entries this test reads are declared, and the schema strips
// everything it does not declare, at both levels: the parsed value holds the
// two named scripts and nothing else, never a key this test has not checked.
// The repository's other scripts and the file's other top-level keys are
// none of this gate's business, and nothing here is written back.
const PackageSchema = z.object({
  scripts: z.object({
    "test:native-release": z.string(),
    test: z.string(),
  }),
});

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
  ["unsupported control", { capabilities: [...identity().capabilities, "queued-jobs-v1"] }],
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
test("setuid files and sticky directories are refused like writable ones", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    assert.equal(verifyNativeHostArtifact(f.options).files.length, 1);
    chmodSync(f.executable, 0o4755);
    assert.throws(() => verifyNativeHostArtifact(f.options));
    chmodSync(f.executable, 0o755);
    chmodSync(join(f.root, "bin"), 0o1755);
    assert.throws(() => verifyNativeHostArtifact(f.options));
  } finally { f.remove(); }
});
// The native release lane's read token is scoped to exactly one folder, and
// the fetcher refuses a token whose scope does not match the folder asked for.
// The fixture answers for that folder, and for any narrower grant it refuses.
// No fixture here is credential-shaped:  the key marker is assembled at run time.
const releaseProject = "836aebe2-c8f7-4e09-978e-7e3e82500bce", releaseFolder = "/botfleet-server";
const fixtureKey = () => Buffer.from(`${["-----BEGIN", "PRIVATE", "KEY-----"].join(" ")}\nfixture\n${["-----END", "PRIVATE", "KEY-----"].join(" ")}\n`).toString("base64");
function notaryFetch({ scope = releaseFolder, names = {}, requests = [] } = {}) {
  return async (url) => {
    requests.push(String(url));
    if (String(url).includes("/service-token")) {
      return new Response(JSON.stringify({ workspace: releaseProject, scopes: [{ environment: "prod", secretPath: scope }],
        permissions: ["read"], expiresAt: null }));
    }
    return new Response(JSON.stringify({ secrets: Object.entries(names).map(([secretKey, secretValue]) => ({ workspace: releaseProject,
      environment: "prod", secretPath: releaseFolder, secretKey, secretValueHidden: false, secretValue })) }));
  };
}
test("a missing notarization secret is named without printing any value", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const printed = () => logged.mock.calls.map((call) => String(call.arguments[0])).join("\n");
  await assert.rejects(nativeHostNotaryCredentials({ env: {}, fetchImpl: () => assert.fail("No token reached the network") }), /packaging refused/);
  assert.match(printed(), /INFISICAL_NATIVE_RELEASE_READ_TOKEN/);
  await assert.rejects(nativeHostNotaryCredentials({ env: { INFISICAL_NATIVE_RELEASE_READ_TOKEN: "fixture" },
    fetchImpl: notaryFetch({ names: { APPLE_API_KEY_ID: "fixture-key-id" } }) }), /packaging refused/);
  assert.match(printed(), /APPLE_API_KEY_P8_BASE64 is missing or unresolved/);
  assert.doesNotMatch(printed(), /fixture-key-id/);
});
test("the notarization credentials are read from the folder the release lane's token covers", async (t) => {
  // The packager has to ask for that one folder.  A read at the project root
  // can only be refused there, after the app's own notarization, from the same
  // folder, has already succeeded.
  const logged = t.mock.method(console, "error", () => {});
  const names = { APPLE_API_KEY_P8_BASE64: fixtureKey(), APPLE_API_KEY_ID: "fixture-key-id", APPLE_API_ISSUER_ID: "fixture-issuer-id" };
  const requests = [];
  const credentials = await nativeHostNotaryCredentials({ env: { INFISICAL_NATIVE_RELEASE_READ_TOKEN: "fixture" },
    fetchImpl: notaryFetch({ names, requests }) });
  assert.deepEqual(credentials, { p8: Buffer.from(names.APPLE_API_KEY_P8_BASE64, "base64"), keyId: "fixture-key-id", issuerId: "fixture-issuer-id" });
  assert.equal(logged.mock.calls.length, 0);
  const list = new URL(requests.find((url) => url.includes("/secrets/raw?")) ?? "about:blank");
  assert.equal(list.searchParams.get("secretPath"), releaseFolder);
  assert.equal(list.searchParams.get("workspaceId"), releaseProject);
  assert.equal(list.searchParams.get("environment"), "prod");
  assert.equal(list.searchParams.get("expandSecretReferences"), "false");
  // A token scoped to the project root alone is refused at its own metadata,
  // before any secret is listed, and nothing is printed.
  const rootOnly = [];
  await assert.rejects(nativeHostNotaryCredentials({ env: { INFISICAL_NATIVE_RELEASE_READ_TOKEN: "fixture" },
    fetchImpl: notaryFetch({ scope: "/", requests: rootOnly }) }), /packaging refused/);
  assert.deepEqual(rootOnly.map((url) => url.includes("/service-token")), [true]);
  assert.equal(logged.mock.calls.length, 0);
});
test("a signed package stops at the notarization credentials before anything is built, and names the stage", async (t) => {
  // The credentials are read before the two release builds, so a grant that
  // does not reach the folder costs seconds instead of a build, and the log
  // says where it stopped rather than only that packaging was refused.
  const logged = t.mock.method(console, "error", () => {});
  const printed = () => logged.mock.calls.map((call) => String(call.arguments[0])).join("\n");
  const root = mkdtempSync(join(tmpdir(), "bf-host-notary-")), repo = join(root, "repo"), output = join(root, "artifact");
  mkdirSync(repo);
  let reads = 0, built = false;
  const options = { repoRoot: repo, output, build, platform: "darwin", signIdentity: "Developer ID Application",
    run: (command, args) => {
      if (command === "git") return args.includes("rev-parse") ? source : "";
      built = true;
      assert.fail("A build command ran");
    } };
  try {
    // The reader's own error is what propagates; the stage line is what the log gains.
    await assert.rejects(packageNativeHost({ ...options, readCredentials: () => { reads += 1; throw new Error("no grant"); } }), /no grant/);
    assert.match(printed(), /stopped at notarization credentials/);
    assert.equal(built, false);
    assert.equal(existsSync(output), false);
    // The unsigned development package reads no credentials at all:  it gets as
    // far as its first build command without ever asking for them.
    await assert.rejects(packageNativeHost({ ...options, unsignedDevelopment: true,
      readCredentials: () => { reads += 1; throw new Error("no grant"); } }));
    assert.equal(built, true);
    assert.equal(reads, 1);
    assert.equal(existsSync(output), false); // A failed package leaves nothing behind.
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("the artifact name is one function for the signed image and the unsigned archive", () => {
  // The two never share a name, so a NOT DISTRIBUTABLE archive cannot be
  // mistaken for the release artifact, and the packager and the release
  // verifier cannot disagree about what a build is called.
  assert.equal(hostArtifactName(build), `BotFleetNativeHost-0.1.0-${build}.dmg`);
  assert.equal(hostArtifactName(build, true), `BotFleetNativeHost-0.1.0-${build}-UNSIGNED.zip`);
  for (const bad of ["20261103100", "0".repeat(12), 202611031000, undefined, null]) assert.throws(() => hostArtifactName(bad), /verification refused/);
  const packager = readFileSync(new URL("./package-native-host.mjs", import.meta.url), "utf8");
  assert.match(packager, /const name = hostArtifactName\(build, unsignedDevelopment\);/);
  // Both distributions name their file through it, and nothing spells the stem by hand.
  assert.equal(packager.split("artifact = join(destination, name);").length - 1, 2);
  assert.doesNotMatch(packager, /BotFleetNativeHost-0\.1\.0-/);
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
const swiftIntermediates = ["BotFleetNativeHost.build", "BotFleetNativeHost.product", "CompanionCore.build", "CompanionCore.swiftmodule", "Modules", "description.json"];
async function packageWithBinPathEntries(entries) {
  const root = mkdtempSync(join(tmpdir(), "bf-host-binpath-")), repo = join(root, "repo");
  mkdirSync(repo);
  const run = (command, args) => {
    if (command === "git") return args.includes("rev-parse") ? source : "";
    if (command === "/usr/bin/lipo") throw new Error("reached universal assembly");
    if (command !== "swift" || !args.includes("--show-bin-path")) return "";
    const arch = args[args.indexOf("--arch") + 1], binPath = join(root, `bin-${arch}`);
    mkdirSync(binPath);
    writeFileSync(join(binPath, "BotFleetNativeHost"), thin({ arch, stamp: identity({ distribution: "unsigned-development" }) }));
    for (const entry of entries) mkdirSync(join(binPath, entry));
    return `${binPath}\n`;
  };
  try {
    await packageNativeHost({ repoRoot: repo, output: join(root, "artifact"), build, platform: "darwin", unsignedDevelopment: true, run });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test("SwiftPM intermediates beside the executable do not refuse packaging", async () => {
  await assert.rejects(packageWithBinPathEntries(swiftIntermediates), /reached universal assembly/);
});
for (const product of ["Host_Core.bundle", "Core.framework", "libCore.dylib"]) {
  test(`an unpackaged ${product} product is refused before universal assembly`, async () => {
    await assert.rejects(packageWithBinPathEntries([...swiftIntermediates, product]), /packaging refused/);
  });
}
test("the native-release chain runs this proof, and hosted CI runs the chain", () => {
  // vitest does not collect *.node-test.mjs.  Hosted CI runs `pnpm test`,
  // which only reaches a node:test file that package.json names, so the
  // identity proof is only proved when both name it.
  const parsed = PackageSchema.safeParse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")));
  assert.ok(parsed.success, "package.json names no native-release test chain");
  const pkg = parsed.data;
  const nativeRelease = pkg.scripts["test:native-release"];
  assert.match(nativeRelease, /scripts\/native-host-artifact\.node-test\.mjs/);
  assert.match(pkg.scripts.test, /pnpm test:native-release/);
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci, /run: pnpm test$/m);
});
test("the Swift stamp mirror names exactly the capabilities the packaging gate writes", () => {
  // BF-2605:  `NativeHostArtifactIdentity` (BotFleetNativeHost) reads the same
  // signed stamp this gate verifies, and its capability list was held to
  // HOST_CAPABILITIES only by convention.  This test reads the Swift source
  // and holds the literal list to the TypeScript one, so a capability added,
  // renamed or dropped on either side fails here before it can ship.
  const swift = readFileSync(new URL("../ios/Scripts/BotFleetNativeHost/NativeHostArtifactIdentity.swift", import.meta.url), "utf8");
  const match = swift.match(/static let capabilities = \[([^\]]*)\]/);
  assert.ok(match, "the Swift capability literal was not found");
  const swiftCapabilities = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  assert.deepEqual(swiftCapabilities, HOST_CAPABILITIES);
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
