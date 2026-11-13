/**
 * Room Attention Index (Aggregation of Bot-Global Activity)
 *
 * Implements the typed attention index specified in
 * docs/architecture/per-room-attention-index.md.
 *
 * Note on Scope:
 * Each bot currently has a single global activity state (server/store.ts).
 * This module attributes that state to rooms through threads, for bots
 * explicitly assigned to each room via `group.memberIds`. A wait counts in
 * the room that owns the thread holding the open card
 * (`bot.waitingThreadId`, set alongside the activity); a turn counts in the
 * room that owns the provider process (`group.busyBotId`) or the live turn
 * thread. Full per-(bot, room) activity tracking remains a planned future
 * enhancement (#815).
 *
 * Invariants:
 * - Room membership is strictly determined by explicit `group.memberIds`.
 * - Do not infer membership from mutable section labels, names, or cwd similarity.
 * - A badge on a room means something is happening IN that room. Global
 *   state with no thread in the room counts nowhere at room altitude.
 *
 * Four distinct, un-summed badges per room:
 * - Errors:       durable failures and dead bots.
 * - Needs Action: waiting-on-you on a thread this room owns.
 * - Working:      a turn this room owns (provider process or live thread).
 * - Unread:       the room chat only. Member 1:1 unread feeds the fleet
 *   rollup, never a room count.
 *
 * Fleet rollup (`summarizeFleetAttention`):
 * Because a bot's state is global, a bot that belongs to N rooms is listed by
 * N room indexes.  The rollup counts each bot once per state, and each unread
 * conversation once, because the per-room counts overlap and cannot be added.
 */

export interface AttentionParticipant {
  botId: string;
  botName: string;
  avatarUrl?: string | null;
  reason?: string;
}

export interface RoomAttention {
  roomId: string;
  roomName: string;
  section?: string | null;
  cwd?: string | null;
  memberIds: string[];
  errors: {
    count: number;
    bots: AttentionParticipant[];
  };
  needsAction: {
    count: number;
    bots: AttentionParticipant[];
  };
  working: {
    count: number;
    bots: AttentionParticipant[];
  };
  unread: {
    /** The room chat only: 1 when `roomUnread`, else 0.  Member 1:1 unread
     * never inflates a room count. */
    count: number;
    hasUnread: boolean;
    /** The room chat's own unread flag (`group.unread`). */
    roomUnread: boolean;
    /** Member bots whose own 1:1 thread is unread.  Listed for the fleet
     * rollup (each unread bot counts once there), not for the room. */
    bots: AttentionParticipant[];
  };
}

export interface AttentionSummaryRollup {
  totalRooms: number;
  /** Rooms with at least one bot in the state.  Each room counts once. */
  roomsWithErrors: number;
  roomsNeedingAction: number;
  roomsWorking: number;
  roomsWithUnread: number;
  /** Distinct bots in the state anywhere in the fleet.  A bot that belongs to
   * several rooms counts once. */
  totalErrors: number;
  totalNeedsAction: number;
  totalWorking: number;
  /** Distinct unread conversations: each unread room chat once, plus each
   * unread member bot once.  The same unit as `unreadConversationCount`,
   * limited to rooms and the bots in them. */
  totalUnread: number;
}

export interface AttentionMessage {
  id?: string;
  parentId?: string | null;
  kind: string;
  tool?: { name: string };
}

export interface MinimalBot {
  id: string;
  name: string;
  avatarUrl?: string | null;
  section?: string | null;
  activity?: "working" | "waiting-on-you" | "idle" | "no-signal" | "dead";
  unread?: boolean;
  hidden?: boolean;
  hasError?: boolean;
  errorReason?: string;
  /** Leaf of the visible branch.  Absent falls back to the flat list. */
  activeLeafId?: string | null;
  messages?: readonly AttentionMessage[];
  /** The bot's own 1:1 thread.  Never a room thread. */
  threadId?: string | null;
  /** The turn currently dispatched, if any.  A room turn points at the
   * room's thread; a 1:1 turn points at the bot's own thread. */
  inflightThreadId?: string | null;
  /** The thread holding the bot's open approval or question while activity
   * is waiting-on-you.  Set alongside the activity by the server; a wait
   * with no thread belongs to no room. */
  waitingThreadId?: string | null;
}

/** One id index per messages-array identity.  Rooms that share a bot, and
 * the error check plus its reason, must not scan that transcript again. */
const attentionMessageIndex = new WeakMap<
  readonly AttentionMessage[],
  Map<string, AttentionMessage>
>();

function indexAttentionMessages<T extends AttentionMessage>(
  messages: readonly T[],
): Map<string, T> {
  const cached = attentionMessageIndex.get(messages);
  if (cached) return cached as Map<string, T>;
  const byId = new Map<string, T>();
  for (const message of messages) {
    if (message.id) byId.set(message.id, message);
  }
  attentionMessageIndex.set(messages, byId);
  return byId;
}

