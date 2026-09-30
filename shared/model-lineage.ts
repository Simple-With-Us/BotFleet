// Model lineage: the one source of truth for which saved model ids belong to
// the same "class" (Claude Sonnet, GPT Luna, Grok, ...), which member of a
// class is newest, which ids are retired outright, and how a saved selection
// moves forward when a newer member ships.
//
// Pure and dependency-free so the harness (write-time checks, the load
// migration, dispatch-time resolution) and the app (the model picker's
// "Latest <Class>" rows, hidden superseded rows, Retired badges) read the
// same table.
//
// Owner rules this module encodes (board row da11b074):
//   - A superseded model must not be selectable.  Within a class only the
//     newest member offered by the instance's catalog is shown, plus a
//     floating "Latest <Class>" choice.
//   - A saved selection may be REWRITTEN to a newer member of its class.  It
//     is never ALIASED: recorded usage, per-model stats, and every message
//     row keep the real slug that ran (docs/rollouts/2026-09-18-latest-model-ids.md,
//     server/drivers/model-discovery.ts).  Nothing here maps one id onto
//     another for attribution.
//   - Automatic moves go forward only when the newer member's blended list
//     price is within 25% of the saved one.  When either price is unknown,
//     a subscription CLI engine moves on the class match alone (the plan,
//     not the token, is what the owner pays for); an API-key engine stays.
//
// A floating selection is stored as `{ model: <resolved slug>, latest:
// <class key> }`.  `model` is ALWAYS a real slug: every driver, recorded row,
// usage bucket, and older client (the iOS app decodes only instanceId /
// model / effort / fallbacks) sees the model that actually runs.  `latest`
// only says "keep `model` pointed at the newest member of this class".

/** List price in USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
}

export interface ModelClassInfo {
  /** Stored on `ModelSelection.latest`, e.g. "sonnet". */
  key: string;
  /** Noun for the picker row, e.g. "Sonnet" -> "Latest Sonnet". */
  label: string;
}

/** Structural selection shape shared by the harness and the app. */
export interface LineageSelection {
  instanceId: string;
  model: string;
  effort?: string;
  latest?: string;
  fallbacks?: LineageSelection[];
}

interface Classified {
  classKey: string;
  /** Version tuple, compared element by element; a missing element is 0. */
  rank: number[];
}

interface Family {
  id: string;
  classes: readonly ModelClassInfo[];
  classify(id: string): Classified | null;
  /** Readable label for an id this family classifies. */
  label(id: string, classified: Classified): string;
  /** Keyed `${classKey}@${rank.join(".")}`. */
  prices?: Readonly<Record<string, ModelPrice>>;
  /** Retired ids: the value is the successor class, or null when nothing
   *  replaces it (a write that introduces one is refused). */
  retired?: Readonly<Record<string, string | null>>;
}

function num(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}

function rankOf(...parts: Array<number | undefined>): number[] {
  const rank: number[] = [];
  for (const part of parts) {
    if (part === undefined) break;
    rank.push(part);
  }
  return rank;
}

function versionText(rank: readonly number[]): string {
  return rank.join(".");
}

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// ── Claude ───────────────────────────────────────────────────────────────
// Current ids: claude-<class>-<major>[-<minor>][-<yyyymmdd>]  (claude-sonnet-5-5,
// claude-haiku-4-5-20251001).  Legacy ids: claude-<major>[-<minor>]-<class>
// [-<yyyymmdd>|-latest]  (claude-3-7-sonnet, claude-3-5-haiku-latest).  A dated
// id ranks equal to its undated twin, so neither supersedes the other.
const CLAUDE_CURRENT = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:[-.](\d{1,2}))?(?:-\d{8})?$/;
const CLAUDE_LEGACY = /^claude-(\d+)(?:[-.](\d{1,2}))?-(opus|sonnet|haiku)(?:-(?:\d{8}|latest))?$/;

