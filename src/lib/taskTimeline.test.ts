import { describe, expect, it } from "vitest";

import { timelineEvents } from "./taskTimeline";

describe("timelineEvents", () => {
  it("labels the first turn-starter Task started regardless of role", () => {
    const events = timelineEvents([{ id: "1", role: "system", kind: "text", text: "routine fired", at: 0 }]);
    expect(events[0]!.label).toBe("Task started");
  });

  it("labels a later human reply User input", () => {
    const events = timelineEvents([
      { id: "1", role: "user", kind: "text", text: "start", at: 0 },
      { id: "2", role: "bot", kind: "activity", tool: { name: "Bash" }, at: 1 },
      { id: "3", role: "user", kind: "text", text: "follow up", at: 2 },
    ]);
    expect(events.map((e) => e.label)).toEqual(["Task started", "Bash", "User input"]);
  });

  it("does not attribute a later automated re-fire to the person", () => {
    // Same routine/webhook/resource firing again in a reused thread: the
    // second system message must not inherit the "User input" label.
    const events = timelineEvents([
      { id: "1", role: "system", kind: "text", text: "routine fired", at: 0 },
      { id: "2", role: "bot", kind: "activity", tool: { name: "Bash" }, at: 1 },
      { id: "3", role: "system", kind: "text", text: "routine fired again", at: 2 },
    ]);
    expect(events.map((e) => e.label)).toEqual(["Task started", "Bash", "Automated instruction"]);
  });
});
