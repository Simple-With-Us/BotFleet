// What a restart is allowed to re-send, and what it must not.
//
// The shapes under test are the ones that cost real money on the owner's Mac:
// a clean SIGTERM that looked exactly like a crash, a marker left behind by a
// turn that had already answered, a resume that failed and was retried by
// every boot afterwards, and a fleet of bots all re-dispatching at once 2.5 s
// after start (audit HS18/HS20).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BOOT_RESUME_TOTAL_CAP,
  forgetResumeFailure,
  inspectLastTurn,
  interruptedTurnsPath,
  planBootRecovery,
  provisionalStopClassification,
  readInterruptedTurns,
  reconcileRecoveryClassification,
  recordInterruptedTurns,
  rememberResumeFailure,
  settledStopClassification,
  runStaggeredResumes,
  takeInterruptedTurns,
  type BootRecoveryCandidate,
} from "./boot-recovery.ts";
import { classifyResumeFailure, mayReplay } from "./resume-recovery.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function rig() {
  const root = mkdtempSync(join(tmpdir(), "bf-boot-recovery-"));
  roots.push(root);
  const eventsDir = join(root, "events");
  mkdirSync(eventsDir, { recursive: true });
  const writeEvents = (threadId: string, events: Array<Record<string, unknown>>) => {
    writeFileSync(
      join(eventsDir, `${threadId}.ndjson`),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
  };
  return { root, eventsDir, writeEvents };
}

function candidate(patch: Partial<BootRecoveryCandidate> = {}): BootRecoveryCandidate {
  return {
    botId: "bot-1",
    botName: "Scout",
    threadId: "thread-1",
    recorded: false,
    outcome: "in-flight",
    classification: "before-accept",
    resumableSession: false,
    failedBefore: false,
    ...patch,
  };
}

describe("the accept-boundary classifier", () => {
  it("lets output outrank everything and treats an unproven turn as after-accept", () => {
    expect(
      classifyResumeFailure({ attempted: true, rejected: true, promptSubmitted: false, producedOutput: true }),
    ).toBe("after-accept");
    expect(
      classifyResumeFailure({ attempted: true, rejected: true, promptSubmitted: false, producedOutput: false }),
    ).toBe("before-accept");
    expect(
      classifyResumeFailure({ attempted: false, rejected: false, promptSubmitted: false, producedOutput: false }),
    ).toBe("unknown");
    expect(mayReplay("before-accept")).toBe(true);
    expect(mayReplay("unknown")).toBe(false);
    expect(mayReplay("after-accept")).toBe(false);
  });
});

describe("reading the last turn out of a thread's event log", () => {
  it("calls a turn that answered completed, so a stale marker never re-spends it", () => {
    const { eventsDir, writeEvents } = rig();
    writeEvents("t1", [
      { type: "turn.started", threadId: "t1" },
      { type: "item.completed", itemType: "assistant_text", threadId: "t1" },
      { type: "turn.completed", ok: true, threadId: "t1" },
    ]);
    expect(inspectLastTurn(eventsDir, "t1").outcome).toBe("completed");
  });

  it("calls a turn that ended badly failed, not resumable", () => {
    const { eventsDir, writeEvents } = rig();
    writeEvents("t1", [{ type: "turn.started" }, { type: "turn.completed", ok: false }]);
    expect(inspectLastTurn(eventsDir, "t1").outcome).toBe("failed");
  });

  it("reads a turn that produced output as after-accept", () => {
    const { eventsDir, writeEvents } = rig();
    writeEvents("t1", [
      { type: "turn.completed", ok: true },
      { type: "turn.started" },
      { type: "item.started", itemType: "tool", title: "Bash" },
      { type: "thread.token-usage.updated", input: 10, output: 2 },
    ]);
    const seen = inspectLastTurn(eventsDir, "t1");
    expect(seen.outcome).toBe("in-flight");
    expect(seen.state.producedOutput).toBe(true);
    expect(seen.classification).toBe("after-accept");
  });

  it("reads a real session id as proof the prompt was submitted", () => {
    const { eventsDir, writeEvents } = rig();
    writeEvents("t1", [
      { type: "turn.started" },
      { type: "session.started", sessionId: "abc-123" },
    ]);
    expect(inspectLastTurn(eventsDir, "t1").classification).toBe("after-accept");
  });

  it("does not read openai-compat's null session id as proof of anything", () => {
    const { eventsDir, writeEvents } = rig();
    writeEvents("t1", [
      { type: "turn.started" },
      { type: "session.started", sessionId: null },
    ]);
    const seen = inspectLastTurn(eventsDir, "t1");
    expect(seen.state.promptSubmitted).toBe(false);
    expect(seen.classification).toBe("unknown");
  });

  it("reads an engine that never started as before-accept, the one replayable shape", () => {
    const { eventsDir, writeEvents } = rig();
    writeEvents("t1", [
      { type: "turn.started" },
      { type: "runtime.error", setup: true, message: "claude: command not found" },
    ]);
    const seen = inspectLastTurn(eventsDir, "t1");
    expect(seen.outcome).toBe("failed");
    expect(seen.classification).toBe("before-accept");
  });

  it("treats a missing log as interrupted rather than finished", () => {
    const { eventsDir } = rig();
    const seen = inspectLastTurn(eventsDir, "never-written");
    expect(seen.outcome).toBe("in-flight");
    expect(seen.classification).toBe("unknown");
  });

  it("reads only the tail, and never half a record", () => {
    const { eventsDir, writeEvents } = rig();
    const filler = Array.from({ length: 400 }, (_, i) => ({
      type: "item.completed",
      itemType: "tool",
      itemId: `old-${i}`,
      padding: "x".repeat(200),
    }));
    writeEvents("t1", [
      { type: "turn.started" },
      ...filler,
      { type: "turn.completed", ok: true },
    ]);
    // A window far smaller than the file still finds the newest turn event,
    // and the torn first line does not throw.
    expect(inspectLastTurn(eventsDir, "t1", 512).outcome).toBe("completed");
  });
});

