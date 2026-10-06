// Muse Code — Meta's `muse` CLI, driven over the community ACP adapter.
//
// The engine is not natively an ACP agent, and that is the whole shape of
// this file.  Muse Code exposes the **Muse Session Protocol (MSP)**: the
// client spawns `muse serve`, writes newline-delimited JSON-RPC 2.0 to its
// stdin, and reads the same back.  Its own method names are
// `session/start`, `turn/start`, `approval/decide`, `turn/cancel` — not ACP's
// `session/new`, `session/prompt`, `session/request_permission`.  So there is
// no first-party ACP entry point to register, and this driver is the same
// shape as the DSH bridge: BotFleet speaks ACP out to a thin adapter, and the
// adapter speaks MSP inward to `muse serve`.
//
//   BotFleet core (ACP)  ->  muse-code-acp (npm @bex-co/muse-code-acp)
//                        ->  muse serve (MSP)  ->  Muse Spark
//
// The adapter is a third-party package, which is worth stating plainly rather
// than burying: it is the only thing between this engine and a working turn.
// What it is verified to carry, from its own README and `docs/mcp-passthrough.md`:
// streaming, session resume, permission routing (cancellation and stale replies
// fail closed), cancellation, model switching at idle, and **client-provided
// MCP servers**.  What it is verified NOT to carry: delegated workers, token
// usage, reasoning summaries, editor-side filesystem proxying, multiple
// authorized workspace roots, native session deletion, and the fs/terminal
// RPCs.  The capability row in `src/lib/engine-capabilities.tsx` is written
// from this list, not from the model's marketing.
//
// Two install steps, because there are two binaries: `muse` itself (Meta's
// installer) and the adapter (`npm`).  `needsNode` is what lets the setup UI
// say so instead of handing a user a `npm` line that cannot run.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog } from "../../contracts.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

/** Reasoning effort, narrowed to the rungs BotFleet's shared `EFFORT_LEVELS`
 *  union can carry AND that this engine's own catalog can actually serve.
 *  Muse publishes eight levels —
 *  `none, minimal, low, medium, high, xhigh, max, ultra` — and this list is a
 *  deliberate subset, not a transcription:
 *
 *    - `max` is excluded because it is Standard-tier `muse-spark-1.3` only,
 *      and 1.3 is not a model this driver offers (see `STATIC_MUSE_MODELS` for
 *      why).  Advertising a rung no reachable model takes is the overclaim
 *      this whole driver is written to avoid — the picker would offer `max`
 *      and the request would come back refused.  It is the one omission that
 *      the engine could take back by adding 1.3 and a `selectModel` hook.
 *    - `none` is excluded because the Meta provider rejects it outright
 *      ("The Meta provider does not accept `none`", HTTP 400), so offering it
 *      would be a level that always fails.
 *    - `minimal` and `ultra` are absent because `EFFORT_LEVELS` in
 *      `server/contracts.ts` has no member for either.  Widening that union
 *      is not free: `server/drivers/pi.ts` advertises the whole union
 *      verbatim, so adding a rung there would silently put two levels in
 *      pi's picker that pi's CLI does not take.  That is the same
 *      overclaim one layer up.
 *
 *  `ultra` is a client-side setting that maps to each provider's highest
 *  supported rung, which makes it a poor fit for a flat list anyway. */
export const MUSE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;

/** The only model this driver offers, and it is the CLI's own documented
 *  default rather than the best model on the card.
 *
 *  Muse Spark ships `muse-spark-1.3`, `muse-spark-1.2`, and `muse-spark-1.1`,
 *  all on a 1,048,576-token window, and `1.3` is the one "tuned for agentic
 *  workflows".  The CLI's default is `muse-spark-1.2` (the API defaults to
 *  `1.3`, which is a different surface with a different default).
 *
 *  This catalog lists `1.2` alone on purpose.  The adapter is verified to
 *  support model switching **at idle**, but its documented ACP config-option
 *  ids are `mode`, `nativeApprovalPolicy`, `sandbox`, `sandboxNetwork`,
 *  `workspaceWrite`, and `shell` — there is no `model` among them, and
 *  BotFleet's `selectModel` hook negotiates through exactly that
 *  `session/set_config_option` channel.  So no model switch is wired here,
 *  and listing `1.3` would put a row in the picker that a user can select and
 *  cannot get.  A single honest row beats three hopeful ones; the fix is a
 *  `selectModel` hook once the adapter exposes model as a config option, and
 *  the ACP core stops reporting `sessionModelSwitch: "unsupported"`. */
export const STATIC_MUSE_MODELS: ModelCatalog = {
  default: "muse-spark-1.2",
  options: [
    {
      id: "muse-spark-1.2",
      label: "Muse Spark 1.2",
      // Fixed per model; the CLI has no context-window override and surfaces
      // this as a percentage instead.
      contextWindow: 1_048_576,
      images: true,
      badge: "1M Context",
      badgeTitle: "Holds 1,048,576 tokens in one turn.  Meta bills no long-context premium, so a full window costs the same per token as an empty one.",
    },
  ],
};

