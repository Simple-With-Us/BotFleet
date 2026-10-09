import { describe, expect, it } from "vitest";
import { resolveAppContext, shownThreadId, threadIdForApp, type AppContextInput } from "./task-app-thread";

describe("threadIdForApp", () => {
  const bot = {
    threadId: "active-other-app",
    tasks: [
      {
        threadId: "thread-app-a",
        workspaceContext: { appRef: { id: "app-a" } },
      },
      {
        threadId: "thread-app-b",
        workspaceContext: { appRef: { id: "app-b" } },
      },
    ],
  };

  it("returns the task thread bound to the requested app", () => {
    expect(threadIdForApp(bot, "app-a")).toBe("thread-app-a");
    expect(threadIdForApp(bot, "app-b")).toBe("thread-app-b");
  });

  it("falls back to the bot's active thread when no app task exists", () => {
    expect(threadIdForApp(bot, "app-missing")).toBe("active-other-app");
    expect(threadIdForApp({ threadId: "only-active", tasks: [] }, "app-a")).toBe("only-active");
  });

  it("returns undefined for a missing bot", () => {
    expect(threadIdForApp(null, "app-a")).toBeUndefined();
    expect(threadIdForApp(undefined, "app-a")).toBeUndefined();
  });
});

describe("resolveAppContext", () => {
  const appThread = "thread-app-a";
  const bot = {
    id: "bot-1",
    threadId: "active",
    tasks: [{ threadId: appThread, workspaceContext: { appRef: { id: "app-a" } } }],
  };
  // The same bot after the task-switch ack: its active thread IS the app thread.
  const switched = { ...bot, threadId: appThread };
  const base: AppContextInput = {
    selectedAppId: "app-a",
    selectedId: "bot-1",
    selectionChanged: false,
    groups: [],
    bots: [bot],
    viewedThreadId: null,
  };

  it("keeps the App when a bot is opened in it, and yields the matrix", () => {
    // openBotInApp: select with the pin set to the app thread.
    expect(resolveAppContext({ ...base, selectionChanged: true, viewedThreadId: appThread })).toEqual({
      selectedAppId: "app-a",
      yieldMatrix: true,
    });
  });

  it("keeps the App after the task-switch ack clears the pin", () => {
    // The ack nulls the pin on purpose and the bot's active thread is now the app thread.
    // Reading the null pin as "left the App" cleared the highlight and the keyboard routing.
    expect(resolveAppContext({ ...base, bots: [switched], viewedThreadId: null })).toEqual({
      selectedAppId: "app-a",
      yieldMatrix: false,
    });
  });

  it("drops the App when the same bot is on a thread outside it", () => {
    expect(resolveAppContext({ ...base, viewedThreadId: null }).selectedAppId).toBeNull();
    expect(resolveAppContext({ ...base, viewedThreadId: "some-other-thread" }).selectedAppId).toBeNull();
  });

  it("drops the App when another bot is picked from the list, and yields the matrix", () => {
    expect(
      resolveAppContext({
        ...base,
        bots: [bot, { id: "bot-2", threadId: appThread }],
        selectedId: "bot-2",
        selectionChanged: true,
      }),
    ).toEqual({ selectedAppId: null, yieldMatrix: true });
  });

  it("does not close the matrix overview on a frame that leaves the selection alone", () => {
    // An SSE frame replaces `bots` and re-runs the effect; the overview the user opened must stay.
    expect(resolveAppContext({ ...base, selectedAppId: null, bots: [{ ...bot }] }).yieldMatrix).toBe(false);
    expect(resolveAppContext({ ...base, bots: [switched] }).yieldMatrix).toBe(false);
  });

  it("leaves a selected App group and an unknown selection alone", () => {
    const groups = [{ id: "app-a", dm: false }];
    expect(resolveAppContext({ ...base, groups, selectedId: "app-a" }).selectedAppId).toBe("app-a");
    expect(resolveAppContext({ ...base, selectedId: "missing" }).selectedAppId).toBe("app-a");
    expect(resolveAppContext({ ...base, selectedId: null }).yieldMatrix).toBe(false);
  });
});

describe("shownThreadId", () => {
  it("prefers the pin and falls back to the active thread", () => {
    expect(shownThreadId({ threadId: "active" }, "pinned")).toBe("pinned");
    expect(shownThreadId({ threadId: "active" }, null)).toBe("active");
    expect(shownThreadId({}, null)).toBeUndefined();
  });
});
