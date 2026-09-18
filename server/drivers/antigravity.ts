// Antigravity driver — Google's `agy` CLI in headless one-shot print mode
// (`agy --print --output-format stream-json`), modeled on claude.ts but fully
// self-contained. Per-turn CLI process; the conversation continues across
// turns via `--conversation <id>` (the resumeCursor is agy's conversation_id).
// Verified against agy 1.1.12.
//
// Unlike claude, print mode has NO interactive permission hook: there is no
// per-action broker here. `--mode accept-edits` allows file edits but
// auto-denies shell (`run_command` comes back as a tool ERROR); the default
// `request-review` auto-denies; `--dangerously-skip-permissions` (fullAuto)
// approves everything. Real per-action approval cards are a future path via
// native ACP (agy issue #31), which would reuse acp/core.ts like grok/gemini.
//
// So a turn that holds host control — the person's own desktop — is spawned
// WITHOUT the bypass however the instance is configured, and says so in the
// thread before it starts: a shell command on that computer is refused, not
// run unseen.  That is the half of acp/core.ts's controlsHost guard this
// engine can honour; the other half, the approval card, needs an ask agy
// print mode never opens.
//
// fullAuto is OFF unless the person turns it on in Settings › Engines.  The
// bypass skips BotFleet's permission broker entirely — no card, no
// destructive/sensitive guard, no decision-log row — so it is an opt-in the
// Engines row spells out, never a default a fresh bot inherits.
//
// Computer use: agy has no per-turn MCP flag, so the bot's computer (cloud
// box / Local VM / VPS / local computer) is mounted by upserting keys into the
// global `~/.gemini/config/mcp_config.json` before each spawn — see
// ensureAntigravityMcp below.
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../procs.ts";
import { stderrExcerpt } from "../stderr-excerpt.ts";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

import { hostToolPrefix, turnComputerMounts } from "../computer-grants.ts";
import { DATA_DIR, stripWorkspaceCredentialEnv } from "../config.ts";
import { computerProxyEnv } from "../container-computer.ts";
import { augmentedPath } from "../env-path.ts";
import { toolFields } from "../tool-fields.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { injectedApiModel, mergeLocalInject } from "./local-inject.ts";

import type { ChildProcess } from "node:child_process";
import type {
  DriverCreateInput,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { appendNative } from "./native.ts";

const DRIVER_KIND = "antigravityAgent";

export interface AntigravityConfig {
  cli: string;
  fullAuto: boolean;
}

/** Said once, at the start of any turn that can act on the person's own
 * desktop.  agy has no interactive permission hook in print mode, so the
 * asking mode we drop it into auto-DENIES a shell ask rather than putting a
 * card in front of anyone.  A person who mounted this Mac expects to be asked;
 * telling them up front that they will not be is the honest version of a
 * capability this engine only half has. */
export const ANTIGRAVITY_HOST_CONTROL_NOTICE =
  "Antigravity cannot ask for approval, so shell commands on this computer are refused during this turn.";

export { STATIC_ANTIGRAVITY_MODELS } from "../antigravity-models.ts";
import { STATIC_ANTIGRAVITY_MODELS } from "../antigravity-models.ts";

function antigravityEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath(), ...overrides };
  // The harness process may hold workspace credentials injected by the
  // desktop shell. Antigravity uses its own login, so none belong in any of
  // its turn, snapshot, or helper children.
  stripWorkspaceCredentialEnv(env);
  return env;
}

const AGY_MODEL_ID = /^[a-z0-9][a-z0-9._:/-]*$/i;

function extrasFromUnknown(value: unknown): Array<{ id: string; label: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return AGY_MODEL_ID.test(item) ? [{ id: item, label: item }] : [];
    if (!item || typeof item !== "object") return [];
    const row = item as { id?: unknown; model?: unknown; name?: unknown; displayName?: unknown };
    const id = typeof row.id === "string" ? row.id : typeof row.model === "string" ? row.model : "";
    if (!AGY_MODEL_ID.test(id)) return [];
    const label = typeof row.name === "string" ? row.name : typeof row.displayName === "string" ? row.displayName : id;
    return [{ id, label }];
  });
}

