// The fake-credential fixture for BF-2622.
//
// One operator selection for the optional secret store is saved through the
// real config path, read back through the real settings resolver, and then
// read from a stubbed vault.
//
// Nothing here reaches a real credential, a live workspace or the network: the
// token references are fake paths inside the throwaway test home and fake
// environment variable names, and every value is a placeholder that is
// obviously not a credential.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  type AppConfig,
  infisicalConfigured,
  infisicalSettings,
  loadConfig,
  parseConfigPatch,
  saveConfig,
  validateInfisicalConfigPatch,
} from "./config.ts";
import { dataDir } from "./data-dir.ts";
import { infisical } from "./infisical.ts";
import { resolveSecretFields, setInfisicalSnapshot } from "./secret-map.ts";

// Obviously fake, and never sent anywhere real: these exist so the assertions
// have credential-shaped strings to look for.
const FAKE_READ_TOKEN = "fake-read-" + "token-not-a-credential";
const FAKE_WRITE_TOKEN = "fake-write-" + "token-not-a-credential";
const FAKE_WRITE_ONLY_TOKEN = "fake-write-" + "only-token-not-a-credential";
const FAKE_READ_ONLY_TOKEN = "fake-read-only-" + "token-not-a-credential";
const FAKE_VAULT_VALUE = "fake-vault-" + "value-not-a-credential";
const FAKE_LOCAL_VAL = "fake-local-" + "value-not-a-credential";
const FAKE_MACHINE_SECRET = "fake-machine-" + "secret-not-a-credential";

const WRITE_ONLY_ENV = "BF_FIXTURE_WRITE_ONLY_TOKEN";
const READ_ONLY_ENV = "BF_FIXTURE_READ_ONLY_TOKEN";

const PRIMARY_PROJECT = "primary-project";
const PRIMARY_FOLDER = "/app";

type OperatorSource = {
  name: string;
  projectId: string;
  environment: string;
  secretPath: string;
  tokenFile?: string;
  tokenEnv?: string;
  writeTokenFile?: string;
  writeTokenEnv?: string;
};

type OperatorSelection = {
  enabled: boolean;
  writeThrough: boolean;
  authMethod: "service-token" | "machine-identity";
  siteUrl: string;
  projectId: string;
  environment: string;
  secretPath: string;
  readSources: OperatorSource[];
};

type RecordedRequest = {
  url: string;
  authorization: string;
  method: string;
};

/** The body a write-through sends for one secret. */
const secretWriteBody = z.object({ secretValue: z.string().optional() });

type TokenGrant = {
  workspace: string;
  environment: string;
  secretPath: string;
  permissions: string[];
};

type FetchFixture = {
  calls: RecordedRequest[];
  vault: Map<string, string>;
  impl: (url: string, init?: RequestInit) => Promise<Response>;
};

/** A token file inside the throwaway test home: the only place the resolver
 * will read a credential reference from, and a fake one at that. */
function fakeTokenFile(value: string): string {
  mkdirSync(dataDir(), { recursive: true });
  const dir = mkdtempSync(join(dataDir(), "bf-infisical-fixture-"));
  const path = join(dir, "token");
  writeFileSync(path, `${value}\n`);
  chmodSync(path, 0o600);
  return path;
}

/** A path inside the throwaway test home that holds no token at all. */
function missingTokenFile(): string {
  mkdirSync(dataDir(), { recursive: true });
  const dir = mkdtempSync(join(dataDir(), "bf-infisical-fixture-"));
  return join(dir, "absent-token");
}

let grants = new Map<string, TokenGrant>();

/** The request headers as a plain string map, so a test can read the
 * authorization header off a stubbed fetch. */
function headerBag(init?: RequestInit): Record<string, string> {
  // SAFETY: every stubbed fetch in this file is called with a plain object of
  // string headers -- never a Headers instance and never an array of pairs --
  // so reading a header off this map cannot be wrong.
  return (init?.headers ?? {}) as Record<string, string>;
}

/** The stubbed transport: it answers the service-token metadata and the
 * secrets list, and it records every request so a test can see which
 * credential and which scope were used. */
