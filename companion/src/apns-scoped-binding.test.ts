import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APNS_VAULT_CACHE_MS,
  APNS_VAULT_RETRY_MS,
  apnsKeySource,
  apnsKeyStamp,
  apnsVaultName,
  loadApnsConfig,
  resetApnsKeyCache,
  SHARED_APNS_KEY_ID,
  SHARED_APNS_KEY_ID_NAME,
  SHARED_APNS_P8_NAME,
} from "./apns.ts";
import type { JsonValue } from "./json.ts";
import {
  APNS_SCOPED_KEY_ID_NAME,
  APNS_SCOPED_P8_NAME,
  ApnsScopedBindingError,
  apnsScopedSecretNames,
  loadScopedApnsMaterial,
  readDeclaredApnsSecrets,
  redactApnsBindingText,
  verifyApnsScopedBinding,
  type ApnsScopedBinding,
  type ApnsScopedFetch,
  type ApnsScopedRequest,
  type ApnsScopedTiming,
} from "./apns-scoped-binding.ts";

const PROJECT = "fixture-project";
const TOKEN = "fixture-apns-token";
const P8 = "-----BEGIN PRIVATE KEY-----\nfixture-apns-pem\n-----END PRIVATE KEY-----\n";

function metadata(patch: {
  workspace?: string;
  projectId?: string;
  scopes?: JsonValue;
  permissions?: string[];
  expiresAt?: string | null;
} = {}): JsonValue {
  return {
    workspace: patch.workspace ?? PROJECT,
    projectId: patch.projectId ?? PROJECT,
    scopes: patch.scopes ?? [{ environment: "prod", secretPath: "/apns" }],
    permissions: patch.permissions ?? ["read"],
    expiresAt: patch.expiresAt === undefined ? null : patch.expiresAt,
  };
}

function secretRow(name: string, value: string, patch: {
  workspace?: string;
  environment?: string;
  secretPath?: string;
  secretValueHidden?: boolean;
  type?: string;
} = {}) {
  return {
    workspace: patch.workspace ?? PROJECT,
    environment: patch.environment ?? "prod",
    secretPath: patch.secretPath ?? "/apns",
    secretKey: name,
    secretValue: value,
    secretValueHidden: patch.secretValueHidden ?? false,
    type: patch.type ?? "shared",
  };
}

