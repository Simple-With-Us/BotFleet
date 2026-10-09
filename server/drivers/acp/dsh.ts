/**
 * DSH ACP driver — BotFleet runtime composed with the Clutch engine shape.
 *
 * Engine catalog, version gate, error classifier, and model-id round-trip
 * live in `Simple-With-Us/Clutch` (`clutch/dsh/acp`).  This file keeps
 * `wrapSpawn` and `createAcpDriver` here because they need BotFleet's ACP
 * core and the Node stdio bridge.  Edit engine shape in Clutch, not here.
 */
import {
  DSH_MINIMUM_ACP_VERSION,
  DSH_PROVIDER_ID,
  DSH_MINIMAX_PROVIDER_ID,
  classifyDshError,
  dshCredentialCandidates,
  dshInstalledEffortLevels,
  dshModelIdFromOptionValue,
  DshModelNotOfferedError,
  dshModelOptionValue,
  dshProviderForModel,
  dshSameModel,
  dshSpawnArgs as clutchDshSpawnArgs,
  dshSupport as clutchDshSupport,
  dshVersionCompatibilityReason,
} from "clutch/dsh/acp";

import type { ModelCatalog, ProviderErrorCode, SendTurnInput } from "../../contracts.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./core.ts";
import { dshWrapSpawn } from "./dsh-mcp.ts";

export { dshWrapSpawn, isDshEngineCli, isStockDshCli } from "./dsh-mcp.ts";
/** BotFleet DSH model catalog.  The Clutch package still publishes
 * MiniMax-M2.7, but it is dropped here per the product decision (M3.1 Flash
 * Preview dominates on context and is the canonical DSH-hosted MiniMax row). */
/** BotFleet DSH model catalog.
 *
 *  Owner-facing list (2026-09-27): DeepSeek V4 Pro, DeepSeek V4 Flash, then
 *  MiniMax M3.1 Flash Preview and M2.7 Highspeed.  DeepSeek's catalog is
 *  only two models — `deepseek-flash` IS the image+video model, billed at the
 *  same rate as text (its image tokens bill "together with your text tokens"),
 *  so there is deliberately no third DeepSeek row for the multimodal variant.
 *  The V4.1 rename retired the `deepseek-v4-flash` id, which sits in
 *  `DSH_EXCLUDED_MODEL_IDS` so a profile written against the old catalog
 *  cannot re-add it.  `deepseek-v4-pro` is NOT retired: it is still the
 *  declared Pro id on stock dsh 0.1.5-rc.2 and in an owner override (only its
 *  display name gained ".1"), so it folds onto the `DeepSeek-V4.1-Pro` row via
 *  `dshSameModel` rather than being excluded.
 *
 *  `MiniMax-M2.7` and `MiniMax-M3` are dropped per the product decision (M3.1
 *  Flash Preview dominates on context and is the canonical DSH-hosted MiniMax
 *  row); both sit in `DSH_EXCLUDED_MODEL_IDS` so the live-catalog union with
 *  an older settings file cannot re-add them.
 *
 *  Badges are price/speed facts the picker renders as chips, so the cost
 *  tradeoff is visible before a model is picked. */
export const STATIC_DSH_MODELS: ModelCatalog = {
  default: "DeepSeek-V4.1-Flash",
  options: [
    {
      id: "DeepSeek-V4.1-Flash",
      label: "DeepSeek-V4.1-Flash",
      images: true,
      contextWindow: 1_000_000,
      badge: "Multimodal",
      badgeTitle:
        "Accepts image and video input at the same token rate as text — each image is capped at 1,024 tokens.",
    },
    {
      id: "DeepSeek-V4.1-Pro",
      label: "DeepSeek-V4.1-Pro",
      images: false,
      contextWindow: 1_000_000,
      badge: "No Vision",
      badgeTitle:
        "Text and reasoning only — lacks vision. Switch to DeepSeek-V4.1-Flash to attach an image.",
    },
    {
      id: "MiniMax-M3.1-Flash-Preview",
      label: "MiniMax-M3.1-Flash-Preview",
      images: true,
      contextWindow: 1_000_000,
      badge: "Preview",
      badgeTitle:
        "Frontier multimodal coding model with a 1M context window. MiniMax offers it through Token Plan and MiniMax Code, so it needs a Token Plan key.",
    },
    {
      id: "MiniMax-M2.7-highspeed",
      label: "MiniMax-M2.7-highspeed",
      images: true,
      contextWindow: 204_800,
      badge: "2x the $",
      badgeTitle:
        "Same 204,800 context as M2.7 at $0.60 / M input and $2.40 / M output — exactly twice MiniMax M3's $0.30 / $1.20.",
    },
  ],
};

