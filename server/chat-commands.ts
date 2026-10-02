// BotFleet's own slash commands: what a text message means as one, and what
// each command does and says.  /stop, /new, /status and /help work on every
// surface; the composers also open pickers for /model, /effort, /tasks and
// /computer, which need no server work and live in the registry only.
//
// The reserved commands are handled here, before any model sees the text, and
// they never reach an engine.  Over iMessage a text message is a command only
// when it is exactly one of the four words (case aside, with one closing . ! or
// ?): "/stop now" and "/stopp" are ordinary text, because wrongly running /new
// would hide a conversation and wrongly ignoring a command only costs a retype.
//
// The functions here take what they need as arguments and hold no state of the
// server's own, so the same code answers the HTTP route, the messages route and
// the tests.  server/index.ts supplies the effects (stopping a turn, starting a
// task) and decides where a reply goes.

import { effortLabel } from "../src/lib/model-effort.ts";
import {
  parseMessagingCommand,
  type BotCommandErrorCode,
  type BotCommandReplyLine,
  type CommandOrigin,
  type MessagingCommandName,
} from "../shared/bot-commands.ts";
import { parseImessageInbound } from "../shared/imessage-message.ts";
import { redactSecretsInText } from "./redact.ts";

/** The four commands that run on the server on every surface. */
export type ServerCommandName = MessagingCommandName;

/** The title the iMessage conversation carries.  The persona rule that tells a
 *  model it is talking over iMessage matches this title, case aside. */
export const IMESSAGE_TASK_TITLE = "iMessage";

/** What /help prints over iMessage: fixed, because only these four words are
 *  commands there. */
export const MESSAGING_HELP_LINES: readonly string[] = [
  "/stop  Stop and clear queued messages",
  "/new  Start a fresh conversation",
  "/status  Engine, model and spend",
  "/help  This list",
  "Anything else goes to the bot.",
];

/** How many commands a bot answers over messaging in one window. */
export const MESSAGING_COMMAND_LIMIT = 10;
export const MESSAGING_COMMAND_WINDOW_MS = 60_000;

/** The command a relayed text message is, or null when it is ordinary text.
 *  The Mac relay posts the raw text and Linq posts it inside the inbound block,
 *  so the wrapper is read off first. */
export function messagingCommandOf(rawText: string): ServerCommandName | null {
  const body = parseImessageInbound(rawText)?.body ?? rawText;
  return parseMessagingCommand(body);
}

/** Counts commands per bot in a rolling window, in memory.  The command over
 *  the limit gets no reply at all, which is what keeps a loop of two bots from
 *  becoming a storm of replies. */
