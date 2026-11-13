import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { infisicalSettings, type InfisicalSettings } from "./config.ts";
import { dataDir } from "./data-dir.ts";
import { infisical } from "./infisical.ts";
import type { InfisicalError } from "./infisical-client.ts";
import { fleetOpsProjectId } from "./infisical.ts";
import { infisicalSnapshot, setInfisicalSnapshot, vaultNames } from "./secret-map.ts";


// Obviously fake, and never sent anywhere real: these exist so the
// assertions below have credential-shaped strings to look for. Every test
// that could plausibly leak one asserts it is absent from what came back.
const SENTINEL_CLIENT_SECRET = "sentinel-client-secret-not-real";
const SENTINEL_READ_TOKEN = "sentinel-service-read-token-not-real";
const SENTINEL_WRITE_TOKEN = "sentinel-service-write-token-not-real";
const SENTINEL_TOKEN = "sentinel-bearer-token-not-real";
const SENTINEL_VAULT_VALUE = "sentinel-vault-value-not-real";

const BASE_SETTINGS: InfisicalSettings = {
  authMethod: "machine-identity",
  enabled: true,
  writeThrough: false,
  siteUrl: "https://app.infisical.example",
  projectId: "proj-1",
  environment: "prod",
  secretPath: "/",
  clientId: "client-1",
  clientSecret: SENTINEL_CLIENT_SECRET,
  token: "",
  writeToken: "",
  readSources: [],
  refreshMinutes: 15,
};

/** The request headers as a plain string map, so a test can read the
 * authorization header off a stubbed fetch. */
function headerBag(init?: RequestInit): Record<string, string> {
  // SAFETY: every stubbed fetch in this file is called with a plain object of
  // string headers -- never a Headers instance and never an array of pairs --
  // so reading a header off this map cannot be wrong.
  return (init?.headers ?? {}) as Record<string, string>;
}

let fixtureSettings = BASE_SETTINGS;
const fixtureTokenFiles = new Map<string, string>();
const metadataRequests: string[] = [];

// Existing success fixtures supply explicit token metadata separately from their
// secrets response; security rejection fixtures below stub the whole wire.
function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): void {
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (!String(url).endsWith("/api/v2/service-token")) return handler(url, init);
    metadataRequests.push(String(url));
    const token = (headerBag(init).authorization ?? "").replace(/^Bearer /, "");
    const scopes: Array<{ projectId: string; environment: string; secretPath: string }> = [];
    let write = token === fixtureSettings.writeToken && Boolean(token);
    if (token === fixtureSettings.token || token === fixtureSettings.writeToken) scopes.push(fixtureSettings);
    for (const source of fixtureSettings.readSources) {
      const readToken = source.tokenFile ? fixtureTokenFiles.get(source.tokenFile) : process.env[source.tokenEnv];
      const writeToken = source.writeTokenFile ? fixtureTokenFiles.get(source.writeTokenFile) : process.env[source.writeTokenEnv ?? ""];
      if (token === readToken || token === writeToken) scopes.push(source);
      if (token === writeToken) write = true;
    }
    return new Response(JSON.stringify({ workspace: scopes[0]?.projectId ?? fixtureSettings.projectId,
      scopes: scopes.map(({ environment, secretPath }) => ({ environment, secretPath })),
      permissions: write ? ["write"] : ["read"], expiresAt: null }));
  });
}

function withSettings(overrides: Partial<InfisicalSettings>): InfisicalSettings {
  const defaults = { ...BASE_SETTINGS };
  if (overrides.token) defaults.authMethod = "service-token";
  const merged: InfisicalSettings = { ...defaults, ...overrides };
  fixtureSettings = merged;
  infisical.configure(() => merged);
  return merged;
}

/** A fetch that answers the secrets list and records every request, so a
 * test can prove that no login call was made. */
function listOnly(secrets: Array<{ secretKey: string; secretValue: string }>) {
  const calls: Array<{ url: string; authorization: string | undefined }> = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = headerBag(init);
    calls.push({ url: String(url), authorization: headers.authorization });
    return new Response(JSON.stringify({ secrets }), { status: 200 });
  });
  return { calls, impl };
}

function loginThenList(secrets: Array<{ secretKey: string; secretValue: string }>) {
  return vi.fn(async (url: string) => {
    if (url.includes("/login")) {
      return new Response(JSON.stringify({ accessToken: SENTINEL_TOKEN }), { status: 200 });
    }
    return new Response(JSON.stringify({ secrets }), { status: 200 });
  });
}

const ENV_KEYS = [
  "INFISICAL_CLIENT_ID",
  "INFISICAL_CLIENT_SECRET",
  "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID",
  "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
  "INFISICAL_TOKEN",
  "INFISICAL_WRITE_TOKEN",
  "OMB_INFISICAL_BOOT_TIMEOUT_MS",
  "OMB_INFISICAL_CALL_TIMEOUT_MS",
  "INFISICAL_FLEET_OPS_PROJECT_ID",
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  fixtureTokenFiles.clear();
  metadataRequests.length = 0;
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  infisical.configure(null);
  infisical.stop();
  setInfisicalSnapshot(null, []);
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

describe("refresh: unconfigured and disabled", () => {
  it("retains partial setup metadata and the raw enabled switch while unconfigured", () => {
    const settings = withSettings({ authMethod: "service-token", enabled: false, projectId: "partial-project", clientId: "", clientSecret: "" });
    expect(infisical.getStatus()).toMatchObject({ configured: false, enabled: false, enabledSetting: false,
      siteUrl: settings.siteUrl, projectId: "partial-project" });
    settings.enabled = true;
    expect(infisical.getStatus()).toMatchObject({ configured: false, enabled: false, enabledSetting: true, projectId: "partial-project" });
  });
  it("makes no request and clears the snapshot when unconfigured", async () => {
    const fetchMock = vi.fn();
    stubFetch(fetchMock);
    withSettings({ projectId: "", clientId: "", clientSecret: "" });

    const status = await infisical.refresh("manual");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(status.configured).toBe(false);
    expect(status.enabled).toBe(false);
    expect(status.source).toBe("none");
    expect(infisicalSnapshot()).toBeNull();
  });

  it("makes no request and clears the snapshot when turned off despite full credentials", async () => {
    // Seed a snapshot as if a previous refresh had succeeded, so clearing it is observable.
    setInfisicalSnapshot(new Map([["COMPOSIO_API_KEY", "old-value"]]), ["COMPOSIO_API_KEY"]);
    const fetchMock = vi.fn();
    stubFetch(fetchMock);
    withSettings({ enabled: false });

    const status = await infisical.refresh("settings");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(status.configured).toBe(true);
    expect(status.enabled).toBe(false);
    expect(infisicalSnapshot()).toBeNull();
    expect(vaultNames()).toEqual([]);
  });
});

describe("refresh: a good sync", () => {
  it("applies only mapped names and reports the rest as unused", async () => {
    withSettings({});
    stubFetch(loginThenList([
        { secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE },
        { secretKey: "SOME_UNMAPPED_NAME", secretValue: "irrelevant" },
        { secretKey: "PATH", secretValue: "/usr/bin" },
      ]),
    );

    const status = await infisical.refresh("manual");

    expect(status.appliedFields).toEqual(["composio.apiKey"]);
    expect(status.appliedCount).toBe(1);
    expect(status.vaultCount).toBe(3);
    expect(status.unusedVaultNames.slice().sort()).toEqual(["PATH", "SOME_UNMAPPED_NAME"]);
    expect(status.lastError).toBeNull();
    expect(status.stale).toBe(false);
    expect(infisicalSnapshot()?.get("COMPOSIO_API_KEY")).toBe(SENTINEL_VAULT_VALUE);
    expect(infisicalSnapshot()?.has("PATH")).toBe(false);
  });

  it("reads with a service token and never logs in", async () => {
    // Every non-agent consumer holds a token scoped to one project,
    // environment and folder, so the read must not need a machine identity.
    withSettings({ clientId: "", clientSecret: "", token: SENTINEL_READ_TOKEN });
    const { calls, impl } = listOnly([
      { secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE },
    ]);
    stubFetch(impl);

    const status = await infisical.refresh("manual");

    expect(status.configured).toBe(true);
    expect(status.hasToken).toBe(true);
    expect(status.lastError).toBeNull();
    expect(calls.some((call) => call.url.includes("/login"))).toBe(false);
    expect(calls[0]?.authorization ?? "").toContain(SENTINEL_READ_TOKEN);
    expect(infisicalSnapshot()?.get("COMPOSIO_API_KEY")).toBe(SENTINEL_VAULT_VALUE);
  });

  it("writes through with the write token, not the read token", async () => {
    withSettings({
      clientId: "",
      clientSecret: "",
      token: SENTINEL_READ_TOKEN,
      writeToken: SENTINEL_WRITE_TOKEN,
      writeThrough: true,
    });
    const calls: Array<{ url: string; method: string; authorization: string | undefined }> = [];
    stubFetch(vi.fn(async (url: string, init?: RequestInit) => {
        const headers = headerBag(init);
        calls.push({
          url: String(url),
          method: init?.method ?? "GET",
          authorization: headers.authorization,
        });
        if (init?.method === "PATCH") return new Response("{}", { status: 200 });
        return new Response(
          JSON.stringify({ secrets: [{ secretKey: "COMPOSIO_API_KEY", secretValue: "new-value" }] }),
          { status: 200 },
        );
      }),
    );

    await infisical.writeSecret("COMPOSIO_API_KEY", "new-value");

    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.authorization ?? "").toContain(SENTINEL_WRITE_TOKEN);
    expect(patch?.authorization ?? "").not.toContain(SENTINEL_READ_TOKEN);
    expect(calls.some((call) => call.url.includes("/login"))).toBe(false);
  });

  it("calls onApplied with the reason on a successful refresh", async () => {
    const applied: string[] = [];
    infisical.configure(() => BASE_SETTINGS, (reason) => applied.push(reason));
    stubFetch(loginThenList([]));

    await infisical.refresh("timer");

    expect(applied).toEqual(["timer"]);
  });

  it("leaves the apply to the caller for the two reasons a caller already handles", async () => {
    // `POST /api/infisical/sync` and the PATCH handler both run
    // `applyResolvedSecrets` themselves the moment their refresh resolves.
    // Firing the callback here as well starts a SECOND, unawaited apply -- and
    // on the write-through path (`writeSecret` ends with `refresh("settings")`)
    // that apply rebuilds the whole fleet from inside a PATCH handler that is
    // still running, killing in-flight turns before the save has landed and
    // leaving the handler's own rebuild to overlap it.
    const applied: string[] = [];
    infisical.configure(() => BASE_SETTINGS, (reason) => applied.push(reason));
    stubFetch(loginThenList([]));

    await infisical.refresh("manual");
    await infisical.refresh("settings");
    expect(applied).toEqual([]);

    await infisical.refresh("boot");
    await infisical.refresh("timer");
    expect(applied).toEqual(["boot", "timer"]);
  });
});