const CLAUDE: Family = {
  id: "claude",
  classes: [
    { key: "fable", label: "Fable" },
    { key: "opus", label: "Opus" },
    { key: "sonnet", label: "Sonnet" },
    { key: "haiku", label: "Haiku" },
  ],
  classify(id) {
    const current = CLAUDE_CURRENT.exec(id);
    if (current) return { classKey: current[1]!, rank: rankOf(num(current[2]), num(current[3])) };
    const legacy = CLAUDE_LEGACY.exec(id);
    if (legacy) return { classKey: legacy[3]!, rank: rankOf(num(legacy[1]), num(legacy[2])) };
    return null;
  },
  label(_id, c) {
    return `Claude ${titleCase(c.classKey)} ${versionText(c.rank)}`;
  },
  // Anthropic first-party list prices (claude-api reference, cached
  // 2026-09-25).  Sonnet 5 -> 5.5 is flat and Opus 5 -> 5.5 is 20% cheaper,
  // so both move automatically; Sonnet 4.6 -> 5.5 is 33% cheaper and would
  // not, which is why the owner directive below floats every Sonnet anyway.
  prices: {
    "fable@5.1": { input: 10, output: 50 },
    "fable@5": { input: 10, output: 50 },
    "opus@5.5": { input: 4, output: 20 },
    "opus@5": { input: 5, output: 25 },
    "opus@4.8": { input: 5, output: 25 },
    "opus@4.7": { input: 5, output: 25 },
    "opus@4.6": { input: 5, output: 25 },
    "sonnet@5.5": { input: 2, output: 10 },
    "sonnet@5": { input: 2, output: 10 },
    "sonnet@4.6": { input: 3, output: 15 },
    "haiku@4.5": { input: 1, output: 5 },
  },
  // Verified dead at the provider: every Deployer turn on it failed with
  // "There's an issue with the selected model (claude-3-7-sonnet)".
  retired: {
    "claude-3-7-sonnet": "sonnet",
  },
};

// ── GPT (Codex) ──────────────────────────────────────────────────────────
// gpt-<major>[.<minor>]-<class>.  Plain ids (gpt-5.5) and specialised ones
// (gpt-5.3-codex-spark) are left unclassified: they have no line to move on.
const GPT_CLASSED = /^gpt-(\d+)(?:\.(\d+))?-(astra|sol|terra|luna)$/;

const GPT: Family = {
  id: "gpt",
  classes: [
    { key: "astra", label: "Astra" },
    { key: "sol", label: "Sol" },
    { key: "terra", label: "Terra" },
    { key: "luna", label: "Luna" },
  ],
  classify(id) {
    const m = GPT_CLASSED.exec(id);
    return m ? { classKey: m[3]!, rank: rankOf(num(m[1]), num(m[2])) } : null;
  },
  label(_id, c) {
    return `GPT-${versionText(c.rank)} ${titleCase(c.classKey)}`;
  },
  // No list prices: these ride a ChatGPT subscription, so the class match
  // decides (see withinPriceBand).
};

// ── Grok ─────────────────────────────────────────────────────────────────
const GROK_PLAIN = /^grok-(\d+)(?:\.(\d+))?$/;
const GROK_BUILD_FAST = /^grok-(\d+)(?:\.(\d+))?-build-fast$/;

const GROK: Family = {
  id: "grok",
  classes: [
    { key: "grok", label: "Grok" },
    { key: "grok-build-fast", label: "Grok Build Fast" },
  ],
  classify(id) {
    const plain = GROK_PLAIN.exec(id);
    if (plain) return { classKey: "grok", rank: rankOf(num(plain[1]), num(plain[2])) };
    const fast = GROK_BUILD_FAST.exec(id);
    if (fast) return { classKey: "grok-build-fast", rank: rankOf(num(fast[1]), num(fast[2])) };
    return null;
  },
  label(_id, c) {
    return c.classKey === "grok" ? `Grok ${versionText(c.rank)}` : `Grok ${versionText(c.rank)} Build Fast`;
  },
  // xAI API list prices, from the `grok` engine's table in
  // src/lib/engine-capabilities.tsx (under-200k-token tier): Grok 4.7 is
  // $2 input / $6 output, and xAI's grok-4.6 card has the same rates.  Only
  // the API-key `grok` engine is decided by them; a subscription engine with
  // an unpriced side still moves on the class match.  Grok 4.5 and the Build
  // Fast line have no list price in the repo, so none is guessed here.
  prices: {
    "grok@4.7": { input: 2, output: 6 },
    "grok@4.6": { input: 2, output: 6 },
  },
  // Owner, 2026-09-30: "Grok 4.5 and 4.6 shouldn't be visible options and
  // anything on that should go to Grok 4.7."  grok-3-mini left the xAI
  // catalog with docs/rollouts/2026-09-18-latest-model-ids.md and has no
  // successor class here.
  retired: {
    "grok-4.5": "grok",
    "grok-4.6": "grok",
    "grok-3-mini": null,
  },
};

