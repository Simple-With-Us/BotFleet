// Plugin sandbox child.  Spawned by server/plugin-loader.ts as its own OS
// process, one per enabled plugin, with:
//   * an empty environment (no provider keys, session tokens, or
//     NODE_OPTIONS reach this process),
//   * the Node permission model: read access to this script and the
//     plugin's own folder only, no filesystem writes, no child processes,
//     no worker threads, no native addons, no WASI, no inspector,
//   * a small V8 heap cap, and a per-call deadline enforced by the parent,
//     which kills this process when a handler overruns.
//
// This file must not import anything at runtime except Node built-ins:
// under the permission model it cannot read node_modules, and the
// packaged build bundles it as its own entry point.  Type-only imports
// are erased before execution.
//
// The plugin talks to BotFleet only through the host object built here.
// That host answers from a per-call snapshot the parent already filtered
// through the manifest's capabilities and the secret-key redaction.
// Plugin log text and thrown error messages never leave this process;
// the parent receives levels, lengths, and stable reason codes.
import type { JsonValue } from "../shared/plugin-manifest.ts";
import type {
  ChildToParentMessage,
  ParentToChildMessage,
  PluginLogLevel,
  PluginRefusal,
  SandboxHostSnapshot,
} from "./plugin-sandbox-protocol.ts";
import type { PluginHost } from "./plugin-types.ts";

/** What a plugin handler may hand back.  The child re-serializes it, so
 *  the parent only ever receives JSON. */
type PluginReturn = JsonValue | undefined;
type CardHandler = (args: { cardId: string; host: PluginHost }) => PluginReturn | Promise<PluginReturn>;
type CommandHandler = (args: { command: string; args: string; host: PluginHost }) => PluginReturn | Promise<PluginReturn>;

/** The two exports the host looks for on an imported module.  Their
 *  values are unverified until exportedHandler checks them. */
interface PluginNamespace {
  getCardData?: JsonValue | Function;
  runCommand?: JsonValue | Function;
}

let handlers: { getCardData: CardHandler | null; runCommand: CommandHandler | null } | null = null;

function send(message: ChildToParentMessage): void {
  process.send?.(message);
}

/** A namespace export is callable, or it is absent.  Anything else is a
 *  contract failure.  `instanceof Function` covers sync and async
 *  functions alike. */
function exportedHandler(namespace: PluginNamespace, name: keyof PluginNamespace): Function | null | "invalid" {
  const value = namespace[name];
  if (value === undefined) return null;
  return value instanceof Function ? value : "invalid";
}

/** Copy a JSON value so the plugin cannot keep a reference to the
 *  snapshot between calls. */
function cloneJson(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value));
}

const LOG_LEVELS: readonly PluginLogLevel[] = ["info", "warn", "error"];

function createHost(snapshot: SandboxHostSnapshot): PluginHost {
  const refused = new Set<PluginRefusal>();
  const refuse = (capability: PluginRefusal) => {
    if (refused.has(capability)) return;
    refused.add(capability);
    send({ type: "refused", capability });
  };
  const config: PluginHost["config"] = Object.freeze({
    get: <T = unknown>(key: string): T | undefined => {
      if (snapshot.configKeys === null) {
        refuse("read.config");
        return undefined;
      }
      if (!Object.prototype.hasOwnProperty.call(snapshot.config, key)) {
        refuse("config.allowlist");
        return undefined;
      }
      const value = snapshot.config[key];
      // SAFETY: the plugin names T; the host promises only a redacted JSON copy and does not validate it against T, same contract as the in-process host it replaces.
      return (value === undefined ? undefined : cloneJson(value)) as T | undefined;
    },
    listKeys: () => {
      if (snapshot.configKeys === null) {
        refuse("read.config");
        return [];
      }
      return [...snapshot.configKeys];
    },
  });
  const host: PluginHost = {
    version: 1,
    log: (level, message) => {
      const safeLevel = LOG_LEVELS.find((candidate) => candidate === level) ?? "info";
      // Only the length crosses the boundary.  String() keeps a non-string
      // argument from throwing; its text still never leaves this process.
      send({ type: "log", level: safeLevel, length: String(message ?? "").length });
    },
    getBots: () => {
      if (snapshot.bots === null) {
        refuse("read.bots");
        return [];
      }
      if (!snapshot.statusAllowed) refuse("read.status");
      return snapshot.bots.map((bot) => ({ ...bot }));
    },
    config,
  };
  return Object.freeze(host);
}

async function load(entryUrl: string): Promise<void> {
  let namespace: PluginNamespace;
  try {
    namespace = await import(entryUrl);
  } catch {
    send({ type: "load_failed", reason: "import_failed" });
    return;
  }
  const card = exportedHandler(namespace, "getCardData");
  const command = exportedHandler(namespace, "runCommand");
  if (card === "invalid" || command === "invalid") {
    send({ type: "load_failed", reason: "invalid_exports" });
    return;
  }
  handlers = {
    // SAFETY: exportedHandler confirmed a callable export; the plugin contract (docs/plugins/DESIGN.md § Host API) names this signature, and the result is re-serialized and schema-checked by the parent.
    getCardData: card as CardHandler | null,
    // SAFETY: same as above for the runCommand export.
    runCommand: command as CommandHandler | null,
  };
  send({ type: "ready", exports: { getCardData: card !== null, runCommand: command !== null } });
}

async function runHandler(message: Extract<ParentToChildMessage, { type: "invoke" }>): Promise<PluginReturn | "not_implemented"> {
  const host = createHost(message.host);
  if (message.handler === "getCardData") {
    if (!handlers?.getCardData) return "not_implemented";
    return handlers.getCardData({ cardId: message.cardId, host });
  }
  if (!handlers?.runCommand) return "not_implemented";
  return handlers.runCommand({ command: message.command, args: message.args, host });
}

async function invoke(message: Extract<ParentToChildMessage, { type: "invoke" }>): Promise<void> {
  const { id } = message;
  if (!handlers) {
    send({ type: "call_failed", id, reason: "bad_request" });
    return;
  }
  let value: PluginReturn | "not_implemented";
  try {
    value = await runHandler(message);
  } catch {
    send({ type: "call_failed", id, reason: "handler_threw" });
    return;
  }
  if (value === "not_implemented") {
    send({ type: "call_failed", id, reason: "not_implemented" });
    return;
  }
  let json: JsonValue;
  try {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error("undefined result");
    json = JSON.parse(text);
  } catch {
    send({ type: "call_failed", id, reason: "result_not_serializable" });
    return;
  }
  send({ type: "result", id, value: json });
}

// Messages on this channel come from the trusted parent, which builds
// them from ParentToChildMessage.  The untrusted direction is the other
// one, and the parent validates it with zod.
process.on("message", (message: ParentToChildMessage) => {
  if (message.type === "load") {
    if (handlers === null) void load(message.entryUrl);
    return;
  }
  void invoke(message);
});

// A plugin that crashes asynchronously takes only its own process down.
// The parent sees the exit and fails the pending calls.
process.on("uncaughtException", () => process.exit(70));
process.on("unhandledRejection", () => process.exit(70));
// The parent going away closes the IPC channel; do not linger.
process.on("disconnect", () => process.exit(0));
