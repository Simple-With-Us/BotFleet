import { describe, expect, it } from "vitest";

import type { Bot, Group } from "@/state/store";

import { preparePaletteBots, preparePaletteGroups } from "./command-palette-entries";

function bot(
  overrides: Partial<Bot> & Pick<Bot, "id" | "name"> & { lastAt?: number; pinned?: boolean },
): Bot {
  return {
    id: overrides.id,
    threadId: `${overrides.id}-thread`,
    name: overrides.name,
    title: "",
    description: "",
    notifications: true,
    color: "blue",
    unread: false,
    modelSelection: { instanceId: "i", model: "m" },
    createdAt: 1,
    pinned: overrides.pinned,
    hidden: overrides.hidden,
    tasks: [{ threadId: `${overrides.id}-thread`, title: "Chat", createdAt: 1 }],
    messages: overrides.lastAt
      ? [{ id: `${overrides.id}-m`, role: "bot", kind: "text", at: overrides.lastAt, text: "hi" }]
      : [],
  };
}

function group(
  overrides: Partial<Group> & Pick<Group, "id" | "name"> & { lastAt?: number; dm?: boolean },
): Group {
  return {
    id: overrides.id,
    threadId: `${overrides.id}-thread`,
    name: overrides.name,
    memberIds: [],
    defaultResponder: { kind: "mentions" },
    bulletin: "",
    unread: false,
    createdAt: 1,
    dm: overrides.dm,
    section: overrides.section,
    messages: overrides.lastAt
      ? [{ id: `${overrides.id}-m`, role: "user", kind: "text", at: overrides.lastAt, text: "hi" }]
      : [],
    tasks: [{ threadId: `${overrides.id}-thread`, title: "Chat", createdAt: 1 }],
  };
}

describe("preparePaletteBots", () => {
  it("drops hidden bots and orders pinned first, then recent activity", () => {
    const ordered = preparePaletteBots([
      bot({ id: "old", name: "Old", lastAt: 1 }),
      bot({ id: "pin", name: "Pinned", lastAt: 2, pinned: true }),
      bot({ id: "fresh", name: "Fresh", lastAt: 99 }),
      bot({ id: "ghost", name: "Ghost", hidden: true, lastAt: 500 }),
    ]).map((row) => row.name);
    expect(ordered).toEqual(["Pinned", "Fresh", "Old"]);
  });
});

describe("preparePaletteGroups", () => {
  it("keeps bot-to-bot chats separate from user rooms even with a leftover Apps section", () => {
    const { rooms, botChats } = preparePaletteGroups([
      group({ id: "apps", name: "Apps room", lastAt: 10 }),
      group({ id: "dm", name: "Compiler ⇄ Designer", dm: true, section: "Apps", lastAt: 50 }),
      group({ id: "work", name: "Work room", section: "Work", lastAt: 20 }),
    ]);
    expect(botChats.map((g) => g.name)).toEqual(["Compiler ⇄ Designer"]);
    expect(rooms.map((g) => g.name)).toEqual(["Work room", "Apps room"]);
  });

  it("sorts each bucket by recent activity", () => {
    const { botChats, rooms } = preparePaletteGroups([
      group({ id: "dm-old", name: "Older DM", dm: true, lastAt: 1 }),
      group({ id: "dm-new", name: "Newer DM", dm: true, lastAt: 100 }),
      group({ id: "room-old", name: "Older room", lastAt: 2 }),
      group({ id: "room-new", name: "Newer room", lastAt: 200 }),
    ]);
    expect(botChats.map((g) => g.name)).toEqual(["Newer DM", "Older DM"]);
    expect(rooms.map((g) => g.name)).toEqual(["Newer room", "Older room"]);
  });
});
