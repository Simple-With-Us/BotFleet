// ZCode ACP driver.  The engine runs on the zcode-acp-server bridge in front
// of the official `zcode app-server`, so the things worth pinning here are the
// claims that shape what a user gets — which channels mount, which models the
// picker offers, which effort rungs exist per model, and which sign-in paths
// produce a credential this driver can see — plus the turn-time wiring the
// bridge is chosen for: permission mode per stance, effort after the model
// switch, and the billing-key strip.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EFFORT_LEVELS, type ProviderInstance } from "../../contracts.ts";
import { ensureDirs } from "../../config.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { BUILT_IN_DRIVERS } from "../builtIn.ts";
import {
  advertisedConfigOptionsSchema,
  parseZcodeAcpModelValue,
  STATIC_ZCODE_ACP_MODELS,
  ZcodeAcpDriver,
  zcodeAcpAuthenticated,
  zcodeAcpModeFor,
  zcodeAcpModelOptionValue,
  ZCODE_ACP_EFFORT_CONFIG_ID,
  ZCODE_ACP_EFFORT_LEVELS,
  ZCODE_ACP_MODE_CONFIG_ID,
  zcodeAcpVersionCompatibilityReason,
} from "./zcode.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

// The bridge's model wire values embed the account's own provider id; these
// two are what the coding-plan account advertises (formatModelValue:
// `providerId\modelId`).
const GLM = "builtin:zai-coding-plan\\GLM-5.3";
const FLASH = "builtin:zai-coding-plan\\GLM-5.3-Flash";