describe("refresh: a second caller while one is in flight", () => {
  it("does not resolve a queued source token or request the vault after being turned off", async () => {
    const settings = withSettings({ token: SENTINEL_READ_TOKEN,
      readSources: [{ name: "primary", projectId: "proj-1", environment: "prod", secretPath: "/",
        tokenEnv: "BF_TEST_QUEUED_READ", tokenFile: "" }],
    });
    process.env.BF_TEST_QUEUED_READ = SENTINEL_READ_TOKEN;
    let finish!: (response: Response) => void;
    let started!: () => void;
    const readStarted = new Promise<void>((resolve) => { started = resolve; });
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; started(); }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stubFetch(fetchMock);
    try {
      const first = infisical.refresh("timer");
      await readStarted;
      const queued = infisical.refresh("manual");
      settings.enabled = false;
      // Remove the locator credential before the queued operation can start.
      delete process.env.BF_TEST_QUEUED_READ;
      finish(new Response(JSON.stringify({ secrets: [] })));
      await first;
      expect(await queued).toMatchObject({ enabled: false, stale: false, lastError: null });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(metadataRequests).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
      expect(infisicalSnapshot()).toBeNull();
    } finally {
      delete process.env.BF_TEST_QUEUED_READ;
      warn.mockRestore();
    }
  });

  it("queues its own read behind the one going instead of joining it", async () => {
    // The window is real: a timer refresh holds the manager for two HTTP
    // calls (up to 16 s on the default budget) and `preload()`'s losing
    // refresh outlives boot.  A Sync Now that lands inside it used to get an
    // untouched status back and answer 200, so the card re-rendered with the
    // same `lastSyncAt` it had before the click -- indistinguishable, to the
    // operator, from a broken button.  Joining the run in flight fixed the
    // symptom and left the real one: that run listed the store before the
    // click, so it cannot reflect anything the click was about.
    withSettings({});
    let calls = 0;
    stubFetch(vi.fn(async (url: string) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (url.includes("/login")) return new Response(JSON.stringify({ accessToken: SENTINEL_TOKEN }), { status: 200 });
        return new Response(
          JSON.stringify({ secrets: [{ secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE }] }),
          { status: 200 },
        );
      }),
    );

    const timerRun = infisical.refresh("timer");
    const syncRun = infisical.refresh("manual");
    const [timerStatus, syncStatus] = await Promise.all([timerRun, syncRun]);

    // Two logins and two lists: the sync got a read that started after it did.
    expect(calls).toBe(4);
    expect(syncStatus.appliedFields).toEqual(["composio.apiKey"]);
    expect(timerStatus.lastSyncAt).toBeTruthy();
    expect(syncStatus.lastSyncAt).toBeTruthy();
    // Strictly later, never the same stamp the first run wrote.
    expect(Date.parse(syncStatus.lastSyncAt!)).toBeGreaterThanOrEqual(Date.parse(timerStatus.lastSyncAt!));
    expect(syncStatus.lastSyncAt).not.toBe(timerStatus.lastSyncAt);
  });

  it("gives three overlapping callers one shared follow-up, not three", async () => {
    // The follow-up is a queue of exactly one: every caller that arrives
    // during the same read shares it, so an operator hammering Sync Now
    // costs one extra round trip in total rather than one each.
    withSettings({});
    let calls = 0;
    stubFetch(vi.fn(async (url: string) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (url.includes("/login")) return new Response(JSON.stringify({ accessToken: SENTINEL_TOKEN }), { status: 200 });
        return new Response(JSON.stringify({ secrets: [] }), { status: 200 });
      }),
    );

    const first = infisical.refresh("timer");
    const second = infisical.refresh("manual");
    const third = infisical.refresh("settings");
    const [, secondStatus, thirdStatus] = await Promise.all([first, second, third]);

    expect(calls).toBe(4);
    expect(secondStatus.lastSyncAt).toBe(thirdStatus.lastSyncAt);
  });
});

describe("refresh: a failure after a good sync", () => {
  it("keeps the previous snapshot and marks the status stale", async () => {
    withSettings({});
    stubFetch(loginThenList([{ secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE }]));
    const good = await infisical.refresh("manual");
    expect(good.lastError).toBeNull();
    expect(good.stale).toBe(false);

    stubFetch(vi.fn(async () => new Response("nope", { status: 500 })));
    const failed = await infisical.refresh("manual");

    expect(failed.stale).toBe(true);
    expect(failed.lastError).toMatch(/500/);
    expect(failed.appliedFields).toEqual(["composio.apiKey"]);
    expect(infisicalSnapshot()?.get("COMPOSIO_API_KEY")).toBe(SENTINEL_VAULT_VALUE);
  });
});

describe("preload", () => {
  it("resolves within the boot cap even though the underlying fetch is slower than the cap", async () => {
    process.env.OMB_INFISICAL_BOOT_TIMEOUT_MS = "20";
    withSettings({});
    // Real, but slow: each call takes longer than the cap, so the cap has to
    // win the race.  Never a promise that never settles at all -- that would
    // leave this manager's `inFlight` guard stuck for every later test in
    // this file, since nothing would ever reach the `finally` that clears it.
    stubFetch(vi.fn(async (url: string) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (url.includes("/login")) return new Response(JSON.stringify({ accessToken: SENTINEL_TOKEN }), { status: 200 });
        return new Response(JSON.stringify({ secrets: [] }), { status: 200 });
      }),
    );

    const start = Date.now();
    const status = await infisical.preload();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(status.configured).toBe(true);

    // Let the background refresh -- still in flight -- finish before the
    // next test runs, rather than leaving it dangling.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(infisical.getStatus().lastSyncAt).toBeTruthy();
  });

  it("says the boot sync did not finish rather than reporting a clean, empty vault", async () => {
    // When the cap wins, the in-flight refresh has stamped `lastAttemptAt` and
    // nothing else -- no error, not stale, vault=0.  Reported verbatim that
    // renders the SUCCESS boot line and a `Connected` pill for a boot that
    // never synced, so an operator greps the log for the documented
    // `unavailable` line, does not find it, and reads `applied=0` as "the
    // vault is empty" instead of "the boot sync never finished".
    process.env.OMB_INFISICAL_BOOT_TIMEOUT_MS = "20";
    withSettings({});
    stubFetch(vi.fn(async (url: string) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (url.includes("/login")) return new Response(JSON.stringify({ accessToken: SENTINEL_TOKEN }), { status: 200 });
        return new Response(JSON.stringify({ secrets: [] }), { status: 200 });
      }),
    );

    const status = await infisical.preload();

    expect(status.lastError).toMatch(/boot sync exceeded 20 ms/);
    expect(status.stale).toBe(true);
    expect(infisical.bootLine()).toMatch(/^\[infisical\] unavailable: boot sync exceeded 20 ms; /);

    // The late refresh still lands, and clears both.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const settled = infisical.getStatus();
    expect(settled.lastError).toBeNull();
    expect(settled.stale).toBe(false);
    expect(settled.lastSyncAt).toBeTruthy();
  });
});

describe("start", () => {
  it("re-arms the interval when Refresh Minutes changes", async () => {
    // `start()` reads `refreshMinutes` once, when it creates the interval, and
    // the PATCH handler never restarted it -- so narrowing 15 to 5 in Settings
    // left the 15-minute cadence running while both the status route and the
    // card echoed 5, and a rotation landed up to three times later than the UI
    // promised with nothing anywhere reporting the gap.
    vi.useFakeTimers();
    try {
      let minutes = 15;
      // Turned off on purpose: `refresh` then stamps `lastAttemptAt` and
      // returns with no HTTP call at all, so a tick is observable without a
      // stubbed fetch racing the fake clock.
      infisical.configure(() => ({ ...BASE_SETTINGS, enabled: false, refreshMinutes: minutes }));
      infisical.start();
      const before = infisical.getStatus().lastAttemptAt;

      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(infisical.getStatus().lastAttemptAt).toBe(before);

      minutes = 5;
      infisical.start();
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(infisical.getStatus().lastAttemptAt).not.toBe(before);
    } finally {
      infisical.stop();
      vi.useRealTimers();
    }
  });

  it("is a no-op when the cadence has not changed", async () => {
    vi.useFakeTimers();
    try {
      infisical.configure(() => ({ ...BASE_SETTINGS, enabled: false, refreshMinutes: 5 }));
      infisical.start();
      // Re-arming at the same cadence must not restart the countdown, or a
      // Settings save every four minutes would postpone the refresh forever.
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      const before = infisical.getStatus().lastAttemptAt;
      infisical.start();
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(infisical.getStatus().lastAttemptAt).not.toBe(before);
    } finally {
      infisical.stop();
      vi.useRealTimers();
    }
  });
});

