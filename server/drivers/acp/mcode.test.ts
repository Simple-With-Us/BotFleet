import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  McodeAgentDriver,
  mcodeAuthenticated,
  mcodeDataDir,
  mcodeModelOptionValue,
  mcodePickerId,
  parseMcodeModelValue,
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
  it("defaults to MiniMax-M3 with the M2.7 speed tier alongside", () => {
    expect(STATIC_MCODE_MODELS).toEqual({
      default: "MiniMax-M3",
      options: [
        { id: "MiniMax-M3", label: "MiniMax M3" },
        { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed" },
      ],
    });
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
        { value: "m:minimax:MiniMax-M3:u", name: "MiniMax-M3" },
        { value: "m:minimax:MiniMax-M2.7:v:highspeed", name: "MiniMax-M2.7 (highspeed)" },
      ],
    },
  ];

  it("matches a plain model id and returns the advertised value verbatim", () => {
    expect(mcodeModelOptionValue("MiniMax-M3", advertised)).toBe("m:minimax:MiniMax-M3:u");
  });

  it("matches the variant folded into the picker id", () => {
    expect(mcodeModelOptionValue("MiniMax-M2.7-highspeed", advertised)).toBe("m:minimax:MiniMax-M2.7:v:highspeed");
  });

  it("keeps the user's own BYOK provider id instead of constructing one", () => {
    const byok = [{ id: "model", options: [{ value: "m:my-openai:MiniMax-M3:u", name: "MiniMax-M3" }] }];
    expect(mcodeModelOptionValue("MiniMax-M3", byok)).toBe("m:my-openai:MiniMax-M3:u");
  });

  it("skips the switch when the session advertises no model option (older mcode)", () => {
    expect(mcodeModelOptionValue("MiniMax-M3", [])).toBeNull();
    expect(mcodeModelOptionValue("MiniMax-M3", undefined)).toBeNull();
    expect(mcodeModelOptionValue("MiniMax-M3", [{ id: "mode", options: [] }])).toBeNull();
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
    expect(mcodePickerId(parseMcodeModelValue("m:minimax:MiniMax-M3:u")!)).toBe("MiniMax-M3");
    expect(parseMcodeModelValue("m:p:Some%20Model:u")).toEqual({ providerId: "p", modelId: "Some Model" });
  });

  it("rejects values that are not mcode-shaped", () => {
    expect(parseMcodeModelValue("m-two")).toBeNull();
    expect(parseMcodeModelValue("m:minimax:MiniMax-M3:x")).toBeNull();
    expect(parseMcodeModelValue(42)).toBeNull();
  });
});
