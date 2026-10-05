import { describe, expect, it } from "vitest";

import { VmCliManifestSchema, loadVmCliManifest } from "./vm-cli-manifest.ts";

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