describe("probe", () => {
  it("never touches the snapshot, even on success", async () => {
    withSettings({});
    stubFetch(loginThenList([{ secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE }]));

    const result = await infisical.probe();

    expect(result.ok).toBe(true);
    expect(result.secretCount).toBe(1);
    expect(result.names).toEqual(["COMPOSIO_API_KEY"]);
    expect(infisicalSnapshot()).toBeNull();
    expect(vaultNames()).toEqual([]);
  });

  it("reports a clear error with no request when unconfigured", async () => {
    const fetchMock = vi.fn();
    stubFetch(fetchMock);
    withSettings({ projectId: "" });

    const result = await infisical.probe();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/project id/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("readPath", () => {
  it("returns one folder's values to the caller and nowhere else", async () => {
    withSettings({ secretPath: "/zulip" });
    const fetchMock = loginThenList([{ secretKey: "ZULIP_BF_PLUMBER_API_KEY", secretValue: SENTINEL_VAULT_VALUE }]);
    stubFetch(fetchMock);

    const values = await infisical.readPath("/zulip");

    expect(values.get("ZULIP_BF_PLUMBER_API_KEY")).toBe(SENTINEL_VAULT_VALUE);
    // the folder asked for, not the configured snapshot path
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("secretPath=%2Fzulip");
    // never the snapshot, never the environment, never the status view
    expect(infisicalSnapshot()).toBeNull();
    expect(Object.values(process.env)).not.toContain(SENTINEL_VAULT_VALUE);
    expect(JSON.stringify(infisical.getStatus())).not.toContain(SENTINEL_VAULT_VALUE);
  });

  it("refuses a different project, environment or folder without dedicated credentials", async () => {
    withSettings({});
    const fetchMock = vi.fn();
    stubFetch(fetchMock);
    await expect(infisical.readPath("/zulip", { projectId: "other", environment: "prod" })).rejects.toThrow(/dedicated/);
    await expect(infisical.readPath("/", { environment: "staging" })).rejects.toThrow(/dedicated/);
    await expect(infisical.readPath("/zulip")).rejects.toThrow(/dedicated/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses with no request when Infisical is turned off", async () => {
    const fetchMock = vi.fn();
    stubFetch(fetchMock);
    withSettings({ enabled: false });

    await expect(infisical.readPath("/zulip")).rejects.toThrow(/not configured and turned on/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("readSources", () => {
  const FLEET_TOKEN = "fake-fleetops-token-not-real";
  const AFC_TOKEN = "fake-afc-token-not-real";
  function tokenFile(token: string): string {
    // Token files are only read from the BotFleet config directory, so
    // fixtures must live there (the throwaway test home), not in tmpdir.
    mkdirSync(dataDir(), { recursive: true });
    const dir = mkdtempSync(join(dataDir(), "bf-infi-"));
    const path = join(dir, "token");
    writeFileSync(path, `${token}\n`);
    chmodSync(path, 0o600);
    fixtureTokenFiles.set(path, token);
    return path;
  }
  function recordingFetch() {
    const calls: Array<{ url: string; authorization: string | undefined }> = [];
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = headerBag(init);
      calls.push({ url: String(url), authorization: headers.authorization });
      const auth = headers.authorization ?? "";
      const key = auth.includes(FLEET_TOKEN) ? "FLEET_KEY" : auth.includes(AFC_TOKEN) ? "AFC_KEY" : "MAIN_KEY";
      return new Response(JSON.stringify({ secrets: [{ secretKey: key, secretValue: `value-for-${key}` }] }), { status: 200 });
    });
    return { calls, impl };
  }

  it("selects a source by project, environment and path, and reads a named source", async () => {
    withSettings({
      token: SENTINEL_READ_TOKEN,
      readSources: [
        { name: "fleetops-zulip", tokenFile: tokenFile(FLEET_TOKEN), tokenEnv: "", projectId: "fleet-proj", environment: "prod", secretPath: "/zulip" },
        { name: "afc-zulip", tokenFile: tokenFile(AFC_TOKEN), tokenEnv: "", projectId: "afc-proj", environment: "prod", secretPath: "/zulip" },
      ],
    });
    const { calls, impl } = recordingFetch();
    stubFetch(impl);
    const fleet = await infisical.readPath("/zulip", { projectId: "fleet-proj", environment: "prod" });
    expect(fleet.get("FLEET_KEY")).toBe("value-for-FLEET_KEY");
    expect(calls.at(-1)?.authorization).toContain(FLEET_TOKEN);
    await expect(infisical.readPath("/zulip/nested", { projectId: "fleet-proj", environment: "prod" })).rejects.toThrow(/dedicated/);
    const named = await infisical.readSource("afc-zulip");
    expect(named.get("AFC_KEY")).toBe("value-for-AFC_KEY");
    expect(calls.at(-1)?.authorization).toContain(AFC_TOKEN);
    const main = await infisical.readPath("/", { projectId: "proj-1", environment: "prod" });
    expect(main.get("MAIN_KEY")).toBe("value-for-MAIN_KEY");
    expect(calls.at(-1)?.authorization).toContain(SENTINEL_READ_TOKEN);
    expect(infisical.getStatus().readSources.map((s) => [s.name, s.ok])).toEqual([["fleetops-zulip", true], ["afc-zulip", true]]);
    expect(JSON.stringify(infisical.getStatus())).not.toContain(FLEET_TOKEN);
  });

  it("warns once and rejects for a missing token file, naming the source and file only", async () => {
    withSettings({
      token: SENTINEL_READ_TOKEN,
      readSources: [{ name: "fleetops-zulip", tokenFile: "/tmp/bf-definitely-missing-token-file", tokenEnv: "", projectId: "fleet-proj", environment: "prod", secretPath: "/zulip" }],
    });
    stubFetch(vi.fn());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(infisical.readPath("/zulip", { projectId: "fleet-proj", environment: "prod" })).rejects.toThrow(/fleetops-zulip/);
      await expect(infisical.readSource("fleetops-zulip")).rejects.toThrow(/\/tmp\/bf-definitely-missing-token-file/);
      expect(warn).toHaveBeenCalledTimes(1);
      const text = warn.mock.calls.flat().join(" ");
      expect(text).toContain("fleetops-zulip");
      expect(text).toContain("/tmp/bf-definitely-missing-token-file");
      expect(text).not.toContain(FLEET_TOKEN);
      expect(infisical.getStatus().readSources[0]).toMatchObject({ name: "fleetops-zulip", ok: false });
      // main vault path still works after the failing source
      const { impl } = recordingFetch();
      stubFetch(impl);
      await expect(infisical.readPath("/", { projectId: "proj-1", environment: "prod" })).resolves.toBeInstanceOf(Map);
      await expect(infisical.refresh("manual")).resolves.toMatchObject({ lastError: null });
    } finally {
      warn.mockRestore();
    }
  });

  it("does not cache a failed source read: a later call retries and can succeed", async () => {
    mkdirSync(dataDir(), { recursive: true });
    const dir = mkdtempSync(join(dataDir(), "bf-infi-"));
    const path = join(dir, "token");
    withSettings({
      token: SENTINEL_READ_TOKEN,
      readSources: [{ name: "fleetops-zulip", tokenFile: path, tokenEnv: "", projectId: "fleet-proj", environment: "prod", secretPath: "/zulip" }],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(infisical.readSource("fleetops-zulip")).rejects.toThrow(/fleetops-zulip/);
      writeFileSync(path, `${FLEET_TOKEN}\n`);
      fixtureTokenFiles.set(path, FLEET_TOKEN);
      chmodSync(path, 0o600);
      const { impl } = recordingFetch();
      stubFetch(impl);
      const values = await infisical.readSource("fleetops-zulip");
      expect(values.get("FLEET_KEY")).toBe("value-for-FLEET_KEY");
      expect(infisical.getStatus().readSources[0]).toMatchObject({ name: "fleetops-zulip", ok: true });
    } finally {
      warn.mockRestore();
    }
  });

  it("matches a read source when stored or requested path has a trailing slash", async () => {
    withSettings({
      token: SENTINEL_READ_TOKEN,
      readSources: [{ name: "fleetops-zulip", tokenFile: tokenFile(FLEET_TOKEN), tokenEnv: "", projectId: "fleet-proj", environment: "prod", secretPath: "/zulip/" }],
    });
    const { calls, impl } = recordingFetch();
    stubFetch(impl);
    const storedSlash = await infisical.readPath("/zulip", { projectId: "fleet-proj", environment: "prod" });
    expect(storedSlash.get("FLEET_KEY")).toBe("value-for-FLEET_KEY");
    const requestedSlash = await infisical.readPath("/zulip/", { projectId: "fleet-proj", environment: "prod" });
    expect(requestedSlash.get("FLEET_KEY")).toBe("value-for-FLEET_KEY");
    const namedSlash = await infisical.readSource("fleetops-zulip", "/zulip/");
    expect(namedSlash.get("FLEET_KEY")).toBe("value-for-FLEET_KEY");
    expect(calls.length).toBe(3);
    expect(calls.every((c) => c.authorization?.includes(FLEET_TOKEN))).toBe(true);
  });

  it("rejects an explicit readSource path outside the source's secretPath, with a warning naming source and path and no request", async () => {
    withSettings({
      token: SENTINEL_READ_TOKEN,
      readSources: [{ name: "fleetops-zulip", tokenFile: tokenFile(FLEET_TOKEN), tokenEnv: "", projectId: "fleet-proj", environment: "prod", secretPath: "/zulip" }],
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ secrets: [{ secretKey: "FLEET_KEY", secretValue: "value-for-FLEET_KEY" }] }), { status: 200 }));
    stubFetch(fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(infisical.readSource("fleetops-zulip", "/other")).rejects.toThrow(/fleetops-zulip/);
      await expect(infisical.readSource("fleetops-zulip", "/other")).rejects.toThrow(/\/other/);
      // A sibling prefix is not under the source path either.
      await expect(infisical.readSource("fleetops-zulip", "/zulip-other")).rejects.toThrow(/\/zulip-other/);
      expect(fetchMock).not.toHaveBeenCalled();
      const warned = warn.mock.calls.flat().join(" ");
      expect(warned).toContain("fleetops-zulip");
      expect(warned).toContain("/other");
      expect(warned).not.toContain(FLEET_TOKEN);
      expect(infisical.getStatus().readSources[0]).toMatchObject({ name: "fleetops-zulip", ok: false });
      // Only the exact folder is covered.
      await expect(infisical.readSource("fleetops-zulip", "/zulip")).resolves.toBeInstanceOf(Map);
      await expect(infisical.readSource("fleetops-zulip", "/zulip/nested")).rejects.toThrow(/not covered/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps root scope exact, and uses the source's own path when none is given", async () => {
    withSettings({
      token: SENTINEL_READ_TOKEN,
      readSources: [
        { name: "root-source", tokenFile: tokenFile(FLEET_TOKEN), tokenEnv: "", projectId: "fleet-proj", environment: "prod", secretPath: "/" },
        { name: "fleetops-zulip", tokenFile: tokenFile(AFC_TOKEN), tokenEnv: "", projectId: "afc-proj", environment: "prod", secretPath: "/zulip" },
      ],
    });
    const { calls, impl } = recordingFetch();
    stubFetch(impl);
    await expect(infisical.readSource("root-source", "/anything/deep")).rejects.toThrow(/not covered/);
    expect(calls).toHaveLength(0);
    await expect(infisical.readSource("fleetops-zulip")).resolves.toBeInstanceOf(Map);
    expect(calls.at(-1)?.url).toContain("secretPath=%2Fzulip");
    expect(calls.at(-1)?.authorization).toContain(AFC_TOKEN);
  });

  it("refuses a token file outside the config directory, a symlink, and a group-readable file", async () => {
    const fetchMock = vi.fn();
    stubFetch(fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const outsideDir = mkdtempSync(join(tmpdir(), "bf-infi-outside-"));
      const outside = join(outsideDir, "token");
      writeFileSync(outside, `${FLEET_TOKEN}\n`);
      chmodSync(outside, 0o600);
      withSettings({
        readSources: [{ name: "fleetops-zulip", tokenFile: outside, tokenEnv: "", projectId: "fleet-proj", environment: "prod", secretPath: "/zulip" }],
      });
      await expect(infisical.readSource("fleetops-zulip")).rejects.toThrow(/outside the BotFleet config directory/);
      await expect(infisical.readSource("fleetops-zulip")).rejects.toThrow(new RegExp(outside.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

      const real = tokenFile(FLEET_TOKEN);
      const link = join(dataDir(), "bf-infi-link-token");
      symlinkSync(real, link);
      withSettings({
        readSources: [{ name: "fleetops-zulip", tokenFile: link, tokenEnv: "", projectId: "fleet-proj", environment: "prod", secretPath: "/zulip" }],
      });
      await expect(infisical.readSource("fleetops-zulip")).rejects.toThrow(/is a symlink/);

      const loose = tokenFile(FLEET_TOKEN);
      chmodSync(loose, 0o640);
      withSettings({
        readSources: [{ name: "fleetops-zulip", tokenFile: loose, tokenEnv: "", projectId: "fleet-proj", environment: "prod", secretPath: "/zulip" }],
      });
      await expect(infisical.readSource("fleetops-zulip")).rejects.toThrow(/group or other/);

      const notAFile = join(dataDir(), "bf-infi-dir-token");
      mkdirSync(notAFile, { recursive: true });
      withSettings({
        readSources: [{ name: "fleetops-zulip", tokenFile: notAFile, tokenEnv: "", projectId: "fleet-proj", environment: "prod", secretPath: "/zulip" }],
      });
      await expect(infisical.readSource("fleetops-zulip")).rejects.toThrow(/not a regular file/);

      const linkDir = join(dataDir(), "bf-infi-link-dir");
      symlinkSync(outsideDir, linkDir);
      withSettings({
        readSources: [{ name: "fleetops-zulip", tokenFile: join(linkDir, "token"), tokenEnv: "", projectId: "fleet-proj", environment: "prod", secretPath: "/zulip" }],
      });
      await expect(infisical.readSource("fleetops-zulip")).rejects.toThrow(/outside the BotFleet config directory/);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(warn.mock.calls.flat().join(" ")).toContain("fleetops-zulip");
      expect(warn.mock.calls.flat().join(" ")).not.toContain(FLEET_TOKEN);
    } finally {
      warn.mockRestore();
    }
  });

  it("reads a token file through the verified handle and always closes it", async () => {
    // A swap between check and open cannot be staged deterministically
    // without mocking fs (barred by lint), so this pins the observable
    // handle contract instead: the token that reaches the vault call is
    // the checked file's, and no descriptor is left open afterwards.
    const path = tokenFile(FLEET_TOKEN);
    withSettings({
      token: SENTINEL_READ_TOKEN,
      readSources: [{ name: "fleetops-zulip", tokenFile: path, tokenEnv: "", projectId: "fleet-proj", environment: "prod", secretPath: "/zulip" }],
    });
    const { calls, impl } = recordingFetch();
    stubFetch(impl);
    const fdDir = "/proc/self/fd";
    const openFds = () => (existsSync(fdDir) ? readdirSync(fdDir).length : null);
    const before = openFds();
    for (let i = 0; i < 3; i += 1) {
      const values = await infisical.readSource("fleetops-zulip");
      expect(values.get("FLEET_KEY")).toBe("value-for-FLEET_KEY");
    }
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.authorization?.includes(FLEET_TOKEN))).toBe(true);
    if (before !== null) expect(openFds()).toBe(before);
  });

  it("warns once and rejects when a source token is refused, without leaking it", async () => {
    withSettings({
      token: SENTINEL_READ_TOKEN,
      readSources: [{ name: "afc-zulip", tokenFile: tokenFile(AFC_TOKEN), tokenEnv: "", projectId: "afc-proj", environment: "prod", secretPath: "/zulip" }],
    });
    stubFetch(vi.fn(async () => new Response("no", { status: 401 })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(infisical.readSource("afc-zulip")).rejects.toThrow(/afc-zulip/);
      await expect(infisical.readSource("afc-zulip")).rejects.toThrow(/afc-zulip/);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.flat().join(" ")).not.toContain(AFC_TOKEN);
      expect(infisical.getStatus().readSources[0]).toMatchObject({ name: "afc-zulip", ok: false });
    } finally {
      warn.mockRestore();
    }
  });
});

describe("writeSecret", () => {
  it.each([
    { operation: "writeSecret", patchStatus: 200 }, { operation: "writeSource", patchStatus: 200 },
    { operation: "writeSecret", patchStatus: 404 }, { operation: "writeSource", patchStatus: 404 },
  ] as const)("preserves the landed state and stops follow-up requests after $operation PATCH $patchStatus finishes disabled", async ({ operation, patchStatus }) => {
    process.env.BF_TEST_DISABLED_READ = SENTINEL_READ_TOKEN;
    process.env.BF_TEST_DISABLED_WRITE = SENTINEL_WRITE_TOKEN;
    const settings = withSettings({ writeThrough: true, token: SENTINEL_READ_TOKEN, writeToken: SENTINEL_WRITE_TOKEN,
      readSources: [{ name: "primary", projectId: "proj-1", environment: "prod", secretPath: "/",
        tokenEnv: "BF_TEST_DISABLED_READ", tokenFile: "", writeTokenEnv: "BF_TEST_DISABLED_WRITE" }],
    });
    let finish!: (response: Response) => void;
    let started!: () => void;
    const patchStarted = new Promise<void>((resolve) => { started = resolve; });
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; started(); }));
    stubFetch(fetchMock);
    try {
      const write = operation === "writeSecret"
        ? infisical.writeSecret("COMPOSIO_API_KEY", "new-value")
        : infisical.writeSource("primary", "COMPOSIO_API_KEY", "new-value");
      const pending = write.then(() => null, (error: InfisicalError) => error);
      await patchStarted;
      settings.enabled = false;
      finish(new Response("{}", { status: patchStatus }));
      const error = await pending;
      expect(error).toMatchObject({ statusCode: 409, writeLanded: patchStatus === 200 });
      expect(error?.message).toContain(patchStatus === 200 ? "write landed" : "turned off");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(metadataRequests).toHaveLength(1);
      expect(infisicalSnapshot()).toBeNull();
    } finally {
      delete process.env.BF_TEST_DISABLED_READ;
      delete process.env.BF_TEST_DISABLED_WRITE;
    }
  });

  it("does not request secrets after a machine login completes with the connection off", async () => {
    const settings = withSettings({});
    let finish!: (response: Response) => void;
    let started!: () => void;
    const loginStarted = new Promise<void>((resolve) => { started = resolve; });
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; started(); }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = infisical.probe();
    await loginStarted;
    settings.enabled = false;
    finish(new Response(JSON.stringify({ accessToken: SENTINEL_TOKEN })));
    expect(await pending).toMatchObject({ ok: false, error: "Infisical is turned off." });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["refresh", "probe", "readPath", "readSource"] as const)
  ("discards %s values when the connection is disabled during the secrets request", async (operation) => {
    process.env.BF_TEST_DISABLED_READ = SENTINEL_READ_TOKEN;
    const settings = withSettings({ token: SENTINEL_READ_TOKEN,
      readSources: [{ name: "primary", projectId: "proj-1", environment: "prod", secretPath: "/",
        tokenEnv: "BF_TEST_DISABLED_READ", tokenFile: "" }],
    });
    let finish!: (response: Response) => void;
    let started!: () => void;
    const listStarted = new Promise<void>((resolve) => { started = resolve; });
    stubFetch(vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; started(); })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const calls = { refresh: () => infisical.refresh("manual"), probe: () => infisical.probe(),
        readPath: () => infisical.readPath("/"), readSource: () => infisical.readSource("primary") };
      const pending = calls[operation]().then((value) => ({ value }), (error: InfisicalError) => ({ error }));
      await listStarted;
      settings.enabled = false;
      finish(new Response(JSON.stringify({ secrets: [{ secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE }] })));
      const result = await pending;
      if (operation === "refresh") expect(result).toMatchObject({ value: { enabled: false, stale: false, lastError: null } });
      else if (operation === "probe") expect(result).toMatchObject({ value: { ok: false, error: "Infisical is turned off." } });
      else expect(result).toMatchObject({ error: { statusCode: 409 } });
      expect(infisicalSnapshot()).toBeNull();
      expect(JSON.stringify(result)).not.toContain(SENTINEL_VAULT_VALUE);
    } finally {
      delete process.env.BF_TEST_DISABLED_READ;
      warn.mockRestore();
    }
  });

  it("refuses while disabled even with write-through and credentials configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    withSettings({ enabled: false, writeThrough: true, token: SENTINEL_READ_TOKEN, writeToken: SENTINEL_WRITE_TOKEN });
    await expect(infisical.writeSecret("COMPOSIO_API_KEY", "new-value")).rejects.toMatchObject({ statusCode: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["probe", "readPath", "readSource", "writeSecret", "writeSource"] as const)
  ("stops %s before its vault call when disabled during metadata verification", async (operation) => {
    process.env.BF_TEST_DISABLED_READ = SENTINEL_READ_TOKEN;
    process.env.BF_TEST_DISABLED_WRITE = SENTINEL_WRITE_TOKEN;
    const settings = withSettings({ writeThrough: true, token: SENTINEL_READ_TOKEN, writeToken: SENTINEL_WRITE_TOKEN,
      readSources: [{ name: "primary", projectId: "proj-1", environment: "prod", secretPath: "/",
        tokenEnv: "BF_TEST_DISABLED_READ", tokenFile: "", writeTokenEnv: "BF_TEST_DISABLED_WRITE" }],
    });
    let finish!: (response: Response) => void;
    let started!: () => void;
    const metadataStarted = new Promise<void>((resolve) => { started = resolve; });
    const fetchMock = vi.fn((url: string) => {
      if (String(url).endsWith("/api/v2/service-token")) {
        return new Promise<Response>((resolve) => { finish = resolve; started(); });
      }
      return Promise.resolve(new Response(JSON.stringify({ secrets: [] })));
    });
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const calls = {
        probe: () => infisical.probe(), readPath: () => infisical.readPath("/"),
        readSource: () => infisical.readSource("primary"),
        writeSecret: () => infisical.writeSecret("COMPOSIO_API_KEY", "new-value"),
        writeSource: () => infisical.writeSource("primary", "COMPOSIO_API_KEY", "new-value"),
      };
      const outcome = calls[operation]().then((value) => ({ value }), (error: InfisicalError) => ({ error }));
      await metadataStarted;
      settings.enabled = false;
      finish(new Response(JSON.stringify({ workspace: "proj-1", environment: "prod", expiresAt: null,
        permissions: operation.startsWith("write") ? ["write"] : ["read"],
        scopes: [{ environment: "prod", secretPath: "/" }],
      })));
      const result = await outcome;
      if (operation === "probe") expect(result).toMatchObject({ value: { ok: false, error: "Infisical is turned off." } });
      else expect(result).toMatchObject({ error: { statusCode: 409 } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.BF_TEST_DISABLED_READ;
      delete process.env.BF_TEST_DISABLED_WRITE;
      warn.mockRestore();
    }
  });

  it("refuses with 409 when write-through is off, without a request", async () => {
    const fetchMock = vi.fn();
    stubFetch(fetchMock);
    withSettings({ writeThrough: false });

    await expect(infisical.writeSecret("COMPOSIO_API_KEY", "new-value")).rejects.toMatchObject({ statusCode: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to clear a managed value even with write-through on", async () => {
    const fetchMock = vi.fn();
    stubFetch(fetchMock);
    withSettings({ writeThrough: true });

    await expect(infisical.writeSecret("COMPOSIO_API_KEY", "")).rejects.toMatchObject({ statusCode: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes through then refreshes so the new value is what resolves next", async () => {
    withSettings({ writeThrough: true });
    const methods: string[] = [];
    stubFetch(vi.fn(async (url: string, init?: RequestInit) => {
        methods.push(init?.method ?? "GET");
        if (url.includes("/login")) return new Response(JSON.stringify({ accessToken: SENTINEL_TOKEN }), { status: 200 });
        if (init?.method === "PATCH") return new Response("{}", { status: 200 });
        return new Response(
          JSON.stringify({ secrets: [{ secretKey: "COMPOSIO_API_KEY", secretValue: "new-value" }] }),
          { status: 200 },
        );
      }),
    );

    await infisical.writeSecret("COMPOSIO_API_KEY", "new-value");

    expect(methods).toContain("PATCH");
    expect(infisicalSnapshot()?.get("COMPOSIO_API_KEY")).toBe("new-value");
  });

  it("does not settle on a read that started before the upsert", async () => {
    // The overlap that made this a real defect: a timer or late boot read is
    // still in flight when a write-through save runs.  That read listed the
    // store BEFORE the upsert, so joining it publishes the pre-write value as
    // the post-write snapshot -- and the harness then tombstones the local
    // copy and answers 200, leaving every bot on the old credential until the
    // next timer.  The write has to be followed by a read that started after
    // it.
    withSettings({ writeThrough: true });
    let listCalls = 0;
    let upserted = false;
    stubFetch(vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/login")) return new Response(JSON.stringify({ accessToken: SENTINEL_TOKEN }), { status: 200 });
        if (init?.method === "PATCH") {
          upserted = true;
          return new Response("{}", { status: 200 });
        }
        listCalls += 1;
        // The FIRST list is the slow one already in flight when the save
        // lands, and it answers with the pre-write value.  Anything after the
        // upsert answers with what was written.
        const first = listCalls === 1;
        if (first) await new Promise((resolve) => setTimeout(resolve, 40));
        const secretValue = upserted && !first ? "written-value" : "pre-write-value";
        return new Response(
          JSON.stringify({ secrets: [{ secretKey: "COMPOSIO_API_KEY", secretValue }] }),
          { status: 200 },
        );
      }),
    );

    // A timer read is under way; the save arrives while it is still listing.
    const slow = infisical.refresh("timer");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await infisical.writeSecret("COMPOSIO_API_KEY", "written-value");

    expect(infisicalSnapshot()?.get("COMPOSIO_API_KEY")).toBe("written-value");
    await slow;
    // And the slow read landing first did not overwrite it on the way out.
    expect(infisicalSnapshot()?.get("COMPOSIO_API_KEY")).toBe("written-value");
  });

  it("rejects writeSecret when the post-upsert verification refresh fails and preserves snapshot", async () => {
    withSettings({ writeThrough: true });
    let patchCount = 0;
    stubFetch(vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/login")) return new Response(JSON.stringify({ accessToken: SENTINEL_TOKEN }), { status: 200 });
        if (init?.method === "PATCH") {
          patchCount += 1;
          return new Response("{}", { status: 200 });
        }
        return new Response("internal error", { status: 500 });
      }),
    );

    await expect(infisical.writeSecret("COMPOSIO_API_KEY", "new-value")).rejects.toMatchObject({
      name: "InfisicalError",
      statusCode: 502,
      writeLanded: true,
      message: expect.stringMatching(/verification refresh failed/i),
    });
    expect(patchCount).toBe(1);
    expect(infisicalSnapshot()?.get("COMPOSIO_API_KEY")).toBeUndefined();
  });

  it("preserves snapshot published before a failed verification refresh", async () => {
    withSettings({ writeThrough: true });
    stubFetch(loginThenList([{ secretKey: "COMPOSIO_API_KEY", secretValue: "published-canonical" }]),
    );
    await infisical.refresh("manual");
    expect(infisicalSnapshot()?.get("COMPOSIO_API_KEY")).toBe("published-canonical");

    stubFetch(vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/login")) return new Response(JSON.stringify({ accessToken: SENTINEL_TOKEN }), { status: 200 });
        if (init?.method === "PATCH") return new Response("{}", { status: 200 });
        return new Response("internal error", { status: 500 });
      }),
    );

    await expect(infisical.writeSecret("COMPOSIO_API_KEY", "attempted-value")).rejects.toMatchObject({
      name: "InfisicalError",
      statusCode: 502,
      writeLanded: true,
    });

    expect(infisicalSnapshot()?.get("COMPOSIO_API_KEY")).toBe("published-canonical");
  });

  it("reconciles ambiguous upsert timeouts when the secret actually landed in Infisical", async () => {
    withSettings({ writeThrough: true });
    let patchCount = 0;
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";

    stubFetch(vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/login")) return new Response(JSON.stringify({ accessToken: SENTINEL_TOKEN }), { status: 200 });
        if (init?.method === "PATCH") {
          patchCount += 1;
          throw timeoutErr;
        }
        return new Response(
          JSON.stringify({ secrets: [{ secretKey: "COMPOSIO_API_KEY", secretValue: "landed-value" }] }),
          { status: 200 },
        );
      }),
    );

    await infisical.writeSecret("COMPOSIO_API_KEY", "landed-value");
    expect(patchCount).toBe(1);
    expect(infisicalSnapshot()?.get("COMPOSIO_API_KEY")).toBe("landed-value");
  });

  it("rejects ambiguous upsert timeouts when the reconciliation refresh fails even if pre-existing snapshot matches", async () => {
    withSettings({ writeThrough: true });
    let patchCount = 0;
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";

    stubFetch(loginThenList([{ secretKey: "COMPOSIO_API_KEY", secretValue: "existing-value" }]),
    );
    await infisical.refresh("manual");
    expect(infisicalSnapshot()?.get("COMPOSIO_API_KEY")).toBe("existing-value");

    stubFetch(vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/login")) return new Response(JSON.stringify({ accessToken: SENTINEL_TOKEN }), { status: 200 });
        if (init?.method === "PATCH") {
          patchCount += 1;
          throw timeoutErr;
        }
        return new Response("internal error", { status: 500 });
      }),
    );

    await expect(infisical.writeSecret("COMPOSIO_API_KEY", "existing-value")).rejects.toMatchObject({
      name: "InfisicalError",
      statusCode: 504,
    });
    expect(patchCount).toBe(1);
  });

  it("preserves canonical snapshot and rejects with 409 when verification encounters a conflict", async () => {
    withSettings({ writeThrough: true });
    stubFetch(vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/login")) return new Response(JSON.stringify({ accessToken: SENTINEL_TOKEN }), { status: 200 });
        if (init?.method === "PATCH") return new Response("{}", { status: 200 });
        return new Response(
          JSON.stringify({ secrets: [{ secretKey: "COMPOSIO_API_KEY", secretValue: "canonical-newer-value" }] }),
          { status: 200 },
        );
      }),
    );

    await expect(infisical.writeSecret("COMPOSIO_API_KEY", "stale-attempt")).rejects.toMatchObject({
      name: "InfisicalError",
      statusCode: 409,
      writeLanded: true,
      message: expect.stringMatching(/different value/i),
    });

    expect(infisicalSnapshot()?.get("COMPOSIO_API_KEY")).toBe("canonical-newer-value");
  });
});

