// ZCode — z.ai's GLM Coding Plan agent, driven over the Agent Client
// Protocol through the `zcode-acp-server` bridge.
//
// The engine's own headless mode is one `--prompt` per turn (the `zcodeAgent`
// driver in `server/drivers/zcode.ts`), which cannot carry BotFleet's MCP
// channels, image attachments, or a held permission ask.  The bridge is the
// thing that unlocks those:  it drives the official `zcode app-server
// --stdio`, translates its event stream into ACP `session/update`, and
// bridges ZCode's interaction channel to ACP — preferring `elicitation/create`
// only when the client declares support for it.  BotFleet's initialize offers
// `fs` only (acp/core.ts), so asks arrive as `session/request_permission`,
// which the core already answers.
//
//   BotFleet core (ACP)  ->  zcode-acp-server (npm zcode-acp-server)
//                        ->  zcode app-server --stdio  ->  GLM Coding Plan
//
// Billing rides the GLM Coding Plan behind the local ZCode sign-in, exactly
// as the headless driver:  the bridge reads the desktop app's credential
// files (`~/.zcode/v2/config.json`) or a saved `zcode-acp setup` account, and
// never takes a key from the editor — its own `authenticate` is a readiness
// check, not a login.  Stray Z_AI/GLM/BIGMODEL key env vars are stripped from
// the child so an inherited key cannot silently flip billing off the
// subscription (the same rule the headless driver and kimi.ts apply).
//
// Verified against the installed bridge 0.82.3 (github.com/william0wang/zcode-acp):
// dist/server.js (initialize: `loadSession: true`, one authMethod
// `zcode-credentials`, sessionCapabilities list/resume/fork), dist/handlers/
// session.js (`session/new` and `session/load`/`session/resume` both accept
// `mcpServers`), dist/config/options.js (configOptions `model`, `mode`,
// `thought`; GLM-5.3 thought variants low/high/max; wire value
// `providerId\modelId`, with a `custom:` colon spelling for agent-defined
// providers), and dist/handlers/authenticate.js (the readiness check).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import type { EffortLevel, ModelCatalog } from "../../contracts.ts";
import { ZCODE_CREDENTIAL_ENV } from "../zcode.ts";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./core.ts";

/** Reasoning effort for GLM-5.3, read off the bridge's own vocabulary
 *  (dist/config/options.js:  "GLM-5.3: low/high/max; GLM-5-Turbo: enabled/off;
 *  others may differ").  The values are the backend's `thought` tokens and are
 *  sent verbatim through `session/set_config_option`. */
export const ZCODE_ACP_EFFORT_LEVELS: readonly EffortLevel[] = ["low", "high", "max"];

/** The session config option id that carries reasoning effort on this bridge.
 *  The id is `thought`; its category is `thought_level` (the shared matcher
 *  vocabulary ACP clients key on).  `session/set_config_option` addresses it
 *  by the id. */
export const ZCODE_ACP_EFFORT_CONFIG_ID = "thought";

/** The session config option id that carries the permission mode. */
export const ZCODE_ACP_MODE_CONFIG_ID = "mode";

/** Full-auto turns run the backend's unrestricted mode; a turn the harness
 *  holds (host control, auto-review, a routine allowlist) runs the backend's
 *  standard asking mode, so every ask reaches BotFleet as a
 *  `session/request_permission` instead of being answered locally.  `yolo` is
 *  also the bridge's own default, but it is set explicitly so the mode is a
 *  property of this driver's contract rather than of the bridge's settings
 *  file (whose `session.mode` would otherwise win over the env fallback). */
export function zcodeAcpModeFor(fullAuto: boolean): string {
  return fullAuto ? "yolo" : "build";
}

/** The built-in Coding Plan models, matching the headless driver's catalog
 *  (packages/shared/src/official-glm-model-id.ts in zai-org/ZCode).  GLM-5.3
 *  documents a 1M-token context window (https://docs.z.ai/guides/llm/glm-5.3,
 *  fetched 2026-11-03).  Flash declares an explicit empty effort list, not an
 *  omitted field:  the picker falls back to the engine-wide list for a row
 *  that declares none, and this bridge's thought vocabulary is per model —
 *  Flash's variants are not verified, so offering GLM-5.3's rungs on it would
 *  be the overclaim this driver is written to avoid. */
