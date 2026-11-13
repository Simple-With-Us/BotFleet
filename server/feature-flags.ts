// Vendor-neutral feature flags for the BotFleet harness.
//
// OpenFeature is the API; the provider is the source of truth.  Today we ship
// a hand-rolled `LocalConfigProvider` that loads `server/feature-flags.json`
// once at init.  Swap to GrowthBook / Hypertune / Cloudflare Flagship later
// by changing one import — call sites keep reading `getBool` / `getString`
// / `getNumber` and never need to know.
//
// Aligns with the observability posture in `docs/observability.md`: the
// module is inert unless the JSON file resolves and a provider has been set.
// Reads before init are queued by the OpenFeature client itself (the SDK's
// `setProvider` flushes pending evaluations), so the typed helpers below can
// be called from any module top-of-file without races.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { OpenFeature, type EvaluationContext, type JsonValue, type Logger, type Provider, type ProviderMetadata, type ResolutionDetails } from "@openfeature/server-sdk";

type FlagVariant = boolean | string | number | JsonValue;
type FlagDefinition = {
  defaultVariant: string;
  variants: Record<string, FlagVariant>;
  disabled?: boolean;
  contextEvaluator?: (ctx: EvaluationContext) => string;
};
type FlagConfig = Record<string, FlagDefinition>;

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FLAGS_PATH = resolve(HERE, "./feature-flags.json");

/** Hand-rolled provider — `LocalConfigProvider`.  Reads its flag table from a
 *  JSON file at construction.  `disabled` falls back to the caller-supplied
 *  default; an unknown flag key also falls back (reason=DEFAULT, matches the
 *  No-op Provider's behavior so the rest of the app stays inert). */
export class LocalConfigProvider implements Provider {
  readonly metadata: ProviderMetadata = { name: "local-config" };
  readonly runsOn = "server" as const;

  private readonly flags: FlagConfig;
  private readonly source: string;

  constructor(flags: FlagConfig, source = "<inline>") {
    this.flags = flags;
    this.source = source;
  }

  static fromFile(path: string = DEFAULT_FLAGS_PATH): LocalConfigProvider {
    const raw = readFileSync(path, "utf8");
    return new LocalConfigProvider(JSON.parse(raw) as FlagConfig, path);
  }

  /** Where the flag table came from — used by the boot log. */
  get sourcePath(): string {
    return this.source;
  }

  private resolve(flagKey: string): { variant: string; value: FlagVariant } | undefined {
    const def = this.flags[flagKey];
    if (!def) return undefined;
    if (def.disabled) return undefined;
    const variant = def.defaultVariant;
    const value = def.variants[variant];
    return { variant, value };
  }

  async resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    _context: EvaluationContext,
    _logger: Logger,
  ): Promise<ResolutionDetails<boolean>> {
    const hit = this.resolve(flagKey);
    if (hit === undefined || typeof hit.value !== "boolean") {
      return { value: defaultValue, reason: "DEFAULT" };
    }
    return { value: hit.value, variant: hit.variant, reason: "STATIC" };
  }
  async resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    _context: EvaluationContext,
    _logger: Logger,
  ): Promise<ResolutionDetails<string>> {
    const hit = this.resolve(flagKey);
    if (hit === undefined || typeof hit.value !== "string") {
      return { value: defaultValue, reason: "DEFAULT" };
    }
    return { value: hit.value, variant: hit.variant, reason: "STATIC" };
  }
  async resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    _context: EvaluationContext,
    _logger: Logger,
  ): Promise<ResolutionDetails<number>> {
    const hit = this.resolve(flagKey);
    if (hit === undefined || typeof hit.value !== "number") {
      return { value: defaultValue, reason: "DEFAULT" };
    }
    return { value: hit.value, variant: hit.variant, reason: "STATIC" };
  }
  async resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    _context: EvaluationContext,
    _logger: Logger,
  ): Promise<ResolutionDetails<T>> {
    const hit = this.resolve(flagKey);
    if (hit === undefined) return { value: defaultValue, reason: "DEFAULT" };
    return { value: hit.value as T, variant: hit.variant, reason: "STATIC" };
  }
}

let installed = false;

/** Install the local provider once.  Subsequent calls are no-ops, so
 *  importing this module from many files is cheap and idempotent. */
export function installLocalConfigProvider(provider: LocalConfigProvider = LocalConfigProvider.fromFile()): void {
  if (installed) return;
  OpenFeature.setProvider(provider);
  installed = true;
}

/** Test-only seam: force a fresh install even when one is already installed,
 *  so a single test file can swap providers across `it` blocks.  Production
 *  code never calls this. */
export function _resetForTests(): void {
  installed = false;
}

/** Read-only snapshot — useful for `/api/feature-flags` later and for tests. */
export function isFeatureFlagsInstalled(): boolean {
  return installed;
}

// --- typed helpers ---------------------------------------------------------
//
// Thin wrappers around the OpenFeature client.  They keep call sites short,
// hide the SDK's Promise shape, and pin the flag key as a string literal at
// the call site rather than letting it leak into business logic.

export async function getBool(key: string, fallback: boolean): Promise<boolean> {
  return OpenFeature.getClient().getBooleanValue(key, fallback);
}
export async function getString(key: string, fallback: string): Promise<string> {
  return OpenFeature.getClient().getStringValue(key, fallback);
}
export async function getNumber(key: string, fallback: number): Promise<number> {
  return OpenFeature.getClient().getNumberValue(key, fallback);
}
// `Logger` is part of the Provider interface signature in OpenFeature; we
// intentionally don't install a custom logger because the harness already
// routes through its own structured logger — wiring a second one would
// double-log every flag miss.
export type { EvaluationContext, Logger };