describe("identity source", () => {
  it("ignores an inactive service-token environment value in machine identity mode", () => {
    process.env.INFISICAL_TOKEN = "fake-unused-service-token";
    withSettings({ authMethod: "machine-identity" });
    expect(infisical.getStatus().source).toBe("config");
  });
  it("reports config when the identity came from settings, env when it came from process.env", () => {
    withSettings({});
    expect(infisical.getStatus().source).toBe("config");

    process.env.INFISICAL_CLIENT_ID = "from-env";
    process.env.INFISICAL_CLIENT_SECRET = SENTINEL_CLIENT_SECRET;
    expect(infisical.getStatus().source).toBe("env");
  });
});

describe("pendingProviderReload", () => {
  it("is a plain flag the harness sets and clears", () => {
    withSettings({});
    expect(infisical.getStatus().pendingProviderReload).toBe(false);

    infisical.setPendingProviderReload(true);
    expect(infisical.getStatus().pendingProviderReload).toBe(true);

    infisical.setPendingProviderReload(false);
    expect(infisical.getStatus().pendingProviderReload).toBe(false);
  });
});

describe("bootLine", () => {
  it("renders the not-configured and disabled-by-settings forms", async () => {
    withSettings({ projectId: "", clientId: "", clientSecret: "" });
    await infisical.refresh("manual");
    expect(infisical.bootLine()).toBe("[infisical] disabled: not configured (select an auth method and add its credentials in Settings > Secrets)");

    withSettings({ enabled: false });
    await infisical.refresh("settings");
    expect(infisical.bootLine()).toBe("[infisical] disabled by settings");
  });

  it("renders the unavailable form after a failed refresh", async () => {
    withSettings({});
    stubFetch(vi.fn(async () => new Response("nope", { status: 500 })));

    await infisical.refresh("manual");

    expect(infisical.bootLine()).toMatch(/^\[infisical\] unavailable: .*; using environment and config values$/);
  });

  it("renders the enabled form with names, field ids and counts only", async () => {
    withSettings({});
    stubFetch(loginThenList([{ secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE }]));

    await infisical.refresh("manual");

    expect(infisical.bootLine()).toMatch(
      /^\[infisical\] enabled env=prod path=\/ vault=1 applied=1 fields=composio\.apiKey unused=0 ms=\d+$/,
    );
  });
});

