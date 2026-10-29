// Build the Sparkle appcast for the native BotFleetMac app (BF-2486, Phase 6).
//
// Why a generator rather than a hand-written feed: the appcast must describe
// the stapled bytes, exactly like latest-mac.yml must describe the stapled
// Electron bytes.  Stapling rewrites the bundle, so any length or signature
// computed before `xcrun stapler staple` describes an app nobody can install.
// The packaging paths (scripts/mac-package.sh and native-mac-release.yml)
// therefore run this script last, over the final ZIP.
//
// Naming is deliberate.  Native assets are BotFleetMac-<version>.*, never
// BotFleet-<version>-*: the un-suffixed names are the electron-updater feed
// namespace (scripts/regenerate-mac-feed.mjs), and a native ZIP that reused
// one would be offered to installed Electron apps as an update they cannot
// run.  Sparkle reads appcast.xml; electron-updater reads latest-mac.yml;
// neither tool ever parses the other's feed.
//
// Signatures: Sparkle verifies an EdDSA signature (sparkle:edSignature) when
// the app carries SUPublicEDKey.  The private key never enters this repo or
// this script.  The caller signs the final ZIP with Sparkle's sign_update and
// drops the base64 signature in a sidecar file, <zip>.edsig; this generator
// copies it into the enclosure verbatim.  With no sidecar the item is emitted
// unsigned and the caller must treat the appcast as a draft: an app with a
// public key configured refuses unsigned items, which is the fail-closed
// behaviour the Phase 6 exit criteria ask for.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const NATIVE_FEED_NAME = "appcast.xml";
export const DEFAULT_FEED_BASE_URL =
  "https://github.com/Simple-With-Us/BotFleet/releases/download";

export function nativeArtifactNames(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`invalid native release version: ${version}`);
  }
  return {
    zip: `BotFleetMac-${version}.zip`,
    dmg: `BotFleetMac-${version}.dmg`,
  };
}

/** The Sparkle build number for 1.0.<commit_count> is the count itself. */
export function buildNumberFor(version) {
  const match = /^1\.0\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(
      `native version ${version} is not 1.0.<commit_count>; ` +
        `stamp it with scripts/stamp-commit-version.mjs instead of inventing one`,
    );
  }
  return match[1];
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * One appcast document for one release.  `items` are newest-first; Sparkle
 * only ever offers the first item whose version beats the installed build,
 * so the generator refuses an out-of-order list rather than publishing a
 * feed whose newest entry is buried.
 */