/** Where the launcher keeps a browser/device-code session, when one has been
 *  stored.  CAVEAT: this path comes from the `muse` launcher script
 *  (`MUSE_AUTH_PATH`, defaulting to `$XDG_CONFIG_HOME/muse/auth.json`, else
 *  `$HOME/.config/muse/auth.json`), NOT from the CLI documentation — no Meta
 *  page states where the CLI stores credentials.  It is used only as a
 *  best-effort second signal, and the comment above it is the reason this
 *  function returns a boolean instead of a confidence. */
function museAuthPath(env: Record<string, string | undefined>): string {
  const fromEnv = env.MUSE_AUTH_PATH?.trim();
  if (fromEnv) return fromEnv;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const home = env.HOME || env.USERPROFILE || homedir();
  return join(xdg && xdg.length > 0 ? xdg : join(home, ".config"), "muse", "auth.json");
}

/** Is Muse Code signed in?  An API key always wins over a browser session —
 *  "Muse Code uses `META_API_KEY` if set, then a stored key, and only then a
 *  stored browser session" — so that env var is the one trustworthy signal.
 *  A stored auth file is a weaker second: see `museAuthPath`.  The value is
 *  never read, only tested for existence, so no credential reaches a log. */
export function museAuthenticated(env: Record<string, string | undefined>): boolean {
  if (env.META_API_KEY?.trim()) return true;
  return existsSync(museAuthPath(env));
}

const support: AcpSupport = {
  driverKind: "museAgent",
  displayName: "Muse Code",
  models: STATIC_MUSE_MODELS,
  effortLevels: MUSE_EFFORT_LEVELS,
  // The adapter accepts image parts on a turn: MSP `TurnInputPart` is
  // `text | image`, and the ACP side takes "PNG, JPEG, GIF, and WebP" as
  // `mediaType` + `base64Data`.  Audio is rejected, which is not a capability
  // this matrix tracks.
  images: true,
  // The load-bearing flag for this driver.  Muse declares MCP servers in its
  // own settings file (`mcp_servers`, stdio or `streamable_http`, each with a
  // `mode` of `required` or `optional`), and the adapter takes a SECOND,
  // per-session list straight off ACP `session/new` / `session/load` /
  // `session/resume` and merges it into a private overlay under the canonical
  // `mcpServers` key.  "User settings are never modified."
  //
  // That overlay is the whole reason this engine can have Connected Apps at
  // all: BotFleet hands its MCP servers over `session/new`, so none of the
  // harness channels need a settings file the user has to edit.  Two caveats
  // the matrix row repeats: SSE is not supported (BotFleet mounts http), and
  // Muse reports MCP connection state as `unknown` because the public SDK has
  // no MCP status method — so a failed server is visible as a failed turn, not
  // as a reported disconnect.
  mcpServers: true,
  defaultCli: "muse-code-acp",
  nativeSource: "muse.acp",
  loginNote: "Muse Code is not signed in — run `muse-code-acp --cli login` in a terminal, or set META_API_KEY",
  install: {
    command: {
      // Two steps: the `muse` binary, then the adapter that fronts it.  The
      // `&&` is load-bearing — a user with only the adapter gets a
      // "binary not found" turn instead of a setup card that says what broke.
      darwin: "curl -fsSL https://dev.meta.ai/install.sh | sh && npm install -g @bex-co/muse-code-acp",
      linux: "curl -fsSL https://dev.meta.ai/install.sh | sh && npm install -g @bex-co/muse-code-acp",
      // Meta's Windows installer is PowerShell, and the adapter is npm on
      // every platform, so the two chain the same way here.
      win32: "irm https://dev.meta.ai/install.ps1 | iex; npm install -g @bex-co/muse-code-acp",
    },
    docsUrl: "https://dev.meta.ai/docs/muse-code",
    // The adapter owns the login surface, not `muse login`: it wraps both
    // behind `--cli`, so `muse login` alone would leave the engine unsigned
    // as far as this driver is concerned.
    signInCommand: "muse-code-acp --cli login",
    // `npm install -g` needs Node; the setup UI surfaces that instead of
    // offering a command that cannot run.
    needsNode: true,
  },
  // No argv.  The adapter takes no run-time flags on this path (its only
  // documented flags are the `--cli` login/logout pair), and `muse`'s own
  // flags belong to `muse exec`, which is not how this engine runs.  Model
  // and effort selection are not passed here for the reasons recorded at
  // `STATIC_MUSE_MODELS` and `MUSE_EFFORT_LEVELS`.
  spawnArgs: () => [],
  // The adapter's ACP auth is a terminal sign-in it performs itself, so there
  // is no auth method for BotFleet to drive from inside the handshake — same
  // shape as mcode.  `authFailure: "continue"` then rides on the ambient
  // sign-in state, and an unsigned engine reports its own auth error rather
  // than a BotFleet-shaped one.
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: (env) => museAuthenticated(env),
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const MuseAgentDriver = createAcpDriver(support);