describe("a stop that reads the log while accept evidence is still queued", () => {
  // The canonical event log is drained by a queued writer, so a SIGTERM
  // handler can read a turn's log while its provider-accept events are still
  // in memory.  Before the provisional/settled split, that read was recorded
  // as-is and the next boot preferred it over the drained log — re-sending a
  // prompt the provider had already accepted.
  const setupFailure = [{ type: "turn.started" }, { type: "runtime.error", setup: true, message: "transient" }];
  const queuedAccept = [{ type: "session.started", sessionId: "provider-session" }, { type: "item.started", itemType: "text" }];
  const bootPlan = (eventsDir: string, root: string, patch: Partial<BootRecoveryCandidate> = {}) => {
    const recorded = takeInterruptedTurns(root).turns.find((turn) => turn.threadId === "t1");
    const inspected = inspectLastTurn(eventsDir, "t1");
    return planBootRecovery([
      candidate({
        threadId: "t1",
        recorded: Boolean(recorded),
        outcome: recorded && inspected.outcome === "failed" ? "in-flight" : inspected.outcome,
        classification: reconcileRecoveryClassification(recorded?.classification, inspected.classification),
        ...patch,
      }),
    ]);
  };
  const replays = (plan: ReturnType<typeof planBootRecovery>) =>
    plan.resume.filter((dispatch) => dispatch.action === "replay").map((dispatch) => dispatch.candidate.threadId);

  it("records a pre-drain before-accept as unknown, then settles on the accept the drain revealed — no replay", () => {
    const { root, eventsDir, writeEvents } = rig();
    writeEvents("t1", setupFailure);
    const early = inspectLastTurn(eventsDir, "t1").classification;
    expect(early).toBe("before-accept"); // the tempting, wrong answer
    const provisional = provisionalStopClassification(early);
    expect(provisional).toBe("unknown");
    expect(mayReplay(provisional)).toBe(false);
    recordInterruptedTurns(root, [{ botId: "bot-1", threadId: "t1", at: 1, reason: "shutdown", classification: provisional }]);

    // The writer drains: the accept evidence lands behind the stop's read.
    writeEvents("t1", [...setupFailure, ...queuedAccept]);
    const settled = settledStopClassification(provisional, inspectLastTurn(eventsDir, "t1").classification);
    expect(settled).toBe("after-accept");
    recordInterruptedTurns(root, [{ botId: "bot-1", threadId: "t1", at: 1, reason: "shutdown", classification: settled }]);

    const plan = bootPlan(eventsDir, root);
    expect(replays(plan)).toEqual([]);
    expect(plan.notify.map((turn) => turn.threadId)).toEqual(["t1"]);
  });

  it("does not replay when the stop's drain never finished, even though the partial log looks replayable", () => {
    const { root, eventsDir, writeEvents } = rig();
    writeEvents("t1", setupFailure);
    const provisional = provisionalStopClassification(inspectLastTurn(eventsDir, "t1").classification);
    recordInterruptedTurns(root, [{ botId: "bot-1", threadId: "t1", at: 1, reason: "shutdown", classification: provisional }]);
    // No settle: the grace period expired first.  The log on disk still reads
    // before-accept, but the record says the stop could not tell.
    expect(inspectLastTurn(eventsDir, "t1").classification).toBe("before-accept");
    const plan = bootPlan(eventsDir, root, { resumableSession: true });
    expect(replays(plan)).toEqual([]);
    // It still resumes the provider's own session rather than re-sending.
    expect(plan.resume.map((dispatch) => dispatch.action)).toEqual(["continue"]);
  });

  it("never lets a before-accept record outrank accept evidence in the flushed log", () => {
    const { root, eventsDir, writeEvents } = rig();
    // An older build wrote its pre-drain reading straight into the record.
    recordInterruptedTurns(root, [{ botId: "bot-1", threadId: "t1", at: 1, reason: "shutdown", classification: "before-accept" }]);
    writeEvents("t1", [...setupFailure, ...queuedAccept]);
    const plan = bootPlan(eventsDir, root, { resumableSession: true });
    expect(replays(plan)).toEqual([]);
    expect(plan.resume.map((dispatch) => dispatch.action)).toEqual(["continue"]);
  });

  it("still replays a turn the drained log proves never reached the provider", () => {
    const { root, eventsDir, writeEvents } = rig();
    writeEvents("t1", setupFailure);
    const provisional = provisionalStopClassification(inspectLastTurn(eventsDir, "t1").classification);
    // Drained, and nothing was queued: the setup failure really was the end.
    const settled = settledStopClassification(provisional, inspectLastTurn(eventsDir, "t1").classification);
    expect(settled).toBe("before-accept");
    recordInterruptedTurns(root, [{ botId: "bot-1", threadId: "t1", at: 1, reason: "shutdown", classification: settled }]);
    expect(replays(bootPlan(eventsDir, root))).toEqual(["t1"]);
  });

  it("never gives back an accept the stop already saw", () => {
    expect(provisionalStopClassification("after-accept")).toBe("after-accept");
    expect(settledStopClassification("after-accept", "before-accept")).toBe("after-accept");
    expect(settledStopClassification("after-accept", "unknown")).toBe("after-accept");
  });
});