/** Models the product keeps out of the picker even when the installed
 *  engine offers them.  Same expression that builds STATIC_DSH_MODELS, so
 *  the live read below and the static fallback agree on what is excluded. */
const DSH_EXCLUDED_MODEL_IDS: readonly string[] = [
  "MiniMax-M2.7",
  // Superseded by MiniMax-M3.1-Flash-Preview.  Dropping it from the static
  // options is not enough: a settings file written while M3 shipped still
  // declares it, and the live-catalog union below would re-add it.
  "MiniMax-M3",
  // Retired by the V4.1 rename: no current catalog declares it.  A settings
  // file written against the old catalog still does, and the union below
  // would otherwise re-add it as a stale duplicate of the V4.1 Flash row.
  // `deepseek-v4-pro` is deliberately absent: it is still declared, and
  // `dshSameModel` folds it onto `DeepSeek-V4.1-Pro` without a duplicate.
  "deepseek-v4-flash",
];

/** The installed engine declares the models it can actually serve in its own
 *  settings file, under a provider map at `llm-pi-ai.providers.<id>.models[]`
 *  with `id` / `name` / `contextWindow`.  That file is the real source of truth
 *  for "what can this DSH run right now" — the catalog compiled into the Clutch
 *  package goes stale the moment the owner edits a profile or the package is
 *  pinned to an older release.  Reading it is the same move claude.ts makes
 *  against `~/.claude/settings.json`.
 *
 *  Note the file is *partial*: a profile that configures only the MiniMax
 *  provider still leaves the DeepSeek rows reachable, so this unions rather
 *  than replaces.  See `readDshModelCatalog` and the note there. */
function readDshSettingsPath(environment: Record<string, string | undefined>): string {
  // `$DSH_HOME` is dsh's engine home itself (credentials live at
  // `$DSH_HOME/.credentials.yaml`, see `dshCredentialCandidates`), not a user
  // home that holds a `.dsh/`.  Only the default, `~/.dsh`, adds the folder.
  //
  // `environment.HOME` before `homedir()`: the ACP core hands this the child
  // environment it will actually spawn the CLI with, so a relocated or
  // test-scoped home has to be honored.  `homedir()` reads the real process
  // home and would silently ignore both.
  const dshHome = environment.DSH_HOME?.trim()
    || join(environment.HOME?.trim() || homedir(), ".dsh");
  return join(dshHome, "settings.yaml");
}

/** The only slice of `settings.yaml` this driver reads.  Parsed once at the
 *  file boundary, so nothing below handles `unknown` or re-asserts its way
 *  down the document.  Every field is optional because the document is
 *  user-authored: `Array.isArray` on a hand-edited file is the real check. */
interface DshModelEntry {
  readonly id?: string;
  readonly name?: string;
  readonly contextWindow?: number;
}

interface DshProviderBlock {
  readonly models?: readonly DshModelEntry[];
}

interface DshSettings {
  readonly "llm-pi-ai"?: { readonly providers?: Readonly<Record<string, DshProviderBlock>> };
  readonly providers?: Readonly<Record<string, DshProviderBlock>>;
}

function isExcludedModelId(id: string): boolean {
  return DSH_EXCLUDED_MODEL_IDS.includes(id);
}

function parseDshSettings(raw: string): DshSettings {
  // SAFETY: parseYaml returns whatever the document happens to contain, so
  // this assertion is a promise the document may break.  DshSettings makes
  // every field optional and the only narrowing that matters — a real model
  // list — is re-checked with Array.isArray before use, so a hand-edited or
  // malformed file degrades to the static catalog instead of trusting a shape.
  return parseYaml(raw) as DshSettings;
}

