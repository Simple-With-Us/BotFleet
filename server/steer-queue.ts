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
  messagesFor(threadId: string): Message[];
}

/** A batch already in the transcript: an update committed it for a restart
 *  (server/update-drain.ts) and it waits here again, after the restart or
 *  because the restart did not come.  It drains as a turn of its own, in its
 *  place in line, with nothing appended. */
export interface CommittedBatch {
  /** The last line of the batch; the turn answers it. */
  userMessageId: string;
  /** Every line of the batch, kept out of transcript replay. */
  excludeIds: string[];
  /** Any line came over a relay, so the turn runs unattended (S8). */
  relayed: boolean;
  /** When the update first held it, for the carrier's staleness rule. */
  heldAt: number;
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
  committed?: CommittedBatch;
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
    /** Set for a batch that was already committed (`CommittedBatch`). */
    carried?: CommittedBatch,
  ) => void | Promise<void>,
): void {
  const leftovers: Array<[string, QueueEntry]> = [];
  // One batch per bot per pass.  A bot can have sends waiting on more than
  // one of its threads, and two starts in one pass would leave the second
  // refused as "already working"; the next settle runs the next one.
  const started = new Set<string>();
  // deleting only the entry being visited is safe under Map iteration
  for (const [threadId, entry] of queues) {
    const bot = store.bot(entry.botId);
    if (!bot) {
      // the bot was deleted while messages waited — nothing left to steer
      queues.delete(threadId);
      continue;
    }
    if (bot.busy || started.has(entry.botId)) continue; // still working — the next settle tries again
    // committed to draining: the entry leaves the map before anything runs,
    // so a settle racing another settle can never fire the same queue twice
    queues.delete(threadId);
    let items = entry.items;
    // A batch an update already committed runs alone, as the turn it was.
    // One whose line has gone from the thread has nothing left to answer.
    let carried: { item: QueuedItem; committed: CommittedBatch; userMessage: Message } | null = null;
    while (!carried && items.length > 0) {
      const head = items[0];
      const committed = head?.committed;
      if (!head || !committed) break;
      items = items.slice(1);
      const userMessage = store.messagesFor(threadId).find((message) => message.id === committed.userMessageId);
      if (userMessage) carried = { item: head, committed, userMessage };
    }
    if (carried) {
      if (items.length) leftovers.push([threadId, { botId: entry.botId, items }]);
      started.add(entry.botId);
      const { item, committed, userMessage } = carried;
      void run(entry.botId, threadId, item.prompt, userMessage, committed.excludeIds, item.linqChatId, committed);
      continue;
    }
    if (!items.length) continue;
    const firstLinq = items.findIndex((item) => item.linqChatId);
    // A committed batch further down is a boundary too: it keeps its place.
    const firstCommitted = items.findIndex((item) => item.committed);
    let end = firstLinq === 0 ? 1 : firstLinq > 0 ? firstLinq : items.length;
    if (firstCommitted > 0) end = Math.min(end, firstCommitted);
    const batch = items.slice(0, end);
    const rest = items.slice(end);
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
    started.add(entry.botId);
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

/** One thread's waiting sends, as an update carries them across a restart. */
export interface SteerQueueSnapshot {
  threadId: string;
  botId: string;
  items: Array<{
    messageId: string;
    text: string;
    prompt: string;
    replyToId?: string;
    linqChatId?: string;
    automationSource?: Message["automationSource"];
    committed?: CommittedBatch;
  }>;
}

/** Take the chosen bots' waiting sends out of the queue, untouched: still off
 *  the transcript, so a restart can carry them and put them back in the same
 *  place in line (`restoreSteeredEntries`).  An update uses this for a bot it
 *  interrupted, whose own turn must resume before these run. */
export function takeSteeredEntries(pick: (botId: string) => boolean): SteerQueueSnapshot[] {
  const taken: SteerQueueSnapshot[] = [];
  for (const [threadId, entry] of queues) {
    if (!pick(entry.botId)) continue;
    queues.delete(threadId);
    taken.push({ threadId, botId: entry.botId, items: entry.items.map((item) => ({ ...item })) });
  }
  return taken;
}

/** Put carried sends back, ahead of anything queued on the thread since. */
export function restoreSteeredEntries(entries: readonly SteerQueueSnapshot[]): void {
  for (const entry of entries) {
    if (entry.items.length === 0) continue;
    const existing = queues.get(entry.threadId);
    queues.set(entry.threadId, {
      botId: entry.botId,
      items: [...entry.items.map((item) => ({ ...item })), ...(existing?.items ?? [])],
    });
  }
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
