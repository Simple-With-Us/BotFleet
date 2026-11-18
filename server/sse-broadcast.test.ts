// Unit tests for the SSE fan-out backpressure and replay-buffer bookkeeping
// pulled out of index.ts (HS16, HS17). A fake response lets these exercise
// write()===false and the byte ceiling deterministically — hard to do
// through a real socket without genuinely stalling a client.
import { describe, expect, it } from "vitest";

import {
  extractSseFrameTarget,
  parseSseFilters,
  ReplayBuffer,
  SLOW_CLIENT_BYTE_LIMIT,
  SSE_FILTER_MAX_VALUES,
  SSE_FILTER_VALUE_MAX_LENGTH,
  SseFilterListSchema,
  wants,
  wantsReplayEntry,
  writeToClient,
  type SseClient,
  type SseWritable,
} from "./sse-broadcast.ts";

/** A fake response whose write() outcome and writableLength are scripted
 * by the test, and which records every chunk actually written. */
class FakeResponse implements SseWritable {
  written: string[] = [];
  ended = false;
  destroyed = false;
  writableLength = 0;
  /** Consumed by the next write() call, then reset to null. */
  nextWriteReturns: boolean | null = null;

  write(chunk: string): boolean {
    this.written.push(chunk);
    const ok = this.nextWriteReturns ?? true;
    this.nextWriteReturns = null;
    return ok;
  }

  end(): void {
    this.ended = true;
  }
}

const client = (overrides: Partial<SseClient> = {}): SseClient => ({
  res: new FakeResponse(),
  screens: false,
  screenBotIds: null,
  slow: false,
  ...overrides,
});

describe("writeToClient", () => {
  it("writes normally when the client is draining", () => {
    const c = client({ screens: true });
    const result = writeToClient(c, "frame-1", "message", "bot-1");
    expect(result).toBe("wrote");
    expect((c.res as FakeResponse).written).toEqual(["frame-1"]);
    expect(c.slow).toBe(false);
  });

  it("drops a screen frame for a client that never opted into screens", () => {
    const c = client({ screens: false });
    const result = writeToClient(c, "frame-1", "screen", "bot-1");
    expect(result).toBe("dropped");
    expect((c.res as FakeResponse).written).toEqual([]);
  });

  it("drops a screen frame outside the client's subscribed bot set", () => {
    const c = client({ screens: true, screenBotIds: new Set(["bot-1"]) });
    expect(writeToClient(c, "frame-1", "screen", "bot-2")).toBe("dropped");
    expect(writeToClient(c, "frame-2", "screen", "bot-1")).toBe("wrote");
  });

  it("marks the client slow when write() returns false, and drops further screen frames until drain", () => {
    const c = client({ screens: true });
    const res = c.res as FakeResponse;
    res.nextWriteReturns = false;
    expect(writeToClient(c, "frame-1", "message", "bot-1")).toBe("wrote");
    expect(c.slow).toBe(true);

    // a screen frame is skipped outright while slow — it never even
    // reaches res.write()
    expect(writeToClient(c, "frame-2", "screen", "bot-1")).toBe("dropped");
    expect(res.written).toEqual(["frame-1"]);

    // a non-screen frame is never dropped just for being slow — it queues
    expect(writeToClient(c, "frame-3", "message", "bot-1")).toBe("wrote");
    expect(res.written).toEqual(["frame-1", "frame-3"]);

    // clearing slow (as the real response's 'drain' handler does) resumes
    // screen frames for this client
    c.slow = false;
    expect(writeToClient(c, "frame-4", "screen", "bot-1")).toBe("wrote");
  });

  it("disconnects a client whose buffered bytes cross the ceiling", () => {
    const c = client({ screens: true });
    const res = c.res as FakeResponse;
    res.writableLength = SLOW_CLIENT_BYTE_LIMIT + 1;
    expect(writeToClient(c, "frame-1", "message", "bot-1")).toBe("slow-end");
    expect(res.ended).toBe(true);
  });

  it("stays under the ceiling and keeps writing normally", () => {
    const c = client({ screens: true });
    const res = c.res as FakeResponse;
    res.writableLength = SLOW_CLIENT_BYTE_LIMIT - 1;
    expect(writeToClient(c, "frame-1", "message", "bot-1")).toBe("wrote");
    expect(res.ended).toBe(false);
  });

  it("reports 'error' and never throws when the underlying write throws", () => {
    const c = client({ screens: true });
    (c.res as FakeResponse).write = () => {
      throw new Error("socket hang up");
    };
    let result: string | undefined;
    expect(() => {
      result = writeToClient(c, "frame-1", "message", "bot-1");
    }).not.toThrow();
    expect(result).toBe("error");
  });

  it("filters frames by threadIds when subscribed to specific threads", () => {
    const c = client({ screens: true, threadIds: new Set(["t-1"]) });
    expect(writeToClient(c, "frame-1", "runtime", "bot-1", "t-2")).toBe("dropped");
    expect(writeToClient(c, "frame-2", "runtime", "bot-1", "")).toBe("dropped");
    expect(writeToClient(c, "frame-3", "runtime", "bot-1", "t-1")).toBe("wrote");
  });

  it("drops all frames when onlyKinds or threadIds is a non-null empty allowlist", () => {
    const emptyKinds = client({ screens: true, onlyKinds: new Set() });
    expect(writeToClient(emptyKinds, "frame-1", "message", "bot-1", "t-1")).toBe("dropped");
    const emptyThreads = client({ screens: true, threadIds: new Set() });
    expect(writeToClient(emptyThreads, "frame-1", "message", "bot-1", "t-1")).toBe("dropped");
  });
});

