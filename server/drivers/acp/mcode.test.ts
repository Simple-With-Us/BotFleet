import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  McodeAgentDriver,
  mcodeAuthenticated,
  mcodeDataDir,
  readMcodeModelCatalog,
  STATIC_MCODE_MODELS,
} from "./mcode.ts";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchHome(withConfig: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-mcode-"));
  scratchDirs.push(dir);
  if (withConfig) {
    mkdirSync(join(dir, ".minimax"), { recursive: true });
    writeFileSync(join(dir, ".minimax", "config.yaml"), "active_profile: default\n");
  }
  return dir;
}

describe("STATIC_MCODE_MODELS", () => {
  it("keeps a preview tier reachable without making it the shipped default", () => {
    expect(STATIC_MCODE_MODELS.default).toBe("MiniMax-M3");
    expect(STATIC_MCODE_MODELS.options.map((o) => o.id)).toEqual([
      "MiniMax-M3",
      "MiniMax-M3.1-Flash-Preview",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M2.7",
    ]);
  });
});

describe("readMcodeModelCatalog", () => {
  const write = (dir: string, body: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), body, "utf8");
  };
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcode-catalog-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lands on the model the user's own config defaults to", () => {
    // The whole point: a current install defaults to the flash preview tier,
    // and a frozen static list made it unreachable in the picker.
    write(
      dir,
      [
        "defaultModel: minimax/MiniMax-M3.1-Flash-Preview",
        "defaultModelContextWindow: 1000000",
        "provider:",
        "  minimax:",
        "    model_order:",
        "      - minimax/MiniMax-M3.1-Flash-Preview",
        "      - minimax/MiniMax-M3",
        "      - minimax/MiniMax-M2.7-highspeed",
        "      - minimax/MiniMax-M2.7",
      ].join("\n"),
    );
    const catalog = readMcodeModelCatalog({ MINIMAX_DATA_DIR: dir });
    expect(catalog.default).toBe("MiniMax-M3.1-Flash-Preview");
    expect(catalog.options.map((o) => o.id)).toContain("MiniMax-M2.7");
    // The configured window fills a gap; it never overwrites a declared one.
    expect(catalog.options.find((o) => o.id === "MiniMax-M3.1-Flash-Preview")?.contextWindow).toBe(1_000_000);
  });

  it("unions rather than replaces, so a thin config cannot blank the picker", () => {
    write(dir, ["defaultModel: MiniMax-M3", "provider:", "  minimax:", "    model_order:", "      - MiniMax-M3"].join("\n"));
    const catalog = readMcodeModelCatalog({ MINIMAX_DATA_DIR: dir });
    // The config names one model; the shipped rows are still all there.
    expect(catalog.options.map((o) => o.id)).toEqual(STATIC_MCODE_MODELS.options.map((o) => o.id));
    expect(catalog.default).toBe("MiniMax-M3");
  });

  it("keeps the static catalog when there is no config at all", () => {
    const catalog = readMcodeModelCatalog({ MINIMAX_DATA_DIR: join(dir, "missing") });
    expect(catalog.default).toBe("MiniMax-M3");
    expect(catalog.options).toEqual(STATIC_MCODE_MODELS.options);
  });

  it("survives a config that is unparseable or the wrong shape", () => {
    write(dir, "defaultModel: [not, a, string]\n\tbad: : :\n");
    const catalog = readMcodeModelCatalog({ MINIMAX_DATA_DIR: dir });
    expect(catalog.options).toEqual(STATIC_MCODE_MODELS.options);
    expect(catalog.default).toBe("MiniMax-M3");
  });

  it("never defaults to a model the config did not actually offer", () => {
    write(dir, ["defaultModel: minimax/MiniMax-M9-Imaginary", "provider:", "  minimax:", "    model_order:", "      - MiniMax-M3"].join("\n"));
    const catalog = readMcodeModelCatalog({ MINIMAX_DATA_DIR: dir });
    // A default that is not on offer would send every turn to a model the
    // picker never offered, so it falls back to the shipped default.
    expect(catalog.default).toBe("MiniMax-M3");
  });
});

describe("mcodeDataDir", () => {
  it("prefers MINIMAX_DATA_DIR over everything", () => {
    expect(mcodeDataDir({ MINIMAX_DATA_DIR: "/data/a", MAVIS_DATA_DIR: "/data/b", HOME: "/home/u" })).toBe("/data/a");
  });

  it("falls back to MAVIS_DATA_DIR when MINIMAX_DATA_DIR is empty", () => {
    expect(mcodeDataDir({ MINIMAX_DATA_DIR: "  ", MAVIS_DATA_DIR: "/data/b", HOME: "/home/u" })).toBe("/data/b");
  });

  it("defaults to ~/.minimax", () => {
    expect(mcodeDataDir({ HOME: "/home/u" })).toBe(join("/home/u", ".minimax"));
  });
});

describe("mcodeAuthenticated", () => {
  it("accepts the BYOK provider key from the environment", () => {
    expect(mcodeAuthenticated({ MCODE_PROVIDER_API_KEY: "sk-test" })).toBe(true);
  });

  it("ignores a blank BYOK key", () => {
    const home = scratchHome(false);
    expect(mcodeAuthenticated({ MCODE_PROVIDER_API_KEY: "  ", HOME: home })).toBe(false);
  });

  it("accepts config.yaml in the data dir as configured", () => {
    const home = scratchHome(true);
    expect(mcodeAuthenticated({ HOME: home })).toBe(true);
  });

  it("rejects a home with no mcode state", () => {
    const home = scratchHome(false);
    expect(mcodeAuthenticated({ HOME: home })).toBe(false);
  });

  it("honours MINIMAX_DATA_DIR for the config lookup", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-mcode-data-"));
    scratchDirs.push(dataDir);
    writeFileSync(join(dataDir, "config.yaml"), "active_profile: default\n");
    expect(mcodeAuthenticated({ MINIMAX_DATA_DIR: dataDir, HOME: scratchHome(false) })).toBe(true);
  });
});

describe("McodeAgentDriver", () => {
  it("registers as a subscription MiniMax Code engine", () => {
    expect(McodeAgentDriver.metadata.displayName).toBe("MiniMax Code");
    expect(McodeAgentDriver.metadata.access).toBe("subscription");
  });

  it("exposes the static model catalog", () => {
    expect(McodeAgentDriver.models).toEqual(STATIC_MCODE_MODELS);
  });

  it("advertises install and sign-in commands", () => {
    expect(McodeAgentDriver.install?.docsUrl).toBe("https://github.com/minimax-ai/minimax-code");
    expect(McodeAgentDriver.install?.signInCommand).toBe("mcode login --region global");
    expect(McodeAgentDriver.install?.command?.darwin).toContain("filecdn.minimax.chat");
  });
});
