import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  McodeAgentDriver,
  mcodeAuthenticated,
  mcodeDataDir,
  mcodeModelOptionValue,
  mcodePickerId,
  parseMcodeModelValue,
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
  it("offers exactly the ids a live session advertises", () => {
    // Every row here was read off a real mcode 0.5.5 session's advertised
    // model config option, folded through mcodePickerId.  A row the session
    // does not advertise fails the turn with an opaque "does not offer", so
    // the shipped list is the advertised set and not a hand-written guess.
    expect(STATIC_MCODE_MODELS.default).toBe("MiniMax-M3.1-Flash-Preview-thinking");
    expect(STATIC_MCODE_MODELS.options.map((o) => o.id)).toEqual([
      "MiniMax-M3.1-Flash-Preview-thinking",
      "MiniMax-M2.7-highspeed-thinking",
    ]);
  });

  it("resolves every shipped id against that same advertised set", () => {
    // The catalog and the selector must agree, or the picker offers rows that
    // cannot run.
    const advertised = [
      { id: "permissionMode", options: [] },
      {
        id: "model",
        options: [
          { value: "m:minimax:MiniMax-M3.1-Flash-Preview:v:", name: "M3.1-Flash-Preview" },
          { value: "m:minimax:MiniMax-M3.1-Flash-Preview:v:thinking", name: "flash · thinking" },
          { value: "m:minimax:MiniMax-M2.7-highspeed:v:thinking", name: "M2.7 highspeed" },
          ],
      },
    ];
    for (const option of STATIC_MCODE_MODELS.options) {
      expect(mcodeModelOptionValue(option.id, advertised)).toEqual(expect.any(String));
    }
  });
});

describe("readMcodeModelCatalog", () => {
  const writeConfig = (dir: string, body: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), body, "utf8");
  };
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "omb-mcode-catalog-"));
    scratchDirs.push(dataDir);
  });

  it("adopts the default the user's own config names, variant folded in", () => {
    // A current install's config names the provider-qualified model and the
    // mode; both fold into the picker id the same way mcodePickerId folds an
    // advertised value.
    writeConfig(
      dataDir,
      [
        "defaultModel: minimax/MiniMax-M3.1-Flash-Preview",
        "defaultModelVariant: thinking",
        "defaultModelContextWindow: 1000000",
      ].join("\n"),
    );
    const catalog = readMcodeModelCatalog({ MINIMAX_DATA_DIR: dataDir });
    expect(catalog.default).toBe("MiniMax-M3.1-Flash-Preview-thinking");
    expect(catalog.options.find((o) => o.id === catalog.default)?.contextWindow).toBe(1_000_000);
  });

  it("never adopts a default that is not on offer", () => {
    // Adopting it would send every turn to a row the picker never showed.
    writeConfig(dataDir, ["defaultModel: minimax/MiniMax-M9-Imaginary", "defaultModelVariant: thinking"].join("\n"));
    expect(readMcodeModelCatalog({ MINIMAX_DATA_DIR: dataDir }).default).toBe("MiniMax-M3.1-Flash-Preview-thinking");
  });

  it("keeps the shipped rows rather than appending unverified ids", () => {
    // A pre-session id cannot be verified: only a running session can say
    // whether it advertises a matching value.
    writeConfig(
      dataDir,
      ["provider:", "  minimax:", "    model_order:", "      - MiniMax-M4-Next"].join("\n"),
    );
    const catalog = readMcodeModelCatalog({ MINIMAX_DATA_DIR: dataDir });
    expect(catalog.options).toEqual(STATIC_MCODE_MODELS.options);
  });

  it("keeps the shipped catalog when there is no config at all", () => {
    const catalog = readMcodeModelCatalog({ MINIMAX_DATA_DIR: join(dataDir, "missing") });
    expect(catalog.default).toBe("MiniMax-M3.1-Flash-Preview-thinking");
    expect(catalog.options).toEqual(STATIC_MCODE_MODELS.options);
  });

  it("survives a config that is unparseable or the wrong shape", () => {
    writeConfig(dataDir, "defaultModel: [not, a, string]\n\tdefaultModelVariant: : :\n");
    const catalog = readMcodeModelCatalog({ MINIMAX_DATA_DIR: dataDir });
    expect(catalog.options).toEqual(STATIC_MCODE_MODELS.options);
    expect(catalog.default).toBe("MiniMax-M3.1-Flash-Preview-thinking");
  });
});

