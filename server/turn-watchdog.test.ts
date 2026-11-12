// Stall-watchdog contract: activity keeps a turn alive indefinitely, human
// approvals pause the clock, silence past the ceiling stalls exactly once.
import { describe, expect, it, vi } from "vitest";

import { TurnWatchdog, type WatchedTurn } from "./turn-watchdog.ts";

const STALL = 10_000;

function rig() {
  let now = 0;
  const stalls: WatchedTurn[] = [];
  const dog = new TurnWatchdog({
    stallMs: STALL,
    checkMs: 60_000,
    onStall: (turn) => stalls.push(turn),
    now: () => now,
  });
  return { dog, stalls, tick: (ms: number) => (now += ms) };
}

describe("TurnWatchdog", () => {
  it("stalls a silent turn once, and only once", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    tick(STALL - 1);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(2);
    dog.sweep();
    expect(stalls).toEqual([expect.objectContaining({ threadId: "t1", botId: "bot1" })]);
    dog.sweep();
    expect(stalls).toHaveLength(1);
    expect(dog.watching("t1")).toBe(false);
  });

  it("any event on the thread resets the clock", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    for (let i = 0; i < 10; i++) {
      tick(STALL - 1);
      dog.touch("t1");
    }
    dog.sweep();
    expect(stalls).toHaveLength(0);
  });

  it("never stalls a turn waiting on a human, however long they take", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.setWaitingOnHuman("t1", true);
    tick(STALL * 100);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    // the answer restarts the clock rather than inheriting the wait
    dog.setWaitingOnHuman("t1", false);
    tick(STALL - 1);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(2);
    dog.sweep();
    expect(stalls).toHaveLength(1);
  });

  it("a settled turn is forgotten", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.settle("t1");
    tick(STALL * 2);
    dog.sweep();
    expect(stalls).toHaveLength(0);
  });

  it("re-watching a thread replaces the previous turn", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    tick(STALL - 1);
    dog.watch("t1", "bot2");
    tick(2);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(STALL);
    dog.sweep();
    expect(stalls).toEqual([expect.objectContaining({ botId: "bot2" })]);
  });

  it("settleAll forgets every turn at once and reports which were in flight", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.watch("t2", "bot2");
    dog.settle("t2");
    dog.watch("t3", "bot3");
    // a provider reload kills every turn at once: the caller gets the list
    // so it can settle each one's bookkeeping, and nothing stalls later
    const killed = dog.settleAll();
    expect(killed.map((turn) => turn.threadId).sort()).toEqual(["t1", "t3"]);
    expect(dog.watching("t1")).toBe(false);
    expect(dog.watching("t3")).toBe(false);
    tick(STALL * 2);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    expect(dog.settleAll()).toEqual([]);
  });

  it("runs the sweep heartbeat on every tick, before the stall scan", () => {
    const beats: number[] = [];
    const dog = new TurnWatchdog({
      stallMs: STALL,
      checkMs: 60_000,
      onStall: () => undefined,
      onSweep: () => beats.push(beats.length),
      now: () => 0,
    });
    dog.sweep();
    dog.sweep();
    expect(beats).toEqual([0, 1]);
  });

  it("a heartbeat that throws never stops the stall detector", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let now = 0;
    const stalls: WatchedTurn[] = [];
    const dog = new TurnWatchdog({
      stallMs: STALL,
      checkMs: 60_000,
      onStall: (turn) => stalls.push(turn),
      onSweep: () => {
        throw new Error("a driver blew up");
      },
      now: () => now,
    });
    dog.watch("t1", "bot1");
    now += STALL + 1;
    dog.sweep();
    expect(stalls).toHaveLength(1);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
