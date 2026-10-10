import { describe, expect, it } from "vitest";

import { existsSync } from "node:fs";

import { VmCliManifestSchema, loadVmCliManifest, parseVmCliShellEnvironment, vmCliManifestPath } from "./vm-cli-manifest.ts";

describe("vmCliManifestSchema", () => {
  it("parses the committed manifest.json", () => {
    const manifest = loadVmCliManifest();
    expect(manifest.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(manifest.tools.length).toBeGreaterThan(0);
  });

  it("rejects unknown top-level fields", () => {
    expect(() =>
      VmCliManifestSchema.parse({
        schemaVersion: 1,
        tools: [],
        extra: true,
      }),
    ).toThrow();
  });

  it("parses shell environment argv", () => {
    expect(parseVmCliShellEnvironment(undefined)).toBe("cloud");
    expect(parseVmCliShellEnvironment("cloud")).toBe("cloud");
    expect(parseVmCliShellEnvironment("local-vm")).toBe("local-vm");
    expect(() => parseVmCliShellEnvironment("mars")).toThrow();
  });

  it("resolves the committed manifest on disk", () => {
    expect(existsSync(vmCliManifestPath())).toBe(true);
    loadVmCliManifest();
  });

  describe("pinned downloads", () => {
    const sha = "a".repeat(64);
    type TestAsset = { url: string; sha256: string; files: Array<{ path?: string; as: string }> };
    type TestDownload = { format: string; assets: { x86_64?: TestAsset; aarch64?: TestAsset } };
    const asset = (overrides: Partial<TestAsset> = {}): TestAsset => ({
      url: "https://example.com/tool-linux-amd64.tar.gz",
      sha256: sha,
      files: [{ path: "tool", as: "tool" }],
      ...overrides,
    });
    const tool = (download: TestDownload) => ({
      schemaVersion: 1,
      tools: [{ name: "tool", targets: ["local"], version: "1.0.0", recipe: "pinned_binary", download }],
    });
    const download = (overrides: Partial<TestDownload> = {}): TestDownload => ({
      format: "tar.gz",
      assets: { x86_64: asset(), aarch64: asset() },
      ...overrides,
    });

    it("accepts an archive and a raw download", () => {
      expect(() => VmCliManifestSchema.parse(tool(download()))).not.toThrow();
      const raw = asset({ files: [{ as: "tool" }] });
      expect(() =>
        VmCliManifestSchema.parse(tool(download({ format: "raw", assets: { x86_64: raw, aarch64: raw } }))),
      ).not.toThrow();
    });

    it("requires both architectures, so an arch is never silently unsupported", () => {
      expect(() => VmCliManifestSchema.parse(tool(download({ assets: { x86_64: asset() } })))).toThrow();
    });

    it("rejects anything that is not a lowercase 64-hex sha256", () => {
      for (const bad of ["", "abc", "A".repeat(64), "g".repeat(64), "a".repeat(63)]) {
        const broken = asset({ sha256: bad });
        expect(() => VmCliManifestSchema.parse(tool(download({ assets: { x86_64: broken, aarch64: asset() } })))).toThrow();
      }
    });

    it("rejects plain http and URLs that could break out of shell quoting", () => {
      for (const bad of ["http://example.com/x", "https://example.com/x'; rm -rf /", "https://example.com/a b", "https://example.com/$(id)", "https://example.com/x`id`", "https://example.com/a;b"]) {
        const broken = asset({ url: bad });
        expect(() => VmCliManifestSchema.parse(tool(download({ assets: { x86_64: broken, aarch64: asset() } })))).toThrow();
      }
    });

    it("rejects file names that carry shell syntax or path traversal", () => {
      for (const as of ["a b", "a;b", "$(id)", "../x", "a/b"]) {
        const broken = asset({ files: [{ path: "tool", as }] });
        expect(() => VmCliManifestSchema.parse(tool(download({ assets: { x86_64: broken, aarch64: asset() } })))).toThrow();
      }
      const bad = asset({ files: [{ path: "a;b", as: "tool" }] });
      expect(() => VmCliManifestSchema.parse(tool(download({ assets: { x86_64: bad, aarch64: asset() } })))).toThrow();
    });

    it("keeps a raw download to one file with no archive path, and an archive to files with paths", () => {
      const rawWithPath = asset({ files: [{ path: "tool", as: "tool" }] });
      expect(() =>
        VmCliManifestSchema.parse(tool(download({ format: "raw", assets: { x86_64: rawWithPath, aarch64: rawWithPath } }))),
      ).toThrow();
      const archiveNoPath = asset({ files: [{ as: "tool" }] });
      expect(() =>
        VmCliManifestSchema.parse(tool(download({ assets: { x86_64: archiveNoPath, aarch64: archiveNoPath } }))),
      ).toThrow();
    });

    it("gives every pinned_binary tool in the committed manifest a download", () => {
      for (const entry of loadVmCliManifest().tools) {
        if (entry.recipe === "pinned_binary") expect(entry.download, entry.name).toBeDefined();
        else expect(entry.download, `${entry.name} has a download but no pinned_binary recipe`).toBeUndefined();
      }
    });
  });

  it("rejects tools with invalid target values", () => {
    expect(() =>
      VmCliManifestSchema.parse({
        schemaVersion: 1,
        tools: [
          {
            name: "bad",
            targets: ["mars"],
            version: "1",
          },
        ],
      }),
    ).toThrow();
  });
});