const scratchDirs: string[] = [];

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ZCode ACP driver", () => {
  it("is registered as a built-in driver", () => {
    // A driver file nobody imports is a file that does nothing, and the
    // capability matrix would have a row for an engine that cannot start.
    expect(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === "zcodeAcp")).toBe(true);
  });

  it("mounts every MCP channel and takes images", () => {
    // The bridge forwards the mcpServers BotFleet hands session/new and the
    // resume calls onto the backend params (dist/handlers/session.js), and it
    // stages image and PDF attachments natively.  Both are the reason this
    // driver exists beside the headless one, so they are pinned, not inferred.
    expect(ZcodeAcpDriver.metadata.channelWiring).toEqual({
      agentsMcp: true,
      computerMcp: true,
      composioMcp: true,
      localComputerMcp: true,
      images: true,
    });
  });

  it("names itself ZCode, rides the subscription rail, and spawns the bridge bin", () => {
    expect(ZcodeAcpDriver.driverKind).toBe("zcodeAcp");
    expect(ZcodeAcpDriver.metadata.displayName).toBe("ZCode");
    expect(ZcodeAcpDriver.metadata.access).toBe("subscription");
    const decoded = ZcodeAcpDriver.defaultConfig();
    // SAFETY: defaultConfig returns AcpConfig, whose `cli` is the string this
    // support names; the assertion only reads that field.
    expect((decoded as { cli: string }).cli).toBe("zcode-acp-server");
    // The package installs a second bin (the unified CLI); the picker must
    // find an install that only exposes it.
    expect(ZcodeAcpDriver.cliAliases).toContain("zcode-acp");
  });

  it("installs the bridge with npm and names a sign-in that writes a file this driver reads", () => {
    const install = ZcodeAcpDriver.install;
    expect(install?.needsNode, "npm install -g needs Node on PATH (the bridge wants Node >= 22)").toBe(true);
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(install?.command?.[platform] ?? "", platform).toContain("npm install -g zcode-acp-server");
    }
    // `zcode-acp setup` writes ~/.zcode/v2/acp-accounts.json — the accounts
    // rung of zcodeAcpAuthenticated.  The muse lesson:  a sign-in command that
    // produces a credential the auth check cannot see strands the setup card
    // forever.
    expect(install?.signInCommand).toBe("zcode-acp setup --provider zai");
  });

  it("offers the Coding Plan's built-in models, with effort only where verified", () => {
    expect(STATIC_ZCODE_ACP_MODELS.default).toBe("GLM-5.3");
    expect(STATIC_ZCODE_ACP_MODELS.options.map((option) => option.id)).toEqual(["GLM-5.3", "GLM-5.3-Flash"]);
    const glm = STATIC_ZCODE_ACP_MODELS.options[0];
    expect(glm?.contextWindow).toBe(1_000_000);
    expect(glm?.effortLevels).toEqual(["low", "high", "max"]);
    // Explicit empty list, not omitted:  the picker falls back to the
    // engine-wide list for a row that declares none, and Flash's thought
    // vocabulary is not verified, so offering GLM-5.3's rungs on it would be
    // a row a user can select and cannot get.
    expect(STATIC_ZCODE_ACP_MODELS.options[1]?.effortLevels).toEqual([]);
  });

  it("keeps the effort rungs inside the shared union and the bridge's own vocabulary", () => {
    for (const level of ZCODE_ACP_EFFORT_LEVELS) {
      expect(EFFORT_LEVELS).toContain(level);
    }
    // Read off the bridge's THOUGHT_ORDER/CONFIG_META (GLM-5.3:
    // low/high/max).  `medium` is deliberately absent until a bridge is seen
    // offering it for GLM-5.3.
    expect(ZCODE_ACP_EFFORT_LEVELS).toEqual(["low", "high", "max"]);
  });

  it("decodes the bridge's model wire values without trusting the provider half", () => {
    expect(parseZcodeAcpModelValue(GLM)).toBe("GLM-5.3");
    expect(parseZcodeAcpModelValue(FLASH)).toBe("GLM-5.3-Flash");
    // Agent-defined providers spell the value `custom:<urlencoded
    // providerId>:<modelId>` (the provider's colons are percent-encoded).
    expect(parseZcodeAcpModelValue("custom:account%3Abigmodel-individual-coding-plan:GLM-5.3")).toBe("GLM-5.3");
    expect(parseZcodeAcpModelValue("GLM-5.3")).toBeNull();
  });

  it("matches the picker model against the advertised options and returns the wire value verbatim", () => {
    const advertised = [
      {
        id: "model",
        options: [
          { value: FLASH, name: "GLM-5.3-Flash" },
          { value: GLM, name: "GLM-5.3" },
        ],
      },
    ];
    expect(zcodeAcpModelOptionValue("GLM-5.3", advertised)).toBe(GLM);
    // Garbage in the list degrades at the boundary instead of throwing.
    expect(
      zcodeAcpModelOptionValue("GLM-5.3", advertisedConfigOptionsSchema.parse([{ id: "model", options: [7, null, { value: GLM }] }])),
    ).toBe(GLM);
    // No model option advertised:  the session keeps its login default and
    // the switch is skipped, exactly as mcode's contract reads.
    expect(zcodeAcpModelOptionValue("GLM-5.3", [{ id: "mode", options: [] }])).toBeNull();
    expect(zcodeAcpModelOptionValue("GLM-5.3", undefined)).toBeNull();
    // A model option exists but lacks the pick:  the user asked for a model
    // the session cannot run, and that must be loud, not silent.
    expect(() => zcodeAcpModelOptionValue("GLM-5.3-Air", advertised)).toThrow(/does not offer GLM-5\.3-Air/);
  });

  it("runs full-auto turns in yolo and held turns in the backend's asking mode", () => {
    expect(zcodeAcpModeFor(true)).toBe("yolo");
    expect(zcodeAcpModeFor(false)).toBe("build");
    expect(ZCODE_ACP_MODE_CONFIG_ID).toBe("mode");
    expect(ZCODE_ACP_EFFORT_CONFIG_ID).toBe("thought");
  });

  it("gates the stock bridge below the 0.82 line and exempts a custom wrapper", () => {
    expect(zcodeAcpVersionCompatibilityReason("0.82.3", { cli: "zcode-acp-server", fullAuto: true })).toBeNull();
    expect(zcodeAcpVersionCompatibilityReason("1.0.0", { cli: "zcode-acp-server", fullAuto: true })).toBeNull();
    const refused = zcodeAcpVersionCompatibilityReason("0.81.2", { cli: "zcode-acp-server", fullAuto: true });
    expect(refused).toMatch(/0\.81\.2/);
    expect(refused).toMatch(/0\.82\.0 or newer/);
    expect(zcodeAcpVersionCompatibilityReason("garbage", { cli: "zcode-acp-server", fullAuto: true })).toMatch(
      /recognizable version/,
    );
    // A wrapper path is the operator's own policy decision; the core skips
    // the gate for it and the helper answers the same way.
    expect(zcodeAcpVersionCompatibilityReason("0.1.0", { cli: "/opt/bridge/acp", fullAuto: true })).toBeNull();
  });
});

