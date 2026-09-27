// Antigravity driver — Google's `agy` CLI in headless one-shot print mode
// (`agy --print --output-format stream-json`), modeled on claude.ts but fully
// self-contained. Per-turn CLI process; the conversation continues across
// turns via `--conversation <id>` (the resumeCursor is agy's conversation_id).
// Verified against agy 1.1.12.
//
// Unlike claude, print mode has NO interactive permission hook: there is no
// per-action broker here.  `--dangerously-skip-permissions` (fullAuto)
// approves everything.  Real per-action approval cards are a future path via
// native ACP (agy issue #31), which would reuse acp/core.ts like grok/gemini.
//
// `--mode` is NOT the permission switch, and an earlier version of this file
// said it was.  agy 1.1.26 `--help` lists "--mode  Set the agent execution
// mode for this session (accept-edits, plan)" and, separately, "--sandbox
// Run in a sandbox with terminal restrictions enabled".  Whether a terminal
// command needs approval is agy's own Tool Execution Policy — a global
// setting this driver does not pass and cannot override, reported per session
// as `permission_mode` on the init event.  Measured on this Mac with agy
// 1.1.26: `--mode accept-edits` with no bypass reports `always-proceed` and
// then RUNS `run_command`.  Under agy's shipped default the same spawn is
// refused — a probe with a config-free HOME reported `request-review` and
// agy's own stderr said the tool "required the \"command\" permission that
// headless mode cannot prompt for, so it was auto-denied", ending the turn
// CANCELED (2026-09-18).
//
// So a turn that holds host control — the person's own desktop — is spawned
// WITHOUT the bypass however the instance is configured, AND is stopped at
// the init event unless agy reports a policy that asks.  Nothing in print
// mode can put a card in front of anyone, so a turn that does not start is
// the only guarantee this engine can actually keep.
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
import { classifyError, computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "./retry.ts";
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
  /** Hard ceiling on one logical turn, relaunches included, however busy
   * agy stays.  Validated exactly like acp/core.ts's field of the same name. */
  promptTimeoutMs?: number;
  /** Renewable silence window while no tool step is running: any stdout line
   * restarts it, so only a turn that has gone completely quiet trips it. */
  promptIdleMs?: number;
  /** The same window while a tool step is ACTIVE.  A build or a test run can
   * legitimately print nothing for minutes, so it gets a longer leash. */
  promptToolIdleMs?: number;
}

/** Said once, at the start of any turn that can act on the person's own
 * desktop.  agy has no interactive permission hook in print mode, so there is
 * no card to put in front of anyone; what BotFleet can do instead is read the
 * policy agy reports and refuse to run the turn under one that would not ask.
 * A person who mounted this Mac expects to be asked, so the chip says plainly
 * which of those two things they are getting. */
export const ANTIGRAVITY_HOST_CONTROL_NOTICE =
  "Antigravity has no approval cards, so BotFleet checks its tool execution policy instead.  A policy that would run shell commands on this computer unasked stops the turn.";

/** agy's Tool Execution Policy values that pause for a human.  From agy
 * 1.1.26's embedded manual: "**Tool Execution Policy**: Controls whether
 * terminal commands require approval before running (`always-proceed`,
 * `request-review`, `strict`, `proceed-in-sandbox`)."  Its changelog confirms
 * the first is the one that does not ask — "always-proceed auto-approve tool
 * confirmation" — while "Fixed commands being auto-approved while the session
 * was in request-review or strict permission mode" and "Added `request-review`
 * (default) mode" establish the other two as asking modes and `request-review`
 * as the shipped default.  `proceed-in-sandbox` "Auto-approves terminal
 * commands that run inside the secure sandbox, requesting manual approval only
 * when a command attempts to bypass the sandbox".  That value is deliberately
 * NOT in the set below: what it does on the host depends on agy's separate
 * enableTerminalSandbox setting, which this driver never reads and never
 * forces (it does not pass `--sandbox`), and nobody has measured it with the
 * sandbox off.  Until someone does, it is refused like any other value whose
 * behaviour on this computer is not known.
 *
 * Do not confuse these with Artifact Review Mode, whose values in the same
 * manual are (`always-proceed`, `agent-decides`, `asks-for-review`); only the
 * Tool Execution Policy gates `run_command`. */
