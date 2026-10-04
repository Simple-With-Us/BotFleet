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
  reloadPlugin,
  removePlugin,
  runPluginCommand,
  updatePlugin,
  _loadedNames,
  _resetForTests,
} from "./plugins.ts";
import { clearPluginsDir, readRegistry } from "./plugin-registry.ts";
import { satisfiesBotfleetVersion, HOST_API_VERSION } from "../shared/plugin-manifest.ts";

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
});