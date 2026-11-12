// Exact-folder CI reads must leave references unexpanded and reject them before export.
// Run: node --test scripts/infisical-fetch-expand.node-test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isUnresolvedReference, run } from "./infisical-fetch.mjs";

const REFERENCE = "${prod.global-api-keys.SENTINEL_KEY_ref_3c9e}";
const RESOLVED = "sentinel-resolved-value-5d1a";

/** Stub only the secrets read and record its URL for query-string assertions. */
function stubFetch(vaultSecrets, listUrls = [], rowOverrides = {}) {
  return async (url) => {
    const u = String(url);
    if (u.includes("/api/v2/service-token")) {
      return new Response(JSON.stringify({
        workspace: "proj", projectId: "proj", scopes: [{ environment: "prod", secretPath: "/" }],
        permissions: ["read"], expiresAt: null,
      }), { status: 200 });
    }
    if (u.includes("/api/v3/secrets/raw")) {
      listUrls.push(u);
      return new Response(JSON.stringify({
        secrets: Object.entries(vaultSecrets).map(([secretKey, secretValue]) => ({
          secretKey, secretValue, workspace: "proj", environment: "prod", secretValueHidden: false, ...rowOverrides,
        })),
      }), { status: 200 });
    }
    throw new Error(`stubFetch: unexpected URL ${u}`);
  };
}

function baseEnv(githubEnv, names) {
  return {
    INFISICAL_NAMES: names,
    INFISICAL_PROJECT_ID: "proj",
    INFISICAL_TOKEN: "st.fixture",
    GITHUB_ENV: githubEnv,
  };
}

