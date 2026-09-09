import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DATA_DIR,
  allowedBotComputers,
  filterAllowedComputers,
  instanceConfigs,
  isValidSshAlias,
  loadConfig,
  localVmMaxInstances,
  parseConfigPatch,
  parseStoredConfig,
  saveConfig,
  roomTurnTimeoutMinutes,
  showToolCallsEnabled,
  summarizeToolCallsEnabled,
  skillRecorderEnabled,
  stripWorkspaceCredentialEnv,
  syncCredentialEnv,
  vpsSshAlias,
  patchInstanceConfig,
  WORKSPACE_CREDENTIAL_ENV,
  autoUpdateDue,
  AUTO_UPDATE_THROTTLE_MS,
  publicIngressUrl,
  publicIngressUrlEffective,
  isSentryDsn,
  observabilityEnabled,
  observabilitySettings,
  sentryDsnConfigured,
  DEFAULT_SENTRY_TRACES_SAMPLE_RATE,
  MAX_OBSERVABILITY_ENVIRONMENT_LENGTH,
  DEFAULT_INFISICAL_ENVIRONMENT,
  DEFAULT_INFISICAL_REFRESH_MINUTES,
  DEFAULT_INFISICAL_SECRET_PATH,
  DEFAULT_INFISICAL_SITE_URL,
  infisicalConfigured,
  infisicalEnabled,
  infisicalSettings,
  isHttpsUrl,
  type AppConfig,
} from "./config.ts";
import { isSentryDsn as isBrowserSentryDsn } from "../src/lib/observability-config.ts";

// Obviously fake, and never sent anywhere: these exist so the assertions
// below have a DSN-shaped string to work on.
const SENTINEL_DSN = "https://abc123@o0.ingest.sentry.io/1";

describe("configuration boundaries", () => {
  it("keeps supported stored settings and drops unrelated top-level data", () => {
    expect(
      parseStoredConfig({
        profile: { name: "Ada", email: "ada@example.com" },
        instances: { claude: { driver: "claudeAgent", config: { cli: "/opt/claude" } } },
        unrelated: { secret: "not part of the config contract" },
      }),
    ).toEqual({
      profile: { name: "Ada", email: "ada@example.com" },
      instances: { claude: { driver: "claudeAgent", config: { cli: "/opt/claude" } } },
    });
  });

  it("rejects malformed stored instances and API patches", () => {
    expect(() => parseStoredConfig({ instances: { claude: { driver: 42 } } })).toThrow("instances.claude.driver");
    expect(() => parseConfigPatch({ opencodeGo: { apiKey: 42 } })).toThrow("opencodeGo.apiKey");
    expect(() => parseConfigPatch({ profile: [] })).toThrow("profile");
    expect(() => parseConfigPatch({ usage: { ingestUrl: "usage.example.com" } })).toThrow(
      "usage.ingestUrl must be an absolute http(s) URL",
    );
    expect(parseConfigPatch({ usage: { ingestUrl: "https://usage.example.com", ingestToken: "tok" } })).toEqual({
      usage: { ingestUrl: "https://usage.example.com", ingestToken: "tok" },
    });
    expect(parseConfigPatch({ usage: { ingestUrl: "" } })).toEqual({ usage: { ingestUrl: "" } });
  });

  it("accepts only a simple VPS SSH config alias and exposes no credentials", () => {
    expect(isValidSshAlias("production-vps")).toBe(true);
    expect(isValidSshAlias("prod; reboot")).toBe(false);
    expect(() => parseConfigPatch({ vps: { sshAlias: "prod; reboot" } })).toThrow("vps.sshAlias");
    expect(parseConfigPatch({ vps: { sshAlias: "production-vps" } })).toEqual({
      vps: { sshAlias: "production-vps" },
    });
    expect(vpsSshAlias({ vps: { sshAlias: "production-vps" } })).toBe("production-vps");
    expect(vpsSshAlias({ vps: { sshAlias: "-bad" } })).toBeNull();
  });

  it("accepts a persisted global room turn timeout and supplies the legacy default", () => {
    expect(parseStoredConfig({ rooms: { turnTimeoutMinutes: 20 } })).toEqual({
      rooms: { turnTimeoutMinutes: 20 },
    });
    expect(roomTurnTimeoutMinutes({ rooms: { turnTimeoutMinutes: 20 } })).toBe(20);
    expect(roomTurnTimeoutMinutes({})).toBe(5);
  });

  it.each([0, 1.5, 1441, "20", null])(
    "rejects an invalid room turn timeout: %j",
    (turnTimeoutMinutes) => {
      expect(() => parseConfigPatch({ rooms: { turnTimeoutMinutes } })).toThrow(
        "rooms.turnTimeoutMinutes",
      );
    },
  );

  it("accepts localVm maxInstances patch", () => {
    expect(localVmMaxInstances({})).toBe(2);
    expect(parseConfigPatch({ localVm: { maxInstances: 4 } })).toEqual({
      localVm: { maxInstances: 4 },
    });
    expect(localVmMaxInstances({ localVm: { maxInstances: 3 } })).toBe(3);
  });

  it("keeps experimental features off by default and accepts an explicit opt-in", () => {
    expect(skillRecorderEnabled({})).toBe(false);
    expect(parseConfigPatch({ features: { skillRecorder: true } })).toEqual({
      features: { skillRecorder: true },
    });
    expect(skillRecorderEnabled({ features: { skillRecorder: true } })).toBe(true);
    expect(() => parseConfigPatch({ features: { skillRecorder: "yes" } })).toThrow(
      "features.skillRecorder",
    );
  });

  it("shows tool steps by default and accepts an explicit opt-out", () => {
    // they carry the file, the command and the duration now — see
    // shared/tool-activity.ts for why that flipped the default
    expect(showToolCallsEnabled({})).toBe(true);
    expect(parseConfigPatch({ features: { showToolCalls: false } })).toEqual({
      features: { showToolCalls: false },
    });
    expect(showToolCallsEnabled({ features: { showToolCalls: false } })).toBe(false);
    expect(showToolCallsEnabled({ features: { showToolCalls: true } })).toBe(true);
  });

  it("defaults summarizeToolCalls to true and accepts explicit toggle", () => {
    expect(summarizeToolCallsEnabled({})).toBe(true);
    expect(summarizeToolCallsEnabled({ features: { summarizeToolCalls: false } })).toBe(false);
    expect(summarizeToolCallsEnabled({ features: { summarizeToolCalls: true } })).toBe(true);
  });

  it.each([0, 1.5, 5, "2", null])("rejects an invalid per-bot VM limit: %j", (maxInstances) => {
    expect(() => parseConfigPatch({ localVm: { maxInstances } })).toThrow("localVm.maxInstances");
  });

  it.each(["one-per-bot", "windows", 1, null])("rejects an invalid Local VM mode: %j", (mode) => {
    expect(() => parseConfigPatch({ localVm: { mode } })).toThrow("localVm.mode");
  });
});

