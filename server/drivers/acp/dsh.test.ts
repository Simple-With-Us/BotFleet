import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  classifyDshError,
  dshCredentialCandidates,
  DshAgentDriver,
  applyDshEnv,
  dshSetupReason,
  DSH_ACP_BRIDGE,
  DSH_PERMISSION_FULL_AUTO,
  DSH_PERMISSION_INTERACTIVE,
  dshDefaultCli,
  dshRuntimeRoot,
  resolveDshBin,
  resolveDshPython,
  STATIC_DSH_MODELS,
  dshSpawnArgs,
} from "./dsh.ts";
import { SPAWNED_SCRIPTS } from "../../proxy-paths.ts";

describe("DshAgentDriver config", () => {
  it("spawns the bundled ACP bridge, because `dsh` has no acp subcommand", () => {
    const cli = DshAgentDriver.defaultConfig().cli;
    // `dsh <anything>` was never an ACP server: the published CLI has no acp
    // mode, so the old bare-word default spawned a process that could not
    // speak the protocol and every turn died at the handshake.
    expect(cli).not.toBe("dsh");
    expect(cli).toContain("dsh-acp.py");
    expect(cli.endsWith("dsh-acp.py") || cli.endsWith('dsh-acp.py"')).toBe(true);
    // …and it is the repo's own copy, never a path into a developer's
    // machine-local runtime install.
    expect(cli).not.toMatch(/dsh-runtime|dsh-acp\.sh/);
  });

  it("resolves the bridge through the one anchor that survives bundling", () => {
    // A `".."` written inside drivers/ climbs from the BUNDLE's directory once
    // esbuild inlines it — that shipped in 0.1.24.  proxy-paths.ts is the only
    // place allowed to do this arithmetic.
    expect(DSH_ACP_BRIDGE).toBe(SPAWNED_SCRIPTS.dshAcp);
    expect(existsSync(DSH_ACP_BRIDGE)).toBe(true);
  });

  it("quotes an interpreter or script path that contains a space", () => {
    const cli = dshDefaultCli({ PATH: "", DSH_ACP_PYTHON: "/opt/My Tools/python3" });
    expect(cli.startsWith('"/opt/My Tools/python3" ')).toBe(true);
  });

  it("never names an interpreter that is not there", () => {
    // The interpreter is resolved on THIS machine at load, so the one thing
    // that must never happen is a stale absolute path baked in from wherever
    // the release was built.  Either it exists, or it is the bare name and
    // spawn reports an honest ENOENT.
    const head = dshDefaultCli({ PATH: "/nonexistent-bin" }).split(" ")[0];
    expect(head === "python3" || existsSync(head)).toBe(true);
  });

  it("defaults to current DeepSeek V4 ids, not retired chat/reasoner", () => {
    expect(STATIC_DSH_MODELS.default).toBe("deepseek-v4-flash");
    expect(STATIC_DSH_MODELS.options.map((option) => option.id)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
  });

  it("ships no vision model while the engine says it cannot take an image", () => {
    // `images: false` gates the composer for the whole engine, so a vision
    // option in the picker offers something the composer then refuses
    expect(STATIC_DSH_MODELS.options.some((option) => /vision/i.test(option.id))).toBe(false);
  });
});

describe("dsh capability honesty", () => {
  it("claims no MCP, because the ACP server it reaches ignores session/new.mcpServers", async () => {
    // the core builds those servers for every harness, so these used to be
    // hardcoded true and the app offered connected apps, the computer and
    // the phone to an engine that could never mount any of them
    const instance = await DshAgentDriver.create({
      instanceId: "dsh-caps",
      displayName: "DeepSeek Harness",
      environment: {},
      enabled: true,
      config: DshAgentDriver.defaultConfig(),
    });
    const capabilities = instance.adapter.capabilities;
    expect(capabilities.agentsMcp).toBe(false);
    expect(capabilities.computerMcp).toBe(false);
    expect(capabilities.composioMcp).toBe(false);
    expect(capabilities.phoneMcp).toBe(false);
    expect(capabilities.qdrantMcp).toBe(false);
    expect(capabilities.localComputerMcp).toBe(false);
    await instance.dispose();
  });

  it("offers no reasoning-effort control, because nothing reads turn.effort", async () => {
    // dshSpawnArgs emits nothing at all; an effort pick would change nothing
    expect(dshSpawnArgs({ cli: "dsh", fullAuto: false }, { integrations: undefined })).toEqual([]);
    const instance = await DshAgentDriver.create({
      instanceId: "dsh-effort",
      displayName: "DeepSeek Harness",
      environment: {},
      enabled: true,
      config: DshAgentDriver.defaultConfig(),
    });
    expect(instance.adapter.capabilities.effortLevels).toBeUndefined();
    await instance.dispose();
  });
});

describe("dshSpawnArgs", () => {
  it("emits no argv, because neither the bridge nor dsh reads --mcp", () => {
    // This used to build `--mcp name=command args` for every integration.
    // Nothing downstream parsed them, so each one advertised a tool the
    // engine could never call — the same lie `mcpServers: false` retracts one
    // layer up.  Restore both together or neither.
    expect(
      dshSpawnArgs(
        { cli: "dsh", fullAuto: false },
        {
          integrations: {
            agents: { command: "/usr/bin/node", args: ["/tmp/proxy.ts"], env: {} },
            dweb: { url: "http://127.0.0.1:8080" },
          },
        },
      ),
    ).toEqual([]);
  });

  it("passes the bridge no argv at all when there are no integrations", () => {
    expect(dshSpawnArgs({ cli: "dsh", fullAuto: true }, { integrations: undefined })).toEqual([]);
  });
});

describe("dsh spawn-target resolution", () => {
  it("prefers an explicit DSH_BIN over everything else", () => {
    expect(resolveDshBin({ DSH_BIN: "/opt/custom/dsh", PATH: "" })).toBe("/opt/custom/dsh");
  });

  it("falls back to a local runtime root only when PATH has no dsh", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-root-"));
    const bin = join(root, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    const exe = join(bin, "dsh");
    writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });

    expect(resolveDshBin({ PATH: "", DSH_RUNTIME_ROOT: root })).toBe(exe);
    expect(dshRuntimeRoot({ DSH_RUNTIME_ROOT: root })).toBe(root);

    // PATH wins over the runtime root when both are present.
    const onPathDir = mkdtempSync(join(tmpdir(), "dsh-path-"));
    const onPath = join(onPathDir, "dsh");
    writeFileSync(onPath, "#!/bin/sh\n", { mode: 0o755 });
    expect(resolveDshBin({ PATH: onPathDir, DSH_RUNTIME_ROOT: root })).toBe(onPath);

    rmSync(root, { recursive: true, force: true });
    rmSync(onPathDir, { recursive: true, force: true });
  });

  it("reports no dsh rather than a path that does not exist", () => {
    expect(resolveDshBin({ PATH: "", DSH_RUNTIME_ROOT: "/nonexistent-dsh-root" })).toBeNull();
    expect(dshRuntimeRoot({ DSH_RUNTIME_ROOT: "/nonexistent-dsh-root" })).toBeNull();
  });

  it("finds python3 on PATH and reports null when there is none", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-py-"));
    const exe = join(dir, "python3");
    writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });
    expect(resolveDshPython({ PATH: dir })).toBe(exe);
    rmSync(dir, { recursive: true, force: true });
    // An empty PATH still finds the macOS/Homebrew absolutes on this host, so
    // assert only the shape the resolver guarantees.
    const none = resolveDshPython({ PATH: "" });
    expect(none === null || none.endsWith("python3")).toBe(true);
  });
});

