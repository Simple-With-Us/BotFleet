/**
 * DSH ACP driver — BotFleet runtime composed with the Harness engine shape.
 *
 * Engine catalog, version gate, error classifier, and model-id round-trip
 * live in `jaywedgeworth22/Harness` (`harness/dsh/acp`).  This file keeps
 * `wrapSpawn` and `createAcpDriver` here because they need BotFleet's ACP
 * core and the Node stdio bridge.  Edit engine shape in Harness, not here.
 */
import {
  STATIC_DSH_MODELS as harnessDshModels,
  DSH_MINIMUM_ACP_VERSION,
  DSH_PROVIDER_ID,
  DSH_MINIMAX_PROVIDER_ID,
  classifyDshError,
  dshCredentialCandidates,
  dshModelIdFromOptionValue,
  dshModelOptionValue,
  dshProviderForModel,
  dshSpawnArgs as harnessDshSpawnArgs,
  dshSupport as harnessDshSupport,
  dshVersionCompatibilityReason,
} from "harness/dsh/acp";

import type { ModelCatalog, ProviderErrorCode, SendTurnInput } from "../../contracts.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./core.ts";
import { dshWrapSpawn } from "./dsh-mcp.ts";

export { dshWrapSpawn, isStockDshCli } from "./dsh-mcp.ts";
/** BotFleet DSH model catalog.  The Harness package still publishes
 * MiniMax-M2.7, but it is dropped here per the product decision (M3 dominates
 * on context and is the canonical DSH-hosted MiniMax row). */
export const STATIC_DSH_MODELS: ModelCatalog = {
  ...harnessDshModels,
  options: harnessDshModels.options.filter((option) => option.id !== "MiniMax-M2.7"),
};

/** Models the product keeps out of the picker even when the installed
 *  Harness offers them.  Same expression that builds STATIC_DSH_MODELS, so
 *  the live read below and the static fallback agree on what is excluded. */
const DSH_EXCLUDED_MODEL_IDS = ["MiniMax-M2.7"] as const;

/** The Harness install declares the models it can actually serve in its own
 *  settings file, under a provider map at `llm-pi-ai.providers.<id>.models[]`
 *  with `id` / `name` / `contextWindow`.  That file is the real source of truth
 *  for "what can this DSH run right now" — the catalog compiled into the Harness
 *  package goes stale the moment the owner edits a profile or the package is
 *  pinned to an older release.  Reading it is the same move claude.ts makes
 *  against `~/.claude/settings.json`.
 *
 *  Note the file is *partial*: a profile that configures only the MiniMax
 *  provider still leaves the DeepSeek rows reachable, so this unions rather
 *  than replaces.  See `readDshModelCatalog` and the note there. */
function readDshSettingsPath(environment: Record<string, string | undefined>): string {
  // `environment.HOME` first, not `homedir()`: the ACP core hands this the
  // child environment it will actually spawn the CLI with, so a relocated or
  // test-scoped home has to be honored.  `homedir()` reads the real process
  // home and would silently ignore both.
  const home = environment.DSH_HOME?.trim()
    || environment.HOME?.trim()
    || homedir();
  return join(home, ".dsh", "settings.yaml");
}

/** Every provider map in the document, most specific first.  The live shape
 *  nests it at `llm-pi-ai.providers`; a top-level `providers` is accepted too
 *  so a profile written that way still works. */
function providerMapsIn(settings: unknown): Record<string, unknown>[] {
  if (!settings || typeof settings !== "object") return [];
  const root = settings as Record<string, unknown>;
  const maps: Record<string, unknown>[] = [];
  const llm = root["llm-pi-ai"];
  const nested = llm && typeof llm === "object" ? (llm as Record<string, unknown>).providers : undefined;
  if (nested && typeof nested === "object") maps.push(nested as Record<string, unknown>);
  if (root.providers && typeof root.providers === "object") maps.push(root.providers as Record<string, unknown>);
  return maps;
}

function modelRowsFromSettings(settings: unknown): ModelCatalog["options"] {
  const rows: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  for (const providers of providerMapsIn(settings)) {
    for (const provider of Object.values(providers)) {
      const models = (provider as { models?: unknown } | null)?.models;
      if (!Array.isArray(models)) continue;
      for (const entry of models) {
        if (!entry || typeof entry !== "object") continue;
        const row = entry as { id?: unknown; name?: unknown; contextWindow?: unknown };
        const id = typeof row.id === "string" ? row.id : "";
        if (!id || seen.has(id)) continue;
        seen.add(id);
        if ((DSH_EXCLUDED_MODEL_IDS as readonly string[]).includes(id)) continue;
        const previous = STATIC_DSH_MODELS.options.find((option) => option.id === id);
        const providedName = typeof row.name === "string" && row.name.trim() ? row.name : "";
        rows.push({
          id,
          // Hand-written copy wins over the settings file's own name.
          label: previous?.label ?? providedName ?? id,
          ...(typeof row.contextWindow === "number" && row.contextWindow > 0
            ? { contextWindow: row.contextWindow }
            : previous?.contextWindow
              ? { contextWindow: previous.contextWindow }
              : {}),
          ...(previous?.badge ? { badge: previous.badge } : {}),
          ...(previous?.badgeTitle ? { badgeTitle: previous.badgeTitle } : {}),
        });
      }
    }
  }
  return rows;
}

