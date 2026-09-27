// The queue that keeps the event-log tee off the publish path.  Three things
// have to be true at once: nothing blocks the caller, nothing grows without a
// bound, and nothing arrives out of order.
import { describe, expect, it, vi } from "vitest";

import { BoundedAppendQueue } from "./append-queue.ts";

/** A writer that hands back a resolver, so a test decides when a write lands. */
function controlledWriter() {
  const written: { file: string; data: string }[] = [];
  const gates: (() => void)[] = [];
  let paused = false;
  const write = async (file: string, data: string) => {
    // Always yield first, the way the real writer does when it stats the file:
    // a write must never land on the enqueuing stack.
    await Promise.resolve();
    if (paused) await new Promise<void>((resolve) => gates.push(resolve));
    written.push({ file, data });
  };
  return {
    write,
    written,
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      for (const gate of gates.splice(0)) gate();
    },
  };
}

describe("BoundedAppendQueue", () => {
  it("does not write on the caller's stack", async () => {
    const writer = controlledWriter();
    const queue = new BoundedAppendQueue<string>(writer.write);

    queue.enqueue("a.log", "one\n", "one");
    queue.enqueue("a.log", "two\n", "two");
    expect(writer.written).toHaveLength(0);
    // The first is in flight, the second is still waiting behind it.
    expect(queue.stats().pending).toBe(1);

    await queue.flush();
    expect(writer.written.map((w) => w.data)).toEqual(["one\n", "two\n"]);
  });

  it("preserves order per file and across files", async () => {
    const writer = controlledWriter();
    const queue = new BoundedAppendQueue<string>(writer.write);

    for (let i = 0; i < 10; i += 1) queue.enqueue(i % 2 === 0 ? "a.log" : "b.log", `${i}\n`, `${i}`);
    await queue.flush();

    expect(writer.written.map((w) => `${w.file}:${w.data.trim()}`)).toEqual([
      "a.log:0",
      "b.log:1",
      "a.log:2",
      "b.log:3",
      "a.log:4",
      "b.log:5",
      "a.log:6",
      "b.log:7",
      "a.log:8",
      "b.log:9",
    ]);
  });

  it("drops the OLDEST entries past the cap and reports the count once", async () => {
    const report = vi.fn();
    const dropped: string[] = [];
    const writer = controlledWriter();
    writer.pause();
    // 10 bytes of payload each, 30 bytes of headroom: three entries fit.
    const queue = new BoundedAppendQueue<string>(writer.write, {
      maxQueuedBytes: 30,
      onDropped: (context) => dropped.push(context),
      report,
      // A clock that never moves: every drop after the first lands inside the
      // same reporting interval, which is the coalescing this asserts.
      now: () => 1_000_000,
    });

    for (let i = 0; i < 8; i += 1) queue.enqueue("a.log", "123456789\n", `${i}`);

    expect(queue.stats().pendingBytes).toBeLessThanOrEqual(30);
    // The first entry is already in flight; the oldest of the rest are the
    // ones that go, and the newest always survives.
    expect(dropped).toEqual(["1", "2", "3", "4"]);
    expect(queue.stats().dropped).toBe(4);
    // A fixed clock means every drop after the first is inside the same
    // reporting interval, so the burst is one line, not eight.
    expect(report).toHaveBeenCalledTimes(1);
    expect(String(report.mock.calls[0][0])).toContain("dropped 1 entry");

    writer.resume();
    await queue.flush();
    // The flush reports what accumulated after the first line.
    expect(report).toHaveBeenCalledTimes(2);
    expect(String(report.mock.calls[1][0])).toContain("dropped 3 entries");
    expect(writer.written.map((w) => w.data.trim())).toEqual(["123456789", "123456789", "123456789", "123456789"]);
  });

  it("names the log it serves in the drop line", async () => {
    const report = vi.fn();
    const writer = controlledWriter();
    writer.pause();
    const queue = new BoundedAppendQueue<string>(writer.write, {
      maxQueuedBytes: 10,
      report,
      label: "native protocol tee",
    });

    for (let i = 0; i < 3; i += 1) queue.enqueue("a.log", "123456789\n", `${i}`);
    writer.resume();
    await queue.flush();

    // Two queues share this code, so the line has to say which one filled.
    expect(report).toHaveBeenCalled();
    expect(String(report.mock.calls[0][0])).toContain("from the native protocol tee");
    expect(String(report.mock.calls[0][0])).not.toContain("event log tee");
  });

  it("keeps a single record larger than the whole cap rather than erasing it", async () => {
    const writer = controlledWriter();
    const queue = new BoundedAppendQueue<string>(writer.write, { maxQueuedBytes: 8 });

    queue.enqueue("a.log", "a".repeat(64), "huge");
    expect(queue.stats().dropped).toBe(0);
    await queue.flush();
    expect(writer.written).toHaveLength(1);
  });

  it("reports a failed write and keeps draining the rest", async () => {
    const failures: string[] = [];
    const written: string[] = [];
    const queue = new BoundedAppendQueue<string>(
      async (_file, data) => {
        if (data.includes("bad")) throw new Error("disk full");
        written.push(data.trim());
      },
      { onWriteError: (context) => failures.push(context) },
    );

    queue.enqueue("a.log", "good-1\n", "good-1");
    queue.enqueue("a.log", "bad\n", "bad");
    queue.enqueue("a.log", "good-2\n", "good-2");
    await queue.flush();

    expect(failures).toEqual(["bad"]);
    expect(written).toEqual(["good-1", "good-2"]);
  });

  it("a throwing handler never rejects the drain", async () => {
    // The drain promise is only awaited at shutdown, so a rejection would sit
    // unhandled for the life of the process — and that takes the harness down
    // on Node 24.  A tee that cannot write is a degraded log, never a reason
    // to stop the fleet.
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const written: string[] = [];
    const queue = new BoundedAppendQueue<string>(
      async (_file, data) => {
        if (data.includes("bad")) throw new Error("disk full");
        written.push(data.trim());
      },
      {
        onWritten: () => {
          throw new Error("handler exploded");
        },
        onWriteError: () => {
          throw new Error("handler exploded harder");
        },
      },
    );

    queue.enqueue("a.log", "good\n", "good");
    queue.enqueue("a.log", "bad\n", "bad");
    queue.enqueue("a.log", "good-2\n", "good-2");
    await expect(queue.flush()).resolves.toBeUndefined();
    expect(written).toEqual(["good", "good-2"]);
    errors.mockRestore();
  });

  it("flush waits for work enqueued while it was already waiting", async () => {
    const writer = controlledWriter();
    const queue = new BoundedAppendQueue<string>(writer.write);

    queue.enqueue("a.log", "one\n", "one");
    const flushed = queue.flush();
    queue.enqueue("a.log", "two\n", "two");
    await flushed;

    expect(writer.written.map((w) => w.data.trim())).toEqual(["one", "two"]);
    expect(queue.stats().pending).toBe(0);
  });
});
