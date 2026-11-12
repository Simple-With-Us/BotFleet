import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deletePluginBrokerState,
  migratePluginSettings,
  pluginSecretKeys,
  pluginSecretsPath,
  readPluginSecrets,
  readPluginSettings,
  validatePluginSettings,
  writePluginSecret,
  writePluginSettings,
} from "./plugin-secrets.ts";

let baseDir = "";

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "bf-plugin-secrets-"));
  mkdirSync(join(baseDir, "demo"), { recursive: true });
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe("validatePluginSettings", () => {
  const specs = [
    { key: "dispatcherBotId", label: "Dispatcher", type: "string" as const, required: true },
    { key: "maxChats", label: "Max", type: "number" as const },
    { key: "verbose", label: "Verbose", type: "boolean" as const },
    { key: "hookSecret", label: "Secret", type: "secret" as const },
  ];

  it("splits secrets from plain values", () => {
    const result = validatePluginSettings(specs, {
      dispatcherBotId: "bot-director",
      maxChats: 5,
      verbose: true,
      hookSecret: "s3cr3t",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values).toEqual({ dispatcherBotId: "bot-director", maxChats: 5, verbose: true });
    expect(result.secrets).toEqual({ hookSecret: "s3cr3t" });
    expect("hookSecret" in result.values).toBe(false);
  });

  it("fails closed on unknown keys, wrong types, and missing required", () => {
    const result = validatePluginSettings(specs, { bogus: 1, maxChats: "5" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.field === "settings.bogus")).toBe(true);
    expect(result.issues.some((i) => i.field === "settings.maxChats")).toBe(true);
    expect(result.issues.some((i) => i.field === "settings.dispatcherBotId")).toBe(true);
  });

  it("rejects empty secrets", () => {
    const result = validatePluginSettings(specs, { dispatcherBotId: "b", hookSecret: "" });
    expect(result.ok).toBe(false);
  });
});

describe("settings and secret persistence", () => {
  it("round-trips settings and keeps secrets separate", () => {
    writePluginSettings(baseDir, "demo", 2, { dispatcherBotId: "bot-director" });
    writePluginSecret(baseDir, "demo", "hookSecret", "s3cr3t");
    expect(readPluginSettings(baseDir, "demo")).toEqual({
      settingsVersion: 2,
      values: { dispatcherBotId: "bot-director" },
    });
    expect(pluginSecretKeys(baseDir, "demo")).toEqual(["hookSecret"]);
    // Secret values never appear in the settings file.
    const settingsText = readFileSync(join(baseDir, "demo", "plugin-settings.json"), "utf8");
    expect(settingsText.includes("s3cr3t")).toBe(false);
  });

  it("deletes a secret with an empty write", () => {
    writePluginSecret(baseDir, "demo", "hookSecret", "s3cr3t");
    writePluginSecret(baseDir, "demo", "hookSecret", "");
    expect(pluginSecretKeys(baseDir, "demo")).toEqual([]);
    expect(readPluginSecrets(baseDir, "demo")).toEqual({});
  });

  it("quarantines corrupt files and reads empty", () => {
    mkdirSync(dirname(pluginSecretsPath(baseDir, "demo")), { recursive: true });
    writeFileSync(pluginSecretsPath(baseDir, "demo"), "{nope");
    writeFileSync(join(baseDir, "demo", "plugin-settings.json"), "[bad");
    expect(readPluginSecrets(baseDir, "demo")).toEqual({});
    expect(readPluginSettings(baseDir, "demo")).toEqual({ settingsVersion: 1, values: {} });
  });

  it("writes files readable only by the owner", () => {
    writePluginSettings(baseDir, "demo", 1, { a: 1 });
    writePluginSecret(baseDir, "demo", "k", "v");
    if (process.platform === "win32") return;
    expect(statSync(join(baseDir, "demo", "plugin-settings.json")).mode & 0o777).toBe(0o600);
    expect(statSync(pluginSecretsPath(baseDir, "demo")).mode & 0o777).toBe(0o600);
  });

  it("keeps secrets outside the sandbox-readable plugin directory", () => {
    writePluginSecret(baseDir, "demo", "hookSecret", "s3cr3t");
    expect(pluginSecretsPath(baseDir, "demo").startsWith(join(baseDir, "demo") + "/")).toBe(false);
    // No secret material under the plugin dir the sandbox can read.
    expect(statSync(join(baseDir, "demo", "plugin-secrets.json"), { throwIfNoEntry: false })).toBe(undefined);
    expect(readPluginSecrets(baseDir, "demo")).toEqual({ hookSecret: "s3cr3t" });
  });

  it("migrates a legacy in-plugin secrets file to the host-only store", () => {
    writeFileSync(join(baseDir, "demo", "plugin-secrets.json"), JSON.stringify({ version: 1, values: { hookSecret: "s3cr3t" } }));
    expect(readPluginSecrets(baseDir, "demo")).toEqual({ hookSecret: "s3cr3t" });
    expect(pluginSecretsPath(baseDir, "demo")).not.toBe(join(baseDir, "demo", "plugin-secrets.json"));
    expect(statSync(join(baseDir, "demo", "plugin-secrets.json"), { throwIfNoEntry: false })).toBe(undefined);
  });

  it("deletePluginBrokerState clears everything", () => {
    writePluginSettings(baseDir, "demo", 1, { a: 1 });
    writePluginSecret(baseDir, "demo", "k", "v");
    deletePluginBrokerState(baseDir, "demo");
    expect(readPluginSettings(baseDir, "demo").values).toEqual({});
    expect(pluginSecretKeys(baseDir, "demo")).toEqual([]);
  });
});

describe("migratePluginSettings", () => {
  it("carries declared keys, applies new defaults, drops removed keys", () => {
    const specs = [
      { key: "keep", label: "Keep", type: "string" as const },
      { key: "fresh", label: "Fresh", type: "string" as const, default: "dflt" },
      { key: "rotated", label: "Rot", type: "secret" as const },
    ];
    const { values, added, dropped } = migratePluginSettings(specs, { keep: "v", gone: 1 });
    expect(values).toEqual({ keep: "v", fresh: "dflt" });
    expect(added).toEqual(["fresh"]);
    expect(dropped).toEqual(["gone"]);
  });
});