function recordingFetch(): FetchFixture {
  const calls: RecordedRequest[] = [];
  const vault = new Map<string, string>([["COMPOSIO_API_KEY", FAKE_VAULT_VALUE]]);
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = headerBag(init);
    const authorization = headers.authorization ?? "";
    const target = String(url);
    calls.push({ url: target, authorization, method: init?.method ?? "GET" });

    if (target.includes("/api/v2/service-token")) {
      const grant = grants.get(authorization.replace(/^Bearer /, ""));
      if (!grant) return new Response("{}", { status: 403 });
      return new Response(JSON.stringify({
        workspace: grant.workspace,
        scopes: [{ environment: grant.environment, secretPath: grant.secretPath }],
        permissions: grant.permissions,
        expiresAt: null,
      }), { status: 200 });
    }
    if (init?.method === "PATCH" || init?.method === "POST") {
      const name = target.split("/").pop() ?? "";
      const body = secretWriteBody.parse(JSON.parse(String(init.body ?? "{}")));
      vault.set(name, body.secretValue ?? "");
      return new Response("{}", { status: 200 });
    }
    if (target.includes("/api/v3/secrets/raw")) {
      const secrets = [...vault.entries()].map(([secretKey, secretValue]) => ({ secretKey, secretValue }));
      return new Response(JSON.stringify({ secrets }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  return { calls, vault, impl };
}

/** The operator's selection, saved the way the native Settings form saves it
 * and read back the way the status route reads it. */
function saveSelection(selection: OperatorSelection): AppConfig {
  saveConfig(parseConfigPatch({ infisical: selection }));
  return loadConfig();
}

const ENV_KEYS = [
  "INFISICAL_CLIENT_ID",
  "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID",
  "INFISICAL_CLIENT_SECRET",
  "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
  "INFISICAL_TOKEN",
  "INFISICAL_WRITE_TOKEN",
  "INFISICAL_PROJECT_ID",
  "INFISICAL_SITE_URL",
  "INFISICAL_DOMAIN",
  "INFISICAL_ENVIRONMENT",
  "INFISICAL_SECRET_PATH",
  "INFISICAL_READ_SOURCES",
  WRITE_ONLY_ENV,
  READ_ONLY_ENV,
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  grants = new Map<string, TokenGrant>();
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env[WRITE_ONLY_ENV] = FAKE_WRITE_ONLY_TOKEN;
  process.env[READ_ONLY_ENV] = FAKE_READ_ONLY_TOKEN;
  rmSync(join(dataDir(), "config.json"), { force: true });
  setInfisicalSnapshot(null, []);
});

afterEach(() => {
  vi.unstubAllGlobals();
  infisical.configure(null);
  infisical.stop();
  setInfisicalSnapshot(null, []);
  rmSync(join(dataDir(), "config.json"), { force: true });
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

describe("the optional secret store fixture", () => {
  it("reads the primary project, environment and folder the operator selected", async () => {
    const readTokenFile = fakeTokenFile(FAKE_READ_TOKEN);
    const writeTokenFile = fakeTokenFile(FAKE_WRITE_TOKEN);
    grants.set(FAKE_READ_TOKEN, {
      workspace: PRIMARY_PROJECT, environment: "prod", secretPath: PRIMARY_FOLDER, permissions: ["read"],
    });
    const { calls, impl } = recordingFetch();
    vi.stubGlobal("fetch", impl);

    const cfg = saveSelection({
      enabled: true,
      writeThrough: false,
      authMethod: "service-token",
      siteUrl: "https://vault.fixture.test",
      projectId: PRIMARY_PROJECT,
      environment: "prod",
      secretPath: PRIMARY_FOLDER,
      readSources: [{
        name: "primary-app",
        projectId: PRIMARY_PROJECT,
        environment: "prod",
        secretPath: PRIMARY_FOLDER,
        tokenFile: readTokenFile,
        writeTokenFile,
      }],
    });

    // The saved selection is the primary vault, and it is configured.
    expect(infisicalConfigured(cfg)).toBe(true);
    const settings = infisicalSettings(cfg);
    infisical.configure(() => settings);

    const status = await infisical.refresh("manual");
    expect(status.configured).toBe(true);
    expect(status.lastError).toBeNull();

    // The read went to the selected project, environment and folder, with the
    // selected read credential and nothing else.
    const list = calls.find((call) => call.url.includes("/api/v3/secrets/raw"));
    expect(list?.url).toContain(`workspaceId=${PRIMARY_PROJECT}`);
    expect(list?.url).toContain("environment=prod");
    expect(list?.url).toContain("secretPath=%2Fapp");
    expect(list?.authorization).toContain(FAKE_READ_TOKEN);
    expect(list?.authorization).not.toContain(FAKE_WRITE_TOKEN);

    // The readback reports the selection and the per-source separation.
    expect(status.projectId).toBe(PRIMARY_PROJECT);
    expect(status.environment).toBe("prod");
    expect(status.secretPath).toBe(PRIMARY_FOLDER);
    expect(status.readSources.map((source) => [source.name, source.hasReadToken, source.hasWriteToken]))
      .toEqual([["primary-app", true, true]]);
  });

  it("does not let a source at another folder configure the primary vault", async () => {
    const otherTokenFile = fakeTokenFile(FAKE_READ_TOKEN);
    grants.set(FAKE_READ_TOKEN, {
      workspace: PRIMARY_PROJECT, environment: "prod", secretPath: "/other-folder", permissions: ["read"],
    });
    const { calls, impl } = recordingFetch();
    vi.stubGlobal("fetch", impl);

    const cfg = saveSelection({
      enabled: true,
      writeThrough: false,
      authMethod: "service-token",
      siteUrl: "https://vault.fixture.test",
      projectId: PRIMARY_PROJECT,
      environment: "prod",
      secretPath: PRIMARY_FOLDER,
      readSources: [{
        name: "other-folder",
        projectId: PRIMARY_PROJECT,
        environment: "prod",
        secretPath: "/other-folder",
        tokenFile: otherTokenFile,
      }],
    });

    // The primary folder has no source of its own, so the primary vault is
    // not configured, and the other folder's credential cannot stand in for it.
    expect(infisicalConfigured(cfg)).toBe(false);
    const settings = infisicalSettings(cfg);
    infisical.configure(() => settings);

    const status = await infisical.refresh("manual");
    expect(status.configured).toBe(false);
    expect(calls).toHaveLength(0);

    // The primary folder has no source, so the read is refused outright and
    // the other folder's credential is never presented for it.
    await expect(infisical.readPath(PRIMARY_FOLDER)).rejects.toThrow(/not configured/);
    expect(calls).toHaveLength(0);
    expect(calls.some((call) => call.authorization.includes(FAKE_READ_TOKEN))).toBe(false);
  });

  it("keeps a read reference and a write reference independent of one another", async () => {
    const readTokenFile = fakeTokenFile(FAKE_READ_TOKEN);
    const writeTokenFile = fakeTokenFile(FAKE_WRITE_TOKEN);
    grants.set(FAKE_READ_TOKEN, {
      workspace: PRIMARY_PROJECT, environment: "prod", secretPath: PRIMARY_FOLDER, permissions: ["read"],
    });
    grants.set(FAKE_WRITE_TOKEN, {
      workspace: PRIMARY_PROJECT, environment: "prod", secretPath: PRIMARY_FOLDER, permissions: ["write"],
    });
    grants.set(FAKE_WRITE_ONLY_TOKEN, {
      workspace: "write-project", environment: "prod", secretPath: "/write-only", permissions: ["write"],
    });
    grants.set(FAKE_READ_ONLY_TOKEN, {
      workspace: "read-project", environment: "prod", secretPath: "/read-only", permissions: ["read"],
    });
    const { calls, impl } = recordingFetch();
    vi.stubGlobal("fetch", impl);

    const cfg = saveSelection({
      enabled: true,
      writeThrough: true,
      authMethod: "service-token",
      siteUrl: "https://vault.fixture.test",
      projectId: PRIMARY_PROJECT,
      environment: "prod",
      secretPath: PRIMARY_FOLDER,
      readSources: [
        {
          name: "primary-app",
          projectId: PRIMARY_PROJECT,
          environment: "prod",
          secretPath: PRIMARY_FOLDER,
          tokenFile: readTokenFile,
          writeTokenFile,
        },
        {
          name: "write-only",
          projectId: "write-project",
          environment: "prod",
          secretPath: "/write-only",
          writeTokenEnv: WRITE_ONLY_ENV,
        },
        {
          name: "read-only",
          projectId: "read-project",
          environment: "prod",
          secretPath: "/read-only",
          tokenEnv: READ_ONLY_ENV,
        },
      ],
    });
    const settings = infisicalSettings(cfg);
    infisical.configure(() => settings);

    // A write-only source never becomes a read source: the read is refused and
    // the write credential is never presented.
    await expect(infisical.readSource("write-only")).rejects.toThrow(/write-only/);
    expect(calls.some((call) => call.authorization.includes(FAKE_WRITE_ONLY_TOKEN))).toBe(false);

    // A source with no write reference stays read-only: the write is refused
    // and the read credential is never presented.
    await expect(infisical.writeSource("read-only", "COMPOSIO_API_KEY", "fake-written-value-not-a-credential"))
      .rejects.toThrow(/read-only/);
    expect(calls.some((call) => call.authorization.includes(FAKE_READ_ONLY_TOKEN))).toBe(false);

    // The write reference is carried separately from the read one: the write
    // goes out with the write credential and never with the read credential.
    await infisical.writeSource("primary-app", "COMPOSIO_API_KEY", "fake-written-value-not-a-credential");
    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.authorization).toContain(FAKE_WRITE_TOKEN);
    expect(patch?.authorization).not.toContain(FAKE_READ_TOKEN);

    // The readback reports each source's read and write references apart.
    const status = infisical.getStatus();
    expect(status.readSources.map((source) => [source.name, source.hasReadToken, source.hasWriteToken]))
      .toEqual([["primary-app", true, true], ["write-only", false, true], ["read-only", true, false]]);
  });

  it("refuses a second read reference for one project before anything is saved", async () => {
    const firstTokenFile = fakeTokenFile(FAKE_READ_TOKEN);
    const secondTokenFile = fakeTokenFile(FAKE_READ_ONLY_TOKEN);
    const cfg = saveSelection({
      enabled: true,
      writeThrough: false,
      authMethod: "service-token",
      siteUrl: "https://vault.fixture.test",
      projectId: PRIMARY_PROJECT,
      environment: "prod",
      secretPath: PRIMARY_FOLDER,
      readSources: [{
        name: "primary-app",
        projectId: PRIMARY_PROJECT,
        environment: "prod",
        secretPath: PRIMARY_FOLDER,
        tokenFile: firstTokenFile,
      }],
    });

    expect(() => validateInfisicalConfigPatch(cfg, {
      infisical: {
        readSources: [
          {
            name: "primary-app",
            projectId: PRIMARY_PROJECT,
            environment: "prod",
            secretPath: PRIMARY_FOLDER,
            tokenFile: firstTokenFile,
          },
          {
            name: "primary-other",
            projectId: PRIMARY_PROJECT,
            environment: "prod",
            secretPath: "/other-folder",
            tokenFile: secondTokenFile,
          },
        ],
      },
    })).toThrow(/one read token reference/);
  });

  it("keeps the optional connection and the local-only resolution apart", async () => {
    const { calls, impl } = recordingFetch();
    vi.stubGlobal("fetch", impl);

    // The connection is off: the read reference is never opened, no request
    // is made, and nothing from the vault reaches the app config.
    const cfg = saveSelection({
      enabled: false,
      writeThrough: false,
      authMethod: "service-token",
      siteUrl: "https://vault.fixture.test",
      projectId: PRIMARY_PROJECT,
      environment: "prod",
      secretPath: PRIMARY_FOLDER,
      readSources: [{
        name: "primary-app",
        projectId: PRIMARY_PROJECT,
        environment: "prod",
        secretPath: PRIMARY_FOLDER,
        tokenFile: missingTokenFile(),
      }],
    });
    const settings = infisicalSettings(cfg);
    infisical.configure(() => settings);

    const status = await infisical.refresh("manual");
    expect(status.enabledSetting).toBe(false);
    expect(status.enabled).toBe(false);
    expect(calls).toHaveLength(0);
    await expect(infisical.readSource("primary-app")).rejects.toThrow(/turned off/);
    expect(calls).toHaveLength(0);

    // The local-only resolution stays in force: this computer's own copy of a
    // mapped credential is what resolves, and no vault value leaks in.
    const local = loadConfig();
    local.composio = { apiKey: FAKE_LOCAL_VAL };
    const rows = resolveSecretFields(local, {}, null);
    expect(rows.find((row) => row.id === "composio.apiKey")?.source).toBe("file");
    expect(local.composio?.apiKey).toBe(FAKE_LOCAL_VAL);

    // Turning the optional connection on never activates the other
    // authentication mode: the service token is the selected method, so with
    // no service token there is no login attempt at all, even though a
    // machine identity is saved alongside it.
    const before = calls.length;
    saveConfig(parseConfigPatch({
      infisical: {
        enabled: true,
        authMethod: "service-token",
        clientId: "fixture-client",
        clientSecret: FAKE_MACHINE_SECRET,
        readSources: [],
      },
    }));
    const selected = infisicalSettings(loadConfig());
    infisical.configure(() => selected);
    const selectedStatus = await infisical.refresh("manual");
    expect(selectedStatus.enabledSetting).toBe(true);
    expect(selectedStatus.configured).toBe(false);
    expect(selectedStatus.hasClientId).toBe(true);
    expect(calls.length).toBe(before);
    expect(calls.some((call) => call.url.includes("/login"))).toBe(false);
  });
});
