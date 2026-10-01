import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ModelCatalog, ProviderInstance } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import {
  MCODE_EFFORT_CONFIG_ID,
  MCODE_M31_EFFORT_LEVELS,
  McodeAgentDriver,
  mcodeAuthenticated,
  mcodeDataDir,
  mcodeModelOptionValue,
  mcodePickerId,
  parseMcodeModelValue,
  readMcodeModelCatalog,
  STATIC_MCODE_MODELS,
  withMcodeEffortLevels,
} from "./mcode.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

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

  it("declares M3.1's effort levels and gives M2.7 Highspeed an explicit empty list", () => {
    // mcode advertises `thinkingEffort` only for M3.1 (default, low, medium,
    // high, xhigh, max), and BotFleet spells `default` as "no effort picked".
    // M2.7 must say `[]` out loud: src/lib/model-effort.ts hands a row that
    // declares no list the engine-wide one, which is M3.1's.
    const byId = new Map(STATIC_MCODE_MODELS.options.map((option) => [option.id, option]));
    expect(byId.get("MiniMax-M3.1-Flash-Preview-thinking")?.effortLevels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(byId.get("MiniMax-M2.7-highspeed-thinking")?.effortLevels).toEqual([]);
    expect(MCODE_M31_EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // No row offers M3, which stays retired: it would have no effort list at
    // all, because mcode advertises no effort options for it.
    expect(STATIC_MCODE_MODELS.options.some((option) => option.id.startsWith("MiniMax-M3-"))).toBe(false);
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

describe("withMcodeEffortLevels", () => {
  it("gives a bare row an explicit empty list and leaves declared lists alone", () => {
    const catalog: ModelCatalog = {
      default: "MiniMax-M3.1-Flash-Preview",
      options: [
        // the bare rows another branch adds to STATIC_MCODE_MODELS
        { id: "MiniMax-M3.1-Flash-Preview", label: "M3.1 Flash Preview" },
        { id: "MiniMax-M2.7-highspeed", label: "M2.7 Highspeed" },
        { id: "MiniMax-M3.1-Flash-Preview-thinking", label: "thinking", effortLevels: ["low", "max"] },
      ],
    };
    const fitted = withMcodeEffortLevels(catalog);
    expect(fitted.default).toBe("MiniMax-M3.1-Flash-Preview");
    expect(fitted.options.map((option) => option.effortLevels)).toEqual([[], [], ["low", "max"]]);
    // the input is not mutated
    expect(catalog.options[0].effortLevels).toBeUndefined();
  });
});

describe("readMcodeModelCatalog effort levels", () => {
  it("returns every row with effortLevels defined, whichever default the owner's config names", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-mcode-effort-catalog-"));
    scratchDirs.push(dataDir);
    writeFileSync(
      join(dataDir, "config.yaml"),
      ["defaultModel: minimax/MiniMax-M2.7-highspeed", "defaultModelVariant: thinking"].join("\n"),
      "utf8",
    );
    const catalog = readMcodeModelCatalog({ MINIMAX_DATA_DIR: dataDir });
    expect(catalog.default).toBe("MiniMax-M2.7-highspeed-thinking");
    expect(catalog.options.length).toBeGreaterThan(0);
    for (const option of catalog.options) {
      expect(option.effortLevels, `${option.id} must declare its effort levels`).toBeDefined();
    }
    const byId = new Map(catalog.options.map((option) => [option.id, option]));
    expect(byId.get("MiniMax-M3.1-Flash-Preview-thinking")?.effortLevels).toEqual([...MCODE_M31_EFFORT_LEVELS]);
    expect(byId.get("MiniMax-M2.7-highspeed-thinking")?.effortLevels).toEqual([]);
  });

  it("does the same when there is no config at all", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-mcode-effort-missing-"));
    scratchDirs.push(dataDir);
    const catalog = readMcodeModelCatalog({ MINIMAX_DATA_DIR: join(dataDir, "missing") });
    for (const option of catalog.options) expect(option.effortLevels).toBeDefined();
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

  it("carries an explicit effort list on every row it exposes", () => {
    for (const option of McodeAgentDriver.models.options) expect(option.effortLevels).toBeDefined();
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

describe("MiniMax Code reasoning effort over ACP", () => {
  const M27 = "m:minimax:MiniMax-M2.7-highspeed:v:thinking";
  const M31 = "m:minimax:MiniMax-M3.1-Flash-Preview:v:thinking";
  // The order a live mcode 0.5.5 session advertises for M3.1.
  const EFFORTS = "default,low,medium,high,xhigh,max";
  const ENV_KEYS = [
    "FAKE_ACP_DUMP",
    "FAKE_ACP_RPC_DUMP",
    "FAKE_ACP_MODELS_JSON",
    "FAKE_ACP_REASONING_CONFIG_ID",
    "FAKE_ACP_REASONING_EFFORTS",
    "FAKE_ACP_REASONING_MODELS",
    "FAKE_ACP_EFFORT_ERROR_CODE",
    "FAKE_ACP_REASONING_STICKS",
    "FAKE_ACP_CONFIG_REPLY_BARE",
  ];
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  let scratch: string;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "botfleet-mcode-effort-"));
    // M2.7 comes first, so an M3.1 turn has to switch the model before it can
    // set an effort that the switch would otherwise reset.
    process.env.FAKE_ACP_MODELS_JSON = JSON.stringify([M27, M31]);
    process.env.FAKE_ACP_REASONING_CONFIG_ID = MCODE_EFFORT_CONFIG_ID;
    process.env.FAKE_ACP_REASONING_EFFORTS = EFFORTS;
    process.env.FAKE_ACP_REASONING_MODELS = M31;
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    vi.restoreAllMocks();
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  const create = async () => {
    instance = await McodeAgentDriver.create({
      instanceId: "mcode-effort-test",
      displayName: "MiniMax Code",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  };

  const dumpTo = (name: string): string => {
    const dump = join(scratch, name);
    process.env.FAKE_ACP_DUMP = dump;
    return dump;
  };

  interface ConfigCall {
    method: string;
    params: { sessionId: string; configId: string; value: string };
  }
  const configCalls = (dump: string): ConfigCall[] => {
    const file = `${dump}.config.json`;
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  };

  const setConfig = (configId: string, value: string) => ({
    method: "session/set_config_option",
    params: { sessionId: "fake-acp-session", configId, value },
  });

  const runTurn = async (input: { threadId: string; model: string; effort?: "low" | "medium" | "high" | "xhigh" | "max" | "none" }) => {
    await instance!.adapter.sendTurn({ text: "reason about this", ...input });
    return recorder!.until((event) => event.type === "turn.completed");
  };

  const errorMessage = () => recorder!.events.find((event) => event.type === "runtime.error")?.message;

  it("sets the picked level after the model switch, because the switch resets it", async () => {
    const dump = dumpTo("xhigh.json");
    await create();

    const done = await runTurn({ threadId: "mcode-effort-xhigh", model: "MiniMax-M3.1-Flash-Preview-thinking", effort: "xhigh" });

    expect(done).toMatchObject({ ok: true });
    expect(configCalls(dump)).toEqual([setConfig("model", M31), setConfig("thinkingEffort", "xhigh")]);
  });

  it("sends mcode's own `default` when no effort is picked, so a level from an earlier turn never sticks", async () => {
    const dump = dumpTo("default.json");
    await create();

    const done = await runTurn({ threadId: "mcode-effort-default", model: "MiniMax-M3.1-Flash-Preview-thinking" });

    expect(done).toMatchObject({ ok: true });
    expect(configCalls(dump)).toEqual([setConfig("model", M31), setConfig("thinkingEffort", "default")]);
  });

  it("sends no effort call for M2.7 Highspeed, which mcode advertises no effort for", async () => {
    const dump = dumpTo("m27.json");
    await create();

    const done = await runTurn({ threadId: "mcode-effort-m27", model: "MiniMax-M2.7-highspeed-thinking", effort: "high" });

    expect(done).toMatchObject({ ok: true });
    expect(configCalls(dump).some((call) => call.params.configId === "thinkingEffort")).toBe(false);
  });

  it("fails the turn before prompting when mcode acknowledges a level but keeps another", async () => {
    const rpcDump = join(scratch, "rpc-stuck.json");
    process.env.FAKE_ACP_RPC_DUMP = rpcDump;
    process.env.FAKE_ACP_REASONING_STICKS = "1";
    await create();

    const done = await runTurn({ threadId: "mcode-effort-stuck", model: "MiniMax-M3.1-Flash-Preview-thinking", effort: "high" });

    expect(done).toMatchObject({ ok: false });
    expect(errorMessage()).toMatch(
      /MiniMax Code did not accept thinking effort high for MiniMax-M3\.1-Flash-Preview-thinking/,
    );
    const methods: string[] = JSON.parse(readFileSync(rpcDump, "utf8"));
    expect(methods).not.toContain("session/prompt");
  });

  it("fails a no-effort turn when the session reports it kept an earlier level, instead of billing it there", async () => {
    // A resumed session still sitting at `high`: the reset to `default` is
    // acknowledged but not applied, and the reply says so.  M3.1 is first here,
    // so no model switch runs and the session keeps its starting level.
    const rpcDump = join(scratch, "rpc-sticky-default.json");
    process.env.FAKE_ACP_RPC_DUMP = rpcDump;
    process.env.FAKE_ACP_MODELS_JSON = JSON.stringify([M31, M27]);
    process.env.FAKE_ACP_REASONING_EFFORTS = "high,default,low,medium,xhigh,max";
    process.env.FAKE_ACP_REASONING_STICKS = "1";
    await create();

    const done = await runTurn({ threadId: "mcode-effort-sticky-default", model: "MiniMax-M3.1-Flash-Preview-thinking" });

    expect(done).toMatchObject({ ok: false });
    expect(errorMessage()).toMatch(
      /MiniMax Code did not accept thinking effort default for MiniMax-M3\.1-Flash-Preview-thinking: still high/,
    );
    const methods: string[] = JSON.parse(readFileSync(rpcDump, "utf8"));
    expect(methods).not.toContain("session/prompt");
  });

  it("completes a no-effort turn when the session already sits at default, even if it ignores the set", async () => {
    process.env.FAKE_ACP_REASONING_STICKS = "1";
    await create();

    const done = await runTurn({ threadId: "mcode-effort-stuck-default", model: "MiniMax-M3.1-Flash-Preview-thinking" });

    expect(done).toMatchObject({ ok: true });
  });

  it("fails an explicit level the CLI does not advertise, naming the level", async () => {
    // A session whose effort list lacks xhigh answers -32602 to it.
    process.env.FAKE_ACP_REASONING_EFFORTS = "default,low,medium,high,max";
    await create();

    const done = await runTurn({ threadId: "mcode-effort-unadvertised", model: "MiniMax-M3.1-Flash-Preview-thinking", effort: "xhigh" });

    expect(done).toMatchObject({ ok: false });
    expect(errorMessage()).toMatch(/MiniMax Code did not accept thinking effort xhigh/);
  });

  it("treats `none` as Default with a warning instead of failing, since M3.1 has no off switch", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dump = dumpTo("none.json");
    await create();

    const done = await runTurn({ threadId: "mcode-effort-none", model: "MiniMax-M3.1-Flash-Preview-thinking", effort: "none" });

    expect(done).toMatchObject({ ok: true });
    expect(configCalls(dump)).toEqual([setConfig("model", M31), setConfig("thinkingEffort", "default")]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no effort "none"'));
  });

  it("does not fail a no-effort turn when mcode refuses `default`, only logs it", async () => {
    // An older mcode that advertises no `thinkingEffort` for M3.1 answers the
    // set with -32602.  Default must not turn that into a failed turn.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.FAKE_ACP_REASONING_MODELS = M27;
    await create();

    const done = await runTurn({ threadId: "mcode-effort-default-refused", model: "MiniMax-M3.1-Flash-Preview-thinking" });

    expect(done).toMatchObject({ ok: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("did not accept thinking effort default"));
  });

  it("fails a no-effort turn when the Default reset errors with anything but -32602", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.FAKE_ACP_EFFORT_ERROR_CODE = "-32603";
    await create();

    const done = await runTurn({ threadId: "mcode-effort-default-internal", model: "MiniMax-M3.1-Flash-Preview-thinking" });

    expect(done).toMatchObject({ ok: false });
    expect(errorMessage()).toMatch(/did not accept thinking effort default/);
  });

  it("accepts a bare acknowledgement that reports no option state", async () => {
    process.env.FAKE_ACP_CONFIG_REPLY_BARE = "1";
    await create();

    const done = await runTurn({ threadId: "mcode-effort-bare", model: "MiniMax-M3.1-Flash-Preview-thinking", effort: "max" });

    expect(done).toMatchObject({ ok: true });
  });

  it("exposes the M3.1 level list as the engine-wide effort capability", async () => {
    await create();

    expect(instance!.adapter.capabilities?.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});
