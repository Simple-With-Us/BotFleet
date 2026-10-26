// Audit the Phase 6 port inventories against the tree as it stands today
// (BF-2515).  docs/native-rewrite-port-inventory.md (BF-2502) and
// docs/native-rewrite-electron-inventory.md (BF-2498) are the gate BF-2514
// and BF-2515 cite: neither lands until every row has a Swift owner or a
// retired reason.  Rows were surveyed on 2026-10-21/22; files added since
// then silently fall outside the gate unless something re-checks coverage.
// This script is that re-check: it lists the tracked files under server/,
// companion/, shared/ and electron/ and reports any file no inventory row
// names, by path, by directory glob, or by file name.
//
// Coverage is matched generously on purpose — a glob like `server/zulip/*`
// covers the files it globbed at survey time and any sibling added later in
// the same directory shares its owner.  What the audit must catch is the
// new subsystem in a new place, not a new file beside a covered one.  Test
// files follow their implementation file, so a *.test.* / *.node-test.*
// twin of a covered file is covered.
//
// Retained paths (BF-2544).  Not everything in the tree is a Node file
// waiting for a Swift owner.  The optional server deployment under
// deploy/linux-server survives the native rewrite by decision: it is the
// server product, not the Mac harness.  Those files are audited as
// deliberately retained — and the audit fails when one of them disappears,
// because a retired server path is exactly the accident this records.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const INVENTORY_DOCS = [
  "docs/native-rewrite-port-inventory.md",
  "docs/native-rewrite-electron-inventory.md",
];
export const AUDITED_ROOTS = ["server", "companion", "shared", "electron"];

/**
 * Paths the rewrite keeps on purpose.  They are not waiting for a Swift
 * owner, and the audit's job is to prove they are still there.
 */
export const RETAINED_PATHS = [
  {
    path: "deploy/linux-server",
    why: "BF-2544: the optional server deployment survives the native rewrite; Phase 6 retires the Mac Node harness, not the server",
  },
];

/** Expand one `dir/{a,b,c}.ts` claim into the files it names. */
function expandBraces(token) {
  const open = token.indexOf("{");
  const close = token.indexOf("}", open);
  if (open === -1 || close === -1) return [token];
  return token
    .slice(open + 1, close)
    .split(",")
    .map((alt) => `${token.slice(0, open)}${alt.trim()}${token.slice(close + 1)}`);
}

