// The explicit table of every tunable, non-secret setting BotFleet knows how
// to consume from the secret store, and the one layer that applies them.
//
// This is the sibling of `secret-map.ts`: that module owns credentials (and
// the handful of endpoint strings that travel with them), while this one owns
// the tunable knobs — intervals, limits, thresholds, sample rates and
// cadences an admin would change without a code deploy.  The two tables share
// one vault snapshot and one rule: for a name the store holds, the store
// wins; underneath, the existing file ordering is untouched.
//
// Knobs are never secrets, so the redaction discipline from `secret-map.ts`
// does not apply here — a knob's value is already visible in Settings and in
// `GET /api/config`.  What this module does keep from its sibling is the
// allowlist: only a name in the table below is ever applied, so a stray row
// in somebody's project can never change how the harness behaves.
//
// Pure data plus pure functions.  The `AppConfig` import is `import type` on
// purpose: `config.ts` imports this module for real, and a value import here
// would close the cycle.
import type { AppConfig } from "./config.ts";

/** One tunable knob BotFleet knows how to consume.
 *
 * `path` is the field path *inside* `section`, so `id` is always
 * `section.path.join(".")` and a 409 refusal, a log line and the status view
 * can all name the same knob with the same string. */
export interface KnobFieldSpec {
  id: string;
  /** Sentence case, for the refusal message and the status view. */
  label: string;
  section: keyof AppConfig;
  path: string[];
  infisicalName: string;
  kind: "int" | "float" | "bool" | "string";
  /** Inclusive bounds applied after parsing; the value is clamped, never
   * rejected, because a knob that fails closed on a typo would rather hold
   * its bound than fall back to a default nobody asked for. */
  min?: number;
  max?: number;
}

/** The canonical map.  A knob that is not here is not managed: it keeps
 * whatever file behaviour it already had, and the vault cannot touch it.
 * There is deliberately no row for the store's own timeouts
 * (`OMB_INFISICAL_CALL_TIMEOUT_MS`, `OMB_INFISICAL_BOOT_TIMEOUT_MS`): they
 * are read before the first login, so the vault they would come from does
 * not exist yet.  See INFISICAL.md for the full inventory and the
 * deliberately-out-of-scope list. */
export const KNOB_FIELDS: readonly KnobFieldSpec[] = [
  {
    id: "jobs.defaultMinutes",
    label: "Default job run limit",
    section: "jobs",
    path: ["defaultMinutes"],
    infisicalName: "BOTFLEET_JOBS_DEFAULT_MINUTES",
    kind: "int",
    min: 1,
    max: 360,
  },
  {
    id: "jobs.maxMinutes",
    label: "Maximum job run limit",
    section: "jobs",
    path: ["maxMinutes"],
    infisicalName: "BOTFLEET_JOBS_MAX_MINUTES",
    kind: "int",
    min: 1,
    max: 360,
  },
  {
    id: "jobs.cpuCores",
    label: "Job CPU cores",
    section: "jobs",
    path: ["cpuCores"],
    infisicalName: "BOTFLEET_JOBS_CPU_CORES",
    kind: "int",
    min: 1,
    max: 64,
  },
  {
    id: "jobs.admission.maxSwapPercent",
    label: "Job admission max swap percent",
    section: "jobs",
    path: ["admission", "maxSwapPercent"],
    infisicalName: "BOTFLEET_JOBS_MAX_SWAP_PERCENT",
    kind: "float",
    min: 1,
    max: 100,
  },
  {
    id: "jobs.admission.minFreeDiskMb",
    label: "Job admission minimum free disk",
    section: "jobs",
    path: ["admission", "minFreeDiskMb"],
    infisicalName: "BOTFLEET_JOBS_MIN_FREE_DISK_MB",
    kind: "float",
    min: 0,
  },
  {
    id: "observability.tracesSampleRate",
    label: "Sentry traces sample rate",
    section: "observability",
    path: ["tracesSampleRate"],
    infisicalName: "BOTFLEET_TRACES_SAMPLE_RATE",
    kind: "float",
    min: 0,
    max: 1,
  },
  {
    id: "observability.aiTracesSampleRate",
    label: "Sentry AI traces sample rate",
    section: "observability",
    path: ["aiTracesSampleRate"],
    infisicalName: "BOTFLEET_AI_TRACES_SAMPLE_RATE",
    kind: "float",
    min: 0,
    max: 1,
  },
  {
    id: "observability.httpTracesSampleRate",
    label: "Sentry HTTP traces sample rate",
    section: "observability",
    path: ["httpTracesSampleRate"],
    infisicalName: "BOTFLEET_HTTP_TRACES_SAMPLE_RATE",
    kind: "float",
    min: 0,
    max: 1,
  },
  {
    id: "observability.uiTracesSampleRate",
    label: "Sentry UI traces sample rate",
    section: "observability",
    path: ["uiTracesSampleRate"],
    infisicalName: "BOTFLEET_UI_TRACES_SAMPLE_RATE",
    kind: "float",
    min: 0,
    max: 1,
  },
  {
    id: "usage.spendCeilingUsd",
    label: "Spend ceiling",
    section: "usage",
    path: ["spendCeilingUsd"],
    infisicalName: "BOTFLEET_SPEND_CEILING_USD",
    kind: "float",
    min: 0,
  },
  {
    id: "usage.spendCeilingMinPricedShare",
    label: "Spend ceiling minimum priced share",
    section: "usage",
    path: ["spendCeilingMinPricedShare"],
    infisicalName: "BOTFLEET_SPEND_CEILING_MIN_PRICED_SHARE",
    kind: "float",
    min: 0,
    max: 1,
  },
  {
    id: "infisical.refreshMinutes",
    label: "Infisical refresh cadence",
    section: "infisical",
    path: ["refreshMinutes"],
    infisicalName: "BOTFLEET_INFISICAL_REFRESH_MINUTES",
    kind: "int",
    min: 5,
    max: 1440,
  },
] as const;

