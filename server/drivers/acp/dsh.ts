import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import type { ProviderSnapshot, ModelCatalog, ProviderErrorCode } from "../../contracts.ts";
import { augmentedPath } from "../../env-path.ts";
import { SPAWNED_SCRIPTS } from "../../proxy-paths.ts";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./core.ts";

/** The ACP server this engine actually spawns.
 *
 * `dsh` has no `acp` subcommand — the published CLI is a REPL and a headless
 * one-shot, nothing more.  So for as long as `defaultCli` was the bare word
 * `dsh` this engine spawned a process that could never speak ACP, and every
 * turn died at the handshake.  The bridge below is the fleet's stdlib-only
 * Python translator: ACP on stdio, `dsh --profile headless` underneath.
 * Point `cli` at your own server (or a future native `dsh acp`) to replace
 * it — the Engines panel's custom-binary field still wins. */
export const DSH_ACP_BRIDGE = SPAWNED_SCRIPTS.dshAcp;

function isExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Walk PATH by hand.  `which` is a shell-out and this repository does not
 * cross that boundary; spawn() would find the binary itself, but the
 * snapshot has to answer "is it installed?" before anything is spawned. */
function onPath(name: string, env: Record<string, string | undefined>): string | null {
  const raw = env.PATH ?? env.Path ?? "";
  for (const dir of raw.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** Interpreters to try, in order, for the bridge.  It imports nothing but the
 * standard library, so any Python 3 on the machine runs it. */
export function resolveDshPython(env: Record<string, string | undefined> = process.env): string | null {
  const explicit = env.DSH_ACP_PYTHON;
  if (explicit) return explicit;
  const win = process.platform === "win32";
  const fromPath = onPath(win ? "python3.exe" : "python3", env);
  if (fromPath) return fromPath;
  if (!win) {
    for (const candidate of ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]) {
      if (isExecutable(candidate)) return candidate;
    }
  }
  return onPath(win ? "python.exe" : "python", env);
}

/** A local `dsh` install to fall back on when the CLI is not on PATH.  The
 * fleet's harness lives here; an absent directory simply yields null. */
export function dshRuntimeRoot(env: Record<string, string | undefined> = process.env): string | null {
  const explicit = env.DSH_RUNTIME_ROOT;
  if (explicit) return existsSync(explicit) ? explicit : null;
  const root = join(env.HOME || env.USERPROFILE || homedir(), "apps", "dsh-runtime");
  return existsSync(root) ? root : null;
}

/** Where the bridge should look for the harness binary.  Explicit env wins,
 * then PATH, then a local runtime's node_modules bin.  Kept in lockstep with
 * `resolve_dsh_bin` in tools/dsh-acp/dsh-acp.py, which applies the same order
 * on its own when the host passes nothing. */
export function resolveDshBin(env: Record<string, string | undefined> = process.env): string | null {
  const explicit = env.DSH_BIN;
  if (explicit) return explicit;
  const fromPath = onPath(process.platform === "win32" ? "dsh.cmd" : "dsh", env);
  if (fromPath) return fromPath;
  const root = dshRuntimeRoot(env);
  if (!root) return null;
  const local = join(root, "node_modules", ".bin", "dsh");
  return existsSync(local) ? local : null;
}

/** Quote a token for the `cli` string.  server/env-path.ts tokenizes that
 * string on unquoted whitespace, so an install path with a space has to be
 * quoted or it arrives as two arguments. */
function quoteCliToken(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/** `<python3> <bridge>` — a `cli` value carrying one fixed leading argument,
 * the shape `resolveCliSpawn` already supports for wrapper scripts.  Falls
 * back to the bare name when no interpreter resolves, so the failure is an
 * honest ENOENT on `python3` rather than a stale absolute path. */
export function dshDefaultCli(env: Record<string, string | undefined> = { ...process.env, PATH: augmentedPath() }): string {
  const python = resolveDshPython(env) ?? "python3";
  return `${quoteCliToken(python)} ${quoteCliToken(DSH_ACP_BRIDGE)}`;
}

/** No argv after the bridge path.
 *
 * This used to emit `--mcp name=command args` for every integration.  The
 * bridge never read those, and neither does `dsh`, so each one was a tool the
 * app offered and the engine could not call.  `mcpServers: false` says the
 * same thing one layer up.  Restore both together or neither. */
export function dshSpawnArgs(_config: AcpConfig, _turn: unknown): string[] {
  return [];
}

/** The harness's own current models.  The vision variant is deliberately
 * absent: `images: false` disables image attachment for the whole engine, so
 * shipping a vision model here offered a capability the composer refused. */
export const STATIC_DSH_MODELS: ModelCatalog = {
  default: "deepseek-v4-flash",
  options: [
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  ],
};

/** Candidate credential files, honoring the same DSH_HOME / HOME precedence the
 * `dsh` harness itself uses.  The `.deepseek` paths cover the platform API and
 * Code CLI logins so one authenticated DeepSeek seat still lights up this rail. */
export function dshCredentialCandidates(env: Record<string, string | undefined>): string[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  const dshHome = env.DSH_HOME || join(home, ".dsh");
  return [
    join(dshHome, ".credentials.yaml"),
    join(home, ".deepseek", "credentials.json"),
    join(home, ".deepseek-code", "credentials", "deepseek-code.json"),
  ];
}

/** Map DSH/DeepSeek failure text onto the canonical provider-error codes so the
 * fallback chain (`server/model-fallback.ts`) treats DSH quota and auth failures
 * like every other engine instead of as a generic rpc_error. */
export function classifyDshError(error: unknown): ProviderErrorCode | undefined {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const blob = `${code ?? ""} ${message}`.toLowerCase();
  if (/unauthoriz|unauthenticated|not signed in|not logged in|invalid api key|invalid_credentials|authentication required|auth.*(fail|missing|required)/.test(blob)) {
    return "invalid_credentials";
  }
  if (/inactive subscription|subscription.*(expired|inactive)|upgrade your (plan|subscription)/.test(blob)) {
    return "inactive_subscription";
  }
  if (/quota|rate.?limit|too many requests|insufficient.?balance|out of credits|credits? exhausted|\b429\b|\b402\b/.test(blob)) {
    return "quota_or_region_restriction";
  }
  if (/overloaded|capacity|service unavailable|bad gateway|upstream|\b502\b|\b503\b|\b504\b/.test(blob)) {
    return "upstream_outage";
  }
  if (/unknown model|model not found|no such model|invalid model/.test(blob)) {
    return "model_catalog_outage";
  }
  return undefined;
}

/** The harness's sandbox modes, from `@deepseek-ai/dsh-sandbox`:
 * `read-only` (its own fail-safe default), `workspace-write`, and
 * `danger-full-access`.  The shipped presets pair the last one with approval
 * policy `never` and everything else with `ask`.
 *
 * Read the caveat in `docs/dsh-engine.md` before trusting this: the variable
 * is a PROFILE convention, not a package one.  A profile's `cordis.yml` has
 * to read `process.env.DSH_PERMISSION_MODE` for it to mean anything, and the
 * stock `headless` profile that this bridge drives does not — it falls back
 * to the sandbox's own `read-only`.  We set it anyway because it is correct
 * for the profiles that do read it (the fleet's `acp` profile), and because
 * read-only is the safer place to land when it is ignored. */
export const DSH_PERMISSION_FULL_AUTO = "danger-full-access";
export const DSH_PERMISSION_INTERACTIVE = "workspace-write";

/** Everything the bridge needs to find and drive the harness.
 *
 * DSH_PERMISSION_MODE is SET on every turn, never merely defaulted.  It is a
 * variable a user's shell may already export — the fleet Mac exports
 * `danger-full-access` for its own headless runner — and `...process.env`
 * would otherwise carry that straight into a bot whose Full Auto switch is
 * off, handing it the filesystem.  The driver owns this value; the ambient
 * environment does not get a vote. */
export function applyDshEnv(env: Record<string, string | undefined>, config: AcpConfig): void {
  const bin = resolveDshBin(env);
  if (bin) env.DSH_BIN = bin;
  if (!env.DSH_HOME) env.DSH_HOME = join(env.HOME || env.USERPROFILE || homedir(), ".dsh");
  const root = dshRuntimeRoot(env);
  if (root) env.DSH_RUNTIME_ROOT = root;
  env.DSH_PERMISSION_MODE = config.fullAuto ? DSH_PERMISSION_FULL_AUTO : DSH_PERMISSION_INTERACTIVE;
}

/** The core can only report that `--version` failed, and `config.cli` here is
 * `python3 <bridge>` — a reason naming that string tells a user nothing they
 * can act on.  Name the piece that is actually missing instead. */
export function dshSetupReason(
  base: ProviderSnapshot,
  env: Record<string, string | undefined>,
  config: AcpConfig,
): ProviderSnapshot {
  if (base.state === "available") return base;
  if (!resolveDshPython(env)) {
    return {
      state: "unavailable",
      reason:
        "Python 3 not found.  The DeepSeek Harness talks ACP through a bundled Python bridge, "
        + "because the `dsh` CLI has no ACP mode of its own.  Install Python 3 (`brew install python3`, "
        + "or Xcode Command Line Tools on macOS) and reopen Settings.",
    };
  }
  if (!existsSync(DSH_ACP_BRIDGE)) {
    return {
      state: "unavailable",
      reason: `The bundled DeepSeek Harness ACP bridge is missing at ${DSH_ACP_BRIDGE}.  Reinstall the app.`,
    };
  }
  if (!resolveDshBin(env)) {
    return {
      state: "unavailable",
      reason:
        "`dsh` CLI not found.  Install it with `npm install -g @deepseek-ai/dsh`, "
        + "or set a custom binary for this engine to point at your own ACP server.",
    };
  }
  return { state: "unavailable", reason: `\`${config.cli}\` did not answer --version` };
}

const support: AcpSupport = {
  driverKind: "dshAgent",
  displayName: "DeepSeek Harness",
  // the vision model below is the one option that CAN take an image, and the
  // flag gates the composer for the whole engine — so it stays off until the
  // catalog can answer per model rather than per engine
  images: false,
  models: STATIC_DSH_MODELS,
  resolveModels: () => STATIC_DSH_MODELS,
  // No effortLevels.  Four were advertised and nothing read `turn.effort`:
  // dshSpawnArgs emits no argv at all and dsh takes no effort flag, so the
  // picker offered a control that changed nothing.  (Reasoning effort IS a
  // real dsh setting — `reasoningEffort` on the llm adapter row — but it
  // lives in the profile's cordis.yml, not on the command line.)
  //
  // No MCP either, and this one is structural rather than a missing wire.
  // The core builds agents/composio/computer/local-computer servers and hands
  // them to session/new — but dsh mounts MCP servers from a `dsh-mcp-client`
  // row in the PROFILE's cordis.yml, and @deepseek-ai/dsh-acp actively
  // rejects a non-empty session/new.mcpServers.  There is no per-session
  // injection point to flip this back on against; see docs/dsh-engine.md.
  mcpServers: false,
  defaultCli: dshDefaultCli(),
  nativeSource: "dsh.acp",
  // There is no `dsh login`.  Grepping the CLI and its command packages for a
  // login subcommand returns nothing: auth is a credentials file or an
  // inherited env var, in that precedence.  Saying "run dsh login" here would
  // send the user after a command that does not exist, so `install` carries no
  // signInCommand either.
  loginNote:
    "DeepSeek Harness is not signed in.  It has no `login` command — set DEEPSEEK_API_KEY, "
    + "or put `refs:\n  DEEPSEEK_API_KEY: <key>` in $DSH_HOME/.credentials.yaml (default ~/.dsh).",

  install: {
    command: {
      darwin: "npm install -g @deepseek-ai/dsh",
      linux: "npm install -g @deepseek-ai/dsh",
      win32: "npm install -g @deepseek-ai/dsh",
    },
    needsNode: true,
    docsUrl: "https://github.com/deepseek-ai/dsh",
  },

  resolveTurnModel: (model) => model,

  spawnArgs: dshSpawnArgs,

  // KNOWN GAP, tracked for the bridge-protocol PR: `dsh` has no model flag.
  // The model is a profile config field (`model:` on the llm adapter row in
  // cordis.yml), so nothing downstream of this call can honour a picker
  // choice today — the bridge answers set_model with a bare `{}` and the
  // profile's own model runs.  The throw below is therefore dormant, not
  // dead: it fires the moment the bridge starts answering honestly, which is
  // the right order (make it real, then let this catch the regression).
  // docs/dsh-engine.md § Model selection has the detail.
  async configureSession({ request, sessionId, turn }) {
    if (!turn.model) return;
    try {
      await request("session/set_model", { sessionId, modelId: turn.model });
    } catch (error) {
      // A set_model that silently no-ops runs the profile's default model, not
      // the picker's selection — the exact "silently wrong model" failure
      // acp/core.ts guards against.  Fail the turn instead of pretending.
      throw new Error(
        `DeepSeek Harness did not switch to ${turn.model}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  },

  transformEnv: applyDshEnv,

  /** The core can only report that `--version` failed, and `config.cli` here
   * is `python3 <bridge>` — a reason naming that string tells a user nothing
   * they can act on.  Name the missing piece instead. */
  refineSnapshot: dshSetupReason,

  classifyError: classifyDshError,

  credentialEnv: ["DEEPSEEK_API_KEY", "DSH_HOME", "DSH_RUNTIME_ROOT"],

  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: (env) =>
    dshCredentialCandidates(env).some(existsSync) || Boolean(env.DEEPSEEK_API_KEY),

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const DshAgentDriver = createAcpDriver(support);
