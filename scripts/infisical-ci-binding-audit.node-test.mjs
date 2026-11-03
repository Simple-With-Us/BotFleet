import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
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
    GITHUB_REF: "refs/heads/codex/bf-2622-infisical-auth",
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

test("branch and expected SHA are checked before any network call", async () => {
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

test("workflow audit mode skips all normal package jobs without replacing their check names", () => {
  const workflow = readFileSync(new URL("../.github/workflows/mac-package-gate.yml", import.meta.url), "utf8");
  const lines = workflow.split("\n");
  const jobSection = (job) => {
    const start = lines.findIndex((line) => line === `  ${job}:`);
    assert.notEqual(start, -1, `${job} job exists`);
    let end = start + 1;
    while (end < lines.length && !/^  [a-z][a-z0-9-]*:$/.test(lines[end])) end++;
    return lines.slice(start, end).join("\n");
  };
  for (const job of ["scope", "package"]) {
    const section = jobSection(job);
    assert.match(section, /inputs\.audit_infisical_bindings == true/, `${job} must be gated in audit mode`);
  }
  assert.match(jobSection("scope"), /'Classify Mac packaging scope'/);
  assert.match(jobSection("scope"), /'Audit-only: Mac packaging classifier skipped'/);
  assert.match(jobSection("package"), /'Unsigned arm64 package \(prepare-cua \+ plist\)'/);
  assert.match(jobSection("package"), /'Audit-only: unsigned package skipped'/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /expected_head_sha/);
  assert.match(workflow, /\[\[ "\$REF" == refs\/heads\/codex\/\* \]\]/);
  assert.match(workflow, /format\('mac-package-audit-/);
  assert.match(workflow, /format\('mac-package-gate-/);
  assert.match(workflow, /node-version: 26/);
  assert.ok(workflow.indexOf("node-version: 26") < workflow.indexOf("Audit existing read-token bindings"));
  assert.doesNotMatch(workflow, /^\s+workflow_run:/m);
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.match(workflow, /^  pull_request:/m);
  assert.doesNotMatch(workflow, /secrets\.INFISICAL_VERCEL_CATCH_UP_READ_TOKEN/);
});
