import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { listSecretsRaw, isUnresolvedReference } from "./infisical-fetch.mjs";

const bindings = [
  {
    name: "INFISICAL_IOS_SHIP_READ_TOKEN",
    consumers: [
      { name: "ios-ship-signing-plan", keys: ["APPLE_API_KEY_ID", "APPLE_API_ISSUER_ID", "APPLE_API_KEY_P8_BASE64", "IOS_CERT_P12_BASE64", "IOS_CERT_PASSWORD", "SENTRY_DSN", "SENTRY_AUTH_TOKEN"], required: ["APPLE_API_KEY_ID", "APPLE_API_ISSUER_ID", "APPLE_API_KEY_P8_BASE64", "IOS_CERT_P12_BASE64", "IOS_CERT_PASSWORD"], fallbackKeys: ["SENTRY_DSN", "SENTRY_AUTH_TOKEN"] },
      { name: "ios-ship-archive", keys: ["APPLE_API_KEY_ID", "APPLE_API_ISSUER_ID", "APPLE_API_KEY_P8_BASE64", "IOS_CERT_P12_BASE64", "IOS_CERT_PASSWORD", "SENTRY_DSN", "SENTRY_AUTH_TOKEN"], required: ["APPLE_API_KEY_ID", "APPLE_API_ISSUER_ID", "APPLE_API_KEY_P8_BASE64", "IOS_CERT_P12_BASE64", "IOS_CERT_PASSWORD"], fallbackKeys: ["SENTRY_DSN", "SENTRY_AUTH_TOKEN"] },
      { name: "electron-build-plan", keys: ["APPLE_API_KEY_ID", "APPLE_API_ISSUER_ID", "APPLE_API_KEY_P8_BASE64"], required: ["APPLE_API_KEY_ID", "APPLE_API_ISSUER_ID", "APPLE_API_KEY_P8_BASE64"], fallbackKeys: [] },
      { name: "mac-commit-build-plan", keys: ["APPLE_API_KEY_ID", "APPLE_API_ISSUER_ID", "APPLE_API_KEY_P8_BASE64"], required: ["APPLE_API_KEY_ID", "APPLE_API_ISSUER_ID", "APPLE_API_KEY_P8_BASE64"], fallbackKeys: [] },
    ],
  },
  {
    name: "INFISICAL_RELEASE_READ_TOKEN",
    consumers: [
      { name: "electron-developer-id-certificate", keys: ["MAC_CERT_P12_BASE64", "MAC_CERT_PASSWORD"], required: ["MAC_CERT_P12_BASE64", "MAC_CERT_PASSWORD"], fallbackKeys: ["MAC_CERT_P12_BASE64", "MAC_CERT_PASSWORD"] },
      { name: "electron-sentry-build", keys: ["SENTRY_DSN", "VITE_SENTRY_DSN", "SENTRY_AUTH_TOKEN"], required: [], fallbackKeys: ["SENTRY_DSN", "VITE_SENTRY_DSN", "SENTRY_AUTH_TOKEN"], fallbackAliases: { VITE_SENTRY_DSN: "SENTRY_DSN" } },
      { name: "electron-notarization", keys: ["APPLE_API_KEY_P8_BASE64", "APPLE_API_KEY_ID", "APPLE_API_ISSUER_ID"], required: ["APPLE_API_KEY_P8_BASE64", "APPLE_API_KEY_ID", "APPLE_API_ISSUER_ID"], fallbackKeys: ["APPLE_API_KEY_P8_BASE64", "APPLE_API_KEY_ID", "APPLE_API_ISSUER_ID"] },
    ],
  },
  {
    name: "INFISICAL_MAC_COMMIT_BUILD_READ_TOKEN",
    consumers: [
      { name: "mac-commit-developer-id-certificate", keys: ["MAC_CERT_P12_BASE64", "MAC_CERT_PASSWORD"], required: ["MAC_CERT_P12_BASE64", "MAC_CERT_PASSWORD"], fallbackKeys: ["MAC_CERT_P12_BASE64", "MAC_CERT_PASSWORD"] },
    ],
  },
  {
    name: "INFISICAL_NATIVE_RELEASE_READ_TOKEN",
    consumers: [
      { name: "native-mac-build-plan", keys: ["APPLE_API_KEY_ID", "APPLE_API_ISSUER_ID", "APPLE_API_KEY_P8_BASE64"], required: ["APPLE_API_KEY_ID", "APPLE_API_ISSUER_ID", "APPLE_API_KEY_P8_BASE64"], fallbackKeys: [] },
      { name: "native-mac-developer-id-certificate", keys: ["MAC_CERT_P12_BASE64", "MAC_CERT_PASSWORD"], required: ["MAC_CERT_P12_BASE64", "MAC_CERT_PASSWORD"], fallbackKeys: ["MAC_CERT_P12_BASE64", "MAC_CERT_PASSWORD"] },
      { name: "native-mac-sentry", keys: ["SENTRY_DSN"], required: [], fallbackKeys: ["SENTRY_DSN"] },
      { name: "native-mac-notarization", keys: ["APPLE_API_KEY_P8_BASE64", "APPLE_API_KEY_ID", "APPLE_API_ISSUER_ID"], required: ["APPLE_API_KEY_P8_BASE64", "APPLE_API_KEY_ID", "APPLE_API_ISSUER_ID"], fallbackKeys: ["APPLE_API_KEY_P8_BASE64", "APPLE_API_KEY_ID", "APPLE_API_ISSUER_ID"] },
      { name: "native-mac-sparkle-appcast", keys: ["SPARKLE_EDDSA_PRIVATE_KEY_B64"], required: [], fallbackKeys: [] },
    ],
  },
  {
    name: "INFISICAL_SENTRY_DEPLOY_READ_TOKEN",
    consumers: [
      { name: "sentry-production-deploy", keys: ["SENTRY_AUTH_TOKEN"], required: [], fallbackKeys: ["SENTRY_AUTH_TOKEN"] },
    ],
  },
  {
    name: "INFISICAL_SENTRY_CI_REPORT_READ_TOKEN",
    consumers: [
      { name: "sentry-ci-report", keys: ["SENTRY_FLEET_DSN"], required: [], fallbackKeys: ["SENTRY_FLEET_DSN"] },
    ],
  },
  {
    name: "INFISICAL_SENTRY_TESTFLIGHT_READ_TOKEN",
    consumers: [
      { name: "sentry-testflight-report", keys: ["SENTRY_AUTH_TOKEN"], required: ["SENTRY_AUTH_TOKEN"], fallbackKeys: ["SENTRY_AUTH_TOKEN"] },
    ],
  },
];

