import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
  compareSemver,
} from "./plugins.ts";
import { clearPluginsDir, readRegistry, removeDirSafe, setPluginEntry } from "./plugin-registry.ts";
import type { PluginLogEvent } from "./plugin-loader.ts";
import { z } from "zod";

import { satisfiesBotfleetVersion, HOST_API_VERSION, pluginManifestSchema } from "../shared/plugin-manifest.ts";

const FIXTURE = join(process.cwd(), "tests", "fixtures", "example-plugin");

// The fixture's card payload, parsed rather than cast: plugin output is
// boundary data even in a test.
const CardDataSchema = z.object({
  result: z.object({ total: z.number(), running: z.number(), stopped: z.number(), errored: z.number() }).strict(),
}).strict();

/** Read a manifest written to disk by the test, through the real schema. */
function readManifest(path: string) {
  return pluginManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
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
    logger: (_event: PluginLogEvent) => {
      // Keep the test output clean.  Real callers wire this to console.
    },
  };
}

beforeEach(async () => {
  baseDir = mkdtempSync(join(tmpdir(), "botfleet-plugins-"));
  await clearPluginsDir(baseDir);
  await _resetForTests();
  initPluginRuntime(makeRuntimeInputs());
});

afterEach(async () => {
  await _resetForTests();
  await removeDirSafe(baseDir);
});