describe("default fleet", () => {
  it("ships Qwen and Hermes as custom-only engines", () => {
    const map = instanceConfigs({});
    expect(map.qwen).toEqual({ driver: "qwenAgent", environment: {} });
    expect(map.hermes).toEqual({ driver: "hermesAgent", environment: {} });
  });

  it("ships Cursor as a default-fleet subscription engine", () => {
    const map = instanceConfigs({});
    expect(map.cursor).toEqual({ driver: "cursorAgent", environment: {} });
  });

  it("ships MiniMax CLI as a default-fleet engine", () => {
    const map = instanceConfigs({});
    expect(map.minimax).toEqual({ driver: "minimax", environment: {} });
    const existing = instanceConfigs({ instances: { claude: { driver: "claudeAgent" } } });
    expect(existing.minimax?.driver).toBe("minimax");
  });

  it("carries the saved OpenAI-compatible URL into the live default instance", () => {
    const map = instanceConfigs({
      openaiCompat: { key: "secret", url: "https://models.example.test/v1" },
    });
    expect(map.openaiCompat.config).toEqual({ url: "https://models.example.test/v1" });
    expect(map.openaiCompat.environment).toEqual({
      OPENAI_COMPAT_API_KEY: "secret",
      OPENAI_COMPAT_URL: "https://models.example.test/v1",
    });
  });

  it("preserves a per-instance OpenAI-compatible URL override", () => {
    const map = instanceConfigs({
      openaiCompat: { url: "https://workspace.example.test/v1" },
      instances: {
        custom: {
          driver: "openai-compat",
          config: { url: "https://instance.example.test/v1", apiKeyEnv: "CUSTOM_KEY" },
        },
      },
    });
    expect(map.custom.config).toEqual({
      url: "https://instance.example.test/v1",
      apiKeyEnv: "CUSTOM_KEY",
    });
  });

  it("does not retain an injected OpenAI-compatible URL across config refreshes", () => {
    const config: AppConfig = {
      openaiCompat: { url: "https://first.example.test/v1" },
      instances: {
        custom: { driver: "openai-compat" },
      },
    };

    expect(instanceConfigs(config).custom.config).toEqual({
      url: "https://first.example.test/v1",
    });
    config.openaiCompat = { url: "https://second.example.test/v1" };
    expect(instanceConfigs(config).custom.config).toEqual({
      url: "https://second.example.test/v1",
    });
    expect(config.instances?.custom.config).toBeUndefined();
  });

  it("adds missing custom-only engines onto an existing product fleet", () => {
    const map = instanceConfigs({ instances: { claude: { driver: "claudeAgent" } } });
    expect(map.claude.driver).toBe("claudeAgent");
    expect(map.qwen?.driver).toBe("qwenAgent");
    expect(map.hermes?.driver).toBe("hermesAgent");
    expect(map.cursor?.driver).toBe("cursorAgent");
    expect(map.openaiCompat?.driver).toBe("openai-compat");
  });

  it("does not expand a one-off shadow fleet", () => {
    const map = instanceConfigs({ instances: { ghost: { driver: "not-a-real-driver" } } });
    expect(Object.keys(map)).toEqual(["ghost"]);
  });
});

describe("Instance CLI override", () => {
  it("sets, replaces, and clears config.cli on a default-fleet instance", () => {
    const cfg: AppConfig = {};
    const set = patchInstanceConfig(cfg, "claude", { cli: "/opt/claude-2.1/bin/claude" });
    expect(set.ok).toBe(true);
    expect(set.config.instances!.claude.config).toEqual({ cli: "/opt/claude-2.1/bin/claude" });

    const replaced = patchInstanceConfig(set.config, "claude", { cli: "~/bin/claude" });
    expect(replaced.config.instances!.claude.config).toEqual({ cli: "~/bin/claude" });

    const cleared = patchInstanceConfig(replaced.config, "claude", { cli: "" });
    expect(cleared.config.instances!.claude.config).toBeUndefined();
  });

  it("preserves sibling config keys when clearing only cli", () => {
    const cfg: AppConfig = {
      instances: { claude: { driver: "claudeAgent", config: { cli: "/x/claude", permissionMode: "bypassPermissions" } } },
    };
    const cleared = patchInstanceConfig(cfg, "claude", { cli: "" });
    expect(cleared.config.instances!.claude.config).toEqual({ permissionMode: "bypassPermissions" });
  });

  it("leaves the original config untouched and rejects unknown instances", () => {
    const cfg: AppConfig = { instances: { codex: { driver: "codex" } } };
    const result = patchInstanceConfig(cfg, "codex", { cli: "/new/codex" });
    expect(result.config.instances!.codex.config).toEqual({ cli: "/new/codex" });
    expect(cfg.instances!.codex.config).toBeUndefined();

    expect(patchInstanceConfig(cfg, "nope", { cli: "/x" }).ok).toBe(false);
  });

  it("never persists the credential env instanceConfigs injects", () => {
    // instanceConfigs() copies each credential into its consuming driver's
    // environment for the live fleet; patchInstanceConfig must strip those pairs
    // back out, or saving a CLI override would copy secrets into the
    // instances section of config.json.
    const cfg: AppConfig = {
      xai: { key: "SECRET-XAI" },
      box: { token: "SECRET-BOX" },
      opencodeGo: { apiKey: "SECRET-OCG" },
      instances: {
        claude: { driver: "claudeAgent" },
        grokApi: { driver: "grok" },
        computer: { driver: "boxAgent" },
        opencode: { driver: "opencodeGo" },
      },
    };
    const set = patchInstanceConfig(cfg, "claude", { cli: "/opt/claude" });
    expect(set.ok).toBe(true);
    for (const entry of Object.values(set.config.instances!)) {
      expect(entry.environment ?? {}).toEqual({});
    }
    // user-authored env survives
    const custom = { instances: { claude: { driver: "claudeAgent", environment: { MY_FLAG: "1" } } } };
    const kept = patchInstanceConfig(custom, "claude", { cli: "/x" });
    expect(kept.config.instances!.claude.environment).toEqual({ MY_FLAG: "1" });
  });
});