/** Extra ids from ~/.gemini/antigravity-cli/settings.json, if the user added any. */
export function readAntigravityModelCatalog(env: Record<string, string | undefined> = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(
      readFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return STATIC_ANTIGRAVITY_MODELS;
  }
  const extras = [
    ...extrasFromUnknown(settings.availableModels),
    ...extrasFromUnknown(settings.customModels),
    ...extrasFromUnknown(settings.extraModels),
  ];
  if (typeof settings.model === "string") extras.push(...extrasFromUnknown([settings.model]));
  const options = STATIC_ANTIGRAVITY_MODELS.options.map((option) => ({ ...option }));
  const seen = new Set(options.map((option) => option.id));
  for (const extra of extras) {
    if (seen.has(extra.id)) continue;
    seen.add(extra.id);
    options.push({ id: extra.id, label: extra.label, custom: true });
  }
  return { default: STATIC_ANTIGRAVITY_MODELS.default, options };
}

// ── computer MCP mount ──────────────────────────────────────────────────
// agy has no per-session MCP flag and no project-level MCP config: verified
// against agy 1.1.19, whose embedded docs list exactly two locations — the
// global `~/.gemini/config/mcp_config.json` and per-plugin files — and whose
// `agy mcp list` ignores `.gemini/{settings,mcp_config}.json` in the cwd.
// So the bot's computer is mounted by upserting ONE key into the global file
// right before each spawn: every other byte of the user's config is
// preserved, and a malformed file starts from a fresh object instead of
// failing the turn (the ensureOpenCodeInjectModel discipline).
export const ANTIGRAVITY_COMPUTER_MCP_KEY = "botfleet-computer";

export interface AntigravityComputerMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

// agy's MCP file is machine-global. Hold this lease for the complete child
// lifetime so two Antigravity turns cannot see each other's computer tokens.
let antigravityComputerMcpLease: Promise<void> = Promise.resolve();

async function acquireAntigravityComputerMcpLease(): Promise<() => void> {
  const previous = antigravityComputerMcpLease;
  let unlock: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  antigravityComputerMcpLease = previous.then(() => current);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    unlock?.();
  };
}

// Lenient by design: keep every unknown key the user put in the file. A
// present-but-wrong mcpServers (e.g. an array) fails the parse and is
// rebuilt fresh — that file was already unusable to agy itself.
const mcpConfigFileSchema = z.looseObject({
  mcpServers: z.looseObject({}).optional(),
});

/** The computer MCP server for this turn, or null when the turn has none.
 * Cloud boxes go through BotFleet's REST-to-MCP adapter (the same spec
 * claude.ts and codex.ts build); Local VM and VPS connections arrive as a
 * ready-made Cua Driver stdio command and pass through unchanged. */
export function antigravityMcpServers(
  integrations: SendTurnInput["integrations"],
): Record<string, { command: string; args: string[]; env: Record<string, string> }> {
  const servers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};
  if (!integrations) return servers;

  for (const [name, def] of Object.entries(integrations)) {
    if (!def || typeof def !== "object" || !("command" in def)) {
      if (name === "computer" && def && "kind" in def && def.kind === "box") {
        const proxyEnv = computerProxyEnv(def as any);
        servers[`botfleet-${name}`] = {
          command: process.execPath,
          args: [SPAWNED_PROXIES.computer],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            OGB_BOX_ID: proxyEnv.OGB_BOX_ID ?? "",
            OGB_BOX_TOKEN: proxyEnv.OGB_BOX_TOKEN ?? "",
            OMB_CONTROL_URL: proxyEnv.OMB_CONTROL_URL ?? "",
            OMB_CONTROL_TOKEN: proxyEnv.OMB_CONTROL_TOKEN ?? "",
          },
        };
      }
      continue;
    }
    servers[`botfleet-${name}`] = { command: (def as any).command, args: (def as any).args, env: { ...(def as any).env } };
  }
  return servers;
}

/** Upsert (server) or remove (null) the botfleet-computer entry in the
 * global mcp_config.json. Only that one key is ever written; a turn without
 * a computer removes it so a previous turn's mount cannot leak tools — or
 * box/control tokens — into later turns or the user's own agy sessions. */