// OP11: bootLine() used to print at boot and again on every Settings PATCH
// that carried an `infisical` block, even one that changed nothing.
describe("bootLineIfChanged", () => {
  it("returns the line the first time, then null while nothing changes", () => {
    withSettings({ projectId: "", clientId: "", clientSecret: "" });
    expect(infisical.bootLineIfChanged()).toBe(
      "[infisical] disabled: not configured (select an auth method and add its credentials in Settings > Secrets)",
    );
    expect(infisical.bootLineIfChanged()).toBeNull();
    expect(infisical.bootLineIfChanged()).toBeNull();
  });

  it("returns a fresh line the moment the state actually changes", () => {
    withSettings({ projectId: "", clientId: "", clientSecret: "" });
    expect(infisical.bootLineIfChanged()).not.toBeNull();

    withSettings({ enabled: false });
    expect(infisical.bootLineIfChanged()).toBe("[infisical] disabled by settings");
    expect(infisical.bootLineIfChanged()).toBeNull();
  });

  it("ignores a changed sync duration alone", async () => {
    vi.useFakeTimers();
    try {
      withSettings({});
      let advanceMsPerCall = 5;
      stubFetch(vi.fn(async (url: string) => {
          vi.advanceTimersByTime(advanceMsPerCall);
          if (url.includes("/login")) {
            return new Response(JSON.stringify({ accessToken: SENTINEL_TOKEN }), { status: 200 });
          }
          return new Response(
            JSON.stringify({ secrets: [{ secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE }] }),
            { status: 200 },
          );
        }),
      );

      await infisical.refresh("manual");
      expect(infisical.bootLineIfChanged()).toMatch(/ms=10$/); // login + list, 5ms each

      // A later Settings PATCH re-syncs (server/index.ts calls refresh()
      // before printing) and stamps a NEW lastSyncMs even though nothing
      // configuration-shaped moved — a much slower round trip this time.
      advanceMsPerCall = 50;
      await infisical.refresh("settings");
      expect(infisical.bootLine()).toMatch(/ms=100$/); // the raw line did change...
      expect(infisical.bootLineIfChanged()).toBeNull(); // ...but the deduped one ignores timing alone
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts over when a new settings provider is installed", () => {
    withSettings({ projectId: "", clientId: "", clientSecret: "" });
    expect(infisical.bootLineIfChanged()).not.toBeNull();
    expect(infisical.bootLineIfChanged()).toBeNull();

    // Same effective state, but reconfigured — as boot does once and a
    // fresh test case's beforeEach effectively does too.
    withSettings({ projectId: "", clientId: "", clientSecret: "" });
    expect(infisical.bootLineIfChanged()).not.toBeNull();
  });
});

describe("no secret ever leaves this module", () => {
  it("keeps the client secret, bearer token and vault value out of the status view and the boot line", async () => {
    withSettings({});
    stubFetch(loginThenList([{ secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE }]));

    await infisical.refresh("manual");
    const serialized = JSON.stringify(infisical.getStatus());
    const line = infisical.bootLine();

    for (const sentinel of [SENTINEL_CLIENT_SECRET, SENTINEL_TOKEN, SENTINEL_VAULT_VALUE]) {
      expect(serialized).not.toContain(sentinel);
      expect(line).not.toContain(sentinel);
    }
  });
});

// ---------------------------------------------------------------------------
// The service-token fallback.  A configured token the server refuses (401,
// 403, 404) is a definitive answer about the CREDENTIAL, and an install
// that also has a machine identity falls back to it.  A transient answer
// (429, any 5xx, a timeout) says nothing about the credential, so the token
// stays exactly where it was and the next refresh tries it again.  The two
// look identical from the outside unless the manager keeps them apart,
// which is what these cases pin down.
// ---------------------------------------------------------------------------
describe("explicit auth and scope isolation", () => {
  it("fails closed for excess resolved token references without trying a primary fallback", async () => {
    const settings = infisicalSettings({ infisical: { projectId: "p", token: "fake-primary-read", readSources: [
      { name: "other-read", projectId: "p", secretPath: "/other", tokenEnv: "ANOTHER_READ" },
    ] } });
    const fetchMock = vi.fn();
    stubFetch(fetchMock);
    infisical.configure(() => settings);
    expect((await infisical.refresh("manual")).lastError).toMatch(/one read token reference/);
    expect((await infisical.probe()).ok).toBe(false);
    await expect(infisical.readSource("other-read")).rejects.toThrow(/one read token reference/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(infisicalSnapshot()).toBeNull();
  });
  function record(options: { status?: number; refused?: string[] } = {}) {
    const calls: Array<{ url: string; authorization: string; method: string; body: string }> = [];
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      const authorization = headerBag(init).authorization ?? "";
      calls.push({ url: String(url), authorization, method: init?.method ?? "GET", body: String(init?.body ?? "") });
      if (String(url).includes("/login")) return new Response(JSON.stringify({ accessToken: SENTINEL_TOKEN }));
      if (options.refused?.some((token) => authorization === `Bearer ${token}`)) return new Response("refused", { status: options.status ?? 401 });
      return new Response(JSON.stringify({ secrets: [{ secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE }] }));
    });
    stubFetch(impl);
    return calls;
  }

  it.each([401, 403, 404])("fails closed after scoped token rejection %i even with a machine identity present", async (status) => {
    withSettings({ token: SENTINEL_READ_TOKEN });
    const calls = record({ status, refused: [SENTINEL_READ_TOKEN] });
    setInfisicalSnapshot(new Map([["COMPOSIO_API_KEY", "previous"]]), ["COMPOSIO_API_KEY"]);
    const result = await infisical.refresh("manual");
    expect(result.stale).toBe(true);
    expect(result.readTokenRefused).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe(`Bearer ${SENTINEL_READ_TOKEN}`);
    expect(infisicalSnapshot()?.get("COMPOSIO_API_KEY")).toBe("previous");
    await infisical.refresh("timer");
    expect(calls).toHaveLength(1);
  });

  it.each([429, 502, 503, 504])("retries transient failure %i with the same scoped token", async (status) => {
    withSettings({ token: SENTINEL_READ_TOKEN });
    const calls = record({ status, refused: [SENTINEL_READ_TOKEN] });
    const result = await infisical.refresh("manual");
    await infisical.refresh("timer");
    expect(result.readTokenRefused).toBe(false);
    expect(calls.map((call) => call.authorization)).toEqual([`Bearer ${SENTINEL_READ_TOKEN}`, `Bearer ${SENTINEL_READ_TOKEN}`]);
  });

  it("requires explicit selection before a configured machine identity is used", async () => {
    const settings = withSettings({ authMethod: undefined });
    const calls = record();
    expect((await infisical.refresh("manual")).configured).toBe(false);
    expect(calls).toHaveLength(0);
    settings.authMethod = "machine-identity";
    expect((await infisical.refresh("settings")).stale).toBe(false);
    expect(calls.filter((call) => call.url.includes("/login"))).toHaveLength(1);
  });

  it("honors explicit machine identity selection even when unused service tokens remain configured", async () => {
    withSettings({ authMethod: "machine-identity", token: SENTINEL_READ_TOKEN });
    const calls = record({ refused: [SENTINEL_READ_TOKEN] });
    expect((await infisical.refresh("manual")).stale).toBe(false);
    expect(calls.filter((call) => call.url.includes("/login"))).toHaveLength(1);
    expect(calls.some((call) => call.authorization.includes(SENTINEL_READ_TOKEN))).toBe(false);
  });

  it("never uses a read credential to satisfy a missing write credential", async () => {
    withSettings({ token: SENTINEL_READ_TOKEN, writeThrough: true, writeToken: "" });
    const calls = record();
    await expect(infisical.writeSecret("COMPOSIO_API_KEY", "replacement")).rejects.toThrow(/write service token/);
    expect(calls).toHaveLength(0);
  });

  it("does not fall back after write credential rejection", async () => {
    withSettings({ token: SENTINEL_READ_TOKEN, writeToken: SENTINEL_WRITE_TOKEN, writeThrough: true });
    const calls = record({ refused: [SENTINEL_WRITE_TOKEN], status: 403 });
    await expect(infisical.writeSecret("COMPOSIO_API_KEY", "replacement")).rejects.toThrow(/403/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe(`Bearer ${SENTINEL_WRITE_TOKEN}`);
    expect(infisical.getStatus().writeTokenRefused).toBe(true);
  });

  it("tries rotated credentials and operator retries without activating a different auth method", async () => {
    const settings = withSettings({ token: SENTINEL_READ_TOKEN });
    const calls = record({ refused: [SENTINEL_READ_TOKEN] });
    await infisical.refresh("manual");
    infisical.retryRefusedTokens();
    await infisical.refresh("manual");
    expect(calls).toHaveLength(2);
    settings.token = "fake-rotated-read-token";
    expect((await infisical.refresh("manual")).stale).toBe(false);
    expect(calls).toHaveLength(3);
    expect(calls.some((call) => call.url.includes("/login"))).toBe(false);
  });

  it("uses distinct scoped read and write locators for the primary vault", async () => {
    process.env.BF_TEST_SCOPE_READ = SENTINEL_READ_TOKEN;
    process.env.BF_TEST_SCOPE_WRITE = SENTINEL_WRITE_TOKEN;
    try {
      withSettings({ authMethod: "service-token", token: "unused-primary-read", writeToken: "unused-primary-write", writeThrough: true, readSources: [{
        name: "primary", projectId: "proj-1", environment: "prod", secretPath: "/", tokenEnv: "BF_TEST_SCOPE_READ", tokenFile: "",
        writeTokenEnv: "BF_TEST_SCOPE_WRITE",
      }] });
      const calls = record();
      await infisical.refresh("manual");
      await infisical.writeSecret("COMPOSIO_API_KEY", SENTINEL_VAULT_VALUE);
      expect(calls.map((call) => call.authorization)).toEqual([`Bearer ${SENTINEL_READ_TOKEN}`, `Bearer ${SENTINEL_WRITE_TOKEN}`, `Bearer ${SENTINEL_READ_TOKEN}`]);
      const status = infisical.getStatus();
      expect(status.readSources[0]).toMatchObject({ hasReadToken: true, hasWriteToken: true });
      expect(JSON.stringify(status)).not.toContain(SENTINEL_WRITE_TOKEN);
      expect(JSON.stringify(status)).not.toContain(SENTINEL_READ_TOKEN);
    } finally {
      delete process.env.BF_TEST_SCOPE_READ;
      delete process.env.BF_TEST_SCOPE_WRITE;
    }
  });

  it("refuses a matching source with a missing token instead of borrowing primary credentials", async () => {
    withSettings({ token: SENTINEL_READ_TOKEN, writeThrough: true, writeToken: SENTINEL_WRITE_TOKEN, readSources: [{
      name: "primary", projectId: "proj-1", environment: "prod", secretPath: "/", tokenEnv: "BF_TEST_UNSET_TOKEN", tokenFile: "",
    }] });
    const calls = record();
    expect((await infisical.refresh("manual")).stale).toBe(true);
    await expect(infisical.writeSecret("COMPOSIO_API_KEY", "replacement")).rejects.toThrow(/write/);
    expect(calls).toHaveLength(0);
  });

  it("writes a secondary source only through its dedicated write locator, without publishing its values", async () => {
    process.env.BF_TEST_SECONDARY_WRITE = SENTINEL_WRITE_TOKEN;
    try {
      withSettings({ writeThrough: true, readSources: [{
        name: "secondary", projectId: "another-project", environment: "staging", secretPath: "/writes", tokenEnv: "", tokenFile: "",
        writeTokenEnv: "BF_TEST_SECONDARY_WRITE",
      }] });
      const calls = record();
      setInfisicalSnapshot(new Map([["COMPOSIO_API_KEY", "previous"]]), ["COMPOSIO_API_KEY"]);
      await infisical.writeSource("secondary", "SECONDARY_KEY", "replacement");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.authorization).toBe(`Bearer ${SENTINEL_WRITE_TOKEN}`);
      expect(JSON.parse(calls[0]!.body)).toMatchObject({ workspaceId: "another-project", environment: "staging", secretPath: "/writes" });
      expect(infisicalSnapshot()?.get("COMPOSIO_API_KEY")).toBe("previous");
    } finally { delete process.env.BF_TEST_SECONDARY_WRITE; }
  });

  it("keeps test connection inert when disabled", async () => {
    withSettings({ enabled: false, token: SENTINEL_READ_TOKEN });
    const calls = record();
    expect((await infisical.probe()).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("discards a last-good snapshot when the primary project changes and the new scope fails", async () => {
    const settings = withSettings({ token: SENTINEL_READ_TOKEN });
    record();
    await infisical.refresh("manual");
    expect(infisicalSnapshot()?.get("COMPOSIO_API_KEY")).toBe(SENTINEL_VAULT_VALUE);
    settings.projectId = "different-project";
    record({ refused: [SENTINEL_READ_TOKEN], status: 403 });
    expect((await infisical.refresh("settings")).stale).toBe(true);
    expect(infisicalSnapshot()).toBeNull();
    expect(infisical.getStatus().lastSyncAt).toBeNull();
  });

  it("discards a delayed response after the connection scope changes mid-read", async () => {
    const settings = withSettings({ token: SENTINEL_READ_TOKEN });
    let finish!: (response: Response) => void;
    let started!: () => void;
    const readStarted = new Promise<void>((resolve) => { started = resolve; });
    stubFetch(vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; started(); })));
    const pending = infisical.refresh("manual");
    await readStarted;
    settings.projectId = "different-project";
    finish(new Response(JSON.stringify({ secrets: [{ secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE }] })));
    const result = await pending;
    expect(result.stale).toBe(true);
    expect(result.lastError).toContain("discarded");
    expect(infisicalSnapshot()).toBeNull();
  });
});

