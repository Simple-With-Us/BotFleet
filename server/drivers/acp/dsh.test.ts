import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { SPAWNED_PROXIES } from "../../proxy-paths.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { createPatchCleanup, dshMcpPatchPaths } from "../dsh-acp-bridge.ts";
import {
  classifyDshError,
  dshCredentialCandidates,
  dshSupport,
  dshModelIdFromOptionValue,
  dshModelOptionValue,
  dshSpawnArgs,
  dshVersionCompatibilityReason,
  dshWrapSpawn,
  DshAgentDriver,
  DSH_INIT_TIMEOUT_MS,
  DSH_MINIMUM_ACP_VERSION,
  readDshModelCatalog,
  STATIC_DSH_MODELS,
} from "./dsh.ts";
import { resolveInitDeadline } from "./init-deadline.ts";
import type { AcpStdioMcpServer } from "./core.ts";
import { dshMcpPatchYaml, isStockDshCli, writeDshMcpPatch } from "./dsh-mcp.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

/** Remove a written patch overlay and the private directory it lives in.
 *
 * Guarded on the directory's own name rather than trusting whatever
 * `writeDshMcpPatch` returned: a regression that puts the overlay back in the
 * shared temp root must fail an assertion, never make this teardown delete
 * that root.  The same guard the bridge's cleanup uses, for the same reason. */
