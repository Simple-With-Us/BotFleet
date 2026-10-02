// What loadConfig() does with a config.json it cannot fully use.  It used to
// swallow every error as "first run", so one bad field dropped every setting
// in the file and nothing said so (audit C3).  Now: silent only when the file
// is missing, one warning naming the file and the failing path otherwise,
// repeated only when the problem changes, and every section that still
// validates is kept.
//
// The warning idea (silent only on ENOENT, repeat only on change) follows
// upstream OpenMausBot PR #1840; the salvage and the notice are BotFleet's.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { DATA_DIR, loadConfig, saveConfig } from "./config.ts";
import { listDataFaults, resetDataFaults } from "./data-faults.ts";

const path = join(DATA_DIR, "config.json");

describe("loadConfig with a config.json it cannot fully use", () => {
  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    mkdirSync(DATA_DIR, { recursive: true });
    rmSync(path, { force: true });
    resetDataFaults();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadConfig(); // a clean read resets the once-per-problem memory
    warn.mockClear();
  });
  afterEach(() => {
    warn.mockRestore();
    rmSync(path, { force: true });
    resetDataFaults();
  });

  const warned = (): string[] => warn.mock.calls.map((call) => String(call[0]));

  it("stays quiet on a first run with no file", () => {
    expect(loadConfig().profile).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(listDataFaults()).toEqual([]);
  });

  it("stays quiet on a healthy file, including keys this build does not know", () => {
    writeFileSync(path, JSON.stringify({ profile: { name: "Ada" }, aSectionFromANewerBuild: { on: true } }));
    expect(loadConfig().profile?.name).toBe("Ada");
    expect(warn).not.toHaveBeenCalled();
    expect(listDataFaults()).toEqual([]);
  });

  it("keeps every section that validates when one section does not, and says which one", () => {
    writeFileSync(
      path,
      JSON.stringify({
        profile: { name: "Ada" },
        tts: { provider: "system" },
        autoUpdate: { enabled: "yes" },
        callStt: { provider: "carrier-pigeon" },
      }),
    );
    const cfg = loadConfig();
    expect(cfg.profile?.name).toBe("Ada");
    expect(cfg.tts?.provider).toBe("system");
    expect(cfg.autoUpdate).toBeUndefined();
    expect(cfg.callStt).toBeUndefined();

    const lines = warned();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(path);
    expect(lines[0]).toContain("autoUpdate.enabled");
    expect(lines[0]).toContain("callStt.provider");
    expect(lines[0]).not.toContain("profile");

    expect(listDataFaults()).toEqual([
      expect.objectContaining({
        file: "config.json",
        kind: "config-partial",
        sections: ["autoUpdate", "callStt"],
        writesRefused: false,
        holdsCleanup: false,
      }),
    ]);
  });

  it("keeps the valid engine entries when one entry under instances is bad", () => {
    writeFileSync(
      path,
      JSON.stringify({
        instances: {
          claude: { driver: "claudeAgent", displayName: "Claude (work)" },
          broken: { driver: 7 },
        },
        profile: { name: "Ada" },
      }),
    );
    const cfg = loadConfig();
    expect(cfg.instances?.claude).toMatchObject({ driver: "claudeAgent", displayName: "Claude (work)" });
    expect(cfg.instances?.broken).toBeUndefined();
    expect(cfg.profile?.name).toBe("Ada");
    expect(warned()).toHaveLength(1);
    expect(warned()[0]).toContain("instances.broken.driver");
    expect(listDataFaults()[0]?.sections).toEqual(["instances.broken"]);
  });

  it("still migrates the retired ElevenLabs voice provider while salvaging around a bad section", () => {
    writeFileSync(path, JSON.stringify({ tts: { provider: "elevenlabs" }, autoUpdate: { enabled: 3 } }));
    expect(loadConfig().tts?.provider).toBe("minimax");
    expect(warned()[0]).toContain("autoUpdate.enabled");
  });

  it("warns once while the same problem persists across many loads", () => {
    writeFileSync(path, JSON.stringify({ autoUpdate: { enabled: "yes" } }));
    for (let i = 0; i < 5; i += 1) loadConfig();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns again when the problem changes, and again after a repair breaks anew", () => {
    writeFileSync(path, JSON.stringify({ autoUpdate: { enabled: "yes" } }));
    loadConfig();
    writeFileSync(path, JSON.stringify({ callStt: { provider: "carrier-pigeon" } }));
    loadConfig();
    expect(warn).toHaveBeenCalledTimes(2);

    writeFileSync(path, "{}");
    loadConfig();
    expect(listDataFaults()).toEqual([]);
    warn.mockClear();
    writeFileSync(path, JSON.stringify({ callStt: { provider: "carrier-pigeon" } }));
    loadConfig();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("treats truncated JSON as unusable, falls back to defaults, and warns once", () => {
    writeFileSync(path, '{"profile":{"name":"Ada"},"xai":{"key":"sk-fixture-secret-value');
    const cfg = loadConfig();
    loadConfig();
    expect(cfg.profile).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warned()[0]).toContain(path);
    expect(warned()[0]).toContain("cut short");
    expect(warned()[0]).not.toContain("sk-fixture-secret-value");
    expect(listDataFaults()).toEqual([expect.objectContaining({ file: "config.json", kind: "config-ignored" })]);
  });

  it("never logs a fragment of the file from a JSON parser error", () => {
    writeFileSync(path, "sk-fixture-secret-value");
    loadConfig();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warned()[0]).toContain("not valid JSON");
    expect(warned()[0]).not.toContain("sk-fixture");
    expect(JSON.stringify(listDataFaults())).not.toContain("sk-fixture");
  });

  it("never logs a value from a failing field", () => {
    writeFileSync(path, JSON.stringify({ xai: { key: ["sk-fixture-secret-value"] }, profile: { name: "Ada" } }));
    const cfg = loadConfig();
    expect(cfg.profile?.name).toBe("Ada");
    expect(warned()[0]).toContain("xai.key");
    expect(warned()[0]).not.toContain("sk-fixture");
    expect(JSON.stringify(listDataFaults())).not.toContain("sk-fixture");
  });

  it("treats an empty file as unusable rather than as a first run", () => {
    writeFileSync(path, "");
    expect(loadConfig().profile).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warned()[0]).toContain("empty");
    expect(listDataFaults()[0]?.kind).toBe("config-ignored");
  });

  it("treats a JSON value that is not an object as unusable", () => {
    for (const body of ["[1,2,3]", '"just text"', "null", "42"]) {
      writeFileSync(path, body);
      loadConfig();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warned()[0]).toContain("JSON object");
      expect(listDataFaults()[0]?.kind).toBe("config-ignored");
      warn.mockClear();
      writeFileSync(path, "{}");
      loadConfig();
      warn.mockClear();
    }
  });

  it("reads a file that starts with a byte-order mark as the healthy file it is", () => {
    writeFileSync(path, `﻿${JSON.stringify({ profile: { name: "Ada" } })}`);
    expect(loadConfig().profile?.name).toBe("Ada");
    expect(warn).not.toHaveBeenCalled();
    expect(listDataFaults()).toEqual([]);
  });

  it("clears the notice once the file is fixed", () => {
    writeFileSync(path, JSON.stringify({ autoUpdate: { enabled: "yes" } }));
    loadConfig();
    expect(listDataFaults()).toHaveLength(1);
    writeFileSync(path, JSON.stringify({ autoUpdate: { enabled: true } }));
    expect(loadConfig().autoUpdate?.enabled).toBe(true);
    expect(listDataFaults()).toEqual([]);
  });

  it("never rewrites or renames config.json while loading it", () => {
    const body = JSON.stringify({ autoUpdate: { enabled: "yes" }, profile: { name: "Ada" } });
    writeFileSync(path, body);
    loadConfig();
    loadConfig();
    expect(readFileSync(path, "utf8")).toBe(body);
  });
});