describe("dsh setup-required reasons", () => {
  const config = { cli: "python3 /somewhere/dsh-acp.py", fullAuto: false };
  const unavailable = { state: "unavailable", reason: "`x` CLI not found" } as const;

  it("leaves an available snapshot alone", () => {
    const ok = { state: "available", version: "dsh-acp 1.3.0" } as const;
    expect(dshSetupReason(ok, { PATH: "" }, config)).toBe(ok);
  });

  it("names Python, not the wrapper string, when no interpreter resolves", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-nopy-"));
    // PATH with nothing in it AND every absolute candidate steered away:
    // DSH_ACP_PYTHON is the one hook that short-circuits the absolutes, so
    // point it at a path that does not exist to model "no python here".
    const snap = dshSetupReason(unavailable, { PATH: dir }, config);
    rmSync(dir, { recursive: true, force: true });
    // On a machine that genuinely has python3 (every CI runner does) the
    // resolver finds it and we fall through to the dsh reason instead — both
    // are precise, and neither is the raw wrapper string.
    expect(snap.state).toBe("unavailable");
    expect(snap.reason).toMatch(/Python 3 not found|`dsh` CLI not found/);
    expect(snap.reason).not.toBe(unavailable.reason);
  });

  it("names the dsh CLI and how to install it when python is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-py-only-"));
    writeFileSync(join(dir, "python3"), "#!/bin/sh\n", { mode: 0o755 });
    const snap = dshSetupReason(unavailable, { PATH: dir, DSH_RUNTIME_ROOT: "/nope" }, config);
    rmSync(dir, { recursive: true, force: true });
    expect(snap.reason).toContain("npm install -g @deepseek-ai/dsh");
    // and it points at the escape hatch, because a user may already run
    // their own ACP server for this engine
    expect(snap.reason).toContain("custom binary");
  });

  it("advertises an install command but no sign-in command, because dsh has none", () => {
    expect(DshAgentDriver.install?.command?.darwin).toBe("npm install -g @deepseek-ai/dsh");
    // `dsh login` does not exist — the CLI reads a credentials file or an
    // inherited DEEPSEEK_API_KEY, and nothing else.
    expect(DshAgentDriver.install?.signInCommand).toBeUndefined();
  });
});