describe("zcodeAcpAuthenticated", () => {
  it("reads the setup accounts file when it exists", () => {
    const home = scratchDir("botfleet-zcode-acp-auth-");
    mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
    writeFileSync(join(home, ".zcode", "v2", "acp-accounts.json"), "{}");
    expect(zcodeAcpAuthenticated({ HOME: home })).toBe(true);
  });

  it("accepts a desktop provider key, but only an enabled builtin one", () => {
    const home = scratchDir("botfleet-zcode-acp-auth-");
    const v2 = join(home, ".zcode", "v2");
    mkdirSync(v2, { recursive: true });
    type DesktopFixture = { provider?: Record<string, { enabled?: boolean; options?: { apiKey?: string } }> };
    const write = (config: DesktopFixture) => writeFileSync(join(v2, "config.json"), JSON.stringify(config));
    // A user-added provider carrying its own key.
    write({ provider: { "custom:relay": { options: { apiKey: "k" } } } });
    expect(zcodeAcpAuthenticated({ HOME: home })).toBe(true);
    // The coding-plan entry counts only when the desktop left it enabled —
    // a disabled leftover proves nothing.
    write({ provider: { "builtin:zai-coding-plan": { enabled: false, options: { apiKey: "k" } } } });
    expect(zcodeAcpAuthenticated({ HOME: home })).toBe(false);
    write({ provider: { "builtin:zai-coding-plan": { enabled: true, options: { apiKey: "k" } } } });
    expect(zcodeAcpAuthenticated({ HOME: home })).toBe(true);
    // Blank keys are not credentials.
    write({ provider: { "builtin:zai-coding-plan": { enabled: true, options: { apiKey: "   " } } } });
    expect(zcodeAcpAuthenticated({ HOME: home })).toBe(false);
  });

  it("answers false on missing, malformed, or keyless files", () => {
    expect(zcodeAcpAuthenticated({ HOME: scratchDir("botfleet-zcode-acp-auth-") })).toBe(false);
    const home = scratchDir("botfleet-zcode-acp-auth-");
    const v2 = join(home, ".zcode", "v2");
    mkdirSync(v2, { recursive: true });
    writeFileSync(join(v2, "config.json"), "{not json");
    expect(zcodeAcpAuthenticated({ HOME: home })).toBe(false);
    writeFileSync(join(v2, "config.json"), JSON.stringify({ provider: {} }));
    expect(zcodeAcpAuthenticated({ HOME: home })).toBe(false);
  });

  it("follows ZCODE_HOME the way the bridge does", () => {
    const root = scratchDir("botfleet-zcode-acp-auth-root-");
    mkdirSync(join(root, "v2"), { recursive: true });
    writeFileSync(join(root, "v2", "acp-accounts.json"), "{}");
    // HOME points at an empty home; the relocated root is what decides.
    expect(zcodeAcpAuthenticated({ HOME: scratchDir("botfleet-zcode-acp-auth-"), ZCODE_HOME: root })).toBe(true);
  });
});

