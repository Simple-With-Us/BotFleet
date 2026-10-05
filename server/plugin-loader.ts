// Load a plugin into its own sandboxed OS process and broker the host API
// across the process boundary.
//
// Plugin code never runs in the trusted server process.  Each enabled
// plugin gets one child (server/plugin-sandbox-child.ts) spawned with:
//   * an empty environment, so provider keys, session tokens, and
//     NODE_OPTIONS in this process's `process.env` are not visible to it,
//   * the Node permission model: read access to the child script and the
//     plugin's own folder only, no filesystem writes, no child processes,
//     no worker threads, no native addons, no WASI, no inspector,
//   * a capped V8 heap, a start deadline, and a per-call deadline.  A call
//     that overruns kills the child; the next call respawns it.
//   * stdio closed, so nothing the plugin prints reaches the server log.
//
// The host API a plugin sees is built inside the child from a per-call
// snapshot.  The capability gates and the secret-key redaction run here,
// in the parent, before the snapshot is sent, so a plugin can only ever
// see what its manifest declared.  Every message the child sends back is
// parsed with ChildToParentMessageSchema; an unparseable message kills the
// child.
//
// Residual risk: Node's permission model (as shipped in the Node versions
// BotFleet runs on) does not restrict outbound network access.  A plugin
// can still open sockets, but it has no credentials, no environment, and
// no readable files outside its own folder to send.  Network isolation
// needs an OS-level mechanism and is tracked in docs/plugins/DESIGN.md §
// Open Questions.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { HOST_API_VERSION, satisfiesBotfleetVersion, type JsonValue } from "../shared/plugin-manifest.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { PLUGINS_DIR } from "./plugin-registry.ts";
import {
  ChildToParentMessageSchema,
  MAX_PLUGIN_RESULT_BYTES,
  type ParentToChildMessage,
  type PluginLogLevel,
  type PluginRefusal,
  type SandboxHostSnapshot,
} from "./plugin-sandbox-protocol.ts";
import type { PluginExports, PluginListing, PluginSource } from "./plugin-types.ts";

/** A plugin's bot summary, used by `host.getBots()`.  Kept narrow on
 *  purpose: the plugin does not need the full bot record. */
export interface PluginHostBotSummary {
  id: string;
  name: string;
  status: string;
  driver: string;
}

/** Why the sandbox, rather than the plugin, ended a call or a load. */
export type PluginSandboxReason =
  | "sandbox_unavailable"
  | "start_failed"
  | "start_timeout"
  | "timeout"
  | "sandbox_exited"
  | "protocol_violation"
  | "result_too_large";

/** Structured, allow-listed log events.  No field carries plugin-supplied
 *  text: `pluginId` is a hash of the plugin's directory name, and every
 *  other field is a level, a length, or a stable code. */
export type PluginLogEvent =
  | { event: "plugin.log"; pluginId: string; level: PluginLogLevel; length: number }
  | { event: "plugin.capability_refused"; pluginId: string; level: "warn"; capability: PluginRefusal }
  | { event: "plugin.sandbox"; pluginId: string; level: "warn"; reason: PluginSandboxReason | "import_failed" | "invalid_exports" | "bad_request" };

/** The factory receives whatever the host has available: bot summaries
 *  and a small allowlisted config snapshot.  Tests pass a stub. */
export interface PluginHostInputs {
  listBots: () => PluginHostBotSummary[];
  listConfigKeys: () => readonly string[];
  readConfig: <T = unknown>(key: string) => T | undefined;
  logger: (event: PluginLogEvent) => void;
}

const SECRET_CONFIG_KEY = /key|token|secret|credential/i;

/** Same filter `listConfigKeys` uses.  A plugin must not read a value
 *  whose key looks like a credential, even if it guesses the name. */
export function isSecretConfigKey(key: string): boolean {
  return SECRET_CONFIG_KEY.test(key);
}

function isRedactableRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Copy a config value with secret-looking keys removed at every level.
 *  The copy is the point: the plugin must not hold the live config object. */
export function redactPluginConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactPluginConfig(entry));
  if (!isRedactableRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (isSecretConfigKey(key)) continue;
    out[key] = redactPluginConfig(value[key]);
  }
  return out;
}

