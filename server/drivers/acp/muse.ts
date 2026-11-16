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

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog } from "../../contracts.ts";
import { z } from "zod";
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
 *      the engine could take back by adding 1.3 to the catalog, once a
 *      session advertises a choice for it.
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
 *  **The switch is wired, but only to what the session advertises.**  The
 *  community adapter does serve a `model` config option:  `dist/config-options.js`
 *  exports `MODEL_CONFIG_ID = "model"` beside `EFFORT_CONFIG_ID =
 *  "reasoningEffort"`, and `applyConfigSelection` handles
 *  `session/set_config_option` for both — which is the channel BotFleet's
 *  `selectModel` hook negotiates through.  What the account can switch TO is
 *  the account's own catalog, so the hook matches the picker id against the
 *  options the session advertises and sends the advertised value back
 *  unchanged, and refuses plainly when the session advertises no model option
 *  at all (an adapter older than the one that added them) or does not offer
 *  the picked id.  A row the session cannot offer is still a row a user can
 *  select and cannot get, so `1.3` stays out of this list:  the catalog is
 *  static, and the account decides which ids exist.
 *
 *  **And the model that actually runs is the account's choice, not ours.**
 *  A live run on 2026-10-05 reported `run.model.configured` with `model_id:
 *  "muse-spark-1.3-contributor"`, `provider_id: "meta"`, `profile_id: "tbh"`,
 *  `source: "startup"` — so the runtime model came from the account's startup
 *  profile, and on that account it was a 1.3 *Contributor* tier rather than the
 *  1.2 the docs describe as the CLI default.  This entry therefore names the
 *  model we can point at, while the matrix row says plainly that a turn runs
 *  the account's startup model unless the session advertises a choice for the
 *  model named here.  Reporting one confident model id when the engine may run
 *  a different tier would be the same overclaim as the `max` effort rung, one
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

/** The ACP config-option id the community adapter serves for the model.
 *
 *  `dist/config-options.js` in `@bex-co/muse-code-acp` exports
 *  `MODEL_CONFIG_ID = "model"` beside `EFFORT_CONFIG_ID = "reasoningEffort"`,
 *  and `applyConfigSelection` handles `session/set_config_option` for both.
 *  The iOS path already drove this same option (see
 *  `ios/Tests/CompanionCoreTests/NativeMuseModelSelectionTests.swift`), so
 *  the Mac server and the native client now switch the model the same way. */
export const MUSE_MODEL_CONFIG_ID = "model";

/** The prefix the adapter puts on a provider-qualified model choice. */
const MUSE_MODEL_VALUE_PREFIX = "muse-model:";

/** The session's advertised config options, decoded at the boundary.
 *
 *  The list is verbatim agent output, so every field this driver reads off it
 *  is parsed before it is branched on:  one malformed entry drops itself
 *  rather than the whole list, and unknown fields pass through. */
export const museAdvertisedConfigOptionsSchema = z
  .array(
    z
      .object({
        id: z.string().optional().catch(undefined),
        currentValue: z.string().optional().catch(undefined),
        options: z
          .array(
            z
              .object({
                value: z.string().optional().catch(undefined),
                name: z.string().optional().catch(undefined),
              })
              .passthrough()
              .optional()
              .catch(undefined),
          )
          .optional()
          .catch(undefined),
      })
      .passthrough(),
  )
  .catch([]);

/** One advertised Muse model selection, decoded from its ACP wire value.
 *
 *  A provider-qualified choice is `muse-model:` followed by the URI-encoded
 *  JSON `[providerId, profileId|null, modelId]` (`modelChoice` in
 *  `dist/config-options.js`);  a model with no provider is advertised as its
 *  plain id instead, so both spellings reach the wire. */
export type MuseModelChoice = {
  providerId: string;
  profileId: string | null;
  modelId: string;
};

/** The three fields of a qualified choice, in the adapter's own order. */
const museModelChoiceSchema = z.tuple([
  z.string().min(1),
  z.string().min(1).nullable(),
  z.string().min(1),
]);

/** Decode one advertised model choice, or null when the value is not one.
 *
 *  The payload is opaque at the ACP boundary, so it is decoded rather than
 *  compared as a string:  the picker id lives inside it, next to the provider
 *  and the profile that belong to the user's own account. */
