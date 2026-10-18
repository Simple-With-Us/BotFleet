// OPS-818: infisical-fetch.mjs must ask Infisical to expand secret references
// and must fail closed (naming the KEY only) when a value is still a bare
// reference.  Run: node --test scripts/infisical-fetch-expand.node-test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isUnresolvedReference, run } from "./infisical-fetch.mjs";

const REFERENCE = "${prod.global-api-keys.SENTINEL_KEY_ref_3c9e}";
const RESOLVED = "sentinel-resolved-value-5d1a";

/** Stub Infisical: login succeeds, the list call returns the fixture secrets
 * and records every list URL so a test can assert on the query string. */
function stubFetch(vaultSecrets, listUrls = []) {
  return async (url) => {
    const u = String(url);
    if (u.includes("/api/v1/auth/universal-auth/login")) {
      return { ok: true, json: async () => ({ accessToken: "test-token", expiresIn: 3600 }) };
    }
    if (u.includes("/api/v3/secrets/raw")) {
      listUrls.push(u);
      return {
        ok: true,
        json: async () => ({
          secrets: Object.entries(vaultSecrets).map(([secretKey, secretValue]) => ({ secretKey, secretValue })),
        }),
      };
    }
    throw new Error(`stubFetch: unexpected URL ${u}`);
  };
}

function baseEnv(githubEnv, names) {
  return {
    INFISICAL_NAMES: names,
    INFISICAL_PROJECT_ID: "proj",
    INFISICAL_CLIENT_ID: "id",
    INFISICAL_CLIENT_SECRET: "secret",
    GITHUB_ENV: githubEnv,
  };
}

test("the secrets list asks Infisical to expand secret references", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ops818-fetch-"));
  try {
    const listUrls = [];
    await run({ env: baseEnv(join(dir, "env"), "FOO"), fetchImpl: stubFetch({ FOO: RESOLVED }, listUrls), log: () => {} });
    assert.equal(listUrls.length, 1);
    assert.equal(new URL(listUrls[0]).searchParams.get("expandSecretReferences"), "true");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a value that is still a bare reference fails closed and names the key only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ops818-fetch-"));
  try {
    const envFile = join(dir, "env");
    const lines = [];
    await assert.rejects(
      run({
        env: baseEnv(envFile, "GOOD BAD"),
        fetchImpl: stubFetch({ GOOD: RESOLVED, BAD: REFERENCE }),
        log: (l) => lines.push(l),
      }),
      (err) => {
        assert.match(err.message, /BAD/);
        assert.ok(!err.message.includes("SENTINEL_KEY_ref_3c9e"), "error must not echo the reference");
        return true;
      },
    );
    const written = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
    assert.ok(!written.includes("SENTINEL_KEY_ref_3c9e"), "reference must never reach GITHUB_ENV");
    assert.ok(lines.every((l) => !l.includes("SENTINEL_KEY_ref_3c9e")), "reference must never reach the log");
    assert.ok(lines.some((l) => l.startsWith("::error::BAD ")), "the key is named in an ::error:: line");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a resolved value is written normally", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ops818-fetch-"));
  try {
    const envFile = join(dir, "env");
    await run({ env: baseEnv(envFile, "FOO"), fetchImpl: stubFetch({ FOO: RESOLVED }), log: () => {} });
    assert.ok(readFileSync(envFile, "utf8").includes(RESOLVED));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isUnresolvedReference matches only a whole-value bare reference", () => {
  assert.equal(isUnresolvedReference("${prod.global-api-keys.NAME}"), true);
  assert.equal(isUnresolvedReference("  ${prod.a.B}\n"), true);
  assert.equal(isUnresolvedReference("prefix-${prod.a.B}"), false);
  assert.equal(isUnresolvedReference("${prod.a.B}-suffix"), false);
  assert.equal(isUnresolvedReference("plain"), false);
  assert.equal(isUnresolvedReference(""), false);
  assert.equal(isUnresolvedReference(undefined), false);
});