describe("parseMcodeModelValue — the advertised no-variant form", () => {
  it("parses the empty-variant `v:` the CLI actually advertises", () => {
    // mcode 0.5.5 advertises the plain (non-thinking) selection as
    // `m:minimax:MiniMax-M3:v:` — a bare `v:` with an EMPTY variant, not the
    // `u` suffix its own type suggests.  Rejecting that spelling made every
    // no-variant model unselectable, including plain MiniMax-M3.
    expect(parseMcodeModelValue("m:minimax:MiniMax-M3.1-Flash-Preview:v:")).toEqual({
      providerId: "minimax",
      modelId: "MiniMax-M3.1-Flash-Preview",
    });
  });

  it("folds an empty variant to the same picker id the `u` spelling gives", () => {
    const emptyVariant = parseMcodeModelValue("m:minimax:MiniMax-M3.1-Flash-Preview:v:");
    const uSuffix = parseMcodeModelValue("m:minimax:MiniMax-M3.1-Flash-Preview:u");
    expect(mcodePickerId(emptyVariant!)).toBe("MiniMax-M3.1-Flash-Preview");
    expect(mcodePickerId(uSuffix!)).toBe("MiniMax-M3.1-Flash-Preview");
  });

  it("still reads a real variant", () => {
    const parsed = parseMcodeModelValue("m:minimax:MiniMax-M3.1-Flash-Preview:v:thinking");
    expect(parsed?.variant).toBe("thinking");
    expect(mcodePickerId(parsed!)).toBe("MiniMax-M3.1-Flash-Preview-thinking");
  });

  it("decodes percent-encoded segments", () => {
    const parsed = parseMcodeModelValue("m:mini%20max:MiniMax%2DM3.1%2DFlash%2DPreview:v:high%20speed");
    expect(parsed).toEqual({ providerId: "mini max", modelId: "MiniMax-M3.1-Flash-Preview", variant: "high speed" });
  });

  it("still rejects a value that is not a model selection", () => {
    expect(parseMcodeModelValue("not-a-value")).toBeNull();
    expect(parseMcodeModelValue("m:minimax:MiniMax-M3.1-Flash-Preview:x:y:z")).toBeNull();
    expect(parseMcodeModelValue(undefined)).toBeNull();
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

describe("mcodeModelOptionValue", () => {
  const advertised = [
    {
      id: "model",
      options: [
        { value: "m:minimax:MiniMax-M3.1-Flash-Preview:u", name: "MiniMax-M3.1-Flash-Preview" },
        { value: "m:minimax:MiniMax-M2.7:v:highspeed", name: "MiniMax-M2.7 (highspeed)" },
      ],
    },
  ];

  it("matches a plain model id and returns the advertised value verbatim", () => {
    expect(mcodeModelOptionValue("MiniMax-M3.1-Flash-Preview", advertised)).toBe("m:minimax:MiniMax-M3.1-Flash-Preview:u");
  });

  it("matches the variant folded into the picker id", () => {
    expect(mcodeModelOptionValue("MiniMax-M2.7-highspeed", advertised)).toBe("m:minimax:MiniMax-M2.7:v:highspeed");
  });

  it("keeps the user's own BYOK provider id instead of constructing one", () => {
    const byok = [{ id: "model", options: [{ value: "m:my-openai:MiniMax-M3.1-Flash-Preview:u", name: "MiniMax-M3.1-Flash-Preview" }] }];
    expect(mcodeModelOptionValue("MiniMax-M3.1-Flash-Preview", byok)).toBe("m:my-openai:MiniMax-M3.1-Flash-Preview:u");
  });

  it("skips the switch when the session advertises no model option (older mcode)", () => {
    expect(mcodeModelOptionValue("MiniMax-M3.1-Flash-Preview", [])).toBeNull();
    expect(mcodeModelOptionValue("MiniMax-M3.1-Flash-Preview", undefined)).toBeNull();
    expect(mcodeModelOptionValue("MiniMax-M3.1-Flash-Preview", [{ id: "mode", options: [] }])).toBeNull();
  });

  it("fails clearly when the model is not in the advertised options", () => {
    expect(() => mcodeModelOptionValue("MiniMax-M9", advertised)).toThrow(/does not offer MiniMax-M9/);
    expect(() => mcodeModelOptionValue("MiniMax-M9", advertised)).toThrow(/MiniMax-M2\.7 \(highspeed\)/);
  });
});

describe("parseMcodeModelValue / mcodePickerId", () => {
  it("decodes a wire value back to the picker id, URI-decoded", () => {
    const parsed = parseMcodeModelValue("m:minimax:MiniMax-M2.7:v:highspeed");
    expect(parsed).toEqual({ providerId: "minimax", modelId: "MiniMax-M2.7", variant: "highspeed" });
    expect(mcodePickerId(parsed!)).toBe("MiniMax-M2.7-highspeed");
    expect(mcodePickerId(parseMcodeModelValue("m:minimax:MiniMax-M3.1-Flash-Preview:u")!)).toBe("MiniMax-M3.1-Flash-Preview");
    expect(parseMcodeModelValue("m:p:Some%20Model:u")).toEqual({ providerId: "p", modelId: "Some Model" });
  });

  it("rejects values that are not mcode-shaped", () => {
    expect(parseMcodeModelValue("m-two")).toBeNull();
    expect(parseMcodeModelValue("m:minimax:MiniMax-M3.1-Flash-Preview:x")).toBeNull();
    expect(parseMcodeModelValue(42)).toBeNull();
  });
});