export function ensureAntigravityMcp(
  servers: Record<string, { command: string; args: string[]; env: Record<string, string> }>,
  env: Record<string, string | undefined> = process.env,
): () => void {
  const home = env.HOME || env.USERPROFILE || homedir();
  const path = join(home, ".gemini", "config", "mcp_config.json");
  const existed = existsSync(path);
  const original = existed ? readFileSync(path, "utf8") : null;
  let config: any = {};
  try {
    const parsed = mcpConfigFileSchema.safeParse(JSON.parse(original ?? ""));
    if (parsed.success) config = parsed.data;
  } catch {}
  
  const currentServers = { ...config.mcpServers };
  let hasChanges = false;
  
  for (const key of Object.keys(currentServers)) {
    if (key.startsWith("botfleet-")) {
      delete currentServers[key];
      hasChanges = true;
    }
  }
  
  for (const [name, server] of Object.entries(servers)) {
    currentServers[name] = server;
    hasChanges = true;
  }
  
  if (!hasChanges) return () => {};
  
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { chmodSync(directory, 0o700); } catch {}
  
  const newConfig = { ...config, mcpServers: currentServers };
  writeFileSync(path, JSON.stringify(newConfig, null, 2), { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch {}
  
  return () => {
    try {
      if (!existsSync(path)) return;
      const cleanupOriginal = readFileSync(path, "utf8");
      
      // If the file is exactly what we just wrote, we can just restore original
      if (cleanupOriginal === JSON.stringify(newConfig, null, 2)) {
        if (existed && original !== null) {
           writeFileSync(path, original, { mode: 0o600 });
           try { chmodSync(path, 0o600); } catch {}
        } else {
           unlinkSync(path);
        }
        return;
      }
      
      // Otherwise someone edited it concurrently! We must parse and patch!
      let cleanupConfig: any = {};
      try {
        const cleanupParsed = mcpConfigFileSchema.safeParse(JSON.parse(cleanupOriginal));
        if (cleanupParsed.success) cleanupConfig = cleanupParsed.data;
      } catch {}
      
      const cleanupServers = { ...cleanupConfig.mcpServers };
      let changed = false;
      for (const key of Object.keys(cleanupServers)) {
        if (key.startsWith("botfleet-")) {
          delete cleanupServers[key];
          changed = true;
        }
      }
      
      // We must ALSO restore any old botfleet- keys that existed originally!
      if (existed && original !== null) {
         try {
           const origParsed = mcpConfigFileSchema.safeParse(JSON.parse(original));
           if (origParsed.success && origParsed.data.mcpServers) {
             for (const [k, v] of Object.entries(origParsed.data.mcpServers)) {
               if (k.startsWith("botfleet-")) {
                 cleanupServers[k] = v;
                 changed = true;
               }
             }
           }
         } catch {}
      }
      
      if (changed) {
        writeFileSync(path, JSON.stringify({ ...cleanupConfig, mcpServers: cleanupServers }, null, 2), { mode: 0o600 });
        try { chmodSync(path, 0o600); } catch {}
      } else if (!existed && Object.keys(cleanupServers).length === 0 && Object.keys(cleanupConfig).length === 1) {
        // If it was just mcpServers: {} we could unlink, but leaving it is fine too.
      }
    } catch {}
  };
}

/** Remove lingering botfleet-* MCP servers from ~/.gemini/config/mcp_config.json.
 * Called on engine creation / harness startup so stale entries from crashed
 * or interrupted runs cannot leak into the user's sessions or surface 401s. */
export function cleanStaleAntigravityMcp(
  env: Record<string, string | undefined> = process.env,
): void {
  const home = env.HOME || env.USERPROFILE || homedir();
  const path = join(home, ".gemini", "config", "mcp_config.json");
  if (!existsSync(path)) return;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = mcpConfigFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    const currentServers = { ...parsed.data.mcpServers };
    let hasChanges = false;
    for (const key of Object.keys(currentServers)) {
      if (key.startsWith("botfleet-")) {
        delete currentServers[key];
        hasChanges = true;
      }
    }
    if (hasChanges) {
      const newConfig = { ...parsed.data, mcpServers: currentServers };
      writeFileSync(path, JSON.stringify(newConfig, null, 2), { mode: 0o600 });
      try { chmodSync(path, 0o600); } catch {}
    }
  } catch {}
}

function decodeConfig(raw: unknown): AntigravityConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.cli !== undefined && typeof o.cli !== "string") {
    throw new Error(`antigravity: invalid cli ${JSON.stringify(o.cli)}`);
  }
  if (o.fullAuto !== undefined && typeof o.fullAuto !== "boolean") {
    throw new Error(`antigravity: invalid fullAuto ${JSON.stringify(o.fullAuto)}`);
  }
  return {
    cli: typeof o.cli === "string" ? o.cli : "agy",
    // Default fullAuto to FALSE.  `--dangerously-skip-permissions` runs every
    // tool on this computer with nothing standing in for the permission
    // broker, which is the consent layer SECURITY.md promises.  Without it,
    // print mode runs `--mode accept-edits`: file edits go through and shell
    // commands come back as tool errors — a less capable bot, but one whose
    // reach the person chose.  Turning the bypass on is an explicit opt-in
    // on the Engines settings row, and the toggle there reflects this value.
    // Still throws above on a non-boolean fullAuto.
    fullAuto: o.fullAuto === true,
  };
}

