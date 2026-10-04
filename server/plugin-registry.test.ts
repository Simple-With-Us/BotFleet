import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    assert.equal(registry.version, 1);
    assert.deepEqual(registry.plugins, {});
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
    assert.equal(registry.plugins.demo?.name, "demo");
    assert.equal(registry.plugins.demo?.enabled, false);
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
    assert.equal(listing.name, "demo");
    assert.equal(listing.version, "1.0.0");
    assert.equal(listing.description, "Demo plugin.");
    assert.equal(listing.capabilities.length, 0);
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
    assert.ok("error" in listing);
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
    assert.ok("error" in listing);
    // SAFETY: the previous line narrowed `listing` to an error variant; the cast is for the reader's benefit so they don't have to inspect the conditional above.
    assert.match((listing as { error: string }).error, /unreadable|invalid/i);
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
    assert.ok("error" in listing);
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
    assert.equal(readRegistry(baseDir).plugins.demo, undefined);
    assert.equal(existsSync(join(baseDir, "demo")), true); // tree was not deleted by removePluginEntry alone
  });

  it("lists every plugin directory on disk", () => {
    for (const name of ["alpha", "beta"]) {
      mkdirSync(join(baseDir, name), { recursive: true, mode: 0o700 });
    }
    const names = listPluginDirs(baseDir);
    assert.deepEqual(names, ["alpha", "beta"]);
  });

  it("clearPluginsDir wipes everything", () => {
    mkdirSync(join(baseDir, "alpha"), { recursive: true, mode: 0o700 });
    clearPluginsDir(baseDir);
    assert.equal(existsSync(baseDir), true);
    assert.deepEqual(listPluginDirs(baseDir), []);
  });
});