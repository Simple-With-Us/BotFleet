// MiniMax Code — MiniMax's `mcode acp` CLI. Subscription in BotFleet:
// auth is the CLI's own `mcode login` (MiniMax account / Token Plan),
// not an API key row. Verified against the public minimax-code README
// and docs/installation.md (data-dir resolution, `mcode acp` entry point).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import type { ModelCatalog } from "../../contracts.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

export const STATIC_MCODE_MODELS: ModelCatalog = {
  default: "MiniMax-M3",
  options: [
    { id: "MiniMax-M3", label: "MiniMax M3" },
    // The flash preview tier the CLI itself defaults to on a current
    // install.  A preview id, so it is NOT the static default for a fresh
    // install with no config — a user who has one gets it from discovery
    // instead, and a user who does not is not handed a preview model.
    { id: "MiniMax-M3.1-Flash-Preview", label: "MiniMax M3.1 Flash Preview" },
    // Same M-series speed tier the direct minimax driver carries: plain
    // M2.7 bills like M3 for a fifth of the context, so M3 dominates it.
    { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed" },
    { id: "MiniMax-M2.7", label: "MiniMax M2.7" },
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

/** Strip the provider qualifier mcode writes on some model references
 *  (`defaultModel: minimax/MiniMax-M3`) down to the bare id the ACP session
 *  and the picker both use.  A value with no `/` is already bare. */
function bareModelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/** The only slice of `config.yaml` this driver reads for the catalog.  The
 *  file also carries per-model generation settings and a `whitelist`, none of
 *  which is needed to know which ids the picker may offer. */
interface McodeSettings {
  defaultModel?: unknown;
  defaultModelContextWindow?: unknown;
  provider?: Record<string, unknown>;
}

function parseMcodeSettings(raw: string): McodeSettings {
  const doc = parseYaml(raw);
  return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as McodeSettings) : {};
}

/** Live catalog for the mcode engine: the static rows plus whatever the
 *  installed CLI lists, with the CLI winning on the ids both know.
 *
 *  This **unions rather than replaces**, the same call `readDshModelCatalog`
 *  makes, and for the same reason: a config that names one provider or one
 *  model still serves the rest, so treating the file as authoritative would
 *  silently retire rows from the picker.  A partial source can add models; it
 *  cannot retire them.
 *
 *  Why this exists at all: the CLI advertises a `model_order` under each
 *  provider and defaults to whatever `defaultModel` names, and both move as
 *  MiniMax ships models.  A frozen static list went stale the moment a new
 *  tier appeared — the flash preview the CLI defaults to was unreachable. */
export function readMcodeModelCatalog(
  environment: Record<string, string | undefined> = process.env,
): ModelCatalog {
  const options = STATIC_MCODE_MODELS.options.map((option) => ({ ...option }));
  const seen = new Set(options.map((option) => option.id));
  let preferred: string | null = null;
  let contextWindow: number | null = null;

  try {
    const settings = parseMcodeSettings(
      readFileSync(join(mcodeDataDir(environment), "config.yaml"), "utf8"),
    );
    const configured = bareModelId(settings.defaultModel);
    if (configured) preferred = configured;
    const window = settings.defaultModelContextWindow;
    if (typeof window === "number" && window > 0) contextWindow = window;

    // Every provider block contributes its own ordered list.  Ids are
    // de-duplicated across blocks so two providers offering the same model
    // produce one row.
    for (const block of Object.values(settings.provider ?? {})) {
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      const order = (block as { model_order?: unknown }).model_order;
      if (!Array.isArray(order)) continue;
      for (const entry of order) {
        const id = bareModelId(entry);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        options.push({ id, label: id });
      }
    }
  } catch {
    // No config, unreadable, or unparseable: the static catalog stands.
  }

  // The user's own default wins when it is actually on offer, so a current
  // install lands on the model its owner chose rather than the shipped one.
  const defaultModel = preferred && seen.has(preferred) ? preferred : STATIC_MCODE_MODELS.default;
  if (preferred && seen.has(preferred) && contextWindow) {
    const row = options.find((option) => option.id === preferred);
    // Only fill a gap — a row that already declares a window keeps it.
    if (row && !row.contextWindow) row.contextWindow = contextWindow;
  }
  return { default: defaultModel, options };
}

const support: AcpSupport = {
  driverKind: "mcodeAgent",
  displayName: "MiniMax Code",
  models: STATIC_MCODE_MODELS,
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
  // `mcode acp` takes no model flag — the public CLI exposes model choice
  // through /provider in the TUI, so the picker id rides the session only.
  spawnArgs: () => ["acp"],
  // mcode's ACP authenticate method ids are not documented publicly; skip
  // the authenticate step and run on the ambient `mcode login` state.
  pickAuthMethod: () => null,
  authFailure: "continue",
  // this instance's HOME, not the server process's: an instance can carry
  // its own, and probing the wrong one reports another account's login
  isAuthenticated: (env) => mcodeAuthenticated(env),
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const McodeAgentDriver = createAcpDriver(support);