describe("Instance enable/disable", () => {
  it("sets enabled=false on a default-fleet instance", () => {
    const cfg: AppConfig = {};
    const result = patchInstanceConfig(cfg, "claude", { enabled: false });
    expect(result.ok).toBe(true);
    expect(result.config.instances!.claude.enabled).toBe(false);
  });

  it("re-enabling clears the flag entirely so it round-trips like a fresh install", () => {
    const cfg: AppConfig = { instances: { claude: { driver: "claudeAgent", enabled: false } } };
    const result = patchInstanceConfig(cfg, "claude", { enabled: true });
    expect(result.ok).toBe(true);
    // The field is GONE on disk after re-enable, not `enabled: true` —
    // matches `entry.enabled !== false` in registry.load.
    expect(result.config.instances!.claude.enabled).toBeUndefined();
  });

  it("preserves a per-instance CLI override when toggling enabled", () => {
    const cfg: AppConfig = {
      instances: { claude: { driver: "claudeAgent", config: { cli: "/opt/claude" } } },
    };
    const off = patchInstanceConfig(cfg, "claude", { enabled: false });
    expect(off.config.instances!.claude.config).toEqual({ cli: "/opt/claude" });
    expect(off.config.instances!.claude.enabled).toBe(false);

    const back = patchInstanceConfig(off.config, "claude", { enabled: true });
    expect(back.config.instances!.claude.config).toEqual({ cli: "/opt/claude" });
    expect(back.config.instances!.claude.enabled).toBeUndefined();
  });

  it("rejects an unknown instance", () => {
    const cfg: AppConfig = {};
    expect(patchInstanceConfig(cfg, "nope", { enabled: false }).ok).toBe(false);
  });
});

describe("OpenCode Go configuration", () => {
  it("injects the key only into OpenCode Go instances", () => {
    const cfg: AppConfig = {
      opencodeGo: { apiKey: "secret-value" },
      instances: {
        opencode: { driver: "opencodeGo" },
        grok: { driver: "grokAgent" },
      },
    };

    const instances = instanceConfigs(cfg);
    expect(instances.opencode.environment).toEqual({ OPENCODE_API_KEY: "secret-value" });
    expect(instances.grok.environment).toEqual({});
  });
});

describe("credential env narrowing", () => {
  it("injects each credential only into the driver that consumes it", () => {
    const cfg: AppConfig = {
      xai: { key: "SECRET-XAI" },
      box: { token: "SECRET-BOX" },
      opencodeGo: { apiKey: "SECRET-OCG" },
      instances: {
        grokApi: { driver: "grok" },
        computer: { driver: "boxAgent" },
        opencode: { driver: "opencodeGo" },
        claude: { driver: "claudeAgent" },
        codex: { driver: "codex" },
      },
    };
    const instances = instanceConfigs(cfg);
    expect(instances.grokApi.environment).toEqual({ XAI_API_KEY: "SECRET-XAI" });
    expect(instances.computer.environment).toEqual({ BOX_TOKEN: "SECRET-BOX" });
    expect(instances.opencode.environment).toEqual({ OPENCODE_API_KEY: "SECRET-OCG" });
    // engines that bring their own login receive NO workspace credential
    expect(instances.claude.environment).toEqual({});
    expect(instances.codex.environment).toEqual({});
  });

  it("hands no credential to any default-fleet CLI engine except the Computer", () => {
    // the default `grok` instance is the CLI-login grokAgent, not the
    // API-key driver, so a configured xai key reaches nobody by default
    const cfg: AppConfig = { xai: { key: "SECRET-XAI" }, box: { token: "SECRET-BOX" } };
    const instances = instanceConfigs(cfg);
    for (const [id, entry] of Object.entries(instances)) {
      if (id === "computer") expect(entry.environment).toEqual({ BOX_TOKEN: "SECRET-BOX" });
      else expect(entry.environment).toEqual({});
    }
  });

  it("keeps a per-instance environment while layering the credential on top", () => {
    const cfg: AppConfig = {
      box: { token: "SECRET-BOX" },
      instances: { computer: { driver: "boxAgent", environment: { MY_FLAG: "1" } } },
    };
    expect(instanceConfigs(cfg).computer.environment).toEqual({ MY_FLAG: "1", BOX_TOKEN: "SECRET-BOX" });
  });
});

describe("credential env preference", () => {
  const VARS = [
    "XAI_API_KEY",
    "OPENAI_COMPAT_API_KEY",
    "OPENAI_COMPAT_URL",
    "BOX_TOKEN",
    "OPENCODE_API_KEY",
    "OMB_TTS_KEY",
    "OMB_OPENAI_IMAGE_KEY",
    "COMPOSIO_API_KEY",
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_URL",
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
    for (const name of VARS) delete process.env[name];
    mkdirSync(DATA_DIR, { recursive: true });
    rmSync(join(DATA_DIR, "config.json"), { force: true });
  });
  afterEach(() => {
    for (const name of VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    rmSync(join(DATA_DIR, "config.json"), { force: true });
  });

  it("prefers env over the config file for every credential", () => {
    // the desktop shell hands secrets to this process as env (from its
    // OS-encrypted store) and leaves the file without them — env must win
    // even over a leftover plaintext value
    writeFileSync(
      join(DATA_DIR, "config.json"),
      JSON.stringify({
        xai: { key: "file-xai", url: "https://api.example.test/v1" },
        box: { token: "file-box" },
        opencodeGo: { apiKey: "file-ocg" },
        tts: { key: "file-tts", voice: "narrator" },
        imageGen: { key: "file-image" },
      }),
    );
    process.env.XAI_API_KEY = "env-xai";
    process.env.BOX_TOKEN = "env-box";
    process.env.OPENCODE_API_KEY = "env-ocg";
    process.env.OMB_TTS_KEY = "env-tts";
    process.env.OMB_OPENAI_IMAGE_KEY = "env-image";
    process.env.DEEPSEEK_API_KEY = "env-deepseek";
    process.env.DEEPSEEK_URL = "https://env.example.test";
    const cfg = loadConfig();
    expect(cfg.xai).toEqual({ key: "env-xai", url: "https://api.example.test/v1" });
    expect(cfg.box).toEqual({ token: "env-box" });
    expect(cfg.opencodeGo).toEqual({ apiKey: "env-ocg" });
    expect(cfg.tts).toEqual({ key: "env-tts", voice: "narrator" });
    expect(cfg.imageGen).toEqual({ key: "env-image" });
    expect(cfg.deepseek).toEqual({ key: "env-deepseek", url: "https://env.example.test" });
  });

  it("falls back to the config file when the env var is unset (dev mode)", () => {
    writeFileSync(
      join(DATA_DIR, "config.json"),
      JSON.stringify({
        xai: { key: "file-xai" },
        tts: { key: "file-tts" },
        imageGen: { key: "file-image" },
        deepseek: { key: "file-deepseek" },
      }),
    );
    const cfg = loadConfig();
    expect(cfg.xai?.key).toBe("file-xai");
    expect(cfg.tts?.key).toBe("file-tts");
    expect(cfg.imageGen?.key).toBe("file-image");
    expect(cfg.deepseek?.key).toBe("file-deepseek");
  });

  it("treats a blanked file field as absent when env supplies the secret", () => {
    // after migration the desktop shell may leave "" behind (a cleared key
    // that was saved mid-session); the env-injected value must still win
    writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ xai: { key: "" } }));
    process.env.XAI_API_KEY = "env-xai";
    expect(loadConfig().xai?.key).toBe("env-xai");
  });

  it("round-trips a DeepSeek key through the packaged app's external-secret tombstone", () => {
    // Mirrors the exact index.ts externalSecretStorage flow: the desktop
    // shell commits the key to credentials.bin, config.json gets the empty
    // tombstone, and syncCredentialEnv is the only thing standing between
    // that "" and configStatus.deepseek.configured reading false forever.
    process.env.DEEPSEEK_API_KEY = "boot-injected";
    writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ deepseek: { key: "" } }));
    syncCredentialEnv({ deepseek: { key: "just-saved" } });
    expect(loadConfig().deepseek?.key).toBe("just-saved");
  });

  it("syncCredentialEnv keeps process.env in step with a credential save", () => {
    process.env.XAI_API_KEY = "boot-injected";
    process.env.BOX_TOKEN = "boot-injected";
    process.env.COMPOSIO_API_KEY = "boot-injected";
    process.env.DEEPSEEK_API_KEY = "boot-injected";
    syncCredentialEnv({
      xai: { key: "just-saved" },
      composio: { apiKey: "ak_just_saved" },
      box: { token: "" },
      deepseek: { key: "ds-just-saved" },
      profile: { name: "Ada" },
    });
    // a saved value replaces the boot-time one; a cleared value drops it;
    // untouched sections change nothing
    expect(process.env.XAI_API_KEY).toBe("just-saved");
    expect(process.env.COMPOSIO_API_KEY).toBe("ak_just_saved");
    expect(process.env.BOX_TOKEN).toBeUndefined();
    expect(process.env.OMB_TTS_KEY).toBeUndefined();
    expect(process.env.DEEPSEEK_API_KEY).toBe("ds-just-saved");
  });

  it("syncCredentialEnv keeps the DeepSeek URL in step, clearing it on an explicit blank", () => {
    process.env.DEEPSEEK_URL = "https://boot.example.test";
    syncCredentialEnv({ deepseek: { url: "https://just-saved.example.test" } });
    expect(process.env.DEEPSEEK_URL).toBe("https://just-saved.example.test");
    syncCredentialEnv({ deepseek: { url: "" } });
    expect(process.env.DEEPSEEK_URL).toBeUndefined();
  });
});