const fallbackEnv = {
  APPLE_API_KEY_ID: "GH_FALLBACK_APPLE_API_KEY_ID",
  APPLE_API_ISSUER_ID: "GH_FALLBACK_APPLE_API_ISSUER_ID",
  APPLE_API_KEY_P8_BASE64: "GH_FALLBACK_APPLE_API_KEY_P8_BASE64",
  MAC_CERT_P12_BASE64: "GH_FALLBACK_MAC_CERT_P12_BASE64",
  MAC_CERT_PASSWORD: "GH_FALLBACK_MAC_CERT_PASSWORD",
  SENTRY_DSN: "GH_FALLBACK_SENTRY_DSN",
  SENTRY_AUTH_TOKEN: "GH_FALLBACK_SENTRY_AUTH_TOKEN",
  SENTRY_FLEET_DSN: "GH_FALLBACK_SENTRY_FLEET_DSN",
};

const configuredSiteUrl = "https://app.infisical.com";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NATIVE_PRIVATE_KEY_NAME = "SPARKLE_EDDSA_PRIVATE_KEY_B64";
const NATIVE_CONFIG_NAME_PATTERN = /(?:APPCAST|(?:NATIVE|SPARKLE|UPDATE).*?(?:FEED|PUBLIC(?:_?ED)?_?KEY)|SUPUBLICEDKEY)/;

function isTrue(value) {
  return value === true || value === "true";
}

/* oxlint-disable anti-slop/no-runtime-typeof -- Validate untrusted service-token metadata with the dependency-free CI runtime. */
function parseScopes(value) {
  const scopes = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(scopes) || scopes.length === 0) throw new Error("Invalid scopes");
  return scopes.map((scope) => {
    if (!scope || typeof scope !== "object" || Array.isArray(scope) ||
        typeof scope.environment !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(scope.environment) ||
        typeof scope.secretPath !== "string" || !/^\/[A-Za-z0-9._/-]{0,200}$/.test(scope.secretPath)) {
      throw new Error("Invalid scope row");
    }
    return { environment: scope.environment, secretPath: scope.secretPath };
  });
}

function safeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  if (typeof metadata.id !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(metadata.id)) return null;
  let scopes;
  try {
    scopes = parseScopes(metadata.scopes);
  } catch {
    return null;
  }
  const permissions = metadata.permissions;
  if (!Array.isArray(permissions) || !permissions.every((item) => item === "read" || item === "write")) return null;
  if (metadata.expiresAt !== null) {
    if (typeof metadata.expiresAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-][01]\d:[0-5]\d|[+-]2[0-3]:[0-5]\d)$/.test(metadata.expiresAt)) return null;
    const expiry = Date.parse(metadata.expiresAt);
    const day = metadata.expiresAt.slice(0, 10);
    const calendarDay = Date.parse(`${day}T00:00:00Z`);
    if (!Number.isFinite(expiry) || !Number.isFinite(calendarDay) || new Date(calendarDay).toISOString().slice(0, 10) !== day) return null;
  }
  return {
    id: typeof metadata.id === "string" ? metadata.id : null,
    workspace: typeof metadata.workspace === "string" ? metadata.workspace : null,
    projectId: typeof metadata.projectId === "string" ? metadata.projectId : null,
    scopes,
    permissions: [...permissions],
    expiresAt: metadata.expiresAt,
  };
}
/* oxlint-enable anti-slop/no-runtime-typeof */

/* oxlint-disable anti-slop/no-runtime-typeof -- Inspect only names and row provenance from the already-authorized raw response. */
async function observeNativeConfigNames(response, projectId) {
  if (!response.ok) return { status: "unknown", names: [] };
  let body;
  try {
    body = await response.clone().json();
  } catch {
    return { status: "unknown", names: [] };
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.secrets)) {
    return { status: "unknown", names: [] };
  }
  const names = new Set();
  let provenanceComplete = true;
  for (const row of body.secrets) {
    if (!row || typeof row !== "object" || Array.isArray(row) ||
        typeof row.secretKey !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(row.secretKey) ||
        row.workspace !== projectId || row.environment !== "prod" ||
        (row.secretPath !== undefined && (typeof row.secretPath !== "string" ||
          !row.secretPath.startsWith("/") || /[*?[\]{}]/.test(row.secretPath) ||
          row.secretPath.replace(/\/+$/, "") !== ""))) {
      provenanceComplete = false;
      continue;
    }
    if (row.secretKey === NATIVE_PRIVATE_KEY_NAME ||
        (NATIVE_CONFIG_NAME_PATTERN.test(row.secretKey) && !row.secretKey.startsWith("INFISICAL_") &&
          !/(?:_TOKEN|_SECRET|_PASSWORD)$/.test(row.secretKey))) {
      names.add(row.secretKey);
    }
  }
  return provenanceComplete
    ? { status: "complete", names: [...names].sort() }
    : { status: "unknown", names: [] };
}
/* oxlint-enable anti-slop/no-runtime-typeof */

function boolEnv(env, name) {
  return isTrue(env[name]);
}

function tokenDigest(id) {
  if (!id) return null;
  return createHash("sha256").update(id).digest("hex");
}

function isExpectedScope(metadata, projectId) {
  return metadata && metadata.workspace === projectId &&
    (metadata.projectId === null || metadata.projectId === projectId) &&
    metadata.permissions.length === 1 && metadata.permissions[0] === "read" &&
    metadata.scopes.length === 1 && metadata.scopes[0].environment === "prod" &&
    metadata.scopes[0].secretPath.replace(/\/+$/, "") === "";
}