test("the secrets list disables expansion, imports, and recursive reads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ops818-fetch-"));
  try {
    const listUrls = [];
    await run({ env: baseEnv(join(dir, "env"), "FOO"), fetchImpl: stubFetch({ FOO: RESOLVED }, listUrls), log: () => {} });
    assert.equal(listUrls.length, 1);
    const query = new URL(listUrls[0]).searchParams;
    assert.equal(query.get("expandSecretReferences"), "false");
    assert.equal(query.get("include_imports"), "false");
    assert.equal(query.get("recursive"), "false");
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
        env: { ...baseEnv(envFile, "GOOD BAD"), INFISICAL_REQUIRED: "BAD" },
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
    assert.ok(lines.some((l) => l.startsWith("::warning::BAD ")), "the invalid key is named in a warning only");
    assert.ok(lines.some((l) => l.startsWith("::error::BAD ")), "a required missing key is named in an error");
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

test("isUnresolvedReference detects bare and embedded reference expressions", () => {
  assert.equal(isUnresolvedReference("${prod.global-api-keys.NAME}"), true);
  assert.equal(isUnresolvedReference("  ${prod.a.B}\n"), true);
  assert.equal(isUnresolvedReference("prefix-${prod.a.B}"), true);
  assert.equal(isUnresolvedReference("${prod.a.B}-suffix"), true);
  assert.equal(isUnresolvedReference("prefix-${prod.a.B}-suffix"), true);
  assert.equal(isUnresolvedReference("before\n${prod.a.B}\nafter"), true);
  assert.equal(isUnresolvedReference("${}"), true);
  assert.equal(isUnresolvedReference("plain"), false);
  assert.equal(isUnresolvedReference(""), false);
  assert.equal(isUnresolvedReference(undefined), false);
});

test("bare and embedded vault references use only an existing valid same-name fallback", async (t) => {
  for (const value of [REFERENCE, `prefix-${REFERENCE}`, `${REFERENCE}-suffix`, `before\n${REFERENCE}\nafter`]) {
    await t.test(`reference form ${value === REFERENCE ? "bare" : "embedded"}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "bf-reference-fallback-"));
      try {
        const envFile = join(dir, "env");
        const lines = [];
        await run({
          env: { ...baseEnv(envFile, "FOO"), INFISICAL_REQUIRED: "FOO", GH_FALLBACK_FOO: RESOLVED },
          fetchImpl: stubFetch({ FOO: value }), log: (line) => lines.push(line),
        });
        const exported = readFileSync(envFile, "utf8");
        assert.ok(exported.includes(RESOLVED));
        assert.ok(!exported.includes("SENTINEL_KEY_ref_3c9e"));
        assert.ok(lines.some((line) => line.startsWith("::warning::FOO ")));
        assert.ok(lines.every((line) => !line.includes("SENTINEL_KEY_ref_3c9e")));
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});

test("reference values without a valid fallback are unavailable and fail only required names", async (t) => {
  const cases = [
    ["vault reference, no fallback", { FOO: `prefix-${REFERENCE}` }, ""],
    ["fallback reference", {}, `prefix-${REFERENCE}`],
    ["references in both sources", { FOO: REFERENCE }, `${REFERENCE}-suffix`],
  ];
  for (const [label, vault, fallback] of cases) {
    for (const required of [false, true]) {
      await t.test(`${label}, ${required ? "required" : "optional"}`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "bf-reference-refusal-"));
        try {
          const envFile = join(dir, "env");
          const lines = [];
          const pending = run({
            env: { ...baseEnv(envFile, "FOO"), INFISICAL_REQUIRED: required ? "FOO" : "", GH_FALLBACK_FOO: fallback },
            fetchImpl: stubFetch(vault), log: (line) => lines.push(line),
          });
          if (required) await assert.rejects(pending, /Missing required Infisical name\(s\): FOO/);
          else await pending;
          assert.equal(existsSync(envFile), false);
          assert.ok(lines.some((line) => line.startsWith("::warning::FOO ")));
          assert.ok(lines.every((line) => !line.includes("SENTINEL_KEY_ref_3c9e")));
        } finally { rmSync(dir, { recursive: true, force: true }); }
      });
    }
  }
});

test("a valid literal vault value ignores an unused reference fallback and unselected reference", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bf-reference-unselected-"));
  try {
    const envFile = join(dir, "env");
    const lines = [];
    await run({
      env: { ...baseEnv(envFile, "FOO"), INFISICAL_REQUIRED: "FOO", GH_FALLBACK_FOO: REFERENCE },
      fetchImpl: stubFetch({ FOO: RESOLVED, UNSELECTED: REFERENCE }), log: (line) => lines.push(line),
    });
    assert.ok(readFileSync(envFile, "utf8").includes(RESOLVED));
    assert.ok(lines.every((line) => !line.includes("reference") && !line.includes("UNSELECTED")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("wrong or missing required row provenance never exports a vault value", async (t) => {
  const cases = [
    ["wrong project", { workspace: "another-project" }],
    ["missing project", { workspace: undefined }],
    ["wrong environment", { environment: "staging" }],
    ["missing environment", { environment: undefined }],
    ["wrong folder", { secretPath: "/another-folder" }],
    ["descendant folder", { secretPath: "/nested/child" }],
    ["malformed optional folder", { secretPath: null }],
    ["empty optional folder", { secretPath: "" }],
    ["duplicate root separator", { secretPath: "///" }],
    ["dot root alias", { secretPath: "/./" }],
    ["parent root alias", { secretPath: "/fleet/../" }],
    ["hidden value", { secretValueHidden: true }],
    ["missing hidden flag", { secretValueHidden: undefined }],
    ["malformed hidden flag", { secretValueHidden: "false" }],
    ["missing value", { secretValue: undefined }],
    ["malformed value", { secretValue: { private: RESOLVED } }],
    ["missing key", { secretKey: undefined }],
    ["malformed key", { secretKey: 123 }],
  ];
  for (const [label, rowOverrides] of cases) {
    for (const hasFallback of [false, true]) {
      await t.test(`${label}, fallback ${hasFallback ? "present" : "absent"}`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "bf-row-provenance-"));
        try {
          const envFile = join(dir, "env");
          const lines = [];
          const fallback = "sentinel-existing-github-fallback";
          const pending = run({
            env: { ...baseEnv(envFile, "FOO"), INFISICAL_REQUIRED: "FOO", GH_FALLBACK_FOO: hasFallback ? fallback : "" },
            fetchImpl: stubFetch({ FOO: RESOLVED }, [], rowOverrides), log: (line) => lines.push(line),
          });
          if (hasFallback) {
            await pending;
            const exported = readFileSync(envFile, "utf8");
            assert.ok(exported.includes(fallback));
            assert.ok(!exported.includes(RESOLVED));
          } else {
            await assert.rejects(pending, /Missing required Infisical name\(s\): FOO/);
            assert.equal(existsSync(envFile), false);
          }
          assert.ok(lines.every((line) => !line.includes(RESOLVED) && !line.includes("another-project") && !line.includes("another-folder")));
        } finally { rmSync(dir, { recursive: true, force: true }); }
      });
    }
  }
});

test("v3 optional folder provenance may be omitted or exactly match with trailing slashes", async (t) => {
  for (const rowOverrides of [{}, { secretPath: "/" }]) {
    await t.test(`folder ${rowOverrides.secretPath ?? "omitted"}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "bf-row-folder-"));
      try {
        const envFile = join(dir, "env");
        await run({ env: { ...baseEnv(envFile, "FOO"), INFISICAL_REQUIRED: "FOO" },
          fetchImpl: stubFetch({ FOO: RESOLVED }, [], rowOverrides), log: () => {} });
        assert.ok(readFileSync(envFile, "utf8").includes(RESOLVED));
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});
