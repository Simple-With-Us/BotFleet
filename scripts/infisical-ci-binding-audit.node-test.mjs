import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse } from "yaml";
import { runAudit } from "./infisical-ci-binding-audit.mjs";

const tokenNames = [
  "INFISICAL_IOS_SHIP_READ_TOKEN",
  "INFISICAL_RELEASE_READ_TOKEN",
  "INFISICAL_MAC_COMMIT_BUILD_READ_TOKEN",
  "INFISICAL_NATIVE_RELEASE_READ_TOKEN",
  "INFISICAL_SENTRY_DEPLOY_READ_TOKEN",
  "INFISICAL_SENTRY_CI_REPORT_READ_TOKEN",
  "INFISICAL_SENTRY_TESTFLIGHT_READ_TOKEN",
];

function fixtureEnv(overrides = {}) {
  return {
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REF_PROTECTED: "true",
    GITHUB_SHA: "a".repeat(40),
    EXPECTED_HEAD_SHA: "a".repeat(40),
    INFISICAL_PROJECT_ID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ...Object.fromEntries(tokenNames.map((name, index) => [name, `fixture-token-${index}`])),
    GH_FALLBACK_APPLE_API_KEY_ID: "false",
    GH_FALLBACK_APPLE_API_ISSUER_ID: "false",
    GH_FALLBACK_APPLE_API_KEY_P8_BASE64: "false",
    GH_FALLBACK_IOS_CERT_P12_BASE64: "false",
    GH_FALLBACK_IOS_CERT_PASSWORD: "false",
    GH_FALLBACK_MAC_CERT_P12_BASE64: "false",
    GH_FALLBACK_MAC_CERT_PASSWORD: "false",
    GH_FALLBACK_SENTRY_DSN: "false",
    GH_FALLBACK_SENTRY_AUTH_TOKEN: "false",
    GH_FALLBACK_SENTRY_FLEET_DSN: "false",
    ...overrides,
  };
}

function validMetadata() {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    workspace: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    projectId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    scopes: JSON.stringify([{ environment: "prod", secretPath: "/" }]),
    permissions: ["read"],
    expiresAt: null,
  };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("audit checks only the seven configured read bindings and emits metadata without values", async () => {
  const requests = [];
  const logs = [];
  const env = fixtureEnv({
    GH_FALLBACK_APPLE_API_KEY_ID: "true",
    GH_FALLBACK_APPLE_API_ISSUER_ID: "true",
    GH_FALLBACK_APPLE_API_KEY_P8_BASE64: "true",
    GH_FALLBACK_MAC_CERT_P12_BASE64: "true",
    GH_FALLBACK_MAC_CERT_PASSWORD: "true",
  });
  const result = await runAudit({
    env,
    logger: (line) => logs.push(line),
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).includes("/api/v2/service-token")) return response(validMetadata());
      const params = new URL(String(url)).searchParams;
      assert.equal(params.get("workspaceId"), "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
      assert.equal(params.get("environment"), "prod");
      assert.equal(params.get("secretPath"), "/");
      assert.equal(params.get("expandSecretReferences"), "false");
      assert.equal(params.get("include_imports"), "false");
      assert.equal(params.get("recursive"), "false");
      assert.equal(params.get("viewSecretValue"), "true");
      return response({ secrets: [
        "APPLE_API_KEY_ID", "APPLE_API_ISSUER_ID", "APPLE_API_KEY_P8_BASE64",
        "IOS_CERT_P12_BASE64", "IOS_CERT_PASSWORD", "MAC_CERT_P12_BASE64", "MAC_CERT_PASSWORD",
        "SENTRY_DSN", "SENTRY_AUTH_TOKEN", "SENTRY_FLEET_DSN", "VITE_SENTRY_DSN", "SPARKLE_EDDSA_PRIVATE_KEY_B64",
      ].map((secretKey) => ({
        workspace: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        environment: "prod",
        secretKey,
        secretValue: "fixture-secret-value-never-log",
        secretValueHidden: false,
      })) });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.bindings.length, 7);
  assert.equal(requests.length, 14);
  assert.deepEqual(result.bindings.map((row) => row.binding), tokenNames);
  assert.ok(result.bindings.every((row) => row.auditPassed && row.permissions.join(",") === "read"));
  assert.match(result.bindings[0].tokenIdDigest, /^[a-f0-9]{64}$/);
  const iosShip = result.bindings.find((row) => row.binding === "INFISICAL_IOS_SHIP_READ_TOKEN");
  assert.equal(iosShip.consumers["electron-build-plan"].APPLE_API_KEY_ID.fallbackPresent, false);
  assert.equal(iosShip.consumers["mac-commit-build-plan"].APPLE_API_KEY_ID.ready, true);
  const release = result.bindings.find((row) => row.binding === "INFISICAL_RELEASE_READ_TOKEN");
  assert.equal(Object.hasOwn(release.consumers, "electron-build-plan"), false);
  assert.equal(release.consumers["electron-notarization"].APPLE_API_KEY_ID.fallbackPresent, true);
  const macCommit = result.bindings.find((row) => row.binding === "INFISICAL_MAC_COMMIT_BUILD_READ_TOKEN");
  assert.deepEqual(Object.keys(macCommit.consumers["mac-commit-developer-id-certificate"]), ["MAC_CERT_P12_BASE64", "MAC_CERT_PASSWORD"]);
  assert.ok(requests.every(({ init }) => init.method === "GET" && init.redirect === "error"));
  assert.ok(logs.join("\n").includes('"expiresAt":null'));
  assert.ok(!logs.join("\n").includes("fixture-secret-value-never-log"));
  assert.ok(!logs.join("\n").includes("fixture-token-"));
  assert.ok(!logs.join("\n").includes("11111111-2222-4333-8444-555555555555"));
  assert.ok(logs.join("\n").includes("not queried"));
});