describe("wants", () => {
  it("every non-screen kind is always wanted", () => {
    expect(wants({ screens: false }, "message")).toBe(true);
    expect(wants({ screens: false }, "turn.completed")).toBe(true);
  });

  it("screen frames require opting in", () => {
    expect(wants({ screens: false }, "screen")).toBe(false);
    expect(wants({ screens: true }, "screen")).toBe(true);
  });

  it("honors onlyKinds allowlists", () => {
    expect(wants({ screens: false, onlyKinds: new Set(["runtime"]) }, "message")).toBe(false);
    expect(wants({ screens: false, onlyKinds: new Set(["runtime"]) }, "runtime")).toBe(true);
    expect(wants({ screens: true, onlyKinds: new Set(["screen"]) }, "screen")).toBe(true);
    expect(wants({ screens: true, onlyKinds: new Set(["screen"]) }, "bot")).toBe(false);
    expect(wants({ screens: false, onlyKinds: new Set(["screen"]) }, "screen")).toBe(false);
    expect(wants({ screens: true, onlyKinds: new Set() }, "runtime")).toBe(false);
  });
});

describe("SSE filter validation, target extraction, and replay filtering", () => {
  it("extracts botId and threadId across direct and nested frame envelopes", () => {
    expect(extractSseFrameTarget({ threadId: "t-msg", botId: "b-1" })).toEqual({ botId: "b-1", threadId: "t-msg" });
    expect(extractSseFrameTarget({ event: { threadId: "t-rt" } })).toEqual({ botId: "", threadId: "t-rt" });
    expect(extractSseFrameTarget({ bot: { id: "b-2", threadId: "t-bot" } })).toEqual({ botId: "b-2", threadId: "t-bot" });
    expect(extractSseFrameTarget({ group: { threadId: "t-grp" } })).toEqual({ botId: "", threadId: "t-grp" });
  });

  it("validates and bounds SSE query filter allowlists", () => {
    expect(SseFilterListSchema.safeParse(["runtime", "bot"]).success).toBe(true);
    expect(SseFilterListSchema.safeParse([""]).success).toBe(false);
    expect(SseFilterListSchema.safeParse(["bad space"]).success).toBe(false);
    expect(SseFilterListSchema.safeParse(["a".repeat(SSE_FILTER_VALUE_MAX_LENGTH + 1)]).success).toBe(false);
    expect(
      SseFilterListSchema.safeParse(Array.from({ length: SSE_FILTER_MAX_VALUES + 1 }, (_, i) => `t-${i}`)).success,
    ).toBe(false);

    const parsed = parseSseFilters(new URLSearchParams("kind=runtime&threadId=t-1&botId=b-1"));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.onlyKinds).toEqual(new Set(["runtime"]));
      expect(parsed.threadIds).toEqual(new Set(["t-1"]));
      expect(parsed.screenBotIds).toEqual(new Set(["b-1"]));
    }

    expect(parseSseFilters(new URLSearchParams("threadId=")).ok).toBe(false);
    expect(parseSseFilters(new URLSearchParams("kind=bad%20kind")).ok).toBe(false);
  });

  it("enforces threadIds and onlyKinds on buffered replay entries", () => {
    const buffer = new ReplayBuffer(10, 1_000_000);
    buffer.push(1, "runtime", "rt-1", "t-1");
    buffer.push(2, "runtime", "rt-2", "t-2");
    buffer.push(3, "bot", "bot-1", "t-1");

    const sub = client({ screens: false, onlyKinds: new Set(["runtime"]), threadIds: new Set(["t-1"]) });
    expect(buffer.entries.filter((entry) => wantsReplayEntry(sub, entry)).map((e) => e.seq)).toEqual([1]);

    const threadOnly = client({ screens: false, threadIds: new Set(["t-1"]) });
    expect(buffer.entries.filter((entry) => wantsReplayEntry(threadOnly, entry)).map((e) => e.seq)).toEqual([1, 3]);
  });
});

