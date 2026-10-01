// MiniMax Code — MiniMax's `mcode acp` CLI. Subscription in BotFleet:
// auth is the CLI's own `mcode login` (MiniMax account / Token Plan),
// not an API key row. Verified against the public minimax-code repo:
// README + docs/installation.md (data-dir resolution, BYOK provider key,
// `mcode acp` entry point) and packages/tui/src/acp/ (model config option
// wire shape, terminal auth method).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import type { EffortLevel, ModelCatalog } from "../../contracts.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

/** The reasoning-effort levels mcode advertises for MiniMax M3.1, beside its
 *  own `default` (which BotFleet spells as "no effort picked" and sends as the
 *  literal `default`).  Read off a live mcode 0.5.5 session's `thinkingEffort`
 *  config option: `default, low, medium, high, xhigh, max`.  M3 and M2.7 carry
 *  no effort options at all, so this list belongs to M3.1 alone. */
export const MCODE_M31_EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** The ACP config option id mcode uses for reasoning effort
 *  (`thinkingEffort`, category `thought_level`).  Present on a session only
 *  when the selected model has effort options, and reset to `default` by every
 *  model switch. */
export const MCODE_EFFORT_CONFIG_ID = "thinkingEffort";

/** mcode's own spelling of "no effort picked", advertised as the first option
 *  of `thinkingEffort` and accepted by `session/set_config_option`. */
const MCODE_DEFAULT_EFFORT = "default";

export const STATIC_MCODE_MODELS: ModelCatalog = {
  default: "MiniMax-M3.1-Flash-Preview-thinking",
  options: [
    {
      id: "MiniMax-M3.1-Flash-Preview-thinking",
      label: "MiniMax M3.1 Flash Preview · thinking",
      effortLevels: [...MCODE_M31_EFFORT_LEVELS],
    },
    // Explicit `[]`, not an omitted field: src/lib/model-effort.ts falls back
    // to the engine-wide list for a row that declares none, and this engine's
    // list is M3.1's.  mcode advertises no `thinkingEffort` for M2.7.
    { id: "MiniMax-M2.7-highspeed-thinking", label: "MiniMax M2.7 Highspeed · thinking", effortLevels: [] },
  ],
};

/** Give every catalog row an explicit `effortLevels`, `[]` where it declares
 *  none.  The client (src/lib/model-effort.ts) treats a row with no list as
 *  "whatever the engine offers", and this engine's list is M3.1's, so a row
 *  added later (or another branch's bare row) would otherwise grow an effort
 *  picker the driver never honours.  Rows that already declare a list are
 *  returned as-is. */
export function withMcodeEffortLevels(catalog: ModelCatalog): ModelCatalog {
  return {
    ...catalog,
    options: catalog.options.map((option) =>
      option.effortLevels === undefined ? { ...option, effortLevels: [] } : option,
    ),
  };
}

/** Resolve mcode's user data directory: MINIMAX_DATA_DIR, then
 *  MAVIS_DATA_DIR, then ~/.minimax. Mirrors docs/installation.md; a
 *  selected profile uses ~/.minimax-<profile>, which the CLI itself
 *  resolves — this helper covers the env-override cases BotFleet sets. */
export function mcodeDataDir(env: Record<string, string | undefined>): string {
  for (const name of ["MINIMAX_DATA_DIR", "MAVIS_DATA_DIR"]) {
    const dir = env[name]?.trim();
    if (dir) return dir;
  }
  return join(env.HOME || env.USERPROFILE || homedir(), ".minimax");
}

/** Is mcode configured enough to run a turn? Either the BYOK provider key
 *  this instance's environment carries, or the config.yaml the CLI writes
 *  on `mcode login` / `mcode provider add`. This proves configuration, not
 *  a live session — a stale login surfaces as a turn error, same as qwen. */
export function mcodeAuthenticated(env: Record<string, string | undefined>): boolean {
  if (env.MCODE_PROVIDER_API_KEY?.trim()) return true;
  return existsSync(join(mcodeDataDir(env), "config.yaml"));
}