describe("plugin lifecycle", () => {
  it("install -> disabled by default", async () => {
    const installed = await installPlugin(FIXTURE, baseDir);
    if ("error" in installed) throw new Error(installed.error);
    expect(installed.enabled).toBe(false);
    expect(installed.name).toBe("fleet-overview");
    expect(installed.capabilities.length).toBe(2);
    expect(existsSync(join(baseDir, "fleet-overview", "botfleet-plugin.json"))).toBe(true);
  });

  it("install rejects when the manifest is invalid", async () => {
    const bad = await installPlugin(process.cwd(), baseDir);
    expect("error" in bad).toBeTruthy();
  });

  it("enable imports the module and records enabled=true", async () => {
    await installPlugin(FIXTURE, baseDir);
    const enabled = await enablePlugin("fleet-overview", baseDir);
    if ("error" in enabled) throw new Error(enabled.error);
    expect(enabled.enabled).toBe(true);
    expect(_loadedNames().includes("fleet-overview")).toBeTruthy();
  });

  it("host API sees bots through getCardData", async () => {
    await installPlugin(FIXTURE, baseDir);
    await enablePlugin("fleet-overview", baseDir);
    const card = await getPluginCardData("fleet-overview", "fleet-overview", baseDir);
    if ("error" in card) throw new Error(card.error);
    const data = CardDataSchema.parse(card.data).result;
    expect(data.total).toBe(3);
    expect(data.running).toBe(1);
    expect(data.stopped).toBe(1);
    expect(data.errored).toBe(1);
  });

  it("host API runs a slash command", async () => {
    await installPlugin(FIXTURE, baseDir);
    await enablePlugin("fleet-overview", baseDir);
    const result = await runPluginCommand("fleet-overview", "fleet", "", baseDir);
    if ("error" in result) throw new Error(result.error);
    expect(result.text).toMatch(/Fleet has 3 bots/);
  });

  it("runPluginCommand refuses when the plugin is disabled", async () => {
    await installPlugin(FIXTURE, baseDir);
    const result = await runPluginCommand("fleet-overview", "fleet", "", baseDir);
    if ("error" in result) {
      expect(result.error).toMatch(/disabled/);
    } else {
      throw new Error("expected an error result");
    }
  });

  it("disable drops the loaded module and flips the flag", async () => {
    await installPlugin(FIXTURE, baseDir);
    await enablePlugin("fleet-overview", baseDir);
    expect(_loadedNames().includes("fleet-overview")).toBeTruthy();
    const disabled = await disablePlugin("fleet-overview", baseDir);
    if ("error" in disabled) throw new Error(disabled.error);
    expect(disabled.enabled).toBe(false);
    expect(!_loadedNames().includes("fleet-overview")).toBeTruthy();
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
      const original = readManifest(manifestPath);
      original.version = "1.1.0";
      writeFileSync(manifestPath, JSON.stringify(original, null, 2));
      const updated = await updatePlugin("fleet-overview", baseDir);
      if ("error" in updated) throw new Error(updated.error);
      expect(updated.version).toBe("1.1.0");
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  it("remove deletes the tree and the registry entry", async () => {
    await installPlugin(FIXTURE, baseDir);
    const removed = await removePlugin("fleet-overview", baseDir);
    if ("error" in removed) throw new Error(removed.error);
    expect(removed.removed).toBe(true);
    expect(existsSync(join(baseDir, "fleet-overview"))).toBe(false);
    expect(readRegistry(baseDir).plugins["fleet-overview"]).toBe(undefined);
  });

  it("list and get return the current state", async () => {
    await installPlugin(FIXTURE, baseDir);
    const list = listPlugins(baseDir);
    expect(list.length).toBe(1);
    const one = getPlugin("fleet-overview", baseDir);
    if ("error" in one) throw new Error(one.error);
    expect(one.name).toBe("fleet-overview");
  });

  it("reload re-imports without changing the enabled flag", async () => {
    await installPlugin(FIXTURE, baseDir);
    await enablePlugin("fleet-overview", baseDir);
    const reloaded = await reloadPlugin("fleet-overview", baseDir);
    if ("error" in reloaded) throw new Error(reloaded.error);
    expect(reloaded.enabled).toBe(true);
    expect(_loadedNames().includes("fleet-overview")).toBeTruthy();
  });

  it("bootPluginRuntime loads every enabled plugin", async () => {
    await installPlugin(FIXTURE, baseDir);
    await enablePlugin("fleet-overview", baseDir);
    await _resetForTests();
    initPluginRuntime(makeRuntimeInputs());
    await bootPluginRuntime(baseDir);
    expect(_loadedNames().includes("fleet-overview")).toBeTruthy();
  });

  it("install refuses a duplicate name", async () => {
    await installPlugin(FIXTURE, baseDir);
    const second = await installPlugin(FIXTURE, baseDir);
    if ("error" in second) {
      expect(second.error).toMatch(/already installed/);
    } else {
      throw new Error("expected an error result");
    }
  });
});

describe("host API version gate", () => {
  it("satisfiesBotfleetVersion recognizes >=1 against the host version", () => {
    expect(satisfiesBotfleetVersion(">=1", HOST_API_VERSION)).toBe(true);
    expect(satisfiesBotfleetVersion(">=2", HOST_API_VERSION)).toBe(false);
  });

  it("enablePlugin refuses when the listing declares a higher host version", async () => {
    await installPlugin(FIXTURE, baseDir);
    const entry = readRegistry(baseDir).plugins["fleet-overview"];
    if (!entry) throw new Error("fixture install did not record an entry");
    // SAFETY: this test mutates the on-disk registry entry it just wrote;
    // the next line restores it so the test never leaves stale state on disk.
    setPluginEntry({ ...entry, enabled: false }, baseDir);
    const manifestPath = join(baseDir, "fleet-overview", "botfleet-plugin.json");
    const manifestRaw = readManifest(manifestPath);
    writeFileSync(
      manifestPath,
      JSON.stringify({
        ...manifestRaw,
        botfleet: ">=2",
      }),
    );
    const result = await enablePlugin("fleet-overview", baseDir);
    if (!("error" in result)) throw new Error("expected enable to fail");
    expect(result.error).toMatch(/requires botfleet ">=2" but the host API is \d/);
    // The plugin must remain disabled after the refused enable.
    const after = readRegistry(baseDir).plugins["fleet-overview"];
    expect(after?.enabled).toBe(false);
    // The module must NOT have been loaded.
    expect(!_loadedNames().includes("fleet-overview")).toBeTruthy();
  });
});

describe("matchPluginActionRoute", () => {
  it("matches the four action paths with the right name and action", () => {
    for (const action of ["enable", "disable", "update", "reload"] as const) {
      const result = matchPluginActionRoute(`/api/plugins/fleet-overview/${action}`);
      expect(result).toEqual({ name: "fleet-overview", action });
    }
  });

  it("returns null for /api/plugins/foo (no action segment)", () => {
    expect(matchPluginActionRoute("/api/plugins/foo")).toBe(null);
  });

  it("returns null for /api/plugins/foo/cards/x (card path, not an action)", () => {
    expect(matchPluginActionRoute("/api/plugins/foo/cards/x")).toBe(null);
  });

  it("returns null for /api/plugins/foo/enable/extra (trailing segment)", () => {
    expect(matchPluginActionRoute("/api/plugins/foo/enable/extra")).toBe(null);
  });

  it("returns null for malformed names", () => {
    expect(matchPluginActionRoute("/api/plugins/-bad/enable")).toBe(null);
    expect(matchPluginActionRoute("/api/plugins/.bad/enable")).toBe(null);
    expect(matchPluginActionRoute("/api/plugins//enable")).toBe(null);
  });

  it("returns null for an unknown action verb", () => {
    expect(matchPluginActionRoute("/api/plugins/foo/install")).toBe(null);
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
      if (!("error" in result)) throw new Error("expected install to fail");
      expect(result.error).toMatch(/^entry: "phantom\.mjs" is not one of the installed plugin files$/);
      // The registry must not have been mutated.
      expect(readRegistry(baseDir).plugins["missing-entry"]).toBe(undefined);
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
      if ("error" in result) throw new Error(result.error);
      expect(result.name).toBe("present-entry");
      expect(result.entry).toBe("plugin.mjs");
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });
});

describe("install failures the UI can render", () => {
  it("returns one issue per manifest field instead of only a flattened error", async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "botfleet-plugin-bad-manifest-"));
    try {
      writeFileSync(join(sourceDir, "botfleet-plugin.json"), JSON.stringify({
        name: "bad-version",
        version: "1.0",
        description: "not semver",
        botfleet: ">=1",
        entry: "plugin.mjs",
      }));
      writeFileSync(join(sourceDir, "plugin.mjs"), "export {}\n");
      const result = await installPlugin(sourceDir, baseDir);
      if (!("error" in result)) throw new Error("expected install to fail");
      expect(result.error).toBe("invalid manifest");
      expect(result.issues?.some((issue) => issue.field === "version")).toBe(true);
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  it("treats a tilde path as a folder on this computer", async () => {
    const result = await installPlugin("~/no-such-botfleet-plugin-dir", baseDir);
    if (!("error" in result)) throw new Error("expected install to fail");
    expect(result.error).not.toMatch(/full path/);
    expect(result.error).toMatch(/could not be read/);
  });

  it("records a git subdirectory and updates from that folder", async () => {
    const manifest = JSON.stringify({
      name: "sub-plugin",
      version: "1.0.0",
      description: "nested",
      botfleet: ">=1",
      entry: "plugin.mjs",
    });
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.toString() : String(input);
      calls.push(url);
      if (url.includes("/contents/plugins/foo")) {
        return Response.json([
          { type: "file", name: "botfleet-plugin.json", path: "botfleet-plugin.json", download_url: "https://example/manifest", sha: "abc" },
          { type: "file", name: "plugin.mjs", path: "plugin.mjs", download_url: "https://example/plugin", sha: "def" },
        ]);
      }
      if (url === "https://example/manifest") return new Response(manifest);
      if (url === "https://example/plugin") return new Response("export {}\n");
      return new Response("missing", { status: 404 });
    };
    const installed = await installPlugin("https://github.com/acme/widget/tree/main/plugins/foo", baseDir, fetcher);
    if ("error" in installed) throw new Error(installed.error);
    expect(installed.source).toEqual({
      kind: "git",
      url: "github.com/acme/widget",
      ref: "main",
      path: "plugins/foo",
    });
    calls.length = 0;
    const updated = await updatePlugin("sub-plugin", baseDir, fetcher);
    if ("error" in updated) throw new Error(updated.error);
    expect(calls.some((url) => url.includes("/contents/plugins/foo"))).toBe(true);
  });

  it("refuses an update whose entry file is not in the fetched tree", async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "botfleet-plugin-update-entry-"));
    try {
      for (const name of readdirSync(FIXTURE)) {
        copyFileSync(join(FIXTURE, name), join(sourceDir, name));
      }
      await installPlugin(sourceDir, baseDir);
      writeFileSync(join(sourceDir, "botfleet-plugin.json"), JSON.stringify({
        name: "fleet-overview",
        version: "1.2.0",
        description: "missing entry",
        botfleet: ">=1",
        entry: "phantom.mjs",
      }));
      const updated = await updatePlugin("fleet-overview", baseDir);
      if (!("error" in updated)) throw new Error("expected update to fail");
      expect(updated.error).toMatch(/phantom\.mjs/);
      const listing = getPlugin("fleet-overview", baseDir);
      if ("error" in listing) throw new Error(listing.error);
      expect(listing.version).toBe("1.0.0");
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  it("refuses a command when the manifest host version no longer matches", async () => {
    await installPlugin(FIXTURE, baseDir);
    await enablePlugin("fleet-overview", baseDir);
    const manifestPath = join(baseDir, "fleet-overview", "botfleet-plugin.json");
    const manifest = readManifest(manifestPath);
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, botfleet: ">=2" }));
    const result = await runPluginCommand("fleet-overview", "fleet", "", baseDir);
    if (!("error" in result)) throw new Error("expected the command to fail");
    expect(result.error).toMatch(/requires botfleet ">=2"/);
    // Request-time mismatch must persist enabled=false like bootPluginRuntime.
    expect(readRegistry(baseDir).plugins["fleet-overview"]?.enabled).toBe(false);
  });
});


