import { describe, expect, it } from "vitest";

import { describeGracefulStop, gracefulStop, gracefulStopRefusal } from "./graceful-shutdown.ts";
import type { GracefulStopOptions } from "./graceful-shutdown.ts";

/** A graceful stop with a fake clock and no real waiting.
 *
 *  The clock only moves when the fixture sleeps, so a deadline is reached
 *  exactly when the fixture says it is, and a fixture that never settles
 *  reaches it after the whole window. */
function fixture(options: {
  busy?: Array<{ id: string; name: string }>;
  active?: number;
  blocking?: Array<{ count: number; label: string }>;
  park?: boolean;
  deadlineMs?: number;
  /** What the work in flight does while the stop waits for it. */
  settle?: (state: { active: number }) => void;
} = {}) {
  const state = {
    now: 0,
    active: options.active ?? 0,
    busy: [...(options.busy ?? [])],
    parked: 0,
    parkedFor: [] as string[],
    slept: 0,
  };
  const deps: GracefulStopOptions = {
    busyBots: () => state.busy.map((bot) => ({ ...bot })),
    activeWorkCount: () => state.active,
    blockingWork: () => options.blocking ?? [],
    parkHeldWork: (interrupted) => {
      state.parked += 1;
      state.parkedFor = [...interrupted];
      return options.park ?? true;
    },
    deadlineMs: options.deadlineMs ?? 1_000,
    sleep: async (ms) => {
      state.slept += ms;
      state.now += ms;
      options.settle?.(state);
    },
    now: () => state.now,
  };
  return { deps, state };
}

describe("gracefulStop", () => {
  it("reports the bots that are still working, and parks the work behind them", async () => {
    // The stop does not interrupt anything itself:  the shutdown that follows
    // does that, and it records the turn for the next boot.  The report says
    // which bots it will interrupt.
    const { deps, state } = fixture({
      busy: [{ id: "a", name: "Nightowl" }, { id: "b", name: "Daylight" }],
    });
    const report = await gracefulStop(deps);
    expect(report.ok).toBe(true);
    expect(report.interrupted).toEqual(["Nightowl", "Daylight"]);
    expect(report.finished).toEqual([]);
    expect(report.leftRunning).toEqual([]);
    expect(state.parked).toBe(1);
  });

  it("counts a bot that had already finished as finished, not as stopped", async () => {
    // A bot whose turn ended during the window has nothing to interrupt, and
    // saying it was stopped would be a lie.
    const { deps, state } = fixture({ busy: [{ id: "a", name: "Nightowl" }] });
    let reads = 0;
    deps.busyBots = () => (reads++ === 0 ? [{ id: "a", name: "Nightowl" }] : []);
    const report = await gracefulStop(deps);
    expect(report.finished).toEqual(["Nightowl"]);
    expect(report.interrupted).toEqual([]);
    // A bot that finished keeps its queued work committed:  only the bots
    // that are being stopped carry theirs uncommitted.
    expect(state.parkedFor).toEqual([]);
  });

  it("parks the queued work for the bots that are being stopped, by id", async () => {
    // The carry is by id, not by name:  the names are for the owner, and two
    // bots can share a name.
    const { deps, state } = fixture({ busy: [{ id: "a", name: "Nightowl" }] });
    await gracefulStop(deps);
    expect(state.parkedFor).toEqual(["a"]);
  });

  it("refuses the stop when the queued work could not be saved", async () => {
    // The messages behind the stopped bots are still in memory, so the server
    // stays up rather than losing them.
    const { deps } = fixture({ busy: [{ id: "a", name: "Nightowl" }], park: false });
    const report = await gracefulStop(deps);
    expect(report.ok).toBe(false);
    expect(report.refusal).toMatch(/could not be saved/);
  });

  it("waits for the work in flight to settle and reports nothing left running", async () => {
    const { deps, state } = fixture({
      active: 2,
      settle: (current) => { current.active = 0; },
    });
    const report = await gracefulStop(deps);
    expect(state.slept).toBeGreaterThan(0);
    expect(report.leftRunning).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("stops at the deadline and names what did not finish", async () => {
    // The bound is the point:  the server shuts down anyway, and the owner is
    // told what could not finish.
    const { deps, state } = fixture({
      active: 3,
      blocking: [{ count: 3, label: "delegated task" }],
      deadlineMs: 1_000,
    });
    const report = await gracefulStop(deps);
    expect(report.ok).toBe(true);
    expect(report.leftRunning).toEqual(["3 delegated tasks"]);
    expect(state.now).toBeGreaterThanOrEqual(1_000);
  });

  it("does not wait at all when nothing is in flight", async () => {
    const { deps, state } = fixture();
    const report = await gracefulStop(deps);
    expect(report.ok).toBe(true);
    expect(state.slept).toBe(0);
    expect(report.leftRunning).toEqual([]);
  });

  it("does not name a kind with nothing in flight", async () => {
    const { deps } = fixture({ blocking: [{ count: 0, label: "bot turn" }] });
    const report = await gracefulStop(deps);
    expect(report.leftRunning).toEqual([]);
  });

  it("parks the work once, after the wait", async () => {
    const { deps, state } = fixture({
      busy: [{ id: "a", name: "Nightowl" }],
      active: 1,
      settle: (current) => { current.active = 0; },
    });
    await gracefulStop(deps);
    expect(state.parked).toBe(1);
  });
});

describe("describeGracefulStop", () => {
  it("says what stopped, what was interrupted and what was left running", () => {
    const report = {
      ok: true,
      finished: ["Daylight"],
      interrupted: ["Nightowl"],
      leftRunning: ["2 routine runs"],
    };
    expect(describeGracefulStop(report)).toBe(
      "1 bot had already finished; 1 bot was stopped; still running: 2 routine runs",
    );
  });

  it("says nothing when nothing was in flight", () => {
    expect(describeGracefulStop({ ok: true, finished: [], interrupted: [], leftRunning: [] }))
      .toBe("nothing was in flight");
  });
});

describe("gracefulStopRefusal", () => {
  it("counts the work and names its kinds when the answer is to wait", () => {
    // The owner already knows this shape, and the answer here is to wait for
    // the work, so it keeps the wording it had.
    expect(gracefulStopRefusal([{ count: 1, label: "in-flight request" }]))
      .toBe("1 active operation(s) must finish before the server can stop: 1 in-flight request");
  });

  it("explains a room turn instead of counting it", () => {
    // A room turn cannot be resumed without repeating it, so "wait for it to
    // finish" is not the whole of it:  the owner is told why the server stays
    // up and what the room turn means.
    expect(gracefulStopRefusal([{ count: 1, label: "room turn" }]))
      .toBe("a room turn is in flight, and a room turn cannot be resumed without repeating it, so the server stays up");
  });

  it("names the other work when a room turn is the reason", () => {
    expect(gracefulStopRefusal([
      { count: 1, label: "room turn" },
      { count: 2, label: "provider reload" },
    ])).toBe(
      "a room turn is in flight, and a room turn cannot be resumed without repeating it, so the server stays up; also in flight: 2 provider reloads",
    );
  });
});
