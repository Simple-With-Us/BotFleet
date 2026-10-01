// Harness side of shared/model-lineage.ts: how a live provider instance
// becomes a LineageContext, how described catalogs are trimmed for pickers,
// and the write-time check every modelSelection PATCH goes through.
//
// Kept out of index.ts so it is testable without booting the server.
import type { ModelSelection } from "./contracts.ts";
import { STATIC_CODEX_MODELS } from "./drivers/codex-catalog.ts";
import {
  anyLineageLabel,
  classifyModel,
  compareRank,
  hasLineage,
  lineageClasses,
  presentCatalog,
  reconcileChain,
  reconcileEntry,
  resumeKeepsStartedModel,
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
    customIds: instance.models.options.filter((option) => option.custom).map((option) => option.id),
    authoritative: catalogIsAuthoritative(instance.driverKind, instance.models),
    ...(effortLevels ? { effortLevels } : {}),
  };
}

// ── Claude CLI version gate ──────────────────────────────────────────────
// The Claude CLI's own model catalog lists Opus 5.5 only from Claude Code
// 2.1.280 (its `min_claude_code_version`); Sonnet 5.5 declares no minimum.
// On an older CLI the Opus 5.5 row is not offered and no saved selection is
// moved onto it: a move there would also hide Opus 5, the model the bot ran
// on before, with no way back in the picker.  Fable 5.1 (listed from 2.1.251)
// was offered to every CLI before lineage existed and is left as it was.
const CLAUDE_CLI_MINIMUM = {
  "claude-opus-5-5": [2, 1, 280],
} as const satisfies Readonly<Record<string, readonly number[]>>;

