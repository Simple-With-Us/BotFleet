/// <reference types="vitest/config" />
import { describe, expect, it } from "vitest";

import { ChildSessionIds } from "./child-session-ids.ts";

/** The id a turn that ran (reported usage) would be stamped with. */
const ran = (ids: ChildSessionIds, threadId: string, instanceId: string) =>
  ids.forTurn(threadId, instanceId, "a-later-turn", true);

describe("ChildSessionIds", () => {
  it("remembers the session each child reported, per thread and instance", () => {
    const ids = new ChildSessionIds();
    ids.note("thread-1", "claude", "s-claude", "t1");
    ids.note("thread-1", "codex", "s-codex", "t1");
    ids.note("thread-2", "claude", "s-other", "t2");
    expect(ran(ids, "thread-1", "claude")).toBe("s-claude");
    expect(ran(ids, "thread-1", "codex")).toBe("s-codex");
    expect(ran(ids, "thread-2", "claude")).toBe("s-other");
    expect(ran(ids, "thread-3", "claude")).toBeUndefined();
  });

  it("stamps a turn with the session it reported itself, even when the turn reported no usage", () => {
    const ids = new ChildSessionIds();
    ids.note("thread-1", "codex", "s-1", "turn-1");
    expect(ids.forTurn("thread-1", "codex", "turn-1", false)).toBe("s-1");
  });

  it("keeps a warm process's session for a later turn the child ran", () => {
    const ids = new ChildSessionIds();
    ids.note("thread-1", "claude", "s-warm", "turn-1");
    expect(ids.forTurn("thread-1", "claude", "turn-2", true)).toBe("s-warm");
  });

  it("gives a turn that failed before its child reported anything no id, not the previous turn's", () => {
    const ids = new ChildSessionIds();
    ids.note("thread-1", "codex", "s-previous", "turn-1");
    expect(ids.forTurn("thread-1", "codex", "turn-2", false)).toBeUndefined();
    expect(ids.forTurn("thread-1", "codex", undefined, false)).toBeUndefined();
  });

  it("forgets an invalidated session, but not a newer one", () => {
    const ids = new ChildSessionIds();
    ids.note("thread-1", "claude", "s-old", "turn-1");
    ids.forget("thread-1", "claude", "s-old");
    expect(ran(ids, "thread-1", "claude")).toBeUndefined();
    ids.note("thread-1", "claude", "s-new", "turn-2");
    ids.forget("thread-1", "claude", "s-old");
    expect(ran(ids, "thread-1", "claude")).toBe("s-new");
  });

  it("forgets an old session when the child starts one it has not named, so a turn is never stamped with it", () => {
    const ids = new ChildSessionIds();
    ids.note("thread-1", "claude", "s-old");
    ids.note("thread-1", "claude", null);
    expect(ran(ids, "thread-1", "claude")).toBeUndefined();
    ids.note("thread-1", "claude", "s-new");
    ids.note("thread-1", "claude", "   ");
    expect(ran(ids, "thread-1", "claude")).toBeUndefined();
  });

  it("keeps the newest sessions when it is full", () => {
    const ids = new ChildSessionIds(2);
    ids.note("a", "i", "1");
    ids.note("b", "i", "2");
    ids.note("a", "i", "1b"); // refreshes a, so b is now the oldest
    ids.note("c", "i", "3");
    expect(ids.size).toBe(2);
    expect(ran(ids, "b", "i")).toBeUndefined();
    expect(ran(ids, "a", "i")).toBe("1b");
    expect(ran(ids, "c", "i")).toBe("3");
  });
});
