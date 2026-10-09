/// <reference types="vitest/config" />
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Every shipped source file, read as text.  Walked by hand rather than with
 *  `import.meta.glob` so the scan has no build-time magic in it: a guard that
 *  depends on the bundler is a guard that silently scans nothing. */
function shippedSources(): Array<[string, string]> {
  // `fileURLToPath`, not `URL.pathname`: on Windows a pathname is
  // "/D:/a/BotFleet/BotFleet", and joining onto that yields the doubled
  // "D:\D:\a\..." that made this test fail on the Windows runner only.
  const root = fileURLToPath(new URL("..", import.meta.url));
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

/** Operator fleet seat prompts ship as markdown beside the server bundle. */
function shippedSeatPromptMarkdown(): Array<[string, string]> {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const botsDir = join(root, "bots");
  const out: Array<[string, string]> = [];
  for (const entry of readdirSync(botsDir)) {
    if (!entry.endsWith(".md")) continue;
    const full = join(botsDir, entry);
    out.push([`bots/${entry}`, readFileSync(full, "utf8")]);
  }
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

describe("shipped seat prompt markdown carries no banned private markers", () => {
  const prompts = shippedSeatPromptMarkdown();

  it("scans every bots/*.md file", () => {
    expect(prompts.length).toBeGreaterThan(5);
  });

  for (const marker of PRIVATE_FLEET_MARKERS) {
    it(`no bots markdown mentions ${marker}`, () => {
      const offenders = prompts
        .filter(([, text]) => text.includes(marker))
        .map(([path]) => path);
      expect(offenders).toEqual([]);
    });
  }
});
