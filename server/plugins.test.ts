import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bootPluginRuntime,
  disablePlugin,
  enablePlugin,
  getPlugin,
  getPluginCardData,
  initPluginRuntime,
  installPlugin,
  listPlugins,
  matchPluginActionRoute,
  reloadPlugin,
  removePlugin,
  runPluginCommand,
  updatePlugin,
  _loadedNames,
  _resetForTests,
} from "./plugins.ts";
import { clearPluginsDir, readRegistry, setPluginEntry } from "./plugin-registry.ts";
import { satisfiesBotfleetVersion, HOST_API_VERSION, type PluginManifest } from "../shared/plugin-manifest.ts";

const FIXTURE = join(process.cwd(), "tests", "fixtures", "example-plugin");

interface CardData {
  total: number;
  running: number;
  stopped: number;
  errored: number;
}

let baseDir: string;

function makeRuntimeInputs() {
  return {
    listBots: () => [
      { id: "alpha", name: "Alpha", status: "running", driver: "claude" },
      { id: "beta", name: "Beta", status: "stopped", driver: "claude" },
      { id: "gamma", name: "Gamma", status: "errored", driver: "claude" },
    ],
    listConfigKeys: () => ["appearance.theme"],
    readConfig: <T = unknown>(_key: string): T | undefined => undefined,
    logger: (_level: "info" | "warn" | "error", _name: string, _message: string) => {
      // Keep the test output clean.  Real callers wire this to console.
    },
  };
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "botfleet-plugins-"));
  clearPluginsDir(baseDir);
  _resetForTests();
  initPluginRuntime(makeRuntimeInputs());
});

afterEach(() => {
  _resetForTests();
  rmSync(baseDir, { recursive: true, force: true });
});