/** `2.1.284 (Claude Code)` -> [2, 1, 284]; undefined when no version is known. */
export function parseCliVersion(text: string | null | undefined): number[] | undefined {
  const match = text ? /(\d+)\.(\d+)\.(\d+)/.exec(text) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** Claude model ids this CLI version is too old for (empty when unknown). */
export function claudeModelsTooNewFor(cliVersion: string | null | undefined): Set<string> {
  const version = parseCliVersion(cliVersion);
  const tooNew = new Set<string>();
  if (!version) return tooNew;
  for (const [id, minimum] of Object.entries(CLAUDE_CLI_MINIMUM)) {
    if (compareRank(version, minimum) < 0) tooNew.add(id);
  }
  return tooNew;
}

/** A Claude lineage context as the detected CLI can run it.  Until the CLI
 *  has answered `--version` the catalog is not authoritative, so nothing on
 *  a Claude engine is resolved or moved on a guess; once it has, models it is
 *  too old for are left out of what the pass may move onto. */
export function gateLineageByCliVersion(
  ctx: LineageContext | undefined,
  cliVersion: string | null | undefined,
): LineageContext | undefined {
  if (!ctx || ctx.driverKind !== "claudeAgent" || !hasLineage(ctx.driverKind)) return ctx;
  if (!parseCliVersion(cliVersion)) return { ...ctx, authoritative: false };
  const tooNew = claudeModelsTooNewFor(cliVersion);
  if (!tooNew.size) return ctx;
  return { ...ctx, offeredIds: ctx.offeredIds.filter((id) => !tooNew.has(id)) };
}

/** A Claude catalog without the rows the detected CLI is too old for.  Other
 *  engines, an unknown version, and custom rows come back unchanged. */
export function withoutModelsTooNewForCli<C extends CatalogLike>(
  driverKind: string,
  models: C,
  cliVersion: string | null | undefined,
): C {
  if (driverKind !== "claudeAgent") return models;
  const tooNew = claudeModelsTooNewFor(cliVersion);
  if (!tooNew.size) return models;
  const options = models.options.filter((option) => Boolean(option.custom) || !tooNew.has(option.id));
  if (options.length === models.options.length) return models;
  const fallbackDefault = options.find((option) => !option.custom)?.id ?? models.default;
  return { ...models, options, default: tooNew.has(models.default) ? fallbackDefault : models.default };
}

/** What `/api/instances` hands every picker (desktop, iOS, the MCP tool):
 *  rows the detected Claude CLI is too old for, superseded and retired rows
 *  removed, and `live` set where "Not in catalog" may be claimed.
 *  Validation and dispatch keep reading the full catalog from the registry,
 *  so a saved older id still resolves. */
export function presentDescribedInstances<
  T extends { driverKind: string; models: CatalogLike; snapshot?: { version?: string | null } },
>(described: T[]): T[] {
  return described.map((instance) => {
    const runnable = withoutModelsTooNewForCli(instance.driverKind, instance.models, instance.snapshot?.version);
    const presented = presentCatalog(instance.driverKind, runnable);
    const live = catalogIsLive(instance.driverKind, instance.models);
    if (presented === instance.models && !live) return instance;
    return { ...instance, models: { ...presented, ...(live ? { live: true } : {}) } };
  });
}

/** Readable model name for notices and errors. */
export function modelNameFor(models: CatalogLike | undefined, id: string): string {
  return models?.options.find((option) => option.id === id)?.label ?? anyLineageLabel(id) ?? id;
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

/** The primary and its fallbacks.  A chain is one flat list (the write path
 *  refuses a fallback's own fallbacks and the store drops any on load,
 *  shared/model-limits.ts), so this is every entry there is. */
function chainEntries(selection: ModelSelection | undefined): ModelSelection[] {
  if (!selection) return [];
  return [selection, ...(selection.fallbacks ?? [])];
}

function slotFor(index: number): string {
  return index === 0 ? "primary" : `fallback ${index}`;
}

function sameTarget(a: ModelSelection, b: ModelSelection): boolean {
  return a.instanceId === b.instanceId && a.model === b.model;
}

/** Whether `entry` is an older member of the class `saved` floats on, on the
 *  same engine: the model a floating slot held before a reconcile resolved it
 *  forward.  Custom ids are the operator's own and never count. */
function staleResolutionOf(
  saved: ModelSelection,
  entry: ModelSelection,
  contextFor: (instanceId: string) => LineageContext | undefined,
): boolean {
  if (!saved.latest || saved.instanceId !== entry.instanceId || saved.model === entry.model) return false;
  const context = contextFor(entry.instanceId);
  if (!context || context.customIds?.includes(entry.model) || context.customIds?.includes(saved.model)) return false;
  const older = classifyModel(context.driverKind, entry.model);
  const resolved = classifyModel(context.driverKind, saved.model);
  return Boolean(
    older &&
      resolved &&
      older.classKey === saved.latest &&
      resolved.classKey === saved.latest &&
      compareRank(resolved.rank, older.rank) > 0,
  );
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
 *  handed a float that belongs to a different place in the chain.
 *
 *  Last, an entry still unpaired is a STALE copy when a saved floating entry
 *  on the same engine has since resolved to a newer member of its class: the
 *  client read the older slug, the server moved the float forward, and the
 *  client wrote its old copy back.  Pairing it keeps the float instead of
 *  pinning the slot to a model the person never picked.  The same place wins
 *  when several saved entries qualify. */
function carryLatestChain(
  incoming: ModelSelection[],
  raws: unknown[],
  saved: ModelSelection[],
  contextFor: (instanceId: string) => LineageContext | undefined,
): ModelSelection[] {
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
  const stale: number[] = [];
  for (const index of open) {
    const entry = incoming[index]!;
    const match = saved.findIndex((candidate, at) => !used.has(at) && sameTarget(candidate, entry));
    if (match < 0) {
      stale.push(index);
      continue;
    }
    used.add(match);
    const from = saved[match]!;
    if (carries(index) && from.latest) out[index] = { ...entry, latest: from.latest };
  }
  for (const index of stale) {
    if (!carries(index)) continue;
    const entry = incoming[index]!;
    const candidates = saved.flatMap((candidate, at) =>
      !used.has(at) && staleResolutionOf(candidate, entry, contextFor) ? [at] : [],
    );
    const at = candidates.includes(index) ? index : candidates[0];
    if (at === undefined) continue;
    used.add(at);
    out[index] = { ...entry, latest: saved[at]!.latest };
  }
  return out;
}

/** Why an explicit `latest` on one entry cannot be honoured, or null.  The
 *  field must name a class this engine has and the model must belong to it
 *  (a retired id counts for its successor class); anything else would be
 *  dropped by the reconcile and saved as a pinned slot, turning a typo into
 *  a successful write with different meaning.
 *
 *  An operator's own custom catalog row never floats: reconcile leaves a
 *  custom id alone, so a `latest` saved on one is a latent float that would
 *  redirect the bot onto the newest OFFICIAL class member the day the custom
 *  row is removed (an id that reads like an official one then counts as a
 *  member), and the picker would label the custom route "Latest <Class>" in
 *  the meantime.  The write is refused rather than saved with a meaning the
 *  person did not pick.
 *
 *  Left alone: an engine the harness does not know (nothing to check
 *  against), and an entry the saved chain already holds exactly (a leftover
 *  must not block editing another slot, custom row or not). */
function latestProblem(
  entry: ModelSelection,
  context: LineageContext | undefined,
  saved: readonly ModelSelection[],
): string | null {
  if (!entry.latest || !context) return null;
  if (saved.some((candidate) => sameTarget(candidate, entry) && candidate.latest === entry.latest)) return null;
  if (context.customIds?.includes(entry.model)) {
    return `cannot apply to custom model "${entry.model}" on instance "${entry.instanceId}" (a custom catalog row stays pinned — drop the latest field)`;
  }
  const classes = lineageClasses(context.driverKind).map((cls) => cls.key);
  if (!classes.includes(entry.latest)) {
    return `is not a model class on instance "${entry.instanceId}"${
      classes.length ? ` (use one of: ${classes.join(", ")})` : " (this engine has no Latest classes)"
    }`;
  }
  const hit = classifyModel(context.driverKind, entry.model);
  const retired = retiredModel(context.driverKind, entry.model);
  if (hit?.classKey !== entry.latest && retired?.successorClass !== entry.latest) {
    return `does not match model "${entry.model}"`;
  }
  return null;
}

/** What a write to ONE TASK's modelSelection is checked against.
 *
 *  A task without an override of its own runs on its bot's selection, so that
 *  selection is the `selection` the lineage check carries a float forward from
 *  and judges "was this id already in the chain?" against.  The fallback cap is
 *  a different question: it grandfathers a chain that is already over the cap
 *  only for the chain being REPLACED, and a task with no override replaces
 *  nothing.  `storedFallbacks` is therefore the task's own override length
 *  (zero when it has none), so a brand-new task override is held to the cap
 *  even when the bot behind it keeps an older, longer chain.
 *
 *  Returns undefined when there is nothing saved to compare with. */
export function taskWriteBaseline(
  taskOverride: ModelSelection | undefined,
  botSelection: ModelSelection | undefined,
): { selection: ModelSelection; busy: false; storedFallbacks: number } | undefined {
  const selection = taskOverride ?? botSelection;
  if (!selection) return undefined;
  return { selection, busy: false, storedFallbacks: taskOverride?.fallbacks?.length ?? 0 };
}

export type LineageWriteResult =
  | { ok: true; selection: ModelSelection; current: ModelSelection | undefined; changes: LineageChange[] }
  | { ok: false; error: string };

/** The lineage half of a modelSelection write.
 *
 *  - Refuses an explicit `latest` that names no class on the engine, does
 *    not match the model, or sits on an operator's custom catalog row.
 *  - Carries `latest` forward for clients that do not send it, including a
 *    stale copy of a model the float has since moved past.
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
  const asked = chainEntries(selection);
  for (let index = 0; index < asked.length; index++) {
    const entry = asked[index]!;
    const problem = latestProblem(entry, contextFor(entry.instanceId), saved);
    if (problem) {
      return { ok: false, error: `modelSelection.latest "${entry.latest}" in ${slotFor(index)} ${problem}` };
    }
  }
  const raws = [raw, ...(selection.fallbacks ?? []).map((_, index) => rawFallback(raw, index))];
  const carried = carryLatestChain(asked, raws, saved, contextFor);
  const incoming: ModelSelection = { ...carried[0]! };
  delete incoming.fallbacks;
  if (selection.fallbacks) incoming.fallbacks = carried.slice(1);
  const unclaimed = [...saved];
  const entries = chainEntries(incoming);
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const context = contextFor(entry.instanceId);
    // A custom catalog row is the operator's own id, even when its text
    // matches a retired official one: reconcile leaves it alone, so the
    // write does too.
    if (context?.customIds?.includes(entry.model)) continue;
    const retired = retiredModel(context?.driverKind, entry.model);
    if (!retired || retired.successorClass !== null) continue;
    // Each saved slot grandfathers ONE incoming copy: a single saved dead
    // target must not cover a second copy of it added in this write.
    const savedAt = unclaimed.findIndex((s) => sameTarget(s, entry));
    if (savedAt >= 0) unclaimed.splice(savedAt, 1);
    else {
      return {
        ok: false,
        error: `retired model "${entry.model}" in ${slotFor(index)} — choose another model`,
      };
    }
  }
  const reconciled = reconcileChain(incoming, contextFor);
  const reconciledCurrent = current ? reconcileChain(current, contextFor).selection : undefined;
  return { ok: true, selection: reconciled.selection, current: reconciledCurrent, changes: reconciled.changes };
}

/** A per-turn override (a fallback or retry pick) reconciled the way a saved
 *  chain is, so a retired or superseded id is never dispatched or recorded.
 *  `freshSession` is true when the reconcile moved the model on an engine
 *  whose native resume keeps the model its session started with (Codex):
 *  resuming the task's old session there would run the old model while the
 *  turn is recorded under the new one. */
export function reconcileTurnOverride(
  selection: ModelSelection,
  context: LineageContext | undefined,
): { selection: ModelSelection; freshSession: boolean } {
  const reconciled = reconcileEntry(selection, context).entry;
  return {
    selection: reconciled,
    freshSession: reconciled.model !== selection.model && resumeKeepsStartedModel(context?.driverKind),
  };
}
