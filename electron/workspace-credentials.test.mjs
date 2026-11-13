import { describe, expect, it } from "vitest";

import {
  assertExternalWorkspaceCredentialMarkers,
  EXTERNAL_WORKSPACE_CREDENTIALS,
  instanceKeyedDriver,
  INSTANCE_API_KEY_ENV,
  markExternalWorkspaceCredentials,
  migrateWorkspaceCredentials,
  setWorkspaceCredentialMarker,
  workspaceCredentialPending,
  workspaceCredentialEnv,
  WORKSPACE_CREDENTIALS,
} from "./workspace-credentials.mjs";

describe("workspace credential migration", () => {
  it("moves every plaintext secret into the store and deletes the field", () => {
    const config = {
      xai: { key: "xai-secret", url: "https://api.example.test/v1" },
      box: { token: "box-secret" },
      tts: { key: "tts-secret", voice: "narrator" },
      imageGen: { key: "image-secret" },
      opencodeGo: { apiKey: "ocg-secret" },
      profile: { name: "Ada" },
    };
    const result = migrateWorkspaceCredentials(config, {});
    expect(result.configChanged).toBe(true);
    expect(result.credentialsChanged).toBe(true);
    expect(result.credentials).toEqual({
      xaiApiKey: "xai-secret",
      boxToken: "box-secret",
      ttsKey: "tts-secret",
      opencodeGoApiKey: "ocg-secret",
      openaiImageApiKey: "image-secret",
    });
    // secrets are DELETED (not blanked) so "" stays meaningful as "cleared";
    // non-secret siblings (endpoint url, chosen voice) stay in the file
    expect(result.config).toEqual({
      xai: { url: "https://api.example.test/v1" },
      box: {},
      tts: { voice: "narrator" },
      imageGen: {},
      opencodeGo: {},
      profile: { name: "Ada" },
    });
    // inputs are never mutated — main.mjs decides which files to rewrite
    expect(config.xai.key).toBe("xai-secret");
  });

  it("migrates legacy primary Infisical tokens to encrypted credential slots", () => {
    const result = migrateWorkspaceCredentials({
      infisical: { clientSecret: "identity-secret", token: "read-service-token", writeToken: "write-service-token", projectId: "fixture-project" },
    }, {});

    expect(result.credentials).toEqual({
      infisicalClientSecret: "identity-secret",
      infisicalReadToken: "read-service-token",
      infisicalWriteToken: "write-service-token",
    });
    expect(result.config).toEqual({ infisical: { projectId: "fixture-project" } });
    expect(JSON.stringify(result.config)).not.toMatch(/identity-secret|read-service-token|write-service-token/);
    expect(workspaceCredentialEnv(result.credentials)).toEqual({
      INFISICAL_CLIENT_SECRET: "identity-secret",
      INFISICAL_TOKEN: "read-service-token",
      INFISICAL_WRITE_TOKEN: "write-service-token",
    });
  });

  it("is idempotent: a second boot over migrated output changes nothing", () => {
    const first = migrateWorkspaceCredentials(
      { xai: { key: "xai-secret" }, tts: { key: "tts-secret", voice: "narrator" } },
      {},
    );
    const second = migrateWorkspaceCredentials(first.config, first.credentials);
    expect(second.configChanged).toBe(false);
    expect(second.credentialsChanged).toBe(false);
    expect(second.credentials).toEqual(first.credentials);
    expect(second.config).toEqual(first.config);
  });

  it("treats a saved non-empty value as newest intent and overwrites the store", () => {
    // mid-session key change: the server persisted the new key to config.json;
    // the stale stored secret must not win at the next boot
    const result = migrateWorkspaceCredentials(
      { box: { token: "box-NEW" } },
      { boxToken: "box-OLD", xaiApiKey: "xai-keep" },
    );
    expect(result.credentials).toEqual({ boxToken: "box-NEW", xaiApiKey: "xai-keep" });
    expect(result.config.box).toEqual({});
  });

  it("treats an empty saved value as no information and keeps the stored secret", () => {
    // The packaged app tombstones every external-mode save as "" in
    // config.json while the real key goes to credentials.bin — a boot that
    // read "" as "cleared" would delete freshly saved keys on every restart.
    const result = migrateWorkspaceCredentials(
      { xai: { key: "" }, tts: { key: "   " } },
      { xaiApiKey: "xai-OLD", ttsKey: "tts-OLD", boxToken: "box-keep" },
    );
    expect(result.credentialsChanged).toBe(false);
    expect(result.credentials).toEqual({ xaiApiKey: "xai-OLD", ttsKey: "tts-OLD", boxToken: "box-keep" });
    // the swept field itself is still removed from the file
    expect(result.config).toEqual({ xai: {}, tts: {} });
    expect(result.configChanged).toBe(true);
  });

  it("keeps the packaged save → restart cycle lossless end to end", () => {
    // first boot migrates the plaintext key in and sweeps the field
    const boot = migrateWorkspaceCredentials({ opencodeGo: { apiKey: "ocg-secret" } }, {});
    expect(boot.credentials).toEqual({ opencodeGoApiKey: "ocg-secret" });

    // an external-mode save commits the key to the store and leaves a ""
    // tombstone in config.json; the next boot must not read it as a clear
    const afterTombstone = migrateWorkspaceCredentials(
      { opencodeGo: { apiKey: "" }, profile: { name: "Ada" } },
      { opencodeGoApiKey: "ocg-secret" },
    );
    expect(afterTombstone.credentials).toEqual({ opencodeGoApiKey: "ocg-secret" });
    expect(afterTombstone.credentialsChanged).toBe(false);
  });

  it("keeps stored secrets when the field is absent (already migrated)", () => {
    const stored = { xaiApiKey: "xai-keep", boxToken: "box-keep" };
    const result = migrateWorkspaceCredentials({ profile: { name: "Ada" } }, stored);
    expect(result.configChanged).toBe(false);
    expect(result.credentialsChanged).toBe(false);
    expect(result.credentials).toEqual(stored);
  });

  it("leaves non-string junk for the server's schema instead of destroying it", () => {
    const result = migrateWorkspaceCredentials({ xai: { key: 42 }, box: "not-an-object" }, {});
    expect(result.configChanged).toBe(false);
    expect(result.credentialsChanged).toBe(false);
    expect(result.config.xai.key).toBe(42);
  });
});

