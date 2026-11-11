import { expect, it } from "vitest";
import { boundPromptSnapshot, boundStalePromptSnapshots, retainRoutineRuns } from "./routine-retention";

it("keeps an old active execution and its receipts beyond 2,000 newer terminal records", () => {
  const owner = { id: "owner", status: "running", createdAt: 1 };
  const child = { id: "child", status: "running", createdAt: 2, coalescedInto: "owner" };
  const history = Array.from({ length: 2001 }, (_, i) => ({ id: `done-${i}`, status: "completed", createdAt: i + 3 }));
  const input = [owner, child, ...history];
  const result = retainRoutineRuns(input, 2000);
  expect(result).toHaveLength(2002);
  expect(result.slice(0, 2)).toEqual([owner, child]);
  expect(result.some((run) => run.id === "done-0")).toBe(false);
  expect(input).toHaveLength(2003);
  expect(result[0]).toBe(owner);

  const settled = result.map((run) => ["owner", "child"].includes(run.id)
    ? { ...run, status: "failed", finishedAt: 4000 } : run);
  const pruned = retainRoutineRuns(settled, 2000);
  expect(pruned).toHaveLength(2000);
  expect(pruned.slice(0, 2).map((run) => run.id)).toEqual(["owner", "child"]);
});

it("trims the noisiest routine first so other routines keep their terminal history", () => {
  const noisyId = "routine-noisy";
  const quietBase = 10_000;
  const noisy = Array.from({ length: 1500 }, (_, i) => ({
    id: `noisy-${i}`,
    status: "completed",
    createdAt: quietBase + i,
    routineId: noisyId,
  }));
  const quiet = Array.from({ length: 10 }, (_, r) =>
    Array.from({ length: 60 }, (_, i) => ({
      id: `quiet-${r}-${i}`,
      status: "completed",
      createdAt: r * 100 + i,
      routineId: `routine-${r}`,
    })),
  ).flat();
  const input = [...noisy, ...quiet];
  const result = retainRoutineRuns(input, 2000);
  expect(result).toHaveLength(2000);
  expect(result.filter((run) => run.routineId === noisyId)).toHaveLength(1400);
  for (let r = 0; r < 10; r += 1) {
    expect(result.filter((run) => run.routineId === `routine-${r}`)).toHaveLength(60);
  }
  expect(input).toHaveLength(2100);
});

it("drops oldest terminal runs within a single routine exactly as global oldest-first would", () => {
  const routineId = "only-routine";
  const runs = Array.from({ length: 5 }, (_, i) => ({
    id: `run-${i}`,
    status: "completed",
    createdAt: i,
    routineId,
  }));
  expect(retainRoutineRuns(runs, 3).map((run) => run.id)).toEqual(["run-2", "run-3", "run-4"]);
  expect(runs).toHaveLength(5);
});

it("preserves a referenced owner and every queued or waiting receipt without expanding admission", () => {
  const runs = [
    { id: "owner", status: "completed", createdAt: 1 },
    { id: "child", status: "waiting", createdAt: 2, coalescedInto: "owner" },
    { id: "queued", status: "queued", createdAt: 3 },
    { id: "old", status: "cancelled", createdAt: 4 },
    { id: "new", status: "failed", createdAt: 5 },
  ];
  expect(retainRoutineRuns(runs, 1).map((run) => run.id)).toEqual(["owner", "child", "queued", "new"]);
});

const INSTRUCTIONS = /\[USER-CONFIGURED WEBHOOK INSTRUCTIONS\]\n([\s\S]*?)\n\[\/USER-CONFIGURED WEBHOOK INSTRUCTIONS\]/;
const EVENT_DATA = /\[UNTRUSTED WEBHOOK EVENT DATA\]\n([\s\S]*?)\n\[\/UNTRUSTED WEBHOOK EVENT DATA\]/;

function webhookPrompt(payload: string) {
  return [
    "Event: deploy.finished",
    "[USER-CONFIGURED WEBHOOK INSTRUCTIONS]",
    "Summarize the deploy.",
    "[/USER-CONFIGURED WEBHOOK INSTRUCTIONS]",
    "[UNTRUSTED WEBHOOK EVENT DATA]",
    payload,
    "[/UNTRUSTED WEBHOOK EVENT DATA]",
    "Reply in one paragraph.",
  ].join("\n");
}

