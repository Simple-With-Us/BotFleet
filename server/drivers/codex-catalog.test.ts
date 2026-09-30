import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ModelCatalog } from "../contracts.ts";
import { CodexDriver } from "./codex.ts";
import {
  decodeCodexSelection,
  encodeCodexSelection,
  OFFICIAL_CODEX_PROVIDER,
  readCodexAppServerModelCatalog,
  readCodexModelCatalog,
  readCodexModelCatalogDetailed,
  readCodexModelsCache,
  STATIC_CODEX_MODELS,
  type CodexCatalogMemory,
  type CodexProbeFailure,
} from "./codex-catalog.ts";

const scratchDirs: string[] = [];
const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchHome(files: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), "omb-codex-catalog-"));
  scratchDirs.push(home);
  const root = join(home, ".codex");
  mkdirSync(root, { recursive: true });
  for (const [relative, body] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  }
  return home;
}

describe("decodeCodexSelection", () => {
  it("forces official rows onto the ChatGPT provider", () => {
    expect(decodeCodexSelection("gpt-6-sol")).toEqual({
      model: "gpt-6-sol",
      modelProvider: OFFICIAL_CODEX_PROVIDER,
    });
  });

  it("forces newly discovered bare ids onto the ChatGPT provider too", () => {
    expect(decodeCodexSelection("gpt-future-codex")).toEqual({
      model: "gpt-future-codex",
      modelProvider: OFFICIAL_CODEX_PROVIDER,
    });
  });

  it("splits provider-encoded custom ids", () => {
    expect(decodeCodexSelection("omlx::Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning")).toEqual({
      model: "Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning",
      modelProvider: "omlx",
    });
  });
});

