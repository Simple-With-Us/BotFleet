// What is worth interrupting someone for. The policy is small, so the
// tests are mostly about the cases where the answer is "stay quiet".
import { describe, expect, it } from "vitest";

import { buildNotification, summarize } from "./notify.ts";

const bot = { id: "bot-1", name: "Scout", threadId: "thread-1" };

describe("buildNotification", () => {
  it("names the bot and carries the detail, per kind", () => {
    expect(buildNotification("approval", bot, "thread-1", "rm -rf ./build")).toMatchObject({
      kind: "approval",
      botId: "bot-1",
      threadId: "thread-1",
      title: "Scout needs approval",
      body: "rm -rf ./build",
    });
    expect(buildNotification("question", bot, "thread-1", "which branch?")?.title).toBe("Scout has a question");
    expect(buildNotification("done", bot, "thread-1", "pushed the branch")?.title).toBe("Scout finished");
    expect(buildNotification("routine-failed", bot, "thread-1", "boom")?.title).toBe("Scout's routine failed");
  });

  it("stays silent for a bot whose notifications are off", () => {
    const quiet = { ...bot, notifications: false };
    for (const kind of ["approval", "question", "done", "routine-failed"] as const) {
      expect(buildNotification(kind, quiet, "thread-1", "anything")).toBeNull();
    }
    // absent means "not turned off" — older bot records predate the flag
    expect(buildNotification("approval", { ...bot, notifications: undefined }, "thread-1", "x")).not.toBeNull();
    expect(buildNotification("approval", { ...bot, notifications: true }, "thread-1", "x")).not.toBeNull();
  });

  it("does not buzz for a finish with nothing to say", () => {
    expect(buildNotification("done", bot, "thread-1", "   ")).toBeNull();
    expect(buildNotification("done", bot, "thread-1", "")).toBeNull();
    // ...but a blocked bot is worth knowing about even with a thin summary
    expect(buildNotification("approval", bot, "thread-1", "")).not.toBeNull();
  });

  it("uses the thread it was raised on, not the bot's current one", () => {
    // a routine runs a bot in a detached task; the notification has to open
    // that conversation, not whatever the bot happens to be showing
    expect(buildNotification("done", bot, "other-thread", "done")?.threadId).toBe("other-thread");
  });

  it("carries the bot's avatar when one is given", () => {
    const avatarUrl = "/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp";
    const frame = buildNotification("done", bot, "thread-1", "pushed the branch", { avatarUrl });
    expect(frame).toMatchObject({ botId: "bot-1", body: "pushed the branch", avatarUrl });

    // no profile image → the frame stays exactly as before
    expect(buildNotification("done", bot, "thread-1", "pushed")?.avatarUrl).toBeUndefined();
  });

  it("carries the request identity on the two kinds where one is waiting", () => {
    const extra = { requestId: "req-7", tool: "Bash" };
    for (const kind of ["approval", "question"] as const) {
      expect(buildNotification(kind, bot, "thread-1", "rm -rf ./build", extra)).toMatchObject({
        kind,
        requestId: "req-7",
        tool: "Bash",
      });
    }
  });

  it("refuses to put a request id on a frame where nothing is waiting", () => {
    // A `done` frame carrying a request id would invite a client to answer
    // a request that is already settled — so the builder drops it rather
    // than trusting every call site never to pass one.
    for (const kind of ["done", "routine-failed", "takeover"] as const) {
      const frame = buildNotification(kind, bot, "thread-1", "finished", { requestId: "req-7", tool: "Bash" });
      expect(frame?.requestId).toBeUndefined();
      expect(frame?.tool).toBeUndefined();
    }
  });

  it("leaves both fields absent for an older caller that passes neither", () => {
    // The phone falls back to resolving the thread's pending card when the
    // id is absent, so "absent" has to stay a real, reachable shape.
    const frame = buildNotification("approval", bot, "thread-1", "rm -rf ./build");
    expect(frame?.requestId).toBeUndefined();
    expect(frame?.tool).toBeUndefined();
    expect(Object.hasOwn(frame ?? {}, "requestId")).toBe(false);
  });
});

describe("summarize", () => {
  it("flattens a model's answer into one lock-screen line", () => {
    expect(summarize("line one\n\nline two")).toBe("line one line two");
    expect(summarize("before\n```js\nconst x = 1;\n```\nafter")).toBe("before after");
    expect(summarize("   padded   ")).toBe("padded");
  });

  it("clamps long text with an ellipsis", () => {
    const long = summarize("x".repeat(400));
    expect(long).toHaveLength(140);
    expect(long.endsWith("…")).toBe(true);
    expect(summarize("short")).toBe("short");
  });

  it("decodes HTML entities and &nbsp; sentence gap tokens", () => {
    expect(summarize("Sentence one.&nbsp; Sentence two.")).toBe("Sentence one. Sentence two.");
    expect(summarize("Tom &amp; Jerry &lt;friends&gt;")).toBe("Tom & Jerry <friends>");
    expect(summarize("Double&#160;gap and &#xA0;hex")).toBe("Double gap and hex");
    expect(summarize("say &quot;hello&#39;s&quot;")).toBe('say "hello\'s"');
    expect(summarize("use `run_command` here")).toBe("use run_command here");
  });
});
