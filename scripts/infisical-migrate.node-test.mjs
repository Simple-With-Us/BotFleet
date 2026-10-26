// The write side of the vault needs a WRITE credential.
//
// A read token and a write token are two different credentials, and Infisical
// refuses a write with a read token.  The migration script upserts rows, so
// handing it the read token turns every write into a 403 that reads like a
// broken vault rather than a missing write credential.  These tests pin the
// rule: the read token reads, the write token writes, and the machine
// identity is the fallback for the write when no write token is provisioned.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveVaultTokens } from "./infisical-migrate.mjs";

const SETTINGS = {
  siteUrl: "https://vault.example.test",
  projectId: "836aebe2-c8f7-4e09-978e-7e3e82500bce",
  environment: "prod",
  secretPath: "/",
  clientId: "machine-id",
  clientSecret: "machine-secret",
  token: "",
  writeToken: "",
};

/** A login stub that records that it was called and hands back a token. */
function loginStub(result = "machine-session-token") {
  const calls = [];
  const impl = async (args) => {
    calls.push(args);
    if (result instanceof Error) throw result;
    return result;
  };
  impl.calls = calls;
  return impl;
}

describe("resolveVaultTokens", () => {
  it("reads with the read token and writes with the write token", async () => {
    const loginImpl = loginStub();
    const got = await resolveVaultTokens(
      { ...SETTINGS, token: "st.read", writeToken: "st.write" },
      { loginImpl },
    );
    assert.equal(got.readToken, "st.read");
    assert.equal(got.writeToken, "st.write");
    // Neither side needs the machine identity when both tokens are there.
    assert.equal(loginImpl.calls.length, 0);
  });

  it("never writes with the read token: the write falls back to the machine identity", async () => {
    const loginImpl = loginStub();
    const got = await resolveVaultTokens({ ...SETTINGS, token: "st.read" }, { loginImpl });
    assert.equal(got.readToken, "st.read");
    assert.equal(got.writeToken, "machine-session-token");
    assert.equal(loginImpl.calls.length, 1);
  });

  it("reports no write credential when there is neither a write token nor a machine identity", async () => {
    const loginImpl = loginStub(new Error("no machine identity on this host"));
    const got = await resolveVaultTokens({ ...SETTINGS, token: "st.read" }, { loginImpl });
    assert.equal(got.readToken, "st.read");
    assert.equal(got.writeToken, "");
  });

  it("logs in once when there is no token at all, and that login can write", async () => {
    const loginImpl = loginStub();
    const got = await resolveVaultTokens({ ...SETTINGS }, { loginImpl });
    assert.equal(got.readToken, "machine-session-token");
    assert.equal(got.writeToken, "machine-session-token");
    assert.equal(loginImpl.calls.length, 1);
  });

  it("uses the write token for the write even when the read side logs in", async () => {
    const loginImpl = loginStub();
    const got = await resolveVaultTokens({ ...SETTINGS, writeToken: "st.write" }, { loginImpl });
    assert.equal(got.readToken, "machine-session-token");
    assert.equal(got.writeToken, "st.write");
    assert.equal(loginImpl.calls.length, 1);
  });

  it("trims the tokens, because the config file can carry stray whitespace", async () => {
    const loginImpl = loginStub();
    const got = await resolveVaultTokens(
      { ...SETTINGS, token: " st.read ", writeToken: " st.write " },
      { loginImpl },
    );
    assert.equal(got.readToken, "st.read");
    assert.equal(got.writeToken, "st.write");
  });

  it("throws when the machine login fails and there is no token to read with", async () => {
    const loginImpl = loginStub(new Error("universal auth refused"));
    await assert.rejects(
      () => resolveVaultTokens({ ...SETTINGS }, { loginImpl }),
      /universal auth refused/,
    );
  });
});