interface DriverLineage {
  families: readonly Family[];
  /** A subscription CLI engine: with no price for either side, a newer
   *  member of the same class is taken on the class match alone. */
  subscription: boolean;
}

// Keyed by driverKind, because one class ("Sonnet") can be reached through
// several engines and each engine's own catalog decides what it offers.
//
// TODO(model-lineage): minimax, mcodeAgent and dshAgent (DeepSeek Harness)
// are deliberately absent.  Their catalogs are owned by the MiniMax/Harness
// lanes (PR #729, the harness-dsh-ids lane), and the DeepSeek V4.1 ids are
// not yet proven accepted on this Mac, so migrating onto them could turn a
// working saved slot into a rejected one.  Add a family here once those
// successors are verified live; nothing else needs to change.
const DRIVER_LINEAGE: Readonly<Record<string, DriverLineage>> = {
  claudeAgent: { families: [CLAUDE], subscription: true },
  codex: { families: [GPT], subscription: true },
  grokAgent: { families: [GROK], subscription: true },
  grok: { families: [GROK], subscription: false },
  droidAgent: { families: [CLAUDE, GPT, GROK], subscription: true },
};

/** Owner-directed, one-time move (2026-09-30): every saved selection in
 *  these classes becomes the floating "Latest <Class>" choice.  Retired ids
 *  with a successor are floated by every reconcile pass, not only this one. */
export const OWNER_DIRECTED_LATEST = {
  id: "2026-09-30-latest-sonnet-luna",
  classKeys: ["sonnet", "luna"] as readonly string[],
};

/** Automatic moves are allowed when the blended list price changes by at
 *  most this fraction. */
export const PRICE_BAND = 0.25;

export function hasLineage(driverKind: string | undefined): boolean {
  return Boolean(driverKind && DRIVER_LINEAGE[driverKind]);
}

function familyFor(driverKind: string | undefined, id: string): { family: Family; classified: Classified } | null {
  if (!driverKind || !id || id.includes("::")) return null;
  const lineage = DRIVER_LINEAGE[driverKind];
  if (!lineage) return null;
  for (const family of lineage.families) {
    const classified = family.classify(id);
    if (classified) return { family, classified };
  }
  return null;
}

export interface ModelLineageInfo {
  classKey: string;
  classLabel: string;
  rank: readonly number[];
  label: string;
}

/** Which class an id belongs to on this engine, or null. */
export function classifyModel(driverKind: string | undefined, id: string): ModelLineageInfo | null {
  const hit = familyFor(driverKind, id);
  if (!hit) return null;
  const info = hit.family.classes.find((c) => c.key === hit.classified.classKey);
  return {
    classKey: hit.classified.classKey,
    classLabel: info?.label ?? titleCase(hit.classified.classKey),
    rank: hit.classified.rank,
    label: hit.family.label(id, hit.classified),
  };
}

/** Classes this engine knows, in picker order. */
export function lineageClasses(driverKind: string | undefined): ModelClassInfo[] {
  const lineage = driverKind ? DRIVER_LINEAGE[driverKind] : undefined;
  return lineage ? lineage.families.flatMap((family) => [...family.classes]) : [];
}

export function classLabel(driverKind: string | undefined, classKey: string): string | undefined {
  return lineageClasses(driverKind).find((c) => c.key === classKey)?.label;
}

/** `{ successorClass }` when the id is explicitly retired on this engine
 *  (`successorClass` null = nothing replaces it); null when it is not. */
