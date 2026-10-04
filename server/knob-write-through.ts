// The knob half of the `PUT /api/config` write-through path, factored out of
// `server/index.ts` so the policy is unit-testable without booting the
// harness.  It mirrors the credential flow in that route one-for-one:
//
//   - The store is canonical for the names it holds, so a save of one of
//     those names is never quietly accepted and then reverted by the next
//     resolution.  With Write Through off the request is refused whole and
//     nothing is written; with it on the value goes to the store first and
//     only then is the local copy dropped, so a failed write leaves both
//     sides exactly as they were.
//   - Keyed on "the store CLAIMS this name", not on "the store won the last
//     resolution": provenance only says `infisical` once a snapshot has
//     actually landed, so a boot with the store unreachable would otherwise
//     accept the save to disk and silently revert it on the next refresh.
//   - Collected first, then written, so a failure part-way through can name
//     what already landed.  Each write is a separate upsert: the local
//     config is untouched on failure, but every earlier write is already in
//     the vault.  Saying so is the only way the operator can put it right.
//
// The one deliberate difference from credentials: a knob that lands in the
// vault is tombstoned by DELETING it from the patch, not by writing an empty
// string.  Knob fields are numbers and booleans — an empty string would fail
// the schema on the next load — and a dropped key simply disappears from the
// file on serialisation, which is exactly "this computer keeps no copy".
import type { AppConfig } from "./config.ts";
import {
  KNOB_FIELDS,
  canonicalKnobString,
  deleteKnobField,
  readKnobField,
  type KnobFieldSpec,
  type KnobSource,
  type KnobValue,
} from "./knob-map.ts";

export interface KnobWriteThroughDeps {
  /** Whether the store is enabled in the resolved settings. */
  enabled: boolean;
  /** Whether admin saves write through to the store. */
  writeThrough: boolean;
  /** The store environment, for the refusal message. */
  environment: string;
  /** Enabled, an error on the record, and no successful sync ever: the
   * manager cannot say what it manages, so the save is refused rather than
   * guessed at. */
  unreachable: boolean;
  /** Every name the vault's last listing returned, mapped or not. */
  knownNames: ReadonlySet<string>;
  sourceOf: (id: string) => KnobSource;
  /** `infisical.writeSecret` — the one path that sends a value anywhere. */
  writeSecret: (name: string, value: string) => Promise<void>;
}

export type KnobWriteThroughResult =
  | { ok: true; written: string[] }
  | {
      ok: false;
      /** 409 for a policy refusal, 502 for the store failing to answer,
       * 503 for the store being unreachable. */
      status: 409 | 502 | 503;
      error: string;
      field?: string;
      infisicalName?: string;
      /** Field ids already in the vault when the failure happened.  The
       * caller must reconcile (re-apply the resolved config) before
       * answering, the same way the credential path does. */
      written: string[];
      failed: string[];
    };

/** A value the route layer must not silently swallow: knobs the patch
 * carries for the store's OWN connection settings (`infisical.projectId`,
 * `siteUrl`, `environment`, `secretPath`, `clientId`, `clientSecret`) cannot
 * ride along with a knob write-through, because the write would land in the
 * old project before the connection moves.  `refreshMinutes` is a knob
 * itself and is fine.  The route refuses the combination outright. */
const INFISICAL_CONNECTION_KEYS = new Set([
  "projectId",
  "siteUrl",
  "environment",
  "secretPath",
  "clientId",
  "clientSecret",
]);

export function patchChangesInfisicalConnection(patch: Partial<AppConfig>): boolean {
  const section = patch.infisical;
  if (!section || typeof section !== "object") return false;
  return [...INFISICAL_CONNECTION_KEYS].some((key) => Object.hasOwn(section, key));
}

function managedBySave(
  spec: KnobFieldSpec,
  deps: KnobWriteThroughDeps,
): boolean {
  if (!deps.enabled) return false;
  const alreadyInVault = deps.sourceOf(spec.id) === "infisical" || deps.knownNames.has(spec.infisicalName);
  if (alreadyInVault) return true;
  // With Write Through on, a requested value writes through to the store so
  // it becomes the authoritative source of truth, even for fresh names —
  // the same rule the credential path applies.
  return deps.writeThrough;
}

export async function writeThroughKnobs(
  patch: Partial<AppConfig>,
  deps: KnobWriteThroughDeps,
): Promise<KnobWriteThroughResult> {
  const managed: Array<{ spec: KnobFieldSpec; requested: KnobValue }> = [];
  for (const spec of KNOB_FIELDS) {
    const requested = readKnobField(patch, spec);
    if (requested === undefined) continue;
    if (deps.unreachable) {
      return {
        ok: false,
        status: 503,
        error:
          `Infisical is unreachable, so BotFleet cannot tell whether it manages ${spec.label}.\u00A0 ` +
          `Try again once it answers, or turn Use Infisical off.`,
        field: spec.id,
        infisicalName: spec.infisicalName,
        written: [],
        failed: [spec.id],
      };
    }
    if (!managedBySave(spec, deps)) continue;
    if (!deps.writeThrough) {
      return {
        ok: false,
        status: 409,
        // NBSP + space, not two ASCII spaces: this string is rendered inline
        // in a plain <div> by the cards that can hit it, and HTML collapses a
        // run of ordinary whitespace to one visible space.
        error:
          `${spec.label} is managed by Infisical (${deps.environment}).\u00A0 ` +
          `Change it in Infisical, or turn on Write Through in Settings > Secrets.`,
        field: spec.id,
        infisicalName: spec.infisicalName,
        written: [],
        failed: [spec.id],
      };
    }
    managed.push({ spec, requested });
  }

  const written: string[] = [];
  for (const { spec, requested } of managed) {
    try {
      await deps.writeSecret(spec.infisicalName, canonicalKnobString(spec, requested));
      written.push(spec.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const landed = written.length > 0
        ? `\u00A0 Already written to Infisical: ${written.join(", ")}.\u00A0 Nothing was saved on this computer.`
        : "\u00A0 Nothing was saved.";
      return {
        ok: false,
        status: 502,
        error: `${reason}${landed}`,
        field: spec.id,
        infisicalName: spec.infisicalName,
        written: [...written],
        failed: managed.slice(written.length).map((entry) => entry.spec.id),
      };
    }
  }
  for (const { spec } of managed) deleteKnobField(patch, spec);
  // A section left with nothing but dropped knobs carries no file change at
  // all — drop the section too, otherwise an emptied `jobs: {}` would still
  // trip the provider-reload gate in the route for a save that changed
  // nothing on disk.  Only sections this call actually tombstoned are
  // pruned; a section the client sent empty for its own reasons is left
  // alone.
  if (managed.length > 0) {
    const touched = new Set(managed.map((entry) => entry.spec.section));
    for (const section of touched) {
      const node = (patch as Record<string, unknown>)[section];
      if (node && typeof node === "object" && !Array.isArray(node)) {
        pruneEmptyObjects(node as Record<string, unknown>);
        if (Object.keys(node).length === 0) delete (patch as Record<string, unknown>)[section];
      }
    }
  }
  return { ok: true, written };
}

/** Delete every empty plain-object child, recursively.  Used only on
 * sections the write-through above just tombstoned: a knob save that left
 * `jobs.admission` holding nothing must not leave the husks behind. */
function pruneEmptyObjects(node: Record<string, unknown>): void {
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (child && typeof child === "object" && !Array.isArray(child)) {
      const record = child as Record<string, unknown>;
      pruneEmptyObjects(record);
      if (Object.keys(record).length === 0) delete node[key];
    }
  }
}
