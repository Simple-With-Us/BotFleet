// Rebuild latest-mac.yml after notarization and stapling have changed the
// bytes.  Generate the feed from the four expected versioned artifacts rather
// than editing electron-builder's intermediate file: repeated multi-arch
// packaging used to leave duplicate entries in the feed.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
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

export function regenerateMacFeed({
  feedPath = join(root, "release", "latest-mac.yml"),
  version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
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
  regenerateMacFeed({ feedPath: process.argv[2] });
}
