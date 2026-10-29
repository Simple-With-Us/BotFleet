/// <reference types="vitest/config" />
import { describe, expect, it } from "vitest";

import { ChildSessionIds } from "./child-session-ids.ts";

describe("ChildSessionIds", () => {
  it("remembers the session each child reported, per thread and instance", () => {
    const ids = new ChildSessionIds();
    ids.note("thread-1", "claude", "s-claude");
    ids.note("thread-1", "codex", "s-codex");
    ids.note("thread-2", "claude", "s-other");
    expect(ids.get("thread-1", "claude")).toBe("s-claude");
    expect(ids.get("thread-1", "codex")).toBe("s-codex");
    expect(ids.get("thread-2", "claude")).toBe("s-other");
    expect(ids.get("thread-3", "claude")).toBeUndefined();
  });

  it("forgets an old session when the child starts one it has not named, so a turn is never stamped with it", () => {
    const ids = new ChildSessionIds();
    ids.note("thread-1", "claude", "s-old");
    ids.note("thread-1", "claude", null);
    expect(ids.get("thread-1", "claude")).toBeUndefined();
    ids.note("thread-1", "claude", "s-new");
    ids.note("thread-1", "claude", "   ");
    expect(ids.get("thread-1", "claude")).toBeUndefined();
  });

  it("keeps the newest sessions when it is full", () => {
    const ids = new ChildSessionIds(2);
    ids.note("a", "i", "1");
    ids.note("b", "i", "2");
    ids.note("a", "i", "1b"); // refreshes a, so b is now the oldest
    ids.note("c", "i", "3");
    expect(ids.size).toBe(2);
    expect(ids.get("b", "i")).toBeUndefined();
    expect(ids.get("a", "i")).toBe("1b");
    expect(ids.get("c", "i")).toBe("3");
  });
});
