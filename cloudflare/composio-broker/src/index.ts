import { z } from "zod";

interface InstallationRow {
  id: string;
  composio_user_id: string;
  session_id: string | null;
  disabled_at: number | null;
  session_upgrade_attempted?: number | null;
}

interface ComposioSession {
  sessionId: string;
  url: string;
  headers: Record<string, string>;
  userId?: string;
  multiAccountConfigured: boolean;
}

interface ConnectedAccountSummary {
  id: string;
  alias?: string;
  status: string;
}

interface ConnectorServiceState {
  connected: boolean;
  pending: boolean;
  status: string;
  accounts: ConnectedAccountSummary[];
}

interface AccountLinkRequest {
  toolkit: string;
  alias?: string;
}

const sessionWireSchema = z.object({
  session_id: z.string().min(1),
  mcp: z.object({
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  config: z.object({
    user_id: z.string().optional(),
    multi_account: z.object({
      enable: z.boolean().optional(),
      max_accounts_per_toolkit: z.number().optional(),
      require_explicit_selection: z.boolean().optional(),
    }).optional(),
  }).optional(),
});
type SessionWire = z.infer<typeof sessionWireSchema>;

const connectedAccountResponseSchema = z.object({
  id: z.string().optional(),
  alias: z.string().nullable().optional(),
  status: z.string().optional(),
  updated_at: z.string().optional(),
  toolkit: z.object({ slug: z.string().optional() }).optional(),
});
type ConnectedAccountResponse = z.infer<typeof connectedAccountResponseSchema>;
const connectedAccountsPageSchema = z.object({
  items: z.array(connectedAccountResponseSchema),
  next_cursor: z.string().nullable().optional(),
});

const toolkitItemSchema = z.object({
  slug: z.string().optional(),
  is_no_auth: z.boolean().optional(),
  connected_account: z.object({ id: z.string().optional(), status: z.string().optional() }).nullable().optional(),
});
type ToolkitItem = z.infer<typeof toolkitItemSchema>;
const toolkitPageSchema = z.object({
  items: z.array(toolkitItemSchema).optional(),
  next_cursor: z.string().nullable().optional(),
});
const linkResponseSchema = z.object({ redirect_url: z.string().optional() });
const aliasRequestSchema = z.object({ alias: z.string().nullable().optional() });
const upstreamErrorSchema = z.object({
  message: z.string().optional(),
  error: z.union([
    z.string(),
    z.object({ message: z.string().optional(), error: z.string().optional() }),
  ]).optional(),
});

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const MAX_MCP_BODY = 2 * 1024 * 1024;
const MULTI_ACCOUNT_CONFIG = {
  enable: true,
  max_accounts_per_toolkit: 5,
  require_explicit_selection: true,
} as const;
// Workers on the free plan get 50 subrequests per request, and the connected
// inventory runs two paginated sweeps back to back — 20 pages each keeps the
// worst case at ~40 fetches with headroom for the session lookup. At 100
// accounts per page nobody real is near the ceiling.
const MAX_CONNECTED_ACCOUNT_PAGES = 20;
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const printableAliasSchema = z.string().min(1).max(64).refine((value) => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 32 || codePoint === 127) return false;
  }
  return true;
});

type JsonValue = null | undefined | boolean | number | string | ConnectedAccountSummary | ConnectorServiceState | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