/** Strip the provider qualifier mcode writes on some model references
 *  (`defaultModel: minimax/MiniMax-M3`) down to the bare id the picker uses.
 *  A value with no `/` is already bare.  The variant-folding `mcodePickerId`
 *  does for session-advertised values is NOT applied here: `model_order` in
 *  config.yaml already carries the folded form (`MiniMax-M2.7-highspeed`). */
function bareModelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/** The only slice of `config.yaml` this driver reads.  The file also carries
 *  per-model generation settings, a per-provider `model_order`, and a
 *  `whitelist`, none of which is needed: the shipped rows already are the set
 *  a session advertises, so the only thing a config can usefully move is the
 *  default. */
interface McodeSettings {
  defaultModel?: unknown;
  defaultModelVariant?: unknown;
  defaultModelContextWindow?: unknown;
}

function parseMcodeSettings(raw: string): McodeSettings {
  const doc = parseYaml(raw);
  return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as McodeSettings) : {};
}

/** Live catalog for the mcode engine: the shipped rows plus the default the
 *  user's own config names.
 *
 *  Discovery here is deliberately narrow — it picks the **default**, and it
 *  does not append rows.  The reason is that a pre-session id cannot be
 *  verified: a row is only selectable if the running session advertises a
 *  matching value, and an id the session does not advertise fails the turn
 *  with an opaque "does not offer".  mcode 0.5.5 is the concrete proof — it
 *  advertises `m:minimax:MiniMax-M3.1-Flash-Preview:v:` for the flash preview
 *  and then fails that exact selection on a real turn, while the same
 *  model's `v:thinking` sibling answers.  So the shipped rows are the
 *  advertised set, and discovery only moves the default onto whichever
 *  advertised row the owner's own config actually names.
 *
 *  `defaultModel` is provider-qualified and `defaultModelVariant` names the
 *  mode, so both are folded into the picker id the same way `mcodePickerId`
 *  folds an advertised value: a variant becomes `<modelId>-<variant>`. */
export function readMcodeModelCatalog(
  environment: Record<string, string | undefined> = process.env,
): ModelCatalog {
  const options = STATIC_MCODE_MODELS.options.map((option) => ({ ...option }));
  const ids = new Set(options.map((option) => option.id));
  let preferred: string | null = null;
  let contextWindow: number | null = null;

  try {
    const settings = parseMcodeSettings(
      readFileSync(join(mcodeDataDir(environment), "config.yaml"), "utf8"),
    );
    const configured = bareModelId(settings.defaultModel);
    if (configured) {
      const variant = settings.defaultModelVariant;
      const folded =
        typeof variant === "string" && variant.trim() ? `${configured}-${variant.trim()}` : configured;
      // Only a default that is actually on offer is adopted; one that is not
      // would send every turn to a row the picker never showed.
      if (ids.has(folded)) preferred = folded;
    }
    const window = settings.defaultModelContextWindow;
    if (typeof window === "number" && window > 0) contextWindow = window;
  } catch {
    // No config, unreadable, or unparseable: the shipped catalog stands.
  }

  const defaultModel = preferred ?? STATIC_MCODE_MODELS.default;
  if (preferred && contextWindow) {
    const row = options.find((option) => option.id === preferred);
    // Only fill a gap — a row that already declares a window keeps it.
    if (row && !row.contextWindow) row.contextWindow = contextWindow;
  }
  return withMcodeEffortLevels({ default: defaultModel, options });
}

/** The slice of a `session/set_config_option` reply this driver reads: the
 *  session's option list, each entry with its current value.  A bare `{}` ACK
 *  carries no option state at all. */
interface ConfigOptionReply {
  configOptions?: Array<{ id?: string; currentValue?: string } | null>;
}

/** The value a reply reports for one session config option, or `undefined`
 *  when it reports nothing, so a bare ACK is never held to a comparison it
 *  cannot make. */
function reportedConfigValue(reply: ConfigOptionReply | null | undefined, configId: string): string | undefined {
  const options = reply?.configOptions;
  return Array.isArray(options) ? options.find((option) => option?.id === configId)?.currentValue : undefined;
}

