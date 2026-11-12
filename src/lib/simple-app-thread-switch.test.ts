import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { TaskWorkspaceContext } from "../../shared/task-workspace-context";
import { planAppThreadOpen, simpleAppThreadRefusal, type AppThreadOpenBot } from "./simple-app-thread-switch";

const here = dirname(fileURLToPath(import.meta.url));

function context(appId: string, cwd: string): TaskWorkspaceContext {
  return { kind: "local", appRef: { kind: "group", id: appId }, cwd, capturedAt: 1 };
}

function bot(): AppThreadOpenBot {
  return {
    threadId: "open-chat",
    tasks: [
      { threadId: "open-chat", title: "Today", workspaceContext: context("app-home", "/repo/home") },
      { threadId: "app-a-chat", title: "Build the deck", workspaceContext: context("app-a", "/repo/a") },
      { threadId: "app-a-other", title: "Notes", workspaceContext: context("app-a", "/repo/a/notes") },
    ],
  };
}

const REFUSAL =
  "“Build the deck” cannot be opened from here, because it belongs to a different App than the open conversation.\u00A0 Nothing was switched, and the open conversation stayed as it is.\u00A0 Switch to Projects in Settings to open it.";

describe("planAppThreadOpen", () => {
  it("lets Projects make a different App conversation the open one", () => {
    expect(planAppThreadOpen({ mode: "projects", bot: bot(), appId: "app-a" })).toEqual({
      action: "show",
      threadId: "app-a-chat",
      activate: true,
    });
  });

  it("does not activate when the bot is already on that conversation", () => {
    const current = bot();
    current.threadId = "app-a-chat";
    expect(planAppThreadOpen({ mode: "projects", bot: current, appId: "app-a" })).toEqual({
      action: "show",
      threadId: "app-a-chat",
      activate: false,
    });
    expect(planAppThreadOpen({ mode: "simple", bot: current, appId: "app-a" })).toEqual({
      action: "show",
      threadId: "app-a-chat",
      activate: false,
    });
  });

  it("refuses a saved App conversation in Simple and leaves the open one alone", () => {
    expect(planAppThreadOpen({ mode: "simple", bot: bot(), appId: "app-a" })).toEqual({
      action: "refuse",
      message: REFUSAL,
    });
  });

  it("switches nothing and refuses nothing while the workspace arrangement is unknown", () => {
    // /api/config has not answered (or failed):  refusing would mislead a
    // Projects user, and activating would move a Simple user's open
    // conversation, so the bot's open conversation stays on screen.
    expect(planAppThreadOpen({ mode: null, bot: bot(), appId: "app-a" })).toEqual({
      action: "show",
      threadId: bot().threadId,
      activate: false,
    });
  });

  it("shows the open conversation when it serves the same App and folder as the saved one", () => {
    const samePlace: AppThreadOpenBot = {
      threadId: "app-a-second",
      tasks: [
        { threadId: "app-a-chat", title: "Build the deck", workspaceContext: context("app-a", "/repo/a") },
        { threadId: "app-a-second", title: "Deck notes", workspaceContext: context("app-a", "/repo/a") },
      ],
    };
    expect(planAppThreadOpen({ mode: "simple", bot: samePlace, appId: "app-a" })).toEqual({
      action: "show",
      threadId: "app-a-second",
      activate: false,
    });
  });

  it("names a different folder inside the same App", () => {
    const otherFolder: AppThreadOpenBot = {
      threadId: "app-a-other",
      tasks: [
        { threadId: "app-a-chat", title: "Build the deck", workspaceContext: context("app-a", "/repo/a") },
        { threadId: "app-a-other", title: "Notes", workspaceContext: context("app-a", "/repo/a/notes") },
      ],
    };
    expect(planAppThreadOpen({ mode: "simple", bot: otherFolder, appId: "app-a" })).toEqual({
      action: "refuse",
      message:
        "“Build the deck” cannot be opened from here, because it runs in a different folder.\u00A0 Nothing was switched, and the open conversation stayed as it is.\u00A0 Switch to Projects in Settings to open it.",
    });
  });

  it("says the saved conversation belongs to an App when the open one does not", () => {
    const plain: AppThreadOpenBot = {
      threadId: "open-chat",
      tasks: [
        { threadId: "open-chat", title: "Today" },
        { threadId: "app-a-chat", title: "Build the deck", workspaceContext: context("app-a", "/repo/a") },
      ],
    };
    expect(planAppThreadOpen({ mode: "simple", bot: plain, appId: "app-a" })).toEqual({
      action: "refuse",
      message:
        "“Build the deck” cannot be opened from here, because it belongs to an App and the open conversation does not.\u00A0 Nothing was switched, and the open conversation stayed as it is.\u00A0 Switch to Projects in Settings to open it.",
    });
  });

  it("keeps the open conversation when the App has no saved one", () => {
    expect(planAppThreadOpen({ mode: "simple", bot: bot(), appId: "app-missing" })).toEqual({
      action: "show",
      threadId: "open-chat",
      activate: false,
    });
  });

  it("shows nothing to activate when the bot is missing", () => {
    expect(planAppThreadOpen({ mode: "simple", bot: null, appId: "app-a" })).toEqual({
      action: "show",
      threadId: undefined,
      activate: false,
    });
  });

  it("uses a plain title when the saved conversation has none", () => {
    expect(simpleAppThreadRefusal("  ", "belongs to another App")).toContain("“New task”");
    expect(simpleAppThreadRefusal("Build the deck", "belongs to another App")).toBe(REFUSAL);
  });

  it("keeps the refusal in everyday words", () => {
    const fallback = simpleAppThreadRefusal("Old notes", "unrecognized");
    expect(REFUSAL).toContain("\u00A0 ");
    expect(REFUSAL).not.toMatch(/switchTask|threadId|coordinator|Eavesdropper|Operator|Muster|hidden App|mode-gated/i);
    expect(REFUSAL).not.toContain("&nbsp;");
    expect(fallback).toContain("because it belongs to a different App or runs in a different folder.");
    expect(simpleAppThreadRefusal("Old notes", "is not bound to an App")).toContain(
      "because it is not tied to an App and the open conversation is.",
    );
  });
});

describe("app thread entry points", () => {
  const appSrc = readFileSync(join(here, "../App.tsx"), "utf8");
  const matrixSrc = readFileSync(join(here, "../components/FleetMatrixView.tsx"), "utf8");
  const deckSrc = readFileSync(join(here, "../components/AppDeck.tsx"), "utf8");

  it("sends the matrix, the App Deck, and the number shortcuts through one Simple gate", () => {
    expect(appSrc.match(/openBotInApp\(/g)).toHaveLength(4);
    expect(appSrc.match(/type: "switchTask"/g)).toHaveLength(1);
    expect(appSrc).toContain("planAppThreadOpen");
    expect(appSrc).toContain("plan.activate && plan.threadId && !b?.busy");
    expect(appSrc).toContain("<SimpleAppThreadRefusal");
    expect(matrixSrc).not.toContain("switchTask");
    expect(deckSrc).not.toContain("switchTask");
    expect(matrixSrc).toContain("onSelectBotInApp(bot.id, group.id)");
    expect(deckSrc).toContain("onSelectBotInApp(b.id, activeAppId)");
  });
});