describe("workspace credential env", () => {
  it("maps each stored secret to exactly its server env var", () => {
    expect(
      workspaceCredentialEnv({
        xaiApiKey: "xai-secret",
        boxToken: "box-secret",
        ttsKey: "tts-secret",
        opencodeGoApiKey: "ocg-secret",
        openaiImageApiKey: "image-secret",
        composioApiKey: "ak_handled-separately",
      }),
    ).toEqual({
      XAI_API_KEY: "xai-secret",
      BOX_TOKEN: "box-secret",
      OMB_TTS_KEY: "tts-secret",
      OPENCODE_API_KEY: "ocg-secret",
      OMB_OPENAI_IMAGE_KEY: "image-secret",
    });
  });

  it("emits nothing for absent or empty secrets", () => {
    expect(workspaceCredentialEnv({})).toEqual({});
    expect(workspaceCredentialEnv({ xaiApiKey: "" })).toEqual({});
    expect(workspaceCredentialEnv(undefined)).toEqual({});
  });

  it("covers every credential the migration table declares", () => {
    const credentials = Object.fromEntries(WORKSPACE_CREDENTIALS.map((c) => [c.name, `v-${c.name}`]));
    const env = workspaceCredentialEnv(credentials);
    expect(Object.keys(env).sort()).toEqual(WORKSPACE_CREDENTIALS.map((c) => c.env).sort());
  });
});