describe("saveConfig section merge", () => {
  beforeEach(() => {
    mkdirSync(DATA_DIR, { recursive: true });
    rmSync(join(DATA_DIR, "config.json"), { force: true });
  });
  afterEach(() => {
    rmSync(join(DATA_DIR, "config.json"), { force: true });
  });

  it("persists usage URL and token, and a later URL-only patch keeps the token", () => {
    saveConfig({ usage: { ingestUrl: "https://usage.example.com", ingestToken: "tok_abc" } });
    expect(loadConfig().usage).toMatchObject({
      ingestUrl: "https://usage.example.com",
      ingestToken: "tok_abc",
    });

    saveConfig({ usage: { ingestUrl: "https://usage.example.com/app" } });
    expect(loadConfig().usage).toMatchObject({
      ingestUrl: "https://usage.example.com/app",
      ingestToken: "tok_abc",
    });
  });

  it("persists qdrant URL and api key the same way", () => {
    saveConfig({
      qdrant: { url: "https://qdrant.example.com", apiKey: "qk", collection: "fleet-agents" },
    });
    expect(loadConfig().qdrant).toMatchObject({
      url: "https://qdrant.example.com",
      apiKey: "qk",
      collection: "fleet-agents",
    });

    saveConfig({ qdrant: { collection: "other" } });
    expect(loadConfig().qdrant).toMatchObject({
      url: "https://qdrant.example.com",
      apiKey: "qk",
      collection: "other",
    });
  });

  it("persists the observability section, and a toggle-only patch keeps the DSN", () => {
    saveConfig({ observability: { sentryDsn: SENTINEL_DSN, environment: "operator" } });
    expect(loadConfig().observability).toMatchObject({
      sentryDsn: SENTINEL_DSN,
      environment: "operator",
    });

    // the kill switch and the sample rate are edited on their own in
    // Settings; neither may wipe the stored key on the way through
    saveConfig({ observability: { enabled: false, tracesSampleRate: 0 } });
    expect(loadConfig().observability).toMatchObject({
      sentryDsn: SENTINEL_DSN,
      environment: "operator",
      enabled: false,
      tracesSampleRate: 0,
    });
    expect(sentryDsnConfigured(loadConfig())).toBe(SENTINEL_DSN);
    expect(observabilityEnabled(loadConfig())).toBe(false);

    // and clearing is explicit: an empty string is the documented remove path
    saveConfig({ observability: { sentryDsn: "" } });
    expect(sentryDsnConfigured(loadConfig())).toBeNull();
  });

  it("persists the ingress URL, and an explicit empty string clears it", () => {
    saveConfig({ ingress: { publicUrl: "https://agents.example.com", enabled: true } });
    expect(loadConfig().ingress).toMatchObject({
      publicUrl: "https://agents.example.com",
      enabled: true,
    });

    // toggling the switch on its own must not wipe the stored URL -- same
    // rule as observability's kill switch above
    saveConfig({ ingress: { enabled: false } });
    expect(loadConfig().ingress).toMatchObject({
      publicUrl: "https://agents.example.com",
      enabled: false,
    });
    expect(publicIngressUrl(loadConfig())).toBe("https://agents.example.com");

    // clearing is explicit: the client sends the trimmed field including ""
    // (never `undefined`, which JSON.stringify drops from the request body
    // entirely and saveConfig's `Object.assign(merged, section)` merge then
    // reads as "field not present in this patch, leave the old value").
    // Regression: the client used to send `publicUrl: trimmed || undefined`,
    // so clearing the Settings input silently kept serving the old URL.
    saveConfig({ ingress: { publicUrl: "", enabled: true } });
    expect(loadConfig().ingress).toMatchObject({ publicUrl: "", enabled: true });
    expect(publicIngressUrl(loadConfig())).toBeNull();
  });
});

describe("workspace credential env strip", () => {
  it("removes every workspace credential from a child env in place", () => {
    const env = {
      PATH: "/usr/bin",
      MY_FLAG: "1",
      ...Object.fromEntries(WORKSPACE_CREDENTIAL_ENV.map((name) => [name, "secret"])),
    };
    stripWorkspaceCredentialEnv(env);
    expect(env).toEqual({ PATH: "/usr/bin", MY_FLAG: "1" });
  });

  it("covers the box token and voice key, which no engine CLI may inherit", () => {
    // these two have no per-driver ACP allowlist entry anywhere — they are
    // consumed in-process (Computer driver / voice module), never by a CLI
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("BOX_TOKEN");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("OMB_TTS_KEY");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("OMB_OPENAI_IMAGE_KEY");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("DEEPSEEK_API_KEY");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("DEEPSEEK_URL");
  });
});

