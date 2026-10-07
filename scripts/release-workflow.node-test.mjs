import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildMacFeed, regenerateMacFeed } from "./regenerate-mac-feed.mjs";
import { verifyReleaseAssets } from "./verify-release-assets.mjs";
import { verifyReleaseTag } from "./verify-release-tag.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "1.0.31";
const builderRequire = createRequire(createRequire(import.meta.url).resolve("electron-builder"));

function hash(file, algorithm, encoding) {
  return createHash(algorithm).update(readFileSync(file)).digest(encoding);
}

function feed(directory, version, urls) {
  const entries = urls.map((url) => ({
    url,
    sha512: hash(join(directory, url), "sha512", "base64"),
    size: readFileSync(join(directory, url)).length,
  }));
  return [
    `version: ${version}`,
    "files:",
    ...entries.flatMap((entry) => [
      `  - url: ${entry.url}`,
      `    sha512: ${entry.sha512}`,
      `    size: ${entry.size}`,
    ]),
    `path: ${entries[0].url}`,
    `sha512: ${entries[0].sha512}`,
    "releaseDate: '2026-09-12T00:00:00.000Z'",
    "",
  ].join("\n");
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "botfleet-release-"));
  const files = [
    `BotFleet-${VERSION}-arm64.zip`,
    `BotFleet-${VERSION}-x64.zip`,
    `BotFleet-${VERSION}-arm64.dmg`,
    `BotFleet-${VERSION}-x64.dmg`,
    `BotFleet-${VERSION}-setup.exe`,
    `BotFleet-${VERSION}-x86_64.AppImage`,
    `BotFleet-${VERSION}-amd64.deb`,
  ];
  for (const file of files) writeFileSync(join(directory, file), `bytes:${file}`);
  for (const file of files.slice(0, 5)) {
    execFileSync(process.platform === "win32" ? "python" : "python3", ["-c", `
import base64,gzip,hashlib,json,sys
from pathlib import Path
p=Path(sys.argv[1]); data=p.read_bytes()
blockmap={"version":"2","files":[{"name":"file","offset":0,"checksums":[base64.b64encode(hashlib.blake2b(data,digest_size=18).digest()).decode("ascii")],"sizes":[len(data)]}]}
Path(str(p)+".blockmap").write_bytes(gzip.compress(json.dumps(blockmap).encode()))
`, join(directory, file)]);
  }
  cpSync(join(directory, files[2]), join(directory, "BotFleet.dmg"));
  cpSync(join(directory, files[3]), join(directory, "BotFleet-intel.dmg"));
  cpSync(join(directory, files[4]), join(directory, "BotFleet-setup.exe"));
  cpSync(join(directory, files[5]), join(directory, "BotFleet.AppImage"));
  cpSync(join(directory, files[6]), join(directory, "BotFleet-amd64.deb"));
  writeFileSync(join(directory, "latest-mac.yml"), buildMacFeed(directory, VERSION, "2026-09-12T00:00:00.000Z"));
  writeFileSync(join(directory, "latest.yml"), feed(directory, VERSION, [files[4]]));
  writeFileSync(join(directory, "latest-linux.yml"), feed(directory, VERSION, [files[5], files[6]]));
  writeFileSync(
    join(directory, "SHA256SUMS-ubuntu-x64.txt"),
    [files[6], files[5]]
      .map((file) => `${hash(join(directory, file), "sha256", "hex")}  ${file}`)
      .join("\n") + "\n",
  );
  return { directory, files };
}

