import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { classifyError } from "../retry.ts";
import { GrokAgentDriver, grokRejectedModelMessage, readGrokModelCatalog, STATIC_GROK_MODELS } from "./grok.ts";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchConfig(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-grok-catalog-"));
  scratchDirs.push(dir);
  mkdirSync(join(dir, ".grok"), { recursive: true });
  writeFileSync(join(dir, ".grok", "config.toml"), toml);
  return dir;
}

/** The chip and hover text both account-gated rows carry (see grok.ts). */
const GATED = {
  badge: "If offered",
  badgeTitle:
    'The Grok Build CLI only offers this model on accounts that have it.  Run "grok models" in a terminal to see what this account can use.',
};
const BUILD_FAST = {
  id: "grok-4.7-build-fast",
  label: "Grok 4.7 Build Fast",
  badge: "2× $",
  badgeTitle: "Same Grok 4.7 model on high-performance infrastructure — 2× the output speed at 2× the per-token price.",
};
const COMPOSER = { id: "composer-2.5", label: "Composer 2.5", ...GATED };
const GROK_BUILD = { id: "grok-build-0.1", label: "Grok Build 0.1", ...GATED };

describe("readGrokModelCatalog", () => {
  it("uses the current Grok Build lineup with 4.7 as the default", () => {
    expect(STATIC_GROK_MODELS).toEqual({
      default: "grok-4.7",
      options: [
        { id: "grok-4.7", label: "Grok 4.7" },
        BUILD_FAST,
        COMPOSER,
        GROK_BUILD,
        { id: "grok-4.6", label: "Grok 4.6" },
        { id: "grok-4.5", label: "Grok 4.5" },
      ],
    });
  });

  it("lists Composer 2.5 and Grok Build 0.1, flagged as account-dependent, with 4.7 still the default", () => {
    const ids = STATIC_GROK_MODELS.options.map((o) => o.id);
    expect(ids.indexOf("composer-2.5")).toBe(ids.indexOf("grok-4.7-build-fast") + 1);
    expect(ids.indexOf("grok-build-0.1")).toBe(ids.indexOf("composer-2.5") + 1);
    expect(ids.indexOf("grok-build-0.1")).toBeLessThan(ids.indexOf("grok-4.6"));
    // xAI has not documented composer-2.5-fast, so it is not offered.
    expect(ids).not.toContain("composer-2.5-fast");
    expect(STATIC_GROK_MODELS.default).toBe("grok-4.7");
    for (const id of ["composer-2.5", "grok-build-0.1"]) {
      const row = STATIC_GROK_MODELS.options.find((o) => o.id === id)!;
      // ModelPicker renders badgeTitle only inside the badge chip, so the
      // honest hover text needs a chip, and the chip must stay short.
      expect(row.badge!.length).toBeLessThanOrEqual(10);
      expect(row.badgeTitle).toContain("grok models");
      // A per-model effortLevels would switch effort off for the other rows.
      expect(row.effortLevels).toBeUndefined();
    }
  });

  it("keeps the new rows ahead of local slugs and does not duplicate or relabel them from config.toml", () => {
    const home = scratchConfig(`
[model.composer-2.5]
name = "Composer from config"

[model."grok-build-0.1"]
name = "Build from config"

[model.local-glm]
name = "GLM local"
`);
    const catalog = readGrokModelCatalog({ HOME: home });
    expect(catalog.options).toEqual([
      { id: "grok-4.7", label: "Grok 4.7" },
      BUILD_FAST,
      COMPOSER,
      GROK_BUILD,
      { id: "grok-4.6", label: "Grok 4.6" },
      { id: "grok-4.5", label: "Grok 4.5" },
      { id: "local-glm", label: "GLM local", custom: true },
    ]);
    expect(catalog.options.filter((o) => o.id === "composer-2.5")).toHaveLength(1);
  });

  it("returns the static cloud pair when there is no config", () => {
    expect(readGrokModelCatalog({ HOME: join(tmpdir(), "omb-grok-missing-home") })).toEqual(STATIC_GROK_MODELS);
  });

  it("appends local slugs from config.toml and prefers their display names", () => {
    const home = scratchConfig(`
[models]
default = "ollama-ornith-35b-bf16"

[model."grok-4.6"]
name = "should not replace the cloud label"

[model."ollama-ornith-35b-bf16"]
model = "ornith:35b-bf16"
name = "ornith:35b-bf16 (Ollama)"
api_key = "must-not-leak"

[model.omlx-minimax-m3]
name = "MiniMax M3 4bit (oMLX)"
`);

    expect(readGrokModelCatalog({ HOME: home })).toEqual({
      default: "ollama-ornith-35b-bf16",
      options: [
        { id: "grok-4.7", label: "Grok 4.7" },
        BUILD_FAST,
        COMPOSER,
        GROK_BUILD,
        { id: "grok-4.6", label: "Grok 4.6" },
        { id: "grok-4.5", label: "Grok 4.5" },
        { id: "ollama-ornith-35b-bf16", label: "ornith:35b-bf16 (Ollama)", custom: true },
        { id: "omlx-minimax-m3", label: "MiniMax M3 4bit (oMLX)", custom: true },
      ],
    });
  });

  it("ignores invalid slugs and a default that is not in the catalog", () => {
    const home = scratchConfig(`
[models]
default = "not-installed"

[model."bad slug"]
name = "nope"

[model.ok-model]
name = "OK"
`);
    const catalog = readGrokModelCatalog({ HOME: home });
    expect(catalog.default).toBe("grok-4.7");
    expect(catalog.options.map((o) => o.id)).toEqual([
      "grok-4.7",
      "grok-4.7-build-fast",
      "composer-2.5",
      "grok-build-0.1",
      "grok-4.6",
      "grok-4.5",
      "ok-model",
    ]);
  });

  it.each(["grok-4.6", "grok-4.5"])("preserves an explicitly configured legacy default %s", (model) => {
    const home = scratchConfig(`[models]\ndefault = "${model}"\n`);
    expect(readGrokModelCatalog({ HOME: home }).default).toBe(model);
  });

  it("honors GROK_HOME over HOME", () => {
    const ignored = scratchConfig(`[model.ignored]\nname = "Ignored"\n`);
    const grokHomeParent = mkdtempSync(join(tmpdir(), "omb-grok-home-"));
    const grokHome = join(grokHomeParent, "grok");
    scratchDirs.push(grokHomeParent);
    mkdirSync(grokHome, { recursive: true });
    writeFileSync(join(grokHome, "config.toml"), `[model.from-grok-home]\nname = "From GROK_HOME"\n`);
    const catalog = readGrokModelCatalog({ HOME: ignored, GROK_HOME: grokHome });
    expect(catalog.options.map((o) => o.id)).toContain("from-grok-home");
    expect(catalog.options.map((o) => o.id)).not.toContain("ignored");
  });

  it("ignores default keys outside the [models] table", () => {
    const home = scratchConfig(`
[cli]
default = "grok-4.5"

[model.ok-model]
name = "OK"
`);
    expect(readGrokModelCatalog({ HOME: home }).default).toBe("grok-4.7");
  });
});