describe("compareSemver", () => {
  it("orders strict MAJOR.MINOR.PATCH strings", () => {
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.0", "1.1.0")).toBe(-1);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
  });
});

describe("install folder skipped warnings", () => {
  it("records skipped directories and non-script files as install warnings", async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "botfleet-plugin-skipped-"));
    try {
      const fixtureFiles = readdirSync(FIXTURE);
      for (const name of fixtureFiles) {
        copyFileSync(join(FIXTURE, name), join(sourceDir, name));
      }
      mkdirSync(join(sourceDir, "helpers"), { recursive: true });
      writeFileSync(join(sourceDir, "README.md"), "# demo\n");
      const installed = await installPlugin(sourceDir, baseDir);
      if ("error" in installed) throw new Error(installed.error);
      expect(installed.warnings.some((w) => w === "skipped helpers")).toBe(true);
      expect(installed.warnings.some((w) => w === "skipped README.md")).toBe(true);
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });
});

describe("update downgrade warning", () => {
  it("warns when an update would downgrade the installed version", async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "botfleet-plugin-downgrade-"));
    try {
      const fixtureFiles = readdirSync(FIXTURE);
      for (const name of fixtureFiles) {
        copyFileSync(join(FIXTURE, name), join(sourceDir, name));
      }
      await installPlugin(sourceDir, baseDir);
      const manifestPath = join(sourceDir, "botfleet-plugin.json");
      const original = readManifest(manifestPath);
      // Bump first so we have room to downgrade.
      original.version = "1.2.0";
      writeFileSync(manifestPath, JSON.stringify(original, null, 2));
      const bumped = await updatePlugin("fleet-overview", baseDir);
      if ("error" in bumped) throw new Error(bumped.error);
      expect(bumped.version).toBe("1.2.0");

      original.version = "1.0.0";
      writeFileSync(manifestPath, JSON.stringify(original, null, 2));
      const downgraded = await updatePlugin("fleet-overview", baseDir);
      if ("error" in downgraded) throw new Error(downgraded.error);
      expect(downgraded.version).toBe("1.0.0");
      expect(downgraded.warnings.some((w) => /downgrade.*1\.2\.0.*1\.0\.0/.test(w))).toBe(true);
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });
});