describe("ZCode ACP turns (fake bridge)", () => {
  const ENV_KEYS = [
    "FAKE_ACP_DUMP",
    "FAKE_ACP_RPC_DUMP",
    "FAKE_ACP_AUTH_METHOD",
    "FAKE_ACP_MODELS_JSON",
    "FAKE_ACP_SESSION_MODES",
    "FAKE_ACP_REASONING_CONFIG_ID",
    "FAKE_ACP_REASONING_EFFORTS",
    "FAKE_ACP_REASONING_MODELS",
    "FAKE_ACP_REASONING_ERROR_CODE",
    "FAKE_ACP_MODE_ERROR_CODE",
    "FAKE_ACP_CONFIG_REPLY_BARE",
  ];
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  let scratch: string;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = scratchDir("botfleet-zcode-acp-turns-");
    // Flash first, so a GLM-5.3 turn has to switch the model before it can
    // set an effort the switch might otherwise reset.
    // The bridge advertises exactly one authMethod (`zcode-credentials`),
    // and its authenticate is a readiness check the handshake can drive —
    // the stance that lets a snapshot which cannot see the deeper OAuth
    // rungs still be corrected by asking the bridge itself.
    process.env.FAKE_ACP_AUTH_METHOD = "zcode-credentials";
    process.env.FAKE_ACP_MODELS_JSON = JSON.stringify([FLASH, GLM]);
    process.env.FAKE_ACP_SESSION_MODES = "plan,build,edit,yolo";
    process.env.FAKE_ACP_REASONING_CONFIG_ID = ZCODE_ACP_EFFORT_CONFIG_ID;
    process.env.FAKE_ACP_REASONING_EFFORTS = "low,high,max";
    process.env.FAKE_ACP_REASONING_MODELS = GLM;
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    vi.restoreAllMocks();
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  const create = async (fullAuto: boolean, environment: Record<string, string> = {}) => {
    instance = await ZcodeAcpDriver.create({
      instanceId: "zcode-acp-test",
      displayName: "ZCode",
      environment,
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto },
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

  const runTurn = async (input: { threadId: string; model?: string; effort?: "low" | "high" | "max" }) => {
    await instance!.adapter.sendTurn({ text: "run the check", ...input });
    // Match on the thread: `until` also returns events already seen, so a
    // test that runs two turns would otherwise read the first turn's end.
    return recorder!.until((event) => event.type === "turn.completed" && event.threadId === input.threadId);
  };

  const errorMessage = () => recorder!.events.find((event) => event.type === "runtime.error")?.message;

  it("sets mode then effort after the model switch, and strips the vendor key env", async () => {
    const dump = dumpTo("full-auto.json");
    await create(true, { Z_AI_API_KEY: "leak", GLM_API_KEY: "leak" });

    const done = await runTurn({ threadId: "zcode-acp-yolo", model: "GLM-5.3", effort: "high" });

    expect(done).toMatchObject({ ok: true });
    expect(configCalls(dump)).toEqual([setConfig("model", GLM), setConfig("mode", "yolo"), setConfig("thought", "high")]);
    // SAFETY: the fake CLI writes the dump itself and its env map carries
    // only the keys it recorded; this test reads that recorded shape.
    const env = (JSON.parse(readFileSync(dump, "utf8")) as { env?: Record<string, string> }).env ?? {};
    expect(env.ZCODE_ACP_MODE).toBe("yolo");
    // An inherited z.ai key must not ride along:  it would flip billing off
    // the Coding Plan subscription onto metered API billing.
    expect(env.Z_AI_API_KEY).toBeUndefined();
    expect(env.GLM_API_KEY).toBeUndefined();
  });

  it("runs a held turn in the asking mode", async () => {
    const dump = dumpTo("asking.json");
    await create(false);

    const done = await runTurn({ threadId: "zcode-acp-build", model: "GLM-5.3" });

    expect(done).toMatchObject({ ok: true });
    expect(configCalls(dump)).toEqual([setConfig("model", GLM), setConfig("mode", "build")]);
    // SAFETY: the fake CLI writes the dump itself and its env map carries
    // only the keys it recorded; this test reads that recorded shape.
    const env = (JSON.parse(readFileSync(dump, "utf8")) as { env?: Record<string, string> }).env ?? {};
    expect(env.ZCODE_ACP_MODE).toBe("build");
  });

  it("sends no effort call when the turn picked none, and none for Flash", async () => {
    const dump = dumpTo("no-effort.json");
    await create(true);

    expect(await runTurn({ threadId: "zcode-acp-default", model: "GLM-5.3" })).toMatchObject({ ok: true });
    const calls = configCalls(dump);
    expect(calls.some((call) => call.params.configId === ZCODE_ACP_EFFORT_CONFIG_ID)).toBe(false);

    const second = dumpTo("flash.json");
    expect(await runTurn({ threadId: "zcode-acp-flash", model: "GLM-5.3-Flash", effort: "high" })).toMatchObject({
      ok: true,
    });
    // Flash declares no effort rungs; a stale thread setting must not put
    // GLM-5.3's vocabulary onto a model that never advertised it.
    expect(configCalls(second).some((call) => call.params.configId === ZCODE_ACP_EFFORT_CONFIG_ID)).toBe(false);
  });

  it("skips the mode set on a session that advertises no mode option", async () => {
    delete process.env.FAKE_ACP_SESSION_MODES;
    const dump = dumpTo("no-mode.json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await create(true);

    expect(await runTurn({ threadId: "zcode-acp-nomode", model: "GLM-5.3" })).toMatchObject({ ok: true });
    expect(configCalls(dump)).toEqual([setConfig("model", GLM)]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no session mode option/));
  });

  it("fails the turn before prompting when the bridge refuses the mode it advertised", async () => {
    const rpcDump = join(scratch, "rpc-mode.json");
    process.env.FAKE_ACP_RPC_DUMP = rpcDump;
    process.env.FAKE_ACP_MODE_ERROR_CODE = "-32602";
    await create(true);

    const done = await runTurn({ threadId: "zcode-acp-mode-refused", model: "GLM-5.3" });

    expect(done).toMatchObject({ ok: false });
    expect(errorMessage()).toMatch(/did not accept session mode yolo/);
    const methods: string[] = JSON.parse(readFileSync(rpcDump, "utf8"));
    expect(methods).not.toContain("session/prompt");
  });

  it("fails the turn before prompting when the bridge refuses the effort it advertised", async () => {
    const rpcDump = join(scratch, "rpc-effort.json");
    process.env.FAKE_ACP_RPC_DUMP = rpcDump;
    process.env.FAKE_ACP_REASONING_ERROR_CODE = "-32602";
    await create(true);

    const done = await runTurn({ threadId: "zcode-acp-effort-refused", model: "GLM-5.3", effort: "max" });

    expect(done).toMatchObject({ ok: false });
    expect(errorMessage()).toMatch(/did not accept thought level max for GLM-5\.3/);
    const methods: string[] = JSON.parse(readFileSync(rpcDump, "utf8"));
    expect(methods).not.toContain("session/prompt");
  });

  it("fails the turn when the account does not offer the picked model", async () => {
    const rpcDump = join(scratch, "rpc-model.json");
    process.env.FAKE_ACP_RPC_DUMP = rpcDump;
    await create(true);

    const done = await runTurn({ threadId: "zcode-acp-model-missing", model: "GLM-5.3-Air" });

    expect(done).toMatchObject({ ok: false });
    expect(errorMessage()).toMatch(/does not offer GLM-5\.3-Air/);
    const methods: string[] = JSON.parse(readFileSync(rpcDump, "utf8"));
    expect(methods).not.toContain("session/prompt");
  });

  it("resumes a thread over session/load", async () => {
    const rpcDump = join(scratch, "rpc-resume.json");
    process.env.FAKE_ACP_RPC_DUMP = rpcDump;
    await create(true);

    const first = await runTurn({ threadId: "zcode-acp-resume" });
    await instance!.adapter.sendTurn({
      text: "keep going",
      threadId: "zcode-acp-resume",
      // The harness persists the native session id from turn 1's result and
      // hands it back as the resume handle.
      resumeCursor: "fake-acp-session",
    });
    // The rpc dump is per-launch (each child overwrites it), so this reads
    // the second launch alone — which must resume, not open fresh.
    // RuntimeEvent carries turnId on every event, so the second wait can
    // require a completion other than the first turn's.
    const firstTurnId = first.turnId;
    await recorder!.until(
      (event) =>
        event.type === "turn.completed"
        && event.threadId === "zcode-acp-resume"
        && event.turnId !== firstTurnId,
      25_000,
    );

    const methods: string[] = JSON.parse(readFileSync(rpcDump, "utf8"));
    // loadSession is in the bridge's initialize answer, so the core's default
    // resume RPC is kept (no resumeMethod override in the driver).
    expect(methods).toContain("session/load");
    expect(methods).not.toContain("session/new");
    expect(methods).toContain("session/prompt");
  });
});
