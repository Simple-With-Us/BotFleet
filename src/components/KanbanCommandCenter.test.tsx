import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StoreContext, StoreProvider, initialState, type Bot, type Group } from "@/state/store";
import type { RoutineRun } from "@/lib/routines";
import {
  COLUMN_VISIBLE_CAP,
  KanbanCommandCenter,
  collapseAttentionCards,
  safeAvatarUrl,
  type KanbanCardItem,
} from "./KanbanCommandCenter";

describe("KanbanCommandCenter", () => {
  it("renders 4-column kanban command center without crashing", () => {
    const html = renderToStaticMarkup(
      createElement(
        StoreProvider,
        null,
        createElement(KanbanCommandCenter, {
          onSelectApp: () => {},
          onSelectBot: () => {},
          onOpenAppRoom: () => {},
        }),
      ),
    );

    expect(html).toContain("Attention Queue");
    expect(html).toContain("In Progress");
    expect(html).toContain("Ready &amp; Standby");
    expect(html).toContain("Completed");
    expect(html).toContain("Filter tasks, bots, or apps...");
  });

  it("sanitizes avatar URLs to app-owned attachments only", () => {
    expect(safeAvatarUrl("http://evil.com/pic.png")).toBeNull();
    expect(safeAvatarUrl("https://user:pass@evil.com/pic.png")).toBeNull();
    expect(safeAvatarUrl("javascript:alert(1)")).toBeNull();
    // Unapproved remote host — must not become a tracking pixel.
    expect(safeAvatarUrl("https://images.example.com/avatar.png")).toBeNull();
    // App-owned attachment path is the only allowed origin.
    expect(
      safeAvatarUrl("/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp"),
    ).toBe("/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp");
  });

  it("accepts onSelectBotInApp without crashing and renders the columns", () => {
    const html = renderToStaticMarkup(
      createElement(
        StoreProvider,
        null,
        createElement(KanbanCommandCenter, {
          onSelectApp: () => {},
          onSelectBot: () => {},
          onSelectBotInApp: () => {},
          onOpenAppRoom: () => {},
          filterAppId: null,
        }),
      ),
    );

    expect(html).toContain("Attention Queue");
    expect(html).toContain("Filter tasks, bots, or apps...");
  });
});

// The cases below render the board from a hand-built store, the way
// KanbanCommandCenterVisualFixture does.  Every bot has no `activity`, so a bot
// makes no card of its own and each count is a count of routine-run cards.
const NOW = 1_730_000_000_000;

function bot(id: string, name = id): Bot {
  return {
    id,
    threadId: `${id}-thread`,
    name,
    title: name,
    description: `${name} description.`,
    notifications: false,
    color: "blue",
    unread: false,
    modelSelection: { instanceId: "claude", model: "claude-sonnet" },
    messages: [],
  };
}

function group(id: string, name: string, memberIds: string[]): Group {
  return {
    id,
    threadId: `${id}-thread`,
    name,
    memberIds,
    defaultResponder: { kind: "everyone" },
    bulletin: "",
    unread: false,
    createdAt: NOW,
    messages: [],
  };
}

let runSeq = 0;
function run(overrides: Partial<RoutineRun> & Pick<RoutineRun, "routineId">): RoutineRun {
  runSeq += 1;
  const at = NOW - runSeq * 1000;
  return {
    id: `run-${runSeq}`,
    routineName: overrides.routineId,
    botId: "bot-1",
    runOn: "bot",
    scheduledFor: at,
    status: "failed",
    manual: false,
    createdAt: at,
    ...overrides,
  };
}

function renderBoard(runs: RoutineRun[]): string {
  const value = {
    state: {
      ...initialState,
      bots: [bot("bot-1", "Runner")],
      groups: [group("app-1", "Ops Console", ["bot-1"])],
      routineRuns: runs,
    },
    dispatch: () => {},
    flushBotPatches: async () => {},
    refreshInstances: async () => {},
  };
  return renderToStaticMarkup(
    createElement(
      StoreContext.Provider,
      { value },
      createElement(KanbanCommandCenter, {
        onSelectApp: () => {},
        onSelectBot: () => {},
        onOpenAppRoom: () => {},
      }),
    ),
  );
}

