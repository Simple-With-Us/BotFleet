// Parameterized recall_search / recall_contribute / recall_stats business
// logic, shared by the CLI-lane MCP proxy (drivers/qdrant-proxy.ts, which
// derives its settings from its own spawned process's env) and the HTTP
// lane's in-process tools (tools/recall.ts, which is handed the harness's
// live `cfg.qdrant` settings directly).  One implementation, two callers —
// the split that PRs #409/#433/#442 already established for bash/file tools.
import { createHash } from "node:crypto";
import { accessHeaders, accessLoginHint } from "./recall-access.ts";
import {
  executeRecallCli,
  fetchRecall,
  findRecallCli,
  probeRecallService,
  recallStatus,
  RECALL_TOOL_TIMEOUT_MS,
  type RecallSettings,
} from "./recall-transport.ts";
import { describeCliFailure } from "./cli-failure.ts";
import { redactSecretsInText } from "./redact.ts";

export const NOT_CONFIGURED_MESSAGE = "Bot RAG is not configured — set a Service URL in Settings";

/** Every recall function returns this instead of a bare string, so a
 *  caller can tell a genuine failure (not configured, bad arguments, a
 *  network/service error) apart from a real answer that merely reads like
 *  one at a glance (e.g. "No matching records found").  `ok: false` is
 *  the ONLY signal a caller should act on — never string-sniff `text`. */
export interface RecallOutcome {
  ok: boolean;
  text: string;
}

const failure = (text: string): RecallOutcome => ({ ok: false, text });
const success = (text: string): RecallOutcome => ({ ok: true, text });

interface HitRecord {
  score?: number;
  text?: string;
  source?: string;
  app?: string;
  category?: string;
  seat?: string;
  doc_id?: string;
  title?: string;
  heading?: string;
  url?: string;
  created_at?: number;
}

function collectionLabel(settings: RecallSettings): string {
  return settings.collection || "agent memory";
}

function formatHits(hits: HitRecord[], settings: RecallSettings, mode?: string): string {
  if (!hits || hits.length === 0) return "No matching records found in agent memory.";
  const modeLabel = mode ? ` (${mode})` : "";
  const formatted = hits
    .map((hit, idx) => {
      const title = hit.title || hit.heading ? `### ${hit.title || hit.heading}\n` : "";
      const tags = [hit.source, hit.app, hit.category, hit.seat ? `seat:${hit.seat}` : null].filter(Boolean).join(" · ");
      const meta = tags ? `_${tags}_\n` : "";
      const text = hit.text ? hit.text.trim() : "";
      const score = hit.score !== undefined ? `\n_Score: ${(hit.score * 100).toFixed(1)}%_` : "";
      const link = hit.url ? ` | [Link](${hit.url})` : "";
      return `${idx + 1}. ${title}${meta}${text}${score}${link}`;
    })
    .join("\n\n---\n\n");
  return `Found ${hits.length} hit(s) in agent memory [${collectionLabel(settings)}]${modeLabel}:\n\n${formatted}`;
}

async function runCli(settings: RecallSettings, subcommand: string, args: string[]): Promise<string> {
  const cli = findRecallCli();
  if (!cli) throw new Error("recall CLI not found on host");
  return executeRecallCli(cli, [subcommand, ...args], settings.collection, RECALL_TOOL_TIMEOUT_MS);
}

function recallHttpHeaders(settings: RecallSettings): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...accessHeaders(settings.accessClientId, settings.accessClientSecret),
  };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  return headers;
}