describe("planning one boot's recovery", () => {
  it("drops a turn that already finished or failed, and a resume that failed last boot", () => {
    const plan = planBootRecovery([
      candidate({ threadId: "done", outcome: "completed" }),
      candidate({ threadId: "dead", outcome: "failed" }),
      candidate({ threadId: "tried", failedBefore: true }),
    ]);
    expect(plan.resume).toEqual([]);
    expect(plan.notify).toEqual([]);
    expect(plan.skipped.map((entry) => entry.reason)).toEqual(["completed", "failed", "failed-before"]);
  });

  it("replays only what it can prove the provider never saw", () => {
    const plan = planBootRecovery([candidate({ classification: "before-accept" })]);
    expect(plan.resume).toHaveLength(1);
    expect(plan.resume[0]!.action).toBe("replay");
  });

  it("continues the provider's own session instead of re-sending an accepted prompt", () => {
    const plan = planBootRecovery([
      candidate({ threadId: "t-after", classification: "after-accept", resumableSession: true }),
      candidate({ threadId: "t-unknown", classification: "unknown", resumableSession: true }),
    ]);
    expect(plan.resume.map((entry) => entry.action)).toEqual(["continue", "continue"]);
  });

  it("tells the person rather than guessing when there is no session to continue", () => {
    const plan = planBootRecovery([
      candidate({ classification: "after-accept", resumableSession: false }),
    ]);
    expect(plan.resume).toEqual([]);
    expect(plan.notify.map((entry) => entry.threadId)).toEqual(["thread-1"]);
  });

  it("caps the fan-out and puts recorded stops in the surviving slots first", () => {
    const many = [
      ...Array.from({ length: 5 }, (_, i) => candidate({ botId: `crash-${i}`, threadId: `crash-${i}` })),
      ...Array.from({ length: 5 }, (_, i) =>
        candidate({ botId: `clean-${i}`, threadId: `clean-${i}`, recorded: true }),
      ),
    ];
    const plan = planBootRecovery(many, { totalCap: 3 });
    expect(plan.resume).toHaveLength(3);
    expect(plan.resume.every((entry) => entry.candidate.recorded)).toBe(true);
    expect(plan.skipped.filter((entry) => entry.reason === "over-cap")).toHaveLength(7);
    expect(plan.cap).toBe(3);
  });

  it("has a cap by default, so an unbounded data directory cannot storm a provider", () => {
    const many = Array.from({ length: BOOT_RESUME_TOTAL_CAP + 4 }, (_, i) =>
      candidate({ botId: `bot-${i}`, threadId: `thread-${i}` }),
    );
    expect(planBootRecovery(many).resume).toHaveLength(BOOT_RESUME_TOTAL_CAP);
  });
});

