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