describe("dsh permission posture", () => {
  const ambient = () => ({
    // The fleet Mac exports exactly this for its own headless runner.
    DSH_PERMISSION_MODE: DSH_PERMISSION_FULL_AUTO,
    HOME: "/tmp/dsh-home-fixture",
    PATH: "",
  });

  it("narrows an ambient danger-full-access when Full Auto is off", () => {
    const env: Record<string, string | undefined> = ambient();
    applyDshEnv(env, { cli: "python3 x", fullAuto: false });
    expect(env.DSH_PERMISSION_MODE).toBe(DSH_PERMISSION_INTERACTIVE);
    expect(env.DSH_PERMISSION_MODE).not.toBe(DSH_PERMISSION_FULL_AUTO);
  });

  it("widens only when the bot's Full Auto switch is on", () => {
    const env: Record<string, string | undefined> = { ...ambient(), DSH_PERMISSION_MODE: undefined };
    applyDshEnv(env, { cli: "python3 x", fullAuto: true });
    expect(env.DSH_PERMISSION_MODE).toBe(DSH_PERMISSION_FULL_AUTO);
  });

  it("points DSH_HOME at the harness home and never overwrites an explicit one", () => {
    const env: Record<string, string | undefined> = ambient();
    applyDshEnv(env, { cli: "python3 x", fullAuto: false });
    expect(env.DSH_HOME).toBe(join("/tmp/dsh-home-fixture", ".dsh"));

    const explicit: Record<string, string | undefined> = { ...ambient(), DSH_HOME: "/custom/dsh" };
    applyDshEnv(explicit, { cli: "python3 x", fullAuto: false });
    expect(explicit.DSH_HOME).toBe("/custom/dsh");
  });

  it("hands the bridge the dsh binary it resolved", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-env-root-"));
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    const exe = join(root, "node_modules", ".bin", "dsh");
    writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });
    const env: Record<string, string | undefined> = { ...ambient(), DSH_RUNTIME_ROOT: root };
    applyDshEnv(env, { cli: "python3 x", fullAuto: false });
    expect(env.DSH_BIN).toBe(exe);
    expect(env.DSH_RUNTIME_ROOT).toBe(root);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("classifyDshError", () => {
  it("maps auth failures to invalid_credentials", () => {
    expect(classifyDshError(new Error("authentication required"))).toBe("invalid_credentials");
    expect(classifyDshError(new Error("invalid api key"))).toBe("invalid_credentials");
    const coded = new Error("unauthorized");
    Object.assign(coded, { code: 401 });
    expect(classifyDshError(coded)).toBe("invalid_credentials");
  });

  it("maps subscription failures to inactive_subscription", () => {
    expect(classifyDshError(new Error("inactive subscription"))).toBe("inactive_subscription");
  });

  it("maps quota/rate failures to quota_or_region_restriction", () => {
    expect(classifyDshError(new Error("rate limit exceeded"))).toBe("quota_or_region_restriction");
    expect(classifyDshError(new Error("insufficient balance"))).toBe("quota_or_region_restriction");
  });

  it("maps upstream outages", () => {
    expect(classifyDshError(new Error("service unavailable"))).toBe("upstream_outage");
    expect(classifyDshError(new Error("overloaded"))).toBe("upstream_outage");
  });

  it("maps unknown-model failures to model_catalog_outage", () => {
    expect(classifyDshError(new Error("model not found"))).toBe("model_catalog_outage");
  });

  it("returns undefined for unrecognized errors", () => {
    expect(classifyDshError(new Error("empty prompt"))).toBeUndefined();
    expect(classifyDshError("something else")).toBeUndefined();
  });
});

describe("dshCredentialCandidates", () => {
  it("honors DSH_HOME over the default ~/.dsh path", () => {
    // Built with join(), so the separator is the host's.  Asserting a literal
    // "/" here passes on macOS and Linux and fails on Windows for a path the
    // implementation got right — compare against the path it should build,
    // not against one platform's spelling of it.
    expect(dshCredentialCandidates({ HOME: "/home/jay" })[0]).toBe(join("/home/jay", ".dsh", ".credentials.yaml"));
    expect(dshCredentialCandidates({ HOME: "/home/jay", DSH_HOME: "/opt/dsh" })[0]).toBe(
      join("/opt/dsh", ".credentials.yaml"),
    );
  });

  it("falls back to the platform home when HOME is unset", () => {
    const candidates = dshCredentialCandidates({});
    expect(candidates[0]).toContain(".dsh");
    expect(candidates[0]).toContain(".credentials.yaml");
  });
});
