import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildAppcast,
  buildNumberFor,
  generateAppcast,
  nativeArtifactNames,
  nativeReleaseTag,
} from "./native-appcast.mjs";
import { verifyNativeRelease } from "./verify-native-release.mjs";

const VERSION = "1.0.2200";

function fixture({ signed = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "botfleet-native-release-"));
  const { zip, dmg } = nativeArtifactNames(VERSION);
  writeFileSync(join(directory, zip), "stapled-native-zip-bytes");
  writeFileSync(join(directory, dmg), "stapled-native-dmg-bytes");
  if (signed) {
    writeFileSync(
      join(directory, `${zip}.edsig`),
      "c2lnbmF0dXJlLWJ5dGVzLWZvci10aGUtc3RhcGxlZC16aXAtMDAxMjM0NTY3ODk=",
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
      verifyNativeRelease(directory, VERSION, { requireSignature: true }),
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

test("the appcast points at the native release namespace, never the Electron one", () => {
  // The Electron release for the same version carries exactly the Electron
  // asset set, so an enclosure pointed at v<version> names a ZIP that
  // release does not hold.
  assert.equal(nativeReleaseTag(VERSION), `native-v${VERSION}`);
  const directory = fixture();
  try {
    generateAppcast({ releaseDir: directory, version: VERSION });
    const xml = readFileSync(join(directory, "appcast.xml"), "utf8");
    assert.match(xml, new RegExp(`/native-v${VERSION}/BotFleetMac-${VERSION}\\.zip`));
    assert.doesNotMatch(xml, /\/v1\.0\.2200\//);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a feed pointing at the Electron release is refused", () => {
  const directory = fixture();
  try {
    generateAppcast({ releaseDir: directory, version: VERSION, tag: `v${VERSION}` });
    assert.throws(
      () => verifyNativeRelease(directory, VERSION),
      /native release namespace/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