describe("ReplayBuffer", () => {
  it("evicts oldest first past the count cap", () => {
    const buffer = new ReplayBuffer(3, 1_000_000);
    buffer.push(1, "message", "a");
    buffer.push(2, "message", "b");
    buffer.push(3, "message", "c");
    buffer.push(4, "message", "d");
    expect(buffer.entries.map((e) => e.seq)).toEqual([2, 3, 4]);
  });

  it("never keeps a screen frame's payload, but keeps its sequence slot", () => {
    const buffer = new ReplayBuffer(10, 1_000_000);
    buffer.push(1, "screen", "big-frame-payload");
    expect(buffer.entries).toEqual([{ seq: 1, kind: "screen", frame: null }]);
  });

  it("replays only the newest engine list: an older instances payload is dropped, its slot kept", () => {
    const buffer = new ReplayBuffer(10, 1_000_000);
    buffer.push(1, "instances", "list-one");
    buffer.push(2, "message", "hello");
    buffer.push(3, "instances", "list-two");
    expect(buffer.entries).toEqual([
      { seq: 1, kind: "instances", frame: null },
      { seq: 2, kind: "message", frame: "hello" },
      { seq: 3, kind: "instances", frame: "list-two" },
    ]);
  });

  it("gives a superseded engine list's bytes back to the budget", () => {
    const buffer = new ReplayBuffer(100, 30);
    buffer.push(1, "instances", "x".repeat(20));
    buffer.push(2, "instances", "y".repeat(20)); // would be 40 bytes without the drop
    buffer.push(3, "message", "m".repeat(10)); // 30 bytes: nothing evicted
    expect(buffer.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("evicts oldest first past the byte cap even under the count cap (HS17)", () => {
    const buffer = new ReplayBuffer(100, 30); // 30-byte budget
    buffer.push(1, "message", "a".repeat(10)); // 10 bytes
    buffer.push(2, "message", "b".repeat(10)); // 20 bytes total
    buffer.push(3, "message", "c".repeat(10)); // 30 bytes total — right at the cap
    expect(buffer.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    buffer.push(4, "message", "d".repeat(10)); // 40 bytes — evicts seq 1
    expect(buffer.entries.map((e) => e.seq)).toEqual([2, 3, 4]);
  });

  it("does not loop forever when a single frame alone exceeds the byte cap", () => {
    const buffer = new ReplayBuffer(100, 5); // 5-byte budget
    buffer.push(1, "message", "this frame alone is already over the cap");
    expect(buffer.entries).toEqual([]);
    // the buffer recovers cleanly for the next, smaller frame
    buffer.push(2, "message", "ok");
    expect(buffer.entries.map((e) => e.seq)).toEqual([2]);
  });
});
