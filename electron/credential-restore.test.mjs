import { describe, expect, it, vi } from "vitest";
import { markExternalInstanceCredentials, planCredentialRestore, restoreInstanceCredentials, restoreWorkspaceCredentials, workspaceRestorePayload } from "./credential-restore.mjs";

describe("attached workspace credential restoration", () => {
  it("migrates only matching custom engines to a nonsecret external-credential marker", () => {
    const source = { instances: {
      custom: { driver: "openai-compat", config: { url: "https://example.test/v1" } },
      claude: { driver: "claudeAgent" },
    } };
    const marked = markExternalInstanceCredentials(source, ["custom", "claude", "gone"]);
    expect(marked).toEqual({ changed: true, config: { instances: {
      custom: { driver: "openai-compat", config: { url: "https://example.test/v1", credentialStorage: "external" } },
      claude: { driver: "claudeAgent" },
    } } });
    expect(source.instances.custom.config).not.toHaveProperty("credentialStorage");
    expect(markExternalInstanceCredentials(marked.config, ["custom"]).changed).toBe(false);
  });
  it("retains current config or vault values and restores only absent credentials", () => {
    const result = planCredentialRestore({ xaiApiKey: "old", composioApiKey: "saved", infisicalClientSecret: "unlock", infisicalReadToken: "read", infisicalWriteToken: "write" }, {
      xai: { key: "canonical" }, composio: { userId: "existing-user", sessionId: "existing-session" },
    });
    expect(result).toEqual({
      env: { COMPOSIO_API_KEY: "saved", INFISICAL_CLIENT_SECRET: "unlock", INFISICAL_TOKEN: "read", INFISICAL_WRITE_TOKEN: "write" },
      restored: ["composioApiKey", "infisicalClientSecret", "infisicalReadToken", "infisicalWriteToken"], retained: ["xaiApiKey"],
    });
  });
  it.each([null, [], { PATH: "unsafe" }, { xaiApiKey: "" }, { xaiApiKey: 123 }, { xaiApiKey: "x".repeat(16_385) }])(
    "rejects unsupported payloads before any mutation: %j", (value) => {
      expect(() => planCredentialRestore(value, {})).toThrow("Invalid credential restore payload");
    },
  );
  it("sends only fixed stored credentials, never account tokens or custom-instance values", () => {
    expect(workspaceRestorePayload({ composioApiKey: "project-key", accountToken: "private", instanceKeys: { custom: "key" } }))
      .toEqual({ composioApiKey: "project-key" });
  });
  it("never sends credentials without a matching verified data owner", async () => {
    const fetchImpl = vi.fn();
    const options = { port: 8799, owner: { port: 8799, nonce: "nonce" }, credentials: { xaiApiKey: "secret" }, fetchImpl };
    expect(await restoreWorkspaceCredentials({ ...options, verifyOwner: async () => false })).toBe("unavailable");
    expect(await restoreWorkspaceCredentials({ ...options, owner: { port: 18799 }, verifyOwner: async () => true })).toBe("unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([[200, "restored"], [409, "busy"], [503, "unavailable"]])("bounds and classifies HTTP %s without exposing error text", async (status, outcome) => {
    const fetchImpl = vi.fn(async () => new Response("sensitive upstream error", { status }));
    expect(await restoreWorkspaceCredentials({ port: 8799, owner: { port: 8799, nonce: "nonce" },
      credentials: { xaiApiKey: "secret" }, verifyOwner: async () => true, fetchImpl })).toBe(outcome);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: "error", method: "POST" });
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
  it("proves ownership again for each custom instance and stops on a changed owner", async () => {
    const verifyOwner = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const fetchImpl = vi.fn(async () => new Response("{}"));
    expect(await restoreInstanceCredentials({ port: 8799, owner: { port: 8799, nonce: "nonce" },
      credentials: { instanceKeys: { first: "saved-one", second: "saved-two" } }, verifyOwner, fetchImpl }))
      .toEqual({ outcome: "unavailable", missing: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toContain("/first?secretStorage=external&restore=1");
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: "PATCH", redirect: "error", body: JSON.stringify({ key: "saved-one" }) });
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
  it.each([[409, "busy"], [503, "unavailable"]])("retains saved custom keys when HTTP %s prevents restoration", async (status, outcome) => {
    const credentials = { instanceKeys: { gone: "old", pending: "saved", later: "unattempted" } };
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 404 }))
      .mockResolvedValueOnce(new Response("sensitive", { status }));
    expect(await restoreInstanceCredentials({ port: 8799, owner: { port: 8799, nonce: "nonce" },
      credentials, verifyOwner: async () => true, fetchImpl })).toEqual({ outcome, missing: ["gone"] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(credentials.instanceKeys).toEqual({ gone: "old", pending: "saved", later: "unattempted" });
  });
});
