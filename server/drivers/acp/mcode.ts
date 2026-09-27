// MiniMax Code — MiniMax's `mcode acp` CLI. Subscription in BotFleet:
// auth is the CLI's own `mcode login` (MiniMax account / Token Plan),
// not an API key row. Verified against the public minimax-code README
// and docs/installation.md (data-dir resolution, `mcode acp` entry point).
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