describe("saveConfig over a config.json it cannot use", () => {
  let warn: MockInstance<typeof console.warn>;
  let error: MockInstance<typeof console.error>;

  beforeEach(() => {
    mkdirSync(DATA_DIR, { recursive: true });
    for (const name of readdirSync(DATA_DIR)) if (name.startsWith("config.json")) rmSync(join(DATA_DIR, name), { force: true });
    resetDataFaults();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
    loadConfig();
  });
  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
    for (const name of readdirSync(DATA_DIR)) if (name.startsWith("config.json")) rmSync(join(DATA_DIR, name), { force: true });
    resetDataFaults();
  });

  const setAside = (): string[] => readdirSync(DATA_DIR).filter((name) => name.startsWith("config.json.corrupt-"));

  it("sets unparseable JSON aside instead of replacing it, and says so", () => {
    const broken = '{"profile":{"name":"Ada"},"tts":{"provider":"system"';
    writeFileSync(path, broken);
    loadConfig();
    expect(listDataFaults()[0]?.kind).toBe("config-ignored");

    saveConfig({ profile: { name: "Grace" } });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ profile: { name: "Grace" } });
    const [name] = setAside();
    expect(setAside()).toHaveLength(1);
    expect(readFileSync(join(DATA_DIR, name!), "utf8")).toBe(broken);

    expect(listDataFaults()).toEqual([
      expect.objectContaining({ file: "config.json", kind: "set-aside", setAsideAs: name }),
    ]);
    // The clean read that follows must not wipe the record of what happened.
    loadConfig();
    expect(listDataFaults()).toHaveLength(1);
    expect(error.mock.calls.map((call) => String(call[0])).join("\n")).toContain(name!);
  });

  it("keeps a schema-invalid file in place and merges the save into it", () => {
    writeFileSync(path, JSON.stringify({ autoUpdate: { enabled: "yes" }, profile: { name: "Ada" } }));
    saveConfig({ profile: { name: "Grace" } });
    expect(setAside()).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      autoUpdate: { enabled: "yes" },
      profile: { name: "Grace" },
    });
  });

  it("keeps every key when the file starts with a byte-order mark", () => {
    writeFileSync(path, `\uFEFF${JSON.stringify({ profile: { name: "Ada" }, tts: { provider: "system" } })}`);
    saveConfig({ profile: { name: "Grace" } });
    expect(setAside()).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      profile: { name: "Grace" },
      tts: { provider: "system" },
    });
  });
});
