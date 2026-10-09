// The step watch: auto-review for engines that act without asking
// (Antigravity print mode, Box Agent, pi's own tools, a full-auto instance).
// What it may promise is narrower than a card, so these pin the promise:
//
//   - Watch records the reviewer's opinion of each step and changes nothing.
//   - On stops the running turn when the reviewer refuses a step, and says so.
//   - A refusal that arrives after the turn ended is a flag, never a stop.
//   - Reads and planning are not reviewed; an unknown kind is.
//   - Nothing reviewed means nothing claimed: no verdict is logged as skipped.
import { describe, expect, it, vi } from "vitest";

import type { Reviewer, ReviewOutcome } from "./auto-review.ts";
import type { DecisionRow } from "./decision-log.ts";
import { MAX_PENDING_STEPS, ReviewWatch, watchesKind, type WatchPlan, type WatchedStep } from "./review-watch.ts";

const reviewer: Reviewer = {
  instanceId: "claude",
  name: "Claude Code",
  role: "fallback",
  review: async () => "",
};

function harness(verdicts: Array<{ allow: boolean; reason: string } | null>, options: { running?: boolean } = {}) {
  const rows: Array<Omit<DecisionRow, "at">> = [];
  const notes: Array<{ threadId: string; text: string; ok: boolean }> = [];
  const stops: Array<{ threadId: string; botId: string }> = [];
  const asked: string[] = [];
  let running = options.running ?? true;
  const watch = new ReviewWatch({
    turnRunning: () => running,
    stopTurn: (threadId, botId) => stops.push({ threadId, botId }),
    note: (threadId, text, ok) => notes.push({ threadId, text, ok }),
    log: (row) => rows.push(row),
    review: vi.fn(async (_reviewers, request): Promise<ReviewOutcome | null> => {
      asked.push(request.summary);
      expect(request.timing).toBe("after");
      const verdict = verdicts.shift() ?? null;
      return verdict ? { verdict, reviewer } : null;
    }),
  });
  return {
    watch,
    rows,
    notes,
    stops,
    asked,
    endTurn: () => {
      running = false;
    },
  };
}

const plan = (mode: WatchPlan["mode"]): WatchPlan => ({
  botId: "bot-1",
  botName: "Scout",
  persona: "Scout",
  mode,
  reviewers: [reviewer],
});

const step = (target: string, patch: Partial<WatchedStep> = {}): WatchedStep => ({
  threadId: "thread-1",
  turnId: "turn-1",
  tool: "run_command",
  target,
  toolKind: "execute",
  ...patch,
});

describe("Watch records and changes nothing", () => {
  it("logs what the reviewer would have done for each step, in order", async () => {
    const h = harness([
      { allow: true, reason: "read-only listing" },
      { allow: false, reason: "deletes the build folder" },
    ]);
    h.watch.observe(step("ls -la"), plan("shadow"));
    h.watch.observe(step("rm -rf build"), plan("shadow"));
    await h.watch.settled();
    expect(h.asked).toEqual(["ls -la", "rm -rf build"]);
    expect(h.rows.map((row) => [row.decision, row.source, row.rule, row.reviewer])).toEqual([
      ["review-would-approve", "auto-review-watch", "read-only listing", "claude"],
      ["review-would-deny", "auto-review-watch", "deletes the build folder", "claude"],
    ]);
    expect(h.stops).toEqual([]);
    expect(h.notes).toEqual([]);
  });
});

