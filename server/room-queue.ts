// A room round that arrives while its bot is busy elsewhere.
//
// One turn per bot at a time is a hard rule — two provider processes for one
// bot means interleaved token spend and an interrupt that reaches only one of
// them.  But the rule was enforced by *dropping* the round: the room got
// "Director is busy in another conversation — skipped this round" and the
// work was simply gone.  A person watching a channel reads that as the bot
// refusing, and the only recovery is to say it again.
//
// So a busy bot's round waits here instead, and runs when the bot settles.
// The same shape as `steer-queue.ts`, with the differences a room forces:
//
//   - keyed by (thread, bot), because two members of one room can be waiting
//     on two different bots at the same time;
//   - one entry per key, because a round is a request to speak, not a
//     message to deliver — asking twice does not mean speaking twice;
//   - bounded and dated, because a bot that never frees up must not grow a
//     queue forever, and a round nobody remembers asking for should not
//     surface an hour later.

import type { ModelSelection } from "./contracts.ts";
import type { GroupRecord } from "./store.ts";

export interface RoomRound {
  groupId: string;
  threadId: string;
  botId: string;
  /** comms depth this round was dispatched at; a resumed round keeps it so
   * bot⇄bot chains still terminate */
  hop: number;
  /** the card answer this round was continuing, if any */
  cardContinuation?: string;
  /** the exact engine/fallback selection chosen for this turn */
  turnSelection?: ModelSelection;
  /** when it was queued, for the staleness cutoff */
  at: number;
}

/** How long a waiting round stays worth running.
 *
 * Long enough to cover a normal turn — including a slow one behind a
 * provider retry — and short enough that a bot stuck for an hour does not
 * suddenly speak into a conversation that has moved on. */
export const ROOM_QUEUE_TTL_MS = 15 * 60 * 1000;

/** A backstop, not a design limit: one entry per (thread, bot) already bounds
 * this by the fleet's size.  If something ever loops, it stops here. */
export const ROOM_QUEUE_MAX = 200;

const queues = new Map<string, RoomRound>();

const keyFor = (threadId: string, botId: string) => `${threadId}\0${botId}`;

/** Remember a round to run when this bot is free.
 *
 * Returns false when one is already waiting for the same bot in the same
 * thread: a round is a request to speak, and two identical requests are one.
 */
export function queueRoomRound(round: Omit<RoomRound, "at">, now: number): boolean {
  const key = keyFor(round.threadId, round.botId);
  if (queues.has(key)) return false;
  if (queues.size >= ROOM_QUEUE_MAX) return false;
  queues.set(key, { ...round, at: now });
  return true;
}

/** Drop a waiting round — the room was interrupted, or the task went away. */
export function cancelRoomRounds(predicate: (round: RoomRound) => boolean): number {
  let dropped = 0;
  for (const [key, round] of queues) {
    if (!predicate(round)) continue;
    queues.delete(key);
    dropped += 1;
  }
  return dropped;
}

export interface RoomQueueStore {
  bot(botId: string): { id: string; busy?: boolean } | null | undefined;
  group(groupId: string): GroupRecord | null | undefined;
}

/** Run every waiting round whose bot is now idle.
 *
 * Committed-before-running, like the steer queue: the entry leaves the map
 * before `run` is called, so two settles racing each other cannot fire the
 * same round twice.  Stale and orphaned entries are swept on the way past —
 * this runs on every turn completion, so there is no separate timer. */
export function drainRoomRounds(
  store: RoomQueueStore,
  now: number,
  run: (round: RoomRound) => void | Promise<void>,
): void {
  for (const [key, round] of queues) {
    if (now - round.at > ROOM_QUEUE_TTL_MS) {
      queues.delete(key);
      continue;
    }
    const bot = store.bot(round.botId);
    if (!bot || !store.group(round.groupId)) {
      // the bot or the room was deleted while the round waited
      queues.delete(key);
      continue;
    }
    if (bot.busy) continue; // still working — the next settle tries again
    queues.delete(key);
    void run(round);
  }
}

/** Test seam: how many rounds are waiting. */
export function _queuedRoomCount(): number {
  return queues.size;
}

/** Whether the exact bot/thread round is still retained.  Runtime readiness
 * uses this to avoid counting stale credential-wait bookkeeping after a
 * cancelled, expired, or orphaned room round. */
export function hasQueuedRoomRound(threadId: string, botId: string): boolean {
  return queues.has(keyFor(threadId, botId));
}

/** Test seam: forget everything. */
export function _resetRoomQueue(): void {
  queues.clear();
}