/** One column's markup: from its test id to the next column's. */
function columnHtml(html: string, column: string): string {
  const start = html.indexOf(`data-testid="kanban-column-${column}"`);
  if (start < 0) throw new Error(`no ${column} column in the markup`);
  const next = html.indexOf('data-testid="kanban-column-', start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}

/** Every card renders exactly one <h4>, so the headings are the cards. */
function cardCount(html: string, column: string): number {
  return (columnHtml(html, column).match(/<h4/g) ?? []).length;
}

describe("KanbanCommandCenter acknowledged runs", () => {
  it("drops failed and missed runs the Routines page already acknowledged", () => {
    const html = renderBoard([
      run({ routineId: "r-ack-failed", routineName: "Acknowledged Failure", status: "failed", seenAt: NOW }),
      run({ routineId: "r-ack-missed", routineName: "Acknowledged Miss", status: "missed", seenAt: NOW }),
      run({ routineId: "r-open", routineName: "Still Broken", status: "failed" }),
    ]);

    expect(html).not.toContain("Acknowledged Failure");
    expect(html).not.toContain("Acknowledged Miss");
    expect(html).toContain("Still Broken");
    expect(cardCount(html, "attention")).toBe(1);
    expect(html).toContain("1 Needs Action");
  });

  it("shows All Clear once every failure is acknowledged", () => {
    const html = renderBoard([
      run({ routineId: "r-1", status: "failed", seenAt: NOW }),
      run({ routineId: "r-2", status: "missed", seenAt: NOW }),
    ]);

    expect(cardCount(html, "attention")).toBe(0);
    expect(html).toContain("0 Needs Action");
    expect(html).toContain("No blocked bots or pending approvals.");
  });

  it("counts only the unacknowledged runs when a newer failure follows an acknowledged one", () => {
    const html = renderBoard([
      run({ routineId: "r-1", routineName: "Nightly", status: "failed", error: "first", seenAt: NOW }),
      run({ routineId: "r-1", routineName: "Nightly", status: "failed", error: "second" }),
    ]);

    expect(cardCount(html, "attention")).toBe(1);
    expect(html).toContain("second");
    // The acknowledged run is not a repeat anyone still has to read.
    expect(html).not.toMatch(/\+\d+ older/);
  });

  it("keeps a waiting approval even when it carries a seenAt, because it is not an acknowledgeable status", () => {
    const html = renderBoard([
      run({ routineId: "r-wait", routineName: "Needs You", status: "waiting", startedAt: NOW, seenAt: NOW }),
    ]);

    expect(cardCount(html, "attention")).toBe(1);
    expect(html).toContain("Needs You");
    expect(html).toContain("Approval Needed");
  });
});

describe("KanbanCommandCenter repeated runs", () => {
  it("makes one card for a routine that failed forty times, showing its newest failure", () => {
    const repeats = Array.from({ length: 40 }, (_, i) => {
      const at = NOW - (40 - i) * 60_000;
      return run({
        routineId: "r-docker",
        routineName: "GitHub UI Pass",
        status: "failed",
        error: `Start docker first (attempt ${i + 1})`,
        scheduledFor: at,
        finishedAt: at + 1_000,
      });
    });
    // Newest first, so the card cannot be right by luck of list order.
    const html = renderBoard([
      ...repeats.reverse(),
      run({ routineId: "r-other", routineName: "Other Routine", status: "failed" }),
    ]);

    expect(cardCount(html, "attention")).toBe(2);
    expect(html.match(/GitHub UI Pass/g)).toHaveLength(1);
    expect(html).toContain("+39 older");
    expect(html).toContain("attempt 40)");
    expect(html).not.toContain("attempt 39)");
    expect(html).not.toContain("attempt 1)");
    // The header counts cards, not the runs folded into them.
    expect(html).toContain("2 Needs Action");
  });

  it("folds a miss into the same routine's failures but keeps a pending approval on its own card", () => {
    const html = renderBoard([
      run({ routineId: "r-1", routineName: "Nightly", status: "failed", error: "it broke", scheduledFor: NOW - 3000, finishedAt: NOW - 3000 }),
      run({ routineId: "r-1", routineName: "Nightly", status: "missed", error: "it never ran", scheduledFor: NOW - 2000, finishedAt: NOW - 2000 }),
      run({ routineId: "r-1", routineName: "Nightly", status: "waiting", prompt: "needs a decision", scheduledFor: NOW - 1000, startedAt: NOW - 1000 }),
    ]);

    expect(cardCount(html, "attention")).toBe(2);
    expect(html).toContain("Approval Needed");
    // The miss is the newer of the two unanswered runs, so it stands in for both.
    expect(html).toContain("it never ran");
    expect(html).not.toContain("it broke");
    expect(html.match(/\+(\d+) older/g)).toEqual(["+1 older"]);
  });

  it("leaves a routine alone when it only has one unanswered run", () => {
    const html = renderBoard([run({ routineId: "r-1", routineName: "Nightly", status: "failed" })]);

    expect(cardCount(html, "attention")).toBe(1);
    expect(html).not.toMatch(/\+\d+ older/);
  });
});

describe("collapseAttentionCards", () => {
  const attentionCard = (r: RoutineRun): KanbanCardItem => ({
    id: `run-${r.id}`,
    column: "attention",
    title: r.routineName,
    statusText: r.status,
    statusKind: "danger",
    timestamp: r.finishedAt || r.scheduledFor,
    unblockValue: 80,
    rawRun: r,
  });

  it("keeps the newest run per routine and counts the rest, whatever the list order", () => {
    const oldest = run({ routineId: "r-1", scheduledFor: 1_000 });
    const middle = run({ routineId: "r-1", scheduledFor: 2_000 });
    const newest = run({ routineId: "r-1", scheduledFor: 3_000 });
    const other = run({ routineId: "r-2", scheduledFor: 1_500 });

    const out = collapseAttentionCards([middle, newest, other, oldest].map(attentionCard));

    expect(out.map((card) => card.rawRun?.id)).toEqual([newest.id, other.id]);
    expect(out[0].olderRuns).toBe(2);
    expect(out[1].olderRuns).toBeUndefined();
  });

  it("folds a manual run into its routine but never merges a webhook trigger that shares the id", () => {
    const scheduled = run({ routineId: "same-id", triggerSource: "schedule", scheduledFor: 1_000 });
    const manual = run({ routineId: "same-id", triggerSource: "manual", manual: true, scheduledFor: 2_000 });
    const hook = run({ routineId: "same-id", triggerSource: "webhook", webhookId: "same-id", scheduledFor: 3_000 });

    const out = collapseAttentionCards([scheduled, manual, hook].map(attentionCard));

    expect(out.map((card) => card.rawRun?.id).sort()).toEqual([manual.id, hook.id].sort());
    expect(out.find((card) => card.rawRun?.id === manual.id)?.olderRuns).toBe(1);
    expect(out.find((card) => card.rawRun?.id === hook.id)?.olderRuns).toBeUndefined();
  });

  it("passes through bot cards and runs that are not failed, missed or waiting, in order", () => {
    const botCard: KanbanCardItem = {
      id: "bot-dead-bot-1",
      column: "attention",
      title: "Runner crashed",
      statusText: "Dead / Crash",
      statusKind: "danger",
      timestamp: 5_000,
      unblockValue: 100,
    };
    const doneA = { ...attentionCard(run({ routineId: "r-1", status: "completed", scheduledFor: 1_000 })), column: "completed" as const };
    const doneB = { ...attentionCard(run({ routineId: "r-1", status: "completed", scheduledFor: 2_000 })), column: "completed" as const };

    const out = collapseAttentionCards([doneA, botCard, doneB]);

    expect(out).toEqual([doneA, botCard, doneB]);
  });

  it("does not mutate the cards it is given", () => {
    const a = attentionCard(run({ routineId: "r-1", scheduledFor: 1_000 }));
    const b = attentionCard(run({ routineId: "r-1", scheduledFor: 2_000 }));

    collapseAttentionCards([a, b]);

    expect(a.olderRuns).toBeUndefined();
    expect(b.olderRuns).toBeUndefined();
  });
});

describe("KanbanCommandCenter column paging", () => {
  it("shows one page of the Attention Queue and says how many are hidden", () => {
    const failing = Array.from({ length: 40 }, (_, i) =>
      run({ routineId: `r-fail-${i}`, routineName: `Failing ${i}`, status: "failed" }),
    );
    const html = renderBoard(failing);
    const attention = columnHtml(html, "attention");

    expect(cardCount(html, "attention")).toBe(COLUMN_VISIBLE_CAP);
    expect(attention).toContain(`Show ${COLUMN_VISIBLE_CAP} More`);
    expect(attention).toContain(`${40 - COLUMN_VISIBLE_CAP} hidden`);
    // The badge and the header strip still report the true total.
    expect(attention).toContain(">40</span>");
    expect(html).toContain("40 Needs Action");
  });

  it("pages In Progress, Ready and Completed too, and offers only what is left", () => {
    const many = (status: RoutineRun["status"], count: number) =>
      Array.from({ length: count }, (_, i) =>
        run({ routineId: `r-${status}-${i}`, routineName: `${status} ${i}`, status, startedAt: NOW - i * 1000 }),
      );
    const html = renderBoard([...many("running", 20), ...many("queued", 20), ...many("completed", 20)]);

    for (const column of ["in_progress", "ready", "completed"]) {
      expect(cardCount(html, column)).toBe(COLUMN_VISIBLE_CAP);
      expect(columnHtml(html, column)).toContain("Show 5 More");
      expect(columnHtml(html, column)).toContain("5 hidden");
      expect(columnHtml(html, column)).toContain(">20</span>");
    }
  });

  it("renders no paging control and no older-runs label while everything fits on one page", () => {
    const html = renderBoard([
      run({ routineId: "r-fail", status: "failed" }),
      run({ routineId: "r-wait", status: "waiting", startedAt: NOW }),
      run({ routineId: "r-run", status: "running", startedAt: NOW }),
      run({ routineId: "r-queued", status: "queued" }),
      run({ routineId: "r-done", status: "completed", finishedAt: NOW }),
    ]);

    expect(html).not.toMatch(/Show \d+ More/);
    expect(html).not.toMatch(/\d+ hidden/);
    expect(html).not.toMatch(/\+\d+ older/);
  });
});
