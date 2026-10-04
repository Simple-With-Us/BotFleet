import { describe, it } from "node:test";
import assert from "node:assert/strict";

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
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.manifest.name, "fleet-overview");
      assert.equal(result.manifest.version, "1.0.0");
      assert.equal(result.manifest.botfleet, ">=1");
      assert.equal(result.manifest.entry, "plugin.mjs");
      assert.deepEqual(result.manifest.capabilities, []);
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
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.manifest.capabilities.length, 2);
      assert.equal(result.manifest.contributes?.cards?.length, 1);
      assert.equal(result.manifest.contributes?.commands?.length, 1);
    }
  });

  it("rejects names with uppercase letters", () => {
    const bad = { ...valid, name: "FleetOverview" };
    const result = parsePluginManifest(bad);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.issues.some((i) => i.field === "name"));
    }
  });

  it("rejects names that try to escape the slug gate", () => {
    for (const name of ["../escape", ".", "..", "with spaces", "with_underscore"]) {
      const result = parsePluginManifest({ ...valid, name });
      assert.equal(result.ok, false, `expected rejection of ${name}`);
    }
  });

  it("rejects non-semver versions with a useful message", () => {
    const result = parsePluginManifest({ ...valid, version: "1.0" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      const issue = result.issues.find((i) => i.field === "version");
      assert.ok(issue);
      assert.match(issue!.message, /semver/);
    }
  });

  it("rejects unknown capabilities", () => {
    const result = parsePluginManifest({ ...valid, capabilities: ["read.bots", "nuke.everything"] });
    assert.equal(result.ok, false);
    if (!result.ok) {
      const issue = result.issues.find((i) => i.message.includes("nuke.everything"));
      assert.ok(issue);
      assert.match(issue!.message, new RegExp(PLUGIN_CAPABILITIES.join("|")));
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
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.issues.some((i) => i.field === "contributes.cards"));
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
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.issues.some((i) => i.field === "contributes.commands"));
    }
  });

  it("rejects entry that points outside the plugin directory", () => {
    const result = parsePluginManifest({ ...valid, entry: "../escape.mjs" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.issues.some((i) => i.field === "entry"));
    }
  });

  it("rejects entry with non-js extension", () => {
    const result = parsePluginManifest({ ...valid, entry: "plugin.cjs" });
    assert.equal(result.ok, false);
  });

  it("rejects botfleet constraint that is not a semver range", () => {
    const result = parsePluginManifest({ ...valid, botfleet: "soon" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.issues.some((i) => i.field === "botfleet"));
    }
  });

  it("includes a (root) field when input is not an object", () => {
    const result = parsePluginManifest("not an object");
    assert.equal(result.ok, false);
    if (!result.ok) {
      // zod returns the root path as "" or similar; we treat both as the root.
      assert.ok(result.issues.some((i) => i.field === "(root)"));
    }
  });
});

describe("parsePluginManifestJson", () => {
  it("surfaces JSON syntax errors as a single (root) issue", () => {
    const result = parsePluginManifestJson("{ not valid json");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.issues.length, 1);
      assert.equal(result.issues[0]!.field, "(root)");
      assert.match(result.issues[0]!.message, /not valid JSON/);
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
    assert.equal(result.ok, true);
  });
});

describe("satisfiesBotfleetVersion", () => {
  it("honors >=", () => {
    assert.equal(satisfiesBotfleetVersion(">=1", 1), true);
    assert.equal(satisfiesBotfleetVersion(">=1", 2), true);
    assert.equal(satisfiesBotfleetVersion(">=2", 1), false);
  });

  it("honors <=", () => {
    assert.equal(satisfiesBotfleetVersion("<=1", 1), true);
    assert.equal(satisfiesBotfleetVersion("<=1", 2), false);
  });

  it("honors caret", () => {
    assert.equal(satisfiesBotfleetVersion("^1.2.0", 1), true);
    assert.equal(satisfiesBotfleetVersion("^1.2.0", 2), false);
  });

  it("honors tilde", () => {
    assert.equal(satisfiesBotfleetVersion("~1.2.0", 1), true);
  });

  it("honors bare version", () => {
    assert.equal(satisfiesBotfleetVersion("1", HOST_API_VERSION), true);
    assert.equal(satisfiesBotfleetVersion("2", HOST_API_VERSION), false);
  });

  it("fails closed on garbage", () => {
    assert.equal(satisfiesBotfleetVersion("anything", 1), false);
  });
});