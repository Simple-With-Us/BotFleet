import { describe, expect, it } from "vitest";
import {
  computeRoomAttentionIndex,
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
      },
      {
        id: "group-bf",
        name: "BotFleet",
        section: "Core",
        memberIds: ["bot-1", "bot-2"],
        unread: false,
        cwd: "/Users/jay/Code/BotFleet",
      },
      {
        id: "group-st",
        name: "Socratic.Trade",
        section: "Trading",
        memberIds: ["bot-3"],
        unread: true,
        cwd: "/Users/jay/Code/Socratic.Trade",
      },
    ];

    const bots: MinimalBot[] = [
      {
        id: "bot-1",
        name: "Architect",
        activity: "working",
        unread: false,
      },
      {
        id: "bot-2",
        name: "Fixer",
        activity: "waiting-on-you",
        unread: true,
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

    // BotFleet group has bot-1 (working) and bot-2 (waiting-on-you, unread)
    const bf = result.find((r) => r.roomId === "group-bf")!;
    expect(bf.errors.count).toBe(0);
    expect(bf.working.count).toBe(1);
    expect(bf.working.bots[0].botName).toBe("Architect");
    expect(bf.needsAction.count).toBe(1);
    expect(bf.needsAction.bots[0].botName).toBe("Fixer");
    expect(bf.unread.count).toBe(1); // bot-2 has unread
    expect(bf.unread.hasUnread).toBe(true);
    expect(bf.cwd).toBe("/Users/jay/Code/BotFleet");

    // Socratic.Trade group has bot-3 (dead), room unread is true
    const st = result.find((r) => r.roomId === "group-st")!;
    expect(st.errors.count).toBe(1);
    expect(st.errors.bots[0].botName).toBe("Scout");
    expect(st.working.count).toBe(0);
    expect(st.needsAction.count).toBe(0);
    expect(st.unread.count).toBe(1); // group unread is true
    expect(st.unread.hasUnread).toBe(true);
  });

  it("handles implicit section matching when memberIds does not list bot explicitly", () => {
    const groups: MinimalGroup[] = [
      {
        id: "group-ct",
        name: "Congress.Trade",
        memberIds: [],
        unread: false,
      },
    ];

    const bots: MinimalBot[] = [
      {
        id: "bot-ct",
        name: "Trader",
        section: "Congress.Trade",
        activity: "waiting-on-you",
        unread: false,
      },
    ];

    const result = computeRoomAttentionIndex(groups, bots);
    expect(result).toHaveLength(1);
    expect(result[0].memberIds).toContain("bot-ct");
    expect(result[0].needsAction.count).toBe(1);
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
        unread: { count: 2, hasUnread: true },
      },
      {
        roomId: "r2",
        roomName: "App 2",
        memberIds: ["b2"],
        errors: { count: 0, bots: [] },
        needsAction: { count: 2, bots: [{ botId: "b2", botName: "Bot 2" }, { botId: "b3", botName: "Bot 3" }] },
        working: { count: 0, bots: [] },
        unread: { count: 0, hasUnread: false },
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
});