/** Every Infisical name this process will accept as a knob, built once from
 * the table.  `secret-map.ts` unions this into the snapshot filter so one
 * listing carries both credentials and knobs. */
export const KNOB_INFISICAL_NAMES: ReadonlySet<string> = new Set(KNOB_FIELDS.map((spec) => spec.infisicalName));

export type KnobValue = number | boolean | string;

/** Parse one vault string into the knob's kind, clamped to its bounds.
 * Returns `null` when the string is not a value of that kind at all — the
 * caller keeps the existing value and says so loudly, because a knob that
 * fails closed on a typo is a knob nobody can debug. */
export function parseKnobValue(spec: KnobFieldSpec, raw: string): KnobValue | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  let value: KnobValue;
  switch (spec.kind) {
    case "int": {
      const num = Number(text);
      if (!Number.isFinite(num)) return null;
      value = Math.trunc(num);
      break;
    }
    case "float": {
      const num = Number(text);
      if (!Number.isFinite(num)) return null;
      value = num;
      break;
    }
    case "bool": {
      const lower = text.toLowerCase();
      if (lower === "true" || lower === "1" || lower === "yes") value = true;
      else if (lower === "false" || lower === "0" || lower === "no") value = false;
      else return null;
      break;
    }
    case "string": {
      value = text;
      break;
    }
  }
  if (typeof value === "number") {
    if (spec.min !== undefined) value = Math.max(spec.min, value);
    if (spec.max !== undefined) value = Math.min(spec.max, value);
  }
  return value;
}

/** The string the write-through path stores in the vault for a knob value —
 * the same shape `parseKnobValue` reads back, so a save round-trips. */
export function canonicalKnobString(spec: KnobFieldSpec, value: KnobValue): string {
  void spec;
  return typeof value === "boolean" ? (value ? "true" : "false") : String(value);
}

function kindMatches(spec: KnobFieldSpec, value: unknown): value is KnobValue {
  switch (spec.kind) {
    case "int":
      return typeof value === "number" && Number.isInteger(value);
    case "float":
      return typeof value === "number" && Number.isFinite(value);
    case "bool":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
  }
}

/** Read one knob off a config-shaped object, typed.  Returns `undefined`
 * when the field is absent or holds a value of the wrong kind — the schema
 * below this layer is zod-validated, so the wrong-kind case is a caller
 * handing in something unvalidated, not a state the file can be in. */
// SAFETY: `spec.section` is a `keyof AppConfig` from the table above, so
// indexing a plain config object by it reads a declared section and nothing
// else.
export function readKnobField(source: object | undefined, spec: KnobFieldSpec): KnobValue | undefined {
  if (!source) return undefined;
  let node: unknown = (source as Record<string, unknown>)[spec.section];
  for (const key of spec.path) {
    if (!node || typeof node !== "object") return undefined;
    // SAFETY: guarded on the line above.
    node = (node as Record<string, unknown>)[key];
  }
  return kindMatches(spec, node) ? node : undefined;
}

/** Write one knob into a config object, copying each level on the way down
 * exactly as `secret-map.ts`'s `writeField` does: the object handed in may
 * be shared, and a caller elsewhere may still be holding the old section. */
export function writeKnobField(cfg: AppConfig, spec: KnobFieldSpec, value: KnobValue): void {
  // SAFETY: as in `readKnobField` — a plain object indexed by a `keyof
  // AppConfig` that the table above owns, so every key written is a declared
  // section.
  const record = cfg as Record<string, unknown>;
  const existing = record[spec.section];
  const section: Record<string, unknown> =
    // SAFETY: the ternary's own guard proves `existing` is a non-null object.
    existing && typeof existing === "object" ? { ...(existing as Record<string, unknown>) } : {};
  record[spec.section] = section;
  let node = section;
  for (let i = 0; i < spec.path.length - 1; i += 1) {
    const key = spec.path[i];
    const child = node[key];
    const next: Record<string, unknown> =
      // SAFETY: the ternary's own guard proves `child` is a non-null object.
      child && typeof child === "object" ? { ...(child as Record<string, unknown>) } : {};
    node[key] = next;
    node = next;
  }
  node[spec.path[spec.path.length - 1]] = value;
}

