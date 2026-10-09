import { describe, expect, it } from "vitest";
import { threadIdForApp } from "./task-app-thread";

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
