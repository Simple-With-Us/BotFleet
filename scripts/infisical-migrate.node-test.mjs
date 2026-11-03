// Managed migration fixtures never authenticate or contact a live vault.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveVaultTokens, run } from "./infisical-migrate.mjs";

const SETTINGS = {
  authMethod: "service-token", siteUrl: "https://vault.example.test",
  projectId: "fixture-project", environment: "prod", secretPath: "/",
  clientId: "unused-machine-id", clientSecret: "unused-machine-secret",
  token: "", writeToken: "", readSources: [],
};

describe("managed migration credentials", () => {
  it("uses distinct service tokens without logging in", async () => {
    let logins = 0;
    assert.deepEqual(await resolveVaultTokens({ ...SETTINGS, token: " st.read ", writeToken: " st.write " }, {
      loginImpl: async () => { logins++; throw new Error("must not log in"); },
    }), { readToken: "st.read", writeToken: "st.write" });
    assert.equal(logins, 0);
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
        listSecretsImpl: async (options) => { calls.push(["read", options.token, options.projectId, options.environment, options.secretPath]); return { values: new Map() }; },
        upsertSecretImpl: async (options) => { calls.push(["write", options.token, options.projectId, options.environment, options.secretPath]); },
      });
      assert.deepEqual(calls, [
        ["read", "st.read", "fixture-project", "prod", "/"],
        ["write", "st.write", "fixture-project", "prod", "/"],
      ]);
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