export const STATIC_ZCODE_ACP_MODELS: ModelCatalog = {
  default: "GLM-5.3",
  options: [
    {
      id: "GLM-5.3",
      label: "GLM-5.3",
      contextWindow: 1_000_000,
      effortLevels: [...ZCODE_ACP_EFFORT_LEVELS],
    },
    { id: "GLM-5.3-Flash", label: "GLM-5.3 Flash", effortLevels: [] },
  ],
};

/** The minimum bridge this driver relies on.  The config-option surface
 *  (`model`/`mode`/`thought`), `loadSession`, `mcpServers` on the session
 *  calls, and the request_permission fallback are all read off 0.82.3; a
 *  bridge older than the 0.82 line is not known to carry them. */
const ZCODE_ACP_MINOR_FLOOR = 82;

/** The session's advertised config options, decoded at the boundary:  the list
 *  is verbatim agent output, and everything this driver reads off it (the
 *  model option's wire values and labels) is parsed before any field is
 *  branched on.  Unknown fields pass through; unknown values degrade to
 *  undefined rather than failing the whole list. */
export const advertisedConfigOptionsSchema = z
  .array(
    z
      .object({
        id: z.string().optional().catch(undefined),
        options: z
          .array(
            z
              .object({
                value: z.string().optional().catch(undefined),
                name: z.string().optional().catch(undefined),
                currentValue: z.string().optional().catch(undefined),
              })
              .passthrough()
              // One garbage entry drops itself, not the whole list.
              .optional()
              .catch(undefined),
          )
          .optional()
          .catch(undefined),
      })
      .passthrough(),
  )
  .catch([]);

/** The wire value of one advertised model selection is the provider id and the
 *  model id joined by a single backslash (`builtin:zai-coding-plan\GLM-5.3`;
 *  dist/config/options.js `formatModelValue`), with a colon spelling for
 *  agent-defined providers (`custom:<urlencoded providerId>:<modelId>`,
 *  `parseModelValue`).  Only the model id is decoded here — the provider half
 *  is the user's own login config and is never constructed or compared. */
export function parseZcodeAcpModelValue(value: string): string | null {
  const custom = /^custom:([^:]+):(.+)$/.exec(value);
  if (custom) {
    try {
      return decodeURIComponent(custom[2]);
    } catch {
      return custom[2];
    }
  }
  const cut = value.lastIndexOf("\\");
  return cut === -1 ? null : value.slice(cut + 1);
}

/** Match the picker model against the session's advertised model options and
 *  return the advertised wire value verbatim:  like mcode, the provider half
 *  of the value belongs to the user's own login, so a value is matched, never
 *  built.  Returns null when the session advertises no model option (the
 *  session keeps its login default and the picker rides it, as before);
 *  throws when a model option exists but the requested model is not in it. */
export function zcodeAcpModelOptionValue(
  model: string,
  advertised: z.infer<typeof advertisedConfigOptionsSchema> | undefined,
): string | null {
  const modelOption = advertised?.find((option) => option.id === "model");
  const available = (modelOption?.options ?? []).filter((option) => option !== undefined);
  if (!modelOption || available.length === 0) return null;
  const wanted = model.trim();
  for (const option of available) {
    if (option.value !== undefined && parseZcodeAcpModelValue(option.value) === wanted) {
      return option.value;
    }
  }
  const names = available.map((option) => String(option.name ?? option.value ?? "?")).join(", ") || "none";
  throw new Error(`ZCode does not offer ${wanted} for this sign-in — available: ${names}`);
}

/** Where the bridge looks for credentials, resolved the way it resolves them:
 *  `ZCODE_HOME` relocates the whole `.zcode` root, and the desktop files live
 *  under `v2/` (dist/utils.js `ZCODE_CREDS_PATH` and the setup accounts
 *  file).  Per call, so a probe with a relocated HOME reads that home. */
