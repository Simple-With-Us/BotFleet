import { describe, expect, it } from "vitest";
import {
  computeRoomAttentionIndex,
  isBotTurnError,
  summarizeFleetAttention,
  type MinimalBot,
  type MinimalGroup,
} from "./attention-index";

describe("computeRoomAttentionIndex", () => {
  it("ignores dm channels and computes attention metrics for real groups", () => {
    const groups: MinimalGroup[] = [
      {
        id: "dm-1",
        name: "Bot1 ⇄ Bot2",
        dm: true,
        memberIds: ["bot-1", "bot-2"],
        unread: true,
        threadId: "thread-dm-1",
      },
      {
        id: "group-bf",
        name: "BotFleet",
        section: "Core",
        memberIds: ["bot-1", "bot-2"],
        unread: false,
        cwd: "/Users/jay/Code/BotFleet",
        threadId: "thread-bf",
      },
      {
        id: "group-st",
        name: "Socratic.Trade",
        section: "Trading",
        memberIds: ["bot-3"],
        unread: true,
        cwd: "/Users/jay/Code/Socratic.Trade",
        threadId: "thread-st",
      },
    ];

    const bots: MinimalBot[] = [
      {
        id: "bot-1",
        name: "Architect",
        activity: "working",
        unread: false,
        // Turn runs on the BotFleet room thread.
        inflightThreadId: "thread-bf",
      },
      {
        id: "bot-2",
        name: "Fixer",
        activity: "waiting-on-you",
        unread: true,
        // Open card sits on the BotFleet room thread.
        waitingThreadId: "thread-bf",
      },
      {
        id: "bot-3",
        name: "Scout",
        activity: "dead",
        unread: false,
      },
      {
        id: "bot-hidden",
        name: "Retired",
        hidden: true,
        activity: "dead",
        unread: true,
      },
    ];

    const result = computeRoomAttentionIndex(groups, bots);

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.roomId)).toEqual(["group-bf", "group-st"]);

    // BotFleet group has bot-1 (working its room thread) and bot-2 (waiting
    // on its room thread). bot-2's unread 1:1 thread is not room content.
    const bf = result.find((r) => r.roomId === "group-bf")!;
    expect(bf.errors.count).toBe(0);
    expect(bf.working.count).toBe(1);
    expect(bf.working.bots[0].botName).toBe("Architect");
    expect(bf.needsAction.count).toBe(1);
    expect(bf.needsAction.bots[0].botName).toBe("Fixer");
    expect(bf.unread.count).toBe(0);
    expect(bf.unread.hasUnread).toBe(false);
    expect(bf.unread.bots.map((b) => b.botName)).toEqual(["Fixer"]);
    expect(bf.cwd).toBe("/Users/jay/Code/BotFleet");

    // Socratic.Trade group has bot-3 (dead), room unread is true
    const st = result.find((r) => r.roomId === "group-st")!;
    expect(st.errors.count).toBe(1);
    expect(st.errors.bots[0].botName).toBe("Scout");
    expect(st.errors.bots[0].reason).toBe("Process terminated");
    expect(st.working.count).toBe(0);
    expect(st.needsAction.count).toBe(0);
    expect(st.unread.count).toBe(1); // group unread is true
    expect(st.unread.hasUnread).toBe(true);
  });

  it("does not infer membership from mutable section labels or names", () => {
    const groups: MinimalGroup[] = [
      {
        id: "group-ct",
        name: "Congress.Trade",
        section: "Finance",
        memberIds: [], // Explicitly empty
        unread: false,
        threadId: "thread-ct",
      },
    ];

    const bots: MinimalBot[] = [
      {
        id: "bot-ct",
        name: "Trader",
        section: "Congress.Trade", // Matches group name
        activity: "dead",
        unread: true,
      },
      {
        id: "bot-finance",
        name: "FinanceBot",
        section: "Finance", // Matches group section
        activity: "waiting-on-you",
        unread: true,
      },
    ];

    const result = computeRoomAttentionIndex(groups, bots);
    expect(result).toHaveLength(1);
    // Neither bot should be inferred as a member
    expect(result[0].memberIds).toEqual([]);
    expect(result[0].errors.count).toBe(0);
    expect(result[0].needsAction.count).toBe(0);
    expect(result[0].unread.count).toBe(0);
    expect(result[0].unread.hasUnread).toBe(false);
  });

  it("computes unread attention without lossy collapse across room and member channels", () => {
    const groups: MinimalGroup[] = [
      {
        id: "group-1",
        name: "Dev",
        memberIds: ["bot-speaker"],
        unread: true, // Room chat itself is unread
        threadId: "thread-dev",
      },
    ];

    const bots: MinimalBot[] = [
      {
        id: "bot-speaker",
        name: "Speaker",
        activity: "idle",
        unread: true, // Direct bot thread is unread
      },
    ];

    const result = computeRoomAttentionIndex(groups, bots);
    expect(result[0].unread.hasUnread).toBe(true);
    // Room count is the room chat only; the member's 1:1 unread is listed
    // for the fleet rollup, not counted here.
    expect(result[0].unread.count).toBe(1);
    expect(result[0].unread.bots.map((b) => b.botId)).toEqual(["bot-speaker"]);
  });

  it("summarizes fleet attention accurately", () => {
    const attentionList = [
      {
        roomId: "r1",
        roomName: "App 1",
        memberIds: ["b1"],
        errors: { count: 1, bots: [{ botId: "b1", botName: "Bot 1" }] },
        needsAction: { count: 0, bots: [] },
        working: { count: 1, bots: [{ botId: "b1", botName: "Bot 1" }] },
        unread: {
          count: 2,
          hasUnread: true,
          roomUnread: true,
          bots: [{ botId: "b1", botName: "Bot 1" }],
        },
      },
      {
        roomId: "r2",
        roomName: "App 2",
        memberIds: ["b2"],
        errors: { count: 0, bots: [] },
        needsAction: { count: 2, bots: [{ botId: "b2", botName: "Bot 2" }, { botId: "b3", botName: "Bot 3" }] },
        working: { count: 0, bots: [] },
        unread: { count: 0, hasUnread: false, roomUnread: false, bots: [] },
      },
    ];

    const summary = summarizeFleetAttention(attentionList);
    expect(summary.totalRooms).toBe(2);
    expect(summary.roomsWithErrors).toBe(1);
    expect(summary.totalErrors).toBe(1);
    expect(summary.roomsNeedingAction).toBe(1);
    expect(summary.totalNeedsAction).toBe(2);
    expect(summary.roomsWorking).toBe(1);
    expect(summary.totalWorking).toBe(1);
    expect(summary.roomsWithUnread).toBe(1);
    expect(summary.totalUnread).toBe(2);
  });

  it("includes bots with active turn errors in room errors and reasons", () => {
    const groups: MinimalGroup[] = [
      {
        id: "group-bf",
        name: "BotFleet",
        memberIds: ["bot-err"],
        unread: false,
        threadId: "thread-bf",
      },
    ];

    const bots: MinimalBot[] = [
      {
        id: "bot-err",
        name: "Builder",
        activity: "idle",
        messages: [
          { kind: "text" },
          { kind: "activity", tool: { name: "error: rate limit from provider" } },
        ],
      },
    ];

    expect(isBotTurnError(bots[0])).toBe(true);
    const result = computeRoomAttentionIndex(groups, bots);
    expect(result[0].errors.count).toBe(1);
    expect(result[0].errors.bots[0].botName).toBe("Builder");
    expect(result[0].errors.bots[0].reason).toBe("Turn error: rate limit from provider");
  });

  it("reads a turn error from the visible branch, not the flat message tail", () => {
    const groups: MinimalGroup[] = [
      {
        id: "group-bf",
        name: "BotFleet",
        memberIds: ["bot-fork", "bot-stale"],
        unread: false,
        threadId: "thread-bf",
      },
    ];

    const bots: MinimalBot[] = [
      {
        id: "bot-fork",
        name: "Builder",
        activity: "idle",
        activeLeafId: "err",
        messages: [
          { id: "root", kind: "text", parentId: null },
          { id: "err", kind: "activity", parentId: "root", tool: { name: "error: rate limit from provider" } },
          { id: "abandoned", kind: "text", parentId: "root" },
        ],
      },
      {
        id: "bot-stale",
        name: "Scout",
        activity: "idle",
        activeLeafId: "live",
        messages: [
          { id: "root", kind: "text", parentId: null },
          { id: "live", kind: "text", parentId: "root" },
          { id: "old-err", kind: "activity", parentId: "root", tool: { name: "error: abandoned branch" } },
        ],
      },
    ];

    expect(isBotTurnError(bots[0])).toBe(true);
    expect(isBotTurnError(bots[1])).toBe(false);
    const result = computeRoomAttentionIndex(groups, bots);
    expect(result[0].errors.count).toBe(1);
    expect(result[0].errors.bots.map((bot) => bot.botName)).toEqual(["Builder"]);
    expect(result[0].errors.bots[0].reason).toBe("Turn error: rate limit from provider");
  });

  it("reuses one transcript for a bot shared by two rooms", () => {
    const messages = [
      { id: "root", kind: "text", parentId: null },
      { id: "err", kind: "activity", parentId: "root", tool: { name: "error: rate limit from provider" } },
      { id: "abandoned", kind: "text", parentId: "root" },
    ];
    const bot: MinimalBot = {
      id: "bot-shared",
      name: "Builder",
      activity: "idle",
      activeLeafId: "err",
      messages,
    };
    const groups: MinimalGroup[] = [
      { id: "room-a", name: "A", memberIds: ["bot-shared"], unread: false, threadId: "thread-a" },
      { id: "room-b", name: "B", memberIds: ["bot-shared"], unread: false, threadId: "thread-b" },
    ];

    const result = computeRoomAttentionIndex(groups, [bot]);
    expect(result.map((room) => room.errors.bots[0]?.reason)).toEqual([
      "Turn error: rate limit from provider",
      "Turn error: rate limit from provider",
    ]);
    expect(isBotTurnError(bot)).toBe(true);

    const again = computeRoomAttentionIndex(groups, [bot]);
    expect(again.map((room) => room.roomId)).toEqual(["room-a", "room-b"]);
    expect(again.map((room) => room.errors.count)).toEqual([1, 1]);
    expect(again.map((room) => room.errors.bots[0].reason)).toEqual([
      "Turn error: rate limit from provider",
      "Turn error: rate limit from provider",
    ]);
  });

  it("uses the leaf as the visible tail, including a deep chain and a cycle", () => {
    const deep = [
      { id: "m0", kind: "text", parentId: null },
      ...Array.from({ length: 40 }, (_, i) => ({
        id: `m${i + 1}`,
        kind: "text",
        parentId: `m${i}`,
      })),
      {
        id: "leaf",
        kind: "activity",
        parentId: "m40",
        tool: { name: "error: leaf on the visible branch" },
      },
      {
        id: "flat-tail",
        kind: "activity",
        parentId: "m0",
        tool: { name: "error: abandoned flat tail" },
      },
    ];
    const deepBot: MinimalBot = {
      id: "bot-deep",
      name: "Builder",
      activity: "idle",
      activeLeafId: "leaf",
      messages: deep,
    };

    const cycle: MinimalBot = {
      id: "bot-cycle",
      name: "Scout",
      activity: "idle",
      activeLeafId: "loop-leaf",
      messages: [
        { id: "loop-leaf", kind: "activity", parentId: "loop-mid", tool: { name: "error: cycle leaf" } },
        { id: "loop-mid", kind: "activity", parentId: "loop-leaf", tool: { name: "error: cycle parent" } },
        { id: "flat-tail", kind: "activity", parentId: null, tool: { name: "error: cycle flat tail" } },
      ],
    };

    const missingLeaf: MinimalBot = {
      id: "bot-missing",
      name: "Fixer",
      activity: "idle",
      activeLeafId: "not-in-transcript",
      messages: [
        { id: "root", kind: "text", parentId: null },
        { id: "flat-tail", kind: "activity", parentId: "root", tool: { name: "error: flat fallback" } },
      ],
    };

    const ancestorOnly: MinimalBot = {
      id: "bot-ancestor",
      name: "Archivist",
      activity: "idle",
      activeLeafId: "clean-leaf",
      messages: [
        { id: "root", kind: "activity", parentId: null, tool: { name: "error: ancestor only" } },
        { id: "clean-leaf", kind: "text", parentId: "root" },
        { id: "flat-tail", kind: "activity", parentId: "root", tool: { name: "error: not the leaf" } },
      ],
    };

    expect(isBotTurnError(deepBot)).toBe(true);
    expect(isBotTurnError(cycle)).toBe(true);
    expect(isBotTurnError(missingLeaf)).toBe(true);
    expect(isBotTurnError(ancestorOnly)).toBe(false);

    const groups: MinimalGroup[] = [
      {
        id: "room",
        name: "BotFleet",
        memberIds: ["bot-deep", "bot-cycle", "bot-missing", "bot-ancestor"],
        unread: false,
        threadId: "thread-room",
      },
    ];
    const result = computeRoomAttentionIndex(groups, [deepBot, cycle, missingLeaf, ancestorOnly]);
    expect(result[0].errors.bots.map((bot) => [bot.botName, bot.reason])).toEqual([
      ["Builder", "Turn error: leaf on the visible branch"],
      ["Scout", "Turn error: cycle leaf"],
      ["Fixer", "Turn error: flat fallback"],
    ]);
  });
});