test("the assembled release has exact feeds, hashes, blockmaps, packages, and stable downloads", () => {
  const { directory } = fixture();
  try {
    assert.doesNotThrow(() => verifyReleaseAssets(directory, VERSION));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the verifier rejects stale feed bytes and stale stable downloads", () => {
  const staleFeed = fixture();
  const staleAlias = fixture();
  try {
    writeFileSync(join(staleFeed.directory, staleFeed.files[0]), "changed after feed generation");
    assert.throws(() => verifyReleaseAssets(staleFeed.directory, VERSION), /hash or size mismatch/);

    writeFileSync(join(staleAlias.directory, "BotFleet.dmg"), "stale alias");
    assert.throws(() => verifyReleaseAssets(staleAlias.directory, VERSION), /does not match/);
  } finally {
    rmSync(staleFeed.directory, { recursive: true, force: true });
    rmSync(staleAlias.directory, { recursive: true, force: true });
  }
});

test("the Linux feed must include and verify both generated package formats", () => {
  const missingDeb = fixture();
  const staleDeb = fixture();
  try {
    writeFileSync(join(missingDeb.directory, "latest-linux.yml"),
      feed(missingDeb.directory, VERSION, [missingDeb.files[5]]));
    assert.throws(() => verifyReleaseAssets(missingDeb.directory, VERSION),
      /latest-linux.yml: expected .*amd64\.deb/);

    writeFileSync(join(staleDeb.directory, staleDeb.files[6]), "changed deb after feed generation");
    assert.throws(() => verifyReleaseAssets(staleDeb.directory, VERSION),
      /latest-linux.yml: hash or size mismatch .*amd64\.deb/);
  } finally {
    rmSync(missingDeb.directory, { recursive: true, force: true });
    rmSync(staleDeb.directory, { recursive: true, force: true });
  }
});

test("mac feed regeneration replaces duplicate intermediate entries deterministically", () => {
  const { directory } = fixture();
  try {
    const feedPath = join(directory, "latest-mac.yml");
    writeFileSync(feedPath, "version: 0.0.0\nfiles:\n  - url: duplicate.zip\n");
    regenerateMacFeed({ feedPath, version: VERSION, releaseDate: "2026-09-12T00:00:00.000Z" });
    const text = readFileSync(feedPath, "utf8");
    assert.equal([...text.matchAll(/^\s{2}- url:/gm)].length, 4);
    assert.equal(new Set([...text.matchAll(/^\s{2}- url:\s+(\S+)/gm)].map((match) => match[1])).size, 4);
    assert.doesNotThrow(() => verifyReleaseAssets(directory, VERSION));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("valid artifact feeds cannot hide a corrupt or stale installer blockmap", () => {
  const corrupt = fixture();
  const stale = fixture();
  try {
    writeFileSync(join(corrupt.directory, `${corrupt.files[0]}.blockmap`), "corrupt map");
    assert.throws(() => verifyReleaseAssets(corrupt.directory, VERSION), /invalid blockmap/);
    cpSync(join(stale.directory, `${stale.files[1]}.blockmap`), join(stale.directory, `${stale.files[0]}.blockmap`));
    assert.throws(() => verifyReleaseAssets(stale.directory, VERSION), /invalid blockmap/);
  } finally {
    rmSync(corrupt.directory, { recursive: true, force: true });
    rmSync(stale.directory, { recursive: true, force: true });
  }
});

test("validates multiple chunks produced by the installed Electron packager", async () => {
  const { directory, files } = fixture();
  try {
    const { buildBlockMap } = builderRequire("app-builder-lib/out/targets/blockmap/blockmap.js");
    const artifact = join(directory, files[0]);
    writeFileSync(artifact, Buffer.alloc(100_000, 91));
    await buildBlockMap(artifact, "gzip", `${artifact}.blockmap`);
    writeFileSync(join(directory, "latest-mac.yml"), buildMacFeed(directory, VERSION, "2026-09-12T00:00:00.000Z"));
    assert.doesNotThrow(() => verifyReleaseAssets(directory, VERSION));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release workflow defaults to artifacts and requires explicit release mutation", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8").replace(/\r\n/g, "\n");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

  assert.equal(pkg.version, VERSION);
  assert.match(pkg.scripts["package:mac:arm64:release"], /electron-builder --mac --arm64 --publish never/);
  assert.match(pkg.scripts["package:mac:x64:release"], /electron-builder --mac --x64 --publish never/);
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /name: mac-release-\$\{\{ matrix\.arch \}\}/);
  assert.match(workflow, /mac-merge:/);
  assert.match(workflow, /draft:\n\s+description:[^\n]+\n\s+required: false\n\s+type: boolean\n\s+default: false/);
  assert.match(workflow, /publish:\n\s+description:[^\n]+\n\s+required: false\n\s+type: boolean\n\s+default: false/);
  assert.match(workflow, /Publish \(only when asked to\)[\s\S]*?if: \$\{\{ inputs\.publish \}\}/);
  assert.match(workflow, /Preserve the complete verified release set/);
  assert.match(workflow, /node scripts\/verify-release-assets\.mjs assets "\$VERSION"/);
  assert.match(workflow, /required: MAC_CERT_P12_BASE64 MAC_CERT_PASSWORD/);
  assert.doesNotMatch(workflow, /RELEASES_PAT/);
  assert.match(workflow, /release:\n\s+name: Create the GitHub release\n\s+if: \$\{\{ inputs\.draft \|\| inputs\.publish \}\}[\s\S]*?permissions:\n\s+contents: write/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(workflow, /group: release-\$\{\{ needs\.prepare\.outputs\.version \}\}/);
  assert.match(workflow, /--target "\$SHA"/);
  assert.match(workflow, /node scripts\/verify-release-tag\.mjs\n\s+cd assets/);
  assert.match(workflow, /existing draft targets \$existing_target, not pinned \$SHA/);
  assert.match(workflow, /node scripts\/verify-release-assets\.mjs uploaded "\$VERSION"/);
});

test("the windows packaging gate asserts the owner as well as the repo it names", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/package-win.yml"), "utf8").replace(/\r\n/g, "\n");
  const builder = readFileSync(join(ROOT, "electron-builder.yml"), "utf8").replace(/\r\n/g, "\n");
  // The error text names Simple-With-Us/BotFleet, so the gate has to check both halves.
  assert.match(workflow, /grep -q "\^owner: Simple-With-Us\$" "\$res\/app-update\.yml"/);
  assert.match(workflow, /grep -q "\^repo: BotFleet\$" "\$res\/app-update\.yml"/);
  // …and both halves have to match what electron-builder actually publishes.
  assert.match(builder, /publish:\n\s+- provider: github\n\s+owner: Simple-With-Us\n\s+repo: BotFleet/);
});

test("release tags must resolve to the pinned build, including nested annotated tags", async () => {
  const sha = "a".repeat(40);
  const annotation = "b".repeat(40);
  const nested = "c".repeat(40);
  const identity = { repo: "Simple-With-Us/BotFleet", tag: `v${VERSION}`, sha };
  const commit = (value) => ({ status: 200, body: { object: { type: "commit", sha: value } } });
  assert.deepEqual(await verifyReleaseTag({ ...identity, request: async () => commit(sha) }), { exists: true });
  await assert.rejects(verifyReleaseTag({ ...identity, request: async () => commit("d".repeat(40)) }), /different commit/);
  const calls = [];
  const request = async (path) => {
    calls.push(path);
    if (path.endsWith(`/tags/${nested}`)) return commit(sha);
    return { status: 200, body: { object: { type: "tag", sha: path.endsWith(`/tags/${annotation}`) ? nested : annotation } } };
  };
  assert.deepEqual(await verifyReleaseTag({ ...identity, request }), { exists: true });
  assert.deepEqual(calls, [
    `repos/${identity.repo}/git/ref/tags/${identity.tag}`,
    `repos/${identity.repo}/git/tags/${annotation}`,
    `repos/${identity.repo}/git/tags/${nested}`,
  ]);
});

test("only a missing ref permits tag creation; failed queries and broken chains fail closed", async () => {
  const identity = { repo: "Simple-With-Us/BotFleet", tag: `v${VERSION}`, sha: "a".repeat(40) };
  assert.deepEqual(await verifyReleaseTag({ ...identity, request: async () => ({ status: 404 }) }), { exists: false });
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(verifyReleaseTag({ ...identity, request: async () => ({ status }) }), /Cannot verify release tag/);
  }
  let calls = 0;
  await assert.rejects(verifyReleaseTag({ ...identity, request: async () => ++calls === 1
    ? { status: 200, body: { object: { type: "tag", sha: "b".repeat(40) } } }
    : { status: 404 } }), /Cannot peel release tag/);
  await assert.rejects(verifyReleaseTag({ ...identity, request: async () => ({ status: 200, body: { object: { type: "tag", sha: "b".repeat(40) } } }) }), /Invalid release tag chain/);
});
