// Harness side of shared/model-lineage.ts: how a live provider instance
// becomes a LineageContext, how described catalogs are trimmed for pickers,
// and the write-time check every modelSelection PATCH goes through.
//
// Kept out of index.ts so it is testable without booting the server.
import type { ModelSelection } from "./contracts.ts";
import { STATIC_CODEX_MODELS } from "./drivers/codex-catalog.ts";
import {
  anyLineageLabel,
  hasLineage,
  presentCatalog,
  reconcileChain,
  retiredModel,
  type LineageChange,
  type LineageContext,
} from "../shared/model-lineage.ts";

interface CatalogLike {
  default: string;
  options: Array<{ id: string; custom?: unknown; label?: string; badge?: string }>;
}

function officialIds(models: CatalogLike): string[] {
  return models.options.filter((option) => !option.custom).map((option) => option.id);
}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** Whether `models` is the built-in `fallback` catalog rather than a list
 *  the provider answered with.  The official ids must be exactly the
 *  fallback's.  When the fallback marks its rows (the Codex fallback carries
 *  an "Unverified" chip on every row), every row must carry that same mark
 *  too: that is what tells the fallback apart from a live listing that
 *  happens to name the same ids, which is the normal case once the fallback
 *  is kept in step with what Codex serves. */
export function matchesStaticFallback(models: CatalogLike, fallback: CatalogLike): boolean {
  const official = models.options.filter((option) => !option.custom);
  const rows = fallback.options.filter((option) => !option.custom);
  if (!sameIdSet(official.map((option) => option.id), rows.map((option) => option.id))) return false;
  const badgeById = new Map(rows.map((row) => [row.id, row.badge]));
  if (!rows.some((row) => row.badge)) return true;
  return official.every((option) => option.badge === badgeById.get(option.id));
}

/** Whether an instance's catalog is the engine's authoritative answer.
 *
 * Codex lists what the signed-in account can use through `codex
 * app-server`, and falls back to STATIC_CODEX_MODELS when that listing is
 * unavailable (codex-catalog.ts).  The static rows are not proof of access —
 * on this Mac they have offered GPT-6 Luna while the account's live catalog
 * had GPT-5.6 Luna — so the static fallback is not authoritative and nothing
 * is resolved or moved against it.  Every other lineage engine's catalog is
 * its product source of truth. */
export function catalogIsAuthoritative(driverKind: string, models: CatalogLike): boolean {
  if (driverKind === "codex") return !matchesStaticFallback(models, STATIC_CODEX_MODELS);
  return true;
}

/** "Not in catalog" is only claimed against a catalog the provider itself
 *  just listed.  Today that is Codex's app-server catalog. */
export function catalogIsLive(driverKind: string, models: CatalogLike): boolean {
  return driverKind === "codex" && catalogIsAuthoritative(driverKind, models);
}

export function lineageContextFor(
  instance: { driverKind: string; models: CatalogLike } | undefined,
  effortLevels?: (model: string) => readonly string[] | undefined,
): LineageContext | undefined {
  if (!instance || !hasLineage(instance.driverKind)) {
    return instance ? { driverKind: instance.driverKind, offeredIds: [], authoritative: false } : undefined;
  }
  return {
    driverKind: instance.driverKind,
    offeredIds: officialIds(instance.models),
    authoritative: catalogIsAuthoritative(instance.driverKind, instance.models),
    ...(effortLevels ? { effortLevels } : {}),
  };
}

/** What `/api/instances` hands every picker (desktop, iOS, the MCP tool):
 *  superseded and retired rows removed, and `live` set where "Not in
 *  catalog" may be claimed.  Validation and dispatch keep reading the full
 *  catalog from the registry, so a saved older id still resolves. */
export function presentDescribedInstances<T extends { driverKind: string; models: CatalogLike }>(described: T[]): T[] {
  return described.map((instance) => {
    const presented = presentCatalog(instance.driverKind, instance.models);
    const live = catalogIsLive(instance.driverKind, instance.models);
    if (presented === instance.models && !live) return instance;
    return { ...instance, models: { ...presented, ...(live ? { live: true } : {}) } };
  });
}

/** Readable model name for notices and errors. */
export function modelNameFor(models: CatalogLike | undefined, id: string): string {
  return models?.options.find((option) => option.id === id)?.label ?? anyLineageLabel(id) ?? id;
}

function slotFor(index: number): string {
  return index < 0 ? "primary" : `fallback ${index + 1}`;
}

function rawLatest(raw: unknown): { present: boolean; value: unknown } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { present: false, value: undefined };
  return Object.hasOwn(raw, "latest")
    ? { present: true, value: (raw as { latest?: unknown }).latest }
    : { present: false, value: undefined };
}