/** Every provider map in the document, most specific first.  The live shape
 *  nests it at `llm-pi-ai.providers`; a top-level `providers` is accepted too
 *  so a profile written that way still works. */
function providerMapsIn(settings: DshSettings): Readonly<Record<string, DshProviderBlock>>[] {
  const candidates: (Readonly<Record<string, DshProviderBlock>> | undefined)[] = [
    settings["llm-pi-ai"]?.providers,
    settings.providers,
  ];
  return candidates.filter((maps): maps is Readonly<Record<string, DshProviderBlock>> => Boolean(maps));
}

function modelRowsFromSettings(settings: DshSettings): ModelCatalog["options"] {
  const rows: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  for (const providers of providerMapsIn(settings)) {
    for (const provider of Object.values(providers)) {
      // `!provider` also covers a null block, which would throw on the next
      // line; a scalar block yields `undefined` here and is skipped.
      if (!provider) continue;
      const models = provider.models;
      if (!Array.isArray(models)) continue;
      for (const entry of models) {
        const id = entry?.id;
        // The declared entry type is a promise the hand-edited file may break,
        // so the id is re-checked as a string here: a numeric or object id
        // would otherwise reach the picker and fail at turn time instead.
        if (typeof id !== "string" || !id) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        if (isExcludedModelId(id)) continue;
        const previous = STATIC_DSH_MODELS.options.find((option) => option.id === id);
        const providedName = entry.name?.trim() ? entry.name : "";
        const row: ModelCatalog["options"][number] = {
          id,
          // Hand-written copy wins over the settings file's own name.  `||`
          // and not `??` on the fallback: `providedName` is "" when the entry
          // has no name, and `??` does not fall through on falsy, so a model
          // the static catalog has never heard of would render with a blank
          // label.
          label: previous?.label ?? (providedName || id),
        };
        // A live contextWindow is the one number a profile edit actually
        // changes, so it beats the static value; otherwise keep the static one.
        const contextWindow =
          entry.contextWindow && entry.contextWindow > 0 ? entry.contextWindow : previous?.contextWindow;
        if (contextWindow) row.contextWindow = contextWindow;
        if (previous?.badge) row.badge = previous.badge;
        if (previous?.badgeTitle) row.badgeTitle = previous.badgeTitle;
        if (previous?.images !== undefined) row.images = previous.images;
        rows.push(row);
      }
    }
  }
  return rows;
}

/** Live catalog for the DSH engine: the static rows plus whatever the
 *  installed engine adds, with live metadata winning on the ids both know.
 *
 *  This **unions rather than replaces**, which is the same call
 *  `readClaudeModelCatalog` makes.  The reason is concrete: a DSH profile that
 *  configures only the `minimax` provider still serves the DeepSeek rows, so
 *  treating the file as authoritative would silently drop
 *  `DeepSeek-V4.1-Flash` / `DeepSeek-V4.1-Pro` from the picker — and
 *  `DeepSeek-V4.1-Flash` is the static default.  A partial source can add
 *  models; it cannot retire them.  Removals need an explicit exclusion in
 *  `DSH_EXCLUDED_MODEL_IDS`, which is how `MiniMax-M2.7` and the retired
 *  pre-rename `deepseek-v4-flash` id are handled. */
