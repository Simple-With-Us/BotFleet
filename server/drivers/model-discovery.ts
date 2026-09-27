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

/** One `GET {baseUrl}/models`, normalized across the two shapes providers
 *  use: a bare array, or `{ data: [...] }`.  Never throws — a network
 *  failure is `ok: false` with no status, same as an unreachable host. */
export async function fetchProviderModels(input: ModelDiscoveryInput): Promise<ModelDiscoveryResult> {
  const { baseUrl, apiKey, headers, timeoutMs } = input;
  try {
    const requestHeaders: Record<string, string> = { ...headers };
    if (apiKey) requestHeaders.authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: requestHeaders,
      signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const json: unknown = await res.json().catch(() => null);
    const rows: unknown[] = Array.isArray(json)
      ? json
      : Array.isArray((json as { data?: unknown })?.data)
        ? ((json as { data: unknown[] }).data)
        : [];
    return { ok: true, status: res.status, rows };
  } catch {
    return { ok: false };
  }
}

export interface MergeModelsOptions {
  /** Ids to drop even when the provider still lists them.  This is how a
   *  product decision is expressed (see `acp/dsh.ts` dropping
   *  `MiniMax-M2.7` from the Harness catalog). */
  excludeIds?: readonly string[];
  /** Keep `known.default` when it survived the refresh instead of
   *  resetting to the first row, so a refresh does not silently move a
   *  user's selection.  Defaults to true. */
  keepDefault?: boolean;
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
  const options_: ModelCatalog["options"] = [];
  for (const row of rows) {
    const candidate = row as { id?: unknown };
    const id = typeof candidate?.id === "string" ? candidate.id : "";
    if (!id || seen.has(id) || excluded.has(id)) continue;
    seen.add(id);
    const previous = known.options.find((option) => option.id === id);
    // `name` is an OpenAI-compatible courtesy field; prefer the hand-written
    // label, then the provider's own name, then the bare id.
    const providedName = (row as { name?: unknown }).name;
    const label =
      previous?.label ??
      (typeof providedName === "string" && providedName.trim() ? providedName : id);
    options_.push({
      id,
      label,
      ...(previous?.badge ? { badge: previous.badge } : {}),
      ...(previous?.badgeTitle ? { badgeTitle: previous.badgeTitle } : {}),
      ...(previous?.contextWindow ? { contextWindow: previous.contextWindow } : {}),
      ...(previous?.loaded !== undefined ? { loaded: previous.loaded } : {}),
    });
  }
  if (options_.length === 0) return null;
  const keepDefault = options.keepDefault ?? true;
  const defaultId = keepDefault && seen.has(known.default) ? known.default : options_[0].id;
  return { default: defaultId, options: options_ };
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