/** Visible tail for turn-error checks.  When the leaf id is in the index,
 * that message is the tail: the old parent walk pushed it first and then
 * reversed, so `.at(-1)` was always the leaf.  A cycle break cannot change
 * that, and a missing leaf still falls back to the flat last message. */
function visibleAttentionTail<T extends AttentionMessage>(
  messages: readonly T[] | undefined,
  activeLeafId: string | null | undefined,
): T | undefined {
  if (!messages || messages.length === 0) return undefined;
  if (!activeLeafId) return messages.at(-1);
  return indexAttentionMessages(messages).get(activeLeafId) ?? messages.at(-1);
}

function messageIsTurnError(message: AttentionMessage | undefined): boolean {
  return message?.kind === "activity" && Boolean(message.tool?.name.startsWith("error:"));
}

export function isBotTurnError(bot: {
  activeLeafId?: string | null;
  messages?: readonly AttentionMessage[];
}): boolean {
  return messageIsTurnError(visibleAttentionTail(bot.messages, bot.activeLeafId));
}

export interface MinimalGroup {
  id: string;
  name: string;
  section?: string | null;
  memberIds: string[];
  unread: boolean;
  dm?: boolean;
  busyBotId?: string | null;
  cwd?: string | null;
  /** The room's shared thread.  A wait or turn on this thread (or one of
   * the task threads) is what puts a badge on THIS room. */
  threadId: string;
  /** The room's independent conversations (DMs omit the collection). */
  tasks?: readonly { threadId: string }[];
}

/**
 * Computes per-room attention state for all non-DM groups across the fleet.
 *
 * A bot's activity is global, but a badge on a room must mean something is
 * happening IN that room. Waiting and working are therefore attributed
 * through threads: the wait counts only in the room that owns the thread
 * holding the open approval or question, and a turn counts only in the
 * room that owns the provider process (busyBotId) or the live turn thread.
 * A 1:1 wait or turn belongs to no room, so no room chip claims it — the
 * bot's own thread and status still show it. Unread on a room is the room
 * chat only; member bots' 1:1 unread feeds the fleet rollup, not rooms.
 */
export function computeRoomAttentionIndex(
  groups: readonly MinimalGroup[],
  bots: readonly MinimalBot[],
): RoomAttention[] {
  const activeBots = bots.filter((b) => !b.hidden);
  const botMap = new Map(activeBots.map((b) => [b.id, b]));
  const rooms = groups.filter((g) => !g.dm);

  // Thread -> room, mirroring the server's groupByThread: a room owns its
  // shared thread plus each task thread. A thread that maps nowhere (a
  // bot's 1:1 thread, a DM thread) belongs to no room.
  const threadRoom = new Map<string, string>();
  for (const room of rooms) {
    threadRoom.set(room.threadId, room.id);
    for (const task of room.tasks ?? []) threadRoom.set(task.threadId, room.id);
  }
  const roomOfThread = (threadId?: string | null): string | undefined =>
    threadId ? threadRoom.get(threadId) : undefined;

  // busyBotId names the speaker that owns the provider process in a room.
  // A bot it names anywhere is claimed: no other room may count that bot
  // as working through the global activity.
  const claimedByRoom = new Map<string, string>();
  for (const room of rooms) {
    if (room.busyBotId) claimedByRoom.set(room.busyBotId, room.id);
  }

  return rooms
    .map((group) => {
      // Membership invariant: Strictly use explicit memberIds.
      // Mutable section labels and cwd similarity must never infer membership.
      const memberSet = new Set<string>(group.memberIds || []);

      const assignedBots = Array.from(memberSet)
        .map((id) => botMap.get(id))
        .filter((b): b is MinimalBot => Boolean(b));

      // 1. Errors: dead activity or terminal unresolved failures.
      // The visible tail is one leaf lookup, reused for the check and the reason.
      const errorBots: AttentionParticipant[] = [];
      for (const b of assignedBots) {
        const visibleTail = visibleAttentionTail(b.messages, b.activeLeafId);
        const turnError = messageIsTurnError(visibleTail);
        if (b.activity !== "dead" && !b.hasError && !turnError) continue;
        const errorDetail = turnError
          ? visibleTail?.tool?.name.slice(6).trim()
          : undefined;
        errorBots.push({
          botId: b.id,
          botName: b.name,
          avatarUrl: b.avatarUrl,
          reason:
            b.errorReason ||
            (b.activity === "dead"
              ? "Process terminated"
              : errorDetail
                ? `Turn error: ${errorDetail}`
                : "Active error"),
        });
      }

      // 2. Needs Action: waiting-on-you, in the room that owns the thread
      // holding the open card. A wait with no attributed thread (or one
      // outside every room) counts nowhere: it is real, but it is not
      // waiting in this room.
      const needsActionBots: AttentionParticipant[] = assignedBots
        .filter((b) => b.activity === "waiting-on-you" && roomOfThread(b.waitingThreadId) === group.id)
        .map((b) => ({
          botId: b.id,
          botName: b.name,
          avatarUrl: b.avatarUrl,
          reason: "Awaiting permission or response",
        }));

      // 3. Working: the room that owns the provider process, else the room
      // that owns the live turn thread. A 1:1 turn touches no room.
      const workingBots: AttentionParticipant[] = assignedBots
        .filter((b) => {
          if (group.busyBotId === b.id) return true;
          if (b.activity !== "working") return false;
          if (claimedByRoom.has(b.id)) return false;
          const liveThread = b.inflightThreadId ?? b.threadId ?? undefined;
          return roomOfThread(liveThread) === group.id;
        })
        .map((b) => ({
          botId: b.id,
          botName: b.name,
          avatarUrl: b.avatarUrl,
          reason: "Turn in flight",
        }));

      // 4. Unread: the room chat only. Member bots' 1:1 unread is still
      // listed (the fleet rollup counts each unread bot once) but it no
      // longer inflates rooms whose own chat has nothing unread.
      const unreadBots: AttentionParticipant[] = assignedBots
        .filter((b) => b.unread)
        .map((b) => ({
          botId: b.id,
          botName: b.name,
          avatarUrl: b.avatarUrl,
        }));
      const roomUnread = Boolean(group.unread);
      const unreadCount = roomUnread ? 1 : 0;
      const hasUnread = unreadCount > 0;

      return {
        roomId: group.id,
        roomName: group.name,
        section: group.section ?? null,
        cwd: group.cwd ?? null,
        memberIds: assignedBots.map((b) => b.id),
        errors: {
          count: errorBots.length,
          bots: errorBots,
        },
        needsAction: {
          count: needsActionBots.length,
          bots: needsActionBots,
        },
        working: {
          count: workingBots.length,
          bots: workingBots,
        },
        unread: {
          count: unreadCount,
          hasUnread,
          roomUnread,
          bots: unreadBots,
        },
      };
    });
}