/** Short, stable correlation id for a plugin in logs.  The raw name comes
 *  from a downloaded manifest, so logs carry this hash instead. */
export function pluginLogId(name: string): string {
  return createHash("sha256").update(name).digest("hex").slice(0, 12);
}

const JSON_VALUE = z.json();

/** Read one allow-listed config value, redact it, and accept it only when
 *  its JSON round-trip parses as a JSON value.  Functions, symbols, and
 *  undefined fields drop out; anything unserializable is withheld. */
function redactedConfigValue(inputs: PluginHostInputs, key: string): JsonValue | undefined {
  const redacted = redactPluginConfig(inputs.readConfig(key));
  if (redacted === undefined) return undefined;
  let text: string | undefined;
  try {
    text = JSON.stringify(redacted);
  } catch {
    return undefined;
  }
  if (text === undefined) return undefined;
  const parsed = JSON_VALUE.safeParse(JSON.parse(text));
  return parsed.success ? parsed.data : undefined;
}

/** Capture the host data one call may see.  Capabilities the manifest did
 *  not declare are `null`, and the child reports the refusal when the
 *  plugin reaches for them.  Config values are redacted copies of
 *  allow-listed, non-secret keys only. */
export function buildHostSnapshot(inputs: PluginHostInputs, capabilities: readonly string[]): SandboxHostSnapshot {
  const allowed = new Set(capabilities);
  const statusAllowed = allowed.has("read.status");
  const bots = allowed.has("read.bots")
    ? inputs.listBots().map((bot) => ({
      id: String(bot.id),
      name: String(bot.name),
      status: statusAllowed ? String(bot.status) : "",
      driver: String(bot.driver),
    }))
    : null;
  if (!allowed.has("read.config")) return { bots, statusAllowed, configKeys: null, config: {} };
  const configKeys = inputs.listConfigKeys().filter((key) => !isSecretConfigKey(key));
  const config: Record<string, JsonValue> = {};
  for (const key of configKeys) {
    const value = redactedConfigValue(inputs, key);
    if (value !== undefined) config[key] = value;
  }
  return { bots, statusAllowed, configKeys: [...configKeys], config };
}

/** One handler call into the sandbox. */
export type PluginSandboxCall =
  | { handler: "getCardData"; cardId: string }
  | { handler: "runCommand"; command: string; args: string };

export type PluginSandboxResult =
  | { ok: true; value: JsonValue }
  | { ok: false; reason: PluginSandboxReason | "not_implemented" | "handler_threw" | "result_not_serializable" | "bad_request" };

/** A running sandbox for one plugin. */
export interface PluginSandbox {
  readonly exports: PluginExports;
  isAlive(): boolean;
  call(request: PluginSandboxCall, host: SandboxHostSnapshot): Promise<PluginSandboxResult>;
  dispose(): void;
}

export interface PluginSandboxOptions {
  /** Absolute path of the plugin entry file inside `pluginDir`. */
  entryPath: string;
  /** The plugin's own folder: the only plugin path the child may read. */
  pluginDir: string;
  pluginId: string;
  logger: (event: PluginLogEvent) => void;
  startTimeoutMs?: number;
  callTimeoutMs?: number;
  heapMb?: number;
}

const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 5_000;
const DEFAULT_HEAP_MB = 64;

/** The permission flag this Node build understands, or null when the
 *  permission model is unavailable.  Without it there is no sandbox, and
 *  the loader refuses to run plugin code rather than fall back to the
 *  server process. */
function permissionFlag(): string | null {
  if (process.allowedNodeEnvironmentFlags.has("--permission")) return "--permission";
  if (process.allowedNodeEnvironmentFlags.has("--experimental-permission")) return "--experimental-permission";
  return null;
}

/** The child's environment.  Nothing is inherited.  Electron's binary
 *  needs ELECTRON_RUN_AS_NODE to behave as plain Node, the same way the
 *  server's other spawned helpers run. */
function sandboxEnv(): NodeJS.ProcessEnv {
  return process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {};
}

