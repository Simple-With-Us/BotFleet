// The slash-command contract: what GET /api/bots/:id/commands answers, what
// POST /api/bots/:id/commands takes and returns, and the two small text rules
// every surface shares.  The server builds these (server/command-registry.ts),
// the desktop and iOS composers read them, and the three JSON files under
// shared/fixtures/bot-commands are the same shapes written out, so a client can
// mock the endpoint without a server.
//
// A client ignores fields it does not know, and hides any item or group whose
// enum value or `clientAction` it does not know; `schemaVersion` above 1 means
// "render the known fields only".  The strict schemas below are the server's:
// a field added here without a version bump fails the server's own tests.

import { z } from "zod";

export const BOT_COMMANDS_SCHEMA_VERSION = 1;

export const COMMAND_SURFACES = ["desktop", "ios"] as const;
export type CommandSurface = (typeof COMMAND_SURFACES)[number];

/** Where a command is typed: the two composers, or a text message that reached
 *  the bot over iMessage (Mac relay or Linq). */
export type CommandOrigin = CommandSurface | "imessage" | "linq";

export const COMMAND_CLIENT_ACTIONS = ["model-picker", "effort-picker", "tasks", "computer"] as const;
export type CommandClientAction = (typeof COMMAND_CLIENT_ACTIONS)[number];

const commandArgsSchema = z
  .object({
    required: z.boolean(),
    hint: z.string(),
    maxLength: z.number().int().min(1).max(500),
  })
  .strict();
export type CommandArgs = z.infer<typeof commandArgsSchema>;

const botCommandSchema = z
  .object({
    id: z.string().regex(/^(botfleet|engine):[a-z][a-z0-9-]*$/),
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    label: z.string().regex(/^\/[a-z][a-z0-9-]*$/),
    title: z.string(),
    description: z.string().max(90),
    source: z.enum(["botfleet", "engine"]),
    invoke: z.enum(["server", "client"]),
    clientAction: z.enum(COMMAND_CLIENT_ACTIONS).nullable(),
    args: commandArgsSchema.nullable(),
    availability: z.enum(["always", "idle"]),
    enabled: z.boolean(),
    disabledReason: z.string().nullable(),
    runsModelTurn: z.boolean(),
    collidesWith: z.string().nullable(),
  })
  .strict();
export type BotCommand = z.infer<typeof botCommandSchema>;

const botCommandGroupSchema = z
  .object({
    id: z.enum(["botfleet", "engine"]),
    label: z.string(),
    state: z.enum(["ready", "pending"]),
    note: z.string().nullable(),
    commands: z.array(botCommandSchema),
  })
  .strict();
export type BotCommandGroup = z.infer<typeof botCommandGroupSchema>;

export const botCommandsResponseSchema = z
  .object({
    schemaVersion: z.literal(BOT_COMMANDS_SCHEMA_VERSION),
    botId: z.string(),
    threadId: z.string(),
    surface: z.enum(COMMAND_SURFACES),
    busy: z.boolean(),
    engine: z
      .object({
        /** Opaque; never shown or parsed. */
        instanceId: z.string(),
        displayName: z.string(),
        model: z.string(),
        modelLabel: z.string(),
        effort: z.string().nullable(),
        commandSupport: z.enum(["announced", "none"]),
      })
      .strict(),
    groups: z.array(botCommandGroupSchema).min(1).max(2),
  })
  .strict();
export type BotCommandsResponse = z.infer<typeof botCommandsResponseSchema>;

/** One line of a command's reply, for the result card. */
export interface BotCommandReplyLine {
  label: string;
  value: string;
}

const replyLineSchema = z.object({ label: z.string(), value: z.string() }).strict();

export const botCommandResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ok: z.literal(true),
      id: z.string(),
      kind: z.literal("reply"),
      reply: z
        .object({
          title: z.string(),
          text: z.string(),
          lines: z.array(replyLineSchema),
        })
        .strict(),
      effects: z
        .object({
          stopped: z.boolean(),
          clearedQueued: z.number().int().min(0),
          cancelledRuns: z.number().int().min(0),
          newThreadId: z.string().nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      id: z.string(),
      kind: z.literal("turn"),
      threadId: z.string(),
      invocationMessageId: z.string(),
    })
    .strict(),
]);
export type BotCommandResult = z.infer<typeof botCommandResultSchema>;

/** The request body of POST /api/bots/:id/commands. */
export const botCommandRequestSchema = z
  .object({
    id: z.string().regex(/^(botfleet|engine):[a-z][a-z0-9-]*$/),
    args: z.string().optional(),
    threadId: z.string().regex(/^[\w-]+$/).optional(),
    surface: z.enum(COMMAND_SURFACES).optional(),
    idempotencyKey: z.string().optional(),
  })
  .strict();
export type BotCommandRequest = z.infer<typeof botCommandRequestSchema>;

/** The error codes POST and GET answer with, beside the sentence-case error. */
export const BOT_COMMAND_ERROR_CODES = [
  "invalid_body",
  "invalid_args",
  "client_command",
  "bot_not_found",
  "command_not_found",
  "bot_busy",
  "thread_mismatch",
  "already_new",
  "no_session",
  "command_disabled",
  "unsupported_media_type",
  "engine_unavailable",
  "rate_limited",
] as const;
export type BotCommandErrorCode = (typeof BOT_COMMAND_ERROR_CODES)[number];

/** What a composer's trimmed text looks like when it may be a command:
 *  "/name" and, after blanks, one argument line.  The caller still decides
 *  whether the name exists and whether it takes an argument; text that does
 *  not match is an ordinary message. */
const COMPOSER_COMMAND = /^\/([a-z][a-z0-9-]*)(?:[ \t]+(.+))?$/i;

export function parseComposerCommand(text: string): { name: string; args: string | null } | null {
  const match = COMPOSER_COMMAND.exec(text.trim());
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: match[2]?.trim() || null };
}

/** The BotFleet commands a text message can run over iMessage: exactly one of
 *  these on its own, with at most one closing . ! or ?.  Anything else, however
 *  close, is ordinary text. */
export const MESSAGING_COMMAND_NAMES = ["stop", "new", "status", "help"] as const;
export type MessagingCommandName = (typeof MESSAGING_COMMAND_NAMES)[number];

const MESSAGING_COMMAND = /^\/(stop|new|status|help)[.!?]?$/i;

/** Blanks that may surround a text message: ASCII whitespace and U+00A0, which
 *  iOS puts after a period. */
const MESSAGE_BLANKS = /^[\s ]+|[\s ]+$/g;

/** The command a text message is, or null when it is ordinary text.  `body` is
 *  the message with any relay wrapper already removed. */
export function parseMessagingCommand(body: string): MessagingCommandName | null {
  const trimmed = body.replace(MESSAGE_BLANKS, "");
  if (trimmed.includes("\n") || trimmed.includes("\r")) return null;
  const match = MESSAGING_COMMAND.exec(trimmed);
  if (!match) return null;
  // SAFETY: the pattern admits only the four names, in any case
  return match[1].toLowerCase() as MessagingCommandName;
}