function zcodeAcpCredentialPaths(env: Record<string, string | undefined>) {
  const root = env.ZCODE_HOME?.trim() || join(env.HOME || env.USERPROFILE || homedir(), ".zcode");
  return { accounts: join(root, "v2", "acp-accounts.json"), desktop: join(root, "v2", "config.json") };
}

/** Is ZCode signed in *as far as this driver can see from files*?
 *
 *  Two cheap rungs of the bridge's own ladder (dist/config/account-provider.js
 *  `zcodeCredentialsPresent`):  a saved `zcode-acp setup` account, or a
 *  desktop `config.json` provider entry carrying an API key — including the
 *  `builtin:` coding-plan entries, where an entry only counts when the
 *  desktop left it enabled.  The deeper 3.15+ OAuth rungs are deliberately
 *  not replicated:  they read an availability cache and a bundled provider
 *  table that would drift.  A keyless-but-entitled desktop install therefore
 *  reads not-signed-in from this snapshot, and the per-turn `authenticate`
 *  call — which asks the bridge itself — is what settles those. */
/** A saved `zcode-acp setup` account file:  one JSON object with at least one
 *  entry.  Existence alone proved nothing (the Kody finding):  a zero-byte or
 *  truncated file from an interrupted setup must read as "no credential this
 *  driver can see", exactly like a missing one. */
const setupAccountsSchema = z.record(z.string(), z.unknown());

export const desktopCredentialConfigSchema = z
  .object({
    provider: z
      .record(
        z.string(),
        z
          .object({
            enabled: z.boolean().optional().catch(undefined),
            options: z
              .object({ apiKey: z.string().optional().catch(undefined) })
              .passthrough()
              .optional()
              .catch(undefined),
          })
          .passthrough(),
      )
      .optional()
      .catch(undefined),
  })
  .passthrough();

export function zcodeAcpAuthenticated(env: Record<string, string | undefined>): boolean {
  const { accounts, desktop } = zcodeAcpCredentialPaths(env);
  let accountsRaw: string;
  try {
    accountsRaw = readFileSync(accounts, "utf8");
  } catch {
    accountsRaw = "";
  }
  if (accountsRaw.trim()) {
    let accountsJson: unknown;
    try {
      accountsJson = JSON.parse(accountsRaw);
    } catch {
      accountsJson = undefined;
    }
    const accounts = setupAccountsSchema.safeParse(accountsJson);
    if (accounts.success && Object.keys(accounts.data).length > 0) return true;
  }
  let raw: string;
  try {
    raw = readFileSync(desktop, "utf8");
  } catch {
    return false;
  }
  // Parsed and validated rather than `as`-cast (the muse rule):  a malformed
  // desktop config is "no credential this driver can see", never a throw out
  // of a snapshot path.
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return false;
  }
  const parsed = desktopCredentialConfigSchema.safeParse(json);
  if (!parsed.success) return false;
  for (const [id, entry] of Object.entries(parsed.data.provider ?? {})) {
    const key = entry.options?.apiKey;
    if (key?.trim()) {
      if (!id.startsWith("builtin:") || entry.enabled === true) return true;
    }
  }
  return false;
}

/** One `session/set_config_option` reply:  `{ kind, currentValue, options }`
 *  on the bridge, possibly a bare `{}` ACK elsewhere.  Only a *reported*
 *  currentValue is evidence — a bare ACK reports nothing to compare against.
 *  The reply is decoded at this boundary; anything else reads as "nothing
 *  reported". */
const configOptionReplySchema = z
  .object({
    currentValue: z.string().optional().catch(undefined),
    options: z
      .array(
        z
          .object({
            id: z.string().optional().catch(undefined),
            currentValue: z.string().optional().catch(undefined),
          })
          .passthrough(),
      )
      .optional()
      .catch(undefined),
  })
  .passthrough();

function reportedConfigValue(result: any, configId: string): string | undefined {
  const decoded = configOptionReplySchema.safeParse(result);
  if (!decoded.success) return undefined;
  const hit = decoded.data.options?.find((option) => option.id === configId);
  const value = hit?.currentValue ?? decoded.data.currentValue;
  return value;
}

