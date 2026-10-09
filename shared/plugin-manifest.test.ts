import { describe, expect, it } from "vitest";

import {
  HOST_API_VERSION,
  PLUGIN_CAPABILITIES,
  parsePluginManifest,
  parsePluginManifestJson,
  satisfiesBotfleetVersion,
} from "./plugin-manifest.ts";

describe("parsePluginManifest", () => {
  const valid = {
    name: "fleet-overview",
    version: "1.0.0",
    description: "Bot counts by status.",
    botfleet: ">=1",
    entry: "plugin.mjs",
  };

  it("accepts a minimal valid manifest", () => {
    const result = parsePluginManifest(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.name).toBe("fleet-overview");
      expect(result.manifest.version).toBe("1.0.0");
      expect(result.manifest.botfleet).toBe(">=1");
      expect(result.manifest.entry).toBe("plugin.mjs");
      expect(result.manifest.capabilities).toEqual([]);
    }
  });

  it("accepts a fully populated manifest", () => {
    const full = {
      ...valid,
      author: "Jay Wedgeworth",
      license: "Apache-2.0",
      capabilities: ["read.bots", "read.status"],
      contributes: {
        cards: [
          {
            id: "fleet-overview",
            title: "Fleet Overview",
            description: "Counts.",
            layout: "stat-grid",
            fields: ["total", "running"],
          },
        ],
        commands: [
          { name: "fleet", description: "Summarize the fleet.", args: ["scope"] },
        ],
      },
    };
    const result = parsePluginManifest(full);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.capabilities.length).toBe(2);
      expect(result.manifest.contributes?.cards?.length).toBe(1);
      expect(result.manifest.contributes?.commands?.length).toBe(1);
    }
  });

  it("rejects names with uppercase letters", () => {
    const bad = { ...valid, name: "FleetOverview" };
    const result = parsePluginManifest(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.field === "name")).toBeTruthy();
    }
  });

  it("rejects names that try to escape the slug gate", () => {
    for (const name of ["../escape", ".", "..", "with spaces", "with_underscore"]) {
      const result = parsePluginManifest({ ...valid, name });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects non-semver versions with a useful message", () => {
    const result = parsePluginManifest({ ...valid, version: "1.0" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((i) => i.field === "version");
      expect(issue).toBeTruthy();
      expect(issue!.message).toMatch(/semver/);
    }
  });

  it("rejects unknown capabilities", () => {
    const result = parsePluginManifest({ ...valid, capabilities: ["read.bots", "nuke.everything"] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((i) => i.message.includes("nuke.everything"));
      expect(issue).toBeTruthy();
      expect(issue!.message).toMatch(new RegExp(PLUGIN_CAPABILITIES.join("|")));
    }
  });

  it("rejects card id duplicates with a per-field message", () => {
    const bad = {
      ...valid,
      contributes: {
        cards: [
          { id: "fleet", title: "A", layout: "stat-grid" },
          { id: "fleet", title: "B", layout: "stat-grid" },
        ],
      },
    };
    const result = parsePluginManifest(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.field === "contributes.cards")).toBeTruthy();
    }
  });

  it("rejects duplicate command names", () => {
    const bad = {
      ...valid,
      contributes: {
        commands: [
          { name: "fleet", description: "A" },
          { name: "fleet", description: "B" },
        ],
      },
    };
    const result = parsePluginManifest(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.field === "contributes.commands")).toBeTruthy();
    }
  });

  it("rejects entry that points outside the plugin directory", () => {
    const result = parsePluginManifest({ ...valid, entry: "../escape.mjs" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.field === "entry")).toBeTruthy();
    }
  });

  it("rejects entry with non-js extension", () => {
    const result = parsePluginManifest({ ...valid, entry: "plugin.cjs" });
    expect(result.ok).toBe(false);
  });

  it("rejects botfleet constraint that is not a semver range", () => {
    const result = parsePluginManifest({ ...valid, botfleet: "soon" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.field === "botfleet")).toBeTruthy();
    }
  });

  it("rejects botfleet ranges the gate cannot evaluate (e.g. >=1.0.0)", () => {
    const result = parsePluginManifest({ ...valid, botfleet: ">=1.0.0" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.field === "botfleet")).toBeTruthy();
    }
  });

  it("includes a (root) field when input is not an object", () => {
    const result = parsePluginManifest("not an object");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // zod returns the root path as "" or similar; we treat both as the root.
      expect(result.issues.some((i) => i.field === "(root)")).toBeTruthy();
    }
  });
});

describe("parsePluginManifestJson", () => {
  it("surfaces JSON syntax errors as a single (root) issue", () => {
    const result = parsePluginManifestJson("{ not valid json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBe(1);
      expect(result.issues[0]!.field).toBe("(root)");
      expect(result.issues[0]!.message).toMatch(/not valid JSON/);
    }
  });

  it("passes through to schema when JSON parses", () => {
    const result = parsePluginManifestJson(JSON.stringify({
      name: "ok",
      version: "0.0.1",
      description: ".",
      botfleet: ">=1",
      entry: "x.mjs",
    }));
    expect(result.ok).toBe(true);
  });
});

describe("satisfiesBotfleetVersion", () => {
  it("honors >=", () => {
    expect(satisfiesBotfleetVersion(">=1", 1)).toBe(true);
    expect(satisfiesBotfleetVersion(">=1", 2)).toBe(true);
    expect(satisfiesBotfleetVersion(">=2", 1)).toBe(false);
  });

  it("honors <=", () => {
    expect(satisfiesBotfleetVersion("<=1", 1)).toBe(true);
    expect(satisfiesBotfleetVersion("<=1", 2)).toBe(false);
  });

  it("honors caret", () => {
    expect(satisfiesBotfleetVersion("^1.2.0", 1)).toBe(true);
    expect(satisfiesBotfleetVersion("^1.2.0", 2)).toBe(false);
  });

  it("honors tilde", () => {
    expect(satisfiesBotfleetVersion("~1.2.0", 1)).toBe(true);
  });

  it("honors bare version", () => {
    expect(satisfiesBotfleetVersion("1", HOST_API_VERSION)).toBe(true);
    expect(satisfiesBotfleetVersion("2", HOST_API_VERSION)).toBe(false);
  });

  it("fails closed on garbage", () => {
    expect(satisfiesBotfleetVersion("anything", 1)).toBe(false);
  });
});