/** Delete one knob from a config-shaped object, leaving its section in
 * place.  Used by the write-through tombstone: after the value lands in the
 * vault, this computer keeps no copy — the vault is canonical, and the next
 * resolution reads it back.  Serialised, the dropped key simply disappears
 * from the file. */
export function deleteKnobField(target: object, spec: KnobFieldSpec): void {
  // SAFETY: as in `readKnobField` — a table-driven section and path over a
  // parsed patch.
  let node: unknown = (target as Record<string, unknown>)[spec.section];
  for (const key of spec.path.slice(0, -1)) {
    if (!node || typeof node !== "object") return;
    // SAFETY: guarded on the line above.
    node = (node as Record<string, unknown>)[key];
  }
  if (!node || typeof node !== "object") return;
  // SAFETY: guarded on the line above.
  delete (node as Record<string, unknown>)[spec.path[spec.path.length - 1]];
}

export type KnobSource = "infisical" | "file" | "none";

export interface KnobProvenance {
  id: string;
  source: KnobSource;
  hasValue: boolean;
  /** True when this computer still holds its own copy that the vault overrode. */
  hasLocalCopy: boolean;
}

let provenance: readonly KnobProvenance[] = [];

/** Apply the vault on top of an already-loaded config and record where every
 * mapped knob came from.
 *
 * This runs at the end of `loadConfig()`, right after `resolveSecretFields`,
 * and it is the only place a vault knob value enters the process.  A knob
 * the vault does not hold — or holds as an unparsable string — is left
 * exactly as the file resolved it, and the unparsable case is logged loudly:
 * staleness is safer than an outage, and a silent drop is neither.
 *
 * Runtime reads never touch this function or the vault: they read the
 * resolved `cfg` the same way they always have, which is the whole point —
 * no per-request, per-tick or per-event fetch anywhere in the hot path. */
export function resolveKnobFields(
  cfg: AppConfig,
  snap: ReadonlyMap<string, string> | null,
): KnobProvenance[] {
  const rows: KnobProvenance[] = [];
  for (const spec of KNOB_FIELDS) {
    const local = readKnobField(cfg, spec);
    const vaultRaw = snap?.get(spec.infisicalName);

    let source: KnobSource = local !== undefined ? "file" : "none";
    let hasLocalCopy = false;
    if (typeof vaultRaw === "string" && vaultRaw.trim().length > 0) {
      const parsed = parseKnobValue(spec, vaultRaw);
      if (parsed === null) {
        console.warn(
          `[infisical] ignoring unparsable value for knob ${spec.infisicalName} (field ${spec.id}); keeping configured value`,
        );
      } else {
        writeKnobField(cfg, spec, parsed);
        hasLocalCopy = local !== undefined;
        source = "infisical";
      }
    }
    rows.push({ id: spec.id, source, hasValue: readKnobField(cfg, spec) !== undefined, hasLocalCopy });
  }
  provenance = rows;
  return rows;
}

/** Where each mapped knob came from at the last `loadConfig()`. */
export function knobProvenance(): readonly KnobProvenance[] {
  return provenance;
}

export function knobSource(id: string): KnobSource {
  return provenance.find((row) => row.id === id)?.source ?? "none";
}

/** Take every vault-managed knob back out of a config patch bound for disk,
 * and report which ones were dropped.
 *
 * A last line of defence, not the design — the twin of `stripVaultManagedValues`
 * in `secret-map.ts`.  The design is that the `PUT /api/config` write-through
 * path drops the knob from the patch after the vault write lands; this catches
 * the case where a route hands `saveConfig` the LIVE config object instead,
 * because that object carries every knob value `resolveKnobFields` just wrote
 * into it — and persisting them bakes the vault's values into
 * `~/.botfleet/config.json`, so the file starts shadowing the store it is
 * supposed to defer to.
 *
 * The tombstone here is the deletion itself: knob fields are numbers and
 * booleans, so there is no empty-string marker the way credentials have —
 * the dropped key simply disappears from the file on serialisation. */
export function stripVaultManagedKnobs(patch: Partial<AppConfig>): string[] {
  const stripped: string[] = [];
  for (const spec of KNOB_FIELDS) {
    if (knobSource(spec.id) !== "infisical") continue;
    // SAFETY: `readKnobField` walks `spec.section` then `spec.path` and
    // returns undefined at any missing level, so a partial config is a valid
    // input.
    const value = readKnobField(patch as AppConfig, spec);
    if (value === undefined) continue;
    deleteKnobField(patch, spec);
    stripped.push(spec.id);
  }
  return stripped;
}