function rawFallback(raw: unknown, index: number): unknown {
  if (!raw || typeof raw !== "object") return undefined;
  const fallbacks = (raw as { fallbacks?: unknown }).fallbacks;
  return Array.isArray(fallbacks) ? fallbacks[index] : undefined;
}

function chainEntries(selection: ModelSelection | undefined): ModelSelection[] {
  if (!selection) return [];
  return [selection, ...(selection.fallbacks ?? [])];
}

function sameTarget(a: ModelSelection, b: ModelSelection): boolean {
  return a.instanceId === b.instanceId && a.model === b.model;
}

/** A client that predates `latest` (the shipped iOS app decodes only
 *  instanceId / model / effort / fallbacks) re-sends a floating entry
 *  without the field.  When the entry still names the engine and model of a
 *  saved floating entry, keep it floating.  An explicit `latest: null` is how
 *  the desktop picker pins the resolved model instead.
 *
 *  Entries are paired with the saved chain by position first.  An entry
 *  whose saved entry at the same position names something else (iOS removed
 *  or reordered a fallback, so the rest of the chain shifted) is then paired
 *  with the first unpaired saved entry that names the same engine and model.
 *  Each saved entry is paired at most once, so a pinned entry is never
 *  handed a float that belongs to a different place in the chain. */
function carryLatestChain(incoming: ModelSelection[], raws: unknown[], saved: ModelSelection[]): ModelSelection[] {
  const out = [...incoming];
  const used = new Set<number>();
  const open: number[] = [];
  const carries = (index: number) => {
    const entry = incoming[index]!;
    return entry.latest === undefined && !rawLatest(raws[index]).present;
  };
  incoming.forEach((entry, index) => {
    const same = saved[index];
    if (same && sameTarget(same, entry)) {
      used.add(index);
      if (carries(index) && same.latest) out[index] = { ...entry, latest: same.latest };
      return;
    }
    open.push(index);
  });
  for (const index of open) {
    const entry = incoming[index]!;
    const match = saved.findIndex((candidate, at) => !used.has(at) && sameTarget(candidate, entry));
    if (match < 0) continue;
    used.add(match);
    const from = saved[match]!;
    if (carries(index) && from.latest) out[index] = { ...entry, latest: from.latest };
  }
  return out;
}

export type LineageWriteResult =
  | { ok: true; selection: ModelSelection; current: ModelSelection | undefined; changes: LineageChange[] }
  | { ok: false; error: string };

/** The lineage half of a modelSelection write.
 *
 *  - Carries `latest` forward for clients that do not send it.
 *  - Refuses a retired id with no successor, but only when this write
 *    introduces it: the UI re-sends the whole chain on every edit, and a
 *    saved leftover in one slot must not block editing another.
 *  - Rewrites retired and superseded ids and resolves Latest entries.
 *  - Reconciles the saved selection the same way, so the caller's "did the
 *    chain change?" check (the busy 409) compares like with like and a bot
 *    whose saved chain merely predates a catalog refresh is not reported as
 *    changed. */
export function checkLineageWrite(
  selection: ModelSelection,
  raw: unknown,
  current: ModelSelection | undefined,
  contextFor: (instanceId: string) => LineageContext | undefined,
): LineageWriteResult {
  const saved = chainEntries(current);
  const raws = [raw, ...(selection.fallbacks ?? []).map((_, index) => rawFallback(raw, index))];
  const carried = carryLatestChain(chainEntries(selection), raws, saved);
  const incoming: ModelSelection = { ...carried[0]! };
  delete incoming.fallbacks;
  if (selection.fallbacks) incoming.fallbacks = carried.slice(1);
  const entries = chainEntries(incoming);
  const unclaimed = [...saved];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const driverKind = contextFor(entry.instanceId)?.driverKind;
    const retired = retiredModel(driverKind, entry.model);
    if (!retired || retired.successorClass !== null) continue;
    // Each saved slot grandfathers ONE incoming copy: a single saved dead
    // target must not cover a second copy of it added in this write.
    const savedAt = unclaimed.findIndex((s) => sameTarget(s, entry));
    if (savedAt >= 0) unclaimed.splice(savedAt, 1);
    else {
      return {
        ok: false,
        error: `retired model "${entry.model}" in ${slotFor(i - 1)} — choose another model`,
      };
    }
  }
  const reconciled = reconcileChain(incoming, contextFor);
  const reconciledCurrent = current ? reconcileChain(current, contextFor).selection : undefined;
  return { ok: true, selection: reconciled.selection, current: reconciledCurrent, changes: reconciled.changes };
}