it("bounds a webhook snapshot to a payload preview while keeping everything the UI parses", () => {
  const full = webhookPrompt("x".repeat(20_000));
  const bounded = boundPromptSnapshot(full, { dataChars: 500, maxChars: 4_000 });
  expect(bounded.length).toBeLessThan(800);
  expect(bounded.startsWith("Event: deploy.finished\n")).toBe(true);
  expect(bounded.endsWith("\nReply in one paragraph.")).toBe(true);
  expect(bounded.match(INSTRUCTIONS)?.[1]).toBe("Summarize the deploy.");
  const data = bounded.match(EVENT_DATA)?.[1] ?? "";
  expect(data.startsWith("x".repeat(500))).toBe(true);
  expect(data).toMatch(/\n…\[19500 more characters not kept in history\]$/);
  expect(boundPromptSnapshot(bounded, { dataChars: 500, maxChars: 4_000 })).toBe(bounded);
  expect(boundPromptSnapshot(webhookPrompt("short"))).toBe(webhookPrompt("short"));
});

it("caps a snapshot with no event block and stays put once capped", () => {
  const plain = "y".repeat(9_000);
  const capped = boundPromptSnapshot(plain, { dataChars: 500, maxChars: 4_000 });
  expect(capped.startsWith("y".repeat(4_000) + "\n…[5000 more characters not kept in history]")).toBe(true);
  expect(boundPromptSnapshot(capped, { dataChars: 500, maxChars: 4_000 })).toBe(capped);
});

it("bounds settled runs beyond the newest N and leaves active, receipt, and newest runs untouched", () => {
  const big = webhookPrompt("z".repeat(10_000));
  const runs = [
    { id: "running", status: "running", createdAt: 1, prompt: big },
    { id: "queued", status: "queued", createdAt: 2, prompt: big },
    { id: "old", status: "completed", createdAt: 3, finishedAt: 10, prompt: big },
    { id: "mid", status: "failed", createdAt: 4, finishedAt: 20, prompt: big },
    { id: "new", status: "completed", createdAt: 5, finishedAt: 30, prompt: big },
    { id: "receipt", status: "completed", createdAt: 0, finishedAt: 1, prompt: big },
    { id: "bare", status: "cancelled", createdAt: 6, finishedAt: 40 },
  ];
  expect(boundStalePromptSnapshots(runs, 2, ["receipt"])).toBe(1);
  expect(runs).toHaveLength(7);
  expect(runs.filter((run) => run.prompt === big).map((run) => run.id)).toEqual(["running", "queued", "mid", "new", "receipt"]);
  const old = runs.find((run) => run.id === "old")!;
  expect(old.prompt!.length).toBeLessThan(1_000);
  expect(old.prompt!.match(INSTRUCTIONS)?.[1]).toBe("Summarize the deploy.");
  expect(boundStalePromptSnapshots(runs, 2, ["receipt"])).toBe(0);
});

it("orders settled runs by finish time, falls back to creation, and rejects a negative limit", () => {
  const big = "q".repeat(9_000);
  const runs = [
    { id: "a", status: "completed", createdAt: 100, prompt: big },
    { id: "b", status: "completed", createdAt: 1, finishedAt: 50, prompt: big },
    { id: "c", status: "completed", createdAt: 2, finishedAt: 200, prompt: big },
  ];
  expect(boundStalePromptSnapshots(runs, 1)).toBe(2);
  expect(runs.filter((run) => run.prompt === big).map((run) => run.id)).toEqual(["c"]);
  expect(boundStalePromptSnapshots(runs, 0)).toBe(1);
  expect(runs.every((run) => run.prompt !== big && run.prompt!.length < 4_100)).toBe(true);
  expect(() => boundStalePromptSnapshots(runs, -1)).toThrow(RangeError);
});

it("keeps the full prompt on a settled owner while a waiting run still folds into it", () => {
  const big = "w".repeat(9_000);
  const runs = [
    { id: "owner", status: "completed", createdAt: 1, finishedAt: 1, prompt: big },
    { id: "child", status: "waiting", createdAt: 2, coalescedInto: "owner", prompt: big },
    { id: "later", status: "completed", createdAt: 3, finishedAt: 3, prompt: big },
  ];
  expect(boundStalePromptSnapshots(runs, 0)).toBe(1);
  expect(runs.map((run) => run.prompt === big)).toEqual([true, true, false]);
});
