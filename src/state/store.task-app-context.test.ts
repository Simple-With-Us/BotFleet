import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskWorkspaceContext } from "../../shared/task-workspace-context";
import { eligibleTaskApps } from "@/lib/task-app-context";
import { initialState, reducer, StoreProvider, useStore, type Action, type AppState, type Bot, type Group } from "./store";

const context: TaskWorkspaceContext = {
  kind: "local",
  appRef: { kind: "group", id: "app-a" },
  cwd: "/repo-a/packages/web",
  capturedAt: 1,
};

function fixture(): AppState {
  const bot: Bot = {
    id: "bot-a", threadId: "bound-task", name: "Builder", title: "", description: "",
    notifications: true, color: "blue", unread: false,
    modelSelection: { instanceId: "codex", model: "gpt" }, messages: [],
    tasks: [
      { threadId: "bound-task", title: "Build", createdAt: 1, cwd: context.cwd, workspaceContext: context },
      { threadId: "legacy-task", title: "Unassigned", createdAt: 2 },
      { threadId: "plain-task", title: "Also unassigned", createdAt: 3 },
    ],
  };
  const group: Group = {
    id: "app-a", name: "App A", threadId: "room-task", memberIds: [bot.id], cwd: "/new-default",
    defaultResponder: { kind: "member", botId: bot.id }, bulletin: "", unread: false, createdAt: 1,
    messages: [], tasks: [{ threadId: "room-task", title: "Room", createdAt: 1 }],
  };
  return { ...initialState, config: { composio: { configured: false }, box: { configured: false }, vps: { configured: false, sshAlias: "" }, rooms: { turnTimeoutMinutes: 10 }, localVm: { mode: "shared", maxInstances: 1 }, conversationMode: "projects" }, bots: [bot], groups: [group, { ...group, id: "app-b", name: "App B" }] };
}

