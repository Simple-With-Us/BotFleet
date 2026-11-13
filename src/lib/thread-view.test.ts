import { beforeEach, describe, expect, it } from "vitest";
import {
  loadThreadView,
  MAX_REMEMBERED_VIEWS,
  parseThreadViews,
  resetThreadViewSession,
  saveThreadView,
  THREAD_VIEW_KEY,
} from "./thread-view.ts";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    raw: () => data.get(THREAD_VIEW_KEY),
  };
}
const throwing = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

beforeEach(() => resetThreadViewSession());

describe("parseThreadViews", () => {
  it("reads a stored map and ignores anything that is not a view", () => {
    expect(parseThreadViews(JSON.stringify({ a: "trajectory", b: "chat", c: "sideways", d: 3 }))).toEqual({ a: "trajectory", b: "chat" });
  });

  it("reads garbage as empty", () => {
    for (const raw of [null, undefined, "", "{", "[]", "3", '"x"']) expect(parseThreadViews(raw)).toEqual({});
  });
});

describe("loadThreadView / saveThreadView", () => {
  it("defaults to Chat for a thread nobody switched", () => {
    expect(loadThreadView("t1", memoryStorage())).toBe("chat");
  });

  it("remembers a thread's view across launches", () => {
    const storage = memoryStorage();
    saveThreadView("t1", "trajectory", storage);
    resetThreadViewSession();
    expect(loadThreadView("t1", storage)).toBe("trajectory");
    expect(loadThreadView("t2", storage)).toBe("chat");
  });

  it("keeps each thread's view separate", () => {
    const storage = memoryStorage();
    saveThreadView("a", "trajectory", storage);
    saveThreadView("b", "chat", storage);
    expect(loadThreadView("a", storage)).toBe("trajectory");
    expect(loadThreadView("b", storage)).toBe("chat");
  });

  it("stores only the non-default view, so switching back forgets the entry", () => {
    const storage = memoryStorage();
    saveThreadView("a", "trajectory", storage);
    expect(JSON.parse(storage.raw()!)).toEqual({ a: "trajectory" });
    saveThreadView("a", "chat", storage);
    expect(JSON.parse(storage.raw()!)).toEqual({});
  });

  it("caps what it remembers, dropping the oldest first", () => {
    const storage = memoryStorage();
    for (let i = 0; i < MAX_REMEMBERED_VIEWS + 5; i++) saveThreadView(`t${i}`, "trajectory", storage);
    const stored = Object.keys(JSON.parse(storage.raw()!));
    expect(stored).toHaveLength(MAX_REMEMBERED_VIEWS);
    expect(stored[0]).toBe("t5");
    expect(stored.at(-1)).toBe(`t${MAX_REMEMBERED_VIEWS + 4}`);
  });

  it("re-orders a thread to newest when it is chosen again", () => {
    const storage = memoryStorage();
    saveThreadView("a", "trajectory", storage);
    saveThreadView("b", "trajectory", storage);
    saveThreadView("a", "trajectory", storage);
    expect(Object.keys(JSON.parse(storage.raw()!))).toEqual(["b", "a"]);
  });

  it("still works for the session when storage rejects every access", () => {
    expect(loadThreadView("t1", throwing)).toBe("chat");
    saveThreadView("t1", "trajectory", throwing);
    expect(loadThreadView("t1", throwing)).toBe("trajectory");
  });

  it("still works when there is no storage at all", () => {
    saveThreadView("t1", "trajectory", null);
    expect(loadThreadView("t1", null)).toBe("trajectory");
    expect(loadThreadView("t2", null)).toBe("chat");
  });

  it("survives a corrupt stored value", () => {
    const storage = memoryStorage({ [THREAD_VIEW_KEY]: "{not json" });
    expect(loadThreadView("t1", storage)).toBe("chat");
    saveThreadView("t1", "trajectory", storage);
    expect(loadThreadView("t1", storage)).toBe("trajectory");
  });
});