describe("staggering the dispatches", () => {
  it("waits between starts and never exceeds the concurrency cap", async () => {
    const started: number[] = [];
    const sleeps: number[] = [];
    let live = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const pending = runStaggeredResumes([0, 1, 2, 3, 4], {
      staggerMs: 2_000,
      concurrency: 2,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      dispatch: async (item) => {
        started.push(item);
        live += 1;
        peak = Math.max(peak, live);
        await new Promise<void>((resolve) => release.push(resolve));
        live -= 1;
      },
    });
    // Let the loop run as far as the concurrency cap allows, then drain.
    await Promise.resolve();
    while (release.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(peak).toBe(2);
    const drain = setInterval(() => release.shift()?.(), 1);
    await pending;
    clearInterval(drain);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    // One wait per dispatch after the first, at the configured interval.
    expect(sleeps).toEqual([2_000, 2_000, 2_000, 2_000]);
  });

  it("does not let one failing resume stop the rest", async () => {
    const started: number[] = [];
    await runStaggeredResumes([0, 1, 2], {
      staggerMs: 0,
      concurrency: 1,
      sleep: async () => {},
      dispatch: async (item) => {
        started.push(item);
        if (item === 0) throw new Error("engine is gone");
      },
    });
    expect(started).toEqual([0, 1, 2]);
  });
});

describe("the interrupted-turns record", () => {
  it("survives a round trip and is consumed exactly once", () => {
    const { root } = rig();
    expect(readInterruptedTurns(root).turns).toEqual([]);
    expect(
      recordInterruptedTurns(root, [
        { botId: "b1", threadId: "t1", at: 10, reason: "shutdown", classification: "after-accept" },
        { botId: "b2", threadId: "t2", at: 10, reason: "shutdown", classification: "before-accept" },
      ]),
    ).toBe(true);
    const taken = takeInterruptedTurns(root);
    expect(taken.turns.map((turn) => turn.threadId)).toEqual(["t1", "t2"]);
    expect(taken.turns[0]!.classification).toBe("after-accept");
    // A second boot must find nothing: a record read twice resumes twice.
    expect(takeInterruptedTurns(root).turns).toEqual([]);
  });

  it("remembers a terminal resume failure across the record being consumed", () => {
    const { root } = rig();
    recordInterruptedTurns(root, [{ botId: "b1", threadId: "t1", at: 1, reason: "shutdown" }]);
    rememberResumeFailure(root, { botId: "b1", threadId: "t1", at: 2, error: "engine is gone" });
    takeInterruptedTurns(root);
    const after = readInterruptedTurns(root);
    expect(after.turns).toEqual([]);
    expect(after.failures.map((failure) => failure.threadId)).toEqual(["t1"]);
    // New input on the thread retires it.
    forgetResumeFailure(root, "b1", "t1");
    expect(readInterruptedTurns(root).failures).toEqual([]);
  });

  it("does not record the same failure twice", () => {
    const { root } = rig();
    rememberResumeFailure(root, { botId: "b1", threadId: "t1", at: 1 });
    rememberResumeFailure(root, { botId: "b1", threadId: "t1", at: 2 });
    const failures = readInterruptedTurns(root).failures;
    expect(failures).toHaveLength(1);
    expect(failures[0]!.at).toBe(2);
  });

  it("reads a corrupt or foreign record as no record at all", () => {
    const { root } = rig();
    writeFileSync(interruptedTurnsPath(root), "{ not json");
    expect(readInterruptedTurns(root).turns).toEqual([]);
    writeFileSync(interruptedTurnsPath(root), JSON.stringify({ turns: [{ nope: true }, null] }));
    expect(readInterruptedTurns(root).turns).toEqual([]);
  });
});