describe("On stops the turn after a refused step", () => {
  it("stops the running turn, says who refused it and why, and logs the stop", async () => {
    const h = harness([{ allow: false, reason: "pushes to a shared branch" }]);
    h.watch.observe(step("git push --force"), plan("enforce"));
    await h.watch.settled();
    expect(h.stops).toEqual([{ threadId: "thread-1", botId: "bot-1" }]);
    expect(h.notes).toEqual([
      {
        threadId: "thread-1",
        text: "review stopped the turn after run_command (Claude Code): pushes to a shared branch",
        ok: false,
      },
    ]);
    expect(h.rows).toEqual([
      expect.objectContaining({
        decision: "review-stopped-turn",
        source: "auto-review",
        rule: "pushes to a shared branch",
        reviewer: "claude",
        botId: "bot-1",
        tool: "run_command",
        summary: "git push --force",
      }),
    ]);
  });

  it("lets an approved step through without a chip", async () => {
    const h = harness([{ allow: true, reason: "routine test run" }]);
    h.watch.observe(step("pnpm test"), plan("enforce"));
    await h.watch.settled();
    expect(h.stops).toEqual([]);
    expect(h.notes).toEqual([]);
    expect(h.rows[0]).toMatchObject({ decision: "review-would-approve", source: "auto-review-watch" });
  });

  it("drops the rest of a stopped turn and ignores its late steps", async () => {
    const h = harness([
      { allow: false, reason: "credential file" },
      { allow: true, reason: "never asked" },
    ]);
    h.watch.observe(step("cat ~/.ssh/id_rsa"), plan("enforce"));
    h.watch.observe(step("echo after"), plan("enforce"));
    await h.watch.settled();
    h.watch.observe(step("echo later"), plan("enforce"));
    await h.watch.settled();
    expect(h.asked).toEqual(["cat ~/.ssh/id_rsa"]);
    expect(h.stops).toHaveLength(1);
    // the next turn on the same thread is watched again
    h.watch.observe(step("echo next", { turnId: "turn-2" }), plan("enforce"));
    await h.watch.settled();
    expect(h.asked).toEqual(["cat ~/.ssh/id_rsa", "echo next"]);
  });

  it("flags a refusal that arrives after the turn ended instead of claiming a stop", async () => {
    const h = harness([{ allow: false, reason: "sends email" }], { running: false });
    h.watch.observe(step("send_email", { toolKind: "other" }), plan("enforce"));
    await h.watch.settled();
    expect(h.stops).toEqual([]);
    expect(h.notes[0]?.text).toBe("review flagged run_command after the turn ended (Claude Code): sends email");
    expect(h.rows[0]).toMatchObject({ decision: "review-would-deny", source: "auto-review-watch" });
  });
});

describe("what is watched", () => {
  it("reviews commands, edits, fetches, connected-app calls and unknown kinds, not reads or planning", () => {
    for (const kind of ["execute", "edit", "fetch", "other", undefined] as const) expect(watchesKind(kind)).toBe(true);
    for (const kind of ["read", "search", "think", "task", "notice"] as const) expect(watchesKind(kind)).toBe(false);
  });

  it("does nothing without a plan, with review off, or with no reviewer", async () => {
    const h = harness([{ allow: false, reason: "x" }]);
    h.watch.observe(step("rm -rf /"), null);
    h.watch.observe(step("rm -rf /"), plan("off"));
    h.watch.observe(step("rm -rf /"), { ...plan("enforce"), reviewers: [] });
    h.watch.observe(step("README.md", { toolKind: "read" }), plan("enforce"));
    await h.watch.settled();
    expect(h.asked).toEqual([]);
    expect(h.rows).toEqual([]);
  });

  it("logs a step nobody could review as skipped, and stops nothing", async () => {
    const h = harness([null]);
    h.watch.observe(step("make deploy"), plan("enforce"));
    await h.watch.settled();
    expect(h.stops).toEqual([]);
    expect(h.rows[0]).toMatchObject({ decision: "review-skipped", rule: "no reviewer answered" });
  });

  it("bounds the queue per thread and says which steps it skipped", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rows: Array<Omit<DecisionRow, "at">> = [];
    const watch = new ReviewWatch({
      turnRunning: () => true,
      stopTurn: () => {},
      note: () => {},
      log: (row) => rows.push(row),
      review: async () => {
        await gate;
        return { verdict: { allow: true, reason: "ok" }, reviewer };
      },
    });
    // one in review, MAX_PENDING_STEPS waiting, one over the line
    for (let i = 0; i < MAX_PENDING_STEPS + 2; i++) watch.observe(step(`echo ${i}`), plan("shadow"));
    expect(rows.filter((row) => row.decision === "review-skipped")).toHaveLength(1);
    release();
    await watch.settled();
    expect(rows.filter((row) => row.decision === "review-would-approve")).toHaveLength(MAX_PENDING_STEPS + 1);
  });
});
