import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InfisicalSettings } from "./config.ts";
import { infisical } from "./infisical.ts";
import { infisicalSnapshot, setInfisicalSnapshot, vaultNames } from "./secret-map.ts";

// Obviously fake, and never sent anywhere real: these exist so the
// assertions below have credential-shaped strings to look for. Every test
// that could plausibly leak one asserts it is absent from what came back.
const SENTINEL_CLIENT_SECRET = "sentinel-client-secret-not-real";
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
  refreshMinutes: 15,
};

function withSettings(overrides: Partial<InfisicalSettings>): InfisicalSettings {
  const merged: InfisicalSettings = { ...BASE_SETTINGS, ...overrides };
  infisical.configure(() => merged);
  return merged;
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