describe("readCodexModelCatalog", () => {
  it("keeps the static fallback to the ids Codex reported as visible, each marked Unverified", () => {
    // Visible rows in Codex 0.154.0's own cache file on 2026-09-30, and in
    // the catalog `codex app-server` returns from an empty home.  No Codex
    // catalog offered gpt-6-sol, gpt-6-luna or gpt-5.3-codex-spark, so a turn
    // sent to one of them is rejected: they are not listed on a guess.
    expect(STATIC_CODEX_MODELS.default).toBe("gpt-5.6-luna");
    expect(STATIC_CODEX_MODELS.options.map((option) => option.id)).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
    expect(STATIC_CODEX_MODELS.options.some((option) => option.id === STATIC_CODEX_MODELS.default)).toBe(true);
    for (const option of STATIC_CODEX_MODELS.options) {
      expect(option).toMatchObject({
        effortLevels: ["low", "medium", "high", "xhigh"],
        supportsEffort: true,
        badge: "Unverified",
      });
      // the tooltip is sentence-spaced with a real no-break space, never the entity
      expect(option.badgeTitle).toMatch(/just now\.\u00A0 This row comes from BotFleet's built-in fallback/);
      expect(option.badgeTitle).not.toContain("&nbsp;");
      expect(option.badge!.length).toBeLessThanOrEqual(10);
    }
  });

  it("returns the static cloud fallback when there is no config or CLI probe", async () => {
    expect(await readCodexModelCatalog({ HOME: join(tmpdir(), "omb-codex-missing-home") })).toEqual(
      STATIC_CODEX_MODELS,
    );
  });

  it("uses the current OAuth fallback when the app-server probe fails", async () => {
    const home = scratchHome({});
    const missingCli = join(home, "missing-codex-cli");
    expect(await readCodexModelCatalog({ HOME: home }, fetch, missingCli)).toEqual(STATIC_CODEX_MODELS);
  });

  it("ends a stalled app-server model probe instead of inventing availability", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const home = scratchHome({});
    const dumpPath = join(home, "calls.json");
    const catalog = await readCodexAppServerModelCatalog(
      FAKE_CLI,
      { HOME: home, PATH: process.env.PATH, FAKE_CODEX_MODE: "models-hang", FAKE_CODEX_DUMP: dumpPath },
      2_000,
    );
    expect(catalog).toBeNull();
    const calls = JSON.parse(readFileSync(dumpPath, "utf8")).calls;
    expect(calls.map((call: { method: string }) => call.method)).toContain("model/list");
  });

  it("uses every visible page from the installed Codex app-server catalog", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const catalog = await readCodexModelCatalog(
      { HOME: join(tmpdir(), "omb-codex-app-server-models"), PATH: process.env.PATH },
      fetch,
      FAKE_CLI,
    );

    expect(catalog).toEqual({
      default: "gpt-fake-default",
      options: [
        { id: "gpt-fake-default", label: "GPT Fake Default" },
        { id: "gpt-page-two", label: "GPT Page Two", effortLevels: ["low", "high"], supportsEffort: true },
      ],
    });
  });

  it("appends the configured local model and cached catalog slugs as custom", async () => {
    const home = scratchHome({
      "config.toml": `
model_provider = "omlx"
model = "Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning"

[model_providers.omlx]
name = "oMLX"
base_url = "http://127.0.0.1:9/v1"
`,
      "omlx.config.toml": `
model_provider = "omlx"
model = "GLM-5.2-mxfp4"
`,
      "model-catalogs/omlx-models.json": JSON.stringify({
        models: [{ slug: "GLM-5.2-mxfp4", display_name: "GLM-5.2-mxfp4 (oMLX)" }],
      }),
    });

    const catalog = await readCodexModelCatalog({ HOME: home }, async () => {
      throw new Error("live probe should not be required");
    });

    expect(catalog.default).toBe(encodeCodexSelection("omlx", "Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning"));
    expect(catalog.options.slice(0, STATIC_CODEX_MODELS.options.length)).toEqual(STATIC_CODEX_MODELS.options);
    expect(catalog.options.filter((option) => option.custom).map((option) => option.id)).toEqual([
      encodeCodexSelection("omlx", "Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning"),
      encodeCodexSelection("omlx", "GLM-5.2-mxfp4"),
    ]);
    expect(catalog.options.find((option) => option.id.endsWith("GLM-5.2-mxfp4"))?.label).toBe("GLM-5.2-mxfp4 (oMLX)");
  });

  it("keeps an official-looking model slug bound to its configured local provider", async () => {
    const home = scratchHome({
      "config.toml": `
model_provider = "omlx"
model = "gpt-5.4"

[model_providers.omlx]
name = "oMLX"
`,
    });

    const catalog = await readCodexModelCatalog({ HOME: home });
    const local = encodeCodexSelection("omlx", "gpt-5.4");

    expect(catalog.default).toBe(local);
    expect(catalog.options).toContainEqual({
      id: local,
      label: "gpt-5.4 (oMLX)",
      custom: true,
    });
    expect(decodeCodexSelection(catalog.default)).toEqual({
      model: "gpt-5.4",
      modelProvider: "omlx",
    });
  });

  it.each(['model_provider = "openai"', ""])("preserves a retired official slug with provider config %j", async (provider) => {
    const home = scratchHome({
      "config.toml": `
${provider}
model = "gpt-5.4"
`,
    });

    const catalog = await readCodexModelCatalog({ HOME: home });
    const stored = encodeCodexSelection("openai", "gpt-5.4");

    expect(catalog.default).toBe(stored);
    expect(catalog.options).toContainEqual({
      id: stored,
      label: "gpt-5.4",
      custom: true,
    });
  });

  it.each(["gpt-5.4"])(
    "keeps saved legacy OAuth selection %s without making it a fallback recommendation",
    async (model) => {
      const home = scratchHome({ "config.toml": `model = "${model}"\n` });
      const catalog = await readCodexModelCatalog({ HOME: home });
      const saved = encodeCodexSelection("openai", model);
      expect(catalog.default).toBe(saved);
      expect(catalog.options).toContainEqual({ id: saved, label: model, custom: true });
      expect(STATIC_CODEX_MODELS.options.some((option) => option.id === model)).toBe(false);
      expect(decodeCodexSelection(saved)).toEqual({ model, modelProvider: "openai" });
    },
  );

  it("preserves profile models when the main provider defaults to OpenAI", async () => {
    const home = scratchHome({
      "config.toml": 'model = "gpt-5.6-sol"\n',
      "legacy.config.toml": 'model = "gpt-5.4"\n',
    });
    const catalog = await readCodexModelCatalog({ HOME: home });
    expect(catalog.default).toBe("gpt-5.6-sol");
    expect(catalog.options).toContainEqual({
      id: encodeCodexSelection("openai", "gpt-5.4"),
      label: "gpt-5.4",
      custom: true,
    });
  });

  it("honors CODEX_HOME over HOME and merges live /v1/models", async () => {
    const ignored = scratchHome({
      "config.toml": `model_provider = "omlx"\nmodel = "ignored"\n`,
    });
    const parent = mkdtempSync(join(tmpdir(), "omb-codex-home-"));
    scratchDirs.push(parent);
    const codexHome = join(parent, "codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      join(codexHome, "config.toml"),
      `
model_provider = "unsloth_api"
model = "unsloth/gemma-4-26B-A4B-it-GGUF"

[model_providers.unsloth_api]
name = "Unsloth Studio"
base_url = "http://127.0.0.1:8888/v1"
env_key = "UNSLOTH_STUDIO_AUTH_TOKEN"
`,
    );

    const catalog = await readCodexModelCatalog(
      { HOME: ignored, CODEX_HOME: codexHome, UNSLOTH_STUDIO_AUTH_TOKEN: "sk-test" },
      async (url, init) => {
        expect(String(url)).toBe("http://127.0.0.1:8888/v1/models");
        expect((init as RequestInit | undefined)?.headers).toMatchObject({ Authorization: "Bearer sk-test" });
        return new Response(JSON.stringify({ data: [{ id: "unsloth/extra-live" }, { id: "bad id" }] }), { status: 200 });
      },
    );

    expect(catalog.options.map((option) => option.id)).toContain(
      encodeCodexSelection("unsloth_api", "unsloth/gemma-4-26B-A4B-it-GGUF"),
    );
    expect(catalog.options.map((option) => option.id)).toContain(encodeCodexSelection("unsloth_api", "unsloth/extra-live"));
    expect(catalog.options.map((option) => option.id)).not.toContain(encodeCodexSelection("omlx", "ignored"));
  });

  it("ignores invalid slugs and a default that is not in the catalog", async () => {
    const home = scratchHome({
      "config.toml": `
model_provider = "nope!"
model = "not installed"

[model_providers.omlx]
name = "oMLX"
`,
    });
    const catalog = await readCodexModelCatalog({ HOME: home });
    // The static default is Luna (the owner-facing default most owners reach
    // for first), on the id Codex serves; Astra still appears as an option.
    expect(catalog.default).toBe("gpt-5.6-luna");
    expect(catalog.options.every((option) => !option.custom)).toBe(true);
  });
});

