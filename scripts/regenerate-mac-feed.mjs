// Rebuild latest-mac.yml after notarization and stapling have changed the
// bytes.  Generate the feed from the four expected versioned artifacts rather
// than editing electron-builder's intermediate file: repeated multi-arch
// packaging used to leave duplicate entries in the feed.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function sha512(file) {
  return createHash("sha512").update(readFileSync(file)).digest("base64");
}

export function macArtifactNames(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`invalid package version: ${version}`);
  }
  return [
    `BotFleet-${version}-arm64.zip`,
    `BotFleet-${version}-x64.zip`,
    `BotFleet-${version}-arm64.dmg`,
    `BotFleet-${version}-x64.dmg`,
  ];
}

export function buildMacFeed(releaseDir, version, releaseDate = new Date().toISOString()) {
  const entries = macArtifactNames(version).map((url) => {
    const file = join(releaseDir, url);
    // A missing artifact means the feed would describe a release that does
    // not exist, so say which version and which file instead of letting the
    // read fail with a bare ENOENT.
    if (!existsSync(file)) {
      throw new Error(
        `missing release artifact ${url} for version ${version} in ${releaseDir}`,
      );
    }
    return { url, sha512: sha512(file), size: statSync(file).size };
  });
  const fallback = entries[0];
  const lines = [`version: ${version}`, "files:"];
  for (const entry of entries) {
    lines.push(`  - url: ${entry.url}`, `    sha512: ${entry.sha512}`, `    size: ${entry.size}`);
  }
  lines.push(
    `path: ${fallback.url}`,
    `sha512: ${fallback.sha512}`,
    `releaseDate: '${releaseDate}'`,
    "",
  );
  return lines.join("\n");
}

/**
 * The version the feed must describe.
 *
 * A CI release stamps its version from the commit count and hands it over as
 * BOTFLEET_BUILD_VERSION, the same way it hands the value to electron-builder
 * and to the server bundler.  package.json's own version is the FLOOR of that
 * scheme, not the release number: it stays at 1.0.31, which is also the
 * version already installed on the owner's Mac, so a feed carrying it can
 * never offer an update.
 *
 * Reading the floor here broke the first unified release: the regeneration
 * looked for BotFleet-1.0.31-arm64.zip while the build had produced
 * BotFleet-1.0.2193-arm64.zip, and the run died naming a file that was never
 * going to exist.  The stamped version is the truth; the floor is only the
 * fallback for a local build that never stamped one.
 */
export function resolveFeedVersion({ env = process.env, versionPath = join(root, "package.json") } = {}) {
  const pinned = env.BOTFLEET_BUILD_VERSION?.trim();
  if (pinned) return pinned;
  return JSON.parse(readFileSync(versionPath, "utf8")).version;
}

export function regenerateMacFeed({
  feedPath = join(root, "release", "latest-mac.yml"),
  version = resolveFeedVersion(),
  releaseDate,
} = {}) {
  const updated = buildMacFeed(dirname(feedPath), version, releaseDate);
  writeFileSync(feedPath, updated);
  console.log(`latest-mac.yml regenerated from ${macArtifactNames(version).length} artifacts`);
  return updated;
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
  // node scripts/regenerate-mac-feed.mjs [feedPath] [version]
  // The version argument wins; without it the stamped BOTFLEET_BUILD_VERSION
  // is used, and without that the package.json floor.  A release always
  // passes one, so the feed can never drift onto the floor.
  regenerateMacFeed({ feedPath: process.argv[2], version: process.argv[3] });
}