describe("operator-level computer allowlist", () => {
  it("returns null when the allowlist is absent, so legacy installs pass through", () => {
    // The shipped default: every destination is allowed, and the runtime
    // never sees the allowlist at all.  This is what an upgraded install
    // looks like until the operator narrows the toggle.
    expect(allowedBotComputers({})).toBeNull();
    expect(allowedBotComputers({ botDefaults: { computers: ["cloud", "local"] } })).toBeNull();
  });

  it("de-duplicates the allowlist while preserving the operator's order", () => {
    expect(
      allowedBotComputers({ botDefaults: { allowedComputers: ["local", "vm", "local", "cloud"] } }),
    ).toEqual(["local", "vm", "cloud"]);
  });

  it("treats an empty allowlist as a real, persisted nothing-is-allowed", () => {
    expect(allowedBotComputers({ botDefaults: { allowedComputers: [] } })).toEqual([]);
  });

  it("filters a granted set through the allowlist and keeps the input order", () => {
    // A bot granted [local, vm, cloud] with the operator's allowlist set to
    // [cloud, vm] should land on [vm, cloud] — the allowlist does not
    // re-order, it only drops.
    expect(filterAllowedComputers(["local", "vm", "cloud"], ["cloud", "vm"])).toEqual([
      "vm",
      "cloud",
    ]);
  });

  it("passes everything through when the allowlist is null", () => {
    expect(filterAllowedComputers(["local", "vm", "cloud"], null)).toEqual(["local", "vm", "cloud"]);
  });

  it("returns an empty list when nothing in the grant is allowed", () => {
    expect(filterAllowedComputers(["local", "vm"], ["cloud"])).toEqual([]);
  });

  it("persists allowedComputers through the schema and the round-trip", () => {
    expect(parseConfigPatch({ botDefaults: { allowedComputers: ["local"] } })).toEqual({
      botDefaults: { allowedComputers: ["local"] },
    });
    expect(() => parseConfigPatch({ botDefaults: { allowedComputers: ["box"] } })).toThrow(
      "botDefaults.allowedComputers",
    );
  });

  it("accepts null as the not-narrowed allowlist, which every fresh install sends", () => {
    // The settings panel carries the whole botDefaults block on every save,
    // so an install that has never narrowed the allowlist sent null with each
    // unrelated change — and the schema answered 400, which made changing the
    // New Bots default or the cloud backend impossible on a fresh install.
    expect(parseConfigPatch({ botDefaults: { allowedComputers: null } })).toEqual({
      botDefaults: { allowedComputers: null },
    });
    expect(allowedBotComputers({ botDefaults: { allowedComputers: null } })).toBeNull();
  });

  it("clears a stored allowlist on null instead of merging it forward", () => {
    // Omitting the key would not do this: the section merge keeps whatever is
    // on disk, so re-enabling the last destination would appear to work and
    // come back narrowed on the next load.
    mkdirSync(DATA_DIR, { recursive: true });
    rmSync(join(DATA_DIR, "config.json"), { force: true });
    try {
      saveConfig({ botDefaults: { computers: ["cloud"], allowedComputers: ["cloud"] } });
      expect(allowedBotComputers(loadConfig())).toEqual(["cloud"]);

      saveConfig({ botDefaults: { allowedComputers: null } });
      const after = loadConfig();
      expect(allowedBotComputers(after)).toBeNull();
      // and only the allowlist is cleared — the workspace default stands.
      expect(after.botDefaults?.computers).toEqual(["cloud"]);
    } finally {
      rmSync(join(DATA_DIR, "config.json"), { force: true });
    }
  });
});

describe("autoUpdate throttle", () => {
  it("treats the first run as due when no lastCheckMs is recorded and the toggle is on", () => {
    const now = 1_700_000_000_000;
    expect(autoUpdateDue({ autoUpdate: { enabled: true } }, now)).toBe(true);
    expect(autoUpdateDue({ autoUpdate: { enabled: true, lastCheckMs: -1 } }, now)).toBe(true);
    expect(autoUpdateDue({ autoUpdate: { enabled: true, lastCheckMs: Number.NaN } }, now)).toBe(true);
  });

  it("refuses to run when the toggle is off, even if no lastCheckMs is recorded", () => {
    const now = 1_700_000_000_000;
    // no autoUpdate at all = the user has not opted in
    expect(autoUpdateDue({}, now)).toBe(false);
    expect(autoUpdateDue({ autoUpdate: {} }, now)).toBe(false);
    expect(autoUpdateDue({ autoUpdate: { enabled: undefined } }, now)).toBe(false);
  });

  it("blocks a run inside the 6-hour window", () => {
    const now = 1_700_000_000_000;
    expect(autoUpdateDue({ autoUpdate: { enabled: true, lastCheckMs: now - 1 } }, now)).toBe(false);
    expect(
      autoUpdateDue(
        { autoUpdate: { enabled: true, lastCheckMs: now - (AUTO_UPDATE_THROTTLE_MS - 1) } },
        now,
      ),
    ).toBe(false);
  });

  it("allows a run at or after the 6-hour mark", () => {
    const now = 1_700_000_000_000;
    expect(
      autoUpdateDue({ autoUpdate: { enabled: true, lastCheckMs: now - AUTO_UPDATE_THROTTLE_MS } }, now),
    ).toBe(true);
    expect(
      autoUpdateDue(
        { autoUpdate: { enabled: true, lastCheckMs: now - (AUTO_UPDATE_THROTTLE_MS + 60_000) } },
        now,
      ),
    ).toBe(true);
  });

  it("refuses to run when the autoUpdate toggle is off", () => {
    const now = 1_700_000_000_000;
    expect(autoUpdateDue({ autoUpdate: { enabled: false, lastCheckMs: now - 60_000 } }, now)).toBe(false);
  });

  it("round-trips the new fields through the patch parser", () => {
    const parsed = parseConfigPatch({ autoUpdate: { enabled: true, lastCheckMs: 1700000000000, lastAppFingerprint: "1.0.30:abc123" } });
    expect(parsed.autoUpdate).toEqual({
      enabled: true,
      lastCheckMs: 1700000000000,
      lastAppFingerprint: "1.0.30:abc123",
    });
  });

  it("rejects a negative lastCheckMs so a corrupt value cannot pin the throttle open", () => {
    expect(() =>
      parseConfigPatch({ autoUpdate: { lastCheckMs: -5 } }),
    ).toThrow();
  });
});

