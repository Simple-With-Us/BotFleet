// Queue-and-steer for busy 1:1 bots.
//
// A message sent to a bot mid-turn used to bounce with a 409. Now it waits
// here until the bot settles, then lands in the thread and runs as ONE
// follow-up turn whose prompt is the queued texts joined with newlines.
//
// The queue is memory-only and is NOT in `messages[]` while the current
// turn is running: appending immediately would make the queued line the
// active leaf, so remaining tool/assistant events of *this* turn would
// hang off a user line the model has not seen. Restart loses the queue
// (same as delegations / approvals). The composer shows a pending chip
// until drain appends the words.
//
// Unlike the delegation drain, an interrupted or failed turn does NOT
// discard this queue: delegations are a bot's fan-out (dropping them on
// Stop is a safety property), but these are the user's own words —
// stop-then-steer (queue a correction, hit Stop, the correction runs) is
// the feature.

import { newId } from "./contracts.ts";
import type { BotRecord, Message } from "./store.ts";

/** The slice of Store this module needs — narrow so tests can fake it. */
export interface SteerStore {
  bot(id: string): BotRecord | null;
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message;
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null;
}

interface QueuedItem {
  messageId: string;
  text: string;
  prompt: string;
  replyToId?: string;
  linqChatId?: string;
  /** Set when the words came from an outside channel (iMessage relay), so
   * the drained turn keeps running unattended (S8). */
  automationSource?: Message["automationSource"];
}

interface QueueEntry {
  /** Kept beside the threadId because the settle that frees the bot can
   * happen on a DIFFERENT thread (a room turn) — drain matches on "this
   * queue's bot is idle now", which needs the bot, not the settling thread. */
  botId: string;
  items: Array<QueuedItem>;
}

const queues = new Map<string, QueueEntry>(); // threadId → waiting sends

/** Hold a mid-turn send off the transcript until drain. */
export function queueSteeredMessage(
  bot: BotRecord,
  text: string,
  options: { prompt?: string; replyToId?: string; linqChatId?: string } = {},
): { id: string } {
  const threadId = bot.threadId;
  const id = newId();
  const entry = queues.get(threadId) ?? { botId: bot.id, items: [] };
  entry.items.push({
    messageId: id,
    text,
    prompt: options.prompt ?? text,
    replyToId: options.replyToId,
    linqChatId: options.linqChatId,
  });
  queues.set(threadId, entry);
  return { id };
}

/** Drain every queue whose bot is idle: append the held lines (leaf is now
 * the finished turn's last item), then one run per thread whose prompt is
 * the texts joined with newlines. `userMessage` is the last appended line
 * so startTurn does not duplicate it; `excludeIds` is every drained line
 * so transcript-replay adapters do not also see earlier queued texts.
 * Entries leave the map BEFORE running so a settle racing another settle
 * can never fire the same queue twice. */
export function drainSteeredMessages(
  store: SteerStore,
  run: (
    botId: string,
    threadId: string,
    prompt: string,
    userMessage: Message,
    excludeIds: string[],
    linqChatId?: string,
  ) => void | Promise<void>,
): void {
  const leftovers: Array<[string, QueueEntry]> = [];
  // deleting only the entry being visited is safe under Map iteration
  for (const [threadId, entry] of queues) {
    const bot = store.bot(entry.botId);
    if (!bot) {
      // the bot was deleted while messages waited — nothing left to steer
      queues.delete(threadId);
      continue;
    }
    if (bot.busy) continue; // still working — the next settle tries again
    // committed to draining: the entry leaves the map before anything runs,
    // so a settle racing another settle can never fire the same queue twice
    queues.delete(threadId);
    const firstLinq = entry.items.findIndex((item) => item.linqChatId);
    const batch = firstLinq === 0
      ? entry.items.slice(0, 1)
      : firstLinq > 0
        ? entry.items.slice(0, firstLinq)
        : entry.items;
    const rest = firstLinq === 0
      ? entry.items.slice(1)
      : firstLinq > 0
        ? entry.items.slice(firstLinq)
        : [];
    // Requeue after this pass so a same-loop Map insert cannot start the
    // next Linq chat before the current startTurn marks the bot busy.
    if (rest.length) leftovers.push([threadId, { botId: entry.botId, items: rest }]);
    const appended: Message[] = [];
    for (const item of batch) {
      // queueId is the pending-chip identity from the 202; append still
      // assigns a fresh transcript id so replay/exclude keep using message.id.
      appended.push(
        store.appendMessage(threadId, {
          role: "user",
          kind: "text",
          text: item.text,
          replyToId: item.replyToId,
          queueId: item.messageId,
          automationSource: item.automationSource,
        }),
      );
    }
    const last = appended.at(-1);
    if (!last) continue;
    const prompt = batch.map((item) => item.prompt).join("\n");
    void run(
      entry.botId,
      threadId,
      prompt,
      last,
      appended.map((message) => message.id),
      batch.length === 1 ? batch[0]?.linqChatId : undefined,
    );
  }
  for (const [threadId, leftover] of leftovers) {
    const existing = queues.get(threadId);
    queues.set(threadId, existing
      ? { botId: leftover.botId, items: [...leftover.items, ...existing.items] }
      : leftover);
  }
}

