import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { CodexDriver } from "./codex.ts";
import {
  decodeCodexSelection,
  encodeCodexSelection,
  OFFICIAL_CODEX_PROVIDER,
  readCodexAppServerModelCatalog,
  readCodexModelCatalog,
  STATIC_CODEX_MODELS,
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
  it("keeps the static fallback aligned with the current visible Codex rows", () => {
    expect(STATIC_CODEX_MODELS).toEqual({
      default: "gpt-6-luna",
      options: [
        { id: "gpt-6-astra", label: "GPT-6 Astra", effortLevels: ["low", "medium", "high", "xhigh"], supportsEffort: true },
        { id: "gpt-6-sol", label: "GPT-6 Sol", effortLevels: ["low", "medium", "high", "xhigh"], supportsEffort: true },
        { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", effortLevels: ["low", "medium", "high", "xhigh"], supportsEffort: true },
        { id: "gpt-6-luna", label: "GPT-6 Luna", effortLevels: ["low", "medium", "high", "xhigh"], supportsEffort: true },
        { id: "gpt-5.5", label: "GPT-5.5", effortLevels: ["low", "medium", "high", "xhigh"], supportsEffort: true },
        { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark", effortLevels: ["low", "medium", "high", "xhigh"], supportsEffort: true },
      ],
    });
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
      "config.toml": 'model = "gpt-6-sol"\n',
      "legacy.config.toml": 'model = "gpt-5.4"\n',
    });
    const catalog = await readCodexModelCatalog({ HOME: home });
    expect(catalog.default).toBe("gpt-6-sol");
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
    // Default is GPT-6 Luna (the owner-facing default most owners reach
    // for first); Astra still appears as a selectable option.
    expect(catalog.default).toBe("gpt-6-luna");
    expect(catalog.options.every((option) => !option.custom)).toBe(true);
  });
});

describe("CodexDriver catalog", () => {
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
});
