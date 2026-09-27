// Generic ACP (Agent Client Protocol) driver core — one JSON-RPC-2.0-over-
// stdio session runtime that every ACP CLI harness (Grok Build, Gemini CLI,
// …) rides. Modeled on t3code's AcpSessionRuntime + per-agent AcpSupport
// split: the protocol mechanics live here, the per-harness quirks (spawn
// argv, auth method, model catalog, sign-in check) live in a small support
// object. Adding a harness = write server/drivers/acp/<name>.ts.
//
// ACP has no `turn/completed` notification: the `session/prompt` RPC *result*
// is the completion signal (it carries stopReason + usage). Permission
// requests arrive as server→client `session/request_permission` and surface
// as canonical request.opened events, answered fail-closed (nothing approved
// unless the agent explicitly offered an `allow`-kind option — option ORDER
// is never a security contract). session/load REPLAYS history as ordinary
// session/update notifications, so updates are double-gated: nothing emits
// before the prompt is sent, and `_meta.isReplay` updates are dropped.
import { homedir } from "node:os";

import { PROVIDER_CREDENTIAL_ENV, WORKSPACE_CREDENTIAL_ENV } from "../../config.ts";
import { cliProbeEnvironment } from "../../cli-probe-env.ts";
import { decodeInjectId } from "../local-inject.ts";
import { toolFields } from "../../tool-fields.ts";
import { describeResult } from "../../../shared/tool-activity.ts";
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../../procs.ts";
import { classifyError, computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "../retry.ts";
import {
  decodeInitTimeoutMs,
  describeInitDeadline,
  describeSlowInit,
  readHostLoad,
  resolveInitDeadline,
  SLOW_INIT_LOG_MS,
} from "./init-deadline.ts";

/**
 * A `host::model` pick talks to a loopback server with its own key.
 * Subscription ACP login (grok.com cached_token) must not fail that turn.
 */
export function skipSubscriptionAuthForLocalInject(model: string | undefined): boolean {
  return Boolean(decodeInjectId(model));
}

import type {
  DriverCreateInput,
  EffortLevel,
  EngineInstall,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  ModelCatalog,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  ProviderErrorCode,
} from "../../contracts.ts";
import { newEventId, newId } from "../../contracts.ts";
import { computerProxyEnv } from "../../container-computer.ts";
import { hostToolPrefix, turnComputerMounts } from "../../computer-grants.ts";
import { augmentedPath } from "../../env-path.ts";

// Resolved from the server root, never relative to this file: bundling inlines
// this module two directories up, so the `".."` pair here would climb past the
// packaged server dir entirely. See server/proxy-paths.ts.
const COMPUTER_PROXY_PATH = SPAWNED_PROXIES.computer;
import { appendNative } from "../native.ts";
import { SPAWNED_PROXIES } from "../../proxy-paths.ts";

/** Stdio MCP server as ACP session/new sends it. */
export type AcpStdioMcpServer = {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
};

/** Build the same mcpServers array every mcpServers:true ACP engine receives. */
export function acpMcpServers(turn: Pick<SendTurnInput, "integrations">): AcpStdioMcpServer[] {
  const servers: AcpStdioMcpServer[] = [];
  const acpEnv = (env: Record<string, string>) =>
    Object.entries(env).map(([name, value]) => ({ name, value: String(value) }));
  const agents = turn.integrations?.agents;
  if (agents) {
    servers.push({ name: "agents", command: agents.command, args: agents.args, env: acpEnv(agents.env) });
  }
  const composio = turn.integrations?.composio;
  if (composio) {
    servers.push({
      name: "composio",
      command: composio.command,
      args: composio.args,
      env: acpEnv(composio.env),
    });
  }
  // The bot's computers, mounted exactly like the Claude driver does.
  // Cloud boxes use the REST adapter; host, sandbox, and VPS Cua
  // connections expose Cua Driver's official MCP server directly. Every
  // grant gets its own server — this was an if/else if that dropped the
  // second computer a bot had been given.
  for (const mount of turnComputerMounts(turn.integrations)) {
    if (mount.box) {
      servers.push({
        name: mount.name,
        command: process.execPath,
        args: [COMPUTER_PROXY_PATH],
        env: acpEnv({ ELECTRON_RUN_AS_NODE: "1", ...computerProxyEnv(mount.box) }),
      });
    } else if (mount.stdio) {
      servers.push({
        name: mount.name,
        command: mount.stdio.command,
        args: mount.stdio.args,
        env: acpEnv(mount.stdio.env ?? {}),
      });
    }
  }
  const phone = turn.integrations?.phone;
  if (phone) {
    servers.push({
      name: "phone",
      command: phone.command,
      args: phone.args,
      env: acpEnv(phone.env ?? {}),
    });
  }
  const qdrant = turn.integrations?.qdrant;
  if (qdrant) {
    servers.push({
      name: "qdrant",
      command: qdrant.command,
      args: qdrant.args,
      env: acpEnv(qdrant.env ?? {}),
    });
  }
  return servers;
}

/** Result of `AcpSupport.wrapSpawn`: a possibly rewritten CLI and argv. */
export type AcpSpawnRewrite = {
  cli: string;
  args: string[];
  env?: { ELECTRON_RUN_AS_NODE: string };
};

export interface AcpConfig {
  cli: string;
  fullAuto: boolean;
  /** Optional home for this instance's sessions. */
  workspace?: string;
  /** Exact `initialize` deadline for this instance, overriding the engine's
   * load-scaled default (see `init-deadline.ts`). */
  initTimeoutMs?: number;
  /** Hard `session/prompt` backstop, regardless of streaming activity.  The
   * default remains below the harness watchdog so the driver can cancel and
   * settle its own process first. */
  promptTimeoutMs?: number;
  /** Renewable `session/prompt` idle deadline.  Fires only after this many
   * ms with NO inbound traffic at all — no `session/update` (message chunk,
   * thought chunk, tool call, or tool result) and no permission request.
   * Any of those resets the clock, so a legitimately long-running turn is
   * never cut off; only a fully wedged one is.  `promptTimeoutMs` still
   * applies underneath this as the absolute backstop. */
  promptIdleMs?: number;
}

/** Per-harness specifics — everything that differs between Grok, Gemini, … */
export interface AcpSupport {
  driverKind: string;
  displayName: string;
  /** Omit for subscription CLIs (the default). Custom-only CLIs sit below
   *  the picker-rail divider and have no first-party cloud catalog. */
  access?: "subscription" | "custom";
  models: { default: string; options: Array<{ id: string; label: string }> };
  /** Effort levels this harness's CLI accepts, ascending. Omit when it has
   * no reasoning-effort control. Static for the same reason `models` is:
   * describe() runs before any session exists, so there is no _meta to read
   * — eventually both should come from initialize's _meta.modelState. */
  effortLevels?: readonly EffortLevel[];
  /** Default CLI binary name if the instance config doesn't override it. */
  defaultCli: string;
  /** Base `initialize` deadline for a CLI whose cold boot is heavier than
   *  the 60 s default assumes.  Host load still stretches it; an instance's
   *  `initTimeoutMs` still overrides it. */
  initTimeoutMs?: number;
  /** Optional live model catalog. A failed lookup keeps the last usable catalog.
   *  `config` is the instance decode so a support can ask the same binary it
   *  will spawn (custom `cli` paths), not whatever happens to be named on PATH. */
  resolveModels?(
    environment: Record<string, string | undefined>,
    config: AcpConfig,
  ): ModelCatalog | Promise<ModelCatalog>;
  /** Native-protocol log label, e.g. "grok.acp". */
  nativeSource: string;
  /** Whether models behind this ACP harness can consume a referenced image.
   * Most coding agents can open local files; opt out for text-only agents. */
  images?: boolean;
  /** Whether this harness's ACP server actually mounts what we hand it in
   * `session/new.mcpServers`.
   *
   * The core builds those servers for every harness, so the flags below were
   * hardcoded true — but a harness that ignores `mcpServers` gets the app
   * offering connected apps, the computer and phone tools it can never use.
   * contracts.ts is explicit: never show a knob the driver cannot turn.
   * Default true, because every sibling honours it; opt out when a harness
   * demonstrably does not. */
  mcpServers?: boolean;
  /** Message shown when the CLI is present but not signed in. */
  loginNote: string;
  /** How a user installs this harness's CLI; surfaced by the setup UI. */
  install?: EngineInstall;
  /** CLI argv AFTER the binary name to enter ACP stdio mode. */
  spawnArgs(config: AcpConfig, turn: SendTurnInput): string[];
  /** Optional rewrite of the spawned CLI.  DSH sits a stdio bridge in front
   * of stock `dsh` so session/new mcpServers are accepted and delivered. */
  wrapSpawn?(cli: string, args: string[], turn: SendTurnInput): AcpSpawnRewrite;
  /** Resume RPC used by this ACP server.  Most older harnesses implement
   * `session/load`; current ACP v1 servers may expose `session/resume`. */
  resumeMethod?: "session/load" | "session/resume";
  /** Reject an installed stock CLI whose reported version cannot satisfy the
   * protocol contract this support relies on.  A custom wrapper can choose
   * its own compatibility policy by inspecting `config.cli`. */
  versionCompatibilityReason?(version: string, config: AcpConfig): string | null;
  /** Provider credential variables this ACP child is allowed to inherit. */
  credentialEnv?: readonly string[];
  /** Select the model through a session config option instead of argv, for
   *  harnesses whose ACP subcommand takes no -m (opencode). The agent must
   *  CONFIRM the requested model before we prompt: silently running a model
   *  other than the one the picker shows is the failure this guards. */
  selectModel?: {
    configId: string;
    /** Translate the picker model into the option's opaque ACP wire value.
     * The UI-facing session event keeps the picker id. */
    valueForModel?(model: string): string;
    /** Translate a confirmed opaque ACP value back to the picker model id
     * when the caller accepts the session default. */
    modelForValue?(value: unknown): string | null;
  };
  /** Mutate the child env in place: strip a key, inject a policy. Receives the
   *  instance config so a support can vary with fullAuto. */
  transformEnv?(env: Record<string, string | undefined>, config: AcpConfig): void;
  /** Mutate the child env after the turn model is known. Catalog refresh and
   *  snapshot share `transformEnv` and must not see a per-turn overlay. */
  applyTurnEnv?(
    env: Record<string, string | undefined>,
    ctx: { model?: string; requestedModel?: string },
  ): void;
  /** Pick the ACP authenticate methodId from initialize's advertised
   * authMethods; return null to skip the authenticate step. */
  pickAuthMethod(authMethods: Array<{ id?: string }>): string | null;
  /** "fail": abort the turn if snapshot auth is missing AND authenticate
   *  is missing/errors (subscription CLIs). A signed-in CLI still proceeds
   *  on its ambient login when initialize omits the expected method.
   *  "continue": proceed anyway (CLIs that work off an ambient login). */
  authFailure: "fail" | "continue";
  /** snapshot(): can this harness actually run a turn? (env already carries the
   *  merged config). May be async for harnesses that have to ask the CLI. */
  isAuthenticated(env: Record<string, string | undefined>, config: AcpConfig): boolean | Promise<boolean>;
  /** Refuse a first-party cloud turn before spawning when snapshot auth is
   * false. Local injected models deliberately bypass this subscription gate. */
  requireAuthenticationBeforeSpawn?: boolean;
  /** Classify provider-native failures without coupling the core to messages. */
  classifyError?(error: unknown): ProviderErrorCode | undefined;
  /** Compose the session/prompt text. Default prepends the persona. */
  buildPromptText?(turn: SendTurnInput): string;
  /** Rewrite a picker id (`omlx::model`) into the CLI-native id before spawn
   * and session/select. Local inject writers live here so the child sees a
   * model it already knows. */
  resolveTurnModel?(
    model: string | undefined,
    env: Record<string, string | undefined>,
  ): string | undefined;
  /** Apply per-session settings between session/new (or session/load) and the
   * first session/prompt. Some CLIs ignore argv and take the model/mode over
   * the wire instead (droid), so this is the only place the pick can land; a
   * throw here fails the turn rather than silently running another model. */
  configureSession?(ctx: {
    request: (method: string, params: unknown, timeoutMs?: number) => Promise<any>;
    sessionId: string;
    config: AcpConfig;
    turn: SendTurnInput;
    /** `session/new` (or `session/load`) advertised model list, verbatim. Some
     * CLIs namespace their ACP model ids differently from their argv `--model`
     * slugs (Cursor answers `default[]` where the CLI calls it `auto`), so a
     * driver that only knows the argv slug cannot form a valid set_model
     * without this. Empty when the agent advertised none. */
    sessionModels: Array<{ modelId?: string; name?: string }>;
  }): Promise<void>;
}

// authenticate and set_config_option run on a child that already booted;
// the cold-start `initialize` deadline lives in init-deadline.ts.
const INIT_TIMEOUT = 60_000;
/** Relaunches an initialize timeout may spend from the retry budget. */
const MAX_INIT_TIMEOUT_RELAUNCHES = 1;
const SESSION_CONFIG_TIMEOUT = 20_000; // configureSession's per-request default
/** Upper bound on per-driver model discovery during registry load. */
const BOOT_MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
// session/new does strictly more than session/load — spawn, authenticate,
// connect every MCP server — so it had no business being given a quarter of
// the budget. Observed p90 is around 8 s; the old 30 s bound was tripping on
// cold starts with many servers configured.
const NEW_SESSION_TIMEOUT = 120_000;
const LOAD_SESSION_TIMEOUT = 120_000; // history replay on a long thread is slow
// Hard backstop: fires regardless of streaming activity.  Kept as a floor
// under the renewable idle deadline below — an agent that streams filler
// forever without ever finishing must still die eventually.
const DEFAULT_PROMPT_MAX_MS = 18 * 60_000;
const MIN_PROMPT_TIMEOUT_MS = 1_000;
const MAX_PROMPT_TIMEOUT_MS = 20 * 60_000;
// Renewable: restarts on every inbound line (session/update or a permission
// request), so this only trips on TOTAL silence — see `request`'s `armIdle`.
const DEFAULT_PROMPT_IDLE_MS = 180_000;
const MIN_PROMPT_IDLE_MS = 1_000;
const MAX_PROMPT_IDLE_MS = 20 * 60_000;
const CANCEL_FLUSH_GRACE_MS = 50;
const FORCE_EXIT_AFTER_MS = 2_000;

/** "3 minutes" at the real default, "N s" for anything not a whole number
 *  of minutes (short test windows included) — used only in the idle-stall
 *  message below. */
function describeIdleWindow(ms: number): string {
  const minutes = ms / 60_000;
  if (Number.isInteger(minutes) && minutes >= 1) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${Math.max(1, Math.round(ms / 1000))} s`;
}

class AcpRpcTimeoutError extends Error {
  readonly method: string;

  /** `detail` extends the message ("… timed out after 180 s (…)") and must
   *  stay free of turn content: it reaches logs and Sentry breadcrumbs. */
  constructor(method: string, detail?: string) {
    super(detail ? `${method} timed out ${detail}` : `${method} timed out`);
    this.name = "AcpRpcTimeoutError";
    this.method = method;
  }
}

/** Distinct from `AcpRpcTimeoutError`: this is the renewable idle guard
 *  tripping on total silence, not the hard wall-clock ceiling elapsing. */
class AcpPromptIdleError extends Error {
  readonly method: string;

  constructor(method: string, idleMs: number) {
    super(`${method} produced no output for ${describeIdleWindow(idleMs)} and was stopped as a stall.`);
    this.name = "AcpPromptIdleError";
    this.method = method;
  }
}

class AcpResumeError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(
      "The saved ACP session could not be resumed.  Start a fresh task or rewind this conversation to replay its visible history.",
      options,
    );
    this.name = "AcpResumeError";
  }
}

/** One spelling for a turn's stop reason.
 *
 * The ACP wire format is camelCase and several agents send `endTurn`, while
 * this driver was written against the snake_case spelling and matched only
 * `end_turn`.  Anything it did not recognise counted as a failure, so every
 * successful turn from an agent using the other spelling was recorded as a
 * failed one — silently, because the turn itself had gone fine.
 *
 * Both spellings mean the same thing, so accept both rather than picking a
 * side, and leave an unknown reason alone so it still reads as a failure. */
export function normalizeStopReason(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

function decodeAcpConfig(defaultCli: string) {
  return (raw: unknown): AcpConfig => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const promptTimeoutMs =
      typeof o.promptTimeoutMs === "number" &&
      Number.isFinite(o.promptTimeoutMs) &&
      Number.isInteger(o.promptTimeoutMs) &&
      o.promptTimeoutMs >= MIN_PROMPT_TIMEOUT_MS &&
      o.promptTimeoutMs <= MAX_PROMPT_TIMEOUT_MS
        ? o.promptTimeoutMs
        : undefined;
    const initTimeoutMs = decodeInitTimeoutMs(o.initTimeoutMs);
    const promptIdleMs =
      typeof o.promptIdleMs === "number" &&
      Number.isFinite(o.promptIdleMs) &&
      Number.isInteger(o.promptIdleMs) &&
      o.promptIdleMs >= MIN_PROMPT_IDLE_MS &&
      o.promptIdleMs <= MAX_PROMPT_IDLE_MS
        ? o.promptIdleMs
        : undefined;
    return {
      cli: typeof o.cli === "string" ? o.cli : defaultCli,
      fullAuto: o.fullAuto === true,
      workspace: typeof o.workspace === "string" ? o.workspace : undefined,
      ...(initTimeoutMs === undefined ? {} : { initTimeoutMs }),
      ...(promptTimeoutMs === undefined ? {} : { promptTimeoutMs }),
      ...(promptIdleMs === undefined ? {} : { promptIdleMs }),
    };
  };
}

/**
 * ACP JSON-RPC-over-stdio driver. Harness differences (argv, auth, catalog)
 * live in `support`; this is the shared handshake and turn runtime.
 */
export function createAcpDriver(support: AcpSupport): ProviderDriver<AcpConfig> {
  const DRIVER_KIND = support.driverKind;
  const SOURCE = support.nativeSource;
  const decodeConfig = decodeAcpConfig(support.defaultCli);

  return {
    driverKind: DRIVER_KIND,
    metadata: {
      displayName: support.displayName,
      supportsMultipleInstances: true,
      access: support.access ?? "subscription",
    },
    install: support.install,
    models: support.models,
    decodeConfig,
    defaultConfig: () => decodeConfig({}),

    async create(input: DriverCreateInput<AcpConfig>): Promise<ProviderInstance> {
      const { instanceId, config } = input;
      const childEnv = (effective: AcpConfig = config) => {
        const env: Record<string, string | undefined> = {
          ...process.env,
          ...input.environment,
          PATH: augmentedPath(),
        };
        const allowedCredentials = new Set(support.credentialEnv ?? []);
        // two lists, one rule: foreign PROVIDER keys must not flip a CLI's
        // billing off its own login, and WORKSPACE credentials (box token,
        // voice key, …) are the harness's secrets — riding along in
        // `...process.env` is not a grant. A driver keeps only what its
        // credentialEnv allowlist names.
        for (const key of [...PROVIDER_CREDENTIAL_ENV, ...WORKSPACE_CREDENTIAL_ENV]) {
          if (!allowedCredentials.has(key)) delete env[key];
        }
        support.transformEnv?.(env, effective);
        return env;
      };
      let models = support.models;
      const refreshModels = async () => {
        if (!support.resolveModels) return;
        try {
          const resolved = await support.resolveModels(childEnv(), config);
          if (resolved.options.length) models = resolved;
        } catch {
          // Keep the last usable catalog when an optional discovery source is down.
        }
      };
      // Model discovery is best-effort at boot: a CLI that stalls must not
      // keep the whole harness from listening. Past the deadline the static
      // catalog stands and the refresh finishes in the background.
      await Promise.race([
        refreshModels(),
        new Promise<void>((resolve) => setTimeout(resolve, BOOT_MODEL_DISCOVERY_TIMEOUT_MS).unref?.()),
      ]);
      const listeners = new Set<RuntimeEventListener>();
      interface Turn {
        stop: () => void;
        interrupt: () => void;
        turnId: string;
        asks: Map<string, (behavior: string, source?: "user" | "timeout" | "system") => void>;
      }
      const active = new Map<string, Turn>();
      let disposed = false;
      // Retry bookkeeping lives PER THREAD, not per sendTurn call: a relaunch
      // re-enters sendTurn, and the budget has to survive that hop or every
      // attempt would look like the first one.  Mirrors claude.ts, which owns
      // the same shape for the same reason.
      const retryState = new Map<string, { attempt: number; cancelled: boolean }>();
      // A relaunch waits real seconds; the fakes in acp.test.ts scale that
      // down so a scripted transient failure does not cost the suite its
      // backoff.  The `turn.retrying` event still reports the REAL delay.
      const retryScale = Number(process.env.FAKE_ACP_RETRY_SCALE ?? "1");

      const emit = (event: RuntimeEvent) => {
        for (const l of [...listeners]) l(event);
      };
      const cliVersion = (effective: AcpConfig, env: Record<string, string | undefined>) =>
        new Promise<string | null>((resolve) => {
          execCli(effective.cli, ["--version"], { timeout: 8000, env: cliProbeEnvironment(env) }, (err, stdout) =>
            resolve(err ? null : stdout.trim()),
          );
        });
      const base = (threadId: string, turnId: string) => ({
        eventId: newEventId(),
        provider: DRIVER_KIND,
        threadId,
        turnId,
        createdAt: new Date().toISOString(),
      });

      const sendTurn = async (turn: SendTurnInput) => {
        const { threadId } = turn;
        if (disposed) throw new Error("provider instance is disposed");
        // Host control means the user's real desktop (the Local VM and a VPS
        // also arrive as `localComputer`, but they are isolated and carry no
        // scope). A full-auto instance keeps its yolo switch for everything
        // else, but a turn that can click on this computer runs brokered:
        // the CLI is spawned in its asking mode and every ask reaches the
        // harness, where the bot's Auto policy, the destructive and sensitive
        // guards, and the unattended block decide. That is what lets a
        // full-auto bot mount the local computer at all.
        const controlsHost = hostToolPrefix(turnComputerMounts(turn.integrations)) !== null;
        const turnConfig: AcpConfig = controlsHost && config.fullAuto ? { ...config, fullAuto: false } : config;
        if (active.has(threadId)) throw new Error("a turn is already running on this thread");
        const turnId = newId();
        // Carried across a relaunch (see maybeRetry): `attempt` is how many
        // transient failures this logical turn has already absorbed, and
        // `cancelled` is how a user stop during the backoff reaches the
        // pending relaunch instead of letting it spawn a process nobody wants.
        const retry = retryState.get(threadId) ?? { attempt: 0, cancelled: false };
        retry.cancelled = false;
        retryState.set(threadId, retry);
        const retryAbort = new AbortController();
        const cwd = turn.cwd ?? config.workspace ?? homedir();
        const env = childEnv(turnConfig);
        let preflightCancelled = false;
        const preflightAsks = new Map<string, (behavior: string, source?: "user" | "timeout" | "system") => void>();
        const cancelPreflight = () => {
          preflightCancelled = true;
          retry.cancelled = true;
          retryAbort.abort();
        };
        active.set(threadId, {
          stop: cancelPreflight,
          interrupt: cancelPreflight,
          turnId,
          asks: preflightAsks,
        });
        emit({ ...base(threadId, turnId), type: "turn.started" });

        const finishBeforeDispatch = (
          ok: boolean,
          stopReason: string,
          error?: { message: string; setup?: boolean },
        ) => {
          if (active.get(threadId)?.turnId === turnId) active.delete(threadId);
          retryState.delete(threadId);
          if (error) emit({ ...base(threadId, turnId), type: "runtime.error", ...error });
          emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null });
          return { turnId, dispatched: false as const };
        };
        const cancelledBeforeDispatch = () =>
          preflightCancelled || disposed
            ? finishBeforeDispatch(true, "cancelled")
            : null;

        // Snapshot status is advisory and callers can dispatch directly.  A
        // provider that requires a minimum stock CLI must enforce that same
        // contract at the last boundary before spawning a paid turn.
        if (support.versionCompatibilityReason && turnConfig.cli === support.defaultCli) {
          let version: string | null;
          try {
            version = await cliVersion(turnConfig, env);
          } catch (error) {
            if (active.get(threadId)?.turnId === turnId) active.delete(threadId);
            throw error;
          }
          const cancelled = cancelledBeforeDispatch();
          if (cancelled) return cancelled;
          const incompatible = version
            ? support.versionCompatibilityReason(version, turnConfig)
            : `\`${turnConfig.cli}\` CLI not found`;
          if (incompatible) {
            return finishBeforeDispatch(false, "setup_required", { message: incompatible, setup: true });
          }
        }
        if (support.requireAuthenticationBeforeSpawn && !skipSubscriptionAuthForLocalInject(turn.model)) {
          let authenticated: boolean;
          try {
            authenticated = await support.isAuthenticated(env, turnConfig);
          } catch (error) {
            if (active.get(threadId)?.turnId === turnId) active.delete(threadId);
            throw error;
          }
          const cancelled = cancelledBeforeDispatch();
          if (cancelled) return cancelled;
          if (!authenticated) {
            return finishBeforeDispatch(false, "auth_required", { message: support.loginNote, setup: true });
          }
        }
        const cancelled = cancelledBeforeDispatch();
        if (cancelled) return cancelled;
        let resolvedModel: string | undefined;
        try {
          resolvedModel = support.resolveTurnModel?.(turn.model, env);
          support.applyTurnEnv?.(env, { model: resolvedModel, requestedModel: turn.model });
        } catch (error) {
          return finishBeforeDispatch(false, "setup_error", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
        const cliTurn =
          resolvedModel !== undefined && resolvedModel !== turn.model
            ? { ...turn, model: resolvedModel }
            : turn;
        const mcpServers = acpMcpServers(turn);

        let child;
        try {
          const requestedArgs = support.spawnArgs(turnConfig, cliTurn);
          const spawned = support.wrapSpawn?.(config.cli, requestedArgs, cliTurn) ?? {
            cli: config.cli,
            args: requestedArgs,
          };
          child = spawnCli(spawned.cli, spawned.args, {
            cwd,
            env: spawned.env ? { ...env, ...spawned.env } : env,
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch (error) {
          const failure = describeSpawnFailure(error instanceof Error ? error : new Error(String(error)), config.cli);
          return finishBeforeDispatch(false, "spawn_error", {
            message: failure.message,
            ...(failure.setup ? { setup: true } : {}),
          });
        }

        // `sawOutput` is the replay-safety gate, and it is PROTOCOL state, not
        // a reading of the error text: it flips the moment this child put
        // something on the bus that a relaunch would duplicate or contradict —
        // an assistant or reasoning delta, a tool call, or a permission card.
        // A transient failure before any of that is a failure to start, and
        // starting over is free.  After it, the CLI may already have edited a
        // file or run a command, and only the CLI's own resume can be trusted
        // to continue safely — so the turn fails honestly instead.
        // `retrying` means a relaunch is already scheduled; every settle path
        // checks it so the dying child cannot also terminate the turn.
        const state = {
          settled: false,
          deadlineTerminating: false,
          promptSent: false,
          sawOutput: false,
          retrying: false,
          text: "",
        };
        const asks = new Map<string, (behavior: string, source?: "user" | "timeout" | "system") => void>();
        let nextId = 1;
        let sessionId: string | null = null;
        let interruptTimer: ReturnType<typeof setTimeout> | null = null;
        const rpcPending = new Map<
          number,
          {
            resolve: (v: any) => void;
            reject: (e: Error) => void;
            timer: ReturnType<typeof setTimeout> | null;
            /** No-op unless this request armed an idle deadline (only
             *  session/prompt does). Re-arming after every inbound line
             *  (and after we answer a permission ask) is what makes the
             *  guard trip on total silence only. */
            armIdle: () => void;
            clearIdle: () => void;
          }
        >();

        const send = (obj: unknown) => {
          // A reply to a server->client request (permission, most likely)
          // resumes an agent that was waiting on US — give it a fresh idle
          // window from the moment it can act again, rather than whatever
          // was left over from before the ask (which could be ~0).
          const message = obj as { id?: unknown; result?: unknown; error?: unknown };
          if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
            for (const pending of rpcPending.values()) pending.armIdle();
          }
          try {
            child.stdin.write(JSON.stringify(obj) + "\n");
          } catch {}
          appendNative(threadId, { dir: "out", source: SOURCE, msg: obj });
        };
        const sendAndFlush = (obj: unknown) =>
          new Promise<void>((resolve) => {
            try {
              child.stdin.write(JSON.stringify(obj) + "\n", () => resolve());
            } catch {
              resolve();
            }
            appendNative(threadId, { dir: "out", source: SOURCE, msg: obj });
          });
        const request = (method: string, params: unknown, timeoutMs?: number, idleMs?: number) =>
          new Promise<any>((resolve, reject) => {
            const id = nextId++;
            // Idle watchdog — unlike `timer` below, this restarts on every
            // inbound line (see the stdout handler), so a long-lived
            // streaming turn is never cut off; only one that has gone
            // completely silent trips it.  Only armed when the caller
            // passes idleMs (currently just session/prompt).
            let idleTimer: ReturnType<typeof setTimeout> | null = null;
            const clearIdle = () => {
              if (idleTimer) clearTimeout(idleTimer);
              idleTimer = null;
            };
            const armIdle = () => {
              if (!(idleMs && idleMs > 0)) return;
              clearIdle();
              idleTimer = setTimeout(() => {
                // A permission ask blocks on a PERSON, not the agent —
                // waiting on one is not the silence this guard exists to
                // catch, so keep re-checking instead of tripping.
                if (asks.size) {
                  armIdle();
                  return;
                }
                rpcPending.delete(id);
                if (timer) clearTimeout(timer);
                reject(new AcpPromptIdleError(method, idleMs));
              }, idleMs);
              idleTimer.unref?.();
            };
            let timer: ReturnType<typeof setTimeout> | null = null;
            if (timeoutMs) {
              timer = setTimeout(() => {
                rpcPending.delete(id);
                clearIdle();
                reject(new AcpRpcTimeoutError(method));
              }, timeoutMs);
              timer.unref?.();
            }
            armIdle();
            rpcPending.set(id, { resolve, reject, timer, armIdle, clearIdle });
            send({ jsonrpc: "2.0", id, method, params });
          });

        const stop = () => killCliTree(child);
        const stopAndWaitForExit = async () => {
          state.deadlineTerminating = true;
          const pid = child.pid;
          const forceExit = () => {
            try {
              if (process.platform !== "win32" && pid) process.kill(-pid, "SIGKILL");
              else child.kill("SIGKILL");
            } catch {
              // already gone
            }
          };
          if (child.exitCode !== null || child.signalCode !== null) {
            forceExit();
            return;
          }
          await new Promise<void>((resolve) => {
            child.once("exit", resolve);
            stop();
            // Keep the process-group kill armed after the CLI leader exits:
            // an MCP descendant can ignore SIGTERM and outlive its parent.
            const forceTimer = setTimeout(forceExit, FORCE_EXIT_AFTER_MS);
            forceTimer.unref?.();
          });
        };

        /** Emit buffered assistant text as its own item, then clear it. */
        const flushAssistantText = () => {
          const text = state.text;
          state.text = "";
          if (!text.trim()) return;
          emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
        };

        /** THIS turn's token total, if the prompt result reported one.
         *
         * ACP runs one `session/prompt` per turn, so the figure the result
         * carries IS the turn's figure — which is exactly what
         * `turn.completed.usage` is defined to be.  Emitting it only as
         * `thread.token-usage.updated` left every ACP engine — nine of the
         * seventeen — invisible to cost bookkeeping and usage caps, because
         * the contract says that live indicator must never be summed.
         * `output` is optional: DSH's ACP server (`@deepseek-ai/dsh-acp`)
         * never puts usage on the `session/prompt` result at all — its only
         * signal is a `session/update` `usage_update` notification carrying
         * a combined context-occupancy figure (see the `usage_update` case
         * in `handleNotification` below), with no input/output split. */
        let turnUsage: { input: number; output?: number } | undefined;

        const settle = (ok: boolean, stopReason: string | null) => {
          if (state.settled || state.retrying) return;
          state.settled = true;
          retryState.delete(threadId);
          if (interruptTimer) clearTimeout(interruptTimer);
          for (const finish of [...asks.values()]) finish("cancel", "system");
          for (const p of rpcPending.values()) {
            if (p.timer) clearTimeout(p.timer);
            p.clearIdle();
            p.reject(new Error("turn settled"));
          }
          rpcPending.clear();
          active.delete(threadId);
          flushAssistantText();
          emit({
            ...base(threadId, turnId),
            type: "turn.completed",
            ok,
            stopReason,
            cost: null,
            ...(turnUsage ? { usage: turnUsage } : {}),
          });
          stop(); // the agent process does not exit on its own
        };

        /** Absorb a transient provider or transport failure by relaunching
         *  this turn, or report `false` and let the caller settle it.
         *
         *  Every ACP engine — Cursor, Droid, Grok CLI, Hermes, Kimi,
         *  DeepSeek, Qwen, OpenCode, DSH — used to fail the whole turn on a
         *  single 429 or connection reset, which then pushed the bot's
         *  fallback chain into a cooldown that one retry would have avoided.
         *  The conditions are exactly claude.ts's, and for the same reasons:
         *  the failure must be transient by the shared classifier, the user
         *  must not have stopped the turn, the budget must not be spent, and
         *  — the replay-safety one — this child must not have produced any
         *  output yet.  Nothing that already reached the person or the disk
         *  is ever re-run here. */
        const maybeRetry = (failure: Parameters<typeof classifyError>[0]): boolean => {
          if (state.settled || state.retrying || state.deadlineTerminating) return false;
          if (retry.cancelled || preflightCancelled || disposed) return false;
          if (state.sawOutput) return false;
          if (retry.attempt >= RETRY_MAX_ATTEMPTS - 1) return false;
          const verdict = classifyError(failure);
          if (!verdict.transient) return false;

          state.retrying = true;
          retry.attempt++;
          const delayMs = computeBackoff(retry.attempt - 1);
          emit({
            ...base(threadId, turnId),
            type: "turn.retrying",
            attempt: retry.attempt,
            delayMs,
            reason: verdict.reason,
          });
          // Retire the failed attempt: no card, no pending RPC, and no child
          // may outlive it into the relaunch.
          if (interruptTimer) clearTimeout(interruptTimer);
          for (const finish of [...asks.values()]) finish("cancel", "system");
          asks.clear();
          for (const p of rpcPending.values()) {
            if (p.timer) clearTimeout(p.timer);
            p.clearIdle();
            p.reject(new Error("turn retrying"));
          }
          rpcPending.clear();
          stop();
          // The thread STAYS claimed through the backoff — that entry is what
          // makes a stop during the wait reach this turn instead of racing a
          // relaunch nobody can see yet.
          const cancelRetry = () => {
            retry.cancelled = true;
            retryAbort.abort();
          };
          active.set(threadId, { stop: cancelRetry, interrupt: cancelRetry, turnId, asks: new Map() });
          void (async () => {
            const wait = interruptibleDelay(delayMs * retryScale, retryAbort.signal);
            await wait.promise;
            active.delete(threadId);
            if (retry.cancelled || disposed) {
              retryState.delete(threadId);
              emit({
                ...base(threadId, turnId),
                type: "turn.completed",
                ok: false,
                stopReason: retry.cancelled ? "interrupted" : "disposed",
                cost: null,
              });
              return;
            }
            try {
              // The SAME turn, cursor included: a turn that never got a
              // prompt result has nothing to resume past, and re-loading the
              // cursor it arrived with is what keeps the relaunch on the
              // thread's real history rather than a session this attempt
              // happened to create and abandon.
              await sendTurn(turn);
            } catch (error) {
              retryState.delete(threadId);
              emit({
                ...base(threadId, turnId),
                type: "runtime.error",
                message: error instanceof Error ? error.message : String(error),
              });
              emit({
                ...base(threadId, turnId),
                type: "turn.completed",
                ok: false,
                stopReason: "exit_before_result",
                cost: null,
              });
            }
          })();
          return true;
        };

        // server→client permission request → canonical request.opened
        const handleServerRequest = (msg: any) => {
          if (msg.method !== "session/request_permission") {
            // never leave an unknown server request hanging — the agent blocks
            return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
          }
          const params = msg.params ?? {};
          // A card in front of a person, or a full-auto approval about to let
          // a tool run, is a side effect this turn can no longer take back.
          state.sawOutput = true;
          flushAssistantText();
          const options: Array<{ optionId?: string; kind?: string }> = Array.isArray(params.options) ? params.options : [];
          const optionFor = (want: "allow" | "reject") =>
            options.find((o) => String(o.kind ?? "").startsWith(want) && typeof o.optionId === "string")?.optionId ?? null;
          const cancelled = { outcome: { outcome: "cancelled" } };
          const missing = (want: string) =>
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: `${DRIVER_KIND} offered no "${want}" permission option — cancelling the request instead of guessing`,
            });

          const toolCall = params.toolCall ?? {};
          if (turnConfig.fullAuto) {
            const allow = optionFor("allow");
            if (!allow) missing("allow");
            return send({
              jsonrpc: "2.0",
              id: msg.id,
              result: allow ? { outcome: { outcome: "selected", optionId: allow } } : cancelled,
            });
          }
          const kind = String(toolCall.kind ?? "");
          const tool = kind === "execute" ? "shell" : kind === "edit" ? "edit" : kind || "tool";
          const summary = String(toolCall.rawInput?.command ?? toolCall.title ?? tool).slice(0, 200);
          const requestId = newId();
          const finish = (behavior: string, source: "user" | "timeout" | "system" = "user") => {
            if (!asks.delete(requestId)) return;
            clearTimeout(timer);
            const want = behavior === "allow" ? "allow" : "reject";
            const optionId = behavior === "cancel" ? null : optionFor(want);
            if (behavior !== "cancel" && !optionId) missing(want);
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: optionId ? { outcome: { outcome: "selected", optionId } } : cancelled,
            });
            emit({
              ...base(threadId, turnId),
              type: "request.resolved",
              requestId,
              behavior: optionId && behavior === "allow" ? "allow" : "deny",
              source: optionId ? source : "system",
              approvalScope: controlsHost ? "local-computer" : undefined,
            });
          };
          const timer = setTimeout(() => {
            finish("deny", "timeout");
          }, 15 * 60_000);
          timer.unref?.();
          asks.set(requestId, finish);
          emit({
            ...base(threadId, turnId),
            type: "request.opened",
            requestId,
            requestType: "permission",
            tool,
            summary,
            approvalScope: controlsHost ? "local-computer" : undefined,
          });
        };

        const handleNotification = (msg: any) => {
          // Vendor side-channels (e.g. grok's `_x.ai/*`) are teed to the
          // native log but never normalized: the prompt result is the settle.
          if (msg.method !== "session/update") return;
          const p = msg.params ?? {};
          if (!state.promptSent || p._meta?.isReplay === true) return;
          const u = p.update ?? {};
          switch (u.sessionUpdate) {
            case "agent_message_chunk": {
              const delta = u.content?.text;
              if (typeof delta === "string" && delta) {
                state.text += delta;
                // past this point a relaunch would repeat words the person
                // already read — see maybeRetry
                state.sawOutput = true;
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
              }
              break;
            }
            case "agent_thought_chunk": {
              const delta = u.content?.text;
              if (typeof delta === "string" && delta) {
                state.sawOutput = true;
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta });
              }
              break;
            }
            case "tool_call": {
              state.sawOutput = true;
              flushAssistantText();
              // ACP hands us `kind`, `locations` and `rawInput` alongside the
              // title.  Folding all of it into one 80-char title was what left
              // the transcript showing `read_file` seven times with no paths;
              // the name and the thing it acted on are separate columns now.
              emit({
                ...base(threadId, turnId),
                type: "item.started",
                itemType: "tool",
                itemId: u.toolCallId,
                title: String(u.title ?? u.rawInput?.command ?? "tool").slice(0, 80),
                ...toolFields(u.title ?? u.rawInput?.command, u.rawInput, {
                  hint: u.kind,
                  locations: u.locations,
                  cwd: turn.cwd,
                }),
              });
              break;
            }
            case "tool_call_update": {
              if (u.status === "completed" || u.status === "failed") {
                emit({
                  ...base(threadId, turnId),
                  type: "item.completed",
                  itemType: "tool",
                  itemId: u.toolCallId,
                  ok: u.status !== "failed",
                  detail: describeResult(u.content ?? u.rawOutput),
                });
              }
              break;
            }
            // DSH's ACP server (`@deepseek-ai/dsh-acp`) never reports usage on
            // the `session/prompt` result — `handle_prompt`'s only reply is
            // `{ stopReason }`. Its one usage signal is this notification:
            // `used` is the session's running context-token count
            // (`tokenMeter.measure(session).totalTokens`, i.e. how much of
            // the context window the conversation now occupies), not a
            // per-turn delta and not a real input/output split — the
            // model's actual per-call usage (`event.data.usage`) is computed
            // internally but never crosses the wire. `used` is still the
            // closest honest reading of "tokens this turn's request carried"
            // available (the context sent grows by the same amount the
            // transcript grows), so it becomes `gen_ai.usage.input_tokens`;
            // there is no reported output figure, so that attribute stays
            // unset instead of a fabricated 0 — see the `output?:` comment
            // on `turnUsage` above.
            case "usage_update": {
              const used = u.used;
              if (typeof used === "number" && Number.isFinite(used)) {
                // Spread, not a literal `output: turnUsage?.output` — that
                // would always create the key (value undefined when
                // unknown), and turn.completed's `usage` below is emitted
                // by spreading this same object, so an explicit
                // `output: undefined` key would survive onto the wire
                // event instead of being omitted.
                turnUsage = {
                  input: Math.max(0, Math.trunc(used)),
                  ...(turnUsage?.output != null ? { output: turnUsage.output } : {}),
                };
                emit({
                  ...base(threadId, turnId),
                  type: "thread.token-usage.updated",
                  input: turnUsage.input,
                  ...(turnUsage.output != null ? { output: turnUsage.output } : {}),
                });
              }
              break;
            }
          }
        };

        let buf = "";
        // decode as UTF-8 across chunk boundaries — a raw `buf += chunk` splits
        // multibyte characters that straddle two reads and corrupts the text
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            let msg: any;
            try {
              msg = JSON.parse(line);
            } catch {
              continue;
            }
            // A resumed session replays its whole history as session/update
            // before the prompt goes out; handleNotification drops those, so
            // teeing them only re-wrote the same transcript on every turn.
            if (msg.method !== "session/update" || (state.promptSent && msg.params?._meta?.isReplay !== true)) {
              appendNative(threadId, { dir: "in", source: SOURCE, msg });
            }
            // Inbound traffic proves the child is alive and making progress
            // — a message chunk, a thought chunk, a tool call or result, a
            // permission request, this response itself, anything — so every
            // idle deadline restarts here; only total silence trips one.
            for (const pend of rpcPending.values()) pend.armIdle();
            if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
              const pend = rpcPending.get(msg.id);
              if (pend) {
                rpcPending.delete(msg.id);
                if (pend.timer) clearTimeout(pend.timer);
                pend.clearIdle();
                if (msg.error) {
                  const error = new Error(msg.error.message ?? JSON.stringify(msg.error));
                  Object.assign(error, { code: msg.error.code, data: msg.error.data });
                  pend.reject(error);
                } else {
                  pend.resolve(msg.result);
                }
              }
            } else if (msg.id !== undefined && msg.method) {
              handleServerRequest(msg);
            } else if (msg.method) {
              handleNotification(msg);
            }
          }
        });

        let stderr = "";
        child.stderr.on("data", (c) => {
          stderr += c;
          if (stderr.length > 8192) stderr = stderr.slice(-8192);
        });
        child.on("error", (e) => {
          emit({ ...base(threadId, turnId), type: "runtime.error", ...describeSpawnFailure(e, config.cli) });
          settle(false, "spawn_error");
        });
        child.on("close", (code) => {
          if (!state.settled && !state.deadlineTerminating && !state.retrying) {
            const message = `${DRIVER_KIND} exited ${code} before the prompt result${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`;
            // A CLI that died on a provider hiccup before saying anything is
            // worth one more launch; a CLI that died for its own reasons is
            // not, and classifyError treats a bare nonzero exit as terminal.
            if (maybeRetry({ exitCode: code, stderr: message })) return;
            emit({ ...base(threadId, turnId), type: "runtime.error", message });
            settle(false, "exit_before_result");
          }
        });

        const interrupt = () => {
          if (sessionId) send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
          else stop();
          if (interruptTimer) clearTimeout(interruptTimer);
          interruptTimer = setTimeout(() => settle(true, "cancelled"), 5_000);
          interruptTimer.unref?.();
        };
        // Wrapped, not bare: a person who stops this turn has stopped the
        // WHOLE turn, and the child's close event must not read as a transient
        // failure worth relaunching.  `stop` and `interrupt` themselves stay
        // unwrapped for the driver's own internal use (settle, deadlines).
        const cancelAndStop = () => {
          retry.cancelled = true;
          retryAbort.abort();
          stop();
        };
        const cancelAndInterrupt = () => {
          retry.cancelled = true;
          retryAbort.abort();
          interrupt();
        };
        active.set(threadId, { stop: cancelAndStop, interrupt: cancelAndInterrupt, turnId, asks });

        // Read the host load once per spawn: the deadline this boot gets is
        // fixed when it starts, not re-judged while it runs.
        const initDeadline = resolveInitDeadline({
          configured: turnConfig.initTimeoutMs,
          engineBaseMs: support.initTimeoutMs,
          load: readHostLoad(),
        });

        (async () => {
          try {
            const initStartedAt = Date.now();
            let init: any;
            try {
              init = await request(
                "initialize",
                { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
                initDeadline.timeoutMs,
              );
            } catch (error) {
              // Name the budget in the failure so a log line says whether
              // the deadline or the boot was the outlier.
              throw error instanceof AcpRpcTimeoutError
                ? new AcpRpcTimeoutError("initialize", describeInitDeadline(initDeadline))
                : error;
            }
            const initElapsedMs = Date.now() - initStartedAt;
            if (initElapsedMs >= SLOW_INIT_LOG_MS) {
              console.warn(`[acp] ${DRIVER_KIND} ${describeSlowInit(initElapsedMs, initDeadline)}`);
            }
            const methods: Array<{ id?: string }> = Array.isArray(init?.authMethods) ? init.authMethods : [];
            const methodId = support.pickAuthMethod(methods);
            if (!skipSubscriptionAuthForLocalInject(turn.model)) {
              // Only fail-closed drivers (authFailure: "fail", currently just
              // Grok) need the ambient-login probe at all — a fail-open driver
              // like Cursor can never have its outcome changed by it, so
              // skip the extra `isAuthenticated` process spawn(s) entirely.
              if (methodId) {
                try {
                  await request("authenticate", { methodId }, INIT_TIMEOUT);
                } catch {
                  // Signed-in subscription CLIs (grok.com OIDC on disk) still
                  // run off ambient login when authenticate rejects.  BOTFLEET-C
                  // paged high for "not signed in" while auth.json was valid.
                  if (support.authFailure === "fail" && !(await support.isAuthenticated(env, turnConfig))) {
                    throw new Error(support.loginNote);
                  }
                }
              } else if (support.authFailure === "fail" && !(await support.isAuthenticated(env, turnConfig))) {
                throw new Error(support.loginNote);
              }
            }

            const cursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
            let sessionResult: any = null;
            if (cursor) {
              try {
                sessionResult = await request(
                  support.resumeMethod ?? "session/load",
                  { sessionId: cursor, cwd, mcpServers },
                  LOAD_SESSION_TIMEOUT,
                );
                sessionId = cursor;
              } catch (error) {
                // The harness withheld inline replay because this cursor said
                // the native session held the conversation.  Starting empty
                // here would silently discard everything before this prompt.
                throw new AcpResumeError({ cause: error });
              }
            }
            if (!sessionId) {
              sessionResult = await request("session/new", { cwd, mcpServers }, NEW_SESSION_TIMEOUT);
              sessionId = typeof sessionResult?.sessionId === "string" ? sessionResult.sessionId : null;
              if (!sessionId) throw new Error("session/new returned no sessionId");
            }
            let selectedModel: string | null = null;
            let sessionStarted = false;
            const emitSessionStarted = () => {
              if (sessionStarted) return;
              sessionStarted = true;
              emit({
                ...base(threadId, turnId),
                type: "session.started",
                sessionId,
                model: selectedModel ?? init?._meta?.modelState?.currentModelId ?? cliTurn.model ?? null,
              });
            };

            try {
              if (support.selectModel) {
                const { configId, valueForModel, modelForValue } = support.selectModel;
                // The value a reply reports for this option, or `undefined` when
                // it reports nothing.  "Not reported" must stay distinct from
                // "reported as some other value": a stock `dsh` ACKs
                // session/set_config_option with a bare `{}`, and reading that
                // as a failed switch raised BOTFLEET-M on every dsh turn.
                const reportedValue = (r: any) =>
                  (Array.isArray(r?.configOptions) ? r.configOptions : []).find(
                    (o: any) => o?.id === configId,
                  )?.currentValue;
                let selectedValue = reportedValue(sessionResult);
                const requestedValue = cliTurn.model
                  ? (valueForModel?.(cliTurn.model) ?? cliTurn.model)
                  : null;
                if (requestedValue && requestedValue !== selectedValue) {
                  const applied = reportedValue(
                    await request(
                      "session/set_config_option",
                      { sessionId, configId, value: requestedValue },
                      INIT_TIMEOUT,
                    ),
                  );
                  // an agent that answers OK but keeps its old model is worse than
                  // one that errors: it burns a paid turn on the wrong thing.  Only
                  // a *reported* mismatch proves that, though — a bare ACK that
                  // reports no state cannot be held to a comparison it never made.
                  if (applied !== undefined && applied !== requestedValue) {
                    throw new Error(
                      `${DRIVER_KIND} did not switch to ${cliTurn.model} (still ${applied ?? "unknown"})`,
                    );
                  }
                  selectedValue = applied ?? requestedValue;
                }
                // Opaque option values are protocol details.  Persist the
                // picker id in the task so resume and usage attribution keep
                // the same model identity the user selected.
                selectedModel = cliTurn.model ?? modelForValue?.(selectedValue) ?? (
                  valueForModel === undefined && typeof selectedValue === "string" ? selectedValue : null
                );
              }

              if (support.configureSession) {
                await support.configureSession({
                  request: (method, params, timeoutMs) =>
                    request(method, params, timeoutMs ?? SESSION_CONFIG_TIMEOUT),
                  sessionId,
                  config: turnConfig,
                  turn: cliTurn,
                  sessionModels: Array.isArray(sessionResult?.models?.availableModels)
                    ? sessionResult.models.availableModels
                    : [],
                });
                // initialize's currentModelId is the CLI default (grok-4.7),
                // not the model this turn asked for. After a successful pin,
                // report the slug we set so the UI does not claim otherwise.
                if (!selectedModel && cliTurn.model) selectedModel = cliTurn.model;
              }
            } catch (error) {
              // session.started is the only place the resume cursor is recorded,
              // so a rejected setting must not orphan a session we just created.
              emitSessionStarted();
              throw error;
            }
            emitSessionStarted();
            state.promptSent = true;
            const text = support.buildPromptText
              ? support.buildPromptText(turn)
              : turn.system
                ? `${turn.system}\n\n${turn.text}`
                : turn.text;
            const result = await request(
              "session/prompt",
              {
                sessionId,
                prompt: [{ type: "text", text }],
              },
              turnConfig.promptTimeoutMs ?? DEFAULT_PROMPT_MAX_MS,
              turnConfig.promptIdleMs ?? DEFAULT_PROMPT_IDLE_MS,
            );
            // opencode 1.18.18 reports usage at the result root; grok and
            // gemini put it under _meta. Read both rather than lose the count.
            const usage = result?.usage ?? result?._meta ?? {};
            if (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number") {
              turnUsage = { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 };
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                ...turnUsage,
              });
            }
            const reason = normalizeStopReason(result?.stopReason);
            if (reason === "end_turn" || reason === "max_tokens") settle(true, null);
            else if (reason === "cancelled") settle(true, "cancelled");
            else settle(false, reason ?? "failed");
          } catch (e) {
            if (!state.settled && !state.retrying) {
              const resumeFailure = e instanceof AcpResumeError;
              const classifiedFailure = resumeFailure && e.cause !== undefined ? e.cause : e;
              const classifiedMessage = classifiedFailure instanceof Error
                ? classifiedFailure.message
                : String(classifiedFailure);
              const code = support.classifyError?.(classifiedFailure);
              const promptTimedOut = e instanceof AcpRpcTimeoutError && e.method === "session/prompt";
              const initTimedOut = e instanceof AcpRpcTimeoutError && e.method === "initialize";
              // Same shape as a hard timeout — an unresponsive child on the
              // other end of a wedged RPC — just detected by total silence
              // instead of elapsed wall clock, so the cleanup is identical.
              const promptWentIdle = e instanceof AcpPromptIdleError && e.method === "session/prompt";
              if ((promptTimedOut || promptWentIdle) && sessionId) {
                state.deadlineTerminating = true;
                // ACP cancellation is a notification.  Flush it to the child
                // and give its event loop one bounded chance to handle it
                // before terminal settlement kills the unresponsive process.
                const cancelFlush = sendAndFlush({
                  jsonrpc: "2.0",
                  method: "session/cancel",
                  params: { sessionId },
                });
                // Windows has no process group signal.  Queue cancellation,
                // then start taskkill while the leader can still identify its
                // descendant tree; POSIX keeps the short graceful interval.
                const windowsExit = process.platform === "win32" ? stopAndWaitForExit() : undefined;
                await Promise.race([
                  cancelFlush,
                  new Promise<void>((resolve) => setTimeout(resolve, CANCEL_FLUSH_GRACE_MS)),
                ]);
                await (windowsExit ?? stopAndWaitForExit());
              }
              // Authentication setup is a user action, not a retry. The
              // classifier is preferred; loginNote remains a compatibility
              // fallback for existing ACP supports.
              const needsAuth = code === "invalid_credentials" || code === "inactive_subscription"
                || classifiedMessage === support.loginNote;
              const baseMessage = e instanceof Error ? e.message : String(e);
              const message = resumeFailure && needsAuth && classifiedMessage !== baseMessage
                ? `${baseMessage}  ${classifiedMessage}`
                : baseMessage;
              // A 429 or a reset during initialize / session setup / prompt is
              // a failure to start, and `sawOutput` inside maybeRetry is what
              // proves nothing has happened yet.  An auth problem is the
              // person's to fix and is never retried; a prompt timeout or an
              // idle stall already set `deadlineTerminating`, which
              // maybeRetry refuses — a wedged child must not be relaunched
              // into the same hang.
              //
              // An initialize deadline earns ONE relaunch, not the whole
              // transient budget: the relaunch repeats the entire cold boot
              // under the same host load, and a second one mostly adds load.
              const initRelaunchSpent = initTimedOut && retry.attempt >= MAX_INIT_TIMEOUT_RELAUNCHES;
              if (
                !needsAuth &&
                !initRelaunchSpent &&
                maybeRetry(classifiedFailure instanceof Error ? classifiedFailure : { text: classifiedMessage })
              ) {
                return;
              }
              emit({
                ...base(threadId, turnId),
                type: "runtime.error",
                message,
                ...(needsAuth ? { setup: true } : {}),
              });
              settle(
                false,
                needsAuth
                  ? "auth_required"
                  : e instanceof AcpResumeError
                    ? "resume_failed"
                    : promptTimedOut
                      ? "prompt_timeout"
                      : promptWentIdle
                        ? "prompt_stall"
                        : "rpc_error",
              );
            }
          }
        })();

        return { turnId };
      };

      const snapshot = async (): Promise<ProviderSnapshot> => {
        const env = childEnv();
        const version = await cliVersion(config, env);
        if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
        const incompatible = support.versionCompatibilityReason?.(version, config);
        if (incompatible) return { state: "unavailable", reason: incompatible, version };
        return { state: "available", version, authenticated: await support.isAuthenticated(env, config) };
      };

      const mountsMcpServers = support.mcpServers !== false;

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        displayName: input.displayName,
        enabled: input.enabled,
        get models() {
          return models;
        },
        refreshModels: support.resolveModels ? refreshModels : undefined,
        snapshot,
        adapter: {
          provider: DRIVER_KIND,
          capabilities: {
            sessionModelSwitch: "unsupported",
            // every MCP flag rides on one question — does this harness mount
            // what session/new hands it? — so they answer together
            agentsMcp: mountsMcpServers,
            computerMcp: mountsMcpServers,
            composioMcp: mountsMcpServers,
            phoneMcp: mountsMcpServers,
            qdrantMcp: mountsMcpServers,
            images: support.images !== false,
            effortLevels: support.effortLevels,
            localComputerMcp: mountsMcpServers,
          },
          sendTurn,
          interruptTurn: async (threadId) => active.get(threadId)?.interrupt(),
          respondToRequest: async (threadId, requestId, decision) => {
            const turn = active.get(threadId);
            const finish = turn?.asks.get(requestId);
            if (!finish) return "unavailable"; // settled, timed out, or turn gone
            finish(decision.behavior === "allow" ? "allow" : "deny", "user");
            return decision.behavior === "allow" ? "allowed-once" : "rejected";
          },
          hasSession: (threadId) => active.has(threadId),
          stopAll: async () => {
            for (const { stop } of active.values()) stop();
          },
          onEvent: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        dispose: async () => {
          disposed = true;
          for (const { stop } of active.values()) stop();
          listeners.clear();
        },
      };
    },
  };
}