/** How long stdout may keep draining after agy's own process exit before the
 * turn is finished on the exit alone.  Long enough for a final `result` line
 * to arrive, short enough that a grandchild holding the pipe cannot strand
 * the bot in "Thinking". */
const EXIT_DRAIN_GRACE_MS = 2_000;

/** How much of agy's own error text survives into the chip.  Kept well under
 * model-fallback.ts's 500-character quota-chip ceiling so a provider cap is
 * still recognised as one after the `error: ` prefix the harness adds. */
const AGY_ERROR_MAX = 300;

/** agy's cap message carries its own reset window ("Resets in 44h3m45s."). */
const AGY_RESET_CLAUSE = /\bresets?(?:\s+(?:in|at))?\s+[^.\n]{1,48}/i;

/** The terminal half of agy's `result` event. Parsed rather than duck-typed:
 * a turn's success and its only error text both come from here, and a shape
 * drift that silently widened either one is how a failed turn goes quiet. */
const agyTurnResultSchema = z.looseObject({
  status: z.string().nullish().catch(null),
  error: z.string().nullish().catch(null),
});

export type AntigravityTurnResult = z.infer<typeof agyTurnResultSchema>;

/** Never throws: an unrecognised payload still has to end the turn. */
export function parseAntigravityTurnResult(payload: unknown): AntigravityTurnResult {
  return agyTurnResultSchema.safeParse(payload).data ?? { status: null, error: null };
}

/**
 * The message BotFleet shows when a turn ends badly.
 *
 * agy reports every terminal failure the same way — one `result` event with
 * `status: "ERROR"` and a human-readable `result.error` — and that is the only
 * place a provider quota ever surfaces.  Observed against agy 1.1.12–1.1.25:
 *
 *   "Individual quota reached. Please upgrade your subscription to increase
 *    your limits. Resets in 44h3m45s."
 *   "Eligibility check failed: Post \"https://…\": read: connection reset by peer"
 *   "timeout waiting for response"
 *
 * The text is passed through so model-fallback.ts can classify it (the quota
 * wording matches QUOTA_OR_CAP, and "Resets in 44h…" parses as a reset time),
 * prefixed with the engine name so the person reading the chip knows which
 * provider ran out.  A long message is trimmed, but never at the cost of the
 * reset window — that is the actionable half.
 */
export function antigravityTurnErrorMessage(result: AntigravityTurnResult): string {
  const text = result.error?.trim() ?? "";
  if (!text) {
    const label = result.status?.trim() || "ERROR";
    return `Antigravity: the turn ended with status ${label} and no reply`;
  }
  let body = text.length > AGY_ERROR_MAX ? `${text.slice(0, AGY_ERROR_MAX).trimEnd()}…` : text;
  const reset = text.match(AGY_RESET_CLAUSE)?.[0]?.trim();
  if (reset && !body.includes(reset)) body = `${body} ${reset.endsWith(".") ? reset : `${reset}.`}`;
  return `Antigravity: ${body}`;
}

