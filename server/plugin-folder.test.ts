import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPluginFolder, type PluginFolderReader } from "./plugin-folder.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "botfleet-plugin-folder-"));
});

function errorFrom(result: ReturnType<typeof readPluginFolder>): string {
  if (!("error" in result)) throw new Error("expected readPluginFolder to fail");
  return result.error;
}

describe("readPluginFolder", () => {
  it("returns an error when no manifest is present", () => {
    const result = readPluginFolder(dir, stubFolder({ entries: [{ name: "plugin.mjs", isDirectory: false }] }));
    expect("error" in result).toBeTruthy();
    expect(errorFrom(result)).toMatch(/no botfleet-plugin\.json/);
  });

  it("returns an error when the manifest cannot be read", () => {
    const result = readPluginFolder(dir, stubFolder({
      entries: [{ name: "botfleet-plugin.json", isDirectory: false }],
      byteSize: () => 32,
      read: () => { throw new Error("EACCES"); },
    }));
    expect("error" in result).toBeTruthy();
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
    expect(result.fetched.manifestText).toBe(manifest);
    expect(result.fetched.files.length).toBe(1);
    expect(result.fetched.files[0]!.path).toBe("plugin.mjs");
    expect(result.skipped).toEqual(["README.md", "sub"]);
  });

  it("refuses absolute paths", () => {
    const result = readPluginFolder("relative/path");
    expect("error" in result).toBeTruthy();
    expect(errorFrom(result)).toMatch(/full path/);
  });

  it("stops reading once the plugin file cap is reached", () => {
    const entries = [{ name: "botfleet-plugin.json", isDirectory: false }];
    for (let i = 0; i < 70; i += 1) entries.push({ name: `file-${i}.js`, isDirectory: false });
    let reads = 0;
    const result = readPluginFolder(dir, stubFolder({
      entries,
      byteSize: () => 8,
      read: () => {
        reads += 1;
        return "{}";
      },
    }));
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/import cap is 64/);
    // The manifest is read once.  Only 64 plugin files are read, not all 70.
    expect(reads).toBe(65);
  });

  it("refuses a manifest over the size cap", () => {
    const result = readPluginFolder(dir, stubFolder({
      entries: [{ name: "botfleet-plugin.json", isDirectory: false }],
      byteSize: () => 1024 * 1024,
    }));
    expect("error" in result).toBeTruthy();
    expect(errorFrom(result)).toMatch(/256KB/);
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