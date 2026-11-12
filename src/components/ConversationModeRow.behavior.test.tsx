// The Workspace Arrangement card, clicked.
// The suite stays on the node environment (the store graph imports
// node:sqlite) and installs happy-dom before the component loads.

import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const happy = require("happy-dom");
  const win = new happy.Window({ url: "http://127.0.0.1:5199/" });
  const install: Array<[string, unknown]> = [
    ["window", win],
    ["document", win.document],
    ["HTMLElement", win.HTMLElement],
    ["HTMLButtonElement", win.HTMLButtonElement],
    ["Element", win.Element],
    ["Node", win.Node],
    ["Event", win.Event],
    ["MouseEvent", win.MouseEvent],
    ["MutationObserver", win.MutationObserver],
    ["getComputedStyle", win.getComputedStyle.bind(win)],
    ["requestAnimationFrame", win.requestAnimationFrame.bind(win)],
    ["cancelAnimationFrame", win.cancelAnimationFrame.bind(win)],
    ["IS_REACT_ACT_ENVIRONMENT", true],
  ];
  for (const [key, value] of install) Reflect.set(globalThis, key, value);
});

import { ConversationModeRow } from "./SettingsModal";
import { StoreContext, initialState, type AppState, type Bot, type ConfigStatus, type Task } from "@/state/store";
import type { TaskWorkspaceContext } from "../../shared/task-workspace-context";

function context(id: string, cwd: string): TaskWorkspaceContext {
  return { kind: "local", appRef: { kind: "group", id }, cwd, capturedAt: 1 };
}

const projectsConfig: ConfigStatus = {
  composio: { configured: false },
  box: { configured: false },
  vps: { configured: false, sshAlias: "" },
  rooms: { turnTimeoutMinutes: 5 },
  localVm: { mode: "shared", maxInstances: 1 },
  conversationMode: "projects",
  roomLabels: { singular: "Channel", plural: "Channels" },
};

function roster(tasks: Task[]): Bot[] {
  return [{
    id: "bot-1",
    threadId: tasks[0]?.threadId ?? "inbox",
    name: "Ada",
    title: "Ada",
    description: "",
    notifications: false,
    color: "blue",
    unread: false,
    modelSelection: { instanceId: "claude", model: "m" },
    messages: [],
    tasks,
  }];
}

function projectsState(bots: Bot[] = []): AppState {
  return { ...initialState, bots, config: projectsConfig };
}

function buttonNamed(name: string): HTMLButtonElement | undefined {
  const found = [...document.querySelectorAll("button")].find((button) => {
    const title = button.querySelector("div")?.textContent?.trim();
    return title === name || button.textContent?.trim() === name;
  });
  return found instanceof HTMLButtonElement ? found : undefined;
}

let root: Root | null = null;
const fetchMock = vi.fn();

function mount(state: AppState) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const value = {
    state,
    dispatch: () => {},
    flushBotPatches: async () => {},
    refreshInstances: async () => {},
  };
  act(() => {
    root!.render(createElement(StoreContext.Provider, { value }, createElement(ConversationModeRow)));
  });
}

async function click(name: string) {
  const button = buttonNamed(name);
  if (!button) throw new Error(`missing button ${name}`);
  await act(async () => {
    button.click();
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("ConversationModeRow merge offer", () => {
  it("offers Merge All Threads when every extra conversation can fold in", async () => {
    mount(projectsState(roster([
      { threadId: "inbox", title: "Inbox", createdAt: 1 },
      { threadId: "side", title: "Side work", createdAt: 2 },
    ])));
    await click("Simple");
    expect(buttonNamed("Merge All Threads")).toBeTruthy();
    expect(document.querySelector("[data-testid='simple-merge-refusal']")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a mixed-App merge before anything is saved, and names the conversation", async () => {
    mount(projectsState(roster([
      {
        threadId: "inbox",
        title: "Inbox",
        createdAt: 1,
        workspaceContext: context("app-a", "/work/app"),
      },
      {
        threadId: "bound",
        title: "Release notes",
        createdAt: 2,
        workspaceContext: context("app-b", "/work/app"),
      },
    ])));
    await click("Simple");
    const refusal = document.querySelector("[data-testid='simple-merge-refusal']");
    expect(refusal?.textContent).toContain("Release notes");
    expect(refusal?.textContent).toContain("workspace stayed as it is");
    expect(refusal?.textContent).toContain("different App");
    expect(buttonNamed("Merge All Threads")).toBeUndefined();
    expect(buttonNamed("Keep Them Out of the Sidebar")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the server's reason when a merge it offered is refused", async () => {
    const sentence = "“Release notes” cannot be combined with the open conversation, because it belongs to an App and the open conversation does not.\u00A0 Nothing was merged, and the workspace stayed as it is.\u00A0 You can switch to Simple without combining them, or stay here and open them.";
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: "Conflict",
      json: async () => ({ error: sentence }),
    });
    mount(projectsState(roster([
      { threadId: "inbox", title: "Inbox", createdAt: 1 },
      { threadId: "side", title: "Side work", createdAt: 2 },
    ])));
    await click("Simple");
    await click("Merge All Threads");
    const alert = document.querySelector("[data-testid='conversation-mode-error']");
    expect(alert?.textContent).toBe(sentence);
    expect(alert?.textContent).not.toMatch(/\b409\b/);
    expect(buttonNamed("Merge All Threads")).toBeTruthy();
  });

  it("does not show a status code when the refusal has no sentence", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: "Conflict",
      json: async () => ({}),
    });
    mount(projectsState());
    await click("Simple");
    await click("Merge All Threads");
    const alert = document.querySelector("[data-testid='conversation-mode-error']");
    expect(alert?.textContent).toContain("switch to Simple without combining them");
    expect(alert?.textContent).not.toMatch(/\b409\b/);
    expect(document.body.textContent).not.toContain("Conflict");
  });

  it("closes the offer after a merge that succeeds", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ conversationMode: "simple" }),
    });
    mount(projectsState(roster([
      { threadId: "inbox", title: "Inbox", createdAt: 1 },
      { threadId: "side", title: "Side work", createdAt: 2 },
    ])));
    await click("Simple");
    await click("Merge All Threads");
    expect(buttonNamed("Merge All Threads")).toBeUndefined();
    expect(document.querySelector("[data-testid='conversation-mode-error']")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ conversationMode: "simple", mergeThreads: true });
  });
});
