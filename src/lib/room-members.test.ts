import { describe, expect, it } from "vitest";

import { explicitMemberIdSet, nextMemberIds } from "./room-members";

const pick = (...ids: string[]) => new Set(ids);

describe("nextMemberIds", () => {
  it("keeps the existing roster in place so the room's lead does not move", () => {
    expect(nextMemberIds(["lead", "second"], pick("lead", "second"), ["second", "lead"])).toEqual(["lead", "second"]);
  });

  it("appends newly ticked bots after the members already in the room", () => {
    expect(nextMemberIds(["lead"], pick("lead", "scout", "archivist"), ["archivist", "lead", "scout"])).toEqual([
      "lead",
      "archivist",
      "scout",
    ]);
  });

  it("drops members that were unticked", () => {
    expect(nextMemberIds(["lead", "second"], pick("second"), ["lead", "second"])).toEqual(["second"]);
  });

  it("ignores ticked ids that are not offered in the list", () => {
    expect(nextMemberIds(["lead"], pick("lead", "ghost"), ["lead"])).toEqual(["lead"]);
  });

  it("returns nothing when every member is unticked", () => {
    expect(nextMemberIds(["lead"], pick(), ["lead"])).toEqual([]);
  });
});

describe("explicitMemberIdSet", () => {
  it("keeps only the ids the room lists", () => {
    const members = explicitMemberIdSet(["bot-a", "bot-b"]);
    expect([...members]).toEqual(["bot-a", "bot-b"]);
  });

  it("does not gain a bot whose section label matches the room name", () => {
    const roomName = "Congress.Trade";
    const sectionLabel = "Congress.Trade";
    const members = explicitMemberIdSet([]);
    expect(sectionLabel).toBe(roomName);
    expect(members.has("bot-ct")).toBe(false);
  });

  it("treats a missing member list as nobody", () => {
    expect(explicitMemberIdSet(undefined).size).toBe(0);
    expect(explicitMemberIdSet(null).size).toBe(0);
  });
});