/** Drop one waiting send so it never drains. Returns false when that
 * queue id was not in the in-memory queue (already drained, or a restart
 * lost the auto-run intent). */
export function cancelSteeredMessage(threadId: string, messageId: string): boolean {
  const entry = queues.get(threadId);
  if (!entry) return false;
  const items = entry.items.filter((item) => item.messageId !== messageId);
  if (items.length === entry.items.length) return false;
  if (items.length === 0) queues.delete(threadId);
  else queues.set(threadId, { botId: entry.botId, items });
  return true;
}

/** Count pending sends without exposing message text to diagnostics. */
export function queuedMessageCount(): number {
  return [...queues.values()].reduce((total, entry) => total + entry.items.length, 0);
}

/** Test helper: how many messages remain queued for a thread. */
export function _queuedCount(threadId: string): number {
  return queues.get(threadId)?.items.length ?? 0;
}

// ── job notices for a running turn (background jobs P1) ─────────────────
// A background job that ends while its bot is mid-turn on the same thread
// cannot start a turn of its own (one turn per bot), and must not wait for
// the turn to end: the bot may be about to start the same work again.  Its
// notice waits here, and the HTTP tool loop drains it between model rounds
// (server/drivers/chat-completions/loop.ts), so the bot reads it before its
// next model call.  A notice the turn never drained is delivered by the next
// turn on the thread: the opening reminder, or a wake turn of its own
// (server/jobs/wake.ts).
//
// Memory-only, like every other queue in this file.  A restart loses it,
// and that is safe: the jobs registry marks every job that was running at a
// restart lost, and queues fresh notices for jobs it settles at boot.

/** One job's end, as the bot reads it. */
export interface JobNoticeItem {
  jobId: string;
  botId: string;
  /** One redacted line: what ended, how, and after how long. */
  text: string;
  /** Whether this notice may wake an idle bot (`onComplete: "wake"`). */
  wake: boolean;
}

const jobNotices = new Map<string, JobNoticeItem[]>(); // threadId → waiting notices

/** Hold a job's notice until a turn on its thread can carry it.  A second
 *  notice for the same job replaces the first. */
export function queueJobNotice(threadId: string, item: JobNoticeItem): void {
  const items = (jobNotices.get(threadId) ?? []).filter((queued) => queued.jobId !== item.jobId);
  items.push(item);
  jobNotices.set(threadId, items);
}

/** Take every notice waiting on this thread.  The caller delivers them. */
export function drainJobNotices(threadId: string): JobNoticeItem[] {
  const items = jobNotices.get(threadId) ?? [];
  jobNotices.delete(threadId);
  return items;
}

/** Put notices back that a dispatch could not deliver (the bot turned out to
 *  be busy, or the harness was reloading), ahead of anything newer. */
export function restoreJobNotices(threadId: string, items: readonly JobNoticeItem[]): void {
  if (items.length === 0) return;
  const newer = (jobNotices.get(threadId) ?? []).filter((queued) => !items.some((item) => item.jobId === queued.jobId));
  jobNotices.set(threadId, [...items, ...newer]);
}

/** The notices waiting on this thread, left in place. */
export function pendingJobNotices(threadId: string): readonly JobNoticeItem[] {
  return jobNotices.get(threadId) ?? [];
}

/** Forget a deleted thread's notices. */
export function dropJobNotices(threadId: string): void {
  jobNotices.delete(threadId);
}

/** Forget a deleted bot's notices on every thread (a room outlives it). */
export function dropJobNoticesForBot(botId: string): void {
  for (const [threadId, items] of jobNotices) {
    const kept = items.filter((item) => item.botId !== botId);
    if (kept.length === 0) jobNotices.delete(threadId);
    else if (kept.length !== items.length) jobNotices.set(threadId, kept);
  }
}