class ChildPluginSandbox implements PluginSandbox {
  exports: PluginExports = { getCardData: false, runCommand: false };
  private alive = true;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (result: PluginSandboxResult) => void; timer: NodeJS.Timeout }>();
  private onStart: ((result: PluginSandboxReason | "import_failed" | "invalid_exports" | "bad_request" | null) => void) | null = null;

  private readonly child: ChildProcess;
  private readonly options: PluginSandboxOptions;

  constructor(child: ChildProcess, options: PluginSandboxOptions) {
    this.child = child;
    this.options = options;
    // serialization: "json" means every message is a JSON value; its shape
    // is still untrusted until ChildToParentMessageSchema parses it.
    child.on("message", (raw: JsonValue) => this.handleMessage(raw));
    child.on("error", () => this.terminate("start_failed"));
    child.on("exit", () => this.terminate("sandbox_exited"));
  }

  start(): Promise<PluginSandboxReason | "import_failed" | "invalid_exports" | "bad_request" | null> {
    return new Promise((resolveStart) => {
      const timer = setTimeout(() => this.terminate("start_timeout"), this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
      this.onStart = (result) => {
        clearTimeout(timer);
        this.onStart = null;
        resolveStart(result);
      };
      this.send({ type: "load", entryUrl: pathToFileURL(this.options.entryPath).href });
    });
  }

  isAlive(): boolean {
    return this.alive;
  }

  call(request: PluginSandboxCall, host: SandboxHostSnapshot): Promise<PluginSandboxResult> {
    if (!this.alive) return Promise.resolve({ ok: false, reason: "sandbox_exited" });
    const id = this.nextId++;
    return new Promise((resolveCall) => {
      const timer = setTimeout(() => {
        this.settle(id, { ok: false, reason: "timeout" });
        this.terminate("timeout");
      }, this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolveCall, timer });
      this.send({ type: "invoke", id, host, ...request });
    });
  }

  dispose(): void {
    this.terminate(null);
  }

  private send(message: ParentToChildMessage): void {
    if (!this.alive || !this.child.connected) return;
    this.child.send(message);
  }

  private settle(id: number, result: PluginSandboxResult): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(result);
    return true;
  }

  private log(reason: PluginSandboxReason | "import_failed" | "invalid_exports" | "bad_request"): void {
    this.options.logger({ event: "plugin.sandbox", pluginId: this.options.pluginId, level: "warn", reason });
  }

  /** Kill the child and fail everything outstanding.  `reason` is null for
   *  an orderly dispose, which is not worth a log line. */
  private terminate(reason: PluginSandboxReason | null): void {
    if (!this.alive) return;
    this.alive = false;
    if (reason) this.log(reason);
    this.child.kill("SIGKILL");
    for (const id of this.pending.keys()) this.settle(id, { ok: false, reason: "sandbox_exited" });
    this.onStart?.(reason ?? "sandbox_exited");
  }

  private handleMessage(raw: JsonValue): void {
    if (!this.alive) return;
    const parsed = ChildToParentMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.terminate("protocol_violation");
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case "log":
        this.options.logger({ event: "plugin.log", pluginId: this.options.pluginId, level: message.level, length: message.length });
        return;
      case "refused":
        this.options.logger({
          event: "plugin.capability_refused",
          pluginId: this.options.pluginId,
          level: "warn",
          capability: message.capability,
        });
        return;
      case "ready":
        if (!this.onStart) return this.terminate("protocol_violation");
        this.exports = message.exports;
        this.onStart(null);
        return;
      case "load_failed":
        if (!this.onStart) return this.terminate("protocol_violation");
        this.log(message.reason);
        this.onStart(message.reason);
        this.dispose();
        return;
      case "call_failed":
        if (!this.pending.has(message.id)) return this.terminate("protocol_violation");
        this.settle(message.id, { ok: false, reason: message.reason });
        return;
      case "result": {
        if (!this.pending.has(message.id)) return this.terminate("protocol_violation");
        if (JSON.stringify(message.value).length > MAX_PLUGIN_RESULT_BYTES) {
          this.settle(message.id, { ok: false, reason: "result_too_large" });
          return;
        }
        this.settle(message.id, { ok: true, value: message.value });
        return;
      }
    }
  }
}

