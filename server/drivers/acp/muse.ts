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

/** The only model this driver names, and the honest reason it names just one.
 *
 *  Muse Spark ships `muse-spark-1.3`, `muse-spark-1.2`, and `muse-spark-1.1`,
 *  all on a 1,048,576-token window.  Two separate things stopped this listing
 *  more than one model.
 *
 *  **We cannot switch.**  The adapter is verified to support model switching at
 *  idle, but its documented ACP config-option ids are `mode`,
 *  `nativeApprovalPolicy`, `sandbox`, `sandboxNetwork`, `workspaceWrite`, and
 *  `shell` — there is no `model` among them, and BotFleet's `selectModel` hook
 *  negotiates through exactly that `session/set_config_option` channel.  So no
 *  model switch is wired, and listing `1.3` would put a row in the picker a
 *  user can select and cannot get.
 *
 *  **And the model that actually runs is the account's choice, not ours.**
 *  A live run on 2026-10-05 reported `run.model.configured` with `model_id:
 *  "muse-spark-1.3-contributor"`, `provider_id: "meta"`, `profile_id: "tbh"`,
 *  `source: "startup"` — so the runtime model came from the account's startup
 *  profile, and on that account it was a 1.3 *Contributor* tier rather than the
 *  1.2 the docs describe as the CLI default.  This entry therefore names the
 *  model we can point at, while the matrix row says plainly that the model a
 *  turn actually uses is the account's startup default until a switch is
 *  wired.  Reporting one confident model id when the engine may run a
 *  different tier would be the same overclaim as the `max` effort rung, one
 *  level up. */
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

/** Is Muse Code signed in *for this driver*?
 *
 *  **Only an API key counts.**  A live run on 2026-10-05 showed why the file
 *  cannot be the answer:  `~/.config/muse/auth.json` exists for a signed-in
 *  account and holds NO credential.  It is an index — `providers.meta` carries
 *  `mechanism: "oauth"`, `storage: "keychain"`, `obtained_via: "device_code"`,
 *  the api base url, and the user's name and avatar URL — while the token lives
 *  in the macOS Keychain under a service name the CLI picks.
 *
 *  And "the account is signed in" is not the question that matters, because
 *  **this driver cannot use a keychain OAuth session.**  Muse Code resolves
 *  credentials as `META_API_KEY`, then a stored key, then a stored browser
 *  session — and the community adapter we spawn bundles
 *  `@muse-code/sdk@1.3.0`, which predates the Keychain move and answers "not
 *  logged in" on exactly that account.  So the third tier is real for the CLI
 *  and unusable here, and reporting it as signed in is what produced the
 *  original bug:  a setup-complete badge over an engine that failed every turn.
 *
 *  Why this returns false rather than trying harder:  the live consumers of
 *  this answer are the setup card and the failover chain at
 *  `server/safety/turn-safety.ts`, which skips an instance whose
 *  `authenticated` is `false`.  `muse` does not set
 *  `requireAuthenticationBeforeSpawn` and uses `authFailure: "continue"`, so
 *  nothing blocks a turn on this value — which means a wrong `false` is not
 *  cosmetic.  It strands the setup card and the failover chain for a user who
 *  did everything right.  Hence `loginNote` and `signInCommand` name the API
 *  key as the sign-in path, so following the card actually produces a
 *  credential this function can see.
 */
export function museAuthenticated(env: Record<string, string | undefined>): boolean {
  return Boolean(env.META_API_KEY?.trim());
}

/** The sign-in sentence the harness shows when this engine is not authenticated.
 *  Exported so a test can hold it to `museAuthenticated` — the bug this encodes
 *  was the two drifting apart. */
export const MUSE_LOGIN_NOTE =
  "Muse Code needs an API key for BotFleet — a browser session signed into the Mac keychain works in the terminal but this engine cannot read it";

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
  // Must name the ONLY sign-in path that produces a credential this driver can
  // see.  It previously said `muse-code-acp --cli login`, which completes a
  // device-code OAuth session into the Keychain — a credential the adapter's
  // SDK cannot read — so a user who followed the card exactly stayed
  // `authenticated: false` forever, with the setup card never clearing and the
  // instance permanently outside the failover chain.  This has to match
  // `museAuthenticated` exactly; the two drifting apart is what that bug was.
  loginNote: MUSE_LOGIN_NOTE,
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
    // The API key path, matching `museAuthenticated` and `loginNote`.  Not
    // `muse-code-acp --cli login`:  that completes a device-code OAuth session
    // into the Keychain, which this engine's adapter cannot read, so it would
    // walk a user through setup and leave them signed out from BotFleet's
    // point of view.  `auth set` reads the key from stdin, so it never lands in
    // a shell history either.  The env-var alternative is `META_API_KEY`.
    signInCommand: "muse auth set --provider meta --api-key-stdin",
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