test("fallback presence is reported without treating it as verified key availability", async () => {
  const env = fixtureEnv({
    ...Object.fromEntries(tokenNames.map((name) => [name, ""])),
    INFISICAL_RELEASE_READ_TOKEN: "fixture-release-token",
    GH_FALLBACK_MAC_CERT_P12_BASE64: "true",
    GH_FALLBACK_MAC_CERT_PASSWORD: "true",
    GH_FALLBACK_APPLE_API_KEY_ID: "true",
    GH_FALLBACK_APPLE_API_ISSUER_ID: "true",
    GH_FALLBACK_APPLE_API_KEY_P8_BASE64: "true",
  });
  let rawCalls = 0;
  const logs = [];
  const result = await runAudit({
    env,
    logger: (line) => logs.push(line),
    fetchImpl: async (url) => {
      if (String(url).includes("/api/v2/service-token")) return response(validMetadata());
      rawCalls++;
      return response({ secrets: [{
        workspace: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", environment: "prod", secretKey: "MAC_CERT_P12_BASE64",
        secretValue: "${UNRESOLVED_REFERENCE}", secretValueHidden: false,
      }] });
    },
  });

  assert.equal(rawCalls, 1);
  assert.equal(result.ok, false);
  const release = result.bindings.find((row) => row.binding === "INFISICAL_RELEASE_READ_TOKEN");
  const certConsumer = release.consumers["electron-developer-id-certificate"];
  assert.equal(certConsumer.MAC_CERT_P12_BASE64.referencePresent, true);
  assert.equal(certConsumer.MAC_CERT_P12_BASE64.fallbackPresent, true);
  assert.equal(certConsumer.MAC_CERT_P12_BASE64.ready, false);
  assert.equal(certConsumer.MAC_CERT_P12_BASE64.availabilityUnverified, true);
  const releaseNotarization = release.consumers["electron-notarization"];
  assert.equal(releaseNotarization.APPLE_API_ISSUER_ID.fallbackPresent, true);
  assert.equal(releaseNotarization.APPLE_API_ISSUER_ID.ready, false);
  assert.equal(releaseNotarization.APPLE_API_ISSUER_ID.availabilityUnverified, true);
  assert.equal(certConsumer.MAC_CERT_PASSWORD.ready, false);
  assert.ok(!logs.join("\n").includes("UNRESOLVED_REFERENCE"));
});

test("provider failure output is generic and missing bindings fail closed", async () => {
  const env = fixtureEnv({
    ...Object.fromEntries(tokenNames.map((name) => [name, ""])),
    INFISICAL_IOS_SHIP_READ_TOKEN: "fixture-credential-do-not-log",
  });
  const logs = [];
  const result = await runAudit({
    env,
    logger: (line) => logs.push(line),
    fetchImpl: async () => response({ error: "provider echoed fixture-credential-do-not-log and private payload" }, 403),
  });
  assert.equal(result.ok, false);
  assert.equal(result.bindings[0].reason, "service-token-audit-failed");
  assert.equal(result.bindings[1].reason, "binding-missing");
  assert.ok(!logs.join("\n").includes("fixture-credential-do-not-log"));
  assert.ok(!logs.join("\n").includes("private payload"));
});