/** Spawn and handshake a sandbox for one plugin entry file. */
export async function startPluginSandbox(
  options: PluginSandboxOptions,
): Promise<PluginSandbox | { reason: PluginSandboxReason | "import_failed" | "invalid_exports" | "bad_request" }> {
  const flag = permissionFlag();
  if (!flag) {
    options.logger({ event: "plugin.sandbox", pluginId: options.pluginId, level: "warn", reason: "sandbox_unavailable" });
    return { reason: "sandbox_unavailable" };
  }
  const childScript = SPAWNED_PROXIES.pluginSandbox;
  const pluginDir = resolve(options.pluginDir);
  const args = [
    flag,
    `--allow-fs-read=${childScript}`,
    `--allow-fs-read=${pluginDir}`,
    `--max-old-space-size=${options.heapMb ?? DEFAULT_HEAP_MB}`,
  ];
  // The dev tree runs the .ts source; the packaged tree runs the bundled .js.
  if (childScript.endsWith(".ts")) args.push("--experimental-strip-types", "--no-warnings");
  args.push(childScript);

  let child: ChildProcess;
  try {
    child = spawn(process.execPath, args, {
      cwd: pluginDir,
      env: sandboxEnv(),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
      windowsHide: true,
    });
  } catch {
    options.logger({ event: "plugin.sandbox", pluginId: options.pluginId, level: "warn", reason: "start_failed" });
    return { reason: "start_failed" };
  }
  const sandbox = new ChildPluginSandbox(child, options);
  const failure = await sandbox.start();
  if (failure) {
    sandbox.dispose();
    return { reason: failure };
  }
  return sandbox;
}

/** A loaded plugin: its listing facts and the sandbox running its code.
 *  A host-version mismatch is an error from `loadPlugin`, not a flag the
 *  caller can ignore. */
export interface LoadedPlugin {
  name: string;
  version: string;
  source: PluginSource;
  capabilities: readonly string[];
  sandbox: PluginSandbox;
}

/** Load (or reload) one enabled plugin.  Refuses a host-version mismatch
 *  before spawning anything.  The `baseDir` is the registry base
 *  directory; production callers pass the default, tests pass a mkdtemp'd
 *  directory so they never touch the host's user data. */
export async function loadPlugin(
  listing: PluginListing,
  inputs: PluginHostInputs,
  baseDir: string = PLUGINS_DIR,
  options: Pick<PluginSandboxOptions, "callTimeoutMs" | "startTimeoutMs" | "heapMb"> = {},
): Promise<LoadedPlugin | { error: string }> {
  if (!satisfiesBotfleetVersion(listing.botfleet, HOST_API_VERSION)) {
    return {
      error: `plugin "${listing.name}" requires botfleet "${listing.botfleet}" but the host API is ${HOST_API_VERSION}`,
    };
  }

  const pluginDir = resolve(baseDir, listing.name);
  const entryPath = resolve(pluginDir, listing.entry);
  // The manifest schema already rejects absolute and `..` entries; this is
  // the belt to that brace, checked on the resolved path.
  if (!entryPath.startsWith(`${pluginDir}/`) && !entryPath.startsWith(`${pluginDir}\\`)) {
    return { error: `plugin "${listing.name}" failed to load (entry_outside_plugin)` };
  }

  const started = await startPluginSandbox({
    ...options,
    entryPath,
    pluginDir,
    pluginId: pluginLogId(listing.name),
    logger: inputs.logger,
  });
  if ("reason" in started) {
    return { error: `plugin "${listing.name}" failed to load (${started.reason})` };
  }

  return {
    name: listing.name,
    version: listing.version,
    source: listing.source,
    capabilities: [...listing.capabilities],
    sandbox: started,
  };
}

/** Run one handler in a loaded plugin's sandbox with a fresh host
 *  snapshot built under that plugin's declared capabilities. */
export function invokePlugin(
  plugin: LoadedPlugin,
  request: PluginSandboxCall,
  inputs: PluginHostInputs,
): Promise<PluginSandboxResult> {
  return plugin.sandbox.call(request, buildHostSnapshot(inputs, plugin.capabilities));
}
