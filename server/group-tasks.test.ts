import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskWorkspaceContext } from "../shared/task-workspace-context.ts";

let home: string;

async function freshStore() {
  home = mkdtempSync(join(tmpdir(), "omb-group-tasks-"));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const { Store, UNTITLED_TASK } = await import("./store.ts");
  return { store: new Store(() => ({ instanceId: "claude", model: "m" })), Store, UNTITLED_TASK };
}

function context(groupId: string, cwd: string): TaskWorkspaceContext {
  return {
    kind: "local",
    appRef: { kind: "group", id: groupId },
    cwd,
    capturedAt: 1_700_000_000_000,
  };
}

function expectConflict(run: () => void): void {
  let error: unknown;
  try { run(); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ status: 409 });
}

afterEach(async () => {
  const { closeMessageDb } = await import("./message-db.ts");
  closeMessageDb();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("channel tasks", () => {
  it("gives a user-created channel one task while DMs stay single-threaded", async () => {
    const { store, UNTITLED_TASK } = await freshStore();
    const bot = store.createBot();
    const channel = store.createGroup("Product", [bot.id]);
    const dm = store.createGroup("DM", [bot.id], true);

    expect(store.groupTasks(channel.id)).toEqual([
      expect.objectContaining({ threadId: channel.threadId, title: UNTITLED_TASK }),
    ]);
    expect(store.groupTasks(dm.id)).toEqual([]);
    expect(store.createGroupTask(dm.id)).toBeNull();
  });

  it("keeps transcripts, pins, and folders isolated while switching", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const channel = store.createGroup("Product", [bot.id]);
    const first = channel.threadId;
    store.appendMessage(first, { role: "user", kind: "text", text: "Plan launch" });
    store.titleGroupTaskFromFirstMessage(channel.id, "Plan launch", first);
    store.patchGroup(channel.id, { cwd: "/tmp/product" });
    expect(store.pinGroupCwd(channel.id, first)).toBe("/tmp/product");
    store.patchGroup(channel.id, { pinnedMessageId: "launch-pin" });

    const second = store.createGroupTask(channel.id)!;
    expect(second.threadId).not.toBe(first);
    expect(store.group(channel.id)).toMatchObject({ threadId: second.threadId });
    expect(store.group(channel.id)?.pinnedCwd).toBeUndefined();
    expect(store.group(channel.id)?.pinnedMessageId).toBeUndefined();
    expect(store.messagesFor(second.threadId)).toEqual([]);

    store.appendMessage(second.threadId, { role: "user", kind: "text", text: "Audit onboarding" });
    store.titleGroupTaskFromFirstMessage(channel.id, "Audit onboarding", second.threadId);
    store.patchGroup(channel.id, { pinnedMessageId: "audit-pin" });

    expect(store.switchGroupTask(channel.id, first)).toMatchObject({
      threadId: first,
      pinnedCwd: "/tmp/product",
      pinnedMessageId: "launch-pin",
    });
    expect(store.messagesFor(first).some((message) => message.text === "Plan launch")).toBe(true);
    expect(store.groupTaskByThread(channel.id, second.threadId)).toMatchObject({
      title: "Audit onboarding",
      pinnedMessageId: "audit-pin",
    });
    expect(store.groupByThread(second.threadId)?.id).toBe(channel.id);
  });

  it("renames and deletes tasks but never removes the final conversation", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const channel = store.createGroup("Product", [bot.id]);
    const first = channel.threadId;
    const second = store.createGroupTask(channel.id)!;
    store.appendMessage(second.threadId, { role: "user", kind: "text", text: "private branch" });

    expect(store.renameGroupTask(channel.id, second.threadId, "  Research  ")?.title).toBe("Research");
    expect(store.deleteGroupTask(channel.id, second.threadId)).toMatchObject({ threadId: first });
    expect(store.messagesFor(second.threadId)).toEqual([]);
    expect(store.deleteGroupTask(channel.id, first)).toBeNull();
  });

  it("merges extra room threads into the active conversation", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const channel = store.createGroup("Product", [bot.id]);
    const first = channel.threadId;
    store.appendMessage(first, { role: "user", kind: "text", text: "room inbox" });
    const second = store.createGroupTask(channel.id, "Research")!;
    store.appendMessage(second.threadId, { role: "user", kind: "text", text: "research note" });
    store.switchGroupTask(channel.id, first);

    const stats = store.mergeAllExtraThreads();
    expect(stats).toEqual({ bots: 0, groups: 1, threads: 1 });
    expect(store.groupTasks(channel.id)).toHaveLength(1);
    expect(store.group(channel.id)!.threadId).toBe(first);
    const texts = store.messagesFor(first).map((message) => message.text);
    expect(texts).toContain("room inbox");
    expect(texts).toContain("research note");
  });

  it("preserves an App binding through bot and group transfers and a group reload", async () => {
    const { store, Store } = await freshStore();
    const originBot = store.createBot();
    const otherBot = store.createBot();
    const app = store.createGroup("Project App", [originBot.id, otherBot.id]);
    const otherGroup = store.createGroup("Archive", [originBot.id]);
    const snapshot = context(app.id, join(home, "checkout", "package"));
    const task = store.createTask(originBot.id, "Bound work", false, undefined, snapshot)!;
    store.appendMessage(task.threadId, { role: "user", kind: "text", text: "Keep this history" });

    expect(store.moveTaskToBot(originBot.id, task.threadId, otherBot.id)).not.toBeNull();
    expect(store.taskByThread(otherBot.id, task.threadId)?.workspaceContext).toEqual(snapshot);
    expectConflict(() => store.moveTaskToGroup(otherBot.id, task.threadId, otherGroup.id));
    expect(store.taskByThread(otherBot.id, task.threadId)?.workspaceContext).toEqual(snapshot);

    expect(store.moveTaskToGroup(otherBot.id, task.threadId, app.id)).not.toBeNull();
    expect(store.groupTaskByThread(app.id, task.threadId)?.workspaceContext).toEqual(snapshot);
    const reloaded = new Store(() => ({ instanceId: "claude", model: "m" }));
    expect(reloaded.groupTaskByThread(app.id, task.threadId)?.workspaceContext).toEqual(snapshot);

    expectConflict(() => store.moveGroupTask(app.id, task.threadId, otherGroup.id));
    expect(store.groupTaskByThread(app.id, task.threadId)?.workspaceContext).toEqual(snapshot);
    expect(store.groupTaskByThread(otherGroup.id, task.threadId)).toBeUndefined();
    expect(store.moveGroupTaskToBot(app.id, task.threadId, originBot.id)).not.toBeNull();
    expect(store.taskByThread(originBot.id, task.threadId)?.workspaceContext).toEqual(snapshot);
    expect(store.messagesFor(task.threadId).some((message) => message.text === "Keep this history")).toBe(true);
  });

  it("refuses to merge group tasks bound to different App directories without changing history", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const app = store.createGroup("Project App", [bot.id]);
    const first = store.createTask(bot.id, "Package A", false, undefined, context(app.id, join(home, "a")))!;
    const second = store.createTask(bot.id, "Package B", false, undefined, context(app.id, join(home, "b")))!;
    store.appendMessage(first.threadId, { role: "user", kind: "text", text: "First package" });
    store.appendMessage(second.threadId, { role: "user", kind: "text", text: "Second package" });
    expect(store.moveTaskToGroup(bot.id, first.threadId, app.id)).not.toBeNull();
    expect(store.moveTaskToGroup(bot.id, second.threadId, app.id)).not.toBeNull();
    const beforeFirst = structuredClone(store.messagesFor(first.threadId));
    const beforeSecond = structuredClone(store.messagesFor(second.threadId));
    const threadIds = store.groupTasks(app.id).map((task) => task.threadId);

    expectConflict(() => store.mergeGroupTasks(app.id, second.threadId, first.threadId));
    expect(store.groupTasks(app.id).map((task) => task.threadId)).toEqual(threadIds);
    expect(store.messagesFor(first.threadId)).toEqual(beforeFirst);
    expect(store.messagesFor(second.threadId)).toEqual(beforeSecond);
  });

  it("adopts a legacy channel thread without losing its folder or pin", async () => {
    const { store, Store } = await freshStore();
    const bot = store.createBot();
    const channel = store.createGroup("Legacy", [bot.id]);
    store.appendMessage(channel.threadId, { role: "user", kind: "text", text: "Prepare the report" });
    const legacy = store.group(channel.id)!;
    delete legacy.tasks;
    legacy.pinnedCwd = "/tmp/legacy";
    legacy.pinnedMessageId = "legacy-pin";
    store.patchGroup(channel.id, { name: "Legacy saved" });

    const reloaded = new Store(() => ({ instanceId: "claude", model: "m" }));
    expect(reloaded.groupTasks(channel.id)).toEqual([
      expect.objectContaining({
        threadId: channel.threadId,
        title: "Prepare the report",
        pinnedCwd: "/tmp/legacy",
        pinnedMessageId: "legacy-pin",
      }),
    ]);
  });
});