// ── caches ─────────────────────────────────────────────────────────────
// The CLI lane's proxy is a long-lived child process and the HTTP lane's
// harness is longer-lived still: one session serves a whole turn, often a
// whole conversation.  Two costs were paid on every single call inside it.
//
//   1. `verifyCollection` ran a full probe — GET /health then GET
//      /recall/stats — before each search and each contribute, so one search
//      was three round trips and the same two calls repeated forever even
//      though the collection rarely changes under a session.
//   2. Nothing remembered an answer, so a bot that searched the same phrase
//      twice in a turn paid the full latency twice (measured 3.76 s on the
//      CLI transport).
//
// Both caches hold positive results only, both are short, and any failure
// retires them: a stale "the corpus is fine" verdict is exactly the thing
// worth being careful about, so it never survives an error.
//
// Two things keep them honest.
//
// A WRITE never rides a cached verdict.  The costs are not symmetric: a
// stale verdict on a search reads the wrong corpus and the bot sees the
// wrong answers, but a stale verdict on a contribution PUTS a lesson in
// somebody else's corpus and reports success.  The contribute body carries
// no collection name, so this probe is the only thing standing between a
// service restarted onto a different collection and a misfiled lesson.
//
// And every entry is keyed by the settings it was formed under.  The CLI
// lane runs one proxy per bot, but the HTTP lane calls these functions in
// the harness process for every bot at once, so an unkeyed cache would hand
// one bot a verdict — or an answer — belonging to another bot's corpus.

/** How long a successful collection probe stands for a SEARCH.  Short enough
 * that a service restarted under a running bot is re-probed within the
 * minute.  Contributions ignore it entirely. */
const COLLECTION_VERIFY_TTL_MS = 60_000;
/** How long an identical search stays answerable from memory, and how many
 * distinct searches are remembered (least-recently-used evicted first). */
const SEARCH_CACHE_TTL_MS = 30_000;
const SEARCH_CACHE_MAX = 16;

const collectionVerified = new Map<string, number>();
const searchCache = new Map<string, { at: number; text: string }>();

/** Names the service a cached verdict or answer belongs to.  Hashed, so a
 * key can never carry a credential into a log line or an error message. */
function serviceKey(settings: RecallSettings): string {
  return createHash("sha256")
    .update(JSON.stringify([settings.url, settings.collection, settings.apiKey,
      settings.accessClientId, settings.accessClientSecret]))
    .digest("hex");
}

/** Forget every remembered search for one service, leaving other services'
 * answers alone. */
function clearSearchCache(service: string): void {
  for (const key of searchCache.keys()) if (key.startsWith(`${service}:`)) searchCache.delete(key);
}

/** Any non-2xx, gate, or transport error retires both caches for that
 * service: the next call re-probes rather than trusting a verdict formed
 * before the failure. */
function invalidateRecallCaches(service: string): void {
  collectionVerified.delete(service);
  clearSearchCache(service);
}

/** The search cache key — the service plus the whole request shape, so a
 * different limit or filter is a different question, never a cache hit. */
function searchCacheKey(service: string, payload: Record<string, unknown>): string {
  return `${service}:${JSON.stringify(Object.keys(payload).sort().map((key) => [key, payload[key]]))}`;
}

function readSearchCache(key: string): string | null {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  // Re-insert so the map's insertion order stays least-recently-used first.
  searchCache.delete(key);
  searchCache.set(key, hit);
  return hit.text;
}

function writeSearchCache(key: string, text: string): void {
  searchCache.delete(key);
  searchCache.set(key, { at: Date.now(), text });
  while (searchCache.size > SEARCH_CACHE_MAX) {
    searchCache.delete(searchCache.keys().next().value!);
  }
}

/** The service owns one corpus; verify it before sending a query or a
 * contribution.  A search may ride a verdict formed within the TTL; a write
 * passes `fresh` and always re-probes, because a cached verdict is a claim
 * about the past and a misfiled contribution cannot be taken back. */
async function verifyCollection(
  settings: RecallSettings,
  signal: AbortSignal,
  options: { fresh?: boolean } = {},
): Promise<void> {
  if (!settings.collection) return;
  const service = serviceKey(settings);
  if (!options.fresh && Date.now() < (collectionVerified.get(service) ?? 0)) return;
  try {
    await probeRecallService(settings.url, recallHttpHeaders(settings), settings.collection, signal);
  } catch (error) {
    invalidateRecallCaches(service);
    throw error;
  }
  collectionVerified.set(service, Date.now() + COLLECTION_VERIFY_TTL_MS);
}