describe("service token metadata gate", () => {
  it.each(["//", "///", "/./", "/fleet/../", "/folder//", "/folder/./child", "/folder//child"])
  ("rejects malformed stored primary folder %s before any network request", async (secretPath) => {
    withSettings(infisicalSettings({ infisical: { authMethod: "service-token", projectId: "proj-1",
      secretPath, token: SENTINEL_READ_TOKEN,
    } }));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ secrets: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const result = await infisical.refresh("manual");
    expect(result.lastError).toMatch(/literal folder/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(infisicalSnapshot()).toBeNull();
  });

  interface ServiceTokenMetadataFixture {
    workspace: string;
    projectId: string;
    scopes: Array<{ environment: string; secretPath: string } | null>;
    permissions: string[];
    expiresAt?: string | null;
  }
  const grant = (permissions = ["read"], patch: Partial<ServiceTokenMetadataFixture> = {}) => ({
    workspace: "proj-1", projectId: "proj-1", scopes: [{ environment: "prod", secretPath: "/requested/" }],
    permissions, expiresAt: null, ...patch,
  });
  function wire(readMetadata: ServiceTokenMetadataFixture, writeMetadata: ServiceTokenMetadataFixture = grant(["write"])) {
    const calls: Array<{ path: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, method: init?.method ?? "GET" });
      if (path === "/api/v2/service-token") {
        const metadata = headerBag(init).authorization === `Bearer ${SENTINEL_WRITE_TOKEN}` ? writeMetadata : readMetadata;
        return new Response(JSON.stringify(metadata));
      }
      // A permissive/clamping server would answer this request successfully.
      // Verification must stop rejected scopes before this response is reachable.
      return new Response(JSON.stringify({ secrets: [{ secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE }] }));
    }));
    return calls;
  }
  const settings = () => withSettings({ secretPath: "/requested", token: SENTINEL_READ_TOKEN,
    writeToken: SENTINEL_WRITE_TOKEN, writeThrough: true });
  const secretCalls = (calls: Array<{ path: string }>) => calls.filter((call) => call.path.startsWith("/api/v3/secrets"));

  it.each([
    ["wrong project", { workspace: "another-project" }],
    ["wrong environment", { scopes: [{ environment: "staging", secretPath: "/requested" }] }],
    ["clamped folder", { scopes: [{ environment: "prod", secretPath: "/granted" }] }],
    ["root is not a descendant grant", { scopes: [{ environment: "prod", secretPath: "/" }] }],
    ["wildcard folder", { scopes: [{ environment: "prod", secretPath: "/requested/*" }] }],
    ["write-capable read token", { permissions: ["read", "write"] }],
    ["expired token", { expiresAt: "2000-01-01T00:00:00Z" }],
    ["missing expiry metadata", { expiresAt: undefined }],
    ["malformed scopes", { scopes: [null] }],
  ] satisfies Array<[string, Partial<ServiceTokenMetadataFixture>]>)
  ("prevents secret reads for %s without MI fallback", async (_label, patch) => {
    settings();
    const calls = wire(grant(["read"], patch));
    const result = await infisical.refresh("manual");
    expect(result.stale).toBe(true);
    expect(result.lastError).not.toBeNull();
    expect(secretCalls(calls)).toEqual([]);
    expect(calls.every((call) => call.path === "/api/v2/service-token")).toBe(true);
    expect(infisicalSnapshot()).toBeNull();
  });

  it.each([
    ["wrong project", { workspace: "another-project" }],
    ["wrong folder", { scopes: [{ environment: "prod", secretPath: "/granted" }] }],
    ["wrong environment", { scopes: [{ environment: "staging", secretPath: "/requested" }] }],
    ["read-only write credential", { permissions: ["read"] }],
    ["expired token", { expiresAt: "2000-01-01T00:00:00Z" }],
    ["malformed expiry", { expiresAt: "not-a-date" }],
  ] satisfies Array<[string, Partial<ServiceTokenMetadataFixture>]>)
  ("prevents writes and reconciliation reads for %s", async (_label, patch) => {
    settings();
    const calls = wire(grant(), grant(["write"], patch));
    await expect(infisical.writeSecret("COMPOSIO_API_KEY", "replacement")).rejects.toBeInstanceOf(Error);
    expect(calls).toHaveLength(1);
    expect(secretCalls(calls)).toEqual([]);
  });

  it("verifies dedicated source credentials before their independent secret read", async () => {
    const source = withSettings({ token: SENTINEL_READ_TOKEN, readSources: [{
      name: "secondary", projectId: "another-project", environment: "prod", secretPath: "/requested",
      tokenEnv: "BF_TEST_METADATA_SOURCE", tokenFile: "",
    }] });
    process.env.BF_TEST_METADATA_SOURCE = "fake-secondary-token";
    const calls = wire(grant());
    try {
      await expect(infisical.readSource("secondary")).rejects.toThrow(/configured project/);
      await expect(infisical.readPath("/requested", { projectId: source.readSources[0].projectId })).rejects.toThrow();
      expect(secretCalls(calls)).toEqual([]);
      expect(calls).toHaveLength(1);
    } finally { delete process.env.BF_TEST_METADATA_SOURCE; }
  });

  it("caches successful metadata by credential, site, exact scope and role for at most a minute", async () => {
    const configured = settings();
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const calls = wire(grant());
    const checks = () => calls.filter((call) => call.path === "/api/v2/service-token").length;
    try {
      await infisical.refresh("manual");
      await infisical.refresh("timer");
      expect(checks()).toBe(1);
      configured.siteUrl = "https://second-vault.example.test";
      await infisical.refresh("timer");
      expect(checks()).toBe(2);
      configured.token = "fake-rotated-read-token";
      await infisical.refresh("timer");
      expect(checks()).toBe(3);
      clock += 60_001;
      await infisical.refresh("timer");
      expect(checks()).toBe(4);
      // A read check never authorizes a write, even at the identical scope.
      configured.writeToken = SENTINEL_WRITE_TOKEN;
      await infisical.writeSecret("COMPOSIO_API_KEY", SENTINEL_VAULT_VALUE);
      expect(checks()).toBe(5);
    } finally { now.mockRestore(); }
  });

  it("never keeps cached verification beyond the token's expiry", async () => {
    settings();
    let clock = Date.now();
    const expiresAt = new Date(clock + 1_000).toISOString();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const calls = wire(grant(["read"], { expiresAt }));
    try {
      await infisical.refresh("manual");
      clock += 1_001;
      const result = await infisical.refresh("timer");
      expect(result.lastError).toMatch(/expired/);
      expect(secretCalls(calls)).toHaveLength(1);
      expect(calls.filter((call) => call.path === "/api/v2/service-token")).toHaveLength(2);
    } finally { now.mockRestore(); }
  });

  it("evicts the least recently used credential when the 64-entry cache fills", async () => {
    const configured = settings();
    const clock = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(clock);
    const calls = wire(grant());
    const checks = () => calls.filter((call) => call.path === "/api/v2/service-token").length;
    const read = async (index: number) => {
      configured.token = `fake-lru-token-${index}`;
      expect((await infisical.refresh("manual")).lastError).toBeNull();
    };
    try {
      for (let index = 0; index < 64; index++) await read(index);
      expect(checks()).toBe(64);
      await read(0);
      expect(checks()).toBe(64);
      await read(64);
      expect(checks()).toBe(65);
      await read(0);
      expect(checks()).toBe(65);
      await read(1);
      expect(checks()).toBe(66);
    } finally { now.mockRestore(); }
  });

  it("promotes cache hits without extending their original verification lifetime", async () => {
    settings();
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const calls = wire(grant());
    const checks = () => calls.filter((call) => call.path === "/api/v2/service-token").length;
    try {
      await infisical.refresh("manual");
      clock += 30_000;
      await infisical.refresh("timer");
      expect(checks()).toBe(1);
      clock += 30_001;
      await infisical.refresh("timer");
      expect(checks()).toBe(2);
    } finally { now.mockRestore(); }
  });

  it("does not use a cached read-only grant to authorize the same credential for a write", async () => {
    withSettings({ secretPath: "/requested", token: SENTINEL_READ_TOKEN, writeToken: SENTINEL_READ_TOKEN, writeThrough: true });
    const calls = wire(grant());
    await infisical.refresh("manual");
    await expect(infisical.writeSecret("COMPOSIO_API_KEY", "replacement")).rejects.toThrow(/write permission/);
    expect(secretCalls(calls)).toHaveLength(1);
    expect(calls.filter((call) => call.path === "/api/v2/service-token")).toHaveLength(2);
  });

  it.each([
    ["projectId", "another-project"], ["environment", "staging"], ["secretPath", "/another-folder"],
  ] as const)("does not reuse cached metadata after changing %s", async (field, value) => {
    const configured = settings();
    const calls = wire(grant());
    await infisical.refresh("manual");
    configured[field] = value;
    expect((await infisical.refresh("settings")).lastError).not.toBeNull();
    expect(secretCalls(calls)).toHaveLength(1);
    expect(calls.filter((call) => call.path === "/api/v2/service-token")).toHaveLength(2);
  });

  it("never probes metadata for explicitly selected machine identity or disabled installs", async () => {
    withSettings({ enabled: false, token: SENTINEL_READ_TOKEN });
    const noCalls = wire(grant());
    await infisical.refresh("manual");
    expect(noCalls).toEqual([]);
    withSettings({ authMethod: "machine-identity", token: SENTINEL_READ_TOKEN });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(new URL(String(url)).pathname);
      return String(url).includes("/login")
        ? new Response(JSON.stringify({ accessToken: SENTINEL_TOKEN }))
        : new Response(JSON.stringify({ secrets: [] }));
    }));
    expect((await infisical.refresh("manual")).lastError).toBeNull();
    expect(calls).toEqual(["/api/v1/auth/universal-auth/login", "/api/v3/secrets/raw"]);
  });
});

