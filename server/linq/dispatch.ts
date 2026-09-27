// Inbound router for Linq webhooks.
//
// The Mac relay already routes `source: "imessage"` through
// `POST /api/bots/{id}/messages`; we follow the same shape so the existing
// prompt handling, typing flag, and tool gating continue to work unchanged
// — a single `ingestInbound()` core keeps the two transports honest.

import type { BotRecord } from "../store.ts";
import { loadConfig } from "../config.ts";
import {
  isImessageInboundSource,
  wrapImessageInbound,
} from "../../shared/imessage-message.ts";
import type { LinqInboundMessage } from "./types.ts";
import {
  linqMarkRead,
  linqStartTyping,
  linqStopTyping,
} from "./client.ts";


export interface ResolvedLinqBinding {
  botNumber: string;
  allowedSenders: string[];
  ignoredSenders: string[];
}

/** Per-bot transport resolution.  Routing turns the operator's UI choice
 *  into a concrete decision:
 *
 *  1. `cfg.botDefaults.imessagePerBot[botId]` — explicit operator choice.
 *  2. absent — the bot stays "off" (no surprise Linq activation).
 *
 *  We surface "linq" only when the workspace has a bot number AND a Linq
 *  API token is available — env var, legacy env var, or the
 *  Infisical-resolved `imessageLinq.apiToken` in the resolved config.
 *  Either missing means the dispatcher logs and ignores.  Tokens are not
 *  stored on disk. */
export function resolveLinqBinding(
  cfg: ReturnType<typeof loadConfig>,
  botId: string,
): ResolvedLinqBinding | null {
  const choice = cfg.botDefaults?.imessagePerBot?.[botId];
  if (choice !== "linq") return null;
  const linqSection = cfg.imessageLinq;
  const envPhone =
    process.env.BOTFLEET_LINQAPP_PHONE_NUMBER?.trim() ||
    process.env.LINQ_AGENT_BOT_NUMBERS?.split(",")[0]?.trim() ||
    "";
  const botNumber = linqSection?.botNumber?.trim() || envPhone;
  if (!botNumber) return null;
  const apiToken =
    process.env.BOTFLEET_LINQAPP_API_KEY?.trim() ||
    process.env.LINQ_API_TOKEN?.trim() ||
    linqSection?.apiToken?.trim();
  if (!apiToken) {
    return null;
  }
  return {
    botNumber,
    allowedSenders: linqSection?.allowedSenders ?? [],
    ignoredSenders: linqSection?.ignoredSenders ?? [],
  };
}

/** Find the bot whose bound phone matched the inbound's destination.  Linq
 *  in hobby tier hands one phone per workspace; bindings map botId → phone
 *  and we reverse-search on the inbound's `toNumber`.  The `bots` list is
 *  injected so the dispatcher remains testable without a Store fixture. */
export function findBotForInbound(
  cfg: ReturnType<typeof loadConfig>,
  bots: BotRecord[],
  msg: LinqInboundMessage,
): { bot: BotRecord; binding: ResolvedLinqBinding } | null {
  const bound: Array<{ bot: BotRecord; binding: ResolvedLinqBinding }> = [];
  for (const bot of bots) {
    const binding = resolveLinqBinding(cfg, bot.id);
    if (binding) bound.push({ bot, binding });
  }
  const wantedNumber = msg.toNumber?.trim();
  if (wantedNumber) {
    const matches = bound.filter((entry) => entry.binding.botNumber === wantedNumber);
    // One workspace number can be claimed by several Linq bots (hobby tier);
    // an explicit `to` that matches more than one is ambiguous — drop the
    // message rather than guess which bot should answer it.
    return matches.length === 1 ? matches[0] : null;
  }
  // `to` is optional on message.received.  With exactly one Linq-bound bot
  // there is only one place the message can go; with several we cannot tell.
  return bound.length === 1 ? bound[0] : null;
}

/** Decide whether to accept this inbound by sender allow/deny lists.  Per-bot
 *  rules merge with workspace-wide rules: when the per-bot allowlist is set
 *  it is authoritative; otherwise the ignore-list filters and the rest pass. */
export function senderAllowed(
  binding: ResolvedLinqBinding,
  fromNumber: string,
): boolean {
  if (binding.allowedSenders.length) {
    return binding.allowedSenders.includes(fromNumber);
  }
  if (binding.ignoredSenders.includes(fromNumber)) return false;
  return true;
}

