/**
 * Room Attention Index (Aggregation of Bot-Global Activity)
 *
 * Implements the typed attention index specified in
 * docs/architecture/per-room-attention-index.md.
 *
 * Note on Scope:
 * Each bot currently has a single global activity state (server/store.ts).
 * This module computes a per-room AGGREGATION of bot-global states for
 * bots explicitly assigned to each room via `group.memberIds`.
 * Per-(bot, room) activity tracking remains a planned future enhancement (#815).
 *
 * Invariants:
 * - Room membership is strictly determined by explicit `group.memberIds`.
 * - Do not infer membership from mutable section labels, names, or cwd similarity.
 *
 * Four distinct, un-summed badges per room:
 * - Errors:       durable failures and dead bots.
 * - Needs Action: waiting-on-you (permissions / questions open).
 * - Working:      turns currently in flight.
 * - Unread:       unread room and member responses.
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
    /** Room chat (when unread) plus each unread member bot.  Per room. */
    count: number;
    hasUnread: boolean;
    /** The room chat's own unread flag (`group.unread`). */
    roomUnread: boolean;
    /** Member bots whose own 1:1 thread is unread.  That flag belongs to the
     * bot, so every room the bot is in lists it. */
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
}

/**
 * Computes per-room attention state for all non-DM groups across the fleet.
 */
export function computeRoomAttentionIndex(
  groups: readonly MinimalGroup[],
  bots: readonly MinimalBot[],
): RoomAttention[] {
  const activeBots = bots.filter((b) => !b.hidden);
  const botMap = new Map(activeBots.map((b) => [b.id, b]));

  return groups
    .filter((g) => !g.dm)
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

      // 2. Needs Action: waiting-on-you (prompts, permissions, confirmation)
      const needsActionBots: AttentionParticipant[] = assignedBots
        .filter((b) => b.activity === "waiting-on-you")
        .map((b) => ({
          botId: b.id,
          botName: b.name,
          avatarUrl: b.avatarUrl,
          reason: "Awaiting permission or response",
        }));

      // 3. Working: turns currently in-flight
      const workingBots: AttentionParticipant[] = assignedBots
        .filter((b) => b.activity === "working" || group.busyBotId === b.id)
        .map((b) => ({
          botId: b.id,
          botName: b.name,
          avatarUrl: b.avatarUrl,
          reason: "Turn in flight",
        }));

      // 4. Unread: room unread state plus assigned bot unread flags
      const unreadBots: AttentionParticipant[] = assignedBots
        .filter((b) => b.unread)
        .map((b) => ({
          botId: b.id,
          botName: b.name,
          avatarUrl: b.avatarUrl,
        }));
      const roomUnread = Boolean(group.unread);
      const unreadCount = (roomUnread ? 1 : 0) + unreadBots.length;
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
 * A bot has one global activity and one unread flag, and every room it belongs
 * to copies them, so the room counts overlap.  Summing them multiplied one
 * working bot by its room count.  The totals here count each bot once per
 * state, matched by `botId` (a bot that is working through `busyBotId` in one
 * room and through its global activity in another is still one), and each
 * unread room chat once.  The `rooms*` fields stay per room: how many rooms
 * are affected.
 */
export function summarizeFleetAttention(
  attentionList: readonly RoomAttention[],
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
