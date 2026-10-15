import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { HelperCard } from "./HelperCard";

const message = (over: Partial<Message> = {}): Message =>
  ({
    id: "m1",
    at: 1_000,
    role: "bot",
    kind: "activity",
    tool: { name: "Task", target: "Survey files", itemId: "task-1" },
    ...over,
  }) as Message;

const html = (row: Message) => renderToStaticMarkup(createElement(HelperCard, { message: row, now: 4_000 }));

describe("HelperCard", () => {
  it("replaces a Task row with the helper's name, activity, tools, tokens and duration", () => {
    const rendered = html(message({
      helper: {
        fidelity: "typed",
        depth: 1,
        label: "Survey files",
        lastActivity: "Read notes.md",
        toolCount: 2,
        tokens: 1098,
        status: "running",
        startedAt: 1_000,
        endedAt: null,
      },
    }));
    expect(rendered).toContain('data-testid="helper-card"');
    expect(rendered).toContain('data-status="running"');
    expect(rendered).toContain("Helper");
    expect(rendered).toContain("Survey files");
    expect(rendered).toContain("Read notes.md");
    expect(rendered).toContain("2 tools · 1,098 tokens · 3s");
    expect(rendered).toContain("Working");
    expect(rendered).toContain("motion-safe:animate-pulse");
  });

  it("says when the helper failed, and draws nothing for an ordinary step", () => {
    const failed = html(message({
      tool: { name: "spawn_agent", ok: false },
      helper: {
        fidelity: "typed",
        depth: 1,
        label: "list files",
        toolCount: 1,
        status: "failed",
        startedAt: 1_000,
        endedAt: 2_000,
      },
    }));
    expect(failed).toContain("Failed");
    expect(failed).toContain('data-status="failed"');
    expect(html(message({ tool: { name: "Read", ok: true, parentItemId: "task-1" } }))).toBe("");
  });
});
