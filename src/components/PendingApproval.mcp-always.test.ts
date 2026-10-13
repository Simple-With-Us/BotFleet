// Write-shaped MCP always-allow must open ConfirmDialog before dispatching
// alwaysAllow.  happy-dom is installed before React loads (node test env).

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.fn();

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

vi.mock("@/state/store", () => ({
  useStore: () => ({ dispatch }),
}));

import { PendingApprovalActions, type Pending } from "./PendingApproval";

const bot = {
  id: "bot-1",
  name: "Test bot",
  modelSelection: { instanceId: "claude", model: "claude" },
  alwaysAllow: [] as string[],
};

const pending: Pending = {
  message: {
    id: "card-1",
    role: "bot",
    kind: "options",
    at: 1,
    card: {
      title: "Allow tool",
      subtitle: "create issue",
      options: ["Allow", "Deny"],
      requestId: "req-1",
      tool: "mcp__linear__create_issue",
      allowKey: "provider-tool:claude:linear:create_issue:abc123",
      allowKeyWarnWrite: true,
    },
  },
  requestId: "req-1",
  tool: "mcp__linear__create_issue",
  allowKey: "provider-tool:claude:linear:create_issue:abc123",
  allowKeyWarnWrite: true,
  detail: "create issue",
};

let root: Root | null = null;
let container: HTMLElement | null = null;

function renderActions() {
  if (!root) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => {
    root!.render(
      createElement(PendingApprovalActions, {
        pending,
        threadId: "thread-1",
        bot,
        onCancelTurn() {},
      }),
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  dispatch.mockClear();
});

describe("PendingApproval MCP always-allow", () => {
  it("confirms before remembering write-shaped MCP tools", () => {
    renderActions();
    const alwaysAllow = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Always allow");
    expect(alwaysAllow).toBeTruthy();
    act(() => alwaysAllow!.click());
    expect(document.getElementById("confirm-dialog-title")?.textContent).toBe("Always allow this write tool?");

    const confirm = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Always allow" && b.closest('[role="dialog"]'),
    );
    expect(confirm).toBeTruthy();
    act(() => confirm!.click());

    expect(dispatch).toHaveBeenCalledWith({
      type: "decideRequest",
      threadId: "thread-1",
      requestId: "req-1",
      behavior: "allow",
      message: undefined,
      alwaysAllow: { botId: "bot-1", key: pending.allowKey },
    });
  });
});
