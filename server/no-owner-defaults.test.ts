// BotFleet is a public app: no endpoint, hostname, path, or project name
// belonging to whoever happens to maintain it may be a default or a
// hardcoded string in shipped code. Everyone configures their own values,
// and unconfigured means the feature is simply off.
//
// This is a source scan rather than a behavioural test on purpose — the
// regression it catches is a new default being pasted in somewhere none of
// the existing tests reach. It covers the runtime (server, src, shared) plus
// everything else that ships to a user or a visitor: the marketing site under
// apps/ and the iOS app's source and build configuration under ios/.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED_DIRS = ["server", "src", "shared", "apps", "ios"];
// Config and markup ship just as literally as code does: a hostname in an
// entitlements plist, a project.yml, or a rendered page is still a hardcoded
// owner default.
const SCANNED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx",
  ".swift",
  ".html", ".json", ".yml", ".yaml",
  ".md",   // prose ships too: a maintainer path in a public README is still a leak
  ".plist", ".entitlements",
  ".sh",
]);
// Build output and vendored dependencies are not ours to police, and an
// .xcodeproj is a generated bundle regenerated from ios/project.yml.
const SKIPPED_DIRS = new Set([
  "node_modules", "Pods", "DerivedData", "dist", "build", "out", "coverage",
]);

/** Assembled from fragments so this file does not trip its own scan. */
const FORBIDDEN: Array<{ label: string; pattern: RegExp }> = [
  { label: "personal service domain", pattern: new RegExp(["jays", "\\.", "services"].join("")) },
  { label: "maintainer home directory", pattern: new RegExp(["/Users/", "jay", "/"].join("")) },
  { label: "private corpus name", pattern: new RegExp(["fleet", "-", "agents"].join("")) },
  { label: "private tooling checkout", pattern: new RegExp(["apps/", "mac-collab"].join("")) },
  { label: "private tooling checkout", pattern: new RegExp(["apps/", "fleet-rag"].join("")) },
  { label: "private mesh address", pattern: new RegExp(["100", "\\.", "69", "\\.", "77"].join("")) },
];

/**
 * Tests may name these strings to assert their absence, so they are scanned
 * past rather than scanned. Covers both the JS convention (`x.test.ts`,
 * `x.node-test.mjs`) and the Swift/XCTest one (`XTests.swift`).
 */
function isTestFile(entry: string): boolean {
  return /\.(test|node-test)\.[^.]+$/.test(entry) || /Tests\.swift$/.test(entry);
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIPPED_DIRS.has(entry) || entry.startsWith(".") || entry.endsWith(".xcodeproj")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (isTestFile(entry)) continue;
    if (SCANNED_EXTENSIONS.has(extname(entry))) out.push(full);
  }
  return out;
}

describe("shipped source carries no owner-specific defaults", () => {
  const files = SCANNED_DIRS.flatMap((dir) => sourceFiles(join(REPO_ROOT, dir)));

  it("finds source to scan at all", () => {
    // A scan that silently walked nothing would pass every assertion below.
    expect(files.length).toBeGreaterThan(100);
  });

  it("reaches the site and iOS trees, not just the runtime", () => {
    // The runtime dirs alone already clear the floor above, so a typo that
    // dropped apps/ or ios/ would otherwise go unnoticed.
    for (const dir of ["apps", "ios"]) {
      const prefix = join(REPO_ROOT, dir) + sep;
      expect(files.filter((file) => file.startsWith(prefix)).length).toBeGreaterThan(0);
    }
  });

  it.each(FORBIDDEN)("contains no $label", ({ pattern }) => {
    const offenders = files.filter((file) => pattern.test(readFileSync(file, "utf8")));
    expect(offenders.map((file) => file.slice(REPO_ROOT.length + 1))).toEqual([]);
  });
});
