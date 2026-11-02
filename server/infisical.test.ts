import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InfisicalSettings } from "./config.ts";
import { infisical } from "./infisical.ts";
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

function withSettings(overrides: Partial<InfisicalSettings>): InfisicalSettings {
  const merged: InfisicalSettings = { ...BASE_SETTINGS, ...overrides };
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
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
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
  it("makes no request and clears the snapshot when unconfigured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
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
    vi.stubGlobal("fetch", fetchMock);
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
    vi.stubGlobal(
      "fetch",
      loginThenList([
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
    vi.stubGlobal("fetch", impl);

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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
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
    vi.stubGlobal("fetch", loginThenList([]));

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
    vi.stubGlobal("fetch", loginThenList([]));

    await infisical.refresh("manual");
    await infisical.refresh("settings");
    expect(applied).toEqual([]);

    await infisical.refresh("boot");
    await infisical.refresh("timer");
    expect(applied).toEqual(["boot", "timer"]);
  });
});

describe("refresh: a second caller while one is in flight", () => {
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
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
    vi.stubGlobal("fetch", loginThenList([{ secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE }]));
    const good = await infisical.refresh("manual");
    expect(good.lastError).toBeNull();
    expect(good.stale).toBe(false);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
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
    vi.stubGlobal("fetch", loginThenList([{ secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE }]));

    const result = await infisical.probe();

    expect(result.ok).toBe(true);
    expect(result.secretCount).toBe(1);
    expect(result.names).toEqual(["COMPOSIO_API_KEY"]);
    expect(infisicalSnapshot()).toBeNull();
    expect(vaultNames()).toEqual([]);
  });

  it("reports a clear error with no request when unconfigured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    withSettings({ projectId: "" });

    const result = await infisical.probe();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/project id/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("readPath", () => {
  it("returns one folder's values to the caller and nowhere else", async () => {
    withSettings({});
    const fetchMock = loginThenList([{ secretKey: "ZULIP_BF_PLUMBER_API_KEY", secretValue: SENTINEL_VAULT_VALUE }]);
    vi.stubGlobal("fetch", fetchMock);

    const values = await infisical.readPath("/zulip");

    expect(values.get("ZULIP_BF_PLUMBER_API_KEY")).toBe(SENTINEL_VAULT_VALUE);
    // the folder asked for, not the configured snapshot path
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("secretPath=%2Fzulip");
    // never the snapshot, never the environment, never the status view
    expect(infisicalSnapshot()).toBeNull();
    expect(Object.values(process.env)).not.toContain(SENTINEL_VAULT_VALUE);
    expect(JSON.stringify(infisical.getStatus())).not.toContain(SENTINEL_VAULT_VALUE);
  });

  it("reads another project's environment when the caller names one, with the same identity", async () => {
    const settings = withSettings({});
    const fetchMock = loginThenList([{ secretKey: "ZULIP_BF_PLUMBER_API_KEY", secretValue: SENTINEL_VAULT_VALUE }]);
    vi.stubGlobal("fetch", fetchMock);

    const values = await infisical.readPath("/zulip", { projectId: "afc-project-id", environment: "staging" });

    expect(values.get("ZULIP_BF_PLUMBER_API_KEY")).toBe(SENTINEL_VAULT_VALUE);
    const listUrl = new URL(String(fetchMock.mock.calls.at(-1)?.[0]));
    expect(listUrl.searchParams.get("workspaceId")).toBe("afc-project-id");
    expect(listUrl.searchParams.get("environment")).toBe("staging");
    expect(listUrl.searchParams.get("secretPath")).toBe("/zulip");
    // one login, with the harness's own identity
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/login"))).toHaveLength(1);

    // blank overrides fall back to the configured project and environment
    await infisical.readPath("/zulip", { projectId: " ", environment: "" });
    const ownUrl = new URL(String(fetchMock.mock.calls.at(-1)?.[0]));
    expect(ownUrl.searchParams.get("workspaceId")).toBe(settings.projectId);
    expect(ownUrl.searchParams.get("environment")).toBe(settings.environment);
  });

  it("refuses with no request when Infisical is turned off", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    withSettings({ enabled: false });

    await expect(infisical.readPath("/zulip")).rejects.toThrow(/not configured and turned on/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("readSources", () => {
  const FLEET_TOKEN = "fake-fleetops-token-not-real";
  const AFC_TOKEN = "fake-afc-token-not-real";
  function tokenFile(token: string): string {
    const dir = mkdtempSync(join(tmpdir(), "bf-infi-"));
    const path = join(dir, "token");
    writeFileSync(path, `${token}\n`);
    chmodSync(path, 0o600);
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
    vi.stubGlobal("fetch", impl);
    const fleet = await infisical.readPath("/zulip", { projectId: "fleet-proj", environment: "prod" });
    expect(fleet.get("FLEET_KEY")).toBe("value-for-FLEET_KEY");
    expect(calls.at(-1)?.authorization).toContain(FLEET_TOKEN);
    const under = await infisical.readPath("/zulip/nested", { projectId: "fleet-proj", environment: "prod" });
    expect(under.get("FLEET_KEY")).toBe("value-for-FLEET_KEY");
    const named = await infisical.readSource("afc-zulip");
    expect(named.get("AFC_KEY")).toBe("value-for-AFC_KEY");
    expect(calls.at(-1)?.authorization).toContain(AFC_TOKEN);
    const main = await infisical.readPath("/zulip", { projectId: "proj-1", environment: "prod" });
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
    vi.stubGlobal("fetch", vi.fn());
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
      vi.stubGlobal("fetch", impl);
      await expect(infisical.readPath("/other", { projectId: "proj-1", environment: "prod" })).resolves.toBeInstanceOf(Map);
      await expect(infisical.refresh("manual")).resolves.toMatchObject({ lastError: null });
    } finally {
      warn.mockRestore();
    }
  });

  it("does not cache a failed source read: a later call retries and can succeed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bf-infi-"));
    const path = join(dir, "token");
    withSettings({
      token: SENTINEL_READ_TOKEN,
      readSources: [{ name: "fleetops-zulip", tokenFile: path, tokenEnv: "", projectId: "fleet-proj", environment: "prod", secretPath: "/zulip" }],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(infisical.readSource("fleetops-zulip")).rejects.toThrow(/fleetops-zulip/);
      writeFileSync(path, `${FLEET_TOKEN}\n`);
      chmodSync(path, 0o600);
      const { impl } = recordingFetch();
      vi.stubGlobal("fetch", impl);
      const values = await infisical.readSource("fleetops-zulip");
      expect(values.get("FLEET_KEY")).toBe("value-for-FLEET_KEY");
      expect(infisical.getStatus().readSources[0]).toMatchObject({ name: "fleetops-zulip", ok: true });
    } finally {
      warn.mockRestore();
    }
  });

  it("warns once and rejects when a source token is refused, without leaking it", async () => {
    withSettings({
      token: SENTINEL_READ_TOKEN,
      readSources: [{ name: "afc-zulip", tokenFile: tokenFile(AFC_TOKEN), tokenEnv: "", projectId: "afc-proj", environment: "prod", secretPath: "/zulip" }],
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
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
  it("refuses with 409 when write-through is off, without a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    withSettings({ writeThrough: false });

    await expect(infisical.writeSecret("COMPOSIO_API_KEY", "new-value")).rejects.toMatchObject({ statusCode: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to clear a managed value even with write-through on", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    withSettings({ writeThrough: true });

    await expect(infisical.writeSecret("COMPOSIO_API_KEY", "")).rejects.toMatchObject({ statusCode: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes through then refreshes so the new value is what resolves next", async () => {
    withSettings({ writeThrough: true });
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
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
    vi.stubGlobal(
      "fetch",
      loginThenList([{ secretKey: "COMPOSIO_API_KEY", secretValue: "published-canonical" }]),
    );
    await infisical.refresh("manual");
    expect(infisicalSnapshot()?.get("COMPOSIO_API_KEY")).toBe("published-canonical");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
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

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
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

    vi.stubGlobal(
      "fetch",
      loginThenList([{ secretKey: "COMPOSIO_API_KEY", secretValue: "existing-value" }]),
    );
    await infisical.refresh("manual");
    expect(infisicalSnapshot()?.get("COMPOSIO_API_KEY")).toBe("existing-value");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
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
    expect(infisical.bootLine()).toBe("[infisical] disabled: not configured (add a machine identity in Settings > Secrets)");

    withSettings({ enabled: false });
    await infisical.refresh("settings");
    expect(infisical.bootLine()).toBe("[infisical] disabled by settings");
  });

  it("renders the unavailable form after a failed refresh", async () => {
    withSettings({});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    await infisical.refresh("manual");

    expect(infisical.bootLine()).toMatch(/^\[infisical\] unavailable: .*; using environment and config values$/);
  });

  it("renders the enabled form with names, field ids and counts only", async () => {
    withSettings({});
    vi.stubGlobal("fetch", loginThenList([{ secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE }]));

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
      "[infisical] disabled: not configured (add a machine identity in Settings > Secrets)",
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
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
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
    vi.stubGlobal("fetch", loginThenList([{ secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE }]));

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
describe("service token fallback", () => {
  // A second fake token, distinct from the first:  "which bearer was used"
  // has to be answerable without a substring reading as a match.
  const ROTATED_READ_TOKEN = "sentinel-rotated-read-token-not-real";

  type RecordedCall = { url: string; method: string; authorization: string | undefined };

  /** A fetch that records every call, answers the login with a session
   * token, refuses the named bearers with `status` and answers every other
   * request with the secrets list. */
  function refusingList(options: {
    refused: string[];
    status: number;
    secrets?: Array<{ secretKey: string; secretValue: string }>;
  }) {
    const calls: RecordedCall[] = [];
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = headerBag(init);
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        authorization: headers.authorization,
      });
      if (String(url).includes("/login")) {
        return new Response(JSON.stringify({ accessToken: SENTINEL_TOKEN }), { status: 200 });
      }
      const bearer = (headers.authorization ?? "").replace(/^Bearer /, "");
      if (options.refused.includes(bearer)) {
        return new Response("refused", { status: options.status });
      }
      return new Response(JSON.stringify({ secrets: options.secrets ?? [] }), { status: 200 });
    });
    return { calls, impl };
  }

  function listCalls(calls: RecordedCall[]): RecordedCall[] {
    return calls.filter((call) => !call.url.includes("/login"));
  }

  function loginCalls(calls: RecordedCall[]): RecordedCall[] {
    return calls.filter((call) => call.url.includes("/login"));
  }

  it("falls back to the machine identity when the server refuses the configured service token", async () => {
    // A revoked service token used to break every vault call on the host.
    // The install still has a machine identity, so the refresh has to land
    // on it instead of reporting the vault as gone.
    withSettings({ token: SENTINEL_READ_TOKEN });
    const { calls, impl } = refusingList({
      refused: [SENTINEL_READ_TOKEN],
      status: 401,
      secrets: [{ secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE }],
    });
    vi.stubGlobal("fetch", impl);

    const status = await infisical.refresh("manual");

    expect(status.lastError).toBeNull();
    expect(status.stale).toBe(false);
    expect(status.appliedFields).toEqual(["composio.apiKey"]);
    expect(infisicalSnapshot()?.get("COMPOSIO_API_KEY")).toBe(SENTINEL_VAULT_VALUE);

    // One login, two lists:  the refused one and the retry.
    expect(loginCalls(calls)).toHaveLength(1);
    const lists = listCalls(calls);
    expect(lists).toHaveLength(2);
    // The first list carried the configured token and was refused...
    expect(lists[0]?.authorization ?? "").toContain(SENTINEL_READ_TOKEN);
    // ...and the retry carried the machine identity's session token.
    expect(lists[1]?.authorization ?? "").toContain(SENTINEL_TOKEN);
    expect(lists[1]?.authorization ?? "").not.toContain(SENTINEL_READ_TOKEN);
  });

  it("keeps the token configured and the last good snapshot when there is no machine identity", async () => {
    // A token-only host has nothing to fall back to.  The refusal must not
    // cost the operator their configuration, and it must not empty a vault
    // that was already synced.
    withSettings({ clientId: "", clientSecret: "", token: SENTINEL_READ_TOKEN });
    const good = listOnly([{ secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE }]);
    vi.stubGlobal("fetch", good.impl);
    const synced = await infisical.refresh("manual");
    expect(synced.stale).toBe(false);
    expect(infisicalSnapshot()?.get("COMPOSIO_API_KEY")).toBe(SENTINEL_VAULT_VALUE);

    const { calls, impl } = refusingList({ refused: [SENTINEL_READ_TOKEN], status: 401 });
    vi.stubGlobal("fetch", impl);

    const failed = await infisical.refresh("manual");

    expect(failed.lastError).toMatch(/401/);
    // The ORIGINAL error is what the caller sees, not a synthesized one.
    expect(failed.lastError).toMatch(/secrets list failed/i);
    expect(failed.stale).toBe(true);
    // No machine identity means no login attempt at all.
    expect(loginCalls(calls)).toHaveLength(0);

    const status = infisical.getStatus();
    expect(status.hasToken).toBe(true);
    expect(status.configured).toBe(true);
    expect(status.enabled).toBe(true);
    // The vault that was already synced is still there.
    expect(infisicalSnapshot()?.get("COMPOSIO_API_KEY")).toBe(SENTINEL_VAULT_VALUE);
  });

  it("does not probe the server again for a token it already knows was refused", async () => {
    // The remembered refusal answers the question on its own:  re-probing a
    // credential the server already rejected costs a round trip per refresh
    // and tells the operator nothing new.
    withSettings({ clientId: "", clientSecret: "", token: SENTINEL_READ_TOKEN });
    const { calls, impl } = refusingList({ refused: [SENTINEL_READ_TOKEN], status: 401 });
    vi.stubGlobal("fetch", impl);

    const first = await infisical.refresh("manual");
    expect(first.lastError).toMatch(/401/);
    expect(listCalls(calls)).toHaveLength(1);

    const second = await infisical.refresh("manual");
    expect(listCalls(calls)).toHaveLength(1);
    expect(second.lastError).toMatch(/no machine identity to fall back to/i);
  });

  it("does not fall back on a transient failure and keeps trying the same token", async () => {
    // A 503 says the server is unwell, not that the credential is dead.
    // Falling back there would trade one credential for another over a
    // network blip, and recording the token as refused would strand the
    // install on the fallback for good.
    withSettings({ token: SENTINEL_READ_TOKEN });
    const { calls, impl } = refusingList({ refused: [SENTINEL_READ_TOKEN], status: 503 });
    vi.stubGlobal("fetch", impl);

    const first = await infisical.refresh("manual");
    expect(first.lastError).toMatch(/503/);
    expect(first.stale).toBe(true);
    // The token is not removed from the configuration either.
    expect(first.hasToken).toBe(true);
    expect(loginCalls(calls)).toHaveLength(0);

    // The second refresh tries the SAME token again:  it was never refused.
    const second = await infisical.refresh("manual");
    expect(second.lastError).toMatch(/503/);
    const lists = listCalls(calls);
    expect(lists).toHaveLength(2);
    expect(lists[1]?.authorization ?? "").toContain(SENTINEL_READ_TOKEN);
    expect(loginCalls(calls)).toHaveLength(0);
  });

  it("falls back to the machine identity on a 403, which refuses that request", async () => {
    // A grant that does not cover what was asked for is final about THAT
    // request, and the call falls back to the machine identity.  It is not
    // final about the credential, so the token is not deprioritized for the
    // rest of the vault:  the scope test below pins that.
    withSettings({ token: SENTINEL_READ_TOKEN });
    const { calls, impl } = refusingList({
      refused: [SENTINEL_READ_TOKEN],
      status: 403,
      secrets: [{ secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE }],
    });
    vi.stubGlobal("fetch", impl);

    const status = await infisical.refresh("manual");

    expect(status.lastError).toBeNull();
    expect(infisicalSnapshot()?.get("COMPOSIO_API_KEY")).toBe(SENTINEL_VAULT_VALUE);
    expect(loginCalls(calls)).toHaveLength(1);
    const lists = listCalls(calls);
    expect(lists).toHaveLength(2);
    expect(lists[1]?.authorization ?? "").toContain(SENTINEL_TOKEN);
    expect(lists[1]?.authorization ?? "").not.toContain(SENTINEL_READ_TOKEN);
  });

  it("does not treat a 429 as a refusal of the credential", async () => {
    // Rate limited is not refused:  the token is still the right one, and
    // the next refresh has to try it again rather than log in instead.
    withSettings({ token: SENTINEL_READ_TOKEN });
    const { calls, impl } = refusingList({ refused: [SENTINEL_READ_TOKEN], status: 429 });
    vi.stubGlobal("fetch", impl);

    const first = await infisical.refresh("manual");
    expect(first.lastError).toMatch(/429/);
    expect(loginCalls(calls)).toHaveLength(0);

    const second = await infisical.refresh("manual");
    expect(second.lastError).toMatch(/429/);
    const lists = listCalls(calls);
    expect(lists).toHaveLength(2);
    expect(lists[1]?.authorization ?? "").toContain(SENTINEL_READ_TOKEN);
    expect(loginCalls(calls)).toHaveLength(0);
  });

  it("tries a rotated token again after the old one was refused", async () => {
    // The memory holds the token VALUE, not a flag:  a rotation is a new
    // value in the same setting, and it has to be tried on its own merits
    // rather than inherit the old token's rejection.
    let settings: InfisicalSettings = { ...BASE_SETTINGS, token: SENTINEL_READ_TOKEN };
    infisical.configure(() => settings);
    const { calls, impl } = refusingList({
      refused: [SENTINEL_READ_TOKEN],
      status: 401,
      secrets: [{ secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE }],
    });
    vi.stubGlobal("fetch", impl);

    const first = await infisical.refresh("manual");
    expect(first.lastError).toBeNull();

    // The operator saves a rotated token.
    settings = { ...settings, token: ROTATED_READ_TOKEN };

    const second = await infisical.refresh("manual");
    expect(second.lastError).toBeNull();
    const lists = listCalls(calls);
    expect(lists.at(-1)?.authorization ?? "").toContain(ROTATED_READ_TOKEN);
    expect(lists.at(-1)?.authorization ?? "").not.toContain(SENTINEL_READ_TOKEN);
  });

  it("forgets a refused token when a new settings source is installed", async () => {
    // `configure()` installs a new credential source, and the server calls it
    // at boot:  that source's token has to be tried on its own merits rather
    // than inherit the previous source's rejection.
    withSettings({ clientId: "", clientSecret: "", token: SENTINEL_READ_TOKEN });
    const refused = refusingList({ refused: [SENTINEL_READ_TOKEN], status: 401 });
    vi.stubGlobal("fetch", refused.impl);
    const failed = await infisical.refresh("manual");
    expect(failed.lastError).toMatch(/401/);

    const accepted = refusingList({
      refused: [],
      status: 401,
      secrets: [{ secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE }],
    });
    vi.stubGlobal("fetch", accepted.impl);
    withSettings({ clientId: "", clientSecret: "", token: SENTINEL_READ_TOKEN });

    const status = await infisical.refresh("manual");

    expect(status.lastError).toBeNull();
    expect(listCalls(accepted.calls)[0]?.authorization ?? "").toContain(SENTINEL_READ_TOKEN);
    expect(infisicalSnapshot()?.get("COMPOSIO_API_KEY")).toBe(SENTINEL_VAULT_VALUE);
  });

  it("forgets a refused token when the operator asks for a retry", async () => {
    // A Sync Now and a Settings save are the operator asking for the
    // configured token to be tried again.  A grant widened or a path created
    // in the vault changes neither the token nor the scope, so the memory
    // cannot notice it on its own:  without the explicit retry the token
    // would stay deprioritized until the process restarted.
    withSettings({ clientId: "", clientSecret: "", token: SENTINEL_READ_TOKEN });
    const refused = refusingList({ refused: [SENTINEL_READ_TOKEN], status: 401 });
    vi.stubGlobal("fetch", refused.impl);
    const failed = await infisical.refresh("manual");
    expect(failed.lastError).toMatch(/401/);
    expect(infisical.getStatus().readTokenRefused).toBe(true);

    const accepted = refusingList({
      refused: [],
      status: 401,
      secrets: [{ secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE }],
    });
    vi.stubGlobal("fetch", accepted.impl);

    infisical.retryRefusedTokens();
    const status = await infisical.refresh("manual");

    expect(status.lastError).toBeNull();
    expect(infisical.getStatus().readTokenRefused).toBe(false);
    expect(listCalls(accepted.calls)[0]?.authorization ?? "").toContain(SENTINEL_READ_TOKEN);
    expect(infisicalSnapshot()?.get("COMPOSIO_API_KEY")).toBe(SENTINEL_VAULT_VALUE);
  });

  it("reports a refused configured token as a failure, even when a machine identity would have worked", async () => {
    // The probe is the operator's question about the CONFIGURED credential.
    // Falling back inside it would answer a different question and turn a
    // dead token into a green light.
    withSettings({ token: SENTINEL_READ_TOKEN });
    const { calls, impl } = refusingList({ refused: [SENTINEL_READ_TOKEN], status: 401 });
    vi.stubGlobal("fetch", impl);

    const result = await infisical.probe();

    expect(result.ok).toBe(false);
    expect(result.error ?? "").toMatch(/^The configured read service token was refused by the server:/);
    // No fallback inside a probe.
    expect(loginCalls(calls)).toHaveLength(0);
  });

  it("falls back to the machine identity for a write when the write token is refused", async () => {
    // The write token is refused the same way the read token is, and the
    // write has to land on the machine identity rather than be lost.
    withSettings({
      token: SENTINEL_READ_TOKEN,
      writeToken: SENTINEL_WRITE_TOKEN,
      writeThrough: true,
    });
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const headers = headerBag(init);
        calls.push({
          url: String(url),
          method: init?.method ?? "GET",
          authorization: headers.authorization,
        });
        if (String(url).includes("/login")) {
          return new Response(JSON.stringify({ accessToken: SENTINEL_TOKEN }), { status: 200 });
        }
        const bearer = (headers.authorization ?? "").replace(/^Bearer /, "");
        if (init?.method === "PATCH") {
          // The configured write token is refused;  the machine identity is not.
          if (bearer === SENTINEL_WRITE_TOKEN) return new Response("refused", { status: 401 });
          return new Response("{}", { status: 200 });
        }
        // The verification read after the upsert.
        return new Response(
          JSON.stringify({ secrets: [{ secretKey: "COMPOSIO_API_KEY", secretValue: "written-value" }] }),
          { status: 200 },
        );
      }),
    );

    await infisical.writeSecret("COMPOSIO_API_KEY", "written-value");

    const patches = calls.filter((call) => call.method === "PATCH");
    expect(patches).toHaveLength(2);
    expect(patches[0]?.authorization ?? "").toContain(SENTINEL_WRITE_TOKEN);
    // The upsert that landed is the one made with the machine identity.
    expect(patches[1]?.authorization ?? "").toContain(SENTINEL_TOKEN);
    expect(patches[1]?.authorization ?? "").not.toContain(SENTINEL_WRITE_TOKEN);
    expect(loginCalls(calls)).toHaveLength(1);
    expect(infisicalSnapshot()?.get("COMPOSIO_API_KEY")).toBe("written-value");
  });

  it("does not probe the server again for a write token it already knows was refused", async () => {
    withSettings({
      token: SENTINEL_READ_TOKEN,
      writeToken: SENTINEL_WRITE_TOKEN,
      writeThrough: true,
    });
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const headers = headerBag(init);
        calls.push({
          url: String(url),
          method: init?.method ?? "GET",
          authorization: headers.authorization,
        });
        if (String(url).includes("/login")) {
          return new Response(JSON.stringify({ accessToken: SENTINEL_TOKEN }), { status: 200 });
        }
        const bearer = (headers.authorization ?? "").replace(/^Bearer /, "");
        if (init?.method === "PATCH") {
          if (bearer === SENTINEL_WRITE_TOKEN) return new Response("refused", { status: 401 });
          return new Response("{}", { status: 200 });
        }
        return new Response(
          JSON.stringify({ secrets: [{ secretKey: "COMPOSIO_API_KEY", secretValue: "written-value" }] }),
          { status: 200 },
        );
      }),
    );

    await infisical.writeSecret("COMPOSIO_API_KEY", "written-value");
    await infisical.writeSecret("COMPOSIO_API_KEY", "written-value");

    const patches = calls.filter((call) => call.method === "PATCH");
    // One refused probe, then the machine identity for both writes.
    expect(patches).toHaveLength(3);
    expect(patches.filter((call) => (call.authorization ?? "").includes(SENTINEL_WRITE_TOKEN))).toHaveLength(1);
    expect(patches[2]?.authorization ?? "").toContain(SENTINEL_TOKEN);
  });
});


describe("service token refusal: scope and visibility", () => {
  const REFUSED_TOKEN = "sentinel-refused-token-not-real";

  type RecordedCall = { url: string; authorization: string | undefined };

  /** A fetch that refuses the named bearer with `status` and answers every
   * other request with the secrets list.  The login endpoint is answered
   * with a session token when the machine identity is in play. */
  function refusingFetch(status: number, secrets: Array<{ secretKey: string; secretValue: string }> = []) {
    const calls: RecordedCall[] = [];
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = headerBag(init);
      calls.push({ url: String(url), authorization: headers.authorization });
      if (String(url).includes("/login")) {
        return new Response(JSON.stringify({ accessToken: SENTINEL_TOKEN }), { status: 200 });
      }
      const bearer = (headers.authorization ?? "").replace(/^Bearer /, "");
      if (bearer === REFUSED_TOKEN) {
        return new Response("refused", { status });
      }
      return new Response(JSON.stringify({ secrets }), { status: 200 });
    });
    return { calls, impl };
  }

  function bearerOf(call: RecordedCall): string {
    return (call.authorization ?? "").replace(/^Bearer /, "");
  }

  it("forgets a refusal when the project it was refused under changes", async () => {
    // A wrong project id answers 404 and looks exactly like a revoked
    // token.  Fixing the project id in Settings has to put the token back
    // in play, or the good token stays deprioritized for the life of the
    // process.
    const settings = { ...BASE_SETTINGS, projectId: "proj-1", clientId: "", clientSecret: "", token: REFUSED_TOKEN };
    infisical.configure(() => settings);
    const { calls, impl } = refusingFetch(404);
    vi.stubGlobal("fetch", impl);

    await infisical.refresh("manual");
    expect(calls.filter((call) => bearerOf(call) === REFUSED_TOKEN)).toHaveLength(1);

    // The same token, a different project:  the remembered refusal was
    // about a different request, so the token is tried again.
    settings.projectId = "proj-2";
    await infisical.refresh("manual");

    expect(calls.filter((call) => bearerOf(call) === REFUSED_TOKEN)).toHaveLength(2);
  });

  /** A fetch that refuses each named bearer with its own status and
   * answers every other request with the secrets list.  The login endpoint
   * is answered with a session token when the machine identity is in play. */
  function perBearerRefusingFetch(statuses: Record<string, number>) {
    const calls: RecordedCall[] = [];
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = headerBag(init);
      calls.push({ url: String(url), authorization: headers.authorization });
      if (String(url).includes("/login")) {
        return new Response(JSON.stringify({ accessToken: SENTINEL_TOKEN }), { status: 200 });
      }
      const bearer = (headers.authorization ?? "").replace(/^Bearer /, "");
      const status = statuses[bearer];
      if (status !== undefined) {
        return new Response("refused", { status });
      }
      return new Response(JSON.stringify({ secrets: [] }), { status: 200 });
    });
    return { calls, impl };
  }

  it("keeps the credential-wide refusal when scope-scoped refusals fill the cap", async () => {
    // A 401 is remembered against EVERY scope, because the bearer is refused
    // however it is used.  That entry is the one worth keeping under the
    // cap:  dropping it would let a revoked token be tried again, which is
    // the whole thing the memory exists to prevent.  Sixteen scope-scoped
    // refusals for another token must not push it out.
    const ROTATED_TOKEN = "sentinel-rotated-token-not-real";
    const settings = {
      ...BASE_SETTINGS,
      projectId: "proj-1",
      clientId: "",
      clientSecret: "",
      token: REFUSED_TOKEN,
    };
    infisical.configure(() => settings);
    const { calls, impl } = perBearerRefusingFetch({
      [REFUSED_TOKEN]: 401,
      [ROTATED_TOKEN]: 404,
    });
    vi.stubGlobal("fetch", impl);

    // One 401:  the credential-wide refusal, remembered against every scope.
    await infisical.refresh("manual");
    expect(calls.filter((call) => bearerOf(call) === REFUSED_TOKEN)).toHaveLength(1);

    // Sixteen scope-scoped refusals for the rotated token, one per scope.
    // Every one of them is a 404, so each is remembered against its own
    // scope rather than against the credential.
    settings.token = ROTATED_TOKEN;
    for (let index = 0; index < 16; index += 1) {
      settings.projectId = `proj-scoped-${index}`;
      await infisical.refresh("manual");
    }
    expect(calls.filter((call) => bearerOf(call) === ROTATED_TOKEN)).toHaveLength(16);

    // Back to the revoked token.  The credential-wide refusal survived the
    // cap, so the token is not tried again -- no request carries it.
    settings.token = REFUSED_TOKEN;
    settings.projectId = "proj-1";
    await infisical.refresh("manual");

    expect(calls.filter((call) => bearerOf(call) === REFUSED_TOKEN)).toHaveLength(1);
    expect(infisical.getStatus().readTokenRefused).toBe(true);
  });

  it("reports a refused token in the status view and in the boot line", async () => {
    // A sync that succeeds on the machine identity must not look exactly
    // like a healthy token:  the refusal is the fact the operator needs.
    withSettings({ token: REFUSED_TOKEN });
    const { impl } = refusingFetch(401, [{ secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE }]);
    vi.stubGlobal("fetch", impl);

    await infisical.refresh("manual");

    const status = infisical.getStatus();
    expect(status.readTokenRefused).toBe(true);
    expect(status.writeTokenRefused).toBe(false);
    // The token is still configured:  it was refused, not removed.
    expect(status.hasToken).toBe(true);
    expect(status.enabled).toBe(true);
    expect(infisical.bootLine()).toContain("read-token-refused");
  });

  /** A fetch that refuses the named bearer, optionally only for one
   * secret path, and answers every other request with the secrets list.
   * The login endpoint answers with a session token when the machine
   * identity is in play. */
  function scopedRefusingFetch(options: {
    status: number;
    onlyPath?: string;
    secrets?: Array<{ secretKey: string; secretValue: string }>;
  }) {
    const calls: RecordedCall[] = [];
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = headerBag(init);
      calls.push({ url: String(url), authorization: headers.authorization });
      if (String(url).includes("/login")) {
        return new Response(JSON.stringify({ accessToken: SENTINEL_TOKEN }), { status: 200 });
      }
      const bearer = (headers.authorization ?? "").replace(/^Bearer /, "");
      if (bearer === REFUSED_TOKEN) {
        const asked = new URL(String(url)).searchParams.get("secretPath") ?? "";
        if (!options.onlyPath || asked === options.onlyPath) {
          return new Response("refused", { status: options.status });
        }
      }
      return new Response(JSON.stringify({ secrets: options.secrets ?? [] }), { status: 200 });
    });
    return { calls, impl };
  }

  it("does not let one missing folder deprioritize the token for the whole vault", async () => {
    // A 404 is a refusal of the REQUEST, not of the credential:  the
    // folder the caller asked for does not exist, and the token itself is
    // still good.  Remembering that refusal against the whole vault would
    // push a working token aside for the life of the process.
    withSettings({ token: REFUSED_TOKEN });
    const { calls, impl } = scopedRefusingFetch({
      status: 404,
      onlyPath: "/missing",
      secrets: [{ secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE }],
    });
    vi.stubGlobal("fetch", impl);

    const values = await infisical.readPath("/missing");
    expect(values.get("COMPOSIO_API_KEY")).toBe(SENTINEL_VAULT_VALUE);

    const refreshed = await infisical.refresh("manual");
    expect(refreshed.lastError).toBeNull();

    // The refresh reads the vault's own scope, where the token was never
    // refused, so the token is used again.
    const lists = calls.filter((call) => !call.url.includes("/login"));
    expect(bearerOf(lists.at(-1)!)).toBe(REFUSED_TOKEN);
    expect(infisical.getStatus().readTokenRefused).toBe(false);
  });

  it("does not let one 403 deprioritize the token for the whole vault", async () => {
    // A 403 is a refusal of the REQUEST the same way a 404 is:  the grant
    // does not cover what was asked for, and the token itself is still good.
    // Remembering it against the whole vault would push a working token
    // aside for the life of the process.
    withSettings({ token: REFUSED_TOKEN });
    const { calls, impl } = scopedRefusingFetch({
      status: 403,
      onlyPath: "/zulip",
      secrets: [{ secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE }],
    });
    vi.stubGlobal("fetch", impl);

    const values = await infisical.readPath("/zulip");
    expect(values.get("COMPOSIO_API_KEY")).toBe(SENTINEL_VAULT_VALUE);

    const refreshed = await infisical.refresh("manual");
    expect(refreshed.lastError).toBeNull();

    // The refresh reads the vault's own scope, where the token was never
    // refused, so the token is used again.
    const lists = calls.filter((call) => !call.url.includes("/login"));
    expect(bearerOf(lists.at(-1)!)).toBe(REFUSED_TOKEN);
    expect(infisical.getStatus().readTokenRefused).toBe(false);
  });

  it("names a refused token on the boot line even when the sync failed", async () => {
    // The case that matters most is a refused token with no machine identity
    // to fall back to:  the sync errored, so the boot line reports the
    // error, and it has to name the refusal as well or the operator cannot
    // tell a revoked token from a broken vault.
    withSettings({ clientId: "", clientSecret: "", token: REFUSED_TOKEN });
    const { impl } = scopedRefusingFetch({
      status: 401,
      secrets: [{ secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE }],
    });
    vi.stubGlobal("fetch", impl);

    await infisical.refresh("manual");

    const line = infisical.bootLine();
    expect(line).toContain("unavailable");
    expect(line).toContain("read-token-refused");
  });

  it("deprioritizes a revoked token everywhere, not only where it was refused", async () => {
    // A 401 is a refusal of the CREDENTIAL:  the bearer itself was
    // rejected, so it is rejected however it is used.  The next refresh
    // must not try it again.
    withSettings({ token: REFUSED_TOKEN });
    const { calls, impl } = scopedRefusingFetch({
      status: 401,
      secrets: [{ secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE }],
    });
    vi.stubGlobal("fetch", impl);

    const values = await infisical.readPath("/zulip");
    expect(values.get("COMPOSIO_API_KEY")).toBe(SENTINEL_VAULT_VALUE);

    const refreshed = await infisical.refresh("manual");
    expect(refreshed.lastError).toBeNull();

    const lists = calls.filter((call) => !call.url.includes("/login"));
    expect(lists.at(-1)?.authorization ?? "").not.toContain(REFUSED_TOKEN);
    expect(infisical.getStatus().readTokenRefused).toBe(true);
  });

  it("reports no refusal for a token the server never refused", async () => {
    withSettings({ token: REFUSED_TOKEN });
    const { impl } = refusingFetch(200, [{ secretKey: "COMPOSIO_API_KEY", secretValue: SENTINEL_VAULT_VALUE }]);
    vi.stubGlobal("fetch", impl);

    await infisical.refresh("manual");

    const status = infisical.getStatus();
    expect(status.readTokenRefused).toBe(false);
    expect(status.writeTokenRefused).toBe(false);
    expect(infisical.bootLine()).not.toContain("token-refused");
  });
});