export function readDshModelCatalog(
  environment: Record<string, string | undefined> = process.env,
): ModelCatalog {
  const options = STATIC_DSH_MODELS.options.map((option) => ({ ...option }));
  let settings: DshSettings | undefined;
  let discovered: ModelCatalog["options"] = [];
  try {
    settings = parseDshSettings(readFileSync(readDshSettingsPath(environment), "utf8"));
    discovered = modelRowsFromSettings(settings);
  } catch {
    // No settings file, unreadable, or unparseable YAML: the static catalog
    // stands.  A discovery miss is never fatal.
  }
  for (const row of discovered) {
    if (isExcludedModelId(row.id)) continue;
    // Fold, don't duplicate: a settings row that spells a static model
    // differently (`deepseek-flash`, an owner's `deepseek-v4.1-flash`) is the
    // same model as the static `DeepSeek-V4.1-Flash` row, so it merges there.
    // dshSameModel covers the DeepSeek alias spellings plus case; any other
    // id still needs an exact match, so an unrelated model lands as its own
    // row exactly as before.
    const index = options.findIndex((option) => dshSameModel(option.id, row.id));
    if (index === -1) {
      options.push(row);
      continue;
    }
    // A known id: keep the static label and badge, take the live context
    // window, which is the one number a profile edit actually changes.
    const merged = options[index];
    if (row.contextWindow) merged.contextWindow = row.contextWindow;
    options[index] = merged;
  }
  // Per-model effort levels (MiniMax M3.1) exist only when this install's
  // settings entry declares them: stock dsh does not catalog M3.1, so without
  // `reasoningEfforts` on its entry dsh refuses every level.  Clutch answers
  // for every per-model row, and an explicit `[]` here wins over the static
  // `perModelEffortLevels` core folds on afterwards, so the picker never
  // offers a level this dsh would refuse.  A missing or unreadable file
  // answers `[]` for those rows too.
  const installedLevels = dshInstalledEffortLevels(settings);
  for (const option of options) {
    const levels = installedLevels[option.id];
    if (levels) option.effortLevels = [...levels];
  }
  // The static default is always in the union, so a refresh cannot move a
  // selection out from under the user.
  return { default: STATIC_DSH_MODELS.default, options };
}

export {
  DSH_MINIMUM_ACP_VERSION,
  DSH_PROVIDER_ID,
  DSH_MINIMAX_PROVIDER_ID,
  DshModelNotOfferedError,
  classifyDshError,
  dshCredentialCandidates,
  dshModelIdFromOptionValue,
  dshModelOptionValue,
  dshProviderForModel,
  dshSameModel,
  dshVersionCompatibilityReason,
};

export function dshSpawnArgs(config: AcpConfig, turn: Pick<SendTurnInput, "integrations">): string[] {
  return clutchDshSpawnArgs(config, turn);
}

/**
 * The Clutch package's error codes include "unknown"; BotFleet's
 * ProviderErrorCode does not — an unrecognized Clutch code is the same as
 * no classification here.
 */
function dshClassifyError(error: unknown): ProviderErrorCode | undefined {
  const code = classifyDshError(error);
  return code === "unknown" ? undefined : code;
}

/** DSH's `initialize` base deadline.  `dsh --profile acp` answers only after
 * its Cordis host has loaded ~200 plugin packages: about 3.5 s of CPU, which
 * the shared 60 s default was cutting off once host load stretched it (p99
 * of answered DSH initializes on this Mac was 120 s, and most late answers
 * arrived within 2 minutes of the spawn).  Host load still scales this. */
export const DSH_INIT_TIMEOUT_MS = 120_000;

export const dshSupport = {
  ...clutchDshSupport,
  initTimeoutMs: DSH_INIT_TIMEOUT_MS,
  images: true,
  models: STATIC_DSH_MODELS,
  resolveModels: (environment) => readDshModelCatalog(environment),
  loginNote: clutchDshSupport.loginNote ?? "DSH CLI auth missing — add ~/.dsh/.credentials.yaml",
  resumeMethod: "session/resume" as const,
  spawnArgs: dshSpawnArgs,
  wrapSpawn: dshWrapSpawn,
  pickAuthMethod: () => null,
  classifyError: dshClassifyError,
  isAuthenticated: (env: Record<string, string | undefined>, _config: AcpConfig) =>
    clutchDshSupport.isAuthenticated?.(env) ?? false,
  authFailure: "continue" as const,
  buildPromptText: (turn: SendTurnInput) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
  // Effort semantics are engine shape and live in Clutch: an explicit level
  // is sent and must take, and Default on a row with per-model levels (MiniMax
  // M3.1) sends dsh's provider-default value so a level a resumed session kept
  // from an earlier turn clears.  DeepSeek rows still send nothing for Default.
  async configureSession({ request, sessionId, turn }) {
    await clutchDshSupport.configureSession?.({ request, sessionId, turn });
  },
} satisfies AcpSupport;

export const DshAgentDriver = createAcpDriver(dshSupport);
