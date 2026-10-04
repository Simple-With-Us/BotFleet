import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPluginFolder, type PluginFolderReader } from "./plugin-folder.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "botfleet-plugin-folder-"));
});

function errorFrom(result: { error: string } | unknown): string {
  // SAFETY: every code path that returns a `{ error }` object is built in plugin-folder.ts; the tests assert against the union shape.
  return (result as { error: string }).error;
}

describe("readPluginFolder", () => {
  it("returns an error when no manifest is present", () => {
    const result = readPluginFolder(dir, stubFolder({ entries: [{ name: "plugin.mjs", isDirectory: false }] }));
    assert.ok("error" in result);
    assert.match(errorFrom(result), /no botfleet-plugin\.json/);
  });

  it("returns an error when the manifest cannot be read", () => {
    const result = readPluginFolder(dir, stubFolder({
      entries: [{ name: "botfleet-plugin.json", isDirectory: false }],
      byteSize: () => 32,
      read: () => { throw new Error("EACCES"); },
    }));
    assert.ok("error" in result);
  });

  it("reads the manifest plus allowed files", () => {
    const manifest = JSON.stringify({ name: "demo", version: "1.0.0", description: "x", botfleet: ">=1", entry: "plugin.mjs" });
    const result = readPluginFolder(dir, stubFolder({
      entries: [
        { name: "botfleet-plugin.json", isDirectory: false },
        { name: "plugin.mjs", isDirectory: false },
        { name: "README.md", isDirectory: false },
        { name: "sub", isDirectory: true },
      ],
      byteSize: () => manifest.length,
      read: (file) => file.endsWith("plugin.mjs") ? "export const x = 1;" : manifest,
    }));
    if ("error" in result) throw new Error(result.error);
    assert.equal(result.fetched.manifestText, manifest);
    assert.equal(result.fetched.files.length, 1);
    assert.equal(result.fetched.files[0]!.path, "plugin.mjs");
  });

  it("refuses absolute paths", () => {
    const result = readPluginFolder("relative/path");
    assert.ok("error" in result);
    assert.match(errorFrom(result), /full path/);
  });

  it("refuses a manifest over the size cap", () => {
    const result = readPluginFolder(dir, stubFolder({
      entries: [{ name: "botfleet-plugin.json", isDirectory: false }],
      byteSize: () => 1024 * 1024,
    }));
    assert.ok("error" in result);
    assert.match(errorFrom(result), /256KB/);
  });
});

function stubFolder(overrides: {
  entries: Array<{ name: string; isDirectory: boolean }>;
  byteSize?: (file: string) => number;
  read?: (file: string) => string;
}): PluginFolderReader {
  return {
    list: () => overrides.entries,
    byteSize: overrides.byteSize ?? (() => 0),
    read: overrides.read ?? (() => ""),
  };
}