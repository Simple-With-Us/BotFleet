import { describe, expect, it } from "vitest";

import { buildTeamMapEdges, buildTeamMapSections, teamMapStatus, type TeamMapSnapshot } from "./team-map";

const bots = [
  { id: "chief", name: "Atlas", section: "Work", chiefOfStaff: true, busy: true },
  { id: "maker", name: "Pixel", section: "Work" },
  { id: "home", name: "Mochi" },
  { id: "archived", name: "Old", hidden: true },
];

describe("team map projection", () => {
  it("groups visible bots by section and separates chiefs", () => {
    expect(buildTeamMapSections(bots)).toEqual([
      { key: "Work", name: "Work", chiefs: [bots[0]], members: [bots[1]] },
      { key: "", name: "General", chiefs: [], members: [bots[2]] },
    ]);
  });

  it("keeps the unsectioned team distinct from a section literally named General", () => {
    const projected = buildTeamMapSections([
      { id: "none", name: "Unsectioned" },
      { id: "named", name: "Named", section: " General " },
    ]);
    expect(projected.map(({ key, name }) => ({ key, name }))).toEqual([
      { key: "", name: "General" },
      { key: "General", name: "General" },
    ]);
  });

  it("keeps one edge per pair and gives live work priority", () => {
    const snapshot: TeamMapSnapshot = {
      collaborations: [{ groupId: "channel", botIds: ["chief", "maker"], lastAt: 10 }],
      queued: [{ sourceBotId: "chief", targetBotId: "maker", reason: "design" }],
      running: [{ sourceBotId: "chief", targetBotId: "maker", threadId: "task" }],
    };
    expect(buildTeamMapEdges(bots, snapshot)).toEqual([
      { sourceBotId: "chief", targetBotId: "maker", state: "running", groupId: undefined },
    ]);
  });

  it("filters archived endpoints and explains live states", () => {
    const snapshot: TeamMapSnapshot = {
      collaborations: [{ groupId: "old", botIds: ["chief", "archived"], lastAt: 10 }],
      queued: [],
      running: [],
    };
    expect(buildTeamMapEdges(bots, snapshot)).toEqual([]);
    expect(teamMapStatus(bots[0])).toEqual({ label: "Working", tone: "success" });
    expect(teamMapStatus({ id: "x", name: "X", activity: "waiting-on-you" })).toEqual({
      label: "Waiting for you",
      tone: "warning",
    });
  });

  it("calls a switched-off bot Off, not Ready", () => {
    expect(teamMapStatus({ id: "x", name: "X", off: true })).toEqual({ label: "Off", tone: "idle" });
    expect(teamMapStatus({ id: "x", name: "X", off: true, activity: "idle" })).toEqual({ label: "Off", tone: "idle" });
    // On stays Ready, whether the field is absent or false.
    expect(teamMapStatus({ id: "x", name: "X" })).toEqual({ label: "Ready", tone: "idle" });
    expect(teamMapStatus({ id: "x", name: "X", off: false })).toEqual({ label: "Ready", tone: "idle" });
  });

  it("keeps what an Off bot is still doing or needs ahead of Off", () => {
    // Off never interrupts a running turn, so it shows Working until the turn
    // ends; a card waiting on the person and a dead process are not hidden.
    expect(teamMapStatus({ id: "x", name: "X", off: true, busy: true })).toEqual({ label: "Working", tone: "success" });
    expect(teamMapStatus({ id: "x", name: "X", off: true, activity: "working" })).toEqual({ label: "Working", tone: "success" });
    expect(teamMapStatus({ id: "x", name: "X", off: true, activity: "waiting-on-you" })).toEqual({
      label: "Waiting for you",
      tone: "warning",
    });
    expect(teamMapStatus({ id: "x", name: "X", off: true, activity: "dead" })).toEqual({ label: "No signal", tone: "danger" });
  });
});