const ANTIGRAVITY_ASKING_POLICIES = new Set(["request-review", "strict"]);

/** Why a host-control turn was stopped before it ran.  The `always-proceed`
 * wording is the measured case; an unreported or unrecognized value gets the
 * same remedy but does not claim to know what the policy would do, because
 * claiming more than we know is the bug this whole check exists to fix. */
export function antigravityHostPolicyRefusal(reported: string | null): string {
  const remedy =
    "  Set the policy to request-review or strict in Antigravity, or remove this computer from the bot.";
  if (reported === "always-proceed") {
    return (
      "Antigravity's tool execution policy is always-proceed, which would run shell commands on this computer with nobody able to approve." +
      remedy
    );
  }
  const named = reported ? `is ${reported}` : "was not reported";
  return (
    `Antigravity's tool execution policy ${named}, so BotFleet cannot tell whether shell commands on this computer would run with nobody able to approve.` +
    remedy
  );
}

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

/** Every key this harness owns in agy's global file starts with this; nothing
 *  else in it is ours to add, replace, or remove. */
export const BOTFLEET_MCP_PREFIX = "botfleet-";

export interface AntigravityComputerMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

// ── the mount lease (DR4) ───────────────────────────────────────────────
//
// agy's MCP file is machine-global, so a turn that MOUNTS a computer into it
// must exclude every other Antigravity turn for its child's whole lifetime —
// otherwise a second turn's agy could pick up the first turn's tools and, in
// their env, its box or control tokens.  That part has not changed.
//
// What changed is who has to wait.  The lease used to be one module-global
// promise taken unconditionally, so a turn with NO computer at all — the
// overwhelming majority — still serialized behind whatever else was running,
// for as long as that other turn lasted, which could be up to 11 minutes.
// Two bots on Antigravity could not answer at the same time.
//
// It is a reader/writer lease now, per config path:
//   • a turn that mounts nothing and has nothing of ours to strip takes the
//     SHARED side — any number of those run at once, because none of them
//     writes the file and none of them can inherit a mount that does not
//     exist;
//   • a turn that mounts a computer, or that has to strip a leftover
//     `botfleet-*` key, takes the EXCLUSIVE side: it waits for the readers
//     already running to finish AND locks everyone else out until its child
//     is gone.
//
// That keeps today's isolation guarantee intact.  The obvious cheaper fixes
// do not: releasing the lease once the child has "read" the config assumes a
// read time nobody has measured (agy may start an MCP server lazily, at the
// first tool call), and skipping the lease outright for computer-less turns
// would let one start WHILE a mount is installed, which is exactly the
// token-crossing this lease exists to prevent.
//
// TODO(DR4): a MOUNTING turn still holds the file for its child's whole
// lifetime — up to the turn's hard ceiling (`promptTimeoutMs`, 11 minutes by
// default), though a silent child is now stopped by the idle windows long
// before that and a timeout is never relaunched.  Shortening that needs one
// measured fact nobody has yet: WHEN does `agy` read
// `~/.gemini/config/mcp_config.json`?  If it reads once at
// startup, the exclusive hold can end at the init event and mounting turns
// would stop excluding each other for minutes.  If it re-reads lazily — say,
// the first time the model calls a computer tool — an early release would
// hand one turn another turn's tools and box token, so the hold must stay.
// Measure it against a real `agy` (watch the file with fs events across a
// turn that calls a tool late) before changing anything here.  Neither the
// code, the comments below, nor agy 1.1.26's embedded docs answer it.
interface AntigravityMcpLease {
  /** Chain of exclusive holders; a reader waits on it while one is active. */
  writers: Promise<void>;
  /** True from the moment an exclusive holder starts until it releases. */
  writing: boolean;
  /** Shared holders running right now. */
  readers: number;
  /** Exclusive holders parked until `readers` reaches zero. */
  drained: Array<() => void>;
}

const antigravityMcpLeases = new Map<string, AntigravityMcpLease>();

/** The machine-global file agy actually reads.  Derived from the turn's own
 *  env so two instances pointed at different HOMEs get different leases —
 *  they are different files and have no reason to wait on each other. */
export function antigravityMcpConfigPath(env: Record<string, string | undefined> = process.env): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  return join(home, ".gemini", "config", "mcp_config.json");
}

