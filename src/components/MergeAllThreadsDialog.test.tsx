// SSR style, as the rest of this repo's component tests do (see
// HistoryCompressionField.test.tsx): `renderToStaticMarkup` is the DOM-free
// path.  The dialog takes the bot as a prop and reads only `dispatch` from
// the store, so a bare StoreProvider is enough to mount it here.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StoreProvider, type Bot } from "@/state/store";
import type { TaskWorkspaceContext } from "../../shared/task-workspace-context";
import { MergeAllThreadsDialog } from "./MergeAllThreadsDialog";

const context: TaskWorkspaceContext = {
  kind: "local",
  appRef: { kind: "group", id: "app-a" },
  cwd: "/repo-a",
  capturedAt: 1,
};

const bot = (tasks: Array<{
  threadId: string;
  title: string;
  createdAt: number;
  startedAt?: number;
  messageCount?: number;
  workspaceContext?: TaskWorkspaceContext;
}>): Bot => ({
  id: "bot-1",
  threadId: tasks[0]!.threadId,
  name: "Juniper",
  title: "Juniper",
  description: "A bot with several conversations.",
  notifications: false,
  color: "blue",
  unread: false,
  modelSelection: { instanceId: "claude", model: "claude-sonnet" },
  messages: [],
  tasks: tasks.map((task) => ({ ...task })),
});

const render = (target: Bot): string =>
  renderToStaticMarkup(
    createElement(
      StoreProvider,
      null,
      createElement(MergeAllThreadsDialog, { bot: target, onClose: () => {} }),
    ),
  );

describe("MergeAllThreadsDialog", () => {
  it("lists every conversation with how much it holds", () => {
    const html = render(
      bot([
        { threadId: "old", title: "The long history", createdAt: 1_000, messageCount: 4_211 },
        { threadId: "new", title: "Recent work", createdAt: 9_000, messageCount: 12 },
      ]),
    );

    expect(html).toContain("Merge All Threads");
    expect(html).toContain("The long history");
    expect(html).toContain("Recent work");
    expect(html).toContain("4,211");
    expect(html).toContain("12");
  });

  it("offers the oldest conversation as the destination by default", () => {
    const html = render(
      bot([
        { threadId: "old", title: "The long history", createdAt: 1_000, messageCount: 10 },
        { threadId: "new", title: "Recent work", createdAt: 9_000, messageCount: 2 },
      ]),
    );

    // A merge appends the other transcripts to the destination, so the
    // oldest one is the default: the merged text then reads in order.
    const oldRadio = html.match(/<input[^>]*value="old"[^>]*>/)?.[0] ?? "";
    const newRadio = html.match(/<input[^>]*value="new"[^>]*>/)?.[0] ?? "";
    expect(oldRadio).toContain("checked");
    expect(newRadio).not.toContain("checked");
  });

  it("says how many conversations will be folded in, and that it cannot be undone", () => {
    const html = render(
      bot([
        { threadId: "old", title: "The long history", createdAt: 1_000, messageCount: 10 },
        { threadId: "new", title: "Recent work", createdAt: 9_000, messageCount: 2 },
        { threadId: "newer", title: "Today's work", createdAt: 12_000, messageCount: 1 },
      ]),
    );

    expect(html).toContain("2 conversations will be folded into");
    expect(html).toContain("The long history");
    expect(html).toContain("cannot be undone");
  });

  it("uses the singular for one conversation", () => {
    const html = render(
      bot([
        { threadId: "old", title: "The long history", createdAt: 1_000, messageCount: 10 },
        { threadId: "new", title: "Recent work", createdAt: 9_000, messageCount: 2 },
      ]),
    );

    expect(html).toContain("1 conversation will be folded into");
  });

  it("counts only the conversations that will actually move, and names the ones that stay", () => {
    const html = render(
      bot([
        { threadId: "old", title: "The long history", createdAt: 1_000, messageCount: 10 },
        { threadId: "new", title: "Recent work", createdAt: 9_000, messageCount: 2 },
        { threadId: "bound", title: "App work", createdAt: 10_000, messageCount: 3, workspaceContext: context },
      ]),
    );

    // The App-bound conversation cannot fold into an unbound destination,
    // so the preview must not promise it: it says what will move and names
    // what stays where it is.
    expect(html).toContain("1 conversation will be folded into");
    expect(html).toContain("Staying where they are");
    expect(html).toContain("App work");
  });

  it("orders the conversations by when they first spoke, not by when the task was created", () => {
    const html = render(
      bot([
        { threadId: "created-first", title: "Created first", createdAt: 1_000, startedAt: 9_000, messageCount: 1 },
        { threadId: "spoke-first", title: "Spoke first", createdAt: 5_000, startedAt: 2_000, messageCount: 1 },
      ]),
    );

    // "Spoke first" began earlier, so it is the default destination even
    // though its task was created later — the server folds transcripts in
    // the order they began.
    const spokeFirst = html.match(/<input[^>]*value="spoke-first"[^>]*>/)?.[0] ?? "";
    expect(spokeFirst).toContain("checked");
  });
});
