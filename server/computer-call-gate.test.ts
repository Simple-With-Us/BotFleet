import { describe, expect, it } from "vitest";

import {
  COMPUTER_WAIT_MAX_MS,
  computerCallActWithinMs,
  computerCallWaitMs,
  computerPersonAwayMs,
  computerPersonAwayText,
  waitForComputerCall,
  type ComputerCallSnapshot,
} from "./computer-call-gate.ts";
import {
  CONTROL_ACT_WITHIN_MS,
  CONTROL_BUSY,
  CONTROL_HANDED_BACK,
  CONTROL_REFUSAL_PLAIN,
  CONTROL_WAIT_MS,
  CONTROL_WAITED,
  controlRefusal,
} from "./control-client.ts";

function clock(start = 1_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

describe("gate wait bounds", () => {
  it("falls back to the built-in defaults without a resolved override", () => {
    expect(computerCallWaitMs()).toBe(CONTROL_WAIT_MS);
    expect(computerCallActWithinMs()).toBe(CONTROL_ACT_WITHIN_MS);
    expect(computerPersonAwayMs()).toBe(COMPUTER_WAIT_MAX_MS);
  });

  it("clamps a resolved override to the gate's bounds", () => {
    expect(computerCallWaitMs(10)).toBe(500);
    expect(computerCallWaitMs(999_999)).toBe(CONTROL_WAIT_MS);
    expect(computerCallActWithinMs(1)).toBe(100);
    expect(computerPersonAwayMs(0)).toBe(1);
  });
});

describe("waitForComputerCall", () => {
  it("lets a free computer act at once", async () => {
    const state = await waitForComputerCall({
      snapshot: () => ({ held: false, helpReason: null, heldSinceMs: null }),
      waitMs: 500,
      actWithinMs: 100,
    });
    expect(state).toEqual({ held: false, helpOpen: false });
  });

  it("waits inside the call while a person holds, then says the call was not performed", async () => {
    const time = clock();
    let held = true;
    const sleeps: number[] = [];
    const pending = waitForComputerCall({
      snapshot: () => ({ held, helpReason: null, heldSinceMs: held ? time.now() - 10 : null }),
      now: time.now,
      waitMs: 500,
      actWithinMs: 100,
      personAwayMs: 60_000,
      sleep: async (ms) => {
        sleeps.push(ms);
        time.advance(ms);
        if (time.now() >= 1_200) held = false;
      },
    });
    const state = await pending;
    expect(state).toEqual({ held: true, helpOpen: false, blockedReason: CONTROL_HANDED_BACK });
    expect(controlRefusal(state)).not.toBe(CONTROL_REFUSAL_PLAIN);
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it("answers a hold that outlasts the call as the person's", async () => {
    const time = clock();
    const state = await waitForComputerCall({
      snapshot: () => ({ held: true, helpReason: "login", heldSinceMs: time.now() }),
      now: () => time.now(),
      waitMs: 500,
      actWithinMs: 100,
      personAwayMs: 60_000,
      sleep: async (ms) => {
        time.advance(ms);
      },
    });
    expect(state).toEqual({ held: true, helpOpen: true, reason: "person" });
    expect(controlRefusal(state)).toBe(CONTROL_REFUSAL_PLAIN);
    expect(time.now()).toBeGreaterThanOrEqual(1_500);
  });

  it("does not wait out a person who has already been away past the ceiling", async () => {
    const time = clock(10_000);
    let slept = false;
    const state = await waitForComputerCall({
      snapshot: () => ({ held: true, helpReason: null, heldSinceMs: 0 }),
      now: time.now,
      waitMs: 5_000,
      personAwayMs: 2_000,
      sleep: async () => {
        slept = true;
      },
    });
    expect(state.blockedReason).toBe(computerPersonAwayText(2_000));
    expect(controlRefusal(state)).toContain("hand control back");
    expect(slept).toBe(false);
  });

  it("answers a contended seat as busy and a late free computer as unperformed", async () => {
    const time = clock();
    let contended = true;
    const busy = await waitForComputerCall({
      snapshot: () => ({ held: false, helpReason: null, heldSinceMs: null }),
      contended: () => contended,
      now: time.now,
      waitMs: 500,
      actWithinMs: 100,
      sleep: async (ms) => {
        time.advance(ms);
        if (time.now() >= 1_400) contended = false;
      },
    });
    expect(busy).toEqual({ held: true, helpOpen: false, blockedReason: CONTROL_WAITED });

    let ticks = 0;
    const stillBusy = await waitForComputerCall({
      snapshot: () => ({ held: false, helpReason: null, heldSinceMs: null }),
      contended: () => true,
      now: () => ticks,
      waitMs: 500,
      actWithinMs: 5_000,
      sleep: async (ms) => {
        ticks += ms;
      },
    });
    expect(stillBusy.blockedReason).toBe(CONTROL_BUSY);
    expect(controlRefusal(stillBusy)).not.toBe(CONTROL_REFUSAL_PLAIN);
  });

  it("stops waiting when the caller hangs up", async () => {
    const controller = new AbortController();
    const state = await waitForComputerCall({
      snapshot: (): ComputerCallSnapshot => ({ held: true, helpReason: null, heldSinceMs: Date.now() }),
      signal: controller.signal,
      waitMs: 500,
      personAwayMs: 60_000,
      sleep: async () => {
        controller.abort();
      },
    });
    expect(state.reason).toBe("person");
  });

  it("refuses a call whose turn ended while the computer looked free", async () => {
    const state = await waitForComputerCall({
      snapshot: () => ({ held: false, helpReason: null, heldSinceMs: null }),
      active: () => false,
      waitMs: 500,
    });
    expect(state.held).toBe(true);
    expect(state.blockedReason).toMatch(/no longer has this computer/);
  });
});