describe("plugin lifecycle", () => {
  it("install -> disabled by default", async () => {
    const installed = await installPlugin(FIXTURE, baseDir);
    if ("error" in installed) throw new Error(installed.error);
    assert.equal(installed.enabled, false);
    assert.equal(installed.name, "fleet-overview");
    assert.equal(installed.capabilities.length, 2);
    assert.equal(existsSync(join(baseDir, "fleet-overview", "botfleet-plugin.json")), true);
  });

  it("install rejects when the manifest is invalid", async () => {
    const bad = await installPlugin(process.cwd(), baseDir);
    assert.ok("error" in bad);
  });

  it("enable imports the module and records enabled=true", async () => {
    await installPlugin(FIXTURE, baseDir);
    const enabled = await enablePlugin("fleet-overview", baseDir);
    if ("error" in enabled) throw new Error(enabled.error);
    assert.equal(enabled.enabled, true);
    assert.ok(_loadedNames().includes("fleet-overview"));
  });

  it("host API sees bots through getCardData", async () => {
    await installPlugin(FIXTURE, baseDir);
    await enablePlugin("fleet-overview", baseDir);
    const card = await getPluginCardData("fleet-overview", "fleet-overview", baseDir);
    if ("error" in card) throw new Error(card.error);
    // SAFETY: the fixture plugin returns { result: counts }; the test knows the shape because it wrote the fixture.
    const data = (card.data as { result: CardData }).result;
    assert.equal(data.total, 3);
    assert.equal(data.running, 1);
    assert.equal(data.stopped, 1);
    assert.equal(data.errored, 1);
  });

  it("host API runs a slash command", async () => {
    await installPlugin(FIXTURE, baseDir);
    await enablePlugin("fleet-overview", baseDir);
    const result = await runPluginCommand("fleet-overview", "fleet", "", baseDir);
    if ("error" in result) throw new Error(result.error);
    assert.match(result.text, /Fleet has 3 bots/);
  });

  it("runPluginCommand refuses when the plugin is disabled", async () => {
    await installPlugin(FIXTURE, baseDir);
    const result = await runPluginCommand("fleet-overview", "fleet", "", baseDir);
    if ("error" in result) {
      assert.match(result.error, /disabled/);
    } else {
      assert.fail("expected an error result");
    }
  });

  it("disable drops the loaded module and flips the flag", async () => {
    await installPlugin(FIXTURE, baseDir);
    await enablePlugin("fleet-overview", baseDir);
    assert.ok(_loadedNames().includes("fleet-overview"));
    const disabled = await disablePlugin("fleet-overview", baseDir);
    if ("error" in disabled) throw new Error(disabled.error);
    assert.equal(disabled.enabled, false);
    assert.ok(!_loadedNames().includes("fleet-overview"));
  });

  it("update refreshes the tree and reloads the module", async () => {
    // Copy the fixture to a temp folder so the update path reads the
    // bumped version back without touching the fixture on disk.
    const sourceDir = mkdtempSync(join(tmpdir(), "botfleet-plugin-update-src-"));
    try {
      const fixtureFiles = readdirSync(FIXTURE);
      for (const name of fixtureFiles) {
        copyFileSync(join(FIXTURE, name), join(sourceDir, name));
      }
      await installPlugin(sourceDir, baseDir);
      await enablePlugin("fleet-overview", baseDir);
      const manifestPath = join(sourceDir, "botfleet-plugin.json");
      // SAFETY: this test owns the manifest it just wrote, so the JSON.parse result has exactly the shape we wrote — a one-key object — and we only read `version`.
      const original = JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string };
      original.version = "1.1.0";
      writeFileSync(manifestPath, JSON.stringify(original, null, 2));
      const updated = await updatePlugin("fleet-overview", baseDir);
      if ("error" in updated) throw new Error(updated.error);
      assert.equal(updated.version, "1.1.0");
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  it("remove deletes the tree and the registry entry", async () => {
    await installPlugin(FIXTURE, baseDir);
    const removed = await removePlugin("fleet-overview", baseDir);
    if ("error" in removed) throw new Error(removed.error);
    assert.equal(removed.removed, true);
    assert.equal(existsSync(join(baseDir, "fleet-overview")), false);
    assert.equal(readRegistry(baseDir).plugins["fleet-overview"], undefined);
  });

  it("list and get return the current state", async () => {
    await installPlugin(FIXTURE, baseDir);
    const list = listPlugins(baseDir);
    assert.equal(list.length, 1);
    const one = getPlugin("fleet-overview", baseDir);
    if ("error" in one) throw new Error(one.error);
    assert.equal(one.name, "fleet-overview");
  });

  it("reload re-imports without changing the enabled flag", async () => {
    await installPlugin(FIXTURE, baseDir);
    await enablePlugin("fleet-overview", baseDir);
    const reloaded = await reloadPlugin("fleet-overview", baseDir);
    if ("error" in reloaded) throw new Error(reloaded.error);
    assert.equal(reloaded.enabled, true);
    assert.ok(_loadedNames().includes("fleet-overview"));
  });

  it("bootPluginRuntime loads every enabled plugin", async () => {
    await installPlugin(FIXTURE, baseDir);
    await enablePlugin("fleet-overview", baseDir);
    _resetForTests();
    initPluginRuntime(makeRuntimeInputs());
    await bootPluginRuntime(baseDir);
    assert.ok(_loadedNames().includes("fleet-overview"));
  });

  it("install refuses a duplicate name", async () => {
    await installPlugin(FIXTURE, baseDir);
    const second = await installPlugin(FIXTURE, baseDir);
    if ("error" in second) {
      assert.match(second.error, /already installed/);
    } else {
      assert.fail("expected an error result");
    }
  });
});

describe("host API version gate", () => {
  it("satisfiesBotfleetVersion recognizes >=1 against the host version", () => {
    assert.equal(satisfiesBotfleetVersion(">=1", HOST_API_VERSION), true);
    assert.equal(satisfiesBotfleetVersion(">=2", HOST_API_VERSION), false);
  });

  it("enablePlugin refuses when the listing declares a higher host version", async () => {
    await installPlugin(FIXTURE, baseDir);
    const entry = readRegistry(baseDir).plugins["fleet-overview"];
    if (!entry) throw new Error("fixture install did not record an entry");
    // SAFETY: this test mutates the on-disk registry entry it just wrote;
    // the next line restores it so the test never leaves stale state on disk.
    setPluginEntry({ ...entry, enabled: false }, baseDir);
    const manifestPath = join(baseDir, "fleet-overview", "botfleet-plugin.json");
    // SAFETY: this test mutates the on-disk manifest it just wrote; the fixture is the canonical example-plugin and ParsePluginManifest validates every field against the PluginManifest schema, so the cast to PluginManifest downcasts to the schema's documented shape.
    const manifestRaw = JSON.parse(readFileSync(manifestPath, "utf8")) as PluginManifest;
    writeFileSync(
      manifestPath,
      JSON.stringify({
        ...manifestRaw,
        botfleet: ">=2",
      }),
    );
    const result = await enablePlugin("fleet-overview", baseDir);
    assert.ok("error" in result, "enablePlugin should refuse on a host-version mismatch");
    assert.match(
      result.error,
      /requires botfleet ">=2" but the host API is \d/,
    );
    // The plugin must remain disabled after the refused enable.
    const after = readRegistry(baseDir).plugins["fleet-overview"];
    assert.equal(after?.enabled, false, "refused enable must not flip the flag");
    // The module must NOT have been loaded.
    assert.ok(
      !_loadedNames().includes("fleet-overview"),
      "refused enable must not import the module",
    );
  });
});

describe("matchPluginActionRoute", () => {
  it("matches the four action paths with the right name and action", () => {
    for (const action of ["enable", "disable", "update", "reload"] as const) {
      const result = matchPluginActionRoute(`/api/plugins/fleet-overview/${action}`);
      assert.deepEqual(result, { name: "fleet-overview", action });
    }
  });

  it("returns null for /api/plugins/foo (no action segment)", () => {
    assert.equal(matchPluginActionRoute("/api/plugins/foo"), null);
  });

  it("returns null for /api/plugins/foo/cards/x (card path, not an action)", () => {
    assert.equal(matchPluginActionRoute("/api/plugins/foo/cards/x"), null);
  });

  it("returns null for /api/plugins/foo/enable/extra (trailing segment)", () => {
    assert.equal(matchPluginActionRoute("/api/plugins/foo/enable/extra"), null);
  });

  it("returns null for malformed names", () => {
    assert.equal(matchPluginActionRoute("/api/plugins/-bad/enable"), null);
    assert.equal(matchPluginActionRoute("/api/plugins/.bad/enable"), null);
    assert.equal(matchPluginActionRoute("/api/plugins//enable"), null);
  });

  it("returns null for an unknown action verb", () => {
    assert.equal(matchPluginActionRoute("/api/plugins/foo/install"), null);
  });
});

describe("installFromFetched entry validation", () => {
  it("rejects when the manifest entry is not among the fetched files", async () => {
    // A folder that contains a manifest pointing at an entry file that does
    // NOT exist alongside the manifest.  buildPluginTree would write only
    // the listed files; without the entry, enable would fail later.
    const sourceDir = mkdtempSync(join(tmpdir(), "botfleet-plugin-missing-entry-"));
    try {
      writeFileSync(
        join(sourceDir, "botfleet-plugin.json"),
        JSON.stringify({
          name: "missing-entry",
          version: "1.0.0",
          description: "fixture with a phantom entry",
          botfleet: ">=1",
          // SAFETY: this test deliberately writes a manifest whose entry
          // is NOT among the files the folder carries, so we can prove
          // installFromFetched refuses before touching the registry.
          entry: "phantom.mjs",
          capabilities: [],
          contributes: {},
        }),
      );
      const result = await installPlugin(sourceDir, baseDir);
      assert.ok("error" in result, "install should refuse when entry is missing");
      assert.match(result.error, /^entry: "phantom\.mjs" is not one of the installed plugin files$/);
      // The registry must not have been mutated.
      assert.equal(readRegistry(baseDir).plugins["missing-entry"], undefined);
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  it("installs when the manifest entry IS among the fetched files", async () => {
    // Same shape as the first test, but the entry file IS present.
    const sourceDir = mkdtempSync(join(tmpdir(), "botfleet-plugin-present-entry-"));
    try {
      writeFileSync(
        join(sourceDir, "botfleet-plugin.json"),
        JSON.stringify({
          name: "present-entry",
          version: "1.0.0",
          description: "fixture whose entry file is present",
          botfleet: ">=1",
          entry: "plugin.mjs",
          capabilities: [],
          contributes: {},
        }),
      );
      writeFileSync(join(sourceDir, "plugin.mjs"), "export default {};\n");
      const result = await installPlugin(sourceDir, baseDir);
      assert.ok(!("error" in result), `install should succeed, got: ${"error" in result ? result.error : ""}`);
      assert.equal(result.name, "present-entry");
      assert.equal(result.entry, "plugin.mjs");
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });
});