// Outbound actions: the calls that reach a person outside the app, or move
// money. Sending an email, replying in a thread, posting to a channel,
// publishing, inviting, sharing, refunding, charging. These get their own
// confirmation regardless of approval level, and an optional daily
// allowance per bot, because the cost of one wrong send is paid by someone
// who never saw the bot.
//
// Shared between the harness (which enforces it) and the app (which shows
// the setting), so both agree on what "outbound" means.
//
// Ported from OpenMausBot (MIT), milind-soni/OpenMausBot.

import { z } from "zod";

function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || value === undefined || Array.isArray(value)) return false;
  return Object.prototype.toString.call(value) === "[object Object]";
}

export type OutboundPolicy = {
  /** ask: every outbound call waits for a tap. allow: up to dailyCap a day. */
  policy: "ask" | "allow";
  dailyCap: number;
};

export const OUTBOUND_DEFAULT_CAP = 25;
const OUTBOUND_MAX_CAP = 1_000;

/** Tools whose action is one of these words send something somewhere. */
const SEND_VERBS = new Set([
  "SEND",
  "SENDS",
  "REPLY",
  "RESPOND",
  "FORWARD",
  "POST",
  "PUBLISH",
  "TWEET",
  "RETWEET",
  "BROADCAST",
  "INVITE",
  "SHARE",
  "REFUND",
  "CHARGE",
  "PAY",
  "PAYOUT",
  "TRANSFER",
]);

/** Creating one of these is sending it: a created comment is a comment
 * someone reads, a created invoice is one someone receives. */
const CREATE_VERBS = new Set(["CREATE", "CREATION", "ADD", "NEW"]);
const SENT_NOUNS = new Set(["MESSAGE", "COMMENT", "POST", "EMAIL", "MAIL", "INVOICE", "PAYMENT", "REFUND", "REPLY", "TWEET", "DM"]);

/** A read verb first means the rest of the name is what is being read:
 * REDDIT_GET_POST fetches a post, it does not post. */
const READ_VERBS = new Set(["GET", "LIST", "FETCH", "SEARCH", "READ", "FIND", "RETRIEVE", "LOOKUP", "DOWNLOAD", "VIEW", "CHECK", "COUNT"]);

/** The action part of a tool name, as upper-case word tokens. Composio's
 * TOOLKIT_ACTION drops its toolkit; an MCP server's mcp__server__action
 * drops its server; a bare built-in like Bash stays as it is. */
function actionTokens(name: string): string[] {
  let action = name;
  if (name.startsWith("mcp__")) {
    const [, server = "", ...rest] = name.split("__");
    action = rest.join("_");
    if (server === "composio") return actionTokens(action);
  } else if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(name)) {
    action = name.slice(name.indexOf("_") + 1);
  }
  return action
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/** Does the tool name describe a read-only action? This is deliberately
 * narrower than "not outbound": updates, deletes and other writes do not
 * become reads merely because they send nothing to another person. */
export function isReadOnlyTool(name: string): boolean {
  const tokens = actionTokens(name);
  return tokens.length > 0 && READ_VERBS.has(tokens[0]);
}

/** Does this tool send something to someone, or move money? */
export function isOutboundTool(name: string): boolean {
  // A raw API call from the workbench can do anything an app tool can, and
  // nothing here can read which; it is treated as a send.
  if (name === "COMPOSIO_PROXY_EXECUTE") return true;
  const tokens = actionTokens(name);
  if (tokens.length === 0) return false;
  if (isReadOnlyTool(name)) return false;
  if (tokens.some((token) => SEND_VERBS.has(token))) return true;
  if (tokens.includes("DRAFT")) return false;
  return tokens.some((token) => CREATE_VERBS.has(token)) && tokens.some((token) => SENT_NOUNS.has(token));
}

const outboundPolicySchema = z.object({
  policy: z.enum(["ask", "allow"]),
  dailyCap: z.number().int().min(1).max(OUTBOUND_MAX_CAP).optional(),
});

/** The stored shape, or null when the value is not one. */
export function normalizeOutboundPolicy(value: unknown): OutboundPolicy | null {
  if (!isJsonObject(value)) return null;
  const parsed = outboundPolicySchema.safeParse(value);
  if (!parsed.success) return null;
  const dailyCap = parsed.data.dailyCap ?? OUTBOUND_DEFAULT_CAP;
  return { policy: parsed.data.policy, dailyCap };
}

/** What a bot without a stored policy does: ask, every time. */
export const DEFAULT_OUTBOUND_POLICY: OutboundPolicy = { policy: "ask", dailyCap: OUTBOUND_DEFAULT_CAP };

/** One app tool a connector request would run, with its arguments when the
 * request carries them. */
export interface ConnectorCall {
  slug: string;
  arguments?: unknown;
}

function connectorCall(slug: string, args?: unknown): ConnectorCall {
  if (args === undefined) return { slug };
  return { slug, arguments: args };
}

/** Composio's session exposes a handful of meta tools and runs the app
 * tools inside them: a multi-execute call carries a list of slugs with
 * arguments. Arbitrary workbench/bash code is opaque: it requires an
 * explicit unrestricted approval, never an inferred app or send count.
 * Search, schema lookup, and connection management run no app tools. */
export function connectorCallsIn(name: string, args: unknown): ConnectorCall[] {
  if (name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    const tools = isJsonObject(args) && Array.isArray(args.tools) ? args.tools
      : isJsonObject(args) && "tool_slug" in args && isJsonObject(args) ? [args] : [];
    if (!tools.length) return [connectorCall("COMPOSIO_PROXY_EXECUTE", args)];
    const calls: ConnectorCall[] = [];
    for (const item of tools) {
      if (!isJsonObject(item)) return [connectorCall("COMPOSIO_PROXY_EXECUTE", args)];
      const slug = [item.tool_slug, item.slug, item.name, item.tool].find(
        (value): value is string | number | boolean => !isJsonObject(value) && value !== null && value !== undefined,
      );
      if (slug === undefined) {
        return [connectorCall("COMPOSIO_PROXY_EXECUTE", args)];
      }
      const slugText = String(slug);
      calls.push(item.arguments !== undefined ? connectorCall(slugText, item.arguments) : connectorCall(slugText));
    }
    return calls;
  }
  if (name === "COMPOSIO_REMOTE_WORKBENCH" || name === "COMPOSIO_REMOTE_BASH_TOOL") {
    return [connectorCall("COMPOSIO_PROXY_EXECUTE", args)];
  }
  if (["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_MANAGE_CONNECTIONS", "COMPOSIO_WAIT_FOR_CONNECTIONS"].includes(name)) {
    return [];
  }
  if (name.startsWith("COMPOSIO_")) return [connectorCall("COMPOSIO_PROXY_EXECUTE", args)];
  return [connectorCall(name, args)];
}

/** The subset of a request's app tools that would send something. */
export function outboundCallsIn(name: string, args: unknown): ConnectorCall[] {
  return connectorCallsIn(name, args).filter((call) => isOutboundTool(call.slug));
}
