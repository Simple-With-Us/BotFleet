// Parameterized recall_search / recall_contribute / recall_stats business
// logic, shared by the CLI-lane MCP proxy (drivers/qdrant-proxy.ts, which
// derives its settings from its own spawned process's env) and the HTTP
// lane's in-process tools (tools/recall.ts, which is handed the harness's
// live `cfg.qdrant` settings directly).  One implementation, two callers —
// the split that PRs #409/#433/#442 already established for bash/file tools.
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

async function verifyCollection(settings: RecallSettings, signal: AbortSignal): Promise<void> {
  if (!settings.collection) return;
  await probeRecallService(settings.url, recallHttpHeaders(settings), settings.collection, signal);
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
      return success(formatHits(data.hits || [], settings, data.mode));
    } catch (error) {
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
    if (gate) return failure(`Bot RAG search failed: ${gate}.`);
    if (res.ok) {
      const data = (await res.json()) as { hits?: HitRecord[]; mode?: string; ok?: boolean; error?: unknown };
      if (data.ok === false || data.error || !Array.isArray(data.hits)) throw new Error("the service returned an invalid search result");
      return success(formatHits(data.hits, settings, data.mode));
    }
    const errText = await res.text().catch(() => "");
    return failure(`Bot RAG search error (${res.status}): ${safeError(errText || res.statusText)}`);
  } catch (err) {
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

  if (!settings.url) {
    try {
      const cliArgs = [text, "--category", category, "--app", app, "--seat", seat, "--json"];
      if (title) cliArgs.push("--title", title);
      if (url) cliArgs.push("--url", url);
      if (force) cliArgs.push("--force");
      const raw = await runCli(settings, "contribute", cliArgs);
      const data = JSON.parse(raw);
      if (data.status === "duplicate") return success(`Contribution duplicate: ${data.message || "A similar lesson already exists"}`);
      return success(`Stored in ${collectionLabel(settings)} [doc_id: ${data.doc_id || data.id}]: ${title ? `"${title}"` : text.slice(0, 80)}`);
    } catch (error) {
      return failure(`Bot RAG CLI failed: ${describeCliFailure(error, RECALL_TOOL_TIMEOUT_MS)}.`);
    }
  }

  try {
    const headers = recallHttpHeaders(settings);
    const signal = AbortSignal.timeout(RECALL_TOOL_TIMEOUT_MS);
    await verifyCollection(settings, signal);

    const res = await fetchRecall(`${settings.url}/recall/contribute`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text, category, app, seat, title, url, force }),
      signal,
    });
    const gate = accessLoginHint(res);
    if (gate) return failure(`Bot RAG contribute failed: ${gate}.`);
    if (res.ok) {
      const data = (await res.json()) as { doc_id?: string; id?: string; ok?: boolean; error?: unknown; status?: string };
      if (data.ok === false || data.error) throw new Error("the service rejected the contribution");
      if (data.status === "duplicate") return success("Contribution duplicate: a similar lesson already exists.");
      if (!data.doc_id && !data.id) throw new Error("the service did not confirm a contribution ID; check before retrying");
      return success(`Successfully contributed to ${collectionLabel(settings)} [id: ${data.doc_id || data.id}]`);
    }
    const errText = await res.text().catch(() => "");
    return failure(`Bot RAG contribute error (${res.status}): ${safeError(errText || res.statusText)}`);
  } catch (err) {
    return failure(`Failed to contribute to agent RAG at ${settings.url}: ${safeError(err)}`);
  }
}

export async function recallStatsWith(settings: RecallSettings): Promise<RecallOutcome> {
  const status = await recallStatus(settings);
  if (!status.configured) return failure(NOT_CONFIGURED_MESSAGE);
  if (!status.ready) return failure(`Bot RAG status check failed: ${status.error}.`);
  return success(`Bot RAG status [${status.collection}]:\n- Source: ${status.source}\n- Backend: healthy\n- Points: ${status.pointsCount?.toLocaleString()}\n- Checked: ${new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" }).format(status.checkedAt)} CT`);
}