export function retiredModel(
  driverKind: string | undefined,
  id: string,
): { successorClass: string | null } | null {
  if (!driverKind || !id) return null;
  const lineage = DRIVER_LINEAGE[driverKind];
  if (!lineage) return null;
  for (const family of lineage.families) {
    if (family.retired && Object.hasOwn(family.retired, id)) {
      return { successorClass: family.retired[id] ?? null };
    }
  }
  return null;
}

export function compareRank(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Newest member of a class among `offeredIds` (catalog order breaks a
 *  tie, so a dated twin never displaces the row the engine lists first). */
export function newestInClass(
  driverKind: string | undefined,
  classKey: string,
  offeredIds: readonly string[],
): string | undefined {
  let best: { id: string; rank: readonly number[] } | undefined;
  for (const id of offeredIds) {
    if (retiredModel(driverKind, id)) continue;
    const hit = familyFor(driverKind, id);
    if (!hit || hit.classified.classKey !== classKey) continue;
    if (!best || compareRank(hit.classified.rank, best.rank) > 0) best = { id, rank: hit.classified.rank };
  }
  return best?.id;
}

/** List price for an id, when this table knows it. */
export function modelPrice(driverKind: string | undefined, id: string): ModelPrice | undefined {
  const hit = familyFor(driverKind, id);
  if (!hit?.family.prices) return undefined;
  return hit.family.prices[`${hit.classified.classKey}@${versionText(hit.classified.rank)}`];
}

/** 3:1 input:output blend, the usual shape of an agent turn. */
export function blendedPrice(price: ModelPrice): number {
  return (3 * price.input + price.output) / 4;
}

/** Whether the blended price moves by at most PRICE_BAND, either way.  A
 *  change of exactly 25% is inside the band. */
export function pricesWithinBand(from: ModelPrice, to: ModelPrice): boolean {
  const base = blendedPrice(from);
  if (base <= 0) return false;
  return Math.abs(blendedPrice(to) - base) / base <= PRICE_BAND + 1e-9;
}

/** Whether moving `from` -> `to` on this engine stays inside the owner's
 *  25% band.  Unknown prices: a subscription CLI engine moves on the class
 *  match; an API-key engine does not. */
export function withinPriceBand(driverKind: string | undefined, from: string, to: string): boolean {
  const a = modelPrice(driverKind, from);
  const b = modelPrice(driverKind, to);
  if (a && b) return pricesWithinBand(a, b);
  return Boolean(driverKind && DRIVER_LINEAGE[driverKind]?.subscription);
}

interface CatalogOption {
  id: string;
  custom?: unknown;
}

function officialIds(options: readonly CatalogOption[]): string[] {
  return options.filter((option) => !option.custom).map((option) => option.id);
}

/** Whether a catalog row is hidden from pickers: a retired id, or an older
 *  member of a class whose newer member the same catalog offers.  Custom
 *  and local rows are the operator's own and are never hidden. */
export function isSupersededInCatalog(
  driverKind: string | undefined,
  id: string,
  offeredIds: readonly string[],
): boolean {
  if (retiredModel(driverKind, id)) return true;
  const hit = familyFor(driverKind, id);
  if (!hit) return false;
  const newest = newestInClass(driverKind, hit.classified.classKey, offeredIds);
  if (!newest || newest === id) return false;
  const newestHit = familyFor(driverKind, newest);
  return Boolean(newestHit && compareRank(newestHit.classified.rank, hit.classified.rank) > 0);
}

/** The catalog a picker should show: superseded and retired official rows
 *  removed, and a default that pointed at one of them moved to the newest
 *  member of its class.  Engines with no lineage come back unchanged. */
export function presentCatalog<O extends CatalogOption, C extends { default: string; options: O[] }>(
  driverKind: string | undefined,
  catalog: C,
): C {
  if (!hasLineage(driverKind)) return catalog;
  const offered = officialIds(catalog.options);
  const options = catalog.options.filter(
    (option) => Boolean(option.custom) || !isSupersededInCatalog(driverKind, option.id, offered),
  );
  if (options.length === catalog.options.length) return catalog;
  let fallbackDefault = catalog.default;
  if (!options.some((option) => option.id === catalog.default)) {
    const hit = familyFor(driverKind, catalog.default);
    const retired = retiredModel(driverKind, catalog.default);
    const classKey = retired?.successorClass ?? hit?.classified.classKey;
    fallbackDefault =
      (classKey ? newestInClass(driverKind, classKey, offered) : undefined) ?? options[0]?.id ?? catalog.default;
  }
  return { ...catalog, default: fallbackDefault, options };
}

export interface LatestOption {
  classKey: string;
  /** "Latest Sonnet" */
  label: string;
  /** The slug a turn would run right now. */
  resolvedId: string;
}

/** One "Latest <Class>" choice per class this catalog offers a member of. */
export function latestOptions(driverKind: string | undefined, options: readonly CatalogOption[]): LatestOption[] {
  const offered = officialIds(options);
  const out: LatestOption[] = [];
  for (const cls of lineageClasses(driverKind)) {
    const resolvedId = newestInClass(driverKind, cls.key, offered);
    if (resolvedId) out.push({ classKey: cls.key, label: `Latest ${cls.label}`, resolvedId });
  }
  return out;
}

/** Readable label for a lineage-classified id (display only). */
export function lineageLabel(driverKind: string | undefined, id: string): string | undefined {
  return classifyModel(driverKind, id)?.label;
}

/** Readable label for a Claude, GPT, or Grok id on any engine: the label a
 *  saved id falls back to once it is no longer in a picker catalog.
 *  Display only — it never validates, routes, or rewrites. */
export function anyLineageLabel(id: string): string | undefined {
  for (const family of [CLAUDE, GPT, GROK]) {
    const classified = family.classify(id);
    if (classified) return family.label(id, classified);
  }
  return undefined;
}

// ── reconcile ────────────────────────────────────────────────────────────

/** What a reconcile pass knows about one instance. */
export interface LineageContext {
  driverKind: string;
  /** Official (non-custom) ids the instance's catalog offers right now. */
  offeredIds: readonly string[];
  /** The catalog is the engine's authoritative answer (a live listing, or
   *  a static list that IS the product's source of truth).  A static
   *  fallback that may not match the account is not: nothing is moved or
   *  resolved against it. */
  authoritative: boolean;
  /** Effort levels the given model accepts; an effort it does not accept
   *  is dropped when a rewrite changes the model.  Omit to keep effort. */
  effortLevels?: (model: string) => readonly string[] | undefined;
}

export type LineageChangeReason = "latest" | "retired" | "superseded" | "owner";

export interface LineageChange {
  /** "primary" or "fallback N" (1-based, as the settings UI numbers them). */
  slot: string;
  instanceId: string;
  from: string;
  to: string;
  /** Class the entry now floats on, when it floats. */
  latest?: string;
  reason: LineageChangeReason;
}

function slotName(index: number): string {
  return index < 0 ? "primary" : `fallback ${index + 1}`;
}

function withModel<S extends LineageSelection>(entry: S, model: string, ctx: LineageContext, latest?: string): S {
  const next: S = { ...entry, model };
  if (latest) next.latest = latest;
  else delete next.latest;
  if (entry.effort !== undefined && model !== entry.model && ctx.effortLevels) {
    const allowed = ctx.effortLevels(model);
    if (allowed && !allowed.includes(entry.effort)) delete next.effort;
  }
  return next;
}

/** Reconcile one entry (no fallbacks) against its instance. */
export function reconcileEntry<S extends LineageSelection>(
  entry: S,
  ctx: LineageContext | undefined,
  slot = "primary",
): { entry: S; change?: LineageChange } {
  if (!ctx || !hasLineage(ctx.driverKind) || !entry.model) {
    // No lineage for this engine: a stray `latest` has nothing to float on.
    if (entry.latest !== undefined && ctx && !hasLineage(ctx.driverKind)) {
      const next = { ...entry };
      delete next.latest;
      return { entry: next };
    }
    return { entry };
  }
  const { driverKind } = ctx;
  const hit = classifyModel(driverKind, entry.model);

  if (entry.latest !== undefined) {
    const known = lineageClasses(driverKind).some((c) => c.key === entry.latest);
    // An explicit pick of a model outside the floating class wins: an older
    // client that carries `latest` through while the person chose another
    // model must not be dragged back onto the class.
    const retired = retiredModel(driverKind, entry.model);
    const sameClass = hit?.classKey === entry.latest || retired?.successorClass === entry.latest;
    if (!known || !sameClass) {
      const next = { ...entry };
      delete next.latest;
      return reconcileEntry(next, ctx, slot);
    }
    if (!ctx.authoritative) return { entry };
    const newest = newestInClass(driverKind, entry.latest, ctx.offeredIds);
    if (!newest || newest === entry.model) return { entry };
    return {
      entry: withModel(entry, newest, ctx, entry.latest),
      change: { slot, instanceId: entry.instanceId, from: entry.model, to: newest, latest: entry.latest, reason: "latest" },
    };
  }

  const retired = retiredModel(driverKind, entry.model);
  if (retired) {
    if (!retired.successorClass || !ctx.authoritative) return { entry };
    const newest = newestInClass(driverKind, retired.successorClass, ctx.offeredIds);
    if (!newest) return { entry };
    return {
      entry: withModel(entry, newest, ctx, retired.successorClass),
      change: {
        slot,
        instanceId: entry.instanceId,
        from: entry.model,
        to: newest,
        latest: retired.successorClass,
        reason: "retired",
      },
    };
  }

  if (!hit || !ctx.authoritative) return { entry };
  const newest = newestInClass(driverKind, hit.classKey, ctx.offeredIds);
  if (!newest || newest === entry.model) return { entry };
  const newestHit = classifyModel(driverKind, newest);
  if (!newestHit || compareRank(newestHit.rank, hit.rank) <= 0) return { entry };
  if (!withinPriceBand(driverKind, entry.model, newest)) return { entry };
  return {
    entry: withModel(entry, newest, ctx),
    change: { slot, instanceId: entry.instanceId, from: entry.model, to: newest, reason: "superseded" },
  };
}

function sameTarget(a: LineageSelection, b: LineageSelection): boolean {
  return a.instanceId === b.instanceId && a.model === b.model;
}

/** Reconcile a whole chain: the primary and every fallback.  A fallback
 *  that the pass made identical to the primary is dropped; one that already
 *  matched it (the settings UI seeds a new fallback from the primary as a
 *  placeholder) is left alone. */
export function reconcileChain<S extends LineageSelection>(
  selection: S,
  contextFor: (instanceId: string) => LineageContext | undefined,
): { selection: S; changes: LineageChange[] } {
  const changes: LineageChange[] = [];
  const primary = reconcileEntry({ ...selection, fallbacks: undefined }, contextFor(selection.instanceId), "primary");
  if (primary.change) changes.push(primary.change);
  const next = { ...primary.entry } as S;
  delete next.fallbacks;
  if (selection.fallbacks) {
    const fallbacks: LineageSelection[] = [];
    selection.fallbacks.forEach((fallback, index) => {
      const result = reconcileEntry(fallback, contextFor(fallback.instanceId), slotName(index));
      if (result.change) changes.push(result.change);
      const becameDuplicate =
        sameTarget(result.entry, next) &&
        !sameTarget(fallback, selection) &&
        (Boolean(result.change) || Boolean(primary.change));
      if (becameDuplicate) {
        changes.push({
          slot: slotName(index),
          instanceId: fallback.instanceId,
          from: fallback.model,
          to: "",
          reason: result.change?.reason ?? "superseded",
        });
        return;
      }
      fallbacks.push(result.entry);
    });
    if (fallbacks.length) next.fallbacks = fallbacks as S["fallbacks"];
  }
  return { selection: next, changes };
}

/** The owner-directed flags: every entry in an OWNER_DIRECTED_LATEST class
 *  starts floating.  `model` is left for reconcileChain to resolve against
 *  the instance's catalog. */
export function applyOwnerDirective<S extends LineageSelection>(
  selection: S,
  driverKindFor: (instanceId: string) => string | undefined,
): { selection: S; flagged: LineageChange[] } {
  const flagged: LineageChange[] = [];
  const flag = <E extends LineageSelection>(entry: E, slot: string): E => {
    if (entry.latest !== undefined) return entry;
    const driverKind = driverKindFor(entry.instanceId);
    const hit = classifyModel(driverKind, entry.model);
    if (!hit || !OWNER_DIRECTED_LATEST.classKeys.includes(hit.classKey)) return entry;
    flagged.push({ slot, instanceId: entry.instanceId, from: entry.model, to: entry.model, latest: hit.classKey, reason: "owner" });
    return { ...entry, latest: hit.classKey };
  };
  const next = flag({ ...selection }, "primary");
  if (selection.fallbacks) {
    next.fallbacks = selection.fallbacks.map((fallback, index) => flag({ ...fallback }, slotName(index))) as S["fallbacks"];
  }
  return { selection: next, flagged };
}

export type LineageStatusKind = "ok" | "retired" | "superseded" | "not-in-catalog";

export interface LineageStatus {
  kind: LineageStatusKind;
  /** What "Switch to" would pick, when something can replace it. */
  successor?: { model: string; latest?: string };
}

/** How a saved id stands against an instance's (presented) catalog, for
 *  the picker badge.  "not-in-catalog" is reported only when the caller
 *  says the catalog is live, so a static fallback never flags a model the
 *  account can actually use. */
export function lineageStatus(
  driverKind: string | undefined,
  id: string,
  options: readonly CatalogOption[],
  live: boolean,
): LineageStatus {
  if (!id || id.includes("::")) return { kind: "ok" };
  if (options.some((option) => option.id === id)) return { kind: "ok" };
  const offered = officialIds(options);
  const retired = retiredModel(driverKind, id);
  if (retired) {
    const model = retired.successorClass ? newestInClass(driverKind, retired.successorClass, offered) : undefined;
    return {
      kind: "retired",
      ...(model ? { successor: { model, latest: retired.successorClass ?? undefined } } : {}),
    };
  }
  const hit = classifyModel(driverKind, id);
  const newest = hit ? newestInClass(driverKind, hit.classKey, offered) : undefined;
  const newestHit = newest ? classifyModel(driverKind, newest) : null;
  if (hit && newest && newestHit && compareRank(newestHit.rank, hit.rank) > 0) {
    return { kind: "superseded", successor: { model: newest, latest: hit.classKey } };
  }
  if (live && offered.length > 0) {
    // A class member the live catalog does not offer (a static-fallback
    // GPT-6 Luna on an account whose live catalog has GPT-5.6 Luna) can
    // still float on the class the account does have.
    return hit && newest
      ? { kind: "not-in-catalog", successor: { model: newest, latest: hit.classKey } }
      : { kind: "not-in-catalog" };
  }
  return { kind: "ok" };
}

/** One-line transcript notice for a bot whose saved models moved, or null
 *  when nothing a person would notice changed.  `changes` are the reconcile
 *  records for this chain; the only thing read from them is which fallback
 *  slots were dropped, so the saved and rewritten chains can be paired. */
export function lineageNotice(
  before: LineageSelection,
  after: LineageSelection,
  changes: readonly LineageChange[],
  driverKindFor: (instanceId: string) => string | undefined,
  nameFor: (instanceId: string, model: string) => string,
): string | null {
  const describe = (entry: LineageSelection): string => {
    const name = nameFor(entry.instanceId, entry.model);
    if (!entry.latest) return name;
    const noun = classLabel(driverKindFor(entry.instanceId), entry.latest) ?? entry.latest;
    return `Latest ${noun} (${name})`;
  };
  const dropped = new Set(changes.filter((change) => change.to === "").map((change) => change.slot));
  const parts: string[] = [];
  const note = (slot: string, from: LineageSelection, to: LineageSelection) => {
    if (from.instanceId === to.instanceId && from.model === to.model && (from.latest ?? "") === (to.latest ?? "")) return;
    parts.push(`${slot} ${describe(from)} → ${describe(to)}`);
  };
  note("primary", before, after);
  const survivors = after.fallbacks ?? [];
  let next = 0;
  (before.fallbacks ?? []).forEach((fallback, index) => {
    const slot = slotName(index);
    if (dropped.has(slot)) {
      parts.push(`${slot} ${nameFor(fallback.instanceId, fallback.model)} removed (now the same as the primary)`);
      return;
    }
    const survivor = survivors[next++];
    if (survivor) note(slot, fallback, survivor);
  });
  if (!parts.length) return null;
  return `Model update: ${parts.join(" · ")}`;
}