test("a broader service-token grant is reported but never reaches the raw-secret endpoint", async () => {
  const env = fixtureEnv({
    ...Object.fromEntries(tokenNames.map((name) => [name, ""])),
    INFISICAL_IOS_SHIP_READ_TOKEN: "fixture-token",
  });
  let rawCalls = 0;
  const result = await runAudit({
    env,
    logger: () => {},
    fetchImpl: async (url) => {
      if (String(url).includes("/api/v2/service-token")) {
        return response({ ...validMetadata(), scopes: [
          { environment: "prod", secretPath: "/" },
          { environment: "dev", secretPath: "/" },
        ] });
      }
      rawCalls++;
      return response({ secrets: [] });
    },
  });
  assert.equal(rawCalls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.bindings[0].reason, "scope-or-metadata-invalid");
  assert.equal(result.bindings[0].scopes.length, 0);
});

test("native name-only observation sees hidden names separately from usable literal values", async () => {
  const env = fixtureEnv({
    ...Object.fromEntries(tokenNames.map((name) => [name, ""])),
    INFISICAL_NATIVE_RELEASE_READ_TOKEN: "fixture-native-token",
  });
  let calls = 0;
  const logs = [];
  const result = await runAudit({
    env,
    logger: (line) => logs.push(line),
    fetchImpl: async (url) => {
      calls++;
      if (String(url).includes("/api/v2/service-token")) return response(validMetadata());
      return response({ secrets: [
        { workspace: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", environment: "prod", secretPath: "/", secretKey: "SPARKLE_EDDSA_PRIVATE_KEY_B64", secretValueHidden: true },
        { workspace: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", environment: "prod", secretPath: "/", secretKey: "SPARKLE_PUBLIC_ED_KEY", secretValueHidden: true },
        { workspace: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", environment: "prod", secretPath: "/", secretKey: "NATIVE_UPDATE_FEED_URL", secretValueHidden: true },
        { workspace: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", environment: "prod", secretPath: "/", secretKey: "APPCAST_BASE_URL", secretValueHidden: true },
        { workspace: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", environment: "prod", secretPath: "/", secretKey: "NATIVE_LOG_LEVEL", secretValueHidden: true },
      ] });
    },
  });
  const native = result.bindings.find((row) => row.binding === "INFISICAL_NATIVE_RELEASE_READ_TOKEN");
  assert.equal(calls, 2);
  assert.equal(native.nativeConfigNames.status, "complete");
  assert.deepEqual(native.nativeConfigNames.names, ["APPCAST_BASE_URL", "NATIVE_UPDATE_FEED_URL", "SPARKLE_EDDSA_PRIVATE_KEY_B64", "SPARKLE_PUBLIC_ED_KEY"]);
  assert.equal(native.nativeConfigNames.sparklePrivateKeyName, "present");
  assert.equal(native.nativeConfigNames.sparklePrivateKeyLiteralValuePresent, false);
  assert.ok(!logs.join("\n").includes("fixture-native-token"));
});

test("native name-only observation stays unknown when any row provenance is not established", async () => {
  const env = fixtureEnv({
    ...Object.fromEntries(tokenNames.map((name) => [name, ""])),
    INFISICAL_NATIVE_RELEASE_READ_TOKEN: "fixture-native-token",
  });
  const result = await runAudit({
    env,
    logger: () => {},
    fetchImpl: async (url) => {
      if (String(url).includes("/api/v2/service-token")) return response(validMetadata());
      return response({ secrets: [
        { workspace: "wrong-project", environment: "prod", secretPath: "/", secretKey: "SPARKLE_EDDSA_PRIVATE_KEY_B64", secretValueHidden: true },
      ] });
    },
  });
  const native = result.bindings.find((row) => row.binding === "INFISICAL_NATIVE_RELEASE_READ_TOKEN");
  assert.equal(native.nativeConfigNames.status, "unknown");
  assert.deepEqual(native.nativeConfigNames.names, []);
  assert.equal(native.nativeConfigNames.sparklePrivateKeyName, "unknown");
  assert.equal(native.nativeConfigNames.sparklePrivateKeyLiteralValuePresent, null);
});

test("expected SHA metadata is checked before any network call", async () => {
  let calls = 0;
  const logs = [];
  const result = await runAudit({
    env: fixtureEnv({ GITHUB_REF: "refs/heads/main", EXPECTED_HEAD_SHA: "b".repeat(40) }),
    logger: (line) => logs.push(line),
    fetchImpl: async () => { calls++; throw new Error("must not call network"); },
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
  assert.match(logs[0], /refused/);
});

test("untrusted dispatch contexts are rejected before project or token reads", async (t) => {
  const cases = [
    ["unprotected branch", { GITHUB_REF: "refs/heads/codex/untrusted", GITHUB_REF_PROTECTED: "false" }],
    ["protected branch", { GITHUB_REF: "refs/heads/codex/untrusted" }],
    ["unprotected main", { GITHUB_REF_PROTECTED: "false" }],
    ["missing protection metadata", { GITHUB_REF_PROTECTED: undefined }],
    ["noncanonical protection metadata", { GITHUB_REF_PROTECTED: "TRUE" }],
    ["tag", { GITHUB_REF: "refs/tags/main" }],
    ["pull request event", { GITHUB_EVENT_NAME: "pull_request" }],
    ["mismatched expected SHA", { EXPECTED_HEAD_SHA: "b".repeat(40) }],
    ["missing expected SHA", { EXPECTED_HEAD_SHA: undefined }],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const env = fixtureEnv(overrides);
      let reads = 0;
      let calls = 0;
      for (const key of ["INFISICAL_PROJECT_ID", ...tokenNames]) {
        Object.defineProperty(env, key, { get() { reads++; throw new Error("binding must not be read"); } });
      }
      const result = await runAudit({ env, logger: () => {},
        fetchImpl: async () => { calls++; throw new Error("network must not be called"); } });
      assert.equal(result.ok, false);
      assert.deepEqual(result.bindings, []);
      assert.equal(reads, 0);
      assert.equal(calls, 0);
    });
  }
});

test("invalid project locator is rejected before querying or being logged", async () => {
  const invalidProject = "not-a-project-uuid-secret-looking-value";
  let calls = 0;
  const logs = [];
  const result = await runAudit({
    env: fixtureEnv({ INFISICAL_PROJECT_ID: invalidProject }),
    logger: (line) => logs.push(line),
    fetchImpl: async () => { calls++; throw new Error("must not call network"); },
  });
  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  assert.ok(result.bindings.every((row) => row.reason === "project-binding-invalid"));
  assert.ok(!logs.join("\n").includes(invalidProject));
});

test("the actual dispatch validation shell rejects untrusted contexts before its next step", { skip: process.platform === "win32" }, () => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/infisical-binding-preflight.yml", import.meta.url), "utf8"));
  const validation = workflow.jobs["audit-infisical-bindings"].steps.find((step) =>
    step.name === "Validate dispatch ref and expected commit before credential reads");
  const cases = [
    [true, {}],
    [true, { EXPECTED_SHA: "A".repeat(40) }],
    [true, { ACTUAL_SHA: "A".repeat(40) }],
    [true, { ACTUAL_SHA: "aA".repeat(20), EXPECTED_SHA: "Aa".repeat(20) }],
    [false, { REF: "refs/heads/codex/untrusted" }],
    [false, { REF_PROTECTED: "false" }],
    [false, { REF_PROTECTED: "" }],
    [false, { EVENT_NAME: "pull_request" }],
    [false, { EXPECTED_SHA: "b".repeat(40) }],
    [false, { EXPECTED_SHA: "not-a-sha" }],
  ];
  for (const [allowed, overrides] of cases) {
    const result = spawnSync("bash", ["--noprofile", "--norc", "-p", "-c", `${validation.run}\nprintf 'trusted-dispatch-ready\\n'`], {
      encoding: "utf8", env: { EVENT_NAME: "workflow_dispatch", REF: "refs/heads/main",
        REF_PROTECTED: "true", ACTUAL_SHA: "a".repeat(40), EXPECTED_SHA: "a".repeat(40), ...overrides },
    });
    assert.equal(result.status === 0, allowed, JSON.stringify(overrides));
    assert.equal(result.stdout, allowed ? "trusted-dispatch-ready\n" : "");
  }
});

test("preflight keeps credentials out of PR runs and pins protected-main dispatch", () => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/infisical-binding-preflight.yml", import.meta.url), "utf8"));
  const audit = workflow.jobs["audit-infisical-bindings"];
  assert.equal(audit.if, "${{ github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.ref_protected == true }}");
  assert.equal(workflow.jobs.test.if, "github.event_name == 'pull_request'");
  assert.doesNotMatch(JSON.stringify(workflow.jobs.test), /secrets\./);
  const checkout = audit.steps.find(step => String(step.uses ?? "").startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "${{ github.sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
});