describe("workspace credential replay markers", () => {
  it("marks only encrypted credentials and never persists their values", () => {
    const source = { xai: { url: "https://api.example.test/v1" }, profile: { name: "Ada" } };
    const result = markExternalWorkspaceCredentials(source, {
      xaiApiKey: "saved-xai",
      composioApiKey: "saved-composio",
    });

    expect(result).toEqual({ changed: true, config: {
      xai: { url: "https://api.example.test/v1", credentialStorage: "external" },
      composio: { credentialStorage: "external" },
      profile: { name: "Ada" },
    } });
    expect(JSON.stringify(result.config)).not.toMatch(/saved-xai|saved-composio/);
    expect(source.xai).not.toHaveProperty("credentialStorage");
  });

  it("rejects a preparation readback missing any fixed encrypted credential marker", () => {
    const credentials = { xaiApiKey: "saved-xai", boxToken: "saved-box" };
    expect(() => assertExternalWorkspaceCredentialMarkers(
      { xai: { credentialStorage: "external" }, box: {} },
      credentials,
    )).toThrow(/boxToken/);
    expect(assertExternalWorkspaceCredentialMarkers(
      {
        xai: { credentialStorage: "external" },
        box: { credentialStorage: "external" },
      },
      credentials,
    )).toEqual(["xaiApiKey", "boxToken"]);
  });

  it("distinguishes pending replay from a restored value", () => {
    expect(workspaceCredentialPending({ xai: { credentialStorage: "external" } }, "xaiApiKey")).toBe(true);
    expect(workspaceCredentialPending({ xai: { credentialStorage: "external", key: "runtime-only" } }, "xaiApiKey")).toBe(false);
    expect(workspaceCredentialPending({ xai: {} }, "xaiApiKey")).toBe(false);
    expect(EXTERNAL_WORKSPACE_CREDENTIALS.map((field) => field.name)).toContain("infisicalClientSecret");
    expect(EXTERNAL_WORKSPACE_CREDENTIALS.map((field) => field.name)).toContain("infisicalReadToken");
    expect(EXTERNAL_WORKSPACE_CREDENTIALS.map((field) => field.name)).toContain("infisicalWriteToken");
  });

  it("removes an external marker only on an explicit credential clear", () => {
    const marked = { xai: { url: "https://api.example.test/v1", credentialStorage: "external" } };
    expect(setWorkspaceCredentialMarker(marked, "xaiApiKey", false)).toEqual({
      xai: { url: "https://api.example.test/v1" },
    });
    expect(setWorkspaceCredentialMarker({ xai: {} }, "xaiApiKey", true)).toEqual({
      xai: { credentialStorage: "external" },
    });
  });
});

describe("drivers that keep a per-instance key", () => {
  it("names them once, for both the server and the desktop shell", () => {
    // One table, two readers: server/config.ts re-exports it for the instance
    // routes, and the shell's boot-time marker repair walks it.  Two copies of
    // it is exactly the drift that left MiniMax instances unrepaired.
    expect([...INSTANCE_API_KEY_ENV]).toEqual([
      ["openai-compat", "OPENAI_COMPAT_API_KEY"],
      ["minimax", "MINIMAX_API_KEY"],
    ]);
  });

  it("recognises an instance entry by its driver, and nothing else", () => {
    expect(instanceKeyedDriver({ driver: "minimax" })).toBe(true);
    expect(instanceKeyedDriver({ driver: "openai-compat" })).toBe(true);
    // A CLI engine reads a login from the user's home directory; there is no
    // per-instance key for the encrypted store to hold.
    expect(instanceKeyedDriver({ driver: "claudeAgent" })).toBe(false);
    expect(instanceKeyedDriver({ driver: "grok" })).toBe(false);
    for (const shape of [undefined, null, "minimax", 7, ["minimax"], {}]) {
      expect(instanceKeyedDriver(shape)).toBe(false);
    }
  });
});