/** JSON-RPC "invalid params": what the bridge answers for an unknown config
 *  option id (dist/handlers/session.js dispatch → null → -32602). */
const ZCODE_ACP_INVALID_PARAMS = -32602;

const support: AcpSupport = {
  driverKind: "zcodeAcp",
  displayName: "ZCode",
  models: STATIC_ZCODE_ACP_MODELS,
  // The engine gate:  this engine can set effort at all.  Every picker row
  // carries its own explicit list (see STATIC_ZCODE_ACP_MODELS).
  effortLevels: ZCODE_ACP_EFFORT_LEVELS,
  images: true,
  // The load-bearing flag, verified rather than assumed:  the bridge takes a
  // per-session `mcpServers` list straight off `session/new` and the resume
  // calls (dist/handlers/session.js `resumeParams` forwards it onto the
  // backend params), which is what mounts BotFleet's team, computer and
  // Composio channels — the whole reason this driver exists beside the
  // headless one.
  mcpServers: true,
  defaultCli: "zcode-acp-server",
  // The package installs a second bin, the unified CLI (`zcode-acp`); the
  // Engines picker searches it so an install that only exposes that one is
  // still found.  It is a discovery alias, not a spawn target:  the stdio
  // server is `zcode-acp-server` itself (the Zed config in its README names
  // the same bin).
  cliAliases: ["zcode-acp"],
  nativeSource: "zcode.acp",
  // Must name only sign-in paths that produce a credential this driver can
  // see (the muse lesson):  the desktop app's Connect flow writes
  // `~/.zcode/v2/config.json`, and `zcode-acp setup` writes
  // `~/.zcode/v2/acp-accounts.json` — both read by
  // `zcodeAcpAuthenticated`.  The setup command reads the key from a hidden
  // prompt, never argv, so it cannot land in shell history.
  loginNote:
    "ZCode needs a GLM Coding Plan sign-in.  Sign in through the ZCode desktop app, or run `zcode-acp setup --provider zai` in a terminal and paste an individual Coding Plan key at the hidden prompt",
  install: {
    // The ZCode CLI itself ships inside the desktop app and the bridge
    // discovers it there (`ZCODE_BIN` → PATH → the app bundle), so the one
    // install line is the bridge.  Node ≥ 22 is the bridge's own floor
    // (`node:sqlite`), which `needsNode` surfaces.
    command: {
      darwin: "npm install -g zcode-acp-server",
      linux: "npm install -g zcode-acp-server",
      win32: "npm install -g zcode-acp-server",
    },
    docsUrl: "https://github.com/william0wang/zcode-acp",
    signInCommand: "zcode-acp setup --provider zai",
    needsNode: true,
  },
  // No argv:  the `zcode-acp-server` bin IS the stdio server.  Model and mode
  // travel over the wire (selectModel + configureSession), not flags.
  spawnArgs: () => [],
  selectModel: {
    configId: "model",
    // `advertised` is the core's verbatim `configOptions` list; it is decoded
    // here, at this driver's boundary, before any field is read.
    valueForModel: (model, advertised) => zcodeAcpModelOptionValue(model, advertisedConfigOptionsSchema.parse(advertised ?? [])),
    modelForValue: (value) => {
      const text = z.string().safeParse(value);
      return text.success ? parseZcodeAcpModelValue(text.data) : null;
    },
  },
  // Billing hygiene (mirrors the headless driver's strip):  an inherited
  // z.ai/GLM/BigModel key must not flip a turn onto metered API billing, and
  // those names are not in the core's PROVIDER list, so they are stripped
  // here.  The mode env only sets a NEW session's starting mode — a resumed
  // session's mode is corrected over the wire in configureSession below.
  transformEnv: (env, config) => {
    for (const key of ZCODE_CREDENTIAL_ENV) delete env[key];
    env.ZCODE_ACP_MODE = zcodeAcpModeFor(config.fullAuto);
  },
  // The bridge advertises exactly one authMethod, `zcode-credentials`, and its
  // `authenticate` is a readiness check (credentials present → `{}`; absent →
  // an error naming the sign-in paths) — drivable from inside the handshake,
  // unlike the terminal logins every sibling skips.  "fail" is therefore the
  // honest stance:  a snapshot that cannot see the deeper OAuth rungs is
  // corrected by asking the bridge itself, and a bridge that answers the
  // check with "no credentials" settles auth_required with that message.
  pickAuthMethod: (authMethods) => authMethods.find((method) => method.id === "zcode-credentials")?.id ?? null,
  authFailure: "fail",
  // This instance's data root, not the server process's:  ZCODE_HOME or a
  // custom HOME must not be checked against the server user's own ~/.zcode.
  isAuthenticated: (env) => zcodeAcpAuthenticated(env),
  // Two settings land between session/new (or session/load) and the first
  // prompt, always in this order:
  //
  // 1.  Mode.  Sent on EVERY turn, not only fresh sessions:  the env default
  //     above only shapes a new session, and a session created under the
  //     other stance (an asking turn that resumed into a full-auto one, or
  //     the reverse) would otherwise keep its earlier mode.  A held turn must
  //     actually ask, and a full-auto turn must actually run — the mode is a
  //     property of this turn's contract, not of the session's history.
  //
  // 2.  Effort, after the mode and only for an explicit pick from the
  //     model's own list.  The core's model switch runs before this hook, and
  //     a switch can reset the backend's thought level, so sending effort
  //     first could be discarded.  "No pick" is skipped rather than defaulted:
  //     this vocabulary has no `default` token to send, so a session keeps
  //     the backend's own level, and a thread that never picked effort keeps
  //     meaning that.  A pick outside the model's list is skipped with a
  //     warning (GLM-5.3 takes low/high/max; the picker only offers those,
  //     so this path is a stale thread setting, not a live click) — but a
  //     REFUSED set always fails the turn, never silently runs another level:
  //     that is a paid turn the person did not ask for.
  async configureSession({ request, sessionId, config, turn, sessionConfigOptions }) {
    // The session's own option list is the authority on whether an option can
    // be set at all (the mcode rule):  a known, non-empty list without the
    // option belongs to a bridge that cannot set it, so the turn runs at the
    // bridge's own defaults exactly as before.  undefined means the list is
    // unknown or empty — nothing observed says the option is missing, so a
    // set that comes back -32602 is tolerated (an older bridge) instead of
    // failing the turn.  The list is decoded at this boundary; garbage
    // entries drop themselves, so a list that parses to nothing carries no
    // evidence either way.
    const sessionOptions = advertisedConfigOptionsSchema.parse(sessionConfigOptions ?? []);
    const advertised = (configId: string): boolean | undefined => {
      if (sessionOptions.length === 0) return undefined;
      return sessionOptions.some((option) => option?.id === configId);
    };
    const modeAdvertised = advertised(ZCODE_ACP_MODE_CONFIG_ID);
    if (modeAdvertised === false) {
      console.warn(`[zcode] this bridge offers no session mode option; running in the bridge's own mode`);
    } else {
      const mode = zcodeAcpModeFor(config.fullAuto);
      let result: any;
      try {
        result = await request("session/set_config_option", {
          sessionId,
          configId: ZCODE_ACP_MODE_CONFIG_ID,
          value: mode,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // SAFETY: the core attaches `code` to a JSON-RPC error with
        // Object.assign; any other thrown value has none, and the `?.`
        // tolerates a non-object.
        const code = (error as { code?: unknown } | null)?.code;
        // A held turn must actually ask and a full-auto turn must actually
        // run:  anything other than an option the session never advertised
        // refuses the turn rather than running it in an unknown mode.
        if (modeAdvertised === true || code !== ZCODE_ACP_INVALID_PARAMS) {
          throw new Error(`ZCode did not accept session mode ${mode}: ${message}`);
        }
        console.warn(`[zcode] this bridge offers no session mode option; running in the bridge's own mode`);
        result = undefined;
      }
      const confirmedMode = reportedConfigValue(result, ZCODE_ACP_MODE_CONFIG_ID);
      if (confirmedMode !== undefined && confirmedMode !== mode) {
        throw new Error(`ZCode did not accept session mode ${mode}: still ${confirmedMode}`);
      }
    }

    // Effort arrives as the shared EffortLevel union already — no trim, or
    // the value widens to string and drops out of the rung check.
    const effort = turn.effort;
    if (!effort) return;
    // The rung vocabulary is per model, so an explicit effort needs the
    // model the session will actually run:  the turn's pick, else the model
    // the session advertises as current, else this driver's default.  A
    // thread on the default model that picks an effort must not silently run
    // at the backend's level.
    const advertisedCurrent = sessionOptions.find((option) => option?.id === "model")?.currentValue;
    const currentText = z.string().safeParse(advertisedCurrent);
    const model =
      turn.model?.trim()
      ?? (currentText.success ? parseZcodeAcpModelValue(currentText.data) : undefined)
      ?? STATIC_ZCODE_ACP_MODELS.default;
    const levels = STATIC_ZCODE_ACP_MODELS.options.find((option) => option.id === model)?.effortLevels ?? [];
    if (!levels.includes(effort)) {
      console.warn(`[zcode] ${model} has no effort "${effort}"; running at the session's own level`);
      return;
    }
    const effortAdvertised = advertised(ZCODE_ACP_EFFORT_CONFIG_ID);
    if (effortAdvertised === false) {
      console.warn(`[zcode] ${model}: this bridge offers no thought option; running at the backend's own level`);
      return;
    }
    let effortResult: any;
    try {
      effortResult = await request("session/set_config_option", {
        sessionId,
        configId: ZCODE_ACP_EFFORT_CONFIG_ID,
        value: effort,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // SAFETY: the core attaches `code` to a JSON-RPC error with
      // Object.assign; any other thrown value has none, and the `?.`
      // tolerates a non-object.
      const code = (error as { code?: unknown } | null)?.code;
      // -32602 is only survivable when the session never advertised the
      // option at all (the list was withheld); when it did, a refusal is a
      // real failure — the sticky-level risk mcode's comment describes.
      if (effortAdvertised === true || code !== ZCODE_ACP_INVALID_PARAMS) {
        throw new Error(`ZCode did not accept thought level ${effort} for ${model}: ${message}`);
      }
      console.warn(`[zcode] ${model}: ${message}`);
      return;
    }
    const confirmedEffort = reportedConfigValue(effortResult, ZCODE_ACP_EFFORT_CONFIG_ID);
    if (confirmedEffort !== undefined && confirmedEffort !== effort) {
      throw new Error(`ZCode did not accept thought level ${effort} for ${model}: still ${confirmedEffort}`);
    }
  },
  // `loadSession: true` is in the bridge's initialize answer, so the core's
  // default `session/load` resume is kept (the bridge also speaks
  // `session/resume`; no reason to leave the default).
  versionCompatibilityReason: zcodeAcpVersionCompatibilityReason,
};

/** The version gate, exported pure so the tests can pin it without spawning.
 *  A custom wrapper (`config.cli` other than the default bin) is exempt:  the
 *  core skips the gate for it, and the helper answers the same way. */
export function zcodeAcpVersionCompatibilityReason(version: string, config: AcpConfig): string | null {
  if (config.cli !== "zcode-acp-server") return null;
  // The bridge prints `0.82.3`; a fork or wrapper may print `v0.82.3` or
  // carry a `-beta` suffix.  The floor reads major and minor only.
  const match = /^v?(\d+)\.(\d+)(?:[.+-]|$)/.exec(version.trim());
  if (!match) return `\`${config.cli}\` did not report a recognizable version ("${version.trim()}")`;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > 0 || minor >= ZCODE_ACP_MINOR_FLOOR) return null;
  return (
    `zcode-acp-server ${version.trim()} lacks the config options and session resume this driver drives. ` +
    `Install 0.82.0 or newer:  npm install -g zcode-acp-server`
  );
}

export const ZcodeAcpDriver = createAcpDriver(support);