const VISIBLE_AND_HIDDEN_CACHE = JSON.stringify({
  fetched_at: "2026-09-30T05:10:22.599387Z",
  client_version: "0.154.0",
  models: [
    {
      slug: "gpt-6-astra",
      display_name: "GPT-6-Astra",
      visibility: "list",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast" },
        { effort: "high", description: "Deep" },
        { effort: "not-a-level", description: "ignored" },
      ],
    },
    { slug: "gpt-reserve", display_name: "Reserve", visibility: "hide" },
    { slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list" },
    { slug: "codex-auto-review", display_name: "Review", visibility: "hide" },
    { slug: "no visibility field", display_name: "Bad" },
    { slug: "gpt-5.6-luna", display_name: "Duplicate", visibility: "list" },
  ],
});

describe("readCodexModelsCache", () => {
  it("lists only visibility:list rows, with their labels and valid effort levels", () => {
    const home = scratchHome({ "models_cache.json": VISIBLE_AND_HIDDEN_CACHE });
    expect(readCodexModelsCache({ HOME: home })).toEqual({
      default: "gpt-6-astra",
      options: [
        { id: "gpt-6-astra", label: "GPT-6-Astra", effortLevels: ["low", "high"], supportsEffort: true },
        { id: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
      ],
    });
  });

  it("honors CODEX_HOME, and is null for a missing, corrupt, or all-hidden cache", () => {
    const home = scratchHome({ "models_cache.json": VISIBLE_AND_HIDDEN_CACHE });
    expect(
      readCodexModelsCache({ HOME: join(tmpdir(), "omb-codex-nowhere"), CODEX_HOME: join(home, ".codex") })?.options,
    ).toHaveLength(2);
    expect(readCodexModelsCache({ HOME: join(tmpdir(), "omb-codex-nowhere") })).toBeNull();
    expect(readCodexModelsCache({ HOME: scratchHome({ "models_cache.json": "{nope" }) })).toBeNull();
    expect(
      readCodexModelsCache({
        HOME: scratchHome({ "models_cache.json": JSON.stringify({ models: [{ slug: "x", visibility: "hide" }] }) }),
      }),
    ).toBeNull();
    expect(
      readCodexModelsCache({ HOME: scratchHome({ "models_cache.json": JSON.stringify({ models: "no" }) }) }),
    ).toBeNull();
  });
});

describe("readCodexModelCatalogDetailed: a failed probe never swaps a confirmed list for the static one", () => {
  const LIVE: ModelCatalog = {
    default: "gpt-fake-default",
    options: [
      { id: "gpt-fake-default", label: "GPT Fake Default" },
      { id: "gpt-page-two", label: "GPT Page Two", effortLevels: ["low", "high"], supportsEffort: true },
    ],
  };
  const liveEnv = (home: string, extra: Record<string, string> = {}) => ({
    HOME: home,
    PATH: process.env.PATH,
    ...extra,
  });
  // The fake app-server is a node process; on a loaded host it can need far
  // longer than the 8 s production budget to answer.
  const probeTimeoutMs = 120_000;

  it("serves the live catalog and remembers it", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const memory: CodexCatalogMemory = {};
    const result = await readCodexModelCatalogDetailed(liveEnv(scratchHome({})), fetch, FAKE_CLI, { memory, probeTimeoutMs });
    expect(result.source).toBe("live");
    expect(result.catalog).toEqual(LIVE);
    expect(memory.lastGood).toEqual(LIVE);
  });

  it("falls back to the last live answer when the probe then fails", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const home = scratchHome({});
    const down = join(home, "down");
    const memory: CodexCatalogMemory = {};
    const env = liveEnv(home, { FAKE_CODEX_DOWN_FILE: down });
    expect((await readCodexModelCatalogDetailed(env, fetch, FAKE_CLI, { memory, probeTimeoutMs })).source).toBe("live");

    writeFileSync(down, "");
    const failures: CodexProbeFailure[] = [];
    const result = await readCodexModelCatalogDetailed(env, fetch, FAKE_CLI, {
      memory,
      probeTimeoutMs,
      onProbeFailure: (reason) => failures.push(reason),
    });
    expect(result.source).toBe("last-good");
    expect(result.catalog).toEqual(LIVE);
    expect(result.catalog.options.some((option) => option.badge)).toBe(false);
    expect(failures).toHaveLength(1);
  });

  it("prefers the last live answer over the CLI's own cache, which only covers a cold start", async () => {
    const home = scratchHome({ "models_cache.json": VISIBLE_AND_HIDDEN_CACHE });
    const memory: CodexCatalogMemory = { lastGood: LIVE };
    const result = await readCodexModelCatalogDetailed({ HOME: home }, fetch, join(home, "missing-cli"), { memory });
    expect(result).toMatchObject({ source: "last-good", catalog: LIVE });
  });

  it("reads the CLI's own cache file on a cold start when the probe fails", async () => {
    const home = scratchHome({ "models_cache.json": VISIBLE_AND_HIDDEN_CACHE });
    const result = await readCodexModelCatalogDetailed({ HOME: home }, fetch, join(home, "missing-cli"), { memory: {} });
    expect(result.source).toBe("codex-cache");
    expect(result.catalog.options.map((option) => option.id)).toEqual(["gpt-6-astra", "gpt-5.6-luna"]);
    expect(result.catalog.options.some((option) => option.badge)).toBe(false);
    expect(result.catalog).not.toEqual(STATIC_CODEX_MODELS);
  });

  it("uses the Unverified static rows only when nothing else has answered", async () => {
    const home = scratchHome({});
    const result = await readCodexModelCatalogDetailed({ HOME: home }, fetch, join(home, "missing-cli"), { memory: {} });
    expect(result).toEqual({ source: "static", catalog: STATIC_CODEX_MODELS });
    expect(result.catalog.options.every((option) => option.badge === "Unverified")).toBe(true);
  });

  it("still merges the configured local models on top of a remembered list", async () => {
    const home = scratchHome({
      "config.toml": `
model_provider = "omlx"
model = "MiniMax-M3-4bit"

[model_providers.omlx]
name = "oMLX"
`,
    });
    const result = await readCodexModelCatalogDetailed({ HOME: home }, fetch, join(home, "missing-cli"), {
      memory: { lastGood: LIVE },
    });
    expect(result.source).toBe("last-good");
    expect(result.catalog.options.map((option) => option.id)).toEqual([
      "gpt-fake-default",
      "gpt-page-two",
      "omlx::MiniMax-M3-4bit",
    ]);
  });

  it("names why a probe failed instead of failing silently", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const home = scratchHome({});
    const reasons: CodexProbeFailure[] = [];
    const stalled = await readCodexAppServerModelCatalog(
      FAKE_CLI,
      { HOME: home, PATH: process.env.PATH, FAKE_CODEX_MODE: "models-hang" },
      4_000,
      (reason) => reasons.push(reason),
    );
    expect(stalled).toBeNull();
    expect(reasons).toEqual(["timeout"]);

    const exited: CodexProbeFailure[] = [];
    const down = join(home, "down");
    writeFileSync(down, "");
    expect(
      await readCodexAppServerModelCatalog(
        FAKE_CLI,
        { HOME: home, PATH: process.env.PATH, FAKE_CODEX_DOWN_FILE: down },
        60_000,
        (reason) => exited.push(reason),
      ),
    ).toBeNull();
    expect(exited).toHaveLength(1);
    expect(["closed", "write-failed", "spawn-error"]).toContain(exited[0]);
  });
});

