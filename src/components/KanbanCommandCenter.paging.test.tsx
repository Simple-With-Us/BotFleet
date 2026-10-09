// Client render of the board's Show More control.  Static markup cannot click,
// and the behaviour that matters is what a click does:  a capped column grows by
// one page, the count of hidden cards falls, and the control goes away once
// nothing is hidden.  The suite stays on the node environment (the store graph
// imports node:sqlite) and installs a DOM before React loads.

import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const happy = require("happy-dom");
  const win = new happy.Window({ url: "http://127.0.0.1:5199/" });
  const install: Array<[string, unknown]> = [
    ["window", win],
    ["document", win.document],
    ["HTMLElement", win.HTMLElement],
    ["Element", win.Element],
    ["Node", win.Node],
    ["Event", win.Event],
    ["MouseEvent", win.MouseEvent],
    ["MutationObserver", win.MutationObserver],
    ["DOMException", win.DOMException],
    ["getComputedStyle", win.getComputedStyle.bind(win)],
    ["requestAnimationFrame", win.requestAnimationFrame.bind(win)],
    ["cancelAnimationFrame", win.cancelAnimationFrame.bind(win)],
    ["IS_REACT_ACT_ENVIRONMENT", true],
  ];
  for (const [key, value] of install) Reflect.set(globalThis, key, value);
});

import { StoreContext, initialState, type Bot, type Group } from "@/state/store";
import type { RoutineRun } from "@/lib/routines";
import { COLUMN_VISIBLE_CAP, KanbanCommandCenter } from "./KanbanCommandCenter";

const NOW = 1_730_000_000_000;

const bot: Bot = {
  id: "bot-1",
  threadId: "bot-1-thread",
  name: "Runner",
  title: "Runner",
  description: "Runner description.",
  notifications: false,
  color: "blue",
  unread: false,
  modelSelection: { instanceId: "claude", model: "claude-sonnet" },
  messages: [],
};

const app: Group = {
  id: "app-1",
  threadId: "app-1-thread",
  name: "Ops Console",
  memberIds: ["bot-1"],
  defaultResponder: { kind: "everyone" },
  bulletin: "",
  unread: false,
  createdAt: NOW,
  messages: [],
};

function failingRuns(count: number): RoutineRun[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `run-${i}`,
    routineId: `routine-${i}`,
    routineName: `Failing ${i}`,
    botId: "bot-1",
    runOn: "bot" as const,
    scheduledFor: NOW - i * 1000,
    status: "failed" as const,
    manual: false,
    createdAt: NOW - i * 1000,
  }));
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = undefined;
  host = undefined;
});

function mount(runs: RoutineRun[], handlers: { onSelectBotInApp?: (botId: string, appId: string) => void } = {}) {
  const value = {
    state: { ...initialState, bots: [bot], groups: [app], routineRuns: runs },
    dispatch: () => {},
    flushBotPatches: async () => {},
    refreshInstances: async () => {},
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      createElement(
        StoreContext.Provider,
        { value },
        createElement(KanbanCommandCenter, {
          onSelectApp: () => {},
          onSelectBot: () => {},
          onOpenAppRoom: () => {},
          ...handlers,
        }),
      ),
    );
  });
  return host;
}

function column(container: HTMLElement, id: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-testid="kanban-column-${id}"]`);
  if (!found) throw new Error(`no ${id} column was rendered`);
  return found;
}

const cards = (container: HTMLElement, id: string) => column(container, id).querySelectorAll("h4");

const showMoreButton = (container: HTMLElement, id: string) =>
  Array.from(column(container, id).querySelectorAll("button")).find((button) =>
    /^Show \d+ More$/.test(button.textContent ?? ""),
  );

function click(element: HTMLElement) {
  act(() => {
    element.click();
  });
}

describe("KanbanCommandCenter Show More", () => {
  it("reveals one page per click, then goes away once nothing is hidden", () => {
    const container = mount(failingRuns(40));
    expect(cards(container, "attention")).toHaveLength(COLUMN_VISIBLE_CAP);
    expect(showMoreButton(container, "attention")?.textContent).toBe("Show 15 More");
    expect(column(container, "attention").textContent).toContain("25 hidden");

    click(showMoreButton(container, "attention")!);
    expect(cards(container, "attention")).toHaveLength(COLUMN_VISIBLE_CAP * 2);
    expect(showMoreButton(container, "attention")?.textContent).toBe("Show 10 More");
    expect(column(container, "attention").textContent).toContain("10 hidden");

    click(showMoreButton(container, "attention")!);
    expect(cards(container, "attention")).toHaveLength(40);
    expect(showMoreButton(container, "attention")).toBeUndefined();
    expect(column(container, "attention").textContent).not.toContain("hidden");
  });

  it("pages each column on its own", () => {
    const completed = Array.from({ length: 20 }, (_, i) => ({
      ...failingRuns(1)[0],
      id: `done-${i}`,
      routineId: `done-routine-${i}`,
      routineName: `Done ${i}`,
      status: "completed" as const,
      finishedAt: NOW - i * 1000,
    }));
    const container = mount([...failingRuns(40), ...completed]);

    click(showMoreButton(container, "completed")!);

    expect(cards(container, "completed")).toHaveLength(20);
    expect(showMoreButton(container, "completed")).toBeUndefined();
    // Completed paging did not touch the Attention Queue.
    expect(cards(container, "attention")).toHaveLength(COLUMN_VISIBLE_CAP);
  });

  it("keeps a card click opening the bot in its app, and the paging control out of that path", () => {
    const opened: Array<[string, string]> = [];
    const container = mount(failingRuns(40), {
      onSelectBotInApp: (botId, appId) => opened.push([botId, appId]),
    });

    click(showMoreButton(container, "attention")!);
    expect(opened).toEqual([]);

    click(cards(container, "attention")[0]);
    expect(opened).toEqual([["bot-1", "app-1"]]);
  });
});