export class CommandRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;

  // Not a parameter property: the server runs under Node's strip-only
  // TypeScript mode, which rejects `constructor(private readonly x)`.
  constructor(limit = MESSAGING_COMMAND_LIMIT, windowMs = MESSAGING_COMMAND_WINDOW_MS) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Record one command for the bot and say whether it is within the limit. */
  allow(botId: string, now = Date.now()): boolean {
    const recent = (this.hits.get(botId) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(botId, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(botId, recent);
    return true;
  }

  /** Forget a deleted bot. */
  forget(botId: string): void {
    this.hits.delete(botId);
  }
}

// ── reply text ──────────────────────────────────────────────────────────────

/** Two sentences read as one paragraph only when joined by two spaces. */
export function joinSentences(sentences: readonly string[]): string {
  return sentences.join("  ");
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** The reply to /stop, built from what the stop actually did. */
export function stopReply(effects: { stopped: boolean; clearedQueued: number; cancelledRuns: number }): string {
  const parts: string[] = [];
  if (effects.stopped) parts.push("Stopped.");
  if (effects.clearedQueued > 0) {
    parts.push(`Cleared ${effects.clearedQueued} queued ${plural(effects.clearedQueued, "message", "messages")}.`);
  }
  if (effects.cancelledRuns > 0) {
    parts.push(
      `Cancelled ${effects.cancelledRuns} routine ${plural(effects.cancelledRuns, "run", "runs")}.`,
      "Automatic runs resume after your next message.",
    );
  }
  return parts.length === 0 ? "Nothing was running." : joinSentences(parts);
}

/** The reply to /new.  In Simple mode the old conversation is saved but not
 *  browsable, and the reply says where to find it. */
export function newConversationReply(simpleMode: boolean): string {
  const parts = ["Started a new conversation.", "The old one is saved."];
  if (simpleMode) parts.push("Switch to Projects in Settings to browse saved conversations.");
  return joinSentences(parts);
}

/** 2m 14s, 45s, 1h 3m. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** 84k, 200k, 1M, 950. */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(Math.round(tokens));
}

export interface StatusInput {
  busy: boolean;
  /** when the turn in flight began, in epoch milliseconds, when that is known */
  busySince: number | null;
  /** the channel the bot is working in, when it is busy in a room */
  busyInChannel: string | null;
  now: number;
  /** DescribedInstance.displayName of the configured engine */
  engineName: string;
  /** the catalog option's label */
  modelLabel: string;
  /** null when the model lists no effort levels, so the line is left out;
   *  "default" or a level otherwise */
  effort: string | null;
  /** the last turn's input tokens, and the model's context window */
  contextTokens: number | null;
  contextWindow: number | null;
  /** the conversation's running cost; null when the engine never reports one */
  costUsd: number | null;
  /** the cost is the API-equivalent price of a subscription, not a charge */
  subscription: boolean;
  /** messages waiting behind the running turn */
  queued: number;
  title: string;
}

function stateLine(input: StatusInput): string {
  if (!input.busy) return "Idle";
  if (input.busyInChannel) return `Working in ${input.busyInChannel}`;
  if (input.busySince !== null) return `Working for ${formatDuration(input.now - input.busySince)}`;
  return "Working";
}

function contextLine(input: StatusInput): string {
  const { contextTokens, contextWindow } = input;
  if (contextTokens === null || contextWindow === null || contextWindow <= 0) return "Unknown";
  const percent = Math.round((contextTokens / contextWindow) * 100);
  return `${formatTokenCount(contextTokens)} of ${formatTokenCount(contextWindow)} tokens (${percent}%)`;
}

function spendLine(input: StatusInput): string {
  if (input.costUsd === null) return "Not reported by this engine";
  const amount = `$${input.costUsd.toFixed(2)} this conversation`;
  return input.subscription ? `${amount} (notional, subscription)` : amount;
}

/** The lines /status prints, in order; a line is left out when its rule says so.
 *  Every value is redacted: the task title is whatever the first message was. */
export function statusLines(input: StatusInput): BotCommandReplyLine[] {
  const lines: BotCommandReplyLine[] = [
    { label: "State", value: stateLine(input) },
    { label: "Engine", value: input.engineName },
    { label: "Model", value: input.modelLabel },
  ];
  if (input.effort !== null) {
    lines.push({ label: "Effort", value: input.effort === "default" ? effortLabel(undefined) : effortLabel(effortOf(input.effort)) });
  }
  lines.push({ label: "Context", value: contextLine(input) }, { label: "Spend", value: spendLine(input) });
  if (input.queued > 0) {
    lines.push({ label: "Queue", value: `${input.queued} queued ${plural(input.queued, "message", "messages")}` });
  }
  lines.push({ label: "Conversation", value: input.title });
  return lines.map((line) => ({ label: line.label, value: redactSecretsInText(line.value) }));
}

function effortOf(level: string): Parameters<typeof effortLabel>[0] {
  // SAFETY: effortLabel only reads the string; an unknown level capitalizes
  return level as Parameters<typeof effortLabel>[0];
}

/** The plain text of a list of reply lines.  The state is the one line with no
 *  label, which is how the endpoint's example prints it. */
export function linesToText(lines: readonly BotCommandReplyLine[]): string {
  return lines.map((line) => (line.label === "State" ? line.value : `${line.label}: ${line.value}`)).join("\n");
}

// ── execution ───────────────────────────────────────────────────────────────

export interface CommandEffects {
  stopped: boolean;
  clearedQueued: number;
  cancelledRuns: number;
  newThreadId: string | null;
}

export type CommandOutcome =
  | { ok: true; reply: { title: string; text: string; lines: BotCommandReplyLine[] }; effects: CommandEffects }
  | { ok: false; status: 409; code: Extract<BotCommandErrorCode, "bot_busy" | "already_new">; error: string };

/** What a stop did, as the server reports it. */
export interface StopOutcome {
  /** a live turn was interrupted, or a routine run was cancelled */
  stopped: boolean;
  refused: boolean;
  cancelledRuns: number;
}

/** Everything a command needs from the server, as closures, so the command
 *  logic can be tested without one. */
export interface CommandContext {
  origin: CommandOrigin;
  bot: { id: string; name: string; busy: boolean };
  /** the workspace keeps one conversation per bot, so the old one is hidden */
  simpleMode: boolean;
  /** Stop everything: the live turn, open approvals, routine runs. */
  stop(): Promise<StopOutcome>;
  /** Drop every message waiting behind the running turn; how many. */
  dropQueued(): number;
  /** The active conversation has no messages. */
  conversationIsEmpty(): boolean;
  /** The active conversation's title, when it has one. */
  conversationTitle(): string | undefined;
  /** Start a conversation and make it the bot's active one; null on failure. */
  startConversation(title: string | undefined): { threadId: string } | null;
  status(): StatusInput;
  /** The commands this bot accepts here, label and one-line description. */
  helpLines(): BotCommandReplyLine[];
}

const NO_EFFECTS: CommandEffects = { stopped: false, clearedQueued: 0, cancelledRuns: 0, newThreadId: null };

function reply(title: string, lines: BotCommandReplyLine[], text: string, effects: CommandEffects): CommandOutcome {
  return {
    ok: true,
    reply: {
      title,
      text: redactSecretsInText(text),
      lines: lines.map((line) => ({ label: line.label, value: redactSecretsInText(line.value) })),
    },
    effects,
  };
}

/** Whether a new conversation started from here is the iMessage one: the
 *  command came over iMessage, or the conversation it leaves was. */
export function isImessageConversation(origin: CommandOrigin, currentTitle: string | undefined): boolean {
  return origin === "imessage" || origin === "linq" || currentTitle?.trim().toLowerCase() === IMESSAGE_TASK_TITLE.toLowerCase();
}

async function runStop(ctx: CommandContext): Promise<CommandOutcome> {
  const stopped = await ctx.stop();
  // typed /stop means stop everything: queued corrections go too
  const clearedQueued = ctx.dropQueued();
  const effects: CommandEffects = {
    stopped: stopped.stopped,
    clearedQueued,
    cancelledRuns: stopped.cancelledRuns,
    newThreadId: null,
  };
  const text = stopReply(effects);
  return reply("Stop", [{ label: "Result", value: text }], text, effects);
}

function runNew(ctx: CommandContext): CommandOutcome {
  if (ctx.bot.busy) {
    return { ok: false, status: 409, code: "bot_busy", error: joinSentences(["Still working.", "Send /stop first, then /new."]) };
  }
  if (ctx.conversationIsEmpty()) {
    return { ok: false, status: 409, code: "already_new", error: "This conversation is already empty." };
  }
  const title = isImessageConversation(ctx.origin, ctx.conversationTitle()) ? IMESSAGE_TASK_TITLE : undefined;
  const started = ctx.startConversation(title);
  if (!started) {
    // a bot with no tasks table to add to is a server fault, reported as busy-less refusal
    return { ok: false, status: 409, code: "already_new", error: "This conversation is already empty." };
  }
  const text = newConversationReply(ctx.simpleMode);
  return reply("New Conversation", [{ label: "Result", value: text }], text, { ...NO_EFFECTS, newThreadId: started.threadId });
}

function runStatus(ctx: CommandContext): CommandOutcome {
  const lines = statusLines(ctx.status());
  return reply("Status", lines, linesToText(lines), NO_EFFECTS);
}

function runHelp(ctx: CommandContext): CommandOutcome {
  if (ctx.origin === "imessage" || ctx.origin === "linq") {
    const lines = MESSAGING_HELP_LINES.map((line) => ({ label: "", value: line }));
    return reply("Help", lines, MESSAGING_HELP_LINES.join("\n"), NO_EFFECTS);
  }
  const lines = ctx.helpLines();
  return reply("Help", lines, lines.map((line) => `${line.label}  ${line.value}`).join("\n"), NO_EFFECTS);
}

/** Run one of the four server commands and describe the outcome.  Nothing here
 *  starts a turn: a command is answered, never sent to a model. */
export async function runServerCommand(name: ServerCommandName, ctx: CommandContext): Promise<CommandOutcome> {
  switch (name) {
    case "stop":
      return runStop(ctx);
    case "new":
      return runNew(ctx);
    case "status":
      return runStatus(ctx);
    case "help":
      return runHelp(ctx);
  }
}

/** The reply as the transcript stores it for an iMessage bot: tagged so the
 *  relay sends it, with the same text. */
export function relayReplyText(text: string, tag: string): string {
  return `${tag} ${text}`;
}