async function auditBinding(binding, { env, projectId, fetchImpl, logger }) {
  const token = String(env[binding.name] ?? "").trim();
  const keys = [...new Set(binding.consumers.flatMap((consumer) => consumer.keys))];
  const consumerRows = Object.fromEntries(binding.consumers.map((consumer) => [consumer.name,
    Object.fromEntries(consumer.keys.map((key) => {
      const sourceKey = consumer.fallbackAliases?.[key] ?? key;
      const fallbackPresent = consumer.fallbackKeys.includes(key) && fallbackEnv[sourceKey]
        ? boolEnv(env, fallbackEnv[sourceKey])
        : false;
      return [key, { present: false, referencePresent: false, fallbackPresent, ready: false, availabilityUnverified: fallbackPresent }];
    }))]));
  const row = {
    binding: binding.name,
    tokenPresent: Boolean(token),
    tokenIdDigest: null,
    scopes: [],
    permissions: [],
    expiresAt: null,
    consumers: consumerRows,
    auditPassed: false,
  };
  if (binding.name === "INFISICAL_NATIVE_RELEASE_READ_TOKEN") {
    row.nativeConfigNames = {
      status: "unknown",
      names: [],
      sparklePrivateKeyName: "unknown",
      sparklePrivateKeyLiteralValuePresent: null,
    };
  }
  if (!token || !projectId || !UUID_PATTERN.test(projectId)) {
    row.reason = !token ? "binding-missing" : !projectId ? "project-binding-missing" : "project-binding-invalid";
  } else {
    let captured = null;
    let grantVerified = false;
    let nativeNamesCandidate = null;
    const captureFetch = async (url, init) => {
      const response = await fetchImpl(url, { ...init, redirect: "error" });
      if (String(url).includes("/api/v2/service-token")) {
        try {
          captured = safeMetadata(await response.clone().json());
        } catch {
          captured = null;
        }
        if (!isExpectedScope(captured, projectId)) throw new Error("Infisical audit grant rejected.");
      } else if (binding.name === "INFISICAL_NATIVE_RELEASE_READ_TOKEN" &&
          String(url).includes("/api/v3/secrets/raw?")) {
        nativeNamesCandidate = await observeNativeConfigNames(response, projectId);
      }
      return response;
    };
    try {
      const values = await listSecretsRaw({
        siteUrl: configuredSiteUrl,
        token,
        projectId,
        environment: "prod",
        secretPath: "/",
        names: keys,
        fetchImpl: captureFetch,
        log: () => {},
      });
      grantVerified = true;
      for (const consumer of binding.consumers) {
        for (const key of consumer.keys) {
          const fallbackPresent = row.consumers[consumer.name][key].fallbackPresent;
          const value = values.get(key);
          const referencePresent = value !== undefined && isUnresolvedReference(value);
          const usableValue = value !== undefined && value.trim().length > 0 && !referencePresent;
          row.consumers[consumer.name][key] = {
            present: usableValue,
            referencePresent,
            fallbackPresent,
            ready: usableValue,
            availabilityUnverified: !usableValue && fallbackPresent,
          };
        }
      }
      if (row.nativeConfigNames && nativeNamesCandidate) {
        row.nativeConfigNames.status = nativeNamesCandidate.status;
        row.nativeConfigNames.names = nativeNamesCandidate.names;
        if (nativeNamesCandidate.status === "complete") {
          const namePresent = nativeNamesCandidate.names.includes(NATIVE_PRIVATE_KEY_NAME);
          row.nativeConfigNames.sparklePrivateKeyName = namePresent ? "present" : "absent";
          row.nativeConfigNames.sparklePrivateKeyLiteralValuePresent =
            row.consumers["native-mac-sparkle-appcast"][NATIVE_PRIVATE_KEY_NAME].ready;
        }
      }
    } catch {
      row.reason = captured && !isExpectedScope(captured, projectId)
        ? "scope-or-metadata-invalid"
        : "service-token-audit-failed";
    }
    if (grantVerified && captured && isExpectedScope(captured, projectId)) {
      row.tokenIdDigest = tokenDigest(captured.id);
      row.scopes = captured.scopes;
      row.permissions = captured.permissions;
      row.expiresAt = captured.expiresAt;
    }
  }
  const requiredFailures = binding.consumers.flatMap((consumer) => consumer.required
    .filter((key) => !row.consumers[consumer.name][key].ready));
  if (requiredFailures.length) row.reason ??= "required-key-unavailable";
  row.auditPassed = !row.reason;
  logger(JSON.stringify(row));
  return row;
}

export async function runAudit({ env = process.env, fetchImpl = fetch, logger = console.log } = {}) {
  const actualSha = String(env.GITHUB_SHA ?? "").toLowerCase();
  const expectedSha = String(env.EXPECTED_HEAD_SHA ?? "").toLowerCase();
  const ref = String(env.GITHUB_REF ?? "");
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch" || ref !== "refs/heads/main" ||
      String(env.GITHUB_REF_PROTECTED) !== "true" || !/^[0-9a-f]{40}$/.test(expectedSha) || actualSha !== expectedSha) {
    logger("Infisical binding audit refused: an exact protected-main dispatch is required.");
    return { ok: false, bindings: [], vercel: "paused: dedicated binding pending" };
  }
  const projectId = String(env.INFISICAL_PROJECT_ID ?? "").trim();
  const rows = [];
  for (const binding of bindings) {
    rows.push(await auditBinding(binding, { env, projectId, fetchImpl, logger }));
  }
  logger(JSON.stringify({ vercel: "paused: dedicated binding pending; not queried" }));
  return { ok: rows.every((row) => row.auditPassed), bindings: rows, vercel: "paused: dedicated binding pending" };
}

let isDirectEntry = false;
try { isDirectEntry = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { /* Imported or nonexistent entry. */ }
if (isDirectEntry) {
  runAudit().then((result) => {
    if (!result.ok) process.exitCode = 1;
  }).catch(() => {
    console.error("Infisical binding audit failed without exposing provider details.");
    process.exitCode = 1;
  });
}