function leaseFor(path: string): AntigravityMcpLease {
  const existing = antigravityMcpLeases.get(path);
  if (existing) return existing;
  const lease: AntigravityMcpLease = { writers: Promise.resolve(), writing: false, readers: 0, drained: [] };
  antigravityMcpLeases.set(path, lease);
  return lease;
}

/** Does the file already carry one of our keys?  A turn that would have to
 *  remove one is a WRITER even though it mounts nothing.  An unreadable file
 *  answers `true` on purpose: "we cannot tell" must take the safe side. */
export function antigravityConfigHasBotfleetServers(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    const parsed = mcpConfigFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) return false;
    return Object.keys(parsed.data.mcpServers ?? {}).some((key) => key.startsWith(BOTFLEET_MCP_PREFIX));
  } catch {
    return true;
  }
}

/** Take the mount lease for one turn and return its release.
 *
 *  `exclusive` turns hold the file; shared turns only promise not to touch
 *  it.  Both hold until the child is gone, because that is the window in
 *  which agy might still read the file. */
export async function acquireAntigravityComputerMcpLease(
  path: string,
  exclusive: boolean,
): Promise<() => void> {
  const lease = leaseFor(path);
  let released = false;
  if (!exclusive) {
    // Re-checked after every wait: a writer that became active while this
    // turn was parked must not be overtaken.  When no writer is active this
    // loop does not await at all, which is the point — the common turn pays
    // nothing.
    while (lease.writing) await lease.writers;
    lease.readers++;
    return () => {
      if (released) return;
      released = true;
      if (--lease.readers === 0) for (const wake of lease.drained.splice(0)) wake();
    };
  }
  const previous = lease.writers;
  let unlock: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  lease.writers = previous.then(() => current);
  await previous;
  lease.writing = true;
  if (lease.readers > 0) await new Promise<void>((resolve) => lease.drained.push(resolve));
  return () => {
    if (released) return;
    released = true;
    lease.writing = false;
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
  const path = antigravityMcpConfigPath(env);
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
    if (key.startsWith(BOTFLEET_MCP_PREFIX)) {
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
        if (key.startsWith(BOTFLEET_MCP_PREFIX)) {
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
               if (k.startsWith(BOTFLEET_MCP_PREFIX)) {
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
  const path = antigravityMcpConfigPath(env);
  if (!existsSync(path)) return;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = mcpConfigFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    const currentServers = { ...parsed.data.mcpServers };
    let hasChanges = false;
    for (const key of Object.keys(currentServers)) {
      if (key.startsWith(BOTFLEET_MCP_PREFIX)) {
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

// ── turn deadlines ──────────────────────────────────────────────────────
// The turn used to have exactly one clock: an 11-minute wall-clock watchdog
// that killed a busy turn and a wedged one alike, and told nobody it was
// coming.  It is now two renewable silence windows plus a hard ceiling, the
// same shape acp/core.ts uses: a turn that keeps printing is never cut off
// by the idle windows, and one that goes quiet is stopped long before the
// ceiling.  The bounds match acp/core.ts so a setting means the same thing
// on every engine.
const DEFAULT_PROMPT_MAX_MS = 11 * 60_000;
const DEFAULT_PROMPT_IDLE_MS = 180_000;
const DEFAULT_PROMPT_TOOL_IDLE_MS = 8 * 60_000;
const MIN_PROMPT_WINDOW_MS = 1_000;
const MAX_PROMPT_WINDOW_MS = 20 * 60_000;
/** How far into a live window the "still waiting" notice appears. */
const DEADLINE_WARN_FRACTION = 0.8;

function decodeWindowMs(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= MIN_PROMPT_WINDOW_MS &&
    value <= MAX_PROMPT_WINDOW_MS
    ? value
    : undefined;
}

/** "3 minutes" for a whole number of minutes, "N s" otherwise (short test
 *  windows included).  Only ever used in the text a person reads. */
function describeWindow(ms: number): string {
  // A minute or more reads in minutes ("about 2 minutes", not "132 s").
  if (ms >= 60_000) {
    const minutes = Math.round(ms / 60_000);
    const about = ms % 60_000 === 0 ? "" : "about ";
    return `${about}${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${Math.max(1, Math.round(ms / 1000))} s`;
}

/** agy's own `--print-timeout`, always a whole minute ABOVE our ceiling so
 *  agy never kills a still-streaming turn before this driver decides to. */
export function antigravityPrintTimeout(maxMs: number): string {
  return `${Math.ceil(maxMs / 60_000) + 1}m`;
}

function decodeConfig(raw: unknown): AntigravityConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const promptTimeoutMs = decodeWindowMs(o.promptTimeoutMs);
  const promptIdleMs = decodeWindowMs(o.promptIdleMs);
  const promptToolIdleMs = decodeWindowMs(o.promptToolIdleMs);
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
    // An out-of-range or malformed window falls back to the default rather
    // than throwing: a stale setting must not take the engine offline.
    ...(promptTimeoutMs === undefined ? {} : { promptTimeoutMs }),
    ...(promptIdleMs === undefined ? {} : { promptIdleMs }),
    ...(promptToolIdleMs === undefined ? {} : { promptToolIdleMs }),
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
    // Retry bookkeeping lives PER THREAD, not per sendTurn call: a relaunch
    // re-enters sendTurn, and the budget has to survive that hop or every
    // attempt would look like the first.  claude.ts owns the same shape.
    // `startedAt` is when the LOGICAL turn's first child launched, so the hard
    // ceiling covers every relaunch together instead of restarting with each
    // one.  Time spent queued for the mount lease is not part of it.
    const retryState = new Map<string, { attempt: number; cancelled: boolean; startedAt: number }>();
    // A relaunch waits real seconds; the fake agy in antigravity.test.ts
    // scales that down.  The `turn.retrying` event still reports the REAL
    // policy delay, so a test asserts the policy without paying for it.
    const retryScale = Number(process.env.FAKE_AGY_RETRY_SCALE ?? "1");
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
      // Carried across a relaunch (see maybeRetry): `attempt` counts the
      // transient failures this logical turn has already absorbed, and
      // `cancelled` is how a stop during the backoff reaches the pending
      // relaunch instead of letting it spawn a child nobody wants.
      const retry = retryState.get(threadId) ?? { attempt: 0, cancelled: false, startedAt: Date.now() };
      retry.cancelled = false;
      retryState.set(threadId, retry);
      const retryAbort = new AbortController();

      // Host control means the user's real desktop — the Local VM and a VPS
      // also arrive as `localComputer`, but they are isolated and carry no
      // scope, so `hostToolPrefix` is what tells them apart.  acp/core.ts runs
      // exactly this guard (see its sendTurn) and then lets every ask reach
      // the harness broker.  agy print mode has no ask to route, so this
      // driver drops the bypass for the turn and then, at the init event,
      // checks the policy agy actually reports — dropping the bypass alone
      // proves nothing, because the Tool Execution Policy is a separate axis
      // that can auto-approve shell regardless (see the file header).  A
      // full-auto instance keeps its switch for every other turn.
      const controlsHost = hostToolPrefix(turnComputerMounts(turn.integrations)) !== null;
      // Auto Mode is for turns a person is present for.  A webhook/resource
      // turn begins with nobody watching, so it must not inherit the
      // permission bypass even when the bot has autoApprove on — the broker
      // path enforces this in autoVerdict ("unattended-block"), and print
      // mode has no broker, so the driver enforces it here instead.
      const isAutoApproved = turn.autoApprove === true && turn.unattended !== true;
      // The per-bot override is scoped to host-control turns only: letting a
      // bot-level autoApprove flag flip fullAuto for sandbox/cloud/VM turns
      // would silently promote an engine-level security gate the owner never
      // switched on.  Non-host turns keep exactly what config.fullAuto says.
      const turnConfig: AntigravityConfig = {
        ...config,
        fullAuto: controlsHost ? isAutoApproved : config.fullAuto,
      };

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
        // nothing launched, so nothing may outlive this call — a stale entry
        // would hand its start time to the thread's next turn
        retryState.delete(threadId);
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
      // Set once a relaunch is scheduled: the failed child is still dying and
      // its close event must not also terminate a turn that is coming back.
      let retryScheduled = false;
      // The replay-safety gate, and it is PROTOCOL state rather than a
      // reading of the error text: it flips the moment this child put
      // something on the bus a relaunch would duplicate — a tool step, a
      // streamed token, a refusal.  Before that, a transient failure is a
      // failure to START, and starting over costs nothing.
      let sawOutput = false;
      // The backstops for a child that neither emits `result` nor exits.  The
      // exit/close handlers below cover a child that dies; these cover one
      // that is alive and wedged, which would otherwise leave the bot busy
      // forever.  Armed once the child exists; settle() and a scheduled
      // relaunch always clear them.
      const maxMs = config.promptTimeoutMs ?? DEFAULT_PROMPT_MAX_MS;
      const idleMs = config.promptIdleMs ?? DEFAULT_PROMPT_IDLE_MS;
      const toolIdleMs = config.promptToolIdleMs ?? DEFAULT_PROMPT_TOOL_IDLE_MS;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let idleWarnTimer: ReturnType<typeof setTimeout> | undefined;
      let maxTimer: ReturnType<typeof setTimeout> | undefined;
      let maxWarnTimer: ReturnType<typeof setTimeout> | undefined;
      const clearDeadlines = () => {
        clearTimeout(idleTimer);
        clearTimeout(idleWarnTimer);
        clearTimeout(maxTimer);
        clearTimeout(maxWarnTimer);
      };
      // Assigned once the child exists. A child can emit `result` and then
      // hang, so settling must still arrange for process and MCP cleanup.
      let armPostSettleCleanup = () => {};
      const settle = (
        ok: boolean,
        stopReason: string | null,
        cost: number | null = null,
        usage?: { input: number; output: number; cachedInput?: number },
      ) => {
        if (settled || retryScheduled) return;
        settled = true;
        retryState.delete(threadId);
        clearDeadlines();
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

      // agy's config is global, so a turn that WRITES it owns the mount for
      // its complete child lifetime — that is what keeps overlapping turns
      // from inheriting, replacing, or removing each other's tools and
      // credentials.  A turn that neither mounts anything nor has a leftover
      // key to strip writes nothing, so it takes the shared side and runs
      // alongside its peers instead of queueing behind them (DR4).
      //
      // Both reads happen in this one synchronous stretch, and the acquire
      // below claims its side before its first await, so a mounting turn can
      // never slip in between deciding and claiming.
      const mcpServers = antigravityMcpServers(turn.integrations);
      const mcpConfigPath = antigravityMcpConfigPath(env);
      const mountsComputer = Object.keys(mcpServers).length > 0;
      const ownsMcpFile = mountsComputer || antigravityConfigHasBotfleetServers(mcpConfigPath);
      const releaseMcpLease = await acquireAntigravityComputerMcpLease(mcpConfigPath, ownsMcpFile);
      if (disposed) {
        releaseMcpLease();
        pending.delete(threadId);
        settle(false, "disposed");
        return { turnId };
      }
      // The ceiling's clock starts here, once the lease is held, not when
      // sendTurn was entered: a turn queued behind another mounting turn must
      // not arrive with its 11 minutes already spent.  A relaunch keeps the
      // first launch's start, so the ceiling still spans every attempt.
      if (retry.attempt === 0) retry.startedAt = Date.now();
      let restoreMcp = () => {};
      try {
        restoreMcp = ensureAntigravityMcp(mcpServers, env);
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
        "--print-timeout", antigravityPrintTimeout(maxMs),
        "--add-dir", cwd,
        // fullAuto approves everything.  accept-edits is the execution mode,
        // NOT a permission setting: it auto-approves file edits and leaves
        // terminal commands to agy's Tool Execution Policy, which is why a
        // host-control turn also has to check `permission_mode` on init.
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

      /** Absorb a transient failure by relaunching the turn, or report false
       *  and let the caller settle it (DR2).
       *
       *  Antigravity had no retry at all: a single 429 or a connection reset
       *  failed the whole turn and pushed the bot's fallback chain into a
       *  cooldown one more attempt would have avoided.  The conditions are
       *  claude.ts's, for claude.ts's reasons — transient by the shared
       *  classifier, not stopped by the person, budget left, and nothing yet
       *  put on the bus by this child.
       *
       *  A timeout is transient to the shared classifier but never relaunched
       *  here: agy's own "timeout waiting for response" means the provider
       *  already hung once on this exact prompt, and relaunching into the same
       *  hang is how one turn used to occupy a bot for half an hour.  Nor is
       *  anything relaunched once the turn's hard ceiling has passed. */
      const maybeRetry = (failure: Parameters<typeof classifyError>[0]): boolean => {
        if (settled || retryScheduled || sawOutput) return false;
        if (retry.cancelled || disposed) return false;
        if (retry.attempt >= RETRY_MAX_ATTEMPTS - 1) return false;
        if (Date.now() - retry.startedAt >= maxMs) return false;
        const verdict = classifyError(failure);
        if (!verdict.transient || verdict.reason === "timeout") return false;

        retryScheduled = true;
        clearDeadlines();
        retry.attempt++;
        const delayMs = computeBackoff(retry.attempt - 1);
        emit({
          ...base(threadId, turnId),
          type: "turn.retrying",
          attempt: retry.attempt,
          delayMs,
          reason: verdict.reason,
        });
        // The thread STAYS claimed through the backoff — that entry is what
        // makes a stop during the wait reach this turn rather than racing a
        // relaunch nobody can see yet.
        const cancelRetry = () => {
          retry.cancelled = true;
          retryAbort.abort();
        };
        active.set(threadId, { stop: cancelRetry, turnId });
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
            // The SAME turn: a relaunch keeps the cursor it arrived with, so
            // it resumes the thread's real conversation rather than the one
            // this attempt created and abandoned.
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

      // conversation_id from the init event → the resumeCursor (session.started
      // is what the harness persists as the cursor). Also seeds tool item ids.
      let conversationId: string | null = null;
      let streamedAssistantText = "";
      // Set when a host-control turn is stopped over agy's tool execution
      // policy.  The child is killed, but lines already in the pipe would
      // otherwise keep emitting steps into a turn the person was told ended.
      let hostPolicyRefused = false;
      // Tool steps agy has reported ACTIVE and not yet DONE or ERROR.  While
      // any is open the silence window is the longer tool window.
      const activeTools = new Set<string>();

      const handleLine = (line: string) => {
        if (settled || retryScheduled || hostPolicyRefused) return;
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
            // The init event is the only place agy states the Tool Execution
            // Policy this session is running under, and it is the setting that
            // decides whether `run_command` asks — `--mode accept-edits` does
            // not (file header).  On the person's own desktop, a policy that
            // does not ask means arbitrary shell with no card and nobody to
            // show one to, so the turn ends here rather than running.  An
            // unreported or unrecognized value is treated the same way: this
            // check exists because the driver used to assume a refusal it
            // never verified, and a default of "probably fine" would repeat
            // exactly that.  `proceed-in-sandbox` is refused too: its effect on the
            // host turns on a second agy setting this driver does not read.
            if (controlsHost && !isAutoApproved) {
              const reported =
                typeof payload.permission_mode === "string"
                  ? payload.permission_mode
                  : typeof o.permission_mode === "string"
                    ? o.permission_mode
                    : null;
              if (reported === null || !ANTIGRAVITY_ASKING_POLICIES.has(reported)) {
                hostPolicyRefused = true;
                // a refusal is a verdict the person is shown; never re-run it
                sawOutput = true;
                emit({
                  ...base(threadId, turnId),
                  type: "runtime.error",
                  message: antigravityHostPolicyRefusal(reported),
                });
                stop();
                settle(false, "host_control_policy");
                return;
              }
            }
            break;
          }
          case "step_update": {
            if (payload.step_type === "tool") {
              const itemId = `${conversationId ?? o.conversation_id ?? "conv"}:${payload.step_index}`;
              // a tool is running, or has run: a relaunch would repeat it
              sawOutput = true;
              if (payload.state === "ACTIVE") {
                activeTools.add(itemId);
                emit({
                  ...base(threadId, turnId),
                  type: "item.started",
                  itemType: "tool",
                  itemId,
                  title: payload.tool_name,
                  ...toolFields(payload.tool_name, payload.tool_input ?? payload.input ?? payload.args),
                });
              } else {
                // Any state other than ACTIVE means the step is no longer
                // running (CANCELED included), so the longer tool window
                // must not outlive it.
                activeTools.delete(itemId);
                if (payload.state === "DONE") {
                  emit({ ...base(threadId, turnId), type: "item.completed", itemType: "tool", itemId, ok: true });
                } else if (payload.state === "ERROR") {
                  emit({ ...base(threadId, turnId), type: "item.completed", itemType: "tool", itemId, ok: false });
                }
              }
            } else if (payload.step_type === "agent_response") {
              if (typeof payload.text_delta === "string" && payload.text_delta.length > 0) {
                streamedAssistantText += payload.text_delta;
                // words the person has already read — see maybeRetry
                sawOutput = true;
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: payload.text_delta });
              }
              if (payload.usage) {
                const cacheRead = payload.usage.cache_read_tokens;
                emit({
                  ...base(threadId, turnId),
                  type: "thread.token-usage.updated",
                  input: (payload.usage.input_tokens || 0) + (payload.usage.cache_read_tokens || 0),
                  output: payload.usage.output_tokens || 0,
                  ...(typeof cacheRead === "number" && Number.isFinite(cacheRead) && cacheRead >= 0
                    ? { cachedInput: cacheRead }
                    : {}),
                });
              }
            }
            break;
          }
          case "result": {
            const response = typeof payload.response === "string" ? payload.response : streamedAssistantText;
            // agy has no error event: a provider 429 or a dropped connection
            // arrives as an ERROR result like everything else.  One that
            // carries no answer and followed no tool step is a failure to
            // START, so it gets the same relaunch a dead child would.
            if (!response && !sawOutput) {
              const early = parseAntigravityTurnResult(payload);
              if (early.status !== "SUCCESS" && maybeRetry({ text: antigravityTurnErrorMessage(early) })) {
                stop(); // the child has said all it is going to
                return;
              }
            }
            if (response && !streamedAssistantText) {
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: response });
            }
            if (response) {
              emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: response });
            }
            if (payload.usage) {
              const cacheRead = payload.usage.cache_read_tokens;
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                input: (payload.usage.input_tokens || 0) + (payload.usage.cache_read_tokens || 0),
                output: payload.usage.output_tokens || 0,
                ...(typeof cacheRead === "number" && Number.isFinite(cacheRead) && cacheRead >= 0
                  ? { cachedInput: cacheRead }
                  : {}),
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
            // A person who pressed Stop gets a stopped turn, not a crash: agy
            // may still flush a CANCELED or ERROR result on its way out, and
            // that is the stop they asked for, not a failure to report.
            if (!ok && retry.cancelled) {
              settle(false, "interrupted");
              break;
            }
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
                    ...(typeof payload.usage.cache_read_tokens === "number" &&
                    Number.isFinite(payload.usage.cache_read_tokens) && payload.usage.cache_read_tokens >= 0
                      ? { cachedInput: payload.usage.cache_read_tokens }
                      : {}),
                  }
                : undefined,
            );
            break;
          }
        }
      };

      // ── deadlines ────────────────────────────────────────────────────────
      // Said once the window is 80 % spent, on the same `notice` chip the
      // host-control warning uses, so a stop never arrives unannounced.
      let noticeCount = 0;
      // One idle warning per turn: a long quiet spell that then resumes must
      // not leave a fresh chip in the transcript every time it recurs.
      let idleWarned = false;
      const deadlineNotice = (title: string) => {
        if (settled || retryScheduled) return;
        const itemId = `${turnId}:deadline-notice-${++noticeCount}`;
        emit({ ...base(threadId, turnId), type: "item.started", itemType: "tool", itemId, title, toolKind: "notice" });
        emit({ ...base(threadId, turnId), type: "item.completed", itemType: "tool", itemId, ok: true });
      };
      const tripDeadline = (stopReason: "prompt_stall" | "prompt_timeout", message: string) => {
        // A person already stopped this turn: the child's close settles it
        // as interrupted, and a deadline firing in that gap is not a stall.
        if (settled || retryScheduled || retry.cancelled) return;
        emit({ ...base(threadId, turnId), type: "runtime.error", message });
        stop();
        // prompt_stall and prompt_timeout are the stop reasons index.ts
        // already treats as a possibly wedged session: the next turn starts a
        // fresh conversation instead of resuming this one.
        settle(false, stopReason);
      };
      const armIdle = () => {
        if (settled || retryScheduled) return;
        clearTimeout(idleTimer);
        clearTimeout(idleWarnTimer);
        const toolRunning = activeTools.size > 0;
        const windowMs = toolRunning ? toolIdleMs : idleMs;
        const warnMs = Math.round(windowMs * DEADLINE_WARN_FRACTION);
        if (!idleWarned) {
          idleWarnTimer = setTimeout(() => {
            idleWarned = true;
            deadlineNotice(
              `Antigravity has gone quiet${toolRunning ? " while a tool runs" : ""}.  If nothing arrives in the next ${describeWindow(windowMs - warnMs)}, BotFleet stops the turn as stalled.`,
            );
          }, warnMs);
          idleWarnTimer.unref?.();
        }
        idleTimer = setTimeout(
          () =>
            tripDeadline(
              "prompt_stall",
              `Antigravity sent nothing for ${describeWindow(windowMs)}${toolRunning ? " while a tool ran" : ""} and was stopped.`,
            ),
          windowMs,
        );
        idleTimer.unref?.();
      };
      // The hard ceiling runs from the start of the LOGICAL turn, so a
      // relaunch inherits what is left of it rather than a fresh budget.
      const armMax = () => {
        const elapsed = Date.now() - retry.startedAt;
        const warnIn = Math.round(maxMs * DEADLINE_WARN_FRACTION) - elapsed;
        if (warnIn > 0) {
          maxWarnTimer = setTimeout(
            () =>
              deadlineNotice(
                `This turn is close to Antigravity's ${describeWindow(maxMs)} limit.  BotFleet stops it in ${describeWindow(maxMs - Math.round(maxMs * DEADLINE_WARN_FRACTION))} if it has not finished.`,
              ),
            warnIn,
          );
          maxWarnTimer.unref?.();
        }
        maxTimer = setTimeout(
          () =>
            tripDeadline(
              "prompt_timeout",
              `Antigravity ran past its ${describeWindow(maxMs)} limit and was stopped.`,
            ),
          Math.max(0, maxMs - elapsed),
        );
        maxTimer.unref?.();
      };

      let buf = "";
      child.stdout.setEncoding("utf8"); // decode multibyte across chunk splits
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        let nl;
        let sawLine = false;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) {
            handleLine(line);
            sawLine = true;
          }
        }
        // Any complete line is proof of life.  Re-armed AFTER the lines are
        // handled, so a step that just went ACTIVE (or DONE) picks the
        // window that matches it.
        if (sawLine) armIdle();
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
      // with no `result`, a crash, a kill, or a wedged process the idle or
      // ceiling deadline reaps.  Anything that leaves this unsettled leaves
      // the bot busy with nothing on screen — the stuck-forever bug, of which
      // a silently dropped quota was only the trigger.
      let exitDrain: ReturnType<typeof setTimeout> | undefined;
      const finishOnChildGone = (code: number | null, signal: NodeJS.Signals | null) => {
        childClosed = true;
        children.delete(child);
        clearTimeout(postSettleReaper);
        clearTimeout(terminationEscalation);
        clearTimeout(exitDrain);
        finalizeMcp();
        if (settled || retryScheduled) return;
        // Stop is not a crash.  The person (or a forced quiesce) asked for
        // this child to die, so its SIGTERM is the expected ending: settle
        // as interrupted, with no runtime.error for Sentry to page on.
        if (retry.cancelled) {
          settle(false, "interrupted");
          return;
        }
        const how = code === null && signal ? `was killed by ${signal}` : `exited ${code}`;
        const message = `agy ${how} before result${stderr ? `: ${stderrExcerpt(stderr)}` : ""}`;
        // The mount lease is already released above, so the relaunch queues
        // for it honestly instead of deadlocking on a lease this turn still
        // holds.
        if (maybeRetry({ exitCode: code, stderr: message })) return;
        emit({ ...base(threadId, turnId), type: "runtime.error", message });
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

      // Wrapped, not bare: a person who stops this turn has stopped the WHOLE
      // turn, and the child's close must not then read as a transient failure
      // worth relaunching.  `stop` stays unwrapped for the driver's own use.
      active.set(threadId, {
        stop: () => {
          retry.cancelled = true;
          retryAbort.abort();
          clearDeadlines();
          stop();
        },
        turnId,
      });
      pending.delete(threadId);

      armIdle();
      armMax();

      emit({ ...base(threadId, turnId), type: "turn.started" });

      if (controlsHost && !isAutoApproved) {
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
