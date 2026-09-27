/// <reference types="vitest/config" />
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Every shipped source file, read as text.  Walked by hand rather than with
 *  `import.meta.glob` so the scan has no build-time magic in it: a guard that
 *  depends on the bundler is a guard that silently scans nothing. */
function shippedSources(): Array<[string, string]> {
  const root = new URL("..", import.meta.url).pathname;
  const out: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|mjs)$/.test(entry) || entry.endsWith(".d.ts") || entry.includes(".test.")) continue;
      out.push([full.slice(root.length), readFileSync(full, "utf8")]);
    }
  };
  for (const sub of ["server", "shared", "src", "electron"]) walk(join(root, sub));
  return out;
}

/**
 * One operator's private fleet protocol used to be part of every bot's system
 * prompt in a publicly shipped app: a private Slack channel, a private task
 * board, a naming prefix, and an iMessage rule applied to installs that have
 * no iMessage transport.  Nothing about it is a BotFleet feature, so it has no
 * business in shipped source, and the cheapest guard is to fail the build when
 * it comes back.
 */
const PRIVATE_FLEET_MARKERS = [
  "#agent-sync",
  "BF-${",
  "Always identify yourself as BF-",
  "the shared board",
  "jay's services",
  "Jay's Tunnel",
  "jay's tunnel",
];

describe("shipped source carries no operator-private fleet protocol", () => {
  const sources = shippedSources();

  it("scans a real number of source files", () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  for (const marker of PRIVATE_FLEET_MARKERS) {
    it(`no source file mentions ${marker}`, () => {
      const offenders = sources
        .filter(([, text]) => text.includes(marker))
        .map(([path]) => path);
      expect(offenders).toEqual([]);
    });
  }
});
