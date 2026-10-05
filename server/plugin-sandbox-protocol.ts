// Wire protocol between the trusted server and a plugin sandbox child
// (server/plugin-sandbox-child.ts).  Node's IPC channel carries JSON
// (`serialization: "json"`), so only plain data crosses the boundary.
//
// Direction matters:
//   * parent -> child messages are built by the server itself.  The
//     ParentToChildMessageSchema documents the contract; the child
//     rejects anything that fails its equivalent runtime shape check.
//   * child -> parent messages come from a process running untrusted
//     plugin code.  The parent accepts one only when
//     ChildToParentMessageSchema parses it.  An unparseable message is a
//     protocol violation: the parent kills the child and fails every
//     pending call.
//
// Plugin-supplied text (log messages, thrown error messages) never
// crosses the boundary.  The child reports a log line's level and
// length, and a failed handler as a stable reason code.
import { z } from "zod";

import type { JsonValue } from "../shared/plugin-manifest.ts";
import { PluginExportsSchema } from "./plugin-types.ts";

/** Upper bound on one handler result, measured as JSON text.  A plugin
 *  that returns more is treated as a failed call, not truncated. */
export const MAX_PLUGIN_RESULT_BYTES = 256 * 1024;

export const PluginLogLevelSchema = z.enum(["info", "warn", "error"]);
export type PluginLogLevel = z.infer<typeof PluginLogLevelSchema>;

/** Capability refusals the child reports when the plugin reaches for a
 *  host API its manifest did not declare.  Stable codes only. */
export const PluginRefusalSchema = z.enum(["read.bots", "read.status", "read.config", "config.allowlist"]);
export type PluginRefusal = z.infer<typeof PluginRefusalSchema>;

/** Why a load failed inside the child.  Stable codes only; the raw import
 *  error stays in the child. */
export const PluginLoadFailureSchema = z.enum(["import_failed", "invalid_exports", "bad_request"]);

/** Why one handler call failed inside the child. */
export const PluginCallFailureSchema = z.enum([
  "not_implemented",
  "handler_threw",
  "result_not_serializable",
  "bad_request",
]);

const callId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const ChildToParentMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), exports: PluginExportsSchema }).strict(),
  z.object({ type: z.literal("load_failed"), reason: PluginLoadFailureSchema }).strict(),
  z.object({ type: z.literal("result"), id: callId, value: z.json() }).strict(),
  z.object({ type: z.literal("call_failed"), id: callId, reason: PluginCallFailureSchema }).strict(),
  z.object({
    type: z.literal("log"),
    level: PluginLogLevelSchema,
    length: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }).strict(),
  z.object({ type: z.literal("refused"), capability: PluginRefusalSchema }).strict(),
]);
export type ChildToParentMessage = z.infer<typeof ChildToParentMessageSchema>;

/** A plugin's getCardData result.  The handler must return an object
 *  with a JSON `result`; anything else is a contract failure. */
export const PluginCardResultSchema = z.object({ result: z.json() }).strict();

/** A plugin's runCommand result.  Must be text. */
export const PluginCommandResultSchema = z.string().max(MAX_PLUGIN_RESULT_BYTES);

/** The bot summary a plugin may see.  Narrow on purpose. */
export const SandboxBotSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  driver: z.string(),
}).strict();
export type SandboxBotSummary = z.infer<typeof SandboxBotSummarySchema>;

/** Host data captured by the parent for one call, after the capability
 *  gates and the secret redaction have run.  The child answers the
 *  plugin's synchronous host calls from this snapshot, so the host API
 *  keeps its synchronous shape without the child ever reaching back into
 *  the server.  `null` means the capability was not declared. */
export const SandboxHostSnapshotSchema = z.object({
  bots: z.array(SandboxBotSummarySchema).nullable(),
  statusAllowed: z.boolean(),
  configKeys: z.array(z.string()).nullable(),
  config: z.record(z.string(), z.json()),
}).strict();
export type SandboxHostSnapshot = z.infer<typeof SandboxHostSnapshotSchema>;

/** Parent -> child wire messages.  Exported so tests and the parent can
 *  parse; the sandbox child uses an equivalent hand-rolled check because
 *  it cannot import zod under the permission model (dev runs the .ts
 *  entry with --experimental-strip-types and no node_modules read). */
export const ParentToChildMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("load"),
    entryUrl: z.string(),
  }).strict(),
  z.object({
    type: z.literal("invoke"),
    id: callId,
    handler: z.literal("getCardData"),
    cardId: z.string(),
    host: SandboxHostSnapshotSchema,
  }).strict(),
  z.object({
    type: z.literal("invoke"),
    id: callId,
    handler: z.literal("runCommand"),
    command: z.string(),
    args: z.string(),
    host: SandboxHostSnapshotSchema,
  }).strict(),
]);
export type ParentToChildMessage = z.infer<typeof ParentToChildMessageSchema>;
