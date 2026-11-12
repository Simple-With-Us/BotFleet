import { describe, expect, it } from "vitest";

import { parseThreadDrag, serializeThreadDrag } from "./thread-drag";

describe("thread drag payload", () => {
  it("round-trips a bot thread", () => {
    const drag = { threadId: "t1", fromId: "bot-a", fromKind: "bot" as const };
    expect(parseThreadDrag(serializeThreadDrag(drag))).toEqual(drag);
  });

  it("still reads the old fromGroupId-only payload so in-flight drags land", () => {
    expect(parseThreadDrag(JSON.stringify({ threadId: "t1", fromGroupId: "room-1" }))).toEqual({
      threadId: "t1",
      fromId: "room-1",
      fromKind: "group",
    });
  });

  it("rejects junk", () => {
    expect(parseThreadDrag("")).toBeNull();
    expect(parseThreadDrag("{")).toBeNull();
    expect(parseThreadDrag(JSON.stringify({ threadId: 1 }))).toBeNull();
  });
});