describe("App task creation and local continuity", () => {
  it("offers only member rooms with explicit folders without changing the folder", () => {
    expect(eligibleTaskApps("bot-a", [
      { id: "eligible", name: "Eligible", memberIds: ["bot-a"], cwd: "/repo/nested" },
      { id: "dm", name: "DM", memberIds: ["bot-a"], cwd: "/repo", dm: true },
      { id: "other", name: "Other", memberIds: ["bot-b"], cwd: "/repo" },
      { id: "unset", name: "Unset", memberIds: ["bot-a"] },
      { id: "empty", name: "Empty", memberIds: ["bot-a"], cwd: "  " },
    ])).toEqual([{ id: "eligible", name: "Eligible", cwd: "/repo/nested" }]);
  });

  it("opens and cancels the chooser without selecting a different running task", () => {
    const state = fixture();
    const opened = reducer(state, { type: "requestNewTask", botId: "bot-a" });
    expect(opened.taskCreationBotId).toBe("bot-a");
    expect(opened.bots).toBe(state.bots);
    const cancelled = reducer(opened, { type: "cancelNewTask" });
    expect(cancelled.taskCreationBotId).toBeNull();
    expect(cancelled.bots).toBe(state.bots);
    const busy = { ...state, bots: state.bots.map((bot) => ({ ...bot, busy: true })) };
    expect(reducer(busy, { type: "requestNewTask", botId: "bot-a" })).toBe(busy);
    const unassigned = { ...state, groups: [] };
    expect(reducer(unassigned, { type: "requestNewTask", botId: "bot-a" })).toBe(unassigned);
  });

  it("refuses the chooser in Simple mode and dismisses it when that mode arrives", () => {
    const state = fixture();
    const simpleConfig = { ...state.config!, conversationMode: "simple" as const };
    const simple = { ...state, config: simpleConfig };
    expect(reducer(simple, { type: "requestNewTask", botId: "bot-a" })).toBe(simple);
    const opened = reducer(state, { type: "requestNewTask", botId: "bot-a" });
    const changed = reducer(opened, { type: "configStatus", config: simpleConfig });
    expect(changed.taskCreationBotId).toBeNull();
    expect(changed.bots).toBe(state.bots);
  });

  it("does not optimistically remove a task whose App merge or room move will be refused", () => {
    const state = fixture();
    expect(reducer(state, { type: "mergeTasks", botId: "bot-a", threadId: "bound-task", intoThreadId: "legacy-task" })).toBe(state);
    expect(reducer(state, { type: "moveTaskToGroup", botId: "bot-a", threadId: "bound-task", toGroupId: "app-b" })).toBe(state);
  });

  it("folds the mergeable conversations into the chosen one and keeps the App-bound one", () => {
    const state = fixture();
    const merged = reducer(state, { type: "mergeAllBotTasks", botId: "bot-a", intoThreadId: "legacy-task" });
    const bot = merged.bots.find((candidate) => candidate.id === "bot-a")!;
    // the plain conversation folds in; the App-bound one cannot, so it stays
    // and the roster agrees with what the server will report.
    expect(bot.tasks!.map((task) => task.threadId)).toEqual(["bound-task", "legacy-task"]);
    expect(bot.threadId).toBe("legacy-task");
  });

  it("takes the server's own list of what is left after a merge", () => {
    const state = fixture();
    // the server is the one that knows what stayed behind, so the roster
    // takes its answer rather than the optimistic guess
    const applied = reducer(state, {
      type: "mergeApplied",
      botId: "bot-a",
      threadId: "legacy-task",
      tasks: [{ threadId: "legacy-task", title: "Unassigned", createdAt: 2 }],
    });
    const bot = applied.bots.find((candidate) => candidate.id === "bot-a")!;
    expect(bot.tasks!.map((task) => task.threadId)).toEqual(["legacy-task"]);
    expect(bot.threadId).toBe("legacy-task");
  });

  it("takes a folded transcript in one piece", () => {
    const state = fixture();
    const messages = [
      { id: "m-1", at: 10, role: "user" as const, kind: "text" as const, text: "first" },
      { id: "m-2", at: 11, role: "user" as const, kind: "text" as const, text: "second" },
    ];
    const added = reducer(state, { type: "messagesAdded", threadId: "bound-task", messages });
    const bot = added.bots.find((candidate) => candidate.id === "bot-a")!;
    // the whole batch lands at once, and the branch head is its last message
    expect(bot.messages.map((message) => message.id)).toEqual(["m-1", "m-2"]);
    expect(bot.activeLeafId).toBe("m-2");
    // a second copy of the same batch changes nothing
    expect(reducer(added, { type: "messagesAdded", threadId: "bound-task", messages })).toBe(added);
  });

  it("refuses a merge-all whose destination is not one of the bot's conversations", () => {
    const state = fixture();
    expect(reducer(state, { type: "mergeAllBotTasks", botId: "bot-a", intoThreadId: "no-such-thread" })).toBe(state);
    expect(reducer(state, { type: "mergeAllBotTasks", botId: "bot-b", intoThreadId: "legacy-task" })).toBe(state);
  });

  it("preserves saved context through a room round-trip and refuses another App", () => {
    const moved = reducer(fixture(), { type: "moveTaskToGroup", botId: "bot-a", threadId: "bound-task", toGroupId: "app-a" });
    expect(moved.groups.find((group) => group.id === "app-a")?.tasks?.find((task) => task.threadId === "bound-task"))
      .toMatchObject({ pinnedCwd: context.cwd, workspaceContext: context });
    expect(reducer(moved, { type: "moveGroupTask", groupId: "app-a", threadId: "bound-task", toGroupId: "app-b" })).toBe(moved);
    const returned = reducer(moved, { type: "moveGroupTaskToBot", groupId: "app-a", threadId: "bound-task", botId: "bot-a" });
    expect(returned.bots.find((bot) => bot.id === "bot-a")?.tasks?.find((task) => task.threadId === "bound-task"))
      .toMatchObject({ cwd: context.cwd, workspaceContext: context });
  });
});

function clientDispatch(): (action: Action) => void {
  let dispatch: ((action: Action) => void) | undefined;
  function Probe() {
    dispatch = useStore().dispatch;
    return null;
  }
  renderToStaticMarkup(createElement(StoreProvider, null, createElement(Probe)));
  if (!dispatch) throw new Error("Store provider did not render");
  return dispatch;
}

describe("App task creation request", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([context.appRef, undefined])("sends only the optional App reference, leaving folder resolution to the server", async (appRef) => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    clientDispatch()({ type: "newTask", botId: "bot-a", appRef });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/bots/bot-a/tasks");
    expect(JSON.parse(String(init?.body))).toEqual(appRef ? { appRef } : {});
  });
});