function removeWrittenPatch(patch: string): void {
  rmSync(patch, { force: true });
  const directory = dirname(patch);
  if (basename(directory).startsWith("botfleet-dsh-mcp-")) {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("DshAgentDriver config", () => {
  it("uses the published ACP profile and current package setup", () => {
    expect(DshAgentDriver.defaultConfig().cli).toBe("dsh");
    expect(dshSpawnArgs({ cli: "dsh", fullAuto: false }, { integrations: undefined })).toEqual([
      "--profile",
      "acp",
    ]);
    expect(DshAgentDriver.install).toMatchObject({
      command: {
        darwin: "npm install -g @deepseek-ai/dsh@latest",
        linux: "npm install -g @deepseek-ai/dsh@latest",
        win32: "npm install -g @deepseek-ai/dsh@latest",
      },
      docsUrl: "https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/bundle/acp-app",
      needsNode: true,
    });
  });

  it("carries the owner-facing DSH model list", () => {
    // Owner 2026-09-27.  DeepSeek's catalog is only two models: `deepseek-flash`
    // IS the image/video model, and its image tokens bill at the same rate as
    // text, so there is deliberately no third DeepSeek row.  MiniMax-M2.7
    // (non-highspeed) stays out — M3 dominates it on context.
    expect(STATIC_DSH_MODELS.default).toBe("DeepSeek-V4.1-Flash");
    expect(STATIC_DSH_MODELS.options.map((option) => option.id)).toEqual([
      "DeepSeek-V4.1-Flash",
      "DeepSeek-V4.1-Pro",
      "MiniMax-M3.1-Flash-Preview",
      "MiniMax-M3",
      "MiniMax-M2.7-highspeed",
    ]);
  });

  it("badges rows where the choice has a capability, cost, or availability consequence", () => {
    const byId = new Map(STATIC_DSH_MODELS.options.map((option) => [option.id, option]));
    // Image + Video: same token rate as text, so the capability is the point,
    // not a price.
    expect(byId.get("DeepSeek-V4.1-Flash")?.badge).toBe("Multimodal");
    // DeepSeek-V4.1-Pro lacks vision and warns of auto-switch to Flash on visual input.
    expect(byId.get("DeepSeek-V4.1-Pro")?.badge).toBe("No Vision");
    expect(byId.get("DeepSeek-V4.1-Pro")?.badgeTitle).toContain("lacks vision");
    expect(byId.get("DeepSeek-V4.1-Pro")?.badgeTitle).toContain("Attaching an image");
    // Preview: Token Plan / MiniMax Code only, so it needs a Token Plan key.
    expect(byId.get("MiniMax-M3.1-Flash-Preview")?.badge).toBe("Preview");
    // 2x Cost: $0.60/$2.40 against M3's $0.30/$1.20.
    expect(byId.get("MiniMax-M2.7-highspeed")?.badge).toBe("2x the $");
    // M3 is the base rate, so it carries no cost chip.
    expect(byId.get("MiniMax-M3")?.badge).toBeUndefined();
  });

  it("gives every chip a hover explanation, since a bare chip is not a price", () => {
    for (const option of STATIC_DSH_MODELS.options) {
      if (!option.badge) continue;
      expect(option.badgeTitle, `${option.id} badge needs a badgeTitle`).toBeTruthy();
      expect(option.badge!.length).toBeLessThanOrEqual(10);
    }
  });

  it("keeps every MiniMax row on a 1M-or-204k context window", () => {
    const byId = new Map(STATIC_DSH_MODELS.options.map((option) => [option.id, option]));
    expect(byId.get("MiniMax-M3")?.contextWindow).toBe(1_000_000);
    expect(byId.get("MiniMax-M3.1-Flash-Preview")?.contextWindow).toBe(1_000_000);
    expect(byId.get("MiniMax-M2.7-highspeed")?.contextWindow).toBe(204_800);
  });

  it("encodes the ACP model option with its provider while preserving the picker id", () => {
    expect(dshModelOptionValue("DeepSeek-V4.1-Pro")).toBe('["deepseek-official","DeepSeek-V4.1-Pro"]');
    expect(dshModelIdFromOptionValue('["deepseek-official","DeepSeek-V4.1-Pro"]')).toBe("DeepSeek-V4.1-Pro");
    expect(dshModelOptionValue("MiniMax-M3")).toBe('["minimax","MiniMax-M3"]');
    expect(dshModelIdFromOptionValue('["minimax","MiniMax-M3"]')).toBe("MiniMax-M3");
    expect(dshModelIdFromOptionValue('["other-provider","DeepSeek-V4.1-Pro"]')).toBeNull();
    expect(dshModelIdFromOptionValue("DeepSeek-V4.1-Pro")).toBeNull();
  });

  it("round-trips every catalog row through the ACP model option encoding", () => {
    // A row that appears in the picker but cannot be encoded is a dead choice:
    // the id is sent to the CLI, and if dshProviderForModel cannot place it
    // under a provider the session rejects the model.  Asserting over the whole
    // catalog rather than two hand-picked ids means a future model added to
    // STATIC_DSH_MODELS is covered the day it lands.
    //
    // Checked directly because the risk was live: dshProviderForModel is prefix
    // based (`MiniMax-` -> minimax), so the newer M3.1 Flash Preview and M2.7
    // highspeed ids do encode, but nothing in the suite proved it.
    for (const option of STATIC_DSH_MODELS.options) {
      const encoded = dshModelOptionValue(option.id);
      expect(encoded, `${option.id} must encode to an ACP model option`).toBeTruthy();
      expect(
        dshModelIdFromOptionValue(encoded!),
        `${option.id} must survive the encode/decode round trip`,
      ).toBe(option.id);
    }
  });

  it("places the two newer MiniMax ids under the minimax provider", () => {
    // Spelled out so a change from prefix matching to a hardcoded allowlist
    // fails here with a readable message rather than at turn time.
    expect(dshModelOptionValue("MiniMax-M3.1-Flash-Preview")).toBe(
      '["minimax","MiniMax-M3.1-Flash-Preview"]',
    );
    expect(dshModelOptionValue("MiniMax-M2.7-highspeed")).toBe(
      '["minimax","MiniMax-M2.7-highspeed"]',
    );
  });

  it("rejects stock DSH versions older than the native ACP profile", () => {
    expect(DSH_MINIMUM_ACP_VERSION).toBe("0.1.5-rc.1");
    expect(dshVersionCompatibilityReason("dsh 0.1.5-rc.1")).toBeNull();
    expect(dshVersionCompatibilityReason("0.1.5-rc.2")).toBeNull();
    expect(dshVersionCompatibilityReason("0.1.5")).toBeNull();
    expect(dshVersionCompatibilityReason("0.2.0")).toBeNull();
    expect(dshVersionCompatibilityReason("dsh 0.1.5-rc.0")).toMatch(/0\.1\.5-rc\.1 or newer/);
    expect(dshVersionCompatibilityReason("dsh 0.1.4")).toMatch(/0\.1\.5-rc\.1 or newer/);
    expect(dshVersionCompatibilityReason("development build")).toMatch(/0\.1\.5-rc\.1 or newer/);
    expect(dshVersionCompatibilityReason("development build", "/opt/dsh-wrapper")).toBeNull();
  });

  // `dsh --profile acp` answers initialize only after loading its whole
  // Cordis plugin graph; the shared 60 s default cut those boots off.
  it("gives the heavy DSH cold boot a longer, still load-scaled initialize deadline", () => {
    expect(dshSupport.initTimeoutMs).toBe(DSH_INIT_TIMEOUT_MS);
    expect(DSH_INIT_TIMEOUT_MS).toBe(120_000);
    const quiet = resolveInitDeadline({ engineBaseMs: dshSupport.initTimeoutMs, load: { load1: 4, cores: 10 } });
    expect(quiet.timeoutMs).toBe(120_000);
    const busy = resolveInitDeadline({ engineBaseMs: dshSupport.initTimeoutMs, load: { load1: 20, cores: 10 } });
    expect(busy.timeoutMs).toBe(240_000);
  });
});

describe("native DSH ACP turns", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  let scratch: string;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "botfleet-dsh-acp-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_DUMP;
    delete process.env.FAKE_ACP_RPC_DUMP;
    delete process.env.FAKE_ACP_MODELS;
    delete process.env.FAKE_ACP_MODELS_JSON;
    delete process.env.FAKE_ACP_REASONING_EFFORTS;
    delete process.env.FAKE_ACP_REASONING_STICKS;
    delete process.env.FAKE_ACP_CONFIG_REPLY_BARE;
    delete process.env.FAKE_ACP_USAGE_UPDATE;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  const create = async () => {
    instance = await DshAgentDriver.create({
      instanceId: "dsh-native-test",
      displayName: "Harness",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  };

  it("mounts standard MCP servers and applies confirmed model and reasoning options", async () => {
    const dump = join(scratch, "dsh.json");
    const flash = dshModelOptionValue("DeepSeek-V4.1-Flash");
    const pro = dshModelOptionValue("DeepSeek-V4.1-Pro");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.FAKE_ACP_MODELS_JSON = JSON.stringify([flash, pro]);
    process.env.FAKE_ACP_REASONING_EFFORTS = "off,high,max";
    await create();

    await instance!.adapter.sendTurn({
      threadId: "dsh-native-turn",
      text: "test the native ACP path",
      model: "DeepSeek-V4.1-Pro",
      effort: "max",
      integrations: {
        agents: { command: "/usr/bin/node", args: ["/tmp/agents-proxy.mjs"], env: {} },
      },
    });
    const done = await recorder!.until((event) => event.type === "turn.completed");

    expect(done).toMatchObject({ ok: true });
    expect(recorder!.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "session.started", model: "DeepSeek-V4.1-Pro" }),
    ]));
    expect(JSON.parse(readFileSync(dump, "utf8")).argv).toEqual(["--profile", "acp"]);
    expect(JSON.parse(readFileSync(`${dump}.mcp.json`, "utf8"))).toEqual([
      expect.objectContaining({ name: "agents", command: "/usr/bin/node", args: ["/tmp/agents-proxy.mjs"] }),
    ]);
    expect(JSON.parse(readFileSync(`${dump}.config.json`, "utf8"))).toEqual([
      { method: "session/set_config_option", params: { sessionId: "fake-acp-session", configId: "model", value: pro } },
      { method: "session/set_config_option", params: { sessionId: "fake-acp-session", configId: "reasoning_effort", value: "max" } },
    ]);
  });

  it("reports input tokens (no fabricated output) from DSH's usage_update notification", async () => {
    // The real @deepseek-ai/dsh-acp package never puts usage on the
    // session/prompt result — its only signal is a session/update
    // sessionUpdate:"usage_update" notification carrying a combined
    // context-occupancy figure, not a real input/output split.  This is
    // the regression test for BOTFLEET's fix: DSH turns used to report no
    // token usage at all.
    process.env.FAKE_ACP_USAGE_UPDATE = "1234";
    await create();

    await instance!.adapter.sendTurn({ threadId: "dsh-usage-turn", text: "how many tokens" });
    const done = await recorder!.until((event) => event.type === "turn.completed");

    expect(recorder!.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "thread.token-usage.updated", input: 1234 }),
    ]));
    const liveUpdate = recorder!.events.find((event) => event.type === "thread.token-usage.updated");
    expect(liveUpdate).not.toHaveProperty("output");
    expect(done).toMatchObject({ ok: true, usage: { input: 1234 } });
    expect(done).not.toHaveProperty("usage.output");
  });

  it("uses session/resume because current DSH rejects session/load", async () => {
    const dump = join(scratch, "resume.json");
    process.env.FAKE_ACP_RPC_DUMP = dump;
    process.env.FAKE_ACP_MODELS_JSON = JSON.stringify([dshModelOptionValue("DeepSeek-V4.1-Flash")]);
    await create();

    await instance!.adapter.sendTurn({
      threadId: "dsh-native-resume",
      text: "continue",
      model: "DeepSeek-V4.1-Flash",
      resumeCursor: "persisted-dsh-session",
    });
    const done = await recorder!.until((event) => event.type === "turn.completed");

    expect(done).toMatchObject({ ok: true });
    const methods = JSON.parse(readFileSync(dump, "utf8")) as string[];
    expect(methods).toContain("session/resume");
    expect(methods).not.toContain("session/load");
    expect(methods).not.toContain("session/new");
  });

  it("reports the picker model id when a turn accepts the native session default", async () => {
    const flash = dshModelOptionValue("DeepSeek-V4.1-Flash");
    process.env.FAKE_ACP_MODELS_JSON = JSON.stringify([flash]);
    await create();

    await instance!.adapter.sendTurn({
      threadId: "dsh-native-default-model",
      text: "use the session default",
    });
    await recorder!.until((event) => event.type === "turn.completed");

    expect(recorder!.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "session.started", model: "DeepSeek-V4.1-Flash" }),
    ]));
  });

  it("fails before prompting if DSH acknowledges but does not apply reasoning effort", async () => {
    const rpcDump = join(scratch, "reasoning-stuck.json");
    process.env.FAKE_ACP_RPC_DUMP = rpcDump;
    process.env.FAKE_ACP_MODELS_JSON = JSON.stringify([dshModelOptionValue("DeepSeek-V4.1-Flash")]);
    process.env.FAKE_ACP_REASONING_EFFORTS = "off,high,max";
    process.env.FAKE_ACP_REASONING_STICKS = "1";
    await create();

    await instance!.adapter.sendTurn({
      threadId: "dsh-native-reasoning-stuck",
      text: "do not spend this turn on the wrong setting",
      model: "DeepSeek-V4.1-Flash",
      effort: "max",
    });
    const done = await recorder!.until((event) => event.type === "turn.completed");

    expect(done).toMatchObject({ ok: false });
    expect(recorder!.events.find((event) => event.type === "runtime.error")?.message).toMatch(
      /did not switch reasoning effort to max/,
    );
    const methods = JSON.parse(readFileSync(rpcDump, "utf8")) as string[];
    expect(methods).not.toContain("session/prompt");
  });

  it("accepts a bare set_config_option acknowledgement instead of failing the turn", async () => {
    const flash = dshModelOptionValue("DeepSeek-V4.1-Flash");
    const pro = dshModelOptionValue("DeepSeek-V4.1-Pro");
    process.env.FAKE_ACP_MODELS_JSON = JSON.stringify([flash, pro]);
    process.env.FAKE_ACP_REASONING_EFFORTS = "off,high,max";
    process.env.FAKE_ACP_CONFIG_REPLY_BARE = "1";
    await create();

    await instance!.adapter.sendTurn({
      threadId: "dsh-native-bare-config-reply",
      text: "run on the pinned model and effort",
      model: "DeepSeek-V4.1-Pro",
      effort: "max",
    });
    const done = await recorder!.until((event) => event.type === "turn.completed");

    expect(done).toMatchObject({ ok: true });
    expect(recorder!.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "session.started", model: "DeepSeek-V4.1-Pro" }),
    ]));
  });
});