export function buildAppcast({
  version,
  feedBaseUrl = DEFAULT_FEED_BASE_URL,
  pubDate = new Date(),
  minimumSystemVersion = "14.0",
  items,
} = {}) {
  const build = buildNumberFor(version);
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("appcast needs at least one item");
  }
  const builds = items.map((item) => Number(item.build));
  for (let i = 1; i < builds.length; i += 1) {
    if (!(builds[i] < builds[i - 1])) {
      throw new Error("appcast items must be ordered newest-first by build number");
    }
  }
  if (String(items[0].build) !== build || items[0].shortVersion !== version) {
    throw new Error(
      `appcast head item (${items[0].shortVersion}/${items[0].build}) ` +
        `does not match the release version (${version}/${build})`,
    );
  }
  const lines = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:dc="http://purl.org/dc/elements/1.1/">`,
    `  <channel>`,
    `    <title>BotFleet</title>`,
    `    <link>${escapeXml(feedBaseUrl.replace(/\/download$/, ""))}</link>`,
    `    <description>BotFleet native macOS updates.</description>`,
    `    <language>en</language>`,
  ];
  for (const item of items) {
    if (!/^BotFleetMac-\d+\.\d+\.\d+\.zip$/.test(basename(item.url))) {
      throw new Error(`appcast enclosure is not a native ZIP name: ${item.url}`);
    }
    if (!Number.isInteger(item.length) || item.length < 1) {
      throw new Error(`appcast enclosure ${item.url} has no usable length`);
    }
    const signature = item.edSignature
      ? ` sparkle:edSignature="${escapeXml(item.edSignature)}"`
      : "";
    lines.push(
      `    <item>`,
      `      <title>Version ${escapeXml(item.shortVersion)}</title>`,
      `      <pubDate>${new Date(item.pubDate ?? pubDate).toUTCString()}</pubDate>`,
      `      <sparkle:version>${escapeXml(item.build)}</sparkle:version>`,
      `      <sparkle:shortVersionString>${escapeXml(item.shortVersion)}</sparkle:shortVersionString>`,
      `      <sparkle:minimumSystemVersion>${escapeXml(minimumSystemVersion)}</sparkle:minimumSystemVersion>`,
      `      <enclosure url="${escapeXml(item.url)}" length="${item.length}" type="application/octet-stream"${signature}/>`,
      `    </item>`,
    );
  }
  lines.push(`  </channel>`, `</rss>`, "");
  return lines.join("\n");
}

/** Read the optional sign_update sidecar for one ZIP.  Never logs its value. */
export function readEdSignature(releaseDir, zipName) {
  const sidecar = join(releaseDir, `${zipName}.edsig`);
  if (!existsSync(sidecar)) return null;
  const signature = readFileSync(sidecar, "utf8").trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(signature) || signature.length < 40) {
    throw new Error(`${zipName}.edsig does not look like a base64 EdDSA signature`);
  }
  return signature;
}

/**
 * Generate appcast.xml in `releaseDir` for `version` from the final,
 * post-staple ZIP.  `tag` is the GitHub release tag the ZIP will be
 * downloaded from (v<version>); the enclosure URL is assembled from it so
 * the feed cannot point at a release that does not carry the bytes.
 */
export function generateAppcast({
  releaseDir,
  version,
  tag = `v${version}`,
  feedBaseUrl = DEFAULT_FEED_BASE_URL,
  pubDate,
} = {}) {
  const { zip } = nativeArtifactNames(version);
  const zipPath = join(releaseDir, zip);
  if (!existsSync(zipPath)) {
    throw new Error(`missing native ZIP ${zip} in ${releaseDir}; package and staple before generating the appcast`);
  }
  const stray = readdirSync(releaseDir).filter(
    (name) => /^BotFleet-\d/.test(name) && name.endsWith(".zip"),
  );
  if (stray.length > 0) {
    throw new Error(
      `native release directory holds Electron-namespace ZIPs (${stray.join(", ")}); ` +
        `keep the two feeds' asset sets in separate directories`,
    );
  }
  const edSignature = readEdSignature(releaseDir, zip);
  const appcast = buildAppcast({
    version,
    pubDate,
    items: [
      {
        build: buildNumberFor(version),
        shortVersion: version,
        url: `${feedBaseUrl}/${tag}/${zip}`,
        length: statSync(zipPath).size,
        edSignature,
      },
    ],
  });
  const feedPath = join(releaseDir, NATIVE_FEED_NAME);
  writeFileSync(feedPath, appcast);
  console.log(
    edSignature
      ? `appcast.xml generated for ${zip} (EdDSA-signed)`
      : `appcast.xml generated for ${zip} (UNSIGNED draft: no ${zip}.edsig sidecar)`,
  );
  return { feedPath, signed: Boolean(edSignature) };
}

// Compare physical paths.  Node's ESM loader realpaths the entry module, so an
// invocation through a symlinked directory (macOS /var -> /private/var) never
// matches process.argv[1] when compared as text.
function isEntryModule() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  const [, , releaseDir, version, tag] = process.argv;
  if (!releaseDir || !version) {
    throw new Error(
      "usage: node scripts/native-appcast.mjs <release-dir> <version> [tag]",
    );
  }
  generateAppcast({ releaseDir, version, tag });
}

export { root as _rootForTests };
