// Tasks: a bot's separate contexts.
//
// The load-bearing property is isolation — each task keeps its own
// transcript AND its own provider session. If resume cursors leaked
// between tasks, a "fresh" task would silently resume the previous
// conversation, which is the exact thing tasks exist to prevent.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskWorkspaceContext } from "../shared/task-workspace-context.ts";

let home: string;

async function freshStore() {
  home = mkdtempSync(join(tmpdir(), "omb-tasks-"));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const { Store, UNTITLED_TASK, titleFromMessage } = await import("./store.ts");
  return { store: new Store(() => ({ instanceId: "claude", model: "m" })), Store, UNTITLED_TASK, titleFromMessage };
}

function context(groupId: string, cwd: string): TaskWorkspaceContext {
  return {
    kind: "local",
    appRef: { kind: "group", id: groupId },
    cwd,
    git: { checkoutRoot: join(home, "checkout"), branch: "feature", headCommit: "a".repeat(40) },
    capturedAt: 1_700_000_000_000,
  };
}

function expectConflict(run: () => void): void {
  let error: unknown;
  try { run(); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ status: 409 });
}

afterEach(async () => {
  // freshStore resets the module graph, so this closes the same SQLite
  // module instance that the freshly imported Store used.
  const { closeMessageDb } = await import("./message-db.ts");
  closeMessageDb();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("tasks", () => {
  it("gives every new bot one task pointing at its thread", async () => {
    const { store, UNTITLED_TASK } = await freshStore();
    const bot = store.createBot();
    expect(store.tasks(bot.id)).toHaveLength(1);
    expect(store.activeTask(bot.id)).toMatchObject({ threadId: bot.threadId, title: UNTITLED_TASK });
  });

  it("starts a new task on a fresh thread and makes it active", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const firstThread = bot.threadId;
    const task = store.createTask(bot.id)!;

    expect(task.threadId).not.toBe(firstThread);
    expect(store.bot(bot.id)!.threadId).toBe(task.threadId);
    expect(store.tasks(bot.id).map((t) => t.threadId)).toEqual([task.threadId, firstThread]);
    // a brand new context: nothing carried over from the greeting thread
    expect(store.messagesFor(task.threadId)).toHaveLength(0);
    expect(store.messagesFor(firstThread).length).toBeGreaterThan(0);
  });

  it("pins a new task to the current bot folder before its first turn", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    store.patchBot(bot.id, { cwd: "/tmp/project-a" });

    const task = store.createTask(bot.id)!;
    expect(task.cwd).toBe("/tmp/project-a");

    store.patchBot(bot.id, { cwd: "/tmp/project-b" });
    expect(store.pinTaskCwd(bot.id, task.threadId)).toBe("/tmp/project-a");
  });

  it("keeps an explicit App workspace snapshot when the bot folder changes and after reload", async () => {
    const { store, Store } = await freshStore();
    const bot = store.createBot();
    const app = store.createGroup("Project App", [bot.id]);
    const chosenCwd = join(home, "checkout", "package");
    const snapshot = context(app.id, chosenCwd);
    store.patchBot(bot.id, { cwd: chosenCwd });

    const task = store.createTask(bot.id, "Build package", true, undefined, snapshot)!;
    expect(task.workspaceContext).toEqual(snapshot);
    expect(task.cwd).toBe(chosenCwd);

    store.patchBot(bot.id, { cwd: join(home, "checkout-similar"), name: "Renamed bot" });
    store.patchGroup(app.id, { cwd: join(home, "checkout-other"), name: "Renamed App Section" });
    expect(store.pinTaskCwd(bot.id, task.threadId)).toBe(chosenCwd);
    expect(store.taskByThread(bot.id, task.threadId)?.workspaceContext).toEqual(snapshot);
    const beforeNone = structuredClone(store.taskByThread(bot.id, task.threadId));
    expect(() => store.pinTaskCwd(bot.id, task.threadId, undefined, { none: true })).toThrow();
    expect(store.taskByThread(bot.id, task.threadId)).toEqual(beforeNone);
    store.flushBotsNow();

    const reloaded = new Store(() => ({ instanceId: "claude", model: "m" }));
    expect(reloaded.taskByThread(bot.id, task.threadId)?.workspaceContext).toEqual(snapshot);
    expect(reloaded.taskByThread(bot.id, task.threadId)?.cwd).toBe(chosenCwd);
  });

  it("can create a detached routine task without changing the visible conversation", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const visibleThread = bot.threadId;
    const routineTask = store.createTask(bot.id, "Morning brief", false)!;

    expect(routineTask.threadId).not.toBe(visibleThread);
    expect(store.bot(bot.id)!.threadId).toBe(visibleThread);
    expect(store.botByThread(routineTask.threadId)?.id).toBe(bot.id);

    store.setResumeCursor(bot.id, "claude", "routine-session", routineTask.threadId);
    expect(store.taskByThread(bot.id, routineTask.threadId)?.resumeCursors.claude).toBe("routine-session");
    expect(store.activeTask(bot.id)?.resumeCursors.claude).toBeUndefined();
  });

  it("keeps provider sessions apart — the whole point of a task", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const first = bot.threadId;
    store.setResumeCursor(bot.id, "claude", "session-one");

    const second = store.createTask(bot.id)!;
    // the new task must NOT inherit the old session
    expect(store.activeTask(bot.id)!.resumeCursors.claude).toBeUndefined();
    store.setResumeCursor(bot.id, "claude", "session-two");

    store.switchTask(bot.id, first);
    expect(store.activeTask(bot.id)!.resumeCursors.claude).toBe("session-one");
    store.switchTask(bot.id, second.threadId);
    expect(store.activeTask(bot.id)!.resumeCursors.claude).toBe("session-two");
  });

  it("names a task after the first thing you asked it", async () => {
    const { store, UNTITLED_TASK, titleFromMessage } = await freshStore();
    const bot = store.createBot();
    store.createTask(bot.id);
    expect(store.activeTask(bot.id)!.title).toBe(UNTITLED_TASK);

    store.titleTaskFromFirstMessage(bot.id, "Audit the payroll spreadsheet\nand flag anything odd");
    expect(store.activeTask(bot.id)!.title).toBe("Audit the payroll spreadsheet");

    // only the first message names it
    store.titleTaskFromFirstMessage(bot.id, "something else entirely");
    expect(store.activeTask(bot.id)!.title).toBe("Audit the payroll spreadsheet");
    expect(titleFromMessage("x".repeat(80))).toHaveLength(48);
  });

  it("deletes a task with its transcript, but never the last one", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const first = bot.threadId;
    const second = store.createTask(bot.id)!;
    store.appendMessage(second.threadId, { role: "user", kind: "text", text: "secret" });

    expect(store.deleteTask(bot.id, second.threadId)).toBeTruthy();
    expect(store.tasks(bot.id)).toHaveLength(1);
    // deleting the ACTIVE task falls back to one that still exists
    expect(store.bot(bot.id)!.threadId).toBe(first);
    expect(store.messagesFor(second.threadId)).toHaveLength(0);

    expect(store.deleteTask(bot.id, first)).toBeNull();
  });

  it("merges one task's transcript into another and keeps the destination id", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const first = bot.threadId;
    store.appendMessage(first, { role: "user", kind: "text", text: "hello inbox" });
    const second = store.createTask(bot.id, "Side work")!;
    store.appendMessage(second.threadId, { role: "user", kind: "text", text: "side note" });

    const merged = store.mergeBotTasks(bot.id, second.threadId, first);
    expect(merged).toBeTruthy();
    expect(store.tasks(bot.id)).toHaveLength(1);
    expect(store.bot(bot.id)!.threadId).toBe(first);
    const texts = store.messagesFor(first).map((message) => message.text);
    expect(texts.some((text) => text?.includes("Merged"))).toBe(true);
    expect(texts).toContain("side note");
  });

  it("refuses an incompatible App task merge without changing transcripts or automation aliases", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const app = store.createGroup("Project App", [bot.id]);
    const plain = bot.threadId;
    const source = store.createTask(bot.id, "Automated work", false, "routine:app", context(app.id, join(home, "checkout")))!;
    store.taskByThread(bot.id, plain)!.automationKeyAliases = ["routine:existing"];
    store.appendMessage(plain, { role: "user", kind: "text", text: "Plain inbox" });
    store.appendMessage(source.threadId, { role: "user", kind: "text", text: "Bound work" });
    const beforePlain = structuredClone(store.messagesFor(plain));
    const beforeSource = structuredClone(store.messagesFor(source.threadId));

    expectConflict(() => store.mergeBotTasks(bot.id, source.threadId, plain));
    expect(store.tasks(bot.id).map((task) => task.threadId)).toContain(source.threadId);
    expect(store.messagesFor(plain)).toEqual(beforePlain);
    expect(store.messagesFor(source.threadId)).toEqual(beforeSource);
    expect(store.taskByThread(bot.id, plain)?.automationKeyAliases).toEqual(["routine:existing"]);
    expect(store.taskByAutomationKey(bot.id, "routine:app")?.threadId).toBe(source.threadId);
  });

  it("refuses a merge between tasks bound to different App groups", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const firstApp = store.createGroup("First App", [bot.id]);
    const secondApp = store.createGroup("Second App", [bot.id]);
    const cwd = join(home, "shared-checkout");
    const first = store.createTask(bot.id, "First App work", false, undefined, context(firstApp.id, cwd))!;
    const second = store.createTask(bot.id, "Second App work", false, undefined, context(secondApp.id, cwd))!;

    expectConflict(() => store.mergeBotTasks(bot.id, second.threadId, first.threadId));
    expect(store.taskByThread(bot.id, first.threadId)?.workspaceContext?.appRef.id).toBe(firstApp.id);
    expect(store.taskByThread(bot.id, second.threadId)?.workspaceContext?.appRef.id).toBe(secondApp.id);
  });

  it("allows a merge when App and directory match despite different Git labels", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const app = store.createGroup("Project App", [bot.id]);
    const cwd = join(home, "checkout");
    const first = store.createTask(bot.id, "First", false, undefined, context(app.id, cwd))!;
    const later = { ...context(app.id, cwd), capturedAt: 1_800_000_000_000, git: undefined };
    const second = store.createTask(bot.id, "Second", false, undefined, later)!;

    expect(store.mergeBotTasks(bot.id, second.threadId, first.threadId)).not.toBeNull();
    expect(store.taskByThread(bot.id, first.threadId)?.workspaceContext).toEqual(context(app.id, cwd));
  });

  it("preflights every task before a bulk merge changes any transcript", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const app = store.createGroup("Project App", [bot.id]);
    const inbox = bot.threadId;
    const plain = store.createTask(bot.id, "Plain extra", false)!;
    const bound = store.createTask(bot.id, "Bound extra", false, undefined, context(app.id, join(home, "checkout")))!;
    store.appendMessage(inbox, { role: "user", kind: "text", text: "Inbox" });
    store.appendMessage(plain.threadId, { role: "user", kind: "text", text: "Plain" });
    store.appendMessage(bound.threadId, { role: "user", kind: "text", text: "Bound" });
    const beforeInbox = structuredClone(store.messagesFor(inbox));
    const beforePlain = structuredClone(store.messagesFor(plain.threadId));
    const beforeBound = structuredClone(store.messagesFor(bound.threadId));

    expectConflict(() => store.mergeAllExtraThreads());
    expect(store.tasks(bot.id)).toHaveLength(3);
    expect(store.messagesFor(inbox)).toEqual(beforeInbox);
    expect(store.messagesFor(plain.threadId)).toEqual(beforePlain);
    expect(store.messagesFor(bound.threadId)).toEqual(beforeBound);
  });

  it("keeps the App workspace on automation rollover after the bot folder changes", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const app = store.createGroup("Project App", [bot.id]);
    const snapshot = context(app.id, join(home, "checkout"));
    store.patchBot(bot.id, { cwd: snapshot.cwd });
    const previous = store.createTask(bot.id, "Nightly build", false, "routine:build", snapshot)!;
    store.patchBot(bot.id, { cwd: join(home, "unrelated") });

    const rolled = store.rolloverAutomationTask(bot.id, "routine:build", { activate: false })!;
    expect(rolled.threadId).not.toBe(previous.threadId);
    expect(rolled.cwd).toBe(snapshot.cwd);
    expect(rolled.workspaceContext).toEqual(snapshot);
    expect(store.taskByThread(bot.id, previous.threadId)?.workspaceContext).toEqual(snapshot);
  });

  it("merges every extra bot thread into the active conversation", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const first = bot.threadId;
    store.appendMessage(first, { role: "user", kind: "text", text: "inbox" });
    const second = store.createTask(bot.id, "Side work")!;
    store.appendMessage(second.threadId, { role: "user", kind: "text", text: "side note" });
    store.switchTask(bot.id, first);
    const third = store.createTask(bot.id, "Later work")!;
    store.appendMessage(third.threadId, { role: "user", kind: "text", text: "later note" });
    store.switchTask(bot.id, first);

    const stats = store.mergeAllExtraThreads();
    expect(stats).toEqual({ bots: 1, groups: 0, threads: 2 });
    expect(store.tasks(bot.id)).toHaveLength(1);
    expect(store.bot(bot.id)!.threadId).toBe(first);
    const texts = store.messagesFor(first).map((message) => message.text);
    expect(texts).toContain("inbox");
    expect(texts).toContain("side note");
    expect(texts).toContain("later note");
  });

  it("adopts a pre-tasks bot's endless thread as its first task", async () => {
    const { store, UNTITLED_TASK } = await freshStore();
    const bot = store.createBot();
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Plan the offsite" });
    // simulate a record saved before tasks existed
    const legacy = store.bot(bot.id)!;
    delete (legacy as { tasks?: unknown }).tasks;
    // patchBot marks the roster dirty and the shutdown flush writes it, so
    // what lands on disk is the pre-tasks shape
    store.patchBot(bot.id, { resumeCursors: { claude: "old-session" } });
    store.flushBotsNow();

    const { Store } = await import("./store.ts");
    const reloaded = new Store(() => ({ instanceId: "claude", model: "m" }));
    const migrated = reloaded.tasks(bot.id);
    expect(migrated).toHaveLength(1);
    expect(migrated[0]).toMatchObject({ threadId: bot.threadId, resumeCursors: { claude: "old-session" } });
    // and it is named from the conversation rather than left blank
    expect(migrated[0]!.title).not.toBe(UNTITLED_TASK);
  });
});
