// Unit tests for the SSE fan-out backpressure and replay-buffer bookkeeping
// pulled out of index.ts (HS16, HS17). A fake response lets these exercise
// write()===false and the byte ceiling deterministically — hard to do
// through a real socket without genuinely stalling a client.
import { describe, expect, it } from "vitest";

import { ReplayBuffer, SLOW_CLIENT_BYTE_LIMIT, wants, writeToClient, type SseClient, type SseWritable } from "./sse-broadcast.ts";

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