describe("public ingress URL", () => {
  it("returns the trimmed URL on the raw helper and null when disabled", () => {
    expect(publicIngressUrl({ ingress: { publicUrl: "https://hooks.example.com/" } })).toBe(
      "https://hooks.example.com",
    );
    expect(publicIngressUrl({ ingress: { publicUrl: "  https://hooks.example.com/abc/  " } })).toBe(
      "https://hooks.example.com/abc",
    );
    expect(publicIngressUrl({})).toBeNull();
    expect(publicIngressUrl({ ingress: { publicUrl: "not-a-url" } })).toBeNull();
  });

  it("publicIngressUrlEffective returns null when the URL is disabled, even if saved", () => {
    expect(
      publicIngressUrlEffective({ ingress: { publicUrl: "https://hooks.example.com", enabled: false } }),
    ).toBeNull();
    // an absent flag defaults to on, so a config written by an older build
    // keeps applying its URL
    expect(
      publicIngressUrlEffective({ ingress: { publicUrl: "https://hooks.example.com" } }),
    ).toBe("https://hooks.example.com");
    expect(publicIngressUrlEffective({})).toBeNull();
  });
});

describe("observability settings", () => {
  let savedEnv: Record<string, string | undefined>;
  const ENV_NAMES = ["SENTRY_ENV", "SENTRY_TRACES_SAMPLE_RATE", "NODE_ENV"] as const;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
    for (const name of ENV_NAMES) delete process.env[name];
  });
  afterEach(() => {
    for (const name of ENV_NAMES) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  it("accepts a real DSN and rejects the shapes the SDK would silently ignore", () => {
    expect(isSentryDsn(SENTINEL_DSN)).toBe(true);
    // http, no public key, and no project id each leave the SDK inert
    expect(isSentryDsn("http://abc123@o0.ingest.sentry.io/1")).toBe(false);
    expect(isSentryDsn("https://o0.ingest.sentry.io/1")).toBe(false);
    expect(isSentryDsn("https://abc123@o0.ingest.sentry.io")).toBe(false);
    expect(isSentryDsn("")).toBe(false);
    expect(isSentryDsn("not a url")).toBe(false);
    expect(isSentryDsn("   ")).toBe(false);
  });

  // @sentry/core matches a DSN against its own `DSN_REGEX` — public key
  // `\w+`, host `[\w.-]+` or a bracketed IPv6 literal — and answers a string
  // that fails it by printing the WHOLE DSN, public key included, through
  // `console.error` before returning nothing.  `Sentry.init` does not throw
  // on that; it builds a client holding no DSN and captures nothing.  So a
  // shape this check waves through is both a credential in the harness log
  // on every boot and a fleet that reports itself watched while it is not.
  it("rejects the shapes @sentry/core's own parser would print and then discard", () => {
    // a UUID-shaped public key: hyphens fail `\w+`
    expect(isSentryDsn("https://a1b2c3d4-e5f6-47a8-9b0c-1d2e3f4a5b6c@o123.ingest.sentry.io/456")).toBe(false);
    // a dotted key fails it too
    expect(isSentryDsn("https://abc.123@o0.ingest.sentry.io/1")).toBe(false);
    // `validateDsn` insists the project id is all digits
    expect(isSentryDsn("https://abc123@o0.ingest.sentry.io/not-a-project")).toBe(false);
    // and the shapes that stay legal
    expect(isSentryDsn("https://abc123@o0.ingest.sentry.io:9000/1")).toBe(true);
    expect(isSentryDsn("https://abc123@sentry.example.com/sentry/42")).toBe(true);
    expect(isSentryDsn("https://abc_123@o0.ingest.sentry.io/1")).toBe(true);
  });

  // The renderer cannot import a server module, so `src/lib/observability-config.ts`
  // carries its own copy of the grammar.  Two copies that disagree put the
  // Settings card and the harness on different rules, which is how a DSN the
  // card accepted gets refused (or, worse, printed) at the other end.
  it("keeps the browser copy of the rule byte-for-byte in agreement", () => {
    const cases = [
      SENTINEL_DSN,
      "https://abc_123@o0.ingest.sentry.io/1",
      "https://abc123@o0.ingest.sentry.io:9000/1",
      "https://abc123@sentry.example.com/sentry/42",
      "https://a1b2c3d4-e5f6-47a8-9b0c-1d2e3f4a5b6c@o123.ingest.sentry.io/456",
      "https://abc.123@o0.ingest.sentry.io/1",
      "https://abc123@o0.ingest.sentry.io/not-a-project",
      "http://abc123@o0.ingest.sentry.io/1",
      "https://o0.ingest.sentry.io/1",
      "https://abc123@o0.ingest.sentry.io",
      "not a url",
      "",
      "   ",
    ];
    for (const value of cases) {
      expect([value, isBrowserSentryDsn(value)]).toEqual([value, isSentryDsn(value)]);
    }
  });

  it("rejects a patch that is not a DSN and treats an empty one as a clear", () => {
    expect(() => parseConfigPatch({ observability: { sentryDsn: "http://abc123@o0.ingest.sentry.io/1" } })).toThrow(
      "observability.sentryDsn must be a Sentry https:// DSN",
    );
    expect(() => parseConfigPatch({ observability: { sentryDsn: "https://o0.ingest.sentry.io/1" } })).toThrow(
      "observability.sentryDsn must be a Sentry https:// DSN",
    );
    expect(() => parseConfigPatch({ observability: { sentryDsn: "https://abc123@o0.ingest.sentry.io" } })).toThrow(
      "observability.sentryDsn must be a Sentry https:// DSN",
    );
    expect(parseConfigPatch({ observability: { sentryDsn: "" } })).toEqual({
      observability: { sentryDsn: "" },
    });
    expect(
      parseConfigPatch({
        observability: { sentryDsn: SENTINEL_DSN, enabled: false, tracesSampleRate: 0, logsEnabled: false },
      }),
    ).toEqual({
      observability: { sentryDsn: SENTINEL_DSN, enabled: false, tracesSampleRate: 0, logsEnabled: false },
    });
  });

  it("rejects an over-long environment name and a sample rate outside 0..1", () => {
    const tooLong = "e".repeat(MAX_OBSERVABILITY_ENVIRONMENT_LENGTH + 1);
    expect(() => parseConfigPatch({ observability: { environment: tooLong } })).toThrow(
      `observability.environment must be ${MAX_OBSERVABILITY_ENVIRONMENT_LENGTH} characters or fewer`,
    );
    expect(
      parseConfigPatch({ observability: { environment: "e".repeat(MAX_OBSERVABILITY_ENVIRONMENT_LENGTH) } }),
    ).toEqual({ observability: { environment: "e".repeat(MAX_OBSERVABILITY_ENVIRONMENT_LENGTH) } });
    expect(() => parseConfigPatch({ observability: { tracesSampleRate: 1.5 } })).toThrow(
      "observability.tracesSampleRate",
    );
    expect(() => parseConfigPatch({ observability: { tracesSampleRate: -0.1 } })).toThrow(
      "observability.tracesSampleRate",
    );
  });

  it("keeps the kill switch explicit: absent means diagnostics are on", () => {
    expect(observabilityEnabled({})).toBe(true);
    expect(observabilityEnabled({ observability: {} })).toBe(true);
    expect(observabilityEnabled({ observability: { enabled: true } })).toBe(true);
    expect(observabilityEnabled({ observability: { enabled: false } })).toBe(false);
  });

  it("returns a stored DSN and drops one that is not a DSN at all", () => {
    expect(sentryDsnConfigured({ observability: { sentryDsn: ` ${SENTINEL_DSN} ` } })).toBe(SENTINEL_DSN);
    expect(sentryDsnConfigured({ observability: { sentryDsn: "https://o0.ingest.sentry.io/1" } })).toBeNull();
    expect(sentryDsnConfigured({})).toBeNull();
  });

  it("defaults the environment, sample rate, and log forwarding", () => {
    expect(observabilitySettings({})).toEqual({
      dsn: null,
      enabled: true,
      environment: "production",
      tracesSampleRate: DEFAULT_SENTRY_TRACES_SAMPLE_RATE,
      logsEnabled: true,
    });
  });

  it("prefers a saved value over the long-standing env names", () => {
    process.env.SENTRY_ENV = "from-env";
    process.env.SENTRY_TRACES_SAMPLE_RATE = "0.9";
    expect(observabilitySettings({})).toMatchObject({ environment: "from-env", tracesSampleRate: 0.9 });
    expect(
      observabilitySettings({ observability: { environment: "operator", tracesSampleRate: 0.05 } }),
    ).toMatchObject({ environment: "operator", tracesSampleRate: 0.05 });
  });

  it("keeps an explicit zero sample rate instead of defaulting it away", () => {
    expect(observabilitySettings({ observability: { tracesSampleRate: 0 } }).tracesSampleRate).toBe(0);
    expect(observabilitySettings({ observability: { logsEnabled: false } }).logsEnabled).toBe(false);
  });
});