const support: AcpSupport = {
  driverKind: "mcodeAgent",
  displayName: "MiniMax Code",
  models: withMcodeEffortLevels(STATIC_MCODE_MODELS),
  // The engine gate.  Every picker row carries its own explicit list (see
  // withMcodeEffortLevels), so this only says "this engine can set effort".
  effortLevels: MCODE_M31_EFFORT_LEVELS,
  resolveModels: (environment) => readMcodeModelCatalog(environment),
  images: true,
  defaultCli: "mcode",
  nativeSource: "mcode.acp",
  loginNote: "MiniMax Code CLI is not signed in — run `mcode login --region global` in a terminal",
  install: {
    command: {
      darwin: "curl -fsSL https://filecdn.minimax.chat/public/install.sh | bash",
      linux: "curl -fsSL https://filecdn.minimax.chat/public/install.sh | bash",
      win32: "irm https://filecdn.minimax.chat/public/install.ps1 | iex",
    },
    docsUrl: "https://github.com/minimax-ai/minimax-code",
    signInCommand: "mcode login --region global",
  },
  // `mcode acp` takes no model flag (packages/tui/src/cli/run-acp-command.ts
  // has no argv), but its ACP server advertises a "model" session config
  // option: session/set_config_option switches mid-session. The wire value
  // embeds the user's own login/BYOK provider, so a value is never
  // constructed here - the picker id is matched against the options the
  // session advertises, and the advertised value goes back verbatim. core
  // fails the turn when the agent does not confirm the switch.
  spawnArgs: () => ["acp"],
  selectModel: {
    configId: "model",
    valueForModel: (model, advertised) => mcodeModelOptionValue(model, advertised),
    modelForValue: (value) => {
      const decoded = parseMcodeModelValue(value);
      return decoded ? mcodePickerId(decoded) : null;
    },
  },
  // mcode's only ACP auth method is a terminal `mcode login`
  // (packages/tui/src/acp/agent.ts, AUTH_METHOD_ID "minimax-code-login",
  // advertised only when the host supports terminal auth) - BotFleet cannot
  // drive a terminal inside the handshake, so skip it and run on the ambient
  // `mcode login` state.
  pickAuthMethod: () => null,
  authFailure: "continue",
  // this instance's HOME, not the server process's: an instance can carry
  // its own, and probing the wrong one reports another account's login
  isAuthenticated: (env) => mcodeAuthenticated(env),
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
  // Reasoning effort.  mcode advertises `thinkingEffort` (default, low, medium,
  // high, xhigh, max) only for M3.1, and `session/set_config_option` sets it
  // for this session without touching config.yaml.
  //
  // Ordering matters: core runs selectModel before this hook, and a model
  // switch resets mcode's effort to `default`, so the effort has to be sent
  // after the switch or it is silently discarded.
  //
  // `default` is sent on EVERY M3.1 turn that picked no level, not skipped.  A
  // session can be reused or resumed with an earlier explicit level still set,
  // and a fresh one inherits whatever the owner's MiniMax Code TUI defaults to;
  // sending `default` makes "no effort picked" mean the same thing each turn.
  //
  // There is deliberately no context-window call here.  mcode's ACP layer
  // handles only permissionMode, model and thinkingEffort.  The 512K/1M window
  // is MiniMax Code's own /model setting (config.yaml
  // `defaultModelContextWindow`), which a session inherits and BotFleet does
  // not write.
  async configureSession({ request, sessionId, turn }) {
    const model = turn.model?.trim();
    if (!model) return;
    const levels = STATIC_MCODE_MODELS.options.find((option) => option.id === model)?.effortLevels ?? [];
    // No effort options for this model (M2.7, or an id this driver does not
    // know): mcode advertises no `thinkingEffort`, so setting one would only
    // earn a -32602.
    if (levels.length === 0) return;

    const requested = turn.effort;
    const explicit = requested && levels.includes(requested) ? requested : undefined;
    if (requested && !explicit) {
      // `none` (and any level this model lacks) cannot be honoured: M3.1 has no
      // off switch.  Run it at Default instead of failing an unattended turn.
      console.warn(`[mcode] ${model} has no effort "${requested}"; using default`);
    }
    const value = explicit ?? MCODE_DEFAULT_EFFORT;
    const refused = (detail: string) => `MiniMax Code did not accept thinking effort ${value} for ${model}: ${detail}`;

    let result: ConfigOptionReply | undefined;
    try {
      result = await request("session/set_config_option", {
        sessionId,
        configId: MCODE_EFFORT_CONFIG_ID,
        value,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // An explicit pick the CLI refuses must not quietly run at another level:
      // that is a paid turn the person did not ask for.  A refused `default`
      // is harmless, since it is also where a fresh session already sits.
      if (explicit) throw new Error(refused(message));
      console.warn(`[mcode] ${model}: ${refused(message)}`);
      return;
    }

    // Only a *reported* mismatch means it did not take: a bare `{}` ACK reports
    // no option state to compare against.
    const confirmed = reportedConfigValue(result, MCODE_EFFORT_CONFIG_ID);
    if (confirmed !== undefined && confirmed !== value) {
      const detail = `still ${confirmed}`;
      if (explicit) throw new Error(refused(detail));
      console.warn(`[mcode] ${model}: ${refused(detail)}`);
    }
  },
};

/** One advertised mcode model selection, decoded from its ACP wire value:
 *  `m:<providerId>:<modelId>:u` (no variant) or
 *  `m:<providerId>:<modelId>:v:<variant>`. The shape is from the public
 *  minimax-code source (packages/tui/src/acp/control-state.ts -
 *  modelConfigValue / parseModelConfigValue, components URI-encoded). */
export function parseMcodeModelValue(
  value: unknown,
): { providerId: string; modelId: string; variant?: string } | null {
  if (typeof value !== "string") return null;
  const [prefix, provider, model, variantKind, variant, ...extra] = value.split(":");
  if (prefix !== "m" || !provider || !model || extra.length > 0) return null;
  if (variantKind === "u" && variant === undefined) {
    return { providerId: decodeURIComponent(provider), modelId: decodeURIComponent(model) };
  }
  if (variantKind === "v") {
    return {
      providerId: decodeURIComponent(provider),
      modelId: decodeURIComponent(model),
      // The CLI advertises the no-variant selection as a bare `v:` with an
      // EMPTY variant — `m:minimax:MiniMax-M3:v:` — not as the `u` suffix the
      // source's own type suggests.  Rejecting it (as a truthiness test on
      // `variant` does) made every non-thinking model unselectable, including
      // the plain `MiniMax-M3` and the flash preview the CLI defaults to.
      // Both spellings mean "no variant", so accept either and fold to the
      // same picker id.
      ...(variant ? { variant: decodeURIComponent(variant) } : {}),
    };
  }
  return null;
}

/** The picker id an advertised selection corresponds to: the model id with
 *  the variant folded in, matching STATIC_MCODE_MODELS
 *  ("MiniMax-M2.7-highspeed"). */
export function mcodePickerId(selection: { modelId: string; variant?: string }): string {
  return selection.variant ? `${selection.modelId}-${selection.variant}` : selection.modelId;
}

/** Match the picker model against the session's advertised model options and
 *  return the advertised wire value verbatim: the providerId inside is the
 *  user's own login/BYOK config, never something to construct. Returns null
 *  when the session advertises no model option (an older mcode - the session
 *  keeps its login default and the picker rides the session, as before);
 *  throws when a model option exists but the requested model is not in it. */
export function mcodeModelOptionValue(model: string, advertised: unknown): string | null {
  const modelOption = (Array.isArray(advertised) ? advertised : []).find(
    (o: any) => o?.id === "model",
  ) as { options?: Array<{ value?: unknown; name?: unknown }> } | undefined;
  if (!modelOption) return null;
  const available = Array.isArray(modelOption.options) ? modelOption.options : [];
  const wanted = model.trim().toLowerCase();
  for (const option of available) {
    const decoded = parseMcodeModelValue(option?.value);
    if (decoded && mcodePickerId(decoded).toLowerCase() === wanted && typeof option?.value === "string") {
      return option.value;
    }
  }
  const names = available.map((o) => String(o?.name ?? o?.value ?? "?")).join(", ") || "none";
  throw new Error(`MiniMax Code does not offer ${model} for this login - available: ${names}`);
}

export const McodeAgentDriver = createAcpDriver(support);
