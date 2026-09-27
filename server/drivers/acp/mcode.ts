// MiniMax Code — MiniMax's `mcode acp` CLI. Subscription in BotFleet:
// auth is the CLI's own `mcode login` (MiniMax account / Token Plan),
// not an API key row. Verified against the public minimax-code repo:
// README + docs/installation.md (data-dir resolution, BYOK provider key,
// `mcode acp` entry point) and packages/tui/src/acp/ (model config option
// wire shape, terminal auth method).
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog } from "../../contracts.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

export const STATIC_MCODE_MODELS: ModelCatalog = {
  default: "MiniMax-M3",
  options: [
    { id: "MiniMax-M3", label: "MiniMax M3" },
    // Same M-series speed tier the direct minimax driver carries: plain
    // M2.7 bills like M3 for a fifth of the context, so M3 dominates it.
    { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed" },
  ],
};

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

const support: AcpSupport = {
  driverKind: "mcodeAgent",
  displayName: "MiniMax Code",
  models: STATIC_MCODE_MODELS,
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
  if (variantKind === "v" && variant) {
    return {
      providerId: decodeURIComponent(provider),
      modelId: decodeURIComponent(model),
      variant: decodeURIComponent(variant),
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