function safeError(error: unknown): string {
  return redactSecretsInText(error instanceof Error ? error.message : String(error)).slice(0, 400);
}

export async function recallSearchWith(settings: RecallSettings, args: Record<string, unknown>): Promise<RecallOutcome> {
  if (!settings.url && !findRecallCli()) return failure(NOT_CONFIGURED_MESSAGE);

  const query = String(args.query || args.topic || "").trim();
  if (!query) return failure("Error: query parameter is required");

  const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
  const category = args.category ? String(args.category).trim() : undefined;
  const app = args.app ? String(args.app).trim() : undefined;
  const source = args.source ? String(args.source).trim() : undefined;
  const seat = args.seat ? String(args.seat).trim() : undefined;
  const sinceDays = args.since_days ? Number(args.since_days) : undefined;
  const perDoc = args.per_doc ? Number(args.per_doc) : undefined;

  // The key is the request, not the raw arguments: two calls that normalise
  // to the same query, limit and filters are the same question.
  const service = serviceKey(settings);
  const cacheKey = searchCacheKey(service, { query, limit, category, app, source, seat, sinceDays, perDoc });
  const cached = readSearchCache(cacheKey);
  if (cached !== null) return success(cached);

  if (!settings.url) {
    try {
      const cliArgs = ["search", query, "--limit", String(limit), "--json"];
      if (category) cliArgs.push("--category", category);
      if (app) cliArgs.push("--app", app);
      if (source) cliArgs.push("--source", source);
      if (seat) cliArgs.push("--seat", seat);
      if (sinceDays) cliArgs.push("--since-days", String(sinceDays));
      if (perDoc) cliArgs.push("--per-doc", String(perDoc));
      const raw = await runCli(settings, "search", cliArgs.slice(1));
      const data = JSON.parse(raw);
      const text = formatHits(data.hits || [], settings, data.mode);
      writeSearchCache(cacheKey, text);
      return success(text);
    } catch (error) {
      invalidateRecallCaches(service);
      return failure(`Bot RAG CLI failed: ${describeCliFailure(error, RECALL_TOOL_TIMEOUT_MS)}.`);
    }
  }

  try {
    const headers = recallHttpHeaders(settings);
    const signal = AbortSignal.timeout(RECALL_TOOL_TIMEOUT_MS);
    await verifyCollection(settings, signal);

    const payload: Record<string, unknown> = { query, limit };
    if (category) payload.category = category;
    if (app) payload.app = app;
    if (source) payload.source = source;
    if (seat) payload.seat = seat;
    if (sinceDays) payload.since_days = sinceDays;
    if (perDoc) payload.per_doc = perDoc;

    const res = await fetchRecall(`${settings.url}/recall/search`, { method: "POST", headers, body: JSON.stringify(payload), signal });
    const gate = accessLoginHint(res);
    if (gate) {
      invalidateRecallCaches(service);
      return failure(`Bot RAG search failed: ${gate}.`);
    }
    if (res.ok) {
      const data = (await res.json()) as { hits?: HitRecord[]; mode?: string; ok?: boolean; error?: unknown };
      if (data.ok === false || data.error || !Array.isArray(data.hits)) throw new Error("the service returned an invalid search result");
      const text = formatHits(data.hits, settings, data.mode);
      writeSearchCache(cacheKey, text);
      return success(text);
    }
    const errText = await res.text().catch(() => "");
    invalidateRecallCaches(service);
    return failure(`Bot RAG search error (${res.status}): ${safeError(errText || res.statusText)}`);
  } catch (err) {
    invalidateRecallCaches(service);
    return failure(`Failed to query agent RAG at ${settings.url}: ${safeError(err)}`);
  }
}