/** Live catalog for the DSH engine: the static rows plus whatever the
 *  installed Harness adds, with live metadata winning on the ids both know.
 *
 *  This **unions rather than replaces**, which is the same call
 *  `readClaudeModelCatalog` makes.  The reason is concrete: a DSH profile that
 *  configures only the `minimax` provider still serves the DeepSeek rows, so
 *  treating the file as authoritative would silently drop
 *  `deepseek-v4-flash` / `deepseek-v4-pro` from the picker — and
 *  `deepseek-v4-flash` is the static default.  A partial source can add
 *  models; it cannot retire them.  Removals need an explicit exclusion in
 *  `DSH_EXCLUDED_MODEL_IDS`, which is how `MiniMax-M2.7` is already handled. */
export function readDshModelCatalog(
  environment: Record<string, string | undefined> = process.env,
): ModelCatalog {
  const options = STATIC_DSH_MODELS.options.map((option) => ({ ...option }));
  let discovered: ModelCatalog["options"] = [];
  try {
    discovered = modelRowsFromSettings(parseYaml(readFileSync(readDshSettingsPath(environment), "utf8")));
  } catch {
    // No settings file, unreadable, or unparseable YAML: the static catalog
    // stands.  A discovery miss is never fatal.
  }
  for (const row of discovered) {
    if ((DSH_EXCLUDED_MODEL_IDS as readonly string[]).includes(row.id)) continue;
    const index = options.findIndex((option) => option.id === row.id);
    if (index === -1) {
      options.push(row);
      continue;
    }
    // A known id: keep the static label and badge, take the live context
    // window, which is the one number a profile edit actually changes.
    const existing = options[index];
    options[index] = {
      ...existing,
      ...(row.contextWindow ? { contextWindow: row.contextWindow } : {}),
    };
  }
  // The static default is always in the union, so a refresh cannot move a
  // selection out from under the user.
  return { default: STATIC_DSH_MODELS.default, options };
}

export {
  DSH_MINIMUM_ACP_VERSION,
  DSH_PROVIDER_ID,
  DSH_MINIMAX_PROVIDER_ID,
  classifyDshError,
  dshCredentialCandidates,
  dshModelIdFromOptionValue,
  dshModelOptionValue,
  dshProviderForModel,
  dshVersionCompatibilityReason,
};

export function dshSpawnArgs(config: AcpConfig, turn: Pick<SendTurnInput, "integrations">): string[] {
  return harnessDshSpawnArgs(config, turn);
}

/**
 * The Harness package's error codes include "unknown"; BotFleet's
 * ProviderErrorCode does not — an unrecognized harness code is the same as
 * no classification here.
 */
function dshClassifyError(error: unknown): ProviderErrorCode | undefined {
  const code = classifyDshError(error);
  return code === "unknown" ? undefined : code;
}

function currentConfigValue(result: unknown, configId: string): unknown {
  if (!result || typeof result !== "object") return undefined;
  const options = (result as { configOptions?: unknown }).configOptions;
  if (!Array.isArray(options)) return undefined;
  const option = options.find(
    (candidate) => candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === configId,
  );
  return option && typeof option === "object" ? (option as { currentValue?: unknown }).currentValue : undefined;
}

/** DSH's `initialize` base deadline.  `dsh --profile acp` answers only after
 * its Cordis host has loaded ~200 plugin packages: about 3.5 s of CPU, which
 * the shared 60 s default was cutting off once host load stretched it (p99
 * of answered DSH initializes on this Mac was 120 s, and most late answers
 * arrived within 2 minutes of the spawn).  Host load still scales this. */
export const DSH_INIT_TIMEOUT_MS = 120_000;

export const dshSupport = {
  ...harnessDshSupport,
  initTimeoutMs: DSH_INIT_TIMEOUT_MS,
  models: STATIC_DSH_MODELS,
  resolveModels: (environment) => readDshModelCatalog(environment),
  loginNote: harnessDshSupport.loginNote ?? "DSH CLI auth missing — add ~/.dsh/.credentials.yaml",
  resumeMethod: "session/resume" as const,
  spawnArgs: dshSpawnArgs,
  wrapSpawn: dshWrapSpawn,
  pickAuthMethod: () => null,
  classifyError: dshClassifyError,
  isAuthenticated: (env: Record<string, string | undefined>, _config: AcpConfig) =>
    harnessDshSupport.isAuthenticated?.(env) ?? false,
  authFailure: "continue" as const,
  buildPromptText: (turn: SendTurnInput) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
  async configureSession({ request, sessionId, turn }) {
    if (!turn.effort) return;
    const requested = turn.effort === "none" ? "off" : turn.effort;
    const result = await request("session/set_config_option", {
      sessionId,
      configId: "reasoning_effort",
      value: requested,
    });
    const confirmed = currentConfigValue(result, "reasoning_effort");
    // Only a *reported* mismatch means the setting did not take.  A reply that
    // carries no option state (stock `dsh` answered `{}`) reports nothing to
    // compare, and failing on that refused every effort-pinned turn.
    if (confirmed !== undefined && confirmed !== requested) {
      throw new Error(
        `DeepSeek Harness did not switch reasoning effort to ${requested} (still ${String(confirmed ?? "unknown")})`,
      );
    }
  },
} satisfies AcpSupport;

export const DshAgentDriver = createAcpDriver(dshSupport);
