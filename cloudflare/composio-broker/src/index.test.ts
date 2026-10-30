import { afterEach, describe, expect, it, vi } from "vitest";

import worker, {
  authorize,
  connectedServices,
  connectionStatus,
  createSession,
  disconnectAccount,
  ensureSession,
  normalizeAccountAlias,
  parseSession,
  requestAlias,
  sha256,
} from "./index";

const multiAccount = {
  enable: true,
  max_accounts_per_toolkit: 5,
  require_explicit_selection: true,
};

function session(id: string, userId: string, configured = true) {
  return {
    session_id: id,
    mcp: { url: `https://mcp.composio.dev/${id}` },
    config: { user_id: userId, ...(configured ? { multi_account: multiAccount } : {}) },
  };
}

function testEnv(
  fetchCalls: Array<{ url: string; init?: RequestInit }>,
  initialInstallation?: { id: string; composio_user_id: string; session_id: string | null; disabled_at: number | null; session_upgrade_attempted?: number | null; last_seen_at?: number },
) {
  const dbRuns: Array<{ sql: string; values: unknown[] }> = [];
  let installation = initialInstallation ? { ...initialInstallation } : null;
  let beforeRun: ((sql: string, values: unknown[]) => void) | undefined;
  const env = {
    COMPOSIO_API_BASE: "https://backend.composio.dev/api/v3.1",
    COMPOSIO_API_KEY: "ak_test",
    SESSION_LIMITER: { limit: async () => ({ success: true }) },
    DB: {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              run: async () => {
                dbRuns.push({ sql, values });
                beforeRun?.(sql, values);
                if (sql.includes("UPDATE installations SET session_id")) {
                  const [sessionId, lastSeenAt, id, userId, previousSessionId] = values;
                  if (installation && installation.id === id && installation.composio_user_id === userId && installation.disabled_at === null && installation.session_id === previousSessionId) {
                    installation.session_id = String(sessionId);
                    installation.session_upgrade_attempted = 1;
                    return { success: true, meta: { changes: 1 } };
                  }
                  return { success: true, meta: { changes: 0 } };
                }
                if (sql.includes("UPDATE installations SET last_seen_at")) {
                  const [, id, userId, sessionId] = values;
                  const matched = Boolean(installation && installation.id === id && installation.composio_user_id === userId && installation.disabled_at === null && installation.session_id === sessionId);
                  if (matched && installation) installation.last_seen_at = Number(values[0]);
                  return { success: true, meta: { changes: matched ? 1 : 0 } };
                }
                return { success: true, meta: { changes: 1 } };
              },
              first: async () => {
                dbRuns.push({ sql, values });
                return installation ? { ...installation } : null;
              },
            };
          },
        };
      },
    },
  };
  const ctx = { waitUntil(promise: Promise<unknown>) { void promise; } };
  return {
    env,
    ctx,
    dbRuns,
    fetchCalls,
    setInstallation(row: typeof installation) { installation = row ? { ...row } : null; },
    setBeforeRun(hook: typeof beforeRun) { beforeRun = hook; },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("connected-apps broker boundaries", () => {
  it("accepts an empty authorize body as a first-account request", async () => {
    await expect(requestAlias(new Request("https://broker.test/v1/connectors/gmail/authorize", {
      method: "POST",
      body: "",
    }))).resolves.toBeUndefined();
    await expect(requestAlias(new Request("https://broker.test/v1/connectors/gmail/authorize", {
      method: "POST",
      body: "  \n",
    }))).resolves.toBeUndefined();
  });

  it("accepts only HTTPS Composio MCP endpoints", () => {
    expect(parseSession({
      session_id: "session-1",
      mcp: { url: "https://mcp.composio.dev/session", headers: { "x-session": "one", host: "bad" } },
    })).toEqual({
      sessionId: "session-1",
      url: "https://mcp.composio.dev/session",
      headers: { "x-session": "one" },
      userId: undefined,
      multiAccountConfigured: false,
    });
    expect(() => parseSession({ session_id: "session-1", mcp: { url: "https://attacker.example/mcp" } })).toThrow(/untrusted/i);
    expect(() => parseSession({ session_id: "session-1", mcp: { url: "http://mcp.composio.dev/session" } })).toThrow(/untrusted/i);
  });

  it("hashes installation tokens before storage", async () => {
    await expect(sha256("botfleet")).resolves.toBe("bec3e3852322168415c2d67feef2589289ddbc255e49902be8301cdef0eda07d");
  });

  it("creates Sessions with explicit multi-account selection", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { env } = testEnv(fetchCalls);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init });
      return Response.json(session("trs_new", "omb_user"), { status: 201 });
    });

    await expect(createSession(env as never, "omb_user")).resolves.toMatchObject({
      sessionId: "trs_new",
      multiAccountConfigured: true,
    });
    expect(JSON.parse(String(fetchCalls[0].init?.body))).toMatchObject({
      user_id: "omb_user",
      multi_account: multiAccount,
    });
  });

  it("rejects a newly created Session explicitly assigned to another user", async () => {
    const { env } = testEnv([]);
    vi.stubGlobal("fetch", async () => Response.json(session("trs_wrong", "omb_other"), { status: 201 }));

    await expect(createSession(env as never, "omb_expected")).rejects.toThrow(/another user/i);
  });

  it("binds a created Session to the requested user when Composio omits user_id", async () => {
    const { env } = testEnv([]);
    vi.stubGlobal("fetch", async () => Response.json({
      session_id: "trs_user_omitted",
      mcp: { url: "https://mcp.composio.dev/trs_user_omitted" },
      config: { multi_account: multiAccount },
    }, { status: 201 }));

    await expect(createSession(env as never, "omb_expected")).resolves.toMatchObject({
      sessionId: "trs_user_omitted",
      userId: "omb_expected",
    });
  });

  it("replaces a cached Session belonging to a different stable user", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const { env, ctx } = testEnv(calls, {
      id: "install-1",
      composio_user_id: "omb_expected",
      session_id: "trs_wrong_owner",
      disabled_at: null,
    });
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (init?.method === "POST") return Response.json(session("trs_replacement", "omb_expected"), { status: 201 });
      return Response.json(session("trs_wrong_owner", "omb_other"));
    });

    await expect(ensureSession({
      id: "install-1",
      composio_user_id: "omb_expected",
      session_id: "trs_wrong_owner",
      disabled_at: null,
    }, env as never, ctx as never)).resolves.toMatchObject({ sessionId: "trs_replacement", userId: "omb_expected" });
    expect(calls.some((call) => call.init?.method === "POST")).toBe(true);
  });

  it("re-reads installation ownership after Session lookup before reusing the cache", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const { env, ctx, setInstallation } = testEnv(calls, {
      id: "install-1",
      composio_user_id: "omb_first",
      session_id: "trs_cached",
      disabled_at: null,
    });
    let lookupCount = 0;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (init?.method === "POST") return Response.json(session("trs_second_user", "omb_second"), { status: 201 });
      lookupCount += 1;
      if (lookupCount === 1) {
        setInstallation({ id: "install-1", composio_user_id: "omb_second", session_id: "trs_cached", disabled_at: null });
      }
      return Response.json(session("trs_cached", "omb_first"));
    });

    await expect(ensureSession({
      id: "install-1",
      composio_user_id: "omb_first",
      session_id: "trs_cached",
      disabled_at: null,
    }, env as never, ctx as never)).resolves.toMatchObject({ sessionId: "trs_second_user", userId: "omb_second" });
    expect(lookupCount).toBeGreaterThanOrEqual(2);
    expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(1);
  });

  it("does not reuse a concurrent winner Session owned by another user", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const { env, ctx, setBeforeRun, setInstallation } = testEnv(calls, {
      id: "install-1",
      composio_user_id: "omb_expected",
      session_id: null,
      disabled_at: null,
    });
    let raced = false;
    setBeforeRun((sql) => {
      if (!raced && sql.includes("UPDATE installations SET session_id")) {
        raced = true;
        // Simulate another writer winning the compare-and-swap with a foreign Session.
        setInstallation({ id: "install-1", composio_user_id: "omb_expected", session_id: "trs_foreign_winner", disabled_at: null });
      }
    });
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/trs_foreign_winner")) return Response.json(session("trs_foreign_winner", "omb_other"));
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { user_id: string };
        const id = calls.filter((call) => call.init?.method === "POST").length === 1 ? "trs_first_attempt" : "trs_owned_replacement";
        return Response.json(session(id, body.user_id), { status: 201 });
      }
      return Response.json(session("trs_foreign_winner", "omb_other"));
    });

    await expect(ensureSession({
      id: "install-1",
      composio_user_id: "omb_expected",
      session_id: null,
      disabled_at: null,
    }, env as never, ctx as never)).resolves.toMatchObject({ sessionId: "trs_owned_replacement", userId: "omb_expected" });
    expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(2);
  });

  it("fails closed after three consecutive installation identity changes", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const { env, ctx, setInstallation } = testEnv(calls, {
      id: "install-1",
      composio_user_id: "omb_user_0",
      session_id: null,
      disabled_at: null,
    });
    let changes = 0;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { user_id: string };
        changes += 1;
        setInstallation({ id: "install-1", composio_user_id: `omb_user_${changes}`, session_id: null, disabled_at: null });
        return Response.json(session(`trs_churn_${changes}`, body.user_id), { status: 201 });
      }
      throw new Error(`unexpected session lookup ${url}`);
    });

    await expect(ensureSession({
      id: "install-1",
      composio_user_id: "omb_user_0",
      session_id: null,
      disabled_at: null,
    }, env as never, ctx as never)).rejects.toMatchObject({ status: 503 });
    expect(changes).toBe(3);
  });

  it("fails closed when the active-installation marker is missing", async () => {
    const { env, ctx } = testEnv([]);
    await expect(ensureSession({
      id: "install-1",
      composio_user_id: "omb_user",
      session_id: null,
    } as never, env as never, ctx as never)).rejects.toMatchObject({ status: 401 });
  });

  it("upgrades a legacy Session without changing the installation's Composio user", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { env, ctx, dbRuns } = testEnv(fetchCalls, {
      id: "install-1",
      composio_user_id: "omb_stable",
      session_id: "trs_legacy",
      disabled_at: null,
    });
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (init?.method === "POST") return Response.json(session("trs_new", "omb_stable"), { status: 201 });
      return Response.json(session("trs_legacy", "omb_stable", false));
    });

    await expect(ensureSession({
      id: "install-1",
      composio_user_id: "omb_stable",
      session_id: "trs_legacy",
      disabled_at: null,
    }, env as never, ctx as never)).resolves.toMatchObject({ sessionId: "trs_new", multiAccountConfigured: true });
    const creation = fetchCalls.find((call) => call.init?.method === "POST");
    expect(JSON.parse(String(creation?.init?.body))).toMatchObject({ user_id: "omb_stable", multi_account: multiAccount });
    const save = dbRuns.find((run) => run.sql.includes("UPDATE installations SET session_id"));
    expect(save?.values[0]).toBe("trs_new");
    expect(save?.values[2]).toBe("install-1");
    expect(save?.values[3]).toBe("omb_stable");
    expect(save?.values[4]).toBe("trs_legacy");
    expect(save?.sql).toContain("composio_user_id = ? AND disabled_at IS NULL AND session_id IS ?");
  });

  it("returns every account and deletes only an owned account ID", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { env, ctx } = testEnv(fetchCalls, {
      id: "install-1",
      composio_user_id: "omb_stable",
      session_id: "trs_multi",
      disabled_at: null,
      session_upgrade_attempted: 1,
    });
    const accounts = {
      items: [
        { id: "ca_work", alias: "work", toolkit: { slug: "gmail" }, status: "ACTIVE", updated_at: "2026-08-21T10:00:00Z" },
        { id: "ca_personal", alias: "personal", toolkit: { slug: "gmail" }, status: "INITIALIZING", updated_at: "2026-08-21T11:00:00Z" },
      ],
      next_cursor: "accounts-page-2",
    };
    let connectedAccountsUnavailable = false;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.includes("/tool_router/session/trs_multi/toolkits")) {
        const query = new URL(url).searchParams;
        if (query.get("cursor") === "toolkits-page-2") {
          return Response.json({
            items: [
              { slug: "publicsearch", is_no_auth: true },
              { slug: "selectedonly", connected_account: { id: "ca_session_only", status: "ACTIVE" } },
            ],
          });
        }
        const body = {
          items: [
            { slug: "gmail", connected_account: { id: "ca_work", status: "ACTIVE" } },
            { slug: "unconnected", connected_account: null },
          ],
          next_cursor: query.has("toolkits") ? undefined : "toolkits-page-2",
        };
        return Response.json(body);
      }
      if (url.endsWith("/tool_router/session/trs_multi/link") && init?.method === "POST") {
        return Response.json({ redirect_url: "https://connect.composio.dev/link/gmail" }, { status: 201 });
      }
      if (url.includes("/tool_router/session/trs_multi")) return Response.json(session("trs_multi", "omb_stable"));
      if (url.includes("/connected_accounts?") && !init?.method) {
        if (connectedAccountsUnavailable) {
          return Response.json({ error: "connected-account read not granted" }, { status: 403 });
        }
        if (url.includes("cursor=accounts-page-2")) {
          return Response.json({
            items: [
              { id: "ca_toolkit_41", alias: "overflow", toolkit: { slug: "toolkit_41" }, status: "ACTIVE", updated_at: "2026-08-21T12:00:00Z" },
            ],
          });
        }
        return Response.json(accounts);
      }
      if (url.includes("/connected_accounts/ca_work") && init?.method === "DELETE") return Response.json({ success: true });
      return Response.json({ error: "not found" }, { status: 404 });
    });
    const installation = {
      id: "install-1",
      composio_user_id: "omb_stable",
      session_id: "trs_multi",
      disabled_at: null,
    };

    const statusResponse = await connectionStatus(
      new URL("https://broker.example/v1/connectors?services=gmail"),
      installation,
      env as never,
      ctx as never,
    );
    await expect(statusResponse.json()).resolves.toEqual({
      services: {
        gmail: {
          connected: true,
          pending: true,
          status: "ACTIVE",
          accounts: [
            { id: "ca_personal", alias: "personal", status: "INITIALIZING" },
            { id: "ca_work", alias: "work", status: "ACTIVE" },
          ],
        },
      },
    });
    const connectedResponse = await connectedServices(installation, env as never, ctx as never);
    await expect(connectedResponse.json()).resolves.toMatchObject({
      configured: true,
      services: {
        toolkit_41: {
          connected: true,
          pending: false,
          status: "ACTIVE",
          accounts: [{ id: "ca_toolkit_41", alias: "overflow", status: "ACTIVE" }],
        },
        publicsearch: {
          connected: true,
          pending: false,
          status: "ACTIVE",
          accounts: [],
        },
        selectedonly: {
          connected: true,
          pending: false,
          status: "ACTIVE",
          accounts: [{ id: "ca_session_only", status: "ACTIVE" }],
        },
      },
    });
    const inventoryCall = fetchCalls.find((call) =>
      call.url.includes("/connected_accounts?") && !call.url.includes("toolkit_slugs=")
    );
    expect(inventoryCall).toBeDefined();
    expect(fetchCalls.some((call) =>
      call.url.includes("/connected_accounts?")
        && !call.url.includes("toolkit_slugs=")
        && call.url.includes("cursor=accounts-page-2")
    )).toBe(true);
    expect(fetchCalls.some((call) =>
      call.url.includes("/tool_router/session/trs_multi/toolkits?")
        && !call.url.includes("toolkits=")
        && call.url.includes("is_connected=true")
        && call.url.includes("cursor=toolkits-page-2")
    )).toBe(true);

    connectedAccountsUnavailable = true;
    const fallbackResponse = await connectedServices(installation, env as never, ctx as never);
    await expect(fallbackResponse.json()).resolves.toMatchObject({
      configured: true,
      services: {
        gmail: {
          connected: true,
          status: "ACTIVE",
          accounts: [{ id: "ca_work", status: "ACTIVE" }],
        },
        publicsearch: { connected: true, status: "ACTIVE", accounts: [] },
        selectedonly: {
          connected: true,
          status: "ACTIVE",
          accounts: [{ id: "ca_session_only", status: "ACTIVE" }],
        },
      },
    });
    connectedAccountsUnavailable = false;
    await expect((await disconnectAccount("gmail", "ca_work", installation, env as never, ctx as never)).json())
      .resolves.toEqual({ removed: 1 });
    await expect((await disconnectAccount("gmail", "ca_not_owned", installation, env as never, ctx as never)).json())
      .resolves.toEqual({ removed: 0 });
    expect(fetchCalls.filter((call) => call.init?.method === "DELETE")).toHaveLength(1);

    const missingAlias = await authorize("gmail", undefined, installation, env as never, ctx as never);
    expect(missingAlias.status).toBe(400);
    await expect(missingAlias.json()).resolves.toEqual({
      error: "Add an account alias so the existing connection is not replaced",
    });
    const authorized = await authorize("gmail", "second", installation, env as never, ctx as never);
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toEqual({ url: "https://connect.composio.dev/link/gmail" });
    const linkCall = fetchCalls.find((call) => call.url.endsWith("/tool_router/session/trs_multi/link"));
    expect(JSON.parse(String(linkCall?.init?.body))).toEqual({ toolkit: "gmail", alias: "second" });
  });

  it("validates aliases at the broker boundary", () => {
    expect(normalizeAccountAlias("  work gmail  ")).toBe("work gmail");
    expect(() => normalizeAccountAlias("bad\nalias")).toThrow(/printable/i);
  });

  it("does not recreate a Session after D1 records the upgrade attempt", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { env, ctx, dbRuns } = testEnv(fetchCalls, {
      id: "install-1",
      composio_user_id: "omb_stable",
      session_id: "trs_legacy",
      disabled_at: null,
      session_upgrade_attempted: 1,
    });
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init });
      return Response.json(session("trs_legacy", "omb_stable", false));
    });

    await expect(ensureSession({
      id: "install-1",
      composio_user_id: "omb_stable",
      session_id: "trs_legacy",
      disabled_at: null,
      session_upgrade_attempted: 1,
    }, env as never, ctx as never)).resolves.toMatchObject({ sessionId: "trs_legacy", multiAccountConfigured: false });
    expect(fetchCalls.some((call) => call.init?.method === "POST")).toBe(false);
    expect(dbRuns.some((run) => run.sql.includes("UPDATE installations SET last_seen_at")
      && run.sql.includes("composio_user_id = ? AND disabled_at IS NULL AND session_id IS ?"))).toBe(true);
  });

  it("rejects new installations when REGISTRATION_MODE is closed", async () => {
    const { env, ctx } = testEnv([]);
    const closedEnv = {
      ...env,
      REGISTRATION_MODE: "closed",
      REGISTRATION_LIMITER: { limit: async () => ({ success: true }) },
    };
    const response = await worker.fetch(
      new Request("https://broker.test/v1/installations", { method: "POST" }),
      closedEnv as never,
      ctx as never,
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "registration is temporarily closed" });
  });
});