describe("the secret-store section", () => {
  // Obviously fake, and never sent anywhere.
  const SENTINEL_CLIENT_SECRET = "sentinel-client-secret-not-real";
  // A fixture id, not a real workspace: the shape is all these tests need,
  // and a real project id in a public repo is fleet infrastructure disclosure.
  const PROJECT_ID = "test-project-0000";
  const VARS = [
    "INFISICAL_CLIENT_ID",
    "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID",
    "INFISICAL_CLIENT_SECRET",
    "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
    "INFISICAL_PROJECT_ID",
    "INFISICAL_SITE_URL",
    "INFISICAL_DOMAIN",
    "INFISICAL_ENVIRONMENT",
    "INFISICAL_SECRET_PATH",
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
    for (const name of VARS) delete process.env[name];
    mkdirSync(DATA_DIR, { recursive: true });
    rmSync(join(DATA_DIR, "config.json"), { force: true });
  });
  afterEach(() => {
    for (const name of VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    rmSync(join(DATA_DIR, "config.json"), { force: true });
  });

  it("persists the section, and a toggle-only patch keeps the identity", () => {
    saveConfig({
      infisical: {
        projectId: PROJECT_ID,
        clientId: "sentinel-client-id",
        clientSecret: SENTINEL_CLIENT_SECRET,
        environment: "prod",
      },
    });
    expect(loadConfig().infisical).toMatchObject({
      projectId: PROJECT_ID,
      clientId: "sentinel-client-id",
      environment: "prod",
    });

    saveConfig({ infisical: { enabled: false, writeThrough: true } });
    expect(loadConfig().infisical).toMatchObject({
      projectId: PROJECT_ID,
      clientId: "sentinel-client-id",
      enabled: false,
      writeThrough: true,
    });
    expect(infisicalEnabled(loadConfig())).toBe(false);
  });

  it("persists a DeepSeek key, which the allowlist used to drop on the floor", () => {
    // The key is in the schema, in the API Keys panel and in the tombstone
    // list, so a save reported success while nothing reached disk.
    saveConfig({ deepseek: { key: "sentinel-deepseek-key" } });
    expect(loadConfig().deepseek).toMatchObject({ key: "sentinel-deepseek-key" });

    saveConfig({ deepseek: { url: "https://api.deepseek.example" } });
    expect(loadConfig().deepseek).toMatchObject({
      key: "sentinel-deepseek-key",
      url: "https://api.deepseek.example",
    });
  });

  it("reads the machine identity from the environment, first alias wins", () => {
    process.env.INFISICAL_UNIVERSAL_AUTH_CLIENT_ID = "from-alias";
    process.env.INFISICAL_CLIENT_ID = "from-primary";
    process.env.INFISICAL_CLIENT_SECRET = SENTINEL_CLIENT_SECRET;
    process.env.INFISICAL_PROJECT_ID = PROJECT_ID;
    process.env.INFISICAL_SECRET_PATH = "/botfleet";
    const cfg = loadConfig();
    expect(cfg.infisical).toMatchObject({
      clientId: "from-primary",
      projectId: PROJECT_ID,
      secretPath: "/botfleet",
    });
    expect(infisicalConfigured(cfg)).toBe(true);

    delete process.env.INFISICAL_CLIENT_ID;
    expect(loadConfig().infisical?.clientId).toBe("from-alias");
  });

  it("stays inert with no project id and no identity", () => {
    expect(infisicalConfigured(loadConfig())).toBe(false);
    expect(infisicalConfigured({ infisical: { projectId: PROJECT_ID } })).toBe(false);
    expect(infisicalConfigured({ infisical: { projectId: PROJECT_ID, clientId: "id" } })).toBe(false);
  });

  it("keeps the kill switch explicit: absent means on once it is configured", () => {
    expect(infisicalEnabled({})).toBe(true);
    expect(infisicalEnabled({ infisical: {} })).toBe(true);
    expect(infisicalEnabled({ infisical: { enabled: true } })).toBe(true);
    expect(infisicalEnabled({ infisical: { enabled: false } })).toBe(false);
  });

  it("defaults the site, environment, path, cadence, and write-through", () => {
    expect(infisicalSettings({})).toEqual({
      enabled: true,
      writeThrough: false,
      siteUrl: DEFAULT_INFISICAL_SITE_URL,
      projectId: "",
      environment: DEFAULT_INFISICAL_ENVIRONMENT,
      secretPath: DEFAULT_INFISICAL_SECRET_PATH,
      clientId: "",
      clientSecret: "",
      refreshMinutes: DEFAULT_INFISICAL_REFRESH_MINUTES,
    });
    expect(
      infisicalSettings({ infisical: { siteUrl: " https://vault.example.test/ ", refreshMinutes: 60 } }),
    ).toMatchObject({ siteUrl: "https://vault.example.test", refreshMinutes: 60 });
    // Out-of-range cadences are clamped rather than obeyed: a one-minute
    // refresh would hammer the store, and a stored zero would never fire.
    expect(infisicalSettings({ infisical: { refreshMinutes: 0 } }).refreshMinutes).toBe(5);
    expect(infisicalSettings({ infisical: { refreshMinutes: 99_999 } }).refreshMinutes).toBe(1440);
    expect(infisicalSettings({ infisical: { writeThrough: true } }).writeThrough).toBe(true);
  });

  it("rejects a site URL, path, environment, or project id that cannot be trusted in a query", () => {
    expect(() => parseConfigPatch({ infisical: { siteUrl: "http://vault.example.test" } })).toThrow(
      "infisical.siteUrl must be an absolute https:// URL",
    );
    expect(() => parseConfigPatch({ infisical: { siteUrl: "vault.example.test" } })).toThrow(
      "infisical.siteUrl",
    );
    expect(() => parseConfigPatch({ infisical: { secretPath: "botfleet" } })).toThrow(
      "infisical.secretPath must start with /",
    );
    expect(() => parseConfigPatch({ infisical: { environment: "e".repeat(80) } })).toThrow(
      "infisical.environment",
    );
    expect(() => parseConfigPatch({ infisical: { environment: "Prod" } })).toThrow("infisical.environment");
    expect(() => parseConfigPatch({ infisical: { projectId: "test-project/../other" } })).toThrow(
      "infisical.projectId",
    );
    expect(() => parseConfigPatch({ infisical: { refreshMinutes: 1 } })).toThrow("infisical.refreshMinutes");
  });

  it("accepts a valid patch, and an empty string as the documented clear", () => {
    expect(
      parseConfigPatch({
        infisical: {
          enabled: true,
          writeThrough: false,
          siteUrl: "https://app.infisical.com",
          projectId: PROJECT_ID,
          environment: "prod",
          secretPath: "/",
          refreshMinutes: 15,
        },
      }),
    ).toEqual({
      infisical: {
        enabled: true,
        writeThrough: false,
        siteUrl: "https://app.infisical.com",
        projectId: PROJECT_ID,
        environment: "prod",
        secretPath: "/",
        refreshMinutes: 15,
      },
    });
    expect(
      parseConfigPatch({ infisical: { siteUrl: "", projectId: "", environment: "", secretPath: "" } }),
    ).toEqual({ infisical: { siteUrl: "", projectId: "", environment: "", secretPath: "" } });
  });

  it("holds the store to TLS", () => {
    expect(isHttpsUrl("https://app.infisical.com")).toBe(true);
    expect(isHttpsUrl("http://app.infisical.com")).toBe(false);
    expect(isHttpsUrl("https://user:pass@app.infisical.com")).toBe(false);
    expect(isHttpsUrl("app.infisical.com")).toBe(false);
    expect(isHttpsUrl("")).toBe(false);
    expect(isHttpsUrl(undefined)).toBe(false);
  });

  it("keeps a saved identity from being shadowed by an injected one", () => {
    process.env.INFISICAL_CLIENT_ID = "boot-injected";
    process.env.INFISICAL_CLIENT_SECRET = "boot-injected";
    syncCredentialEnv({ infisical: { clientId: "just-saved", clientSecret: SENTINEL_CLIENT_SECRET } });
    expect(process.env.INFISICAL_CLIENT_ID).toBe("just-saved");
    expect(process.env.INFISICAL_CLIENT_SECRET).toBe(SENTINEL_CLIENT_SECRET);

    syncCredentialEnv({ infisical: { clientId: "", clientSecret: "" } });
    expect(process.env.INFISICAL_CLIENT_ID).toBeUndefined();
    expect(process.env.INFISICAL_CLIENT_SECRET).toBeUndefined();
  });

  it("strips the machine identity from a child environment", () => {
    // It can read every name in the project, so of everything on the strip
    // list this is the pair that must never reach a spawned engine CLI.
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("INFISICAL_CLIENT_ID");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("INFISICAL_CLIENT_SECRET");
    const env = {
      PATH: "/usr/bin",
      INFISICAL_CLIENT_ID: "id",
      INFISICAL_CLIENT_SECRET: SENTINEL_CLIENT_SECRET,
    };
    stripWorkspaceCredentialEnv(env);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("strips the universal-auth aliases too, so an engine never inherits either spelling", () => {
    // loadConfig accepts INFISICAL_UNIVERSAL_AUTH_CLIENT_ID / _SECRET as
    // equals of the canonical pair — that is how a headless install and the
    // iOS ship workflow authenticate — so a strip list that named only the
    // canonical spelling would leave a fully usable, project-wide identity
    // riding into every spawned bot CLI through `...process.env`.
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("INFISICAL_UNIVERSAL_AUTH_CLIENT_ID");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET");
    const env = {
      PATH: "/usr/bin",
      INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "alias-id",
      INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: SENTINEL_CLIENT_SECRET,
      // Pointers, not credentials: they authenticate nothing on their own and
      // stay, so a bot that legitimately talks to the same project can still
      // be told which one it is.
      INFISICAL_PROJECT_ID: "proj-1",
      INFISICAL_SITE_URL: "https://app.infisical.example",
    };
    stripWorkspaceCredentialEnv(env);
    expect(env).toEqual({
      PATH: "/usr/bin",
      INFISICAL_PROJECT_ID: "proj-1",
      INFISICAL_SITE_URL: "https://app.infisical.example",
    });
    expect(JSON.stringify(env)).not.toContain(SENTINEL_CLIENT_SECRET);
  });

  it("resolves the identity from the alias pair alone, which is why both spellings are stripped", () => {
    // The load side of the same fact: with only the aliases exported, the
    // store is fully configured.  If this ever stops being true the strip
    // entries above are dead weight; while it is true they are load-bearing.
    delete process.env.INFISICAL_CLIENT_ID;
    delete process.env.INFISICAL_CLIENT_SECRET;
    process.env.INFISICAL_UNIVERSAL_AUTH_CLIENT_ID = "alias-id";
    process.env.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET = SENTINEL_CLIENT_SECRET;
    try {
      const cfg = loadConfig();
      expect(cfg.infisical?.clientId).toBe("alias-id");
      expect(cfg.infisical?.clientSecret).toBe(SENTINEL_CLIENT_SECRET);
    } finally {
      delete process.env.INFISICAL_UNIVERSAL_AUTH_CLIENT_ID;
      delete process.env.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET;
    }
  });
});
