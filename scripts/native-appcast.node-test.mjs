import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildAppcast,
  buildNumberFor,
  generateAppcast,
  nativeArtifactNames,
} from "./native-appcast.mjs";
import { verifyNativeRelease } from "./verify-native-release.mjs";

const VERSION = "1.0.2200";
const privateKey = createPrivateKey({ key: Buffer.concat([
  Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 77),
]), format: "der", type: "pkcs8" });
const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32).toString("base64");

function fixture({ signed = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "botfleet-native-release-"));
  const { zip, dmg } = nativeArtifactNames(VERSION);
  writeFileSync(join(directory, zip), "stapled-native-zip-bytes");
  writeFileSync(join(directory, dmg), "stapled-native-dmg-bytes");
  if (signed) {
    writeFileSync(
      join(directory, `${zip}.edsig`),
      sign(null, readFileSync(join(directory, zip)), privateKey).toString("base64"),
    );
  }
  return directory;
}

test("the build number is the commit count, not an invented component", () => {
  assert.equal(buildNumberFor("1.0.2200"), "2200");
  assert.throws(() => buildNumberFor("2.1.0"), /1\.0\.<commit_count>/);
  assert.throws(() => buildNumberFor("1.0.31-beta"), /1\.0\.<commit_count>/);
});

test("a generated appcast verifies against the stapled bytes", () => {
  const directory = fixture();
  try {
    const { signed } = generateAppcast({ releaseDir: directory, version: VERSION });
    assert.equal(signed, false);
    assert.doesNotThrow(() => verifyNativeRelease(directory, VERSION));
    const xml = readFileSync(join(directory, "appcast.xml"), "utf8");
    assert.match(xml, /<sparkle:version>2200<\/sparkle:version>/);
    assert.match(xml, /BotFleetMac-1\.0\.2200\.zip/);
    // The Electron feed namespace must never appear as a native enclosure.
    assert.doesNotMatch(xml, /enclosure url="[^"]*\/BotFleet-1\./);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a signed sidecar lands in the enclosure and satisfies the signature gate", () => {
  const directory = fixture({ signed: true });
  try {
    const { signed } = generateAppcast({ releaseDir: directory, version: VERSION });
    assert.equal(signed, true);
    assert.doesNotThrow(() =>
      verifyNativeRelease(directory, VERSION, { requireSignature: true, publicKey }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unsigned draft fails the publish gate, not the draft check", () => {
  const directory = fixture();
  try {
    generateAppcast({ releaseDir: directory, version: VERSION });
    assert.throws(
      () => verifyNativeRelease(directory, VERSION, { requireSignature: true }),
      /no sparkle:edSignature/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("verification rejects a length measured before stapling", () => {
  const directory = fixture();
  try {
    generateAppcast({ releaseDir: directory, version: VERSION });
    // Stapling (or any later byte change) without regenerating the feed.
    writeFileSync(join(directory, nativeArtifactNames(VERSION).zip), "different-bytes-now");
    assert.throws(() => verifyNativeRelease(directory, VERSION), /regenerate the appcast after stapling/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("generation refuses an Electron-namespace ZIP in the same directory", () => {
  const directory = fixture();
  try {
    writeFileSync(join(directory, `BotFleet-${VERSION}-arm64.zip`), "electron-bytes");
    assert.throws(
      () => generateAppcast({ releaseDir: directory, version: VERSION }),
      /Electron-namespace ZIPs/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("items must be newest-first so Sparkle offers the head build", () => {
  assert.throws(
    () =>
      buildAppcast({
        version: VERSION,
        items: [
          { build: "2200", shortVersion: VERSION, url: "https://example.invalid/BotFleetMac-1.0.2200.zip", length: 10 },
          { build: "2201", shortVersion: "1.0.2201", url: "https://example.invalid/BotFleetMac-1.0.2201.zip", length: 10 },
        ],
      }),
    /newest-first/,
  );
});

test("a mirror feed base moves the channel link and the enclosure together", () => {
  const appcast = buildAppcast({
    version: VERSION,
    feedBaseUrl: "https://mirror.invalid/botfleet/releases/download",
    items: [
      {
        build: buildNumberFor(VERSION),
        shortVersion: VERSION,
        url: `https://mirror.invalid/botfleet/releases/download/v${VERSION}/BotFleetMac-${VERSION}.zip`,
        length: 10,
      },
    ],
  });
  assert.match(appcast, /<link>https:\/\/mirror\.invalid\/botfleet\/releases<\/link>/);
  assert.match(appcast, /https:\/\/mirror\.invalid\/botfleet\/releases\/download\/v/);
});

test("generateAppcast carries a mirror feed base into both the enclosure and the link", () => {
  const directory = fixture();
  try {
    const mirror = "https://mirror.invalid/botfleet/releases/download";
    generateAppcast({ releaseDir: directory, version: VERSION, feedBaseUrl: mirror });
    const appcast = readFileSync(join(directory, "appcast.xml"), "utf8");
    assert.match(
      appcast,
      new RegExp(`<enclosure url="${mirror}/v${VERSION}/BotFleetMac-${VERSION}\\.zip"`),
    );
    assert.match(appcast, /<link>https:\/\/mirror\.invalid\/botfleet\/releases<\/link>/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a 0.1.0 release carries its build as its own value", () => {
  // The shared release policy writes the marketing version 0.1.0 and the
  // build as the commit's Central merge stamp, so the build is its own value
  // and can never be derived from the version string.
  assert.equal(buildNumberFor("0.1.0", "202610291425"), "202610291425");
  const appcast = buildAppcast({
    version: "0.1.0",
    build: "202610291425",
    items: [
      {
        build: "202610291425",
        shortVersion: "0.1.0",
        url: "https://example.invalid/BotFleetMac-0.1.0.zip",
        length: 10,
      },
    ],
  });
  assert.match(appcast, /<sparkle:version>202610291425<\/sparkle:version>/);
  assert.match(appcast, /<sparkle:shortVersionString>0\.1\.0<\/sparkle:shortVersionString>/);
});

test("a 0.1.0 appcast without its build is refused instead of guessed", () => {
  // The old single-argument lookup cannot answer 0.1.0, and a release that
  // cannot name its own build must fail here rather than publish a feed.
  assert.throws(
    () =>
      buildAppcast({
        version: "0.1.0",
        items: [
          {
            build: "202610291425",
            shortVersion: "0.1.0",
            url: "https://example.invalid/BotFleetMac-0.1.0.zip",
            length: 10,
          },
        ],
      }),
    /not 1\.0\.<commit_count>/,
  );
});

test("a --build with no value fails on the flag itself", () => {
  // Falling through would derive the build from the version string and
  // report a version problem, which reads as the wrong cause.  The flag is
  // the cause, so the flag is what fails.
  const result = spawnSync(
    process.execPath,
    [join(dirname(fileURLToPath(import.meta.url)), "native-appcast.mjs"), "/nonexistent-release-dir", "0.1.0", "v0.1.0-202610291425-native", "--build"],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--build requires a build number/);
});
