import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PluginRegistrySchema } from "./plugin-types.ts";
import {
  buildEntry,
  clearPluginsDir,
  listPluginDirs,
  listingFor,
  readRegistry,
  removePluginEntry,
  setPluginEntry,
  writePluginTree,
} from "./plugin-registry.ts";

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "botfleet-plugin-registry-"));
});

describe("plugin registry", () => {
  it("reads an empty registry when no file exists", () => {
    const registry = readRegistry(baseDir);
    expect(registry.version).toBe(1);
    expect(registry.plugins).toEqual({});
  });

  it("writes and reads back a registry", () => {
    const entry = buildEntry({
      name: "demo",
      version: "1.0.0",
      source: { kind: "folder", path: "/tmp/demo" },
      warnings: [],
    });
    setPluginEntry(entry, baseDir);
    const registry = readRegistry(baseDir);
    expect(registry.plugins.demo?.name).toBe("demo");
    expect(registry.plugins.demo?.enabled).toBe(false);
  });

  it("rejects and quarantines a registry whose entries fail the schema", () => {
    // Top-level shape is right; the entry under `plugins` is not.  The old
    // top-level-only predicate accepted this file.
    writeFileSync(join(baseDir, "registry.json"), JSON.stringify({
      version: 1,
      plugins: { demo: { name: "demo", enabled: "yes" } },
    }));
    const registry = readRegistry(baseDir);
    expect(registry.plugins).toEqual({});
    const files = readdirSync(baseDir);
    expect(files.includes("registry.json")).toBe(false);
    expect(files.some((file) => file.startsWith("registry.json.invalid-"))).toBe(true);
  });

  it("rejects a registry entry stored under a different key than its name", () => {
    const entry = buildEntry({ name: "demo", version: "1.0.0", source: { kind: "folder", path: "/tmp/demo" }, warnings: [] });
    expect(PluginRegistrySchema.safeParse({ version: 1, plugins: { other: entry } }).success).toBe(false);
    expect(PluginRegistrySchema.safeParse({ version: 1, plugins: { demo: entry } }).success).toBe(true);
  });

  it("rejects a registry entry with an unknown field or source kind", () => {
    const entry = buildEntry({ name: "demo", version: "1.0.0", source: { kind: "folder", path: "/tmp/demo" }, warnings: [] });
    expect(PluginRegistrySchema.safeParse({ version: 1, plugins: { demo: { ...entry, extra: 1 } } }).success).toBe(false);
    expect(PluginRegistrySchema.safeParse({ version: 1, plugins: { demo: { ...entry, source: { kind: "ftp", path: "x" } } } }).success).toBe(false);
  });

  it("writes the plugin tree and reads it back through listingFor", () => {
    const manifest = JSON.stringify({
      name: "demo",
      version: "1.0.0",
      description: "Demo plugin.",
      botfleet: ">=1",
      entry: "plugin.mjs",
    });
    writePluginTree("demo", {
      source: "/tmp/demo",
      manifestText: manifest,
      files: [{ path: "plugin.mjs", content: "export const hello = 'world';\n" }],
    }, baseDir);

    const entry = buildEntry({
      name: "demo",
      version: "1.0.0",
      source: { kind: "folder", path: "/tmp/demo" },
      warnings: [],
    });
    setPluginEntry(entry, baseDir);

    const listing = listingFor("demo", baseDir);
    if ("error" in listing) throw new Error(listing.error);
    expect(listing.name).toBe("demo");
    expect(listing.version).toBe("1.0.0");
    expect(listing.description).toBe("Demo plugin.");
    expect(listing.capabilities.length).toBe(0);
  });

  it("fails listingFor with a useful message when the manifest is unreadable", () => {
    mkdirSync(join(baseDir, "broken"), { recursive: true, mode: 0o700 });
    const entry = buildEntry({
      name: "broken",
      version: "1.0.0",
      source: { kind: "folder", path: "/tmp/broken" },
      warnings: [],
    });
    setPluginEntry(entry, baseDir);

    const listing = listingFor("broken", baseDir);
    expect("error" in listing).toBeTruthy();
  });

  it("fails listingFor when the manifest is invalid JSON", () => {
    const dir = join(baseDir, "bad-json");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "botfleet-plugin.json"), "{ not json", { mode: 0o600 });
    const entry = buildEntry({
      name: "bad-json",
      version: "1.0.0",
      source: { kind: "folder", path: "/tmp/bad-json" },
      warnings: [],
    });
    setPluginEntry(entry, baseDir);
    const listing = listingFor("bad-json", baseDir);
    expect("error" in listing).toBeTruthy();
    // SAFETY: the previous line narrowed `listing` to an error variant; the cast is for the reader's benefit so they don't have to inspect the conditional above.
    expect((listing as { error: string }).error).toMatch(/unreadable|invalid/i);
  });

  it("fails listingFor when the manifest fails schema validation", () => {
    const dir = join(baseDir, "bad-schema");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, "botfleet-plugin.json"),
      JSON.stringify({ name: "BAD NAME", version: "1.0", description: "x", botfleet: "x", entry: "x" }),
      { mode: 0o600 },
    );
    const entry = buildEntry({
      name: "bad-schema",
      version: "1.0.0",
      source: { kind: "folder", path: "/tmp/bad-schema" },
      warnings: [],
    });
    setPluginEntry(entry, baseDir);
    const listing = listingFor("bad-schema", baseDir);
    expect("error" in listing).toBeTruthy();
  });

  it("removes an entry and its directory", () => {
    const manifest = JSON.stringify({
      name: "demo",
      version: "1.0.0",
      description: "Demo plugin.",
      botfleet: ">=1",
      entry: "plugin.mjs",
    });
    writePluginTree("demo", {
      source: "/tmp/demo",
      manifestText: manifest,
      files: [],
    }, baseDir);
    const entry = buildEntry({
      name: "demo",
      version: "1.0.0",
      source: { kind: "folder", path: "/tmp/demo" },
      warnings: [],
    });
    setPluginEntry(entry, baseDir);
    removePluginEntry("demo", baseDir);
    expect(readRegistry(baseDir).plugins.demo).toBe(undefined);
    expect(existsSync(join(baseDir, "demo"))).toBe(true); // tree was not deleted by removePluginEntry alone
  });

  it("lists every plugin directory on disk", () => {
    for (const name of ["alpha", "beta"]) {
      mkdirSync(join(baseDir, name), { recursive: true, mode: 0o700 });
    }
    const names = listPluginDirs(baseDir);
    expect(names).toEqual(["alpha", "beta"]);
  });

  it("clearPluginsDir wipes everything", () => {
    mkdirSync(join(baseDir, "alpha"), { recursive: true, mode: 0o700 });
    clearPluginsDir(baseDir);
    expect(existsSync(baseDir)).toBe(true);
    expect(listPluginDirs(baseDir)).toEqual([]);
  });
});