describe("CodexDriver catalog", () => {
  beforeEach(() => {
    process.env.OMB_CODEX_CATALOG_PROBE_MS = "120000";
  });
  afterEach(() => {
    delete process.env.OMB_CODEX_CATALOG_PROBE_MS;
  });

  it("loads the config catalog when the instance is created", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const home = scratchHome({
      "config.toml": `
model_provider = "omlx"
model = "MiniMax-M3-4bit"

[model_providers.omlx]
name = "oMLX"
`,
    });
    const instance = await CodexDriver.create({
      instanceId: "codex-catalog",
      displayName: "Codex",
      environment: { HOME: home },
      enabled: true,
      config: { ...CodexDriver.defaultConfig(), cli: FAKE_CLI },
    });
    try {
      expect(instance.models.options.some((option) => option.id === "omlx::MiniMax-M3-4bit" && option.custom)).toBe(true);
      expect(instance.refreshModels).toEqual(expect.any(Function));
    } finally {
      await instance.dispose();
    }
  });

  it("keeps the confirmed catalog when a later probe fails, instead of swapping in the static rows", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const home = scratchHome({});
    const down = join(home, "down");
    const instance = await CodexDriver.create({
      instanceId: "codex-catalog-keep",
      displayName: "Codex",
      environment: { HOME: home, FAKE_CODEX_DOWN_FILE: down },
      enabled: true,
      config: { ...CodexDriver.defaultConfig(), cli: FAKE_CLI },
    });
    try {
      const live = instance.models.options.map((option) => option.id);
      expect(live).toEqual(["gpt-fake-default", "gpt-page-two"]);

      // Codex goes away the way it does under host load: the probe returns
      // nothing.  Before this, describe() replaced the list with the static
      // rows and persisted them.
      writeFileSync(down, "");
      await instance.refreshModels!();
      expect(instance.models.options.map((option) => option.id)).toEqual(live);
      expect(instance.models.options.some((option) => option.badge)).toBe(false);
    } finally {
      await instance.dispose();
    }
  });

  it("serves the CLI's own cache, not the static rows, when the very first probe fails", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const home = scratchHome({ "models_cache.json": VISIBLE_AND_HIDDEN_CACHE });
    const down = join(home, "down");
    writeFileSync(down, "");
    const instance = await CodexDriver.create({
      instanceId: "codex-catalog-cold",
      displayName: "Codex",
      environment: { HOME: home, FAKE_CODEX_DOWN_FILE: down },
      enabled: true,
      config: { ...CodexDriver.defaultConfig(), cli: FAKE_CLI },
    });
    try {
      expect(instance.models.options.map((option) => option.id)).toEqual(["gpt-6-astra", "gpt-5.6-luna"]);
    } finally {
      await instance.dispose();
    }
  });

  it("marks the static rows Unverified when nothing has ever answered", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const home = scratchHome({});
    const down = join(home, "down");
    writeFileSync(down, "");
    const instance = await CodexDriver.create({
      instanceId: "codex-catalog-static",
      displayName: "Codex",
      environment: { HOME: home, FAKE_CODEX_DOWN_FILE: down },
      enabled: true,
      config: { ...CodexDriver.defaultConfig(), cli: FAKE_CLI },
    });
    try {
      expect(instance.models.options.map((option) => option.id)).toEqual(
        STATIC_CODEX_MODELS.options.map((option) => option.id),
      );
      expect(instance.models.options.every((option) => option.badge === "Unverified")).toBe(true);
    } finally {
      await instance.dispose();
    }
  });
});