describe("dsh MCP delivery", () => {
  const localComputer = {
    command: "/opt/cua-driver",
    args: ["mcp", "--embedded"],
    env: { CUA_DRIVER_EMBEDDED: "1" },
    platform: "darwin" as const,
    scope: "local-computer" as const,
  };

  it("treats stock dsh binaries as the published CLI that needs the ACP bridge", () => {
    expect(isStockDshCli("dsh")).toBe(true);
    expect(isStockDshCli("/Users/jay/apps/dsh-runtime/dsh")).toBe(true);
    expect(isStockDshCli("/Users/jay/apps/dsh-runtime/dsh.sh")).toBe(true);
    expect(isStockDshCli(FAKE_CLI)).toBe(false);
    expect(isStockDshCli("/opt/dsh-wrapper")).toBe(false);
  });

  it("renders BotFleet stdio mounts as dsh-mcp-client --patch rows", () => {
    const yaml = dshMcpPatchYaml([
      {
        name: "computer",
        command: "/opt/cua-driver",
        args: ["mcp", "--embedded"],
        env: [{ name: "CUA_DRIVER_EMBEDDED", value: "1" }],
      },
    ]);
    expect(yaml).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(yaml).toContain('serverName: "computer"');
    expect(yaml).toContain('command: "/opt/cua-driver"');
    expect(yaml).toContain('          - "mcp"');
    expect(yaml).toContain("          CUA_DRIVER_EMBEDDED: \"1\"");
  });

  it("wraps stock dsh with the ACP bridge and a --patch overlay when mounts exist", () => {
    const wrapped = dshWrapSpawn("dsh", ["--profile", "acp"], {
      integrations: { localComputer },
    });
    expect(wrapped.cli).toBe(process.execPath);
    expect(wrapped.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
    expect(wrapped.args[0]).toBe(SPAWNED_PROXIES.dshAcpBridge);
    expect(wrapped.args.slice(1, 5)).toEqual(["--", "dsh", "--profile", "acp"]);
    const patch = wrapped.args[wrapped.args.indexOf("--patch") + 1];
    expect(basename(patch)).toContain("botfleet-dsh-mcp-");
    expect(readFileSync(patch, "utf8")).toContain('serverName: "computer"');
    removeWrittenPatch(patch);
  });

  // The overlay holds every mount's environment verbatim — OMB_COMMS_TOKEN,
  // OMB_CONTROL_TOKEN and any Composio key — so it must never be readable by
  // anyone else on a shared machine.  POSIX mode bits only: Windows has no
  // group or other bits to assert on, and a per-user temp directory there is
  // already private.
  it.skipIf(process.platform === "win32")(
    "writes the patch overlay into a private directory, readable only by this user",
    () => {
      const patch = writeDshMcpPatch([
        {
          name: "agents",
          command: "/opt/agents-mcp",
          args: [],
          env: [{ name: "OMB_COMMS_TOKEN", value: "not-a-real-token" }],
        },
      ]);
      try {
        expect(readFileSync(patch, "utf8")).toContain("not-a-real-token");
        expect(statSync(patch).mode & 0o077).toBe(0);
        expect(statSync(dirname(patch)).mode & 0o777).toBe(0o700);
      } finally {
        removeWrittenPatch(patch);
      }
    },
  );

  it("still hands the bridge a path it recognises, and the bridge removes the file and its directory", async () => {
    const patch = writeDshMcpPatch([
      { name: "computer", command: "/opt/cua-driver", args: ["mcp"], env: [] },
    ]);
    const directory = dirname(patch);
    expect(dshMcpPatchPaths(["--profile", "acp", "--patch", patch])).toEqual([patch]);
    try {
      createPatchCleanup([patch])();
      await vi.waitFor(() => {
        expect(existsSync(patch)).toBe(false);
        expect(existsSync(directory)).toBe(false);
      });
    } finally {
      removeWrittenPatch(patch);
    }
  });

  it("leaves no directory behind when the overlay cannot be written", () => {
    const listing = () => readdirSync(tmpdir()).filter((name) => name.startsWith("botfleet-dsh-mcp-"));
    const before = listing();
    const malformed: Partial<AcpStdioMcpServer>[] = [{ name: "computer", command: "/opt/cua-driver" }];
    // SAFETY: deliberately incomplete — a mount with no `args` makes the YAML
    // build throw inside writeDshMcpPatch, which is the only portable way to
    // reach its failure path; making the filesystem itself fail is not.
    expect(() => writeDshMcpPatch(malformed as AcpStdioMcpServer[])).toThrow();
    expect(listing()).toEqual(before);
  });

  it("leaves a non-dsh CLI unwrapped so tests still see session/new mcpServers", () => {
    expect(
      dshWrapSpawn(FAKE_CLI, ["--profile", "acp"], { integrations: { localComputer } }),
    ).toEqual({ cli: FAKE_CLI, args: ["--profile", "acp"] });
  });
});

describe("dsh capability honesty", () => {
  it("advertises only the controls implemented by the native ACP profile", async () => {
    const instance = await DshAgentDriver.create({
      instanceId: "dsh-capabilities",
      displayName: "Harness",
      environment: {},
      enabled: true,
      config: DshAgentDriver.defaultConfig(),
    });
    try {
      expect(instance.adapter.capabilities).toMatchObject({
        agentsMcp: true,
        computerMcp: true,
        composioMcp: true,
        phoneMcp: true,
        qdrantMcp: true,
        localComputerMcp: true,
        images: false,
        effortLevels: ["none", "high", "max"],
      });
    } finally {
      await instance.dispose();
    }
  });
});

describe("classifyDshError", () => {
  it("maps provider failures to canonical fallback codes", () => {
    expect(classifyDshError(new Error("authentication required"))).toBe("invalid_credentials");
    expect(classifyDshError(new Error("inactive subscription"))).toBe("inactive_subscription");
    expect(classifyDshError(new Error("rate limit exceeded"))).toBe("quota_or_region_restriction");
    expect(classifyDshError(new Error("service unavailable"))).toBe("upstream_outage");
    expect(classifyDshError(new Error("model not found"))).toBe("model_catalog_outage");
    expect(classifyDshError(new Error("empty prompt"))).toBeUndefined();
  });
});

describe("dshCredentialCandidates", () => {
  it("recognizes only the credential file read by the published DSH package", () => {
    expect(dshCredentialCandidates({ HOME: "/home/jay" })).toEqual([
      join("/home/jay", ".dsh", ".credentials.yaml"),
    ]);
    expect(dshCredentialCandidates({ HOME: "/home/jay", DSH_HOME: "/opt/dsh" })).toEqual([
      join("/opt/dsh", ".credentials.yaml"),
    ]);
    expect(dshCredentialCandidates({})[0]).toContain(".credentials.yaml");
  });
});

describe("dsh authentication and credentials", () => {
  it("includes MINIMAX_API_KEY in credentialEnv", () => {
    expect(dshSupport.credentialEnv).toContain("MINIMAX_API_KEY");
    expect(dshSupport.credentialEnv).toContain("DEEPSEEK_API_KEY");
  });

  it("authenticates when MINIMAX_API_KEY is present", () => {
    expect(
      dshSupport.isAuthenticated(
        { HOME: "/nonexistent-dsh-home-test", MINIMAX_API_KEY: "minimax-secret" },
        { cli: "dsh", fullAuto: false },
      ),
    ).toBe(true);
  });

  it("authenticates when DEEPSEEK_API_KEY is present", () => {
    expect(
      dshSupport.isAuthenticated(
        { HOME: "/nonexistent-dsh-home-test", DEEPSEEK_API_KEY: "deepseek-secret" },
        { cli: "dsh", fullAuto: false },
      ),
    ).toBe(true);
  });

  it("fails authentication when no keys or credential files exist", () => {
    expect(
      dshSupport.isAuthenticated(
        { HOME: "/nonexistent-dsh-home-test" },
        { cli: "dsh", fullAuto: false },
      ),
    ).toBe(false);
  });
});

// The DSH engine's catalog comes from the Harness install's own settings file
// so a new profile model shows up without a BotFleet release.  The static
// catalog is the floor, and because a DSH profile is *partial* (it often
// configures only the minimax provider) the live read unions rather than
// replaces — the same call readClaudeModelCatalog makes.
describe("readDshModelCatalog", () => {
  let home: string;
  const STATIC_IDS = STATIC_DSH_MODELS.options.map((option) => option.id);

  const writeSettings = (yaml: string) => {
    mkdirSync(join(home, ".dsh"), { recursive: true });
    writeFileSync(join(home, ".dsh", "settings.yaml"), yaml, "utf8");
  };

  /** The live file shape: providers nested under llm-pi-ai. */
  const llmPiAi = (blocks: string) => `llm-pi-ai:\n  providers:\n${blocks}`;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dsh-settings-"));
  });

  afterEach(() => {
    removeTempDir(home);
  });

  it("adds a model the static catalog has never heard of", () => {
    writeSettings(llmPiAi("    minimax:\n      models:\n        - id: MiniMax-M3\n        - id: MiniMax-M4\n"));
    const catalog = readDshModelCatalog({ HOME: home });
    expect(catalog.options.map((option) => option.id)).toContain("MiniMax-M4");
  });

  it("keeps every static row, because a DSH profile is a partial source", () => {
    // This profile configures only the minimax provider.  deepseek-v4-flash is
    // the static default and is still reachable, so the live read must not drop
    // it -- that would silently remove a working engine from the picker.
    writeSettings(llmPiAi("    minimax:\n      models:\n        - id: MiniMax-M3\n"));
    const catalog = readDshModelCatalog({ HOME: home });
    for (const id of STATIC_IDS) expect(catalog.options.map((option) => option.id)).toContain(id);
  });

  it("never moves the default, since the union always contains it", () => {
    writeSettings(llmPiAi("    minimax:\n      models:\n        - id: MiniMax-M9\n"));
    expect(readDshModelCatalog({ HOME: home }).default).toBe(STATIC_DSH_MODELS.default);
  });

  it("reads the live nesting under llm-pi-ai.providers", () => {
    writeSettings(llmPiAi("    minimax:\n      models:\n        - id: MiniMax-M7\n"));
    expect(readDshModelCatalog({ HOME: home }).options.map((o) => o.id)).toContain("MiniMax-M7");
  });

  it("also reads a top-level providers map", () => {
    writeSettings("providers:\n  minimax:\n    models:\n      - id: MiniMax-M6\n");
    expect(readDshModelCatalog({ HOME: home }).options.map((o) => o.id)).toContain("MiniMax-M6");
  });

  it("falls back to the id when an entry has no name", () => {
    // Regression: `??` does not fall through on an empty string, so a model
    // the static catalog has never heard of rendered with a blank label.
    writeSettings(llmPiAi("    minimax:\n      models:\n        - id: MiniMax-M8\n"));
    const row = readDshModelCatalog({ HOME: home }).options.find((o) => o.id === "MiniMax-M8");
    expect(row?.label).toBe("MiniMax-M8");
  });

  it("falls back to the id when an entry name is whitespace only", () => {
    writeSettings(llmPiAi('    minimax:\n      models:\n        - id: MiniMax-M8\n          name: "   "\n'));
    const row = readDshModelCatalog({ HOME: home }).options.find((o) => o.id === "MiniMax-M8");
    expect(row?.label).toBe("MiniMax-M8");
  });

  it("takes a live contextWindow for a known id", () => {
    const known = STATIC_DSH_MODELS.options[0].id;
    writeSettings(llmPiAi(`    minimax:\n      models:\n        - id: ${known}\n          contextWindow: 2000000\n`));
    const row = readDshModelCatalog({ HOME: home }).options.find((option) => option.id === known);
    expect(row?.contextWindow).toBe(2_000_000);
  });

  it("keeps the hand-written label for a model it already knows", () => {
    const known = STATIC_DSH_MODELS.options.find((option) => option.id === "MiniMax-M3")!;
    writeSettings(llmPiAi("    minimax:\n      models:\n        - id: MiniMax-M3\n          name: Renamed By Profile\n"));
    const row = readDshModelCatalog({ HOME: home }).options.find((option) => option.id === "MiniMax-M3");
    expect(row?.label).toBe(known.label);
  });

  it("still drops MiniMax-M2.7 when the settings file offers it", () => {
    writeSettings(llmPiAi("    minimax:\n      models:\n        - id: MiniMax-M2.7\n        - id: MiniMax-M3\n"));
    const ids = readDshModelCatalog({ HOME: home }).options.map((o) => o.id);
    expect(ids).not.toContain("MiniMax-M2.7");
    expect(ids).toContain("MiniMax-M2.7-highspeed");
  });

  it("merges several provider blocks into one catalog", () => {
    writeSettings(llmPiAi(
      "    deepseek-official:\n      models:\n        - id: deepseek-v4-pro\n    minimax:\n      models:\n        - id: MiniMax-M3\n",
    ));
    const ids = readDshModelCatalog({ HOME: home }).options.map((o) => o.id);
    expect(ids).toContain("DeepSeek-V4.1-Pro");
    expect(ids).toContain("MiniMax-M3");
    // The fixture's pre-rename id must not survive the union as a stale row.
    expect(ids).not.toContain("deepseek-v4-pro");
  });

  it("drops every retired pre-rename DeepSeek id a stale profile still offers", () => {
    writeSettings(llmPiAi(
      "    deepseek-official:\n      models:\n        - id: deepseek-v4-flash\n        - id: deepseek-v4-pro\n",
    ));
    const ids = readDshModelCatalog({ HOME: home }).options.map((o) => o.id);
    expect(ids).not.toContain("deepseek-v4-flash");
    expect(ids).not.toContain("deepseek-v4-pro");
    expect(ids).toContain("DeepSeek-V4.1-Flash");
    expect(ids).toContain("DeepSeek-V4.1-Pro");
  });

  it("falls back to the static catalog when there is no settings file", () => {
    expect(readDshModelCatalog({ HOME: home }).options.map((o) => o.id)).toEqual(STATIC_IDS);
  });

  it("falls back to the static catalog on unparseable YAML", () => {
    writeSettings("llm-pi-ai: [ this: is: not: valid\n\t- nope");
    expect(readDshModelCatalog({ HOME: home }).options.map((o) => o.id)).toEqual(STATIC_IDS);
  });

  it("falls back to the static catalog when there is no models block", () => {
    writeSettings(llmPiAi("    minimax:\n      apiKeyEnv: MINIMAX_API_KEY\n"));
    expect(readDshModelCatalog({ HOME: home }).options.map((o) => o.id)).toEqual(STATIC_IDS);
  });

  it("falls back to the static catalog when the provider map is empty", () => {
    writeSettings(llmPiAi("    {}\n"));
    expect(readDshModelCatalog({ HOME: home }).options.map((o) => o.id)).toEqual(STATIC_IDS);
  });

  it("ignores a provider whose models are not a list", () => {
    writeSettings(llmPiAi("    minimax:\n      models: nope\n"));
    expect(readDshModelCatalog({ HOME: home }).options.map((o) => o.id)).toEqual(STATIC_IDS);
  });

  it("ignores a malformed model row instead of emitting a nameless option", () => {
    writeSettings(llmPiAi("    minimax:\n      models:\n        - id: ''\n        - id: 7\n        - nonsense\n"));
    expect(readDshModelCatalog({ HOME: home }).options.map((o) => o.id)).toEqual(STATIC_IDS);
  });

  it("honors DSH_HOME over HOME", () => {
    const alt = mkdtempSync(join(tmpdir(), "dsh-alt-home-"));
    try {
      // DSH_HOME is a home dir, so settings.yaml lives under its .dsh/.
      mkdirSync(join(alt, "elsewhere", ".dsh"), { recursive: true });
      writeFileSync(
        join(alt, "elsewhere", ".dsh", "settings.yaml"),
        "llm-pi-ai:\n  providers:\n    minimax:\n      models:\n        - id: MiniMax-M9\n",
        "utf8",
      );
      const catalog = readDshModelCatalog({ HOME: home, DSH_HOME: join(alt, "elsewhere") });
      expect(catalog.options.map((o) => o.id)).toContain("MiniMax-M9");
    } finally {
      removeTempDir(alt);
    }
  });

  it("reads the real install's settings.yaml without dropping a static row", () => {
    // Guards the regression this design exists to prevent: on a machine whose
    // profile declares only the minimax provider, a wholesale replace would
    // delete the DeepSeek rows.
    const real = readDshModelCatalog({});
    for (const id of STATIC_IDS) expect(real.options.map((o) => o.id)).toContain(id);
  });
});