export async function recallContributeWith(
  settings: RecallSettings,
  defaultSeat: string,
  args: Record<string, unknown>,
): Promise<RecallOutcome> {
  if (!settings.url && !findRecallCli()) return failure(NOT_CONFIGURED_MESSAGE);

  const text = String(args.text || "").trim();
  if (!text) return failure("Error: text parameter is required");

  const category = String(args.category || "lesson").trim();
  const app = String(args.app || "botfleet").trim();
  const seat = String(args.seat || defaultSeat || "Bot").trim();
  const title = args.title ? String(args.title).trim() : undefined;
  const url = args.url ? String(args.url).trim() : undefined;
  const force = Boolean(args.force);

  const service = serviceKey(settings);

  if (!settings.url) {
    try {
      const cliArgs = [text, "--category", category, "--app", app, "--seat", seat, "--json"];
      if (title) cliArgs.push("--title", title);
      if (url) cliArgs.push("--url", url);
      if (force) cliArgs.push("--force");
      const raw = await runCli(settings, "contribute", cliArgs);
      const data = JSON.parse(raw);
      if (data.status === "duplicate") return success(`Contribution duplicate: ${data.message || "A similar lesson already exists"}`);
      // The corpus just changed, so remembered answers are out of date.
      clearSearchCache(service);
      return success(`Stored in ${collectionLabel(settings)} [doc_id: ${data.doc_id || data.id}]: ${title ? `"${title}"` : text.slice(0, 80)}`);
    } catch (error) {
      invalidateRecallCaches(service);
      return failure(`Bot RAG CLI failed: ${describeCliFailure(error, RECALL_TOOL_TIMEOUT_MS)}.`);
    }
  }

  try {
    const headers = recallHttpHeaders(settings);
    const signal = AbortSignal.timeout(RECALL_TOOL_TIMEOUT_MS);
    // A write never rides a cached verdict: the body names no collection, so
    // this probe is the only check that the service still owns the one that
    // was configured.
    await verifyCollection(settings, signal, { fresh: true });

    const res = await fetchRecall(`${settings.url}/recall/contribute`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text, category, app, seat, title, url, force }),
      signal,
    });
    const gate = accessLoginHint(res);
    if (gate) {
      invalidateRecallCaches(service);
      return failure(`Bot RAG contribute failed: ${gate}.`);
    }
    if (res.ok) {
      const data = (await res.json()) as { doc_id?: string; id?: string; ok?: boolean; error?: unknown; status?: string };
      if (data.ok === false || data.error) throw new Error("the service rejected the contribution");
      if (data.status === "duplicate") return success("Contribution duplicate: a similar lesson already exists.");
      if (!data.doc_id && !data.id) throw new Error("the service did not confirm a contribution ID; check before retrying");
      // The corpus just changed, so remembered answers are out of date.
      clearSearchCache(service);
      return success(`Successfully contributed to ${collectionLabel(settings)} [id: ${data.doc_id || data.id}]`);
    }
    const errText = await res.text().catch(() => "");
    invalidateRecallCaches(service);
    return failure(`Bot RAG contribute error (${res.status}): ${safeError(errText || res.statusText)}`);
  } catch (err) {
    invalidateRecallCaches(service);
    return failure(`Failed to contribute to agent RAG at ${settings.url}: ${safeError(err)}`);
  }
}

export async function recallStatsWith(settings: RecallSettings): Promise<RecallOutcome> {
  // The bot's stats tool is a tool call, so it gets the tool budget.  Left
  // implicit, `recallStatus` falls back to the much shorter settings-probe
  // budget, and a cold embedder would fail the bot's stats call while the
  // same corpus answered its searches fine.
  const status = await recallStatus(settings, RECALL_TOOL_TIMEOUT_MS);
  if (!status.configured) return failure(NOT_CONFIGURED_MESSAGE);
  if (!status.ready) {
    // This call just saw the corpus fail its own check — a collection
    // mismatch, an unhealthy backend, a gate.  Whatever an earlier probe
    // concluded is now known to be out of date, so retire it here too
    // instead of letting a search or a contribution act on it.
    invalidateRecallCaches(serviceKey(settings));
    return failure(`Bot RAG status check failed: ${status.error}.`);
  }
  return success(`Bot RAG status [${status.collection}]:\n- Source: ${status.source}\n- Backend: healthy\n- Points: ${status.pointsCount?.toLocaleString()}\n- Checked: ${new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" }).format(status.checkedAt)} CT`);
}
