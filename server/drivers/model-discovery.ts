// Shared live model discovery for API-key engines.
//
// The engine picker is fed by `ProviderInstance.refreshModels`, which
// `harness/registry.ts` calls on every describe.  Engines that expose an
// OpenAI-compatible `GET {baseUrl}/models` should never carry a hand-written
// catalog as the only source of truth: a provider that ships a new model
// would not show up until a human edited TypeScript.  This module is the one
// place that knows how to ask a provider what it has, how to fold the answer
// into a `ModelCatalog` without losing hand-written metadata, and how to memo
// the fetch so N describes do not become N HTTP round trips.
//
// Three rules every caller inherits:
//   1. A discovery miss is never fatal.  `null` from `mergeDiscoveredModels`
//      means "keep the catalog you already have" — a blank, malformed, or
//      empty list must never blank the picker.
//   2. Hand-written metadata wins.  Labels, badges, and context windows are
//      the product's copy and the sizing input for the model-facing rebuild;
//      a live row may refresh which ids exist, never how they read.
//   3. A removed id stays removed.  Nothing here re-aliases a retired id to
//      its replacement, per docs/rollouts/2026-09-18-latest-model-ids.md.
import type { ModelCatalog } from "../contracts.ts";

export interface ModelDiscoveryInput {
  /** Base URL with no trailing slash and no `/chat/completions` suffix;
   *  discovery calls `{baseUrl}/models`. */
  baseUrl: string;
  apiKey?: string;
  /** Provider-specific extras (an org header, an `api-version`, ...). */
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface ModelDiscoveryResult {
  ok: boolean;
  status?: number;
  /** The raw provider rows, kept for callers that also snapshot a provider
   *  from the same fetch (see drivers/minimax.ts `probeModels`). */
  rows?: unknown[];
}

const DEFAULT_TIMEOUT_MS = 8_000;

/** Rows out of either provider payload shape: a bare array, or an envelope
 *  carrying one under `data`. */
function rowsFromModelsPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  // SAFETY: `data` is only read to decide whether this is the `{ data: [...] }`
  // envelope, and Array.isArray re-checks the result, so a payload that does
  // not match the declared shape yields [] instead of a bad read.
  const data = (payload as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data : [];
}

/** One `GET {baseUrl}/models`, normalized across the two shapes providers
 *  use: a bare array, or `{ data: [...] }`.  Never throws — a network
 *  failure is `ok: false` with no status, same as an unreachable host. */
export async function fetchProviderModels(input: ModelDiscoveryInput): Promise<ModelDiscoveryResult> {
  const { baseUrl, apiKey, headers, timeoutMs } = input;
  try {
    const requestHeaders = new Headers(headers);
    if (apiKey) requestHeaders.set("authorization", `Bearer ${apiKey}`);
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: requestHeaders,
      signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const payload: unknown = await res.json().catch(() => null);
    return { ok: true, status: res.status, rows: rowsFromModelsPayload(payload) };
  } catch {
    return { ok: false };
  }
}

export interface MergeModelsOptions {
  /** Ids to drop even when the provider still lists them.  This is how a
   *  product decision is expressed (see `acp/dsh.ts` dropping
   *  `MiniMax-M2.7` from the Clutch catalog). */
  excludeIds?: readonly string[];
  /** Keep `known.default` when it survived the refresh instead of
   *  resetting to the first row, so a refresh does not silently move a
   *  user's selection.  Defaults to true. */
  keepDefault?: boolean;
}

/** The two fields a provider row may contribute beyond its id.  Narrowed once,
 *  at the point the untrusted row enters, so the merge below works with real
 *  strings instead of re-asserting the same shape per field. */
function readProviderRow(row: unknown): { id: string; name: string } | null {
  if (!row || typeof row !== "object") return null;
  // SAFETY: the row came off a provider's JSON, so `id` and `name` may be any
  // type.  Both are read here and nowhere else, and each is re-checked with
  // typeof before use, so a row that breaks the declared shape contributes
  // nothing rather than a mis-typed value.
  const record = row as { id?: unknown; name?: unknown };
  if (typeof record.id !== "string" || !record.id) return null;
  const name = typeof record.name === "string" && record.name.trim() ? record.name : "";
  return { id: record.id, name };
}

/** Fold discovered rows into a catalog, preserving the hand-written
 *  metadata for ids we already know.  Returns `null` when the result would
 *  be empty — the caller keeps its existing catalog. */
export function mergeDiscoveredModels(
  rows: readonly unknown[],
  known: ModelCatalog,
  options: MergeModelsOptions = {},
): ModelCatalog | null {
  const excluded = new Set(options.excludeIds ?? []);
  const seen = new Set<string>();
  const merged: ModelCatalog["options"] = [];
  for (const candidate of rows) {
    const row = readProviderRow(candidate);
    if (!row) continue;
    if (seen.has(row.id) || excluded.has(row.id)) continue;
    seen.add(row.id);
    const previous = known.options.find((option) => option.id === row.id);
    // `name` is an OpenAI-compatible courtesy field; prefer the hand-written
    // label, then the provider's own name, then the bare id.
    const option: ModelCatalog["options"][number] = {
      id: row.id,
      // `||` not `??`: readProviderRow reports a missing name as "", and `??`
      // would let that empty string win over the id instead of falling back.
      label: previous?.label ?? (row.name || row.id),
    };
    // Metadata is copied only when present, so an option never carries a key
    // set to undefined.
    if (previous?.badge) option.badge = previous.badge;
    if (previous?.badgeTitle) option.badgeTitle = previous.badgeTitle;
    if (previous?.contextWindow) option.contextWindow = previous.contextWindow;
    if (previous?.loaded !== undefined) option.loaded = previous.loaded;
    merged.push(option);
  }
  if (merged.length === 0) return null;
  const keepDefault = options.keepDefault ?? true;
  const defaultId = keepDefault && seen.has(known.default) ? known.default : merged[0].id;
  return { default: defaultId, options: merged };
}

/** Memoize a discovery fetch for `ttlMs`.  Drivers used to hand-roll this —
 *  minimax at 60 s, cursor at 5 min — and the drift is why `describe` fans out
 *  into a burst of duplicate `/models` calls every time the registry memo
 *  expires.  One helper, one TTL per call site, and concurrent describes
 *  share the in-flight promise instead of stacking requests. */
export function createModelDiscoveryProbe(
  ttlMs: number,
  run: () => Promise<ModelDiscoveryResult>,
): () => Promise<ModelDiscoveryResult> {
  let cached: { at: number; result: Promise<ModelDiscoveryResult> } | null = null;
  return () => {
    const now = Date.now();
    if (cached && now - cached.at < ttlMs) return cached.result;
    const result = run();
    cached = { at: now, result };
    // Only a rejection invalidates the memo.  A resolved probe must keep
    // serving until the TTL expires, or every sequential `await
    // refreshModels()` refetches and the TTL buys nothing.  The `catch` also
    // keeps a `void probe()` from surfacing as an unhandled rejection.
    result.catch(() => {
      if (cached?.result === result) cached = null;
    });
    return result;
  };
}

/** Convenience for the common engine shape: probe `{baseUrl}/models`, merge
 *  into `current`, and report whether the catalog moved.  Returns `null`
 *  when nothing changed, so `refreshModels` can leave its `models` alone. */
export async function discoverModelCatalog(
  probe: () => Promise<ModelDiscoveryResult>,
  current: () => ModelCatalog,
  options: MergeModelsOptions = {},
): Promise<ModelCatalog | null> {
  const result = await probe();
  if (!result.ok || !result.rows) return null;
  return mergeDiscoveredModels(result.rows, current(), options);
}
