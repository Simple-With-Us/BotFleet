// Managed migration fixtures never authenticate or contact a live vault.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verifyServiceToken } from "../server/infisical-client.ts";
import { resolveVaultTokens, run as runWithVerifier } from "./infisical-migrate.mjs";

const SETTINGS = {
  authMethod: "service-token", siteUrl: "https://vault.example.test",
  projectId: "fixture-project", environment: "prod", secretPath: "/",
  clientId: "unused-machine-id", clientSecret: "unused-machine-secret",
  token: "", writeToken: "", readSources: [],
};

const acceptToken = async () => ({ expiresAt: null });
function run(options) {
  return runWithVerifier({ ...options, verifyServiceTokenImpl: options.verifyServiceTokenImpl ?? acceptToken });
}

describe("managed migration credentials", () => {
  it("uses distinct service tokens without logging in", async () => {
    assert.deepEqual(await resolveVaultTokens({ ...SETTINGS, token: " st.read ", writeToken: " st.write " }),
      { readToken: "st.read", writeToken: "st.write" });
  });

  it("does not borrow a read token or a machine identity for writes", async () => {
    assert.deepEqual(await resolveVaultTokens({ ...SETTINGS, token: "st.read" }), { readToken: "st.read", writeToken: "" });
  });

  it("requires a read token even when a write token or machine identity exists", async () => {
    await assert.rejects(resolveVaultTokens({ ...SETTINGS, writeToken: "st.write" }), /read service token/);
    await assert.rejects(resolveVaultTokens({ ...SETTINGS, authMethod: "machine-identity" }), /machine identities are not used/);
  });

  it("does not bypass a matching dedicated source by borrowing the primary token", async () => {
    await assert.rejects(resolveVaultTokens({ ...SETTINGS, token: "st.primary", readSources: [{
      name: "primary-source", projectId: "fixture-project", environment: "prod", secretPath: "/",
      tokenEnv: "FIXTURE_SOURCE_TOKEN",
    }] }), /configured source/);
  });

  it("refuses --apply without a write token before attempting a read or write", async () => {
    const previousExitCode = process.exitCode;
    let reads = 0;
    let writes = 0;
    const errors = [];
    try {
      await run({
        argv: ["--apply"], log: () => {}, err: (line) => errors.push(line),
        loadConfigImpl: () => ({ infisical: { ...SETTINGS, token: "st.read" }, composio: { apiKey: "fixture-local" } }),
        listSecretsImpl: async () => { reads++; throw new Error("must not list"); },
        upsertSecretImpl: async () => { writes++; },
      });
      assert.equal(process.exitCode, 1);
      assert.equal(reads, 0);
      assert.equal(writes, 0);
      assert.match(errors.join(" "), /dedicated write service token/);
    } finally { process.exitCode = previousExitCode; }
  });

  it("uses the read token for comparison and the write token only for the requested upsert", async () => {
    const previousExitCode = process.exitCode;
    const calls = [];
    try {
      await run({
        argv: ["--apply"], log: () => {}, err: () => {},
        loadConfigImpl: () => ({ infisical: { ...SETTINGS, token: "st.read", writeToken: "st.write" }, composio: { apiKey: "fixture-local" } }),
        verifyServiceTokenImpl: async (options) => { calls.push(["verify", options.mode, options.token, options.projectId, options.environment, options.secretPath]); return { expiresAt: null }; },
        listSecretsImpl: async (options) => { calls.push(["read", options.token, options.projectId, options.environment, options.secretPath]); return { values: new Map() }; },
        upsertSecretImpl: async (options) => { calls.push(["write", options.token, options.projectId, options.environment, options.secretPath]); },
      });
      assert.deepEqual(calls, [
        ["verify", "read", "st.read", "fixture-project", "prod", "/"],
        ["verify", "write", "st.write", "fixture-project", "prod", "/"],
        ["read", "st.read", "fixture-project", "prod", "/"],
        ["write", "st.write", "fixture-project", "prod", "/"],
      ]);
    } finally { process.exitCode = previousExitCode; }
  });

  it("refuses an out-of-scope or expired read token before reading or writing", async () => {
    const previousExitCode = process.exitCode;
    let reads = 0;
    let writes = 0;
    const errors = [];
    try {
      await run({
        argv: ["--apply"], log: () => {}, err: (line) => errors.push(line),
        loadConfigImpl: () => ({ infisical: { ...SETTINGS, token: "st.read", writeToken: "st.write" }, composio: { apiKey: "fixture-local" } }),
        verifyServiceTokenImpl: async ({ mode }) => {
          assert.equal(mode, "read");
          throw new Error("st.read private metadata says expired or wrong folder");
        },
        listSecretsImpl: async () => { reads++; return { values: new Map() }; },
        upsertSecretImpl: async () => { writes++; },
      });
      assert.equal(process.exitCode, 1);
      assert.equal(reads, 0);
      assert.equal(writes, 0);
      assert.ok(errors.every((line) => !line.includes("st.read") && !line.includes("private metadata")));
    } finally { process.exitCode = previousExitCode; }
  });

  it("uses the real verifier and rejects wrong project, folder, environment, expiry, and write permission before any vault I/O", async (t) => {
    const originalFetch = globalThis.fetch;
    const validRead = {
      workspace: "fixture-project", projectId: "fixture-project",
      scopes: [{ environment: "prod", secretPath: "/" }], permissions: ["read"], expiresAt: null,
    };
    const validWrite = { ...validRead, permissions: ["write"] };
    const cases = [
      ["wrong project", { ...validRead, workspace: "other-project", projectId: "other-project" }, validWrite, 1],
      ["wrong folder", { ...validRead, scopes: [{ environment: "prod", secretPath: "/other" }] }, validWrite, 1],
      ["wrong environment", { ...validRead, scopes: [{ environment: "staging", secretPath: "/" }] }, validWrite, 1],
      ["expired read token", { ...validRead, expiresAt: "2020-01-01T00:00:00Z" }, validWrite, 1],
      ["read-only write token", validRead, validRead, 2],
    ];
    try {
      for (const [name, readMetadata, writeMetadata, expectedVerifications] of cases) {
        await t.test(name, async () => {
          const previousExitCode = process.exitCode;
          const order = [];
          const errors = [];
          globalThis.fetch = async (url, init) => {
            const token = String(init?.headers?.authorization ?? "").replace(/^Bearer /, "");
            order.push(`verify:${token}`);
            assert.match(String(url), /\/api\/v2\/service-token$/);
            const metadata = token === "st.read" ? readMetadata : writeMetadata;
            return new Response(JSON.stringify(metadata), { status: 200 });
          };
          try {
            await runWithVerifier({
              argv: ["--apply"], log: () => {}, err: (line) => errors.push(line),
              loadConfigImpl: () => ({ infisical: { ...SETTINGS, token: "st.read", writeToken: "st.write" }, composio: { apiKey: "fixture-local" } }),
              verifyServiceTokenImpl: verifyServiceToken,
              listSecretsImpl: async () => { order.push("secrets-read"); return { values: new Map() }; },
              upsertSecretImpl: async () => { order.push("secret-write"); },
            });
            assert.equal(process.exitCode, 1);
            assert.equal(order.length, expectedVerifications);
            assert.ok(order.every((entry) => entry.startsWith("verify:")));
            assert.ok(errors.every((line) => !line.includes("st.read") && !line.includes("st.write") && !line.includes("fixture-local")));
          } finally { process.exitCode = previousExitCode; }
        });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts valid exact read and write scopes before listing and upserting", async () => {
    const originalFetch = globalThis.fetch;
    const previousExitCode = process.exitCode;
    const calls = [];
    globalThis.fetch = async (url, init) => {
      const token = String(init?.headers?.authorization ?? "").replace(/^Bearer /, "");
      calls.push(`verify:${token}`);
      assert.match(String(url), /\/api\/v2\/service-token$/);
      return new Response(JSON.stringify({
        workspace: "fixture-project", projectId: "fixture-project",
        scopes: [{ environment: "prod", secretPath: "/" }],
        permissions: [token === "st.read" ? "read" : "write"], expiresAt: null,
      }), { status: 200 });
    };
    try {
      await runWithVerifier({
        argv: ["--apply"], log: () => {}, err: () => {},
        loadConfigImpl: () => ({ infisical: { ...SETTINGS, token: "st.read", writeToken: "st.write" }, composio: { apiKey: "fixture-local" } }),
        verifyServiceTokenImpl: verifyServiceToken,
        listSecretsImpl: async () => { calls.push("secrets-read"); return { values: new Map() }; },
        upsertSecretImpl: async () => { calls.push("secret-write"); },
      });
      assert.deepEqual(calls, ["verify:st.read", "verify:st.write", "secrets-read", "secret-write"]);
    } finally {
      globalThis.fetch = originalFetch;
      process.exitCode = previousExitCode;
    }
  });

  it("refuses a read-only write token before any vault read or upsert", async () => {
    const previousExitCode = process.exitCode;
    const modes = [];
    let reads = 0;
    let writes = 0;
    const errors = [];
    try {
      await run({
        argv: ["--apply"], log: () => {}, err: (line) => errors.push(line),
        loadConfigImpl: () => ({ infisical: { ...SETTINGS, token: "st.read", writeToken: "st.read-only" }, composio: { apiKey: "fixture-local" } }),
        verifyServiceTokenImpl: async ({ mode, token }) => {
          modes.push(mode);
          if (mode === "write") throw new Error(`${token} has read-only permission`);
          return { expiresAt: null };
        },
        listSecretsImpl: async () => { reads++; return { values: new Map() }; },
        upsertSecretImpl: async () => { writes++; },
      });
      assert.deepEqual(modes, ["read", "write"]);
      assert.equal(process.exitCode, 1);
      assert.equal(reads, 0);
      assert.equal(writes, 0);
      assert.ok(errors.every((line) => !line.includes("st.read-only") && !line.includes("permission")));
    } finally { process.exitCode = previousExitCode; }
  });

  it("fails a refused write without exposing its upstream error or retrying another identity", async () => {
    const previousExitCode = process.exitCode;
    let writes = 0;
    const errors = [];
    try {
      await run({
        argv: ["--apply"], log: () => {}, err: (line) => errors.push(line),
        loadConfigImpl: () => ({ infisical: { ...SETTINGS, token: "st.read", writeToken: "st.write" }, composio: { apiKey: "fixture-local" } }),
        listSecretsImpl: async () => ({ values: new Map() }),
        upsertSecretImpl: async () => { writes++; throw new Error("st.write fixture-local"); },
      });
      assert.equal(process.exitCode, 1);
      assert.equal(writes, 1);
      assert.ok(errors.every((line) => !line.includes("st.write") && !line.includes("fixture-local")));
    } finally { process.exitCode = previousExitCode; }
  });
});
