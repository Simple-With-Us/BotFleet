// Outbound Linq delivery for completed bot turns.
//
// The Mac relay polls messages.db for `[to iMessage]` replies.  Linq has no
// local chat.db, so the harness must push those tagged replies through the
// partner API.  We reuse `outboundImessageText` — the same gate the relay
// uses — and keep chatId correlation here so dispatch/index stay thin.
//
// Bindings are turn-scoped.  A second inbound on a busy bot must not
// retarget the in-flight turn's first reply (content leak).  Queued
// inbounds keep their own chat id until drain starts that turn.

import { outboundImessageText } from "../../shared/imessage-message.ts";
import { linqSendMessage, linqStopTyping } from "./client.ts";
import { loadConfig } from "../config.ts";

export interface LinqChatBinding {
  chatId: string;
  botId: string;
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

function pendingTurnId(threadId: string): string {
  return `pending:${threadId}`;
}

/** `${threadId}:${turnId}` → the inbound chat that started that turn. */
const chatByTurn = new Map<string, LinqChatBinding>();
/** threadId → the turn currently speaking on it (1:1 Linq bots). */
const currentTurnByThread = new Map<string, string>();

export function bindLinqChatToTurn(
  threadId: string,
  turnId: string,
  botId: string,
  chatId: string,
): void {
  const pendingId = pendingTurnId(threadId);
  chatByTurn.set(turnKey(threadId, turnId), { chatId, botId });
  // Migrating pending → provider turnId must not leave the placeholder
  // around for a later peek/release on this thread.
  if (turnId !== pendingId) chatByTurn.delete(turnKey(threadId, pendingId));
  currentTurnByThread.set(threadId, turnId);
}

/** Bind a chat to a turn that has not been assigned a provider turnId yet
 *  (startTurn before sendTurn returns, and tests).  Overwriting an
 *  in-flight turn's chat is refused — callers must bind a new turn id. */
export function rememberLinqChat(threadId: string, botId: string, chatId: string, turnId?: string): void {
  const id = turnId ?? currentTurnByThread.get(threadId);
  if (id) {
    const existing = chatByTurn.get(turnKey(threadId, id));
    if (existing && existing.chatId !== chatId) return;
  }
  bindLinqChatToTurn(threadId, turnId ?? pendingTurnId(threadId), botId, chatId);
}

export function peekLinqChat(threadId: string, turnId?: string): LinqChatBinding | undefined {
  if (turnId) {
    const exact = chatByTurn.get(turnKey(threadId, turnId));
    if (exact) return exact;
  }
  const currentId = currentTurnByThread.get(threadId);
  if (!currentId) return undefined;
  // Events can carry the provider turnId before startTurn has migrated the
  // pending placeholder onto that id.
  if (!turnId || currentId === pendingTurnId(threadId)) {
    return chatByTurn.get(turnKey(threadId, currentId));
  }
  return undefined;
}

export function releaseLinqChat(threadId: string, turnId?: string): void {
  const pendingId = pendingTurnId(threadId);
  const currentId = currentTurnByThread.get(threadId);
  if (turnId) chatByTurn.delete(turnKey(threadId, turnId));
  // A turn that settles during sendTurn still has only the pending key.
  // 1:1 bots queue the next inbound, so this cannot drop a later launch.
  if (!turnId || currentId === turnId || currentId === pendingId) {
    chatByTurn.delete(turnKey(threadId, pendingId));
    if (currentId && (currentId === turnId || currentId === pendingId || !turnId)) {
      currentTurnByThread.delete(threadId);
    }
  }
}

/** Test helper: drop in-memory bindings so cases cannot leak across tests. */
export function _resetLinqChatBindingsForTests(): void {
  chatByTurn.clear();
  currentTurnByThread.clear();
}

/** Stop the typing indicator for a remembered chat (best-effort). */
export async function stopLinqTypingForThread(threadId: string, turnId?: string): Promise<void> {
  const binding = peekLinqChat(threadId, turnId);
  if (!binding) return;
  try {
    await linqStopTyping(binding.chatId);
  } catch {
    /* typing is advisory */
  }
}

/** If this bot text is a `[to iMessage]` reply for a Linq-origin turn,
 *  send it through the partner API. */
export async function deliverLinqOutboundIfNeeded(
  threadId: string,
  botId: string,
  text: string,
  turnId?: string,
): Promise<{ sent: boolean; reason?: string }> {
  const binding = peekLinqChat(threadId, turnId);
  if (!binding || binding.botId !== botId) {
    return { sent: false, reason: "no_linq_chat" };
  }
  const cfg = loadConfig();
  if (cfg.botDefaults?.imessagePerBot?.[botId] !== "linq") {
    return { sent: false, reason: "bot_not_linq" };
  }
  const outbound = outboundImessageText(text);
  if (!outbound) return { sent: false, reason: "not_tagged" };
  try {
    await linqSendMessage(binding.chatId, { text: outbound });
    await linqStopTyping(binding.chatId).catch(() => undefined);
    return { sent: true };
  } catch (err) {
    await linqStopTyping(binding.chatId).catch(() => undefined);
    return {
      sent: false,
      reason: err instanceof Error ? err.message : "send_failed",
    };
  }
}