export function parseMuseModelValue(value: string): MuseModelChoice | null {
  if (!value.startsWith(MUSE_MODEL_VALUE_PREFIX)) return null;
  let payload: string;
  try {
    payload = decodeURIComponent(value.slice(MUSE_MODEL_VALUE_PREFIX.length));
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  const tuple = museModelChoiceSchema.safeParse(raw);
  if (!tuple.success) return null;
  const [providerId, profileId, modelId] = tuple.data;
  return { providerId, profileId, modelId };
}

/** The picker id an advertised model choice names:  the model id out of a
 *  qualified value, or the plain id an unqualified choice carries. */
export function museModelIdForValue(value: string): string | null {
  const decoded = parseMuseModelValue(value);
  if (decoded) return decoded.modelId;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Match the picker model against the session's advertised model options and
 *  return the advertised wire value verbatim.
 *
 *  The value is never constructed here:  the provider and the profile inside
 *  it belong to the user's own account, so the only safe thing to send is the
 *  exact string the session advertised.  A model the session does not offer is
 *  refused rather than sent, and every refusal says plainly what is wrong, so
 *  the caller reports it instead of retrying a request the adapter would
 *  answer with `-32602`.
 *
 *  This throws rather than returning null on purpose:  a null means "keep the
 *  session's default", and running the account's startup model under a picker
 *  that names another one is the overclaim this driver exists to avoid. */
export function museModelOptionValue(
  model: string,
  advertised: z.infer<typeof museAdvertisedConfigOptionsSchema> | undefined,
): string {
  const modelOption = advertised?.find((option) => option.id === MUSE_MODEL_CONFIG_ID);
  if (!modelOption) {
    throw new Error(
      "This Muse session cannot switch models: the adapter advertises no model option, so the turn runs the account's startup model",
    );
  }
  const choices = (modelOption.options ?? []).flatMap((option) =>
    option === undefined || option.value === undefined
      ? []
      : [{ value: option.value, name: option.name ?? option.value }],
  );
  if (choices.length === 0) {
    throw new Error(
      "This Muse session cannot switch models: the adapter advertises a model option with no choices",
    );
  }
  const wanted = model.trim();
  let match: { value: string; name: string } | null = null;
  for (const choice of choices) {
    const decoded = parseMuseModelValue(choice.value);
    const hit = decoded ? decoded.modelId === wanted : choice.value === wanted;
    if (!hit) continue;
    if (match) {
      throw new Error(
        `Muse offers ${wanted} more than once for this session, so BotFleet cannot choose one`,
      );
    }
    match = choice;
  }
  if (!match) {
    const names = choices.map((choice) => choice.name).join(", ") || "none";
    throw new Error(`Muse does not offer ${wanted} for this session — available: ${names}`);
  }
  const decoded = parseMuseModelValue(match.value);
  if (decoded && decoded.profileId) {
    // The adapter refuses named-profile routing itself ("Named model profile
    // routing is unverified on supported Muse hosts"), so this says it here
    // instead of letting the switch come back as an invalid-params error.
    throw new Error(
      `Muse routes ${wanted} through a named profile, which this adapter refuses to switch to`,
    );
  }
  return match.value;
}

/** Where the launcher keeps its credential index, when one has been stored.
 *
 *  This file is NOT a credential store, and treating it as one was the original
 *  bug.  A live run on 2026-10-05 found `~/.config/muse/auth.json` present on a
 *  signed-in account containing only an index:  `schema_version`, and a
 *  `providers.meta` block with `mechanism: "oauth"`, `storage: "keychain"`,
 *  `obtained_via: "device_code"`, `api_base_url`, and the user's name, email,
 *  and avatar URL.  No key, no token.
 *
 *  So the existence of this file proves nothing, and neither does its absence.
 *  What it does carry is the discriminator that matters:  `storage`. */
function museAuthIndexPath(env: Record<string, string | undefined>): string {
  const fromEnv = env.MUSE_AUTH_PATH?.trim();
  if (fromEnv) return fromEnv;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const home = env.HOME || env.USERPROFILE || homedir();
  return join(xdg && xdg.length > 0 ? xdg : join(home, ".config"), "muse", "auth.json");
}

/** Shape of `~/.config/muse/auth.json`, as far as this driver reads it.
 *
 *  Deliberately loose about everything except the one field that matters:
 *  `storage` must be a non-empty string to count as a credential.  Only the
 *  `meta` provider is modelled, and only that provider can satisfy
 *  `museAuthenticated` — the index is a map of providers, and letting any one
 *  of them satisfy the check put an instance with no Meta credential into the
 *  failover chain at `server/safety/turn-safety.ts`, where it fails every turn.
 *
 *  `.passthrough()` because a provider we do not model must not invalidate the
 *  whole index; `.catch(undefined)` per field so a `meta` entry carrying an
 *  unexpected shape reads as "no credential" instead of failing the parse. */
export const authIndexSchema = z
  .object({
    providers: z
      .object({
        meta: z
          .object({ storage: z.string().min(1) })
          .passthrough()
          .optional()
          .catch(undefined),
      })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();

/** The validated shape of the credential index, derived from the schema itself
 *  so the type and the runtime check cannot drift apart.  Exported with it so
 *  the auth tests can assert against the same contract the driver reads. */
export type AuthIndex = z.infer<typeof authIndexSchema>;

/** The credential backend the CLI recorded, or null when there is no index.
 *
 *  The value is no longer used to *reject* a session:  `keychain` means the
 *  token was handed to the OS keychain, and the installed CLI resolves it for
 *  the adapter, so it counts as signed in — see `museAuthenticated`.  It is
 *  still the right thing to read, because a present file with a recorded
 *  `storage` is exactly what distinguishes signed in from signed out. */
function museCredentialStorage(env: Record<string, string | undefined>): string | null {
  const path = museAuthIndexPath(env);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null; // no index: not signed in, or not this CLI's index
  }
  try {
    // Parsed and validated rather than `as`-cast, matching the other drivers:
    // a TypeScript cast only silences the compiler, it does not check anything
    // at runtime, and this value decides whether the setup card clears and
    // whether the instance joins the failover chain.  `.passthrough()` keeps
    // unknown provider entries from failing the whole index — a future
    // provider we do not model must not read as "signed out".
    const parsed = authIndexSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    // Annotating with the inferred type is the point of exporting the schema:
    // if the runtime check and the declared shape ever disagree, this line
    // stops compiling rather than the drift going unnoticed.
    const index: AuthIndex = parsed.data;
    return index.providers?.meta?.storage ?? null;
  } catch {
    // A malformed index is not evidence of a credential, and must never throw
    // out of a snapshot path.
    return null;
  }
}

/** Is Muse Code signed in *for this driver*?
 *
 *  This used to answer `false` for a keychain-backed session, on the theory
 *  that the community adapter's bundled `@muse-code/sdk@1.3.0` predates the
 *  keychain move and would answer "not logged in" while the credential was in
 *  fact fine.  **That theory is wrong, and it is now measured rather than
 *  assumed.**
 *
 *  On a keychain-device-code account, the real `muse-code-acp` adapter
 *  completes `initialize` → `session/new` → `session/prompt` and returns
 *  `stopReason: end_turn`.  The adapter does not read the credential itself:
 *  it spawns `muse serve`, and the installed CLI resolves the keychain token.
 *  The SDK version is irrelevant to the question, because the SDK is not the
 *  component holding the session.
 *
 *  So keychain storage is a real credential and is treated as signed in.  The
 *  old `false` was not cosmetic: it stranded the setup card forever and kept
 *  the instance out of the failover chain at `server/safety/turn-safety.ts`
 *  for a user who had signed in correctly and could run a turn by hand — the
 *  exact "does not work" report this fixes.
 *
 *  `storage` is still read at all, because it is the only thing in the index
 *  that distinguishes "signed in" from "signed out" — the file itself carries
 *  no secret and exists either way. */
export function museAuthenticated(env: Record<string, string | undefined>): boolean {
  if (env.META_API_KEY?.trim()) return true;
  return museCredentialStorage(env) !== null;
}

/** The sign-in sentence the harness shows when this engine is not authenticated.
 *  Exported so a test can hold it to `museAuthenticated` — the bug this encodes
 *  was the two drifting apart.
 *
 *  The API key is offered as one valid route, not the only one: a browser
 *  session stored in the macOS keychain is honoured like any other credential,
 *  because the installed CLI resolves it for the adapter.  The key path is
 *  named here because it is the route that also works on a machine with no
 *  keychain, and because the command reads the key from stdin — so it must
 *  name both the prompt and the Ctrl-D, or a user who followed the card
 *  exactly sat in a terminal that looked hung:  no key, no EOF, no stored
 *  credential, and a card that never cleared. */
export const MUSE_LOGIN_NOTE =
  "Muse Code needs an API key for BotFleet.  A browser session signed into the Mac keychain also works.  To sign in, run `muse auth set --provider meta --api-key-stdin`, paste the key when it prompts, then press Ctrl-D and Enter";

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
  // selection is not passed here either:  it travels over the wire through
  // the `selectModel` hook below, because the adapter serves the model as a
  // session config option and not as a flag.
  spawnArgs: () => [],
  // The model switch, over the adapter's own config option.  The picker id is
  // matched against the options the session advertises and the advertised
  // value is sent back unchanged, because the provider and the profile inside
  // it belong to the user's own account and are never constructed here.  A
  // session that advertises no model option — an adapter older than the one
  // that added them — cannot switch, and the hook says so plainly instead of
  // sending a request the adapter would answer with `-32602`.
  selectModel: {
    configId: MUSE_MODEL_CONFIG_ID,
    valueForModel: (model, advertised) =>
      museModelOptionValue(model, museAdvertisedConfigOptionsSchema.parse(advertised ?? [])),
    modelForValue: (value) => {
      const text = z.string().safeParse(value);
      return text.success ? museModelIdForValue(text.data) : null;
    },
  },
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
