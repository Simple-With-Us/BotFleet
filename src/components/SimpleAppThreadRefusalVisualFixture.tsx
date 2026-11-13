// Renders the Simple refusal a matrix cell, an App Deck chip, or a number
// shortcut shows, using the same plan the app uses.
import { useState } from "react";
import { planAppThreadOpen } from "@/lib/simple-app-thread-switch";
import type { TaskWorkspaceContext } from "../../shared/task-workspace-context";
import { SimpleAppThreadRefusal } from "./SimpleAppThreadRefusal";

const home: TaskWorkspaceContext = {
  kind: "local",
  appRef: { kind: "group", id: "app-home" },
  cwd: "/repo/home",
  capturedAt: 1,
};
const deck: TaskWorkspaceContext = {
  kind: "local",
  appRef: { kind: "group", id: "app-a" },
  cwd: "/repo/a",
  capturedAt: 1,
};

export default function SimpleAppThreadRefusalVisualFixture() {
  const [message, setMessage] = useState<string | null>(null);
  const open = () => {
    const plan = planAppThreadOpen({
      mode: "simple",
      appId: "app-a",
      bot: {
        threadId: "open-chat",
        tasks: [
          { threadId: "open-chat", title: "Today", workspaceContext: home },
          { threadId: "app-a-chat", title: "Build the deck", workspaceContext: deck },
        ],
      },
    });
    if (plan.action === "refuse") setMessage(plan.message);
  };
  return (
    <div data-testid="simple-app-thread-refusal-fixture" className="min-h-screen bg-app text-ink">
      <div className="flex h-9 items-center gap-1.5 border-b border-hairline/25 bg-app/40 px-3 text-[11px]">
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-ink-tertiary">
          BotFleet:
        </span>
        <button
          type="button"
          data-testid="simple-app-thread-chip"
          onClick={open}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-raised px-2 py-1 font-medium text-ink shadow-xs"
        >
          Build the deck
        </button>
      </div>
      {message && <SimpleAppThreadRefusal message={message} onDismiss={() => setMessage(null)} />}
    </div>
  );
}
