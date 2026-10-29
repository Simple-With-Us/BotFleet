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
// The optional server deployment is audited too, and is a documented
// exception rather than a finding.  BotFleet may run with the server as the
// primary BotFleet server (BF-2544), and deploy/linux-server/ ships the SAME
// server/ code as that optional deployment.  The Mac-local harness is what
// Phase 6 retires; the optional server path stays, so it is listed in
// RETAINED_PATHS and reported as retained, never as uncovered.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const INVENTORY_DOCS = [
  "docs/native-rewrite-port-inventory.md",
  "docs/native-rewrite-electron-inventory.md",
];
export const AUDITED_ROOTS = ["server", "companion", "shared", "electron", "deploy"];

/**
 * Paths the audit deliberately keeps.  Each one is a documented, expected
 * exception: its files are reported as retained rather than as uncovered, so
 * a reader can see at a glance that they are meant to stay.  A path added
 * here is an exclusion from the decommission, never a hole in the inventory.
 */
export const RETAINED_PATHS = [
  {
    path: "deploy/linux-server/",
    why: "the optional Linux server deployment (BF-2544) ships the same server/ code and is deliberately retained",
  },
];

/**
 * Surfaces outside the audited roots that stop working when those roots go.
 * They are not inventory rows, because nothing in them is Node to retire, and
 * they are not retained paths, because keeping them as they are is not an
 * option: BotFleet Control (mac-control/) calls only routes that live in
 * server/index.ts, supervises the LaunchAgents and the pm2 job that Phase 5
 * retires, and is built and installed only by the Electron packaging that
 * Step 6 deletes.  The audit reports them so the dependency is visible in
 * the same place as the inventory, and the gate requires their disposition
 * (BF-2583).
 */
export const DEPENDENT_PATHS = [
  {
    path: "mac-control/",
    why: "BotFleet Control's local half is the Mac-local Node stack; its post-Node disposition is Decision 1 in docs/plans/2026-10-29-botfleet-control-after-node.md and the gate's control-disposition evidence (BF-2583)",
  },
];

/** The tracked files under each dependent surface, so the CLI can count them. */
export function dependentFiles(repoRoot) {
  const out = execFileSync(
    "git",
    ["-C", repoRoot, "ls-files", "--", ...DEPENDENT_PATHS.map((entry) => entry.path)],
    { encoding: "utf8", timeout: 30_000 },
  );
  return out.split("\n").filter(Boolean).sort();
}

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
 * Is this file inside one of the deliberately retained paths?  Retained files
 * are excluded from the decommission: they are an approved exception, not an
 * inventory gap.
 */
export function isRetained(file) {
  return RETAINED_PATHS.some((entry) => file.startsWith(entry.path));
}

/** The retained files present in `files`, so the CLI can report them. */
export function retainedFiles(files) {
  return files.filter((file) => isRetained(file)).sort();
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

  return files.filter((file) => !isRetained(file) && !covered(file)).sort();
}

export function trackedFiles(repoRoot) {
  const out = execFileSync(
    "git",
    ["-C", repoRoot, "ls-files", "--", ...AUDITED_ROOTS],
    { encoding: "utf8", timeout: 30_000 },
  );
  return out.split("\n").filter(Boolean).sort();
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
  console.log(
    `audited ${files.length} tracked files under ${AUDITED_ROOTS.join(", ")} ` +
      `against ${INVENTORY_DOCS.length} inventory docs`,
  );
  for (const entry of RETAINED_PATHS) {
    const count = files.filter((file) => file.startsWith(entry.path)).length;
    console.log(
      `retained on purpose: ${entry.path} (${count} tracked file(s)) — ${entry.why}`,
    );
  }
  const dependents = dependentFiles(repoRoot);
  for (const entry of DEPENDENT_PATHS) {
    const count = dependents.filter((file) => file.startsWith(entry.path)).length;
    console.log(
      `depends on the stack being deleted: ${entry.path} (${count} tracked file(s)) — ${entry.why}`,
    );
  }
  if (uncovered.length > 0) {
    console.error(`UNCOVERED (${uncovered.length}): no inventory row names these files`);
    for (const file of uncovered) console.error(`  - ${file}`);
    console.error(
      "Add each to its owner's row in the port inventory (or record its retired reason) before BF-2514/BF-2515 cite the inventory as their gate.",
    );
    process.exit(1);
  }
  console.log("every audited file has an inventory row, or is a deliberately retained path");
}