describe("the fleet's project", () => {
  it("comes from the environment variable the fleet's own tools read", () => {
    process.env.INFISICAL_FLEET_OPS_PROJECT_ID = "  a-project-id  ";
    expect(fleetOpsProjectId()).toBe("a-project-id");
  });

  it("is empty when the host has no such variable", () => {
    // The product server reads nothing else for it:  the fleet keeps that
    // project id out of every repository, and the server does not reach
    // into the fleet's own handoff files for a setting.
    expect(fleetOpsProjectId()).toBe("");
  });
});

describe("readProjectPath", () => {
  it("refuses to borrow the primary machine identity for the fleet project", async () => {
    process.env.INFISICAL_FLEET_OPS_PROJECT_ID = "fleet-ops-project-id";
    withSettings({});
    const fetchMock = vi.fn();
    stubFetch(fetchMock);
    await expect(infisical.readProjectPath("fleet-ops", "/cli-logins/BF-ORACLE")).rejects.toThrow(/dedicated/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads BotFleet's own project when the caller names that one", async () => {
    const settings = withSettings({});
    const fetchMock = loginThenList([{ secretKey: "XAI_API_KEY", secretValue: SENTINEL_VAULT_VALUE }]);
    stubFetch(fetchMock);

    await infisical.readProjectPath("botfleet", "/");

    const listUrl = new URL(String(fetchMock.mock.calls.at(-1)?.[0]));
    expect(listUrl.searchParams.get("workspaceId")).toBe(settings.projectId);
  });

  it("refuses with no request when this host has no project id for the fleet's project", async () => {
    const fetchMock = vi.fn();
    stubFetch(fetchMock);
    withSettings({});
    await expect(infisical.readProjectPath("fleet-ops", "/cli-logins/BF-ORACLE")).rejects.toThrow(
      /fleet's Infisical project is not configured/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
