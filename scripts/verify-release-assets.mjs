// Verify a fully assembled desktop release before it can reach GitHub
// Releases.  Node and Python standard libraries validate feeds and chunk
// hashes without installing the Electron packaging dependency tree.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function sha512(file) {
  return createHash("sha512").update(readFileSync(file)).digest("base64");
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function parseUpdateFeed(text, feedName) {
  const lines = text.split(/\r?\n/);
  const version = lines.find((line) => /^version:\s+/.test(line))?.replace(/^version:\s+/, "").trim();
  const entries = [];
  let current = null;
  let inFiles = false;
  let fallbackPath = null;
  let fallbackHash = null;

  for (const line of lines) {
    if (line === "files:") {
      inFiles = true;
      continue;
    }
    const url = line.match(/^\s{2}- url:\s+(\S+)\s*$/);
    if (inFiles && url) {
      current = { url: url[1], sha512: null, size: null };
      entries.push(current);
      continue;
    }
    const hash = line.match(/^\s{4}sha512:\s+(\S+)\s*$/);
    if (inFiles && current && hash) {
      current.sha512 = hash[1];
      continue;
    }
    const size = line.match(/^\s{4}size:\s+(\d+)\s*$/);
    if (inFiles && current && size) {
      current.size = Number(size[1]);
      continue;
    }
    const path = line.match(/^path:\s+(\S+)\s*$/);
    if (path) {
      inFiles = false;
      fallbackPath = path[1];
      continue;
    }
    const topHash = line.match(/^sha512:\s+(\S+)\s*$/);
    if (!inFiles && topHash) fallbackHash = topHash[1];
  }

  if (!version) throw new Error(`${feedName}: missing version`);
  if (entries.length === 0) throw new Error(`${feedName}: no file entries`);
  for (const entry of entries) {
    if (!entry.sha512 || entry.size == null) {
      throw new Error(`${feedName}: incomplete entry for ${entry.url}`);
    }
  }
  if (!fallbackPath || !fallbackHash) throw new Error(`${feedName}: incomplete fallback entry`);
  return { version, entries, fallbackPath, fallbackHash };
}