describe("summarizeFleetAttention", () => {
  const room = (
    id: string,
    memberIds: string[],
    extra: Partial<MinimalGroup> = {},
  ): MinimalGroup => ({ id, name: id, memberIds, unread: false, threadId: `${id}-thread`, ...extra });

  it("attributes a working turn to its own room, not every room the bot is in", () => {
    // One working bot and one dead bot, each a member of all three rooms.
    // The worker's turn runs on room-a's thread.
    const groups = [
      room("room-a", ["bot-worker", "bot-crashed"]),
      room("room-b", ["bot-worker", "bot-crashed"]),
      room("room-c", ["bot-worker", "bot-crashed"]),
    ];
    const bots: MinimalBot[] = [
      { id: "bot-worker", name: "Worker", activity: "working", inflightThreadId: "room-a-thread" },
      { id: "bot-crashed", name: "Crashed", activity: "dead" },
    ];

    const rooms = computeRoomAttentionIndex(groups, bots);
    // Only the room that owns the turn thread shows working. Errors stay
    // global: a dead bot is dead in every room it belongs to.
    expect(rooms.map((r) => r.working.count)).toEqual([1, 0, 0]);
    expect(rooms.map((r) => r.working.bots.map((b) => b.botId))).toEqual([
      ["bot-worker"],
      [],
      [],
    ]);
    expect(rooms.map((r) => r.errors.count)).toEqual([1, 1, 1]);

    const summary = summarizeFleetAttention(rooms);
    expect(summary.totalWorking).toBe(1);
    expect(summary.totalErrors).toBe(1);
    expect(summary.totalNeedsAction).toBe(0);
    expect(summary.totalUnread).toBe(0);
    expect(summary.roomsWorking).toBe(1);
    expect(summary.roomsWithErrors).toBe(3);
  });

  it("shows an unattributed working state nowhere", () => {
    // A working bot with no live-thread attribution (and no room claiming
    // it through busyBotId) is real work, but no room can honestly claim
    // it, so no room chip does.
    const groups = [
      room("room-a", ["bot-worker"]),
      room("room-b", ["bot-worker"]),
    ];
    const bots: MinimalBot[] = [
      { id: "bot-worker", name: "Worker", activity: "working" },
    ];

    const rooms = computeRoomAttentionIndex(groups, bots);
    expect(rooms.map((r) => r.working.count)).toEqual([0, 0]);

    // No room claims the turn, but the fleet total still counts the bot:
    // the pills report distinct bots in the state anywhere in the fleet.
    const summary = summarizeFleetAttention(rooms, bots);
    expect(summary.totalWorking).toBe(1);
    expect(summary.roomsWorking).toBe(0);
  });

  it("still counts different bots separately when their rooms overlap", () => {
    // Each wait and turn is attributed to the room that owns its thread,
    // even when membership overlaps.
    const groups = [
      room("room-a", ["bot-a", "bot-c"]),
      room("room-b", ["bot-a", "bot-b", "bot-c", "bot-d"]),
      room("room-c", ["bot-b", "bot-d"]),
    ];
    const bots: MinimalBot[] = [
      { id: "bot-a", name: "A", activity: "working", inflightThreadId: "room-a-thread" },
      { id: "bot-b", name: "B", activity: "working", inflightThreadId: "room-c-thread" },
      { id: "bot-c", name: "C", activity: "waiting-on-you", waitingThreadId: "room-b-thread" },
      { id: "bot-d", name: "D", activity: "waiting-on-you", waitingThreadId: "room-b-thread" },
    ];

    const rooms = computeRoomAttentionIndex(groups, bots);
    expect(rooms.map((r) => r.working.count)).toEqual([1, 0, 1]);
    expect(rooms.map((r) => r.needsAction.count)).toEqual([0, 2, 0]);

    const summary = summarizeFleetAttention(rooms);
    expect(summary.totalWorking).toBe(2);
    expect(summary.totalNeedsAction).toBe(2);
  });

  it("shows a wait only in the room that owns the waiting thread", () => {
    // The reported case: one bot waits on a card in AFC+OPS while belonging
    // to every room. Only AFC+OPS may show it.
    const groups = [
      room("room-codecaps", ["bot-plumber"]),
      room("room-afcops", ["bot-plumber"]),
    ];
    const bots: MinimalBot[] = [
      {
        id: "bot-plumber",
        name: "Plumber",
        activity: "waiting-on-you",
        waitingThreadId: "room-afcops-thread",
      },
    ];

    const rooms = computeRoomAttentionIndex(groups, bots);
    expect(rooms.map((r) => r.needsAction.count)).toEqual([0, 1]);
    expect(rooms[1].needsAction.bots.map((b) => b.botName)).toEqual(["Plumber"]);

    const summary = summarizeFleetAttention(rooms);
    expect(summary.totalNeedsAction).toBe(1);
    expect(summary.roomsNeedingAction).toBe(1);
  });

  it("shows a 1:1 wait or turn in no room", () => {
    // A wait on the bot's own thread (or a wait the server never attributed)
    // belongs to no room, so no room chip claims it.
    const groups = [
      room("room-a", ["bot-solo"]),
      room("room-b", ["bot-solo"]),
    ];
    const waitingNowhere: MinimalBot[] = [
      {
        id: "bot-solo",
        name: "Solo",
        activity: "waiting-on-you",
        threadId: "bot-solo-thread",
        waitingThreadId: "bot-solo-thread",
      },
    ];
    const waitingUnattributed: MinimalBot[] = [
      { id: "bot-solo", name: "Solo", activity: "waiting-on-you" },
    ];

    for (const bots of [waitingNowhere, waitingUnattributed]) {
      const rooms = computeRoomAttentionIndex(groups, bots);
      expect(rooms.map((r) => r.needsAction.count)).toEqual([0, 0]);
      // The fleet pill still counts the waiting bot once.
      expect(summarizeFleetAttention(rooms, bots).totalNeedsAction).toBe(1);
    }

    const turningNowhere: MinimalBot[] = [
      {
        id: "bot-solo",
        name: "Solo",
        activity: "working",
        threadId: "bot-solo-thread",
        inflightThreadId: "bot-solo-thread",
      },
    ];
    const rooms = computeRoomAttentionIndex(groups, turningNowhere);
    expect(rooms.map((r) => r.working.count)).toEqual([0, 0]);
    expect(summarizeFleetAttention(rooms, turningNowhere).totalWorking).toBe(1);
  });

  it("attributes a wait on a room task thread to that room", () => {
    const groups = [
      room("room-a", ["bot-tasked"], {
        threadId: "room-a-thread",
        tasks: [{ threadId: "room-a-task-9" }],
      }),
      room("room-b", ["bot-tasked"]),
    ];
    const bots: MinimalBot[] = [
      {
        id: "bot-tasked",
        name: "Tasked",
        activity: "waiting-on-you",
        waitingThreadId: "room-a-task-9",
      },
    ];

    const rooms = computeRoomAttentionIndex(groups, bots);
    expect(rooms.map((r) => r.needsAction.count)).toEqual([1, 0]);
  });

  it("counts a working bot once whether its activity or its room's busy marker says so", () => {
    const groups = [
      room("room-a", ["bot-global"], { busyBotId: "bot-global" }),
      room("room-b", ["bot-global", "bot-room-only"], { busyBotId: "bot-room-only" }),
    ];
    const bots: MinimalBot[] = [
      { id: "bot-global", name: "Global", activity: "working" },
      { id: "bot-room-only", name: "Room Only", activity: "idle" },
    ];

    const rooms = computeRoomAttentionIndex(groups, bots);
    // room-a lists bot-global once although two signals mark it working.
    // room-b lists only its own busy speaker: bot-global's process belongs
    // to room-a, so room-b may not claim it through the global activity.
    expect(rooms.map((r) => r.working.bots.map((b) => b.botId))).toEqual([
      ["bot-global"],
      ["bot-room-only"],
    ]);

    const summary = summarizeFleetAttention(rooms);
    expect(summary.totalWorking).toBe(2);
    expect(summary.roomsWorking).toBe(2);
  });

  it("counts an unread bot once, plus each room chat that is unread itself", () => {
    const groups = [
      room("room-a", ["bot-reader"]),
      room("room-b", ["bot-reader"], { unread: true }),
      room("room-c", ["bot-reader"]),
    ];
    const bots: MinimalBot[] = [
      { id: "bot-reader", name: "Reader", activity: "idle", unread: true },
    ];

    const rooms = computeRoomAttentionIndex(groups, bots);
    // Per room: the room chat only. The bot's 1:1 unread is still listed
    // for the fleet rollup, but only room-b's own chat counts at room level.
    expect(rooms.map((r) => r.unread.count)).toEqual([0, 1, 0]);
    expect(rooms.map((r) => r.unread.roomUnread)).toEqual([false, true, false]);
    expect(rooms.map((r) => r.unread.bots.map((b) => b.botId))).toEqual([
      ["bot-reader"],
      ["bot-reader"],
      ["bot-reader"],
    ]);

    const summary = summarizeFleetAttention(rooms);
    expect(summary.totalUnread).toBe(2); // the bot once, plus room-b's chat
    expect(summary.roomsWithUnread).toBe(1);
  });

  it("counts a room-less dead or errored bot once in the fleet error total", () => {
    // bot-orphan and bot-flagged belong to no room: their failures are
    // real but land in no room error list.  The fleet pill still counts
    // each of them once.
    const groups = [room("room-a", ["bot-member"])];
    const bots: MinimalBot[] = [
      { id: "bot-member", name: "Member", activity: "idle" },
      { id: "bot-orphan", name: "Orphan", activity: "dead" },
      { id: "bot-flagged", name: "Flagged", activity: "idle", hasError: true },
    ];

    const rooms = computeRoomAttentionIndex(groups, bots);
    expect(rooms[0].errors.count).toBe(0);

    const summary = summarizeFleetAttention(rooms, bots);
    expect(summary.totalErrors).toBe(2);
    expect(summary.roomsWithErrors).toBe(0);
  });

  it("counts a waiting bot claimed by a room busy marker only as working", () => {
    // room-a's busyBotId names bot-split, whose raw activity is an
    // unattributed wait.  The busy marker already counts it working; the
    // fleet union must not also add it to needs action.
    const groups = [room("room-a", ["bot-split"], { busyBotId: "bot-split" })];
    const bots: MinimalBot[] = [
      { id: "bot-split", name: "Split", activity: "waiting-on-you" },
    ];

    const rooms = computeRoomAttentionIndex(groups, bots);
    expect(rooms[0].working.count).toBe(1);
    expect(rooms[0].needsAction.count).toBe(0);

    const summary = summarizeFleetAttention(rooms, bots);
    expect(summary.totalWorking).toBe(1);
    expect(summary.totalNeedsAction).toBe(0);
  });
});