export const AntigravityDriver: ProviderDriver<AntigravityConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Antigravity", supportsMultipleInstances: true },
  install: {
    command: {
      darwin: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      linux: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      win32: "irm https://antigravity.google/cli/install.ps1 | iex",
    },
    docsUrl: "https://github.com/google-antigravity/antigravity-cli#installation",
  },
  models: STATIC_ANTIGRAVITY_MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<AntigravityConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const env = antigravityEnvironment(input.environment);
    const catalogEnv: Record<string, string | undefined> = env;
    let models = STATIC_ANTIGRAVITY_MODELS;
    const refreshModels = async () => {
      try {
        const resolved = await mergeLocalInject(readAntigravityModelCatalog(catalogEnv), catalogEnv);
        if (resolved.options.length) models = resolved;
      } catch {
        // Keep the last usable catalog when settings.json is unreadable.
      }
    };
    await refreshModels();
    cleanStaleAntigravityMcp(catalogEnv);
    const listeners = new Set<RuntimeEventListener>();
    // one active turn per thread; a second send while busy is a caller bug
    const active = new Map<string, { stop: () => void; turnId: string }>();
    const pending = new Set<string>();
    let disposed = false;
    // every live agy child, tracked independently of `active`: a child can
    // hang AFTER emitting `result` (so it's already removed from `active`), and
    // dispose()/stopAll() must still be able to reap it. Removed on process exit.
    const children = new Set<ChildProcess>();

    const emit = (event: RuntimeEvent) => {
      for (const l of [...listeners]) l(event);
    };

    // Reap every tracked child's tree (mirrors the per-turn stop()) — POSIX
    // process group on mac/linux, taskkill /T on Windows. When escalate is
    // set a SIGKILL follows after a grace for anything that ignored the term;
    // on Windows killCliTree is already a force kill, so the retry is a no-op.
    const reapChildren = (escalate: boolean) => {
      for (const child of children) {
        killCliTree(child);
        if (escalate && process.platform !== "win32") {
          setTimeout(() => {
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch {}
          }, 2000).unref?.();
        }
      }
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (disposed) throw new Error("Antigravity instance is disposed");
      if (active.has(threadId) || pending.has(threadId)) throw new Error("a turn is already running on this thread");
      pending.add(threadId);
      const turnId = newId();

      // Host control means the user's real desktop — the Local VM and a VPS
      // also arrive as `localComputer`, but they are isolated and carry no
      // scope, so `hostToolPrefix` is what tells them apart.  acp/core.ts runs
      // exactly this guard (see its sendTurn) and then lets every ask reach
      // the harness broker.  agy print mode has no ask to route, so this
      // driver can only honour the first half: drop the bypass for the turn so
      // `run_command` is refused instead of running unseen on the person's own
      // machine.  A full-auto instance keeps its switch for every other turn.
      const controlsHost = hostToolPrefix(turnComputerMounts(turn.integrations)) !== null;
      const turnConfig: AntigravityConfig =
        controlsHost && config.fullAuto ? { ...config, fullAuto: false } : config;

      // Default cwd to a per-thread workspace under DATA_DIR — deliberately
      // NOT homedir(): a bot running unattended should not get the whole home
      // as its default sandbox. `--add-dir` grants agy access to that dir.
      // strip filesystem-unsafe chars only — never truncate: a 36-char UUID
      // sliced to 32 would collide two threads sharing the first 32 chars onto
      // one workspace dir. replace() already keeps a UUID unique and safe.
      const tag = threadId.replace(/[^\w-]/g, "");
      const workspace = join(DATA_DIR, "workspaces", tag);
      try {
        mkdirSync(workspace, { recursive: true });
      } catch (error) {
        pending.delete(threadId);
        throw error;
      }
      const cwd = turn.cwd ?? workspace;

      // prompt is passed as the `--print` argv value: agy does NOT read the
      // prompt from piped stdin in print mode — a bare `--print` produces zero
      // output (verified against agy 1.1.12). Combine persona + text.
      // Trade-off: a very large prompt could exceed argv limits (E2BIG),
      // guarded below since stdin is not an option.
      const prompt = turn.system ? `${turn.system}\n\n${turn.text}` : turn.text;
      const resumeCursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;

      let settled = false;
      // Last backstop: a child that neither emits `result` nor exits. The
      // exit/close handlers below cover a child that dies; this covers one
      // that is alive and wedged, which would otherwise leave the bot busy
      // forever. Assigned just below; settle() always clears it.
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      // Assigned once the child exists. A child can emit `result` and then
      // hang, so settling must still arrange for process and MCP cleanup.
      let armPostSettleCleanup = () => {};
      const settle = (
        ok: boolean,
        stopReason: string | null,
        cost: number | null = null,
        usage?: { input: number; output: number },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        active.delete(threadId);
        armPostSettleCleanup();
        emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost, ...(usage ? { usage } : {}) });
      };

      // agy accepts prompts either via `--print <prompt>` on argv or via stdin.
      // Prompts <= 64KB pass on argv for backward compatibility with CLI stubs;
      // larger prompts pipe via stdin to avoid OS ARG_MAX / E2BIG limits.
      const MAX_PROMPT_BYTES = 20 * 1024 * 1024; // 20MB safety ceiling
      if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) {
        emit({
          ...base(threadId, turnId),
          type: "runtime.error",
          message: `prompt too large (${Buffer.byteLength(prompt)} bytes, max ${MAX_PROMPT_BYTES} bytes)`,
        });
        settle(false, "prompt_too_large");
        pending.delete(threadId);
        return { turnId };
      }
      const useStdin = Buffer.byteLength(prompt) > 64 * 1024;

      // agy's config is global, so every turn — including one without a
      // computer — owns the mount for its complete child lifetime. This keeps
      // overlapping turns from inheriting, replacing, or removing each
      // other's tools and credentials.
      const releaseMcpLease = await acquireAntigravityComputerMcpLease();
      if (disposed) {
        releaseMcpLease();
        pending.delete(threadId);
        settle(false, "disposed");
        return { turnId };
      }
      let restoreMcp = () => {};
      try {
        restoreMcp = ensureAntigravityMcp(antigravityMcpServers(turn.integrations), env);
      } catch (error) {
        releaseMcpLease();
        pending.delete(threadId);
        emit({
          ...base(threadId, turnId),
          type: "runtime.error",
          message: `could not update Antigravity's MCP config (${join(".gemini", "config", "mcp_config.json")}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        settle(false, "mcp_config_error");
        return { turnId };
      }

      const args = [
        "--output-format", "stream-json",
        "--print-timeout", "10m",
        "--add-dir", cwd,
        // fullAuto approves everything; otherwise accept-edits allows file
        // edits but auto-denies shell (no interactive channel in print mode).
        // turnConfig, not config: a host-control turn never takes the bypass.
        turnConfig.fullAuto ? "--dangerously-skip-permissions" : "--mode",
      ];
      if (!turnConfig.fullAuto) args.push("accept-edits");
      if (!useStdin) {
        args.unshift("--print", prompt);
      } else {
        args.unshift("--print", "-");
      }
      if (turn.model) args.push("--model", injectedApiModel(turn.model) ?? turn.model);
      if (resumeCursor) args.push("--conversation", resumeCursor);

      // spawnCli resolves npm .cmd shims / shebang scripts on Windows and
      // owns the process-group vs windowsHide difference (see procs.ts)
      let child: ReturnType<typeof spawnCli>;
      try {
        child = spawnCli(config.cli, args, {
          cwd,
          env,
          stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"],
        });
        if (useStdin && child.stdin) {
          child.stdin.on("error", () => {});
          child.stdin.end(prompt);
        }
      } catch (error) {
        try {
          restoreMcp();
        } finally {
          releaseMcpLease();
        }
        pending.delete(threadId);
        emit({
          ...base(threadId, turnId),
          type: "runtime.error",
          ...describeSpawnFailure(error instanceof Error ? error : new Error(String(error)), config.cli),
        });
        settle(false, "spawn_error");
        return { turnId };
      }
      children.add(child);

      let childClosed = false;
      let postSettleReaper: ReturnType<typeof setTimeout> | undefined;
      let terminationEscalation: ReturnType<typeof setTimeout> | undefined;
      let mcpFinalized = false;
      const finalizeMcp = () => {
        if (mcpFinalized) return;
        mcpFinalized = true;
        try {
          restoreMcp();
        } catch (error) {
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: `could not restore Antigravity's MCP config: ${error instanceof Error ? error.message : String(error)}`,
          });
        } finally {
          releaseMcpLease();
        }
      };
      const armTerminationEscalation = () => {
        if (childClosed || terminationEscalation) return;
        terminationEscalation = setTimeout(() => {
          if (childClosed) return;
          if (process.platform === "win32") {
            killCliTree(child); // taskkill /T /F is already forceful
            return;
          }
          try {
            const pid = child.pid;
            if (pid) process.kill(-pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {
            try {
              child.kill("SIGKILL");
            } catch {}
          }
        }, 3_000);
        terminationEscalation.unref?.();
      };
      const stop = () => {
        killCliTree(child); // process groups are POSIX-only
        armTerminationEscalation();
      };
      armPostSettleCleanup = () => {
        if (childClosed || postSettleReaper) return;
        // A normal agy process exits immediately after `result`. Give it a
        // short grace, then reap a zombie. Explicit stops use the same bounded
        // SIGKILL escalation so an uncooperative child cannot retain the lease.
        postSettleReaper = setTimeout(stop, 2_000);
        postSettleReaper.unref?.();
      };

      // conversation_id from the init event → the resumeCursor (session.started
      // is what the harness persists as the cursor). Also seeds tool item ids.
      let conversationId: string | null = null;
      let streamedAssistantText = "";

      const handleLine = (line: string) => {
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          return;
        }
        appendNative(threadId, { dir: "in", source: "agy.stream", msg: o });
        const payload = o[o.event] ?? {};
        switch (o.event) {
          case "init": {
            conversationId = o.conversation_id ?? null;
            emit({
              ...base(threadId, turnId),
              type: "session.started",
              sessionId: conversationId,
              model: turn.model ?? null,
            });
            break;
          }
          case "step_update": {
            if (payload.step_type === "tool") {
              const itemId = `${conversationId ?? o.conversation_id ?? "conv"}:${payload.step_index}`;
              if (payload.state === "ACTIVE") {
                emit({
                  ...base(threadId, turnId),
                  type: "item.started",
                  itemType: "tool",
                  itemId,
                  title: payload.tool_name,
                  ...toolFields(payload.tool_name, payload.tool_input ?? payload.input ?? payload.args),
                });
              } else if (payload.state === "DONE") {
                emit({ ...base(threadId, turnId), type: "item.completed", itemType: "tool", itemId, ok: true });
              } else if (payload.state === "ERROR") {
                emit({ ...base(threadId, turnId), type: "item.completed", itemType: "tool", itemId, ok: false });
              }
            } else if (payload.step_type === "agent_response") {
              if (typeof payload.text_delta === "string" && payload.text_delta.length > 0) {
                streamedAssistantText += payload.text_delta;
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: payload.text_delta });
              }
              if (payload.usage) {
                emit({
                  ...base(threadId, turnId),
                  type: "thread.token-usage.updated",
                  input: (payload.usage.input_tokens || 0) + (payload.usage.cache_read_tokens || 0),
                  output: payload.usage.output_tokens || 0,
                });
              }
            }
            break;
          }
          case "result": {
            const response = typeof payload.response === "string" ? payload.response : streamedAssistantText;
            if (response && !streamedAssistantText) {
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: response });
            }
            if (response) {
              emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: response });
            }
            if (payload.usage) {
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                input: (payload.usage.input_tokens || 0) + (payload.usage.cache_read_tokens || 0),
                output: payload.usage.output_tokens || 0,
              });
            }
            // agy has no separate error event: a provider quota, a failed
            // eligibility check, and its own "timeout waiting for response"
            // all arrive as this one `result` with status ERROR and a
            // human-readable `error`.  Surfacing it is the whole difference
            // between a red chip the person can act on and a turn that just
            // stops with nothing where the answer should be.
            const result = parseAntigravityTurnResult(payload);
            const ok = result.status === "SUCCESS";
            if (!ok) {
              emit({
                ...base(threadId, turnId),
                type: "runtime.error",
                message: antigravityTurnErrorMessage(result),
              });
            }
            settle(
              ok,
              result.status ?? null,
              null,
              payload.usage
                ? {
                    input: (payload.usage.input_tokens || 0) + (payload.usage.cache_read_tokens || 0),
                    output: payload.usage.output_tokens || 0,
                  }
                : undefined,
            );
            break;
          }
        }
      };

      let buf = "";
      child.stdout.setEncoding("utf8"); // decode multibyte across chunk splits
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) handleLine(line);
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

      // The turn must end when the child does, however it goes: a clean exit
      // with no `result`, a crash, a kill, or a wedged process the watchdog
      // reaps. Anything that leaves this unsettled leaves the bot busy with
      // nothing on screen — the stuck-forever bug, of which a silently
      // dropped quota was only the trigger.
      let exitDrain: ReturnType<typeof setTimeout> | undefined;
      const finishOnChildGone = (code: number | null, signal: NodeJS.Signals | null) => {
        childClosed = true;
        children.delete(child);
        clearTimeout(postSettleReaper);
        clearTimeout(terminationEscalation);
        clearTimeout(exitDrain);
        finalizeMcp();
        if (settled) return;
        const how = code === null && signal ? `was killed by ${signal}` : `exited ${code}`;
        emit({
          ...base(threadId, turnId),
          type: "runtime.error",
          message: `agy ${how} before result${stderr ? `: ${stderrExcerpt(stderr)}` : ""}`,
        });
        settle(false, "exit_before_result");
      };

      child.on("close", (code, signal) => finishOnChildGone(code, signal));

      // `close` waits for every stdio pipe to reach EOF, and agy's own MCP
      // servers are grandchildren that inherited those pipes — one of them
      // outliving agy holds `close` back indefinitely even though agy itself
      // is gone. `exit` is the process's own death, so it is the honest
      // signal; give stdout a short grace to drain a trailing `result` line
      // (which settles the turn properly), then finish on the exit alone.
      child.on("exit", (code, signal) => {
        if (childClosed || exitDrain) return;
        exitDrain = setTimeout(() => finishOnChildGone(code, signal), EXIT_DRAIN_GRACE_MS);
        exitDrain.unref?.();
      });

      active.set(threadId, { stop, turnId });
      pending.delete(threadId);

      // 11 min — just above agy's own 10m --print-timeout, so agy normally
      // settles first; this is the backstop for a fully wedged child.
      watchdog = setTimeout(() => {
        if (!settled) {
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: "Antigravity: the agy CLI stopped responding and never finished this turn — ending it after 11 minutes.",
          });
          stop();
          settle(false, "timeout");
        }
      }, 11 * 60_000);
      watchdog.unref?.();

      emit({ ...base(threadId, turnId), type: "turn.started" });

      if (controlsHost) {
        // Not a step the model took — the harness saying what this turn
        // cannot do, on the same `notice` chip a model fallback uses.  It
        // opens and settles in one breath because there is nothing to wait
        // for; an unsettled tool row would spin for the whole turn.
        const noticeItemId = `${turnId}:host-control-notice`;
        emit({
          ...base(threadId, turnId),
          type: "item.started",
          itemType: "tool",
          itemId: noticeItemId,
          title: ANTIGRAVITY_HOST_CONTROL_NOTICE,
          toolKind: "notice",
        });
        emit({
          ...base(threadId, turnId),
          type: "item.completed",
          itemType: "tool",
          itemId: noticeItemId,
          ok: true,
        });
      }

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const version = await new Promise<string | null>((resolve) => {
        execCli(config.cli, ["--version"], { timeout: 8000, env }, (err, stdout) =>
          resolve(err ? null : stdout.trim()),
        );
      });
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      // No auth field: agy auth is keyring-backed with no reliable file marker
      // (~/.gemini/antigravity-cli/ exists after first run even when logged
      // out), so any file heuristic would overstate "signed in". Leave undefined.
      return { state: "available", version };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() {
        return models;
      },
      refreshModels,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        // `localComputerMcp` stays true, and sendTurn is what earns it.  A
        // turn holding host control is spawned WITHOUT the bypass, so agy runs
        // `--mode accept-edits`: file edits go through, and a shell ask is
        // auto-DENIED rather than surfaced — `run_command` comes back to the
        // model as a tool error.  So a shell command on this computer is
        // refused, never run silently, which is the property contracts.ts is
        // protecting; what is still missing is the card that would let someone
        // say yes.  `respondToRequest` is "unavailable" for the same reason:
        // print mode opens no ask, so there is nothing to answer.  Real
        // per-action approval arrives when agy exposes native ACP (agy issue
        // #31) and this driver moves onto acp/core.ts's broker; the
        // alternative until then is setting this flag false, which would take
        // the desktop away from every Antigravity bot that has it today.
        capabilities: {
          sessionModelSwitch: "in-session",
          images: true,
          computerMcp: true,
          localComputerMcp: true,
          agentsMcp: true,
          composioMcp: true,
          phoneMcp: true,
          qdrantMcp: true,
        },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.stop(),
        respondToRequest: async () => "unavailable" as const, // this engine has no asks to answer
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { stop } of active.values()) stop();
          reapChildren(false); // also reap children that hung post-result
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: (prompt: string) =>
        new Promise((resolve, reject) => {
          execCli(
            config.cli,
            ["-p", prompt, "--output-format", "text", "--model", "gemini-3.6-flash-low"],
            { timeout: 60_000, env },
            (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
          );
        }),
      dispose: async () => {
        disposed = true;
        for (const { stop } of active.values()) stop();
        reapChildren(true); // escalate to SIGKILL — disposal must reap every child
        listeners.clear();
      },
    };
  },
};