function jsonResponse(body: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function binding(fetchImpl: ApnsScopedFetch, patch: Partial<ApnsScopedBinding> = {}): ApnsScopedBinding {
  return {
    projectId: PROJECT,
    environment: "prod",
    folder: "/apns",
    siteUrl: "https://fixture.invalid",
    token: TOKEN,
    fetchImpl,
    ...patch,
  };
}

function timing(patch: Partial<ApnsScopedTiming> = {}): ApnsScopedTiming {
  return {
    pin: "",
    timeoutMs: 5_000,
    retryMs: 30_000,
    cacheMs: APNS_VAULT_CACHE_MS,
    keyIdFallback: SHARED_APNS_KEY_ID,
    ...patch,
  };
}

interface SharedFetchScript {
  fetchImpl: ApnsScopedFetch;
  urls: () => string[];
  inits: () => ApnsScopedRequest[];
}

function sharedFetch(secret?: (name: string) => JsonValue, metadataBody?: () => JsonValue): SharedFetchScript {
  const readSecret = secret ?? ((name: string): JsonValue => {
    if (name === "APNS_KEY_P8") return { secret: secretRow(name, P8) };
    if (name === "APNS_KEY_ID") return { secret: secretRow(name, "ROTATED001") };
    throw new Error(`unexpected secret ${name}`);
  });
  const readMetadata = metadataBody ?? (() => metadata());
  const urls: string[] = [];
  const inits: ApnsScopedRequest[] = [];
  const fetchImpl: ApnsScopedFetch = async (url, init) => {
    urls.push(url);
    inits.push(init);
    const parsed = new URL(url);
    if (parsed.pathname === "/api/v2/service-token") return jsonResponse(readMetadata());
    const name = decodeURIComponent(parsed.pathname.slice(parsed.pathname.lastIndexOf("/") + 1));
    return jsonResponse(readSecret(name));
  };
  return { fetchImpl, urls: () => urls, inits: () => inits };
}

describe("scoped APNs binding", () => {
  const saved = { ...process.env };
  let dir = "";

  beforeEach(() => {
    process.env = { ...saved };
    delete process.env.APNS_P8;
    delete process.env.APNS_P8_PATH;
    delete process.env.APNS_KEY_ID;
    delete process.env.APNS_VAULT_READ_TIMEOUT_MS;
    delete process.env.APNS_VAULT_RETRY_MS;
    process.env.FLEET_SECRETS_BIN = "/nonexistent/fleet-bin";
    dir = mkdtempSync(join(tmpdir(), "apns-scoped-"));
    resetApnsKeyCache();
  });

  afterEach(() => {
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
    resetApnsKeyCache();
    vi.useRealTimers();
  });

  it("requests only the declared names, and only after an exact read-only scope matches", async () => {
    expect(APNS_SCOPED_P8_NAME).toBe(SHARED_APNS_P8_NAME);
    expect(APNS_SCOPED_KEY_ID_NAME).toBe(SHARED_APNS_KEY_ID_NAME);
    expect(apnsScopedSecretNames("")).toEqual([SHARED_APNS_P8_NAME, SHARED_APNS_KEY_ID_NAME]);
    expect(apnsScopedSecretNames("KEY1234567")).toEqual([apnsVaultName("KEY1234567")]);
    const script = sharedFetch();
    const config = await loadApnsConfig(binding(script.fetchImpl));
    expect(config?.keyId).toBe("ROTATED001");
    expect(config?.p8).toBe(P8);
    expect(apnsKeySource(binding(script.fetchImpl))).toBe("Infisical scoped APNS_KEY_P8");
    const urls = script.urls().map((url) => new URL(url));
    expect(urls.map((url) => url.pathname)).toEqual([
      "/api/v2/service-token",
      "/api/v3/secrets/raw/APNS_KEY_P8",
      "/api/v3/secrets/raw/APNS_KEY_ID",
    ]);
    expect(urls[0]?.search).toBe("");
    for (const url of urls.slice(1)) {
      expect(url.searchParams.get("workspaceId")).toBe(PROJECT);
      expect(url.searchParams.get("environment")).toBe("prod");
      expect(url.searchParams.get("secretPath")).toBe("/apns");
      expect(url.searchParams.get("viewSecretValue")).toBe("true");
      expect(url.searchParams.get("expandSecretReferences")).toBe("false");
      expect(url.searchParams.get("include_imports")).toBe("false");
      expect(url.searchParams.get("recursive")).toBe("false");
      expect(url.toString()).not.toContain(TOKEN);
    }
    for (const init of script.inits()) {
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("error");
      expect(init.cache).toBe("no-store");
      expect(init.credentials).toBe("omit");
      expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    }
    expect(script.urls().some((url) => url.includes("universal-auth"))).toBe(false);
  });

  it("normalizes the folder and accepts a stringified scope", async () => {
    const script = sharedFetch(undefined, () => metadata({
      scopes: JSON.stringify([{ environment: "prod", secretPath: "/apns/" }]),
    }));
    const config = await loadApnsConfig(binding(script.fetchImpl, { folder: "/apns/" }));
    expect(config?.keyId).toBe("ROTATED001");
    expect(new URL(script.urls()[1] ?? "").searchParams.get("secretPath")).toBe("/apns");
  });

  it("selects AUTHKEY_<KEY_ID> when a key id is pinned and does not read the shared names", async () => {
    process.env.APNS_KEY_ID = "KEY1234567";
    const script = sharedFetch((name) => {
      if (name !== "AUTHKEY_KEY1234567") throw new Error(`unexpected secret ${name}`);
      return { secret: secretRow(name, P8) };
    });
    const config = await loadApnsConfig(binding(script.fetchImpl));
    expect(config?.keyId).toBe("KEY1234567");
    expect(script.urls().map((url) => new URL(url).pathname)).toEqual([
      "/api/v2/service-token",
      "/api/v3/secrets/raw/AUTHKEY_KEY1234567",
    ]);
    expect(apnsKeySource(binding(script.fetchImpl))).toBe("Infisical scoped AUTHKEY_KEY1234567");
  });

  it("refuses a token whose project, environment, or folder is not exact, before any secret read", async () => {
    const cases = [
      metadata({ workspace: "fixture-other-project" }),
      metadata({ projectId: "fixture-other-project" }),
      metadata({ scopes: [{ environment: "dev", secretPath: "/apns" }] }),
      metadata({ scopes: [{ environment: "prod", secretPath: "/apns" }, { environment: "dev", secretPath: "/" }] }),
      metadata({ scopes: [{ environment: "prod", secretPath: "/apns/child" }] }),
      metadata({ scopes: [{ environment: "prod", secretPath: "/" }] }),
    ];
    for (const body of cases) {
      let secrets = 0;
      const fetchImpl: ApnsScopedFetch = async (url) => {
        if (new URL(url).pathname.includes("/secrets/")) secrets += 1;
        return jsonResponse(body);
      };
      await expect(readDeclaredApnsSecrets(binding(fetchImpl), "", 5_000)).rejects.toThrow(ApnsScopedBindingError);
      expect(secrets).toBe(0);
    }
  });

  it("refuses a credential that is not read-only before any secret read", async () => {
    for (const permissions of [["write"], ["read", "write"]]) {
      let secrets = 0;
      const fetchImpl: ApnsScopedFetch = async (url) => {
        if (new URL(url).pathname.includes("/secrets/")) secrets += 1;
        return jsonResponse(metadata({ permissions }));
      };
      await expect(verifyApnsScopedBinding(binding(fetchImpl), 5_000)).rejects.toThrow(/read-only/);
      expect(secrets).toBe(0);
    }
  });

  it("refuses an expired token and a malformed scope before any secret read", async () => {
    const bodies = [
      metadata({ expiresAt: "2000-01-01T00:00:00Z" }),
      metadata({ scopes: [{ environment: "prod", secretPath: "/apns/*" }] }),
    ];
    for (const body of bodies) {
      let secrets = 0;
      const fetchImpl: ApnsScopedFetch = async (url) => {
        if (new URL(url).pathname.includes("/secrets/")) secrets += 1;
        return jsonResponse(body);
      };
      await expect(verifyApnsScopedBinding(binding(fetchImpl), 5_000)).rejects.toThrow(ApnsScopedBindingError);
      expect(secrets).toBe(0);
    }
  });

  it("does not call the network for a folder, site, token, or key id outside the contract", async () => {
    const bad = [
      binding(async () => jsonResponse({}), { siteUrl: "http://fixture.invalid" }),
      binding(async () => jsonResponse({}), { siteUrl: "https://user:secret@fixture.invalid/path" }),
      binding(async () => jsonResponse({}), { folder: "/apns/../other" }),
      binding(async () => jsonResponse({}), { folder: "/apns/*" }),
      binding(async () => jsonResponse({}), { token: "short" }),
      binding(async () => jsonResponse({}), { projectId: "" }),
    ];
    for (const candidate of bad) {
      let calls = 0;
      candidate.fetchImpl = async () => {
        calls += 1;
        return jsonResponse({});
      };
      await expect(readDeclaredApnsSecrets(candidate, "", 5_000)).rejects.toThrow(ApnsScopedBindingError);
      expect(calls).toBe(0);
    }
    let calls = 0;
    const fetchImpl: ApnsScopedFetch = async () => {
      calls += 1;
      return jsonResponse(metadata());
    };
    await expect(readDeclaredApnsSecrets(binding(fetchImpl), "../SECRET", 5_000)).rejects.toThrow(/declared name/);
    expect(calls).toBe(0);
  });

  it("rejects references, imports, and descendants, and keeps those values out of the error", async () => {
    const reference = sharedFetch((name) => ({ secret: secretRow(name, name === "APNS_KEY_P8" ? "${APNS_OTHER}" : "ROTATED001") }));
    await expect(readDeclaredApnsSecrets(binding(reference.fetchImpl), "", 5_000)).rejects.toThrow(/reference, import, or descendant/);
    try {
      await readDeclaredApnsSecrets(binding(reference.fetchImpl), "", 5_000);
    } catch (err) {
      expect(String(err)).not.toContain("APNS_OTHER");
      expect(String(err)).not.toContain(TOKEN);
    }

    const imported = sharedFetch(() => ({
      secret: secretRow("APNS_KEY_P8", P8),
      imports: [{ secretPath: "/other", secrets: [{ secretKey: "APNS_KEY_P8", secretValue: P8 }] }],
    }));
    await expect(readDeclaredApnsSecrets(binding(imported.fetchImpl), "", 5_000)).rejects.toThrow(/reference, import, or descendant/);

    const descendant = sharedFetch(() => ({ secret: secretRow("APNS_KEY_P8", P8, { secretPath: "/apns/child" }) }));
    await expect(readDeclaredApnsSecrets(binding(descendant.fetchImpl), "", 5_000)).rejects.toThrow(/reference, import, or descendant/);
    try {
      await readDeclaredApnsSecrets(binding(descendant.fetchImpl), "", 5_000);
    } catch (err) {
      expect(String(err)).not.toContain("fixture-apns-pem");
    }
  });

  it("treats a referenced key id as missing and does not adopt it", async () => {
    const script = sharedFetch((name) => ({
      secret: secretRow(name, name === "APNS_KEY_ID" ? "${APNS_KEY_ID}" : P8),
    }));
    const read = await readDeclaredApnsSecrets(binding(script.fetchImpl), "", 5_000);
    expect(read.p8).toBe(P8);
    expect(read.keyId).toBeNull();
    expect(JSON.stringify(read)).not.toContain("${APNS_KEY_ID}");
  });

  it("redacts fixture secrets from binding errors", async () => {
    const leaked = `bearer fixture-apns-token pem ${P8} ref \${APNS_OTHER}`;
    const redacted = redactApnsBindingText(leaked, [TOKEN, P8]);
    expect(redacted).not.toContain(TOKEN);
    expect(redacted).not.toContain("fixture-apns-pem");
    expect(redacted).not.toContain("APNS_OTHER");
    expect(redacted).toContain("«redacted»");

    const fetchImpl: ApnsScopedFetch = async () => {
      throw new Error("transport said fixture-apns-token");
    };
    await expect(verifyApnsScopedBinding(binding(fetchImpl), 5_000)).rejects.toThrow(/APNs binding read failed/);
    try {
      await verifyApnsScopedBinding(binding(fetchImpl), 5_000);
    } catch (err) {
      expect(err).toBeInstanceOf(ApnsScopedBindingError);
      expect(String(err)).not.toContain(TOKEN);
    }

    const bodyLeak: ApnsScopedFetch = async () => new Response(P8, { status: 500 });
    try {
      await verifyApnsScopedBinding(binding(bodyLeak), 5_000);
    } catch (err) {
      expect(String(err)).not.toContain("fixture-apns-pem");
      expect(String(err)).not.toContain("BEGIN PRIVATE KEY");
    }
  });

  it("prefers APNS_P8 and then APNS_P8_PATH, and does not call the binding", async () => {
    let calls = 0;
    const bound = binding(async () => {
      calls += 1;
      throw new Error("network");
    });
    process.env.APNS_P8 = P8;
    // resolveP8 trims the environment value. The file path below keeps the bytes on disk.
    expect((await loadApnsConfig(bound))?.p8).toBe(P8.trim());
    expect(apnsKeySource(bound)).toBe("APNS_P8 environment");
    delete process.env.APNS_P8;
    const file = join(dir, "AuthKey.p8");
    writeFileSync(file, P8, { mode: 0o600 });
    process.env.APNS_P8_PATH = file;
    expect((await loadApnsConfig(bound))?.p8).toBe(P8);
    expect(apnsKeySource(bound)).toBe(file);
    process.env.APNS_P8_PATH = join(dir, "missing.p8");
    expect(await loadApnsConfig(bound)).toBeNull();
    expect(calls).toBe(0);
  });

  it("fails closed on a bad binding and does not fall through to fleet-secrets", async () => {
    const marker = join(dir, "called");
    const bin = join(dir, "fleet-secrets");
    writeFileSync(bin, `#!/bin/sh\necho called > '${marker}'\nexit 3\n`);
    chmodSync(bin, 0o755);
    process.env.FLEET_SECRETS_BIN = bin;
    let secrets = 0;
    const fetchImpl: ApnsScopedFetch = async (url) => {
      if (new URL(url).pathname.includes("/secrets/")) secrets += 1;
      return jsonResponse(metadata({ permissions: ["read", "write"] }));
    };
    expect(await loadApnsConfig(binding(fetchImpl))).toBeNull();
    expect(await apnsKeyStamp(binding(fetchImpl))).toBeNull();
    expect(secrets).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("does not call fetch when the scoped binding is omitted", async () => {
    const marker = join(dir, "called");
    const bin = join(dir, "fleet-secrets");
    writeFileSync(bin, `#!/bin/sh\necho called > '${marker}'\ncat <<'PEM'\n${P8}PEM\n`);
    chmodSync(bin, 0o755);
    process.env.FLEET_SECRETS_BIN = bin;
    const original = globalThis.fetch;
    let network = 0;
    const replacement: typeof fetch = async () => {
      network += 1;
      throw new Error("network");
    };
    globalThis.fetch = replacement;
    try {
      const config = await loadApnsConfig();
      expect(config?.p8).toContain("BEGIN PRIVATE KEY");
      expect(apnsKeySource()).toBe("Infisical APNS_KEY_P8");
      expect(network).toBe(0);
      expect(readFileSync(marker, "utf8")).toContain("called");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("caches a scoped read, expires it, and shares one in-flight read", async () => {
    const script = sharedFetch();
    const bound = binding(script.fetchImpl);
    expect((await loadApnsConfig(bound))?.keyId).toBe("ROTATED001");
    expect((await loadApnsConfig(bound))?.p8).toBe(P8);
    expect(script.urls()).toHaveLength(3);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + APNS_VAULT_CACHE_MS + 1);
    expect((await loadApnsConfig(bound))?.p8).toBe(P8);
    expect(script.urls()).toHaveLength(6);
    vi.useRealTimers();

    let slow = 0;
    const concurrent: ApnsScopedFetch = async (url) => {
      slow += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return script.fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${TOKEN}` },
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        signal: AbortSignal.timeout(5_000),
      });
    };
    resetApnsKeyCache();
    const again = binding(concurrent);
    await Promise.all([loadApnsConfig(again), loadApnsConfig(again)]);
    expect(slow).toBe(3);
  });

  it("keeps the last good key through a failed reread and does not retry inside the failure window", async () => {
    let fail = false;
    let calls = 0;
    const fetchImpl: ApnsScopedFetch = async (url, init) => {
      calls += 1;
      if (fail) return jsonResponse({ error: TOKEN }, 500);
      return sharedFetch().fetchImpl(url, init);
    };
    const bound = binding(fetchImpl);
    const good = await loadApnsConfig(bound);
    expect(good?.p8).toBe(P8);
    const before = calls;
    fail = true;
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + APNS_VAULT_CACHE_MS + 1);
    expect((await loadApnsConfig(bound))?.p8).toBe(P8);
    const afterFailure = calls;
    expect(afterFailure).toBeGreaterThan(before);
    vi.setSystemTime(Date.now() + 1);
    expect((await loadApnsConfig(bound))?.p8).toBe(P8);
    expect(calls).toBe(afterFailure);
    vi.setSystemTime(Date.now() + APNS_VAULT_RETRY_MS + 1);
    expect((await loadApnsConfig(bound))?.p8).toBe(P8);
    expect(calls).toBeGreaterThan(afterFailure);
  });

  it("stamps a slow id miss when the read finishes, so the next caller uses the cache", async () => {
    let clock = 10_000_000;
    let calls = 0;
    const fetchImpl: ApnsScopedFetch = async (url) => {
      calls += 1;
      const parsed = new URL(url);
      if (parsed.pathname === "/api/v2/service-token") return jsonResponse(metadata());
      const name = decodeURIComponent(parsed.pathname.slice(parsed.pathname.lastIndexOf("/") + 1));
      if (name === "APNS_KEY_ID") clock += 500;
      if (name === "APNS_KEY_ID") return jsonResponse({ error: "missing" }, 404);
      return jsonResponse({ secret: secretRow(name, P8) });
    };
    const read = await loadScopedApnsMaterial(binding(fetchImpl), timing({
      retryMs: 100,
      cacheMs: 10_000,
      now: () => clock,
    }));
    expect(read.p8).toBe(P8);
    expect(read.keyId).toBe(SHARED_APNS_KEY_ID);
    const after = calls;
    await loadScopedApnsMaterial(binding(fetchImpl), timing({ retryMs: 100, cacheMs: 10_000, now: () => clock }));
    expect(calls).toBe(after);
  });

  it("honours the companion read ceiling and ignores a nonsense override", async () => {
    let calls = 0;
    const fetchImpl: ApnsScopedFetch = async (_url, init) => {
      calls += 1;
      await new Promise((_resolve, reject) => {
        const fail = () => reject(new Error("aborted fixture-apns-token"));
        if (init.signal.aborted) {
          fail();
          return;
        }
        init.signal.addEventListener("abort", fail, { once: true });
      });
      return jsonResponse(metadata());
    };
    process.env.APNS_VAULT_READ_TIMEOUT_MS = "1";
    expect(await loadApnsConfig(binding(fetchImpl))).toBeNull();
    expect(calls).toBe(1);
    let leaked = "";
    try {
      await verifyApnsScopedBinding(binding(fetchImpl), 1);
    } catch (err) {
      leaked = String(err);
    }
    expect(leaked).not.toContain(TOKEN);

    process.env.APNS_VAULT_READ_TIMEOUT_MS = "-1";
    resetApnsKeyCache();
    const script = sharedFetch();
    expect((await loadApnsConfig(binding(script.fetchImpl)))?.p8).toBe(P8);
  });

  it("does not reuse a cached key for a different folder or token", async () => {
    const first = sharedFetch();
    expect((await loadApnsConfig(binding(first.fetchImpl)))?.p8).toBe(P8);
    const otherPem = "-----BEGIN PRIVATE KEY-----\nfixture-apns-other\n-----END PRIVATE KEY-----\n";
    const second = sharedFetch((name) => ({
      secret: secretRow(name, name === "APNS_KEY_P8" ? otherPem : "ROTATED001", { secretPath: "/other" }),
    }), () => metadata({ scopes: [{ environment: "prod", secretPath: "/other" }] }));
    const config = await loadApnsConfig(binding(second.fetchImpl, { folder: "/other" }));
    expect(config?.p8).toBe(otherPem);
    expect(second.urls().some((url) => url.includes("/api/v3/secrets/raw/"))).toBe(true);

    resetApnsKeyCache();
    const swapped = sharedFetch((name) => {
      const token = name;
      return { secret: secretRow(token, P8) };
    });
    let which = "fixture-apns-token";
    const fetchImpl: ApnsScopedFetch = async (url, init) => {
      which = init.headers.authorization.endsWith("fixture-apns-token-b") ? "b" : "a";
      if (new URL(url).pathname.includes("APNS_KEY_P8")) {
        const value = which === "b"
          ? "-----BEGIN PRIVATE KEY-----\nfixture-apns-b\n-----END PRIVATE KEY-----\n"
          : P8;
        return jsonResponse({ secret: secretRow("APNS_KEY_P8", value) });
      }
      return swapped.fetchImpl(url, init);
    };
    expect((await loadApnsConfig(binding(fetchImpl)))?.p8).toBe(P8);
    const next = await loadApnsConfig(binding(fetchImpl, { token: "fixture-apns-token-b" }));
    expect(next?.p8).toContain("fixture-apns-b");
  });
});