function json(value: JsonValue, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function normalizeAccountAlias(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = z.string().safeParse(value);
  if (!parsed.success) throw new Error("Account alias must be text");
  const alias = parsed.data.trim();
  if (!printableAliasSchema.safeParse(alias).success) {
    throw new Error("Account alias must be 1-64 printable characters");
  }
  return alias;
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseSession(value: SessionWire): ComposioSession {
  const url = new URL(value.mcp.url);
  if (url.protocol !== "https:" || (url.hostname !== "composio.dev" && !url.hostname.endsWith(".composio.dev"))) {
    throw new Error("Composio returned an untrusted MCP URL");
  }
  const headers: Record<string, string> = {};
  if (value.mcp.headers) {
    for (const [name, header] of Object.entries(value.mcp.headers)) {
      if (/^(host|cookie|content-length)$/i.test(name)) continue;
      headers[name] = header;
    }
  }
  const config = value.config;
  const multi = config?.multi_account;
  return {
    sessionId: value.session_id,
    url: url.toString(),
    headers,
    userId: config?.user_id,
    // Only `enable` gates reuse: the cap and selection flags are requested at
    // creation, and recreating a Session would post the same config and get
    // the same echo back — strict equality here can only churn, never fix.
    multiAccountConfigured: multi?.enable === true,
  };
}

async function upstreamError(response: Response, fallback: string) {
  const text = await response.text().catch(() => "");
  try {
    const body = upstreamErrorSchema.parse(JSON.parse(text));
    const nested = body.error instanceof Object ? body.error.message ?? body.error.error : body.error;
    return String(body.message ?? nested ?? fallback).slice(0, 240);
  } catch {
    return text.trim().slice(0, 240) || fallback;
  }
}

function composioRequest(env: Env, path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  headers.set("x-api-key", env.COMPOSIO_API_KEY);
  if (init?.body) headers.set("content-type", "application/json");
  return fetch(`${env.COMPOSIO_API_BASE}${path}`, {
    ...init,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });
}

async function getSession(env: Env, sessionId: string) {
  const response = await composioRequest(env, `/tool_router/session/${encodeURIComponent(sessionId)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await upstreamError(response, `Session lookup failed (${response.status})`));
  return parseSession(sessionWireSchema.parse(await response.json()));
}

async function createSession(env: Env, userId: string) {
  const response = await composioRequest(env, "/tool_router/session", {
    method: "POST",
    body: JSON.stringify({
      user_id: userId,
      manage_connections: {
        enable: true,
        enable_wait_for_connections: true,
        enable_connection_removal: true,
      },
      multi_account: MULTI_ACCOUNT_CONFIG,
    }),
  });
  if (!response.ok) throw new Error(await upstreamError(response, `Session creation failed (${response.status})`));
  const session = parseSession(sessionWireSchema.parse(await response.json()));
  if (session.userId && session.userId !== userId) {
    throw new Error("Composio returned a Session for another user");
  }
  return { ...session, userId };
}

/** Same-isolate cache for Session upgrade attempts.  Durable copy is D1
 *  `installations.session_upgrade_attempted` so a cold isolate does not
 *  recreate Sessions forever when Composio still withholds multi-account. */
const multiAccountUpgradeAttempted = new Set<string>();

function sessionUpgradeAttempted(installation: InstallationRow, session: ComposioSession | null) {
  if (Number(installation.session_upgrade_attempted) === 1) return true;
  return Boolean(session && multiAccountUpgradeAttempted.has(session.sessionId));
}

async function ensureSession(installation: InstallationRow, env: Env, ctx: ExecutionContext) {
  if (!(await env.SESSION_LIMITER.limit({ key: installation.id })).success) {
    throw new Response(JSON.stringify({ error: "too many connected-app requests" }), { status: 429, headers: JSON_HEADERS });
  }
  const readCurrent = async () => {
    const row = await env.DB.prepare(
      "SELECT id, composio_user_id, session_id, disabled_at, session_upgrade_attempted FROM installations WHERE id = ?",
    ).bind(installation.id).first<InstallationRow>();
    if (!row || row.id !== installation.id || row.disabled_at !== null || !row.composio_user_id) {
      throw new Response(JSON.stringify({ error: "installation is unavailable" }), { status: 401, headers: JSON_HEADERS });
    }
    return row;
  };
  const touchLastSeen = (row: InstallationRow) => {
    ctx.waitUntil(
      env.DB.prepare(
        "UPDATE installations SET last_seen_at = ? WHERE id = ? AND composio_user_id = ? AND disabled_at IS NULL AND session_id IS ?",
      ).bind(Date.now(), row.id, row.composio_user_id, row.session_id)
        .run()
        .catch((error: Error) => console.error(JSON.stringify({ message: "last-seen update failed", id: row.id, error: error.message }))),
    );
  };
  const sameSnapshot = (left: InstallationRow, right: InstallationRow) =>
    left.composio_user_id === right.composio_user_id && left.session_id === right.session_id;
  let current = installation;
  const adoptCurrent = (row: InstallationRow) => {
    current = row;
    installation.composio_user_id = row.composio_user_id;
    installation.session_id = row.session_id;
    installation.session_upgrade_attempted = row.session_upgrade_attempted;
  };
  const unavailable = () => new Response(JSON.stringify({ error: "installation changed during session setup" }), { status: 503, headers: JSON_HEADERS });

  if (installation.disabled_at !== null || !installation.composio_user_id) {
    throw new Response(JSON.stringify({ error: "installation is unavailable" }), { status: 401, headers: JSON_HEADERS });
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const expectedUserId = current.composio_user_id;
    const previousSessionId = current.session_id;
    const cached = previousSessionId ? await getSession(env, previousSessionId) : null;
    const afterLookup = await readCurrent();
    if (!sameSnapshot(current, afterLookup)) {
      adoptCurrent(afterLookup);
      continue;
    }
    if (cached?.userId === expectedUserId && (cached.multiAccountConfigured || sessionUpgradeAttempted(current, cached))) {
      touchLastSeen(current);
      return cached;
    }

    // Create a replacement when the cached Session is absent, legacy, or belongs to another user.
    const created = await createSession(env, expectedUserId);
    const afterCreate = await readCurrent();
    if (afterCreate.composio_user_id !== expectedUserId) {
      adoptCurrent(afterCreate);
      continue;
    }
    if (afterCreate.session_id !== previousSessionId) {
      adoptCurrent(afterCreate);
      if (!current.session_id) continue;
      const winner = await getSession(env, current.session_id);
      const afterWinnerLookup = await readCurrent();
      if (!sameSnapshot(current, afterWinnerLookup)) {
        adoptCurrent(afterWinnerLookup);
        continue;
      }
      if (winner?.userId === expectedUserId) {
        touchLastSeen(current);
        return winner;
      }
      continue;
    }

    const saved = await env.DB.prepare(
      "UPDATE installations SET session_id = ?, last_seen_at = ?, session_upgrade_attempted = 1 WHERE id = ? AND composio_user_id = ? AND disabled_at IS NULL AND session_id IS ?",
    ).bind(created.sessionId, Date.now(), installation.id, expectedUserId, previousSessionId).run();
    const afterSave = await readCurrent();
    if (afterSave.composio_user_id !== expectedUserId) {
      adoptCurrent(afterSave);
      continue;
    }
    if ((saved.meta?.changes ?? 0) > 0 && afterSave.session_id === created.sessionId) {
      installation.session_id = created.sessionId;
      installation.session_upgrade_attempted = 1;
      multiAccountUpgradeAttempted.add(created.sessionId);
      return created;
    }
    adoptCurrent(afterSave);
    if (current.session_id && current.session_id !== previousSessionId) {
      const winner = await getSession(env, current.session_id);
      const afterWinnerLookup = await readCurrent();
      if (!sameSnapshot(current, afterWinnerLookup)) {
        adoptCurrent(afterWinnerLookup);
        continue;
      }
      if (winner?.userId === expectedUserId) {
        touchLastSeen(current);
        return winner;
      }
    }
  }
  throw unavailable();
}

async function authenticate(request: Request, env: Env) {
  const token = request.headers.get("authorization")?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT id, composio_user_id, session_id, disabled_at, session_upgrade_attempted FROM installations WHERE token_hash = ?",
  ).bind(await sha256(token)).first<InstallationRow>();
  return row && row.disabled_at === null ? row : null;
}

async function register(request: Request, env: Env) {
  if (String(env.REGISTRATION_MODE) !== "open") return json({ error: "registration is temporarily closed" }, 503);
  const fingerprint = `${request.headers.get("cf-connecting-ip") ?? "unknown"}|${request.headers.get("user-agent") ?? "unknown"}`;
  if (!(await env.REGISTRATION_LIMITER.limit({ key: await sha256(fingerprint.slice(0, 512)) })).success) {
    return json({ error: "too many registration attempts" }, 429);
  }
  const installationId = crypto.randomUUID();
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO installations (id, token_hash, composio_user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(installationId, await sha256(token), `omb_${installationId.replaceAll("-", "")}`, now, now).run();
  console.log(JSON.stringify({ message: "installation registered", installationId }));
  return json({ installationId, token }, 201);
}

async function proxyMcp(request: Request, installation: InstallationRow, env: Env, ctx: ExecutionContext) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_MCP_BODY) return json({ error: "MCP request is too large" }, 413);
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_MCP_BODY) return json({ error: "MCP request is too large" }, 413);
  const session = await ensureSession(installation, env, ctx);
  const upstreamHeaders = new Headers(session.headers);
  upstreamHeaders.set("x-api-key", env.COMPOSIO_API_KEY);
  upstreamHeaders.set("content-type", request.headers.get("content-type") ?? "application/json");
  upstreamHeaders.set("accept", "application/json, text/event-stream");
  const incomingMcpSession = request.headers.get("mcp-session-id");
  if (incomingMcpSession) upstreamHeaders.set("mcp-session-id", incomingMcpSession);
  const response = await fetch(session.url, {
    method: "POST",
    headers: upstreamHeaders,
    body,
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const headers = new Headers({
    "content-type": response.headers.get("content-type") ?? "application/json",
    "cache-control": "no-store",
  });
  const mcpSession = response.headers.get("mcp-session-id");
  if (mcpSession) headers.set("mcp-session-id", mcpSession);
  return new Response(response.body, { status: response.status, headers });
}

async function catalog(env: Env) {
  const response = await fetch(`${env.COMPOSIO_TOOLKIT_BASE}/toolkits?limit=500&sort_by=usage`, {
    headers: { accept: "application/json", "x-api-key": env.COMPOSIO_API_KEY },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return json({ error: await upstreamError(response, "Catalog unavailable") }, 502);
  return new Response(response.body, {
    headers: { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "private, max-age=600" },
  });
}

async function listConnectedAccounts(env: Env, userId: string, slugs: string[]) {
  const accounts: ConnectedAccountResponse[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CONNECTED_ACCOUNT_PAGES; page += 1) {
    const params = new URLSearchParams({
      limit: "50",
      user_ids: userId,
      order_by: "updated_at",
      order_direction: "desc",
    });
    if (slugs.length) params.set("toolkit_slugs", slugs.join(","));
    if (cursor) params.set("cursor", cursor);
    const response = await composioRequest(env, `/connected_accounts?${params}`);
    if (!response.ok) throw new Error(await upstreamError(response, `Account lookup failed (${response.status})`));
    const body = connectedAccountsPageSchema.parse(await response.json());
    accounts.push(...body.items);
    const next = body.next_cursor || undefined;
    if (!next || seenCursors.has(next)) return accounts;
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error("Connected-account inventory exceeded the pagination safety limit");
}

async function listSessionToolkits(
  env: Env,
  sessionId: string,
): Promise<ToolkitItem[]> {
  const toolkits: ToolkitItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CONNECTED_ACCOUNT_PAGES; page += 1) {
    // Avoid walking the full marketplace just to render the Connected tab.
    // Composio supports a server-side connected-only filter on this route.
    const params = new URLSearchParams({ limit: "50", is_connected: "true" });
    if (cursor) params.set("cursor", cursor);
    const response = await composioRequest(
      env,
      `/tool_router/session/${encodeURIComponent(sessionId)}/toolkits?${params}`,
    );
    if (!response.ok) throw new Error(await upstreamError(response, "Toolkit inventory unavailable"));
    const body = toolkitPageSchema.parse(await response.json());
    toolkits.push(...(body.items ?? []));
    const next = body.next_cursor || undefined;
    if (!next || seenCursors.has(next)) return toolkits;
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error("Toolkit inventory exceeded the pagination safety limit");
}

function summarizeAccounts(accounts: ConnectedAccountResponse[], slugs: string[]) {
  const requested = new Set(slugs.map((slug) => slug.toLowerCase()));
  const bySlug = new Map<string, Array<ConnectedAccountSummary & { updatedAt: string }>>();
  for (const account of accounts) {
    const slug = account.toolkit?.slug?.toLowerCase();
    if (!slug || (requested.size && !requested.has(slug)) || !account.id || !ACCOUNT_ID.test(account.id)) continue;
    const alias = account.alias?.trim() ?? "";
    const summary: ConnectedAccountSummary & { updatedAt: string } = {
      id: account.id,
      status: account.status || "UNKNOWN",
      updatedAt: account.updated_at ?? "",
    };
    if (printableAliasSchema.safeParse(alias).success) summary.alias = alias;
    const list = bySlug.get(slug) ?? [];
    list.push(summary);
    bySlug.set(slug, list);
  }
  for (const list of bySlug.values()) list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return bySlug;
}

function publicAccount({ id, alias, status }: ConnectedAccountSummary): ConnectedAccountSummary {
  const account: ConnectedAccountSummary = { id, status };
  if (alias) account.alias = alias;
  return account;
}

function serviceStateFromAccounts(accounts: ConnectedAccountSummary[]): ConnectorServiceState {
  const active = accounts.find((account) => /^active$/i.test(account.status));
  const pending = accounts.find((account) => /^(initiated|initializing|pending)$/i.test(account.status));
  const selected = active ?? pending ?? accounts[0];
  return {
    connected: Boolean(active),
    pending: Boolean(pending),
    status: selected?.status ?? "not_connected",
    accounts: accounts.map(publicAccount),
  };
}

function allServiceStates(
  accountsBySlug: ReadonlyMap<string, ConnectedAccountSummary[]>,
  toolkits: ToolkitItem[],
): Record<string, ConnectorServiceState> {
  const services = new Map(
    [...accountsBySlug].map(([slug, accounts]) => [slug, serviceStateFromAccounts(accounts)]),
  );
  for (const toolkit of toolkits) {
    const slug = toolkit.slug?.toLowerCase();
    const selected = toolkit.connected_account;
    const selectedId = selected?.id && ACCOUNT_ID.test(selected.id) ? selected.id : undefined;
    if (!slug || (!toolkit.is_no_auth && !selectedId)) continue;
    const existingAccounts = accountsBySlug.get(slug) ?? [];
    const accounts = [...existingAccounts];
    if (selectedId && !accounts.some((account) => account.id === selectedId)) {
      accounts.push({ id: selectedId, status: selected?.status ?? "ACTIVE" });
    }
    const accountState = serviceStateFromAccounts(accounts);
    const status = toolkit.is_no_auth ? "ACTIVE" : selected?.status ?? accountState.status;
    services.set(slug, {
      connected: toolkit.is_no_auth === true || accountState.connected || /^active$/i.test(status),
      pending: accountState.pending || /^(initiated|initializing|pending)$/i.test(status),
      status,
      accounts: accountState.accounts,
    });
  }
  return Object.fromEntries(services);
}

async function connectedServices(
  installation: InstallationRow,
  env: Env,
  ctx: ExecutionContext,
) {
  const session = await ensureSession(installation, env, ctx);
  const [toolkits, accounts] = await Promise.all([
    listSessionToolkits(env, session.sessionId),
    listConnectedAccounts(env, installation.composio_user_id, []).catch(() => []),
  ]);
  return json({
    configured: true,
    services: allServiceStates(summarizeAccounts(accounts, []), toolkits),
  });
}

async function connectionStatus(url: URL, installation: InstallationRow, env: Env, ctx: ExecutionContext) {
  const slugs = [...new Set((url.searchParams.get("services") ?? "").split(",").map((slug) => slug.toLowerCase()).filter(Boolean))].slice(0, 50);
  const session = await ensureSession(installation, env, ctx);
  const [response, accounts] = await Promise.all([
    composioRequest(
      env,
      `/tool_router/session/${encodeURIComponent(session.sessionId)}/toolkits?${new URLSearchParams({ limit: "50", toolkits: slugs.join(",") })}`,
    ),
    listConnectedAccounts(env, installation.composio_user_id, slugs).catch(() => []),
  ]);
  if (!response.ok) return json({ error: await upstreamError(response, "Connection status unavailable") }, 502);
  const body = toolkitPageSchema.parse(await response.json());
  const items = new Map((body.items ?? []).map((item) => [item.slug?.toLowerCase(), item]));
  const accountsBySlug = summarizeAccounts(accounts, slugs);
  return json({ services: Object.fromEntries(slugs.map((slug) => {
    const item = items.get(slug);
    const serviceAccounts = accountsBySlug.get(slug) ?? [];
    const accountState = serviceStateFromAccounts(serviceAccounts);
    const status = item?.connected_account?.status ?? (item?.is_no_auth ? "ACTIVE" : accountState.status);
    return [slug, {
      connected: item?.is_no_auth === true || accountState.connected || /^active$/i.test(status),
      pending: accountState.pending || /^(initiated|initializing|pending)$/i.test(status),
      status,
      accounts: accountState.accounts,
    }];
  })) });
}

async function authorize(
  slug: string,
  alias: string | undefined,
  installation: InstallationRow,
  env: Env,
  ctx: ExecutionContext,
) {
  const session = await ensureSession(installation, env, ctx);
  // Listing can be denied to the broker's key scope; authorize must still
  // work, with the alias guardrails degrading to first-account behavior.
  const accounts = await listConnectedAccounts(env, installation.composio_user_id, [slug]).catch(() => []);
  const serviceAccounts = accounts.filter((account) => account.toolkit?.slug?.toLowerCase() === slug);
  const usableAccounts = serviceAccounts.filter((account) => /^(active|initiated|initializing|pending)$/i.test(account.status ?? ""));
  if (usableAccounts.length >= MULTI_ACCOUNT_CONFIG.max_accounts_per_toolkit) {
    return json({ error: `${slug} already has the maximum of ${MULTI_ACCOUNT_CONFIG.max_accounts_per_toolkit} accounts` }, 409);
  }
  if (usableAccounts.length > 0 && !alias) {
    return json({ error: "Add an account alias so the existing connection is not replaced" }, 400);
  }
  if (alias && serviceAccounts.some((account) => account.alias?.trim().toLowerCase() === alias.toLowerCase())) {
    return json({ error: `Account alias "${alias}" is already in use for ${slug}` }, 409);
  }
  const linkRequest: AccountLinkRequest = { toolkit: slug };
  if (alias) linkRequest.alias = alias;
  const response = await composioRequest(env, `/tool_router/session/${encodeURIComponent(session.sessionId)}/link`, {
    method: "POST",
    body: JSON.stringify(linkRequest),
  });
  if (!response.ok) return json({ error: await upstreamError(response, "Authorization unavailable") }, 502);
  const body = linkResponseSchema.parse(await response.json());
  if (!body.redirect_url) return json({ error: "Composio returned no authorization link" }, 502);
  const redirect = new URL(body.redirect_url);
  if (redirect.protocol !== "https:" || (redirect.hostname !== "composio.dev" && !redirect.hostname.endsWith(".composio.dev"))) {
    return json({ error: "Composio returned an untrusted authorization link" }, 502);
  }
  return json({ url: redirect.toString() });
}

async function disconnect(slug: string, installation: InstallationRow, env: Env, ctx: ExecutionContext) {
  const session = await ensureSession(installation, env, ctx);
  const list = await composioRequest(
    env,
    `/tool_router/session/${encodeURIComponent(session.sessionId)}/toolkits?${new URLSearchParams({ limit: "50", toolkits: slug })}`,
  );
  if (!list.ok) return json({ error: await upstreamError(list, "Connection lookup unavailable") }, 502);
  const body = toolkitPageSchema.parse(await list.json());
  const id = body.items?.find((item) => item.slug?.toLowerCase() === slug)?.connected_account?.id;
  if (!id) return json({ removed: 0 });
  const response = await composioRequest(env, `/connected_accounts/${encodeURIComponent(id)}?revoke_on_delete=true`, { method: "DELETE" });
  if (!response.ok) return json({ error: await upstreamError(response, "Disconnect failed") }, 502);
  return json({ removed: 1 });
}

async function disconnectAccount(
  slug: string,
  accountId: string,
  installation: InstallationRow,
  env: Env,
  ctx: ExecutionContext,
) {
  if (!ACCOUNT_ID.test(accountId)) return json({ error: "Invalid connected-account ID" }, 400);
  await ensureSession(installation, env, ctx);
  const accounts = await listConnectedAccounts(env, installation.composio_user_id, [slug]);
  const owned = accounts.some((account) =>
    account.id === accountId && account.toolkit?.slug?.toLowerCase() === slug
  );
  if (!owned) return json({ removed: 0 });
  const response = await composioRequest(
    env,
    `/connected_accounts/${encodeURIComponent(accountId)}?revoke_on_delete=true`,
    { method: "DELETE" },
  );
  if (!response.ok) return json({ error: await upstreamError(response, "Disconnect failed") }, 502);
  return json({ removed: 1 });
}

async function requestAlias(request: Request) {
  if (!request.body) return undefined;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > 2048) throw new Response(JSON.stringify({ error: "request body is too large" }), { status: 413, headers: JSON_HEADERS });
  let body: z.infer<typeof aliasRequestSchema>;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 2048) {
      throw new Response(JSON.stringify({ error: "request body is too large" }), { status: 413, headers: JSON_HEADERS });
    }
    // Some Fetch implementations expose a zero-length POST as a non-null
    // ReadableStream. First-account authorization intentionally has no alias,
    // so accept that wire representation exactly like a missing body.
    if (!raw.trim()) return undefined;
    body = aliasRequestSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (error instanceof Response) throw error;
    throw new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400, headers: JSON_HEADERS });
  }
  try {
    return normalizeAccountAlias(body.alias);
  } catch (error) {
    throw new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), { status: 400, headers: JSON_HEADERS });
  }
}

async function route(request: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") return json({ service: "botfleet-composio", ready: Boolean(env.COMPOSIO_API_KEY) });
  if (request.method === "POST" && url.pathname === "/v1/installations") return register(request, env);
  if (!url.pathname.startsWith("/v1/")) return json({ error: "not found" }, 404);
  const installation = await authenticate(request, env);
  if (!installation) return json({ error: "unauthorized" }, 401);
  if (request.method === "GET" && url.pathname === "/v1/me") return json({ installationId: installation.id });
  if (request.method === "POST" && url.pathname === "/v1/mcp") return proxyMcp(request, installation, env, ctx);
  if (request.method === "GET" && url.pathname === "/v1/catalog") return catalog(env);
  if (request.method === "GET" && url.pathname === "/v1/connectors/connected") return connectedServices(installation, env, ctx);
  if (request.method === "GET" && url.pathname === "/v1/connectors") return connectionStatus(url, installation, env, ctx);
  const accountMatch = url.pathname.match(/^\/v1\/connectors\/([a-z0-9][a-z0-9_-]{0,80})\/accounts\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/);
  if (accountMatch && request.method === "DELETE") {
    return disconnectAccount(accountMatch[1], accountMatch[2], installation, env, ctx);
  }
  const match = url.pathname.match(/^\/v1\/connectors\/([a-z0-9][a-z0-9_-]{0,80})(?:\/(authorize))?$/);
  if (match?.[2] && request.method === "POST") return authorize(match[1], await requestAlias(request), installation, env, ctx);
  if (match && !match[2] && request.method === "DELETE") return disconnect(match[1], installation, env, ctx);
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      if (error instanceof Response) return error;
      console.error(JSON.stringify({ message: "request failed", path: new URL(request.url).pathname, error: error instanceof Error ? error.message : String(error) }));
      return json({ error: "service unavailable" }, 503);
    }
  },
} satisfies ExportedHandler<Env>;

export {
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
};