function expectExactUrls(feedName, entries, expectedUrls) {
  const urls = entries.map((entry) => entry.url);
  if (new Set(urls).size !== urls.length) throw new Error(`${feedName}: duplicate file entry`);
  const actual = [...urls].sort();
  const expected = [...expectedUrls].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${feedName}: expected ${expected.join(", ")}; found ${actual.join(", ")}`);
  }
}

function verifyFeed(directory, feedName, version, expectedUrls, blockmapUrls = []) {
  const feedPath = join(directory, feedName);
  if (!existsSync(feedPath)) throw new Error(`${feedName}: missing required update feed`);
  const feed = parseUpdateFeed(readFileSync(feedPath, "utf8"), feedName);
  if (feed.version !== version) {
    throw new Error(`${feedName}: version ${feed.version} does not match package ${version}`);
  }
  expectExactUrls(feedName, feed.entries, expectedUrls);

  for (const entry of feed.entries) {
    if (basename(entry.url) !== entry.url) throw new Error(`${feedName}: unsafe artifact path ${entry.url}`);
    const artifact = join(directory, entry.url);
    if (!existsSync(artifact)) throw new Error(`${feedName}: missing ${entry.url}`);
    const actualHash = sha512(artifact);
    const actualSize = statSync(artifact).size;
    if (actualHash !== entry.sha512 || actualSize !== entry.size) {
      throw new Error(`${feedName}: hash or size mismatch for ${entry.url}`);
    }
  }

  const fallback = feed.entries.find((entry) => entry.url === feed.fallbackPath);
  if (!fallback || fallback.sha512 !== feed.fallbackHash) {
    throw new Error(`${feedName}: fallback path/hash does not match a verified file entry`);
  }
  for (const url of blockmapUrls) {
    if (!existsSync(join(directory, `${url}.blockmap`))) {
      throw new Error(`${feedName}: missing ${url}.blockmap`);
    }
    try {
      execFileSync(process.platform === "win32" ? "python" : "python3", [
        fileURLToPath(new URL("./verify-release-blockmap.py", import.meta.url)),
        join(directory, url), join(directory, `${url}.blockmap`),
      ], { stdio: "pipe", timeout: 120_000 });
    } catch {
      throw new Error(`${feedName}: invalid blockmap for ${url}`);
    }
  }
  console.log(`${feedName}: verified ${feed.entries.length} artifacts`);
}

export function verifyReleaseAssets(directory, version) {
  const root = resolve(directory);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`invalid package version: ${version}`);
  }
  const mac = [
    `BotFleet-${version}-arm64.zip`,
    `BotFleet-${version}-x64.zip`,
    `BotFleet-${version}-arm64.dmg`,
    `BotFleet-${version}-x64.dmg`,
  ];
  const windows = [`BotFleet-${version}-setup.exe`];
  const deb = `BotFleet-${version}-amd64.deb`;
  const linux = [`BotFleet-${version}-x86_64.AppImage`, deb];

  verifyFeed(root, "latest-mac.yml", version, mac, mac);
  verifyFeed(root, "latest.yml", version, windows, windows);
  verifyFeed(root, "latest-linux.yml", version, linux);
  const stableDownloads = new Map([
    ["BotFleet.dmg", mac[2]],
    ["BotFleet-intel.dmg", mac[3]],
    ["BotFleet-setup.exe", windows[0]],
    ["BotFleet.AppImage", linux[0]],
    ["BotFleet-amd64.deb", `BotFleet-${version}-amd64.deb`],
  ]);
  for (const [alias, versioned] of stableDownloads) {
    const aliasPath = join(root, alias);
    const versionedPath = join(root, versioned);
    if (!existsSync(aliasPath)) throw new Error(`missing stable download ${alias}`);
    if (sha512(aliasPath) !== sha512(versionedPath)) {
      throw new Error(`stable download ${alias} does not match ${versioned}`);
    }
  }

  if (!existsSync(join(root, deb))) throw new Error(`missing Linux package ${deb}`);
  const checksumPath = join(root, "SHA256SUMS-ubuntu-x64.txt");
  if (!existsSync(checksumPath)) throw new Error("missing SHA256SUMS-ubuntu-x64.txt");
  const checksums = new Map(
    readFileSync(checksumPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const match = line.match(/^([0-9a-f]{64})\s+\*?(\S+)$/);
        if (!match) throw new Error(`invalid checksum line: ${line}`);
        return [match[2], match[1]];
      }),
  );
  for (const file of [deb, linux[0]]) {
    if (checksums.get(file) !== sha256(join(root, file))) {
      throw new Error(`SHA256SUMS-ubuntu-x64.txt: mismatch for ${file}`);
    }
  }

  const expectedFiles = new Set([
    ...mac,
    ...mac.map((file) => `${file}.blockmap`),
    ...windows,
    ...windows.map((file) => `${file}.blockmap`),
    ...linux,
    deb,
    ...stableDownloads.keys(),
    "latest-mac.yml",
    "latest.yml",
    "latest-linux.yml",
    "SHA256SUMS-ubuntu-x64.txt",
  ]);
  const actualFiles = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const unexpected = actualFiles.filter((file) => !expectedFiles.has(file));
  const missing = [...expectedFiles].filter((file) => !actualFiles.includes(file));
  if (unexpected.length || missing.length) {
    throw new Error(
      `release asset set differs: unexpected [${unexpected.sort().join(", ")}], missing [${missing.sort().join(", ")}]`,
    );
  }
  console.log(`release ${version}: every updater feed and stable download is complete`);
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
  const [, , directory, version] = process.argv;
  if (!directory || !version) {
    throw new Error("usage: node scripts/verify-release-assets.mjs <directory> <version>");
  }
  verifyReleaseAssets(directory, version);
}