describe("GrokAgentDriver catalog", () => {
  it("loads the config catalog when the instance is created", async () => {
    const home = scratchConfig(`[model.local-glm]\nname = "GLM local"\n`);
    const instance = await GrokAgentDriver.create({
      instanceId: "grok-catalog",
      displayName: "Grok",
      environment: { HOME: home },
      enabled: true,
      config: GrokAgentDriver.defaultConfig(),
    });
    try {
      expect(instance.models.options.some((o) => o.id === "local-glm" && o.label === "GLM local")).toBe(true);
      expect(instance.refreshModels).toEqual(expect.any(Function));
    } finally {
      await instance.dispose();
    }
  });
});

describe("grokRejectedModelMessage", () => {
  const OFFERED = [
    { modelId: "grok-4.7", name: "Grok 4.7" },
    { modelId: "grok-4.7-build-fast", name: "Grok 4.7 Fast" },
    { modelId: "grok-4.6", name: "Grok 4.6" },
    { modelId: "grok-4.5", name: "Grok 4.5" },
  ];
  const CLI_WORDING = "Invalid params: unknown model id";

  it("keeps the CLI's own wording, names what the account is offered, and points at grok models", () => {
    const message = grokRejectedModelMessage("composer-2.5", CLI_WORDING, OFFERED);
    expect(message).toContain('Grok rejected model "composer-2.5" via session/set_model: Invalid params: unknown model id.');
    expect(message).toContain("This account's Grok CLI offers: grok-4.7, grok-4.7-build-fast, grok-4.6, grok-4.5.");
    expect(message).toContain("Run `grok models` in a terminal to see everything this account can use.");
    expect(message).toContain("~/.grok/config.toml");
    expect(message).toContain("`grok update`");
    // The stale hint is gone: it blamed an old CLI for an id the account is not served.
    expect(message).not.toContain("1.0.6");
  });

  it("still reads as a terminal unknown_model failure, not an auth or quota one", () => {
    const withList = classifyError(new Error(grokRejectedModelMessage("grok-build-0.1", CLI_WORDING, OFFERED)));
    expect(withList).toEqual({ transient: false, reason: "unknown_model" });
    const noList = classifyError(new Error(grokRejectedModelMessage("grok-build-0.1", CLI_WORDING, [])));
    expect(noList).toEqual({ transient: false, reason: "unknown_model" });
  });

  it("omits the offered clause when the session advertised no models", () => {
    const message = grokRejectedModelMessage("composer-2.5", CLI_WORDING, []);
    expect(message).not.toContain("offers:");
    expect(message).toContain("`grok models`");
    expect(grokRejectedModelMessage("composer-2.5", CLI_WORDING)).toBe(message);
  });

  it("lists each offered id once, drops unusable ids, and caps the list", () => {
    const junk = [
      { modelId: "grok-4.7" },
      { modelId: " grok-4.7 " },
      { modelId: "" },
      { name: "no id" },
      { modelId: "bad slug with spaces" },
      { modelId: "x".repeat(200) },
      ...Array.from({ length: 20 }, (_, i) => ({ modelId: `m-${i}` })),
    ];
    const message = grokRejectedModelMessage("composer-2.5", CLI_WORDING, junk);
    const list = message.split("offers: ")[1]!.split(".  Run")[0]!;
    const ids = list.split(", ");
    expect(ids[0]).toBe("grok-4.7");
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(12);
    expect(message).not.toContain("bad slug");
    expect(message).not.toContain("xxxx");
  });
});
