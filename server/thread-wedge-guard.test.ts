import { describe, expect, it } from "vitest";

import { isMcodeLockContentionMessage } from "./mcode-lock-contention.ts";
import {
  THREAD_WEDGE_NO_OUTPUT_THRESHOLD,
  ThreadWedgeGuard,
  isNoOutputWedgeStop,
} from "./thread-wedge-guard.ts";

describe("isMcodeLockContentionMessage", () => {
  it("matches the MiniMax Code runtime lock collision text", () => {
    expect(
      isMcodeLockContentionMessage("MiniMax Code Runtime failed: Lock file is already being held"),
    ).toBe(true);
  });

  it("does not match unrelated auth.lock noise", () => {
    expect(isMcodeLockContentionMessage("auth.lock: permission denied")).toBe(false);
  });
});

describe("isNoOutputWedgeStop", () => {
  it("includes stall and exit-before-result stops", () => {
    expect(isNoOutputWedgeStop("prompt_stall")).toBe(true);
    expect(isNoOutputWedgeStop("exit_before_result")).toBe(true);
    expect(isNoOutputWedgeStop("interrupted")).toBe(false);
  });
});

describe("ThreadWedgeGuard", () => {
  const key = { botId: "b1", threadId: "t1", instanceId: "mcode" };

  it("rotates after the configured streak of wedge failures", () => {
    const guard = new ThreadWedgeGuard();
    for (let i = 1; i < THREAD_WEDGE_NO_OUTPUT_THRESHOLD; i++) {
      const result = guard.recordFailure(key, { stopReason: "prompt_stall" });
      expect(result.shouldRotate).toBe(false);
      expect(result.streak).toBe(i);
    }
    const last = guard.recordFailure(key, { stopReason: "prompt_stall" });
    expect(last.streak).toBe(THREAD_WEDGE_NO_OUTPUT_THRESHOLD);
    expect(last.shouldRotate).toBe(true);
  });

  it("counts lock contention runtime errors toward the same streak", () => {
    const guard = new ThreadWedgeGuard();
    const msg = "MiniMax Code Runtime failed: Lock file is already being held";
    for (let i = 0; i < THREAD_WEDGE_NO_OUTPUT_THRESHOLD - 1; i++) {
      guard.recordFailure(key, { runtimeMessage: msg });
    }
    expect(guard.recordFailure(key, { runtimeMessage: msg }).shouldRotate).toBe(true);
  });

  it("clears the streak after a successful turn", () => {
    const guard = new ThreadWedgeGuard();
    guard.recordFailure(key, { stopReason: "prompt_stall" });
    guard.recordSuccess(key);
    expect(guard.peek(key)).toBe(0);
    expect(guard.recordFailure(key, { stopReason: "prompt_stall" }).streak).toBe(1);
  });
});