/** Backticked path-ish tokens from the inventory docs, first word only. */
export function extractPatterns(inventoryText) {
  const patterns = new Set();
  for (const match of inventoryText.matchAll(/`([^`]+)`/g)) {
    // Drop `:193-370`-style line citations and trailing punctuation: the
    // claim is the file, the citation is provenance.
    const token = match[1]
      .trim()
      .split(/\s+/)[0]
      ?.replace(/:\d+(?:-\d+)?$/, "")
      .replace(/[,;:)]$/, "");
    if (!token) continue;
    // A token counts as a path claim if it names one of the audited roots,
    // a file under one, or a bare source file name.
    if (
      AUDITED_ROOTS.some((rootDir) => token === `${rootDir}/` || token.startsWith(`${rootDir}/`)) ||
      /^[^/\s]+\.(ts|tsx|mjs|cjs|mts|swift|json|yml|yaml|plist|sh)$/.test(token)
    ) {
      for (const expanded of expandBraces(token)) patterns.add(expanded);
    }
  }
  return [...patterns];
}

function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", "[^/]*")
    .replace(/\\\{([^}]+)\\\}/g, (_, inner) => `(?:${inner.split(",").join("|")})`);
  return new RegExp(`^${escaped}$`);
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mjs", ".cjs", ".mts", ".swift", ".d.mts", ".json"];

/** The implementation stem a test/fixture/declaration twin belongs to. */
function testTwinBase(file) {
  return file
    .replace(/\.node-test\.(mjs|cjs|mts)$/, "")
    .replace(/\.test\.(ts|tsx|mjs|cjs)$/, "")
    .replace(/\.spec\.(ts|tsx)$/, "")
    .replace(/\.fixtures\.(ts|tsx)$/, "")
    .replace(/\.d\.mts$/, "");
}

/**
 * Files from `files` that no pattern covers.  Pure over its inputs so the
 * fixture in the test suite exercises the same matcher the CLI runs.
 */
export function findUncovered(files, inventoryText) {
  const patterns = extractPatterns(inventoryText);
  const exact = new Set(patterns.filter((pattern) => !pattern.includes("*")));
  const globs = patterns.filter((pattern) => pattern.includes("*")).map(globToRegExp);
  // Directory claims: `server/zulip/` (or a glob's literal directory head)
  // covers everything beneath it — the inventory names subsystems, and a
  // subsystem's later files inherit its owner.  A claim on a bare audited
  // root (`server/`, from prose like "delete server/") covers nothing by
  // itself: if it did, no new subsystem could ever audit as uncovered,
  // which is the one drift this script exists to catch.
  const dirClaims = new Set();
  for (const pattern of patterns) {
    const star = pattern.indexOf("*");
    const head = star === -1 ? pattern : pattern.slice(0, star);
    const dir = head.endsWith("/") ? head : head.includes("/") ? `${dirname(head)}/` : null;
    if (dir && dir !== "./" && dir.split("/").filter(Boolean).length >= 2) {
      dirClaims.add(dir);
    }
  }
  const bareNames = new Set(patterns.filter((pattern) => !pattern.includes("/")));
  const bareGlobs = [...bareNames]
    .filter((pattern) => pattern.includes("*"))
    .map(globToRegExp);
  const mentionsFixtures = /fixture/i.test(inventoryText);

  const covered = (file) => {
    // Captured-turn fixtures ride their feature's owner (BF-2503); the
    // inventory claims the corpus, not each captured file by name.
    if (mentionsFixtures && file.split("/").includes("fixtures")) return true;
    const stem = testTwinBase(file);
    // Feature tests are named after their subsystem with a scenario suffix
    // (box-pool-occupancy.test.ts tests box.ts), so every hyphen prefix of
    // the stem is also a candidate implementation name.
    const stemPrefixes = stem
      .split("-")
      .map((_, index, parts) => parts.slice(0, index + 1).join("-"))
      .filter((prefix) => prefix !== stem);
    const candidates = [
      file,
      stem,
      ...SOURCE_EXTENSIONS.map((ext) => `${stem}${ext}`),
      ...stemPrefixes.flatMap((prefix) =>
        SOURCE_EXTENSIONS.map((ext) => `${prefix}${ext}`),
      ),
    ];
    for (const candidate of candidates) {
      if (exact.has(candidate)) return true;
      if (bareNames.has(basename(candidate))) return true;
      if (bareGlobs.some((regex) => regex.test(basename(candidate)))) return true;
      if (globs.some((regex) => regex.test(candidate))) return true;
      for (const dir of dirClaims) {
        if (candidate.startsWith(dir)) return true;
      }
      // A directory claim written without the trailing file part, e.g. the
      // doc row `server/zulip/*` already produced dir `server/zulip/`.
      const fileDir = `${dirname(candidate)}/`;
      if (dirClaims.has(fileDir)) return true;
    }
    return false;
  };

  return files.filter((file) => !covered(file)).sort();
}

/** Tracked files under the given roots, in path order. */
export function trackedFilesUnder(repoRoot, roots) {
  if (roots.length === 0) return [];
  const out = execFileSync(
    "git",
    ["-C", repoRoot, "ls-files", "--", ...roots],
    { encoding: "utf8", timeout: 30_000 },
  );
  return out.split("\n").filter(Boolean).sort();
}

export function trackedFiles(repoRoot) {
  return trackedFilesUnder(repoRoot, AUDITED_ROOTS);
}

/** Tracked files under the retained paths. */
export function retainedFiles(repoRoot) {
  return trackedFilesUnder(
    repoRoot,
    RETAINED_PATHS.map((entry) => entry.path),
  );
}

/**
 * Retained paths that hold no tracked file any more.  A retained path that
 * disappeared was retired by accident or by a decision nobody recorded, and
 * the optional server deployment must not vanish quietly (BF-2544).
 */
export function findMissingRetained(repoRoot, files = retainedFiles(repoRoot)) {
  return RETAINED_PATHS.filter(
    (entry) => !files.some((file) => file.startsWith(`${entry.path}/`)),
  ).map((entry) => entry.path);
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
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const inventoryText = INVENTORY_DOCS.map((doc) =>
    readFileSync(join(repoRoot, doc), "utf8"),
  ).join("\n");
  const files = trackedFiles(repoRoot);
  const uncovered = findUncovered(files, inventoryText);
  const retained = retainedFiles(repoRoot);
  const missingRetained = findMissingRetained(repoRoot, retained);
  console.log(
    `audited ${files.length} tracked files under ${AUDITED_ROOTS.join(", ")} ` +
      `against ${INVENTORY_DOCS.length} inventory docs`,
  );
  console.log(
    `retained by decision: ${RETAINED_PATHS.map(
      (entry) =>
        `${entry.path} (${retained.filter((file) => file.startsWith(`${entry.path}/`)).length} tracked files)`,
    ).join(", ")}`,
  );
  let failed = false;
  if (uncovered.length > 0) {
    console.error(`UNCOVERED (${uncovered.length}): no inventory row names these files`);
    for (const file of uncovered) console.error(`  - ${file}`);
    console.error(
      "Add each to its owner's row in the port inventory (or record its retired reason) before BF-2514/BF-2515 cite the inventory as their gate.",
    );
    failed = true;
  }
  if (missingRetained.length > 0) {
    console.error(
      `MISSING RETAINED PATHS (${missingRetained.length}): these paths must survive the rewrite`,
    );
    for (const path of missingRetained) {
      const entry = RETAINED_PATHS.find((item) => item.path === path);
      console.error(`  - ${path}: ${entry?.why ?? "retained path"}`);
    }
    failed = true;
  }
  if (failed) process.exit(1);
  console.log("every audited file has an inventory row, and every retained path is still there");
}
