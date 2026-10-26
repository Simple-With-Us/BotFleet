// Verify a native BotFleetMac release directory before it can join a GitHub
// release (BF-2486, Phase 6).  This is the native counterpart of
// scripts/verify-release-assets.mjs, with the same discipline: check the
// actual bytes in the directory, never a manifest's word for them.
//
// The checks that exist because their absence already shipped a broken
// update once, on the Electron side, and must not be relearned natively:
//   - the feed version, the bundle version and the release tag are one
//     string (the BF-2458 downgrade-refusal was three schemes disagreeing);
//   - feed lengths are measured after stapling, because stapling rewrites
//     the bundle bytes;
//   - native asset names can never collide with the electron-updater
//     namespace, or an installed Electron app would download a Swift app
//     as its own update.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_FEED_NAME, buildNumberFor, nativeArtifactNames, nativeReleaseTag } from "./native-appcast.mjs";

export function parseAppcast(text) {
  const items = [];
  const itemBlocks = text.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  for (const block of itemBlocks) {
    const pick = (pattern) => block.match(pattern)?.[1]?.trim() ?? null;
    items.push({
      shortVersion: pick(/<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/),
      build: pick(/<sparkle:version>([^<]+)<\/sparkle:version>/),
      minimumSystemVersion: pick(
        /<sparkle:minimumSystemVersion>([^<]+)<\/sparkle:minimumSystemVersion>/,
      ),
      enclosureUrl: pick(/<enclosure\s+[^>]*url="([^"]+)"/),
      enclosureLength: Number(pick(/<enclosure\s+[^>]*length="(\d+)"/)),
      edSignature: pick(/sparkle:edSignature="([^"]+)"/),
    });
  }
  return { items };
}

export function verifyNativeRelease(directory, version, { requireSignature = false } = {}) {
  const rootDir = resolve(directory);
  const { zip, dmg } = nativeArtifactNames(version);
  const build = buildNumberFor(version);

  for (const name of [zip, dmg, NATIVE_FEED_NAME]) {
    if (!existsSync(join(rootDir, name))) {
      throw new Error(`native release ${version}: missing ${name}`);
    }
  }

  // No Electron-namespace artifact may ride along: latest-mac.yml's files
  // are BotFleet-<version>-*, and one shared upload directory is exactly
  // how the two feeds would cross-contaminate.
  const files = readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const collisions = files.filter(
    (name) => /^BotFleet-\d/.test(name) || name === "latest-mac.yml",
  );
  if (collisions.length > 0) {
    throw new Error(
      `native release ${version}: Electron-feed artifacts present (${collisions.join(", ")}); ` +
        `assemble native and Electron asset sets separately`,
    );
  }

  const { items } = parseAppcast(readFileSync(join(rootDir, NATIVE_FEED_NAME), "utf8"));
  if (items.length === 0) throw new Error(`${NATIVE_FEED_NAME}: no items`);
  const [head, ...older] = items;
  if (head.shortVersion !== version || head.build !== build) {
    throw new Error(
      `${NATIVE_FEED_NAME}: head item is ${head.shortVersion}/${head.build}, release is ${version}/${build}`,
    );
  }
  for (let i = 1; i < items.length; i += 1) {
    if (!(Number(items[i].build) < Number(items[i - 1].build))) {
      throw new Error(`${NATIVE_FEED_NAME}: items are not ordered newest-first`);
    }
  }
  void older;

  if (basename(head.enclosureUrl ?? "") !== zip) {
    throw new Error(
      `${NATIVE_FEED_NAME}: head enclosure ${head.enclosureUrl} does not name ${zip}`,
    );
  }
  // The enclosure must live in the native release namespace.  The Electron
  // release for the same version carries exactly the Electron asset set, so
  // an enclosure pointed at v<version> names a ZIP nobody ships.
  const tag = nativeReleaseTag(version);
  const pathSegments = (head.enclosureUrl ?? "").split("/");
  if (!pathSegments.some((segment) => segment === tag)) {
    throw new Error(
      `${NATIVE_FEED_NAME}: head enclosure ${head.enclosureUrl} does not live in the native release namespace (${tag})`,
    );
  }
  const actualLength = statSync(join(rootDir, zip)).size;
  if (head.enclosureLength !== actualLength) {
    throw new Error(
      `${NATIVE_FEED_NAME}: enclosure length ${head.enclosureLength} != stapled ZIP size ${actualLength}; ` +
        `regenerate the appcast after stapling`,
    );
  }
  if (requireSignature && !head.edSignature) {
    throw new Error(
      `${NATIVE_FEED_NAME}: head item carries no sparkle:edSignature; ` +
        `sign the stapled ZIP with sign_update before publishing`,
    );
  }
  console.log(
    `native release ${version} (build ${build}): DMG, ZIP and appcast agree` +
      (head.edSignature ? " (EdDSA-signed)" : " (unsigned draft)"),
  );
  return { zip, dmg, signed: Boolean(head.edSignature) };
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
  const [, , directory, version, ...rest] = process.argv;
  if (!directory || !version) {
    throw new Error(
      "usage: node scripts/verify-native-release.mjs <directory> <version> [--require-signature]",
    );
  }
  verifyNativeRelease(directory, version, {
    requireSignature: rest.includes("--require-signature"),
  });
}