/**
 * Summarizes fleet-wide room attention numbers for higher-level rollups and badges.
 *
 * Room counts no longer overlap for waits, turns, or unread: each wait and
 * each turn is attributed to at most one room through its thread, and each
 * room's unread is its own chat.  Errors still overlap (a dead bot is dead
 * in every room it belongs to), so the totals here count each bot once per
 * state, matched by `botId`, and each unread room chat once.  The `rooms*`
 * fields stay per room: how many rooms are affected.  Callers pass the
 * fleet bots so a wait or turn that owns no room (a 1:1, or one the server
 * never attributed) still counts once in the totals.
 */
export function summarizeFleetAttention(
  attentionList: readonly RoomAttention[],
  bots?: readonly MinimalBot[],
): AttentionSummaryRollup {
  let roomsWithErrors = 0;
  let roomsNeedingAction = 0;
  let roomsWorking = 0;
  let roomsWithUnread = 0;
  let unreadRoomChats = 0;
  const errorBotIds = new Set<string>();
  const needsActionBotIds = new Set<string>();
  const workingBotIds = new Set<string>();
  const unreadBotIds = new Set<string>();

  for (const item of attentionList) {
    if (item.errors.count > 0) roomsWithErrors += 1;
    if (item.needsAction.count > 0) roomsNeedingAction += 1;
    if (item.working.count > 0) roomsWorking += 1;
    if (item.unread.hasUnread) roomsWithUnread += 1;
    if (item.unread.roomUnread) unreadRoomChats += 1;

    for (const bot of item.errors.bots) errorBotIds.add(bot.botId);
    for (const bot of item.needsAction.bots) needsActionBotIds.add(bot.botId);
    for (const bot of item.working.bots) workingBotIds.add(bot.botId);
    for (const bot of item.unread.bots) unreadBotIds.add(bot.botId);
  }

  // Room attribution drives the room badges, but a wait or turn on a
  // thread no room owns (a 1:1, or one the server never attributed) lands
  // in no room list.  The fleet totals are distinct bots in the state
  // anywhere in the fleet, so union the direct activity states in.
  for (const bot of bots ?? []) {
    if (bot.hidden) continue;
    if (bot.activity === "waiting-on-you") needsActionBotIds.add(bot.id);
    if (bot.activity === "working") workingBotIds.add(bot.id);
  }

  return {
    totalRooms: attentionList.length,
    roomsWithErrors,
    roomsNeedingAction,
    roomsWorking,
    roomsWithUnread,
    totalErrors: errorBotIds.size,
    totalNeedsAction: needsActionBotIds.size,
    totalWorking: workingBotIds.size,
    totalUnread: unreadRoomChats + unreadBotIds.size,
  };
}