/** Shared ingest core.  Both transports (Mac relay, Linq) hit `POST
 *  /api/bots/{id}/messages` with their source label; the dispatcher below
 *  is the only place that adds the source-specific behavior (typing,
 *  mark-read, sender policy).  Keeping one function enforces identical
 *  prompt wrapping and payload shape between them and removes the
 *  temptation to fork behavior per transport. */
export async function ingestInbound({
  source,
  bot,
  chatId,
  text,
  media,
  idempotencyKey,
  signal,
}: {
  source: "imessage" | "linq";
  bot: BotRecord;
  chatId: string;
  text?: string;
  media?: string[];
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** True when the messages endpoint answered an idempotent replay: the
   *  delivery was accepted before, no new turn starts. */
}): Promise<{ dispatched: boolean; reason?: string; replayed?: boolean }> {
  if (!text && (!media || media.length === 0)) {
    return { dispatched: false, reason: "empty" };
  }
  // /api/bots/:id/messages requires nonempty text and ignores `media`, so
  // fold attachment URLs into the prompt for media-only and captioned inbound.
  const mediaLines = (media ?? []).filter(Boolean).map((url, i) => `[attachment ${i + 1}] ${url}`);
  const combined = [text?.trim() || (mediaLines.length ? "(media attached)" : ""), ...mediaLines]
    .filter(Boolean)
    .join("\n");
  // Same resolution as server/index.ts's PORT so an OMB_PORT/OGB_PORT
  // override (tests, a second harness) dispatches to the right app server.
  const port = Number(process.env.OMB_PORT || process.env.OGB_PORT || 8799);
  const host = process.env.BOTFLEET_HOST ?? `127.0.0.1:${port}`;
  const url = `http://${host}/api/bots/${bot.id}/messages`;
  const body: Record<string, unknown> = {
    text: wrapImessageInbound(combined),
    source,
    chatId,
  };
  if (media && media.length) body.media = media;
  if (idempotencyKey) body.idempotencyKey = idempotencyKey;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      return { dispatched: false, reason: `http_${res.status}` };
    }
    // An idempotent replay answers 202 with `replayed: true` but starts no
    // new turn — the caller must not treat it like a fresh dispatch.
    const payload = (await res.json().catch(() => ({}))) as { replayed?: unknown };
    return { dispatched: true, replayed: payload?.replayed === true };
  } catch (err) {
    return {
      dispatched: false,
      reason: err instanceof Error ? err.message : "fetch_failed",
    };
  }
}

/** Public entry point for the webhook receiver.  Resolves the bot, enforces
 *  sender policy, marks the chat read, starts a typing indicator, then
 *  delegates to the shared ingest core.  The `bots` list is the actual
 *  store roster (injectable for tests). */
export async function handleLinqInbound(
  msg: LinqInboundMessage,
  bots: BotRecord[],
): Promise<{ dispatched: boolean; reason?: string }> {
  const cfg = loadConfig();
  const bot = findBotForInbound(cfg, bots, msg);
  if (!bot) {
    console.log(
      `[linq] ignoring inbound from ${msg.fromNumber} — no bound bot for chat ${msg.chatId}`,
    );
    return { dispatched: false, reason: "no_bot_for_chat" };
  }
  if (!senderAllowed(bot.binding, msg.fromNumber)) {
    console.log(
      `[linq] ignoring inbound from ${msg.fromNumber} — blocked by allow/deny list`,
    );
    return { dispatched: false, reason: "sender_blocked" };
  }
  void linqMarkRead(msg.chatId).catch(() => undefined);
  // Await start so stop cannot overtake it; leave typing up until outbound
  // delivery (or failure) settles the turn — do not stop on the 202.
  try {
    await linqStartTyping(msg.chatId);
  } catch {
    /* typing is advisory */
  }
  const result = await ingestInbound({
    source: "linq",
    bot: bot.bot,
    chatId: msg.chatId,
    text: msg.text,
    media: msg.media?.map((m) => m.url).filter(Boolean) as string[] | undefined,
    idempotencyKey: msg.messageId,
  });
  if (!result.dispatched) {
    void linqStopTyping(msg.chatId).catch(() => undefined);
  } else if (result.replayed) {
    // Idempotent replay of an already-completed turn: no new turn starts,
    // so turn.completed never fires.  Typing was just (re)started above for
    // a turn that will never run — stop it.
    void linqStopTyping(msg.chatId).catch(() => undefined);
  }
  return result;
}

/** Re-exported so receivers and tests can probe the source predicate. */
export const isLinqInboundSource = (source: unknown): boolean =>
  isImessageInboundSource(source) || source === "linq";
