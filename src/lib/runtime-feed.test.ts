import { describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "../../server/contracts.ts";
import { createEventBatcher, publishRuntimeEvent, subscribeRuntimeEvents, watchedThreadCount } from "./runtime-feed.ts";

const ev = (threadId: string, over: Record<string, unknown> = {}): RuntimeEvent =>
  ({ eventId: `e-${Math.random()}`, provider: "claude", threadId, createdAt: "2026-09-29T14:00:00.000Z", type: "turn.started", ...over }) as RuntimeEvent;

describe("the runtime feed", () => {
  it("does nothing when nobody is watching the thread", () => {
    expect(watchedThreadCount()).toBe(0);
    expect(() => publishRuntimeEvent(ev("nobody"))).not.toThrow();
  });

  it("delivers a thread's events to its subscribers and no one else's", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeRuntimeEvents("t-a", a);
    const offB = subscribeRuntimeEvents("t-b", b);
    const event = ev("t-a");
    publishRuntimeEvent(event);
    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith(event);
    expect(b).not.toHaveBeenCalled();
    offA();
    offB();
    expect(watchedThreadCount()).toBe(0);
  });

  it("stops delivering after unsubscribe", () => {
    const listener = vi.fn();
    const off = subscribeRuntimeEvents("t", listener);
    off();
    publishRuntimeEvent(ev("t"));
    expect(listener).not.toHaveBeenCalled();
  });

  it("supports several subscribers to one thread, and a thrown listener does not stop the rest", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    const off1 = subscribeRuntimeEvents("t", bad);
    const off2 = subscribeRuntimeEvents("t", good);
    publishRuntimeEvent(ev("t"));
    expect(good).toHaveBeenCalledTimes(1);
    off1();
    off2();
    quiet.mockRestore();
  });

  it("drops streamed deltas — the settled item carries the text", () => {
    const listener = vi.fn();
    const off = subscribeRuntimeEvents("t", listener);
    publishRuntimeEvent(ev("t", { type: "content.delta", streamKind: "assistant_text", delta: "hi" }));
    expect(listener).not.toHaveBeenCalled();
    off();
  });

  it("clips what it forwards", () => {
    const listener = vi.fn();
    const off = subscribeRuntimeEvents("t", listener);
    publishRuntimeEvent(ev("t", { type: "item.completed", itemType: "tool", ok: true, detail: "x".repeat(50_000) }));
    const forwarded = listener.mock.calls[0]![0] as { detail: string };
    expect(forwarded.detail.length).toBeLessThanOrEqual(2000);
    off();
  });
});

describe("createEventBatcher", () => {
  function harness(waitMs = 250) {
    const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
    const flushed: RuntimeEvent[][] = [];
    const batcher = createEventBatcher(
      (events) => flushed.push(events),
      waitMs,
      (fn, ms) => {
        const timer = { fn, ms, live: true };
        timers.push(timer);
        return timer;
      },
      (handle) => {
        (handle as { live: boolean }).live = false;
      },
    );
    const tick = () => timers.filter((t) => t.live).forEach((t) => {
      t.live = false;
      t.fn();
    });
    return { batcher, flushed, timers, tick };
  }

  it("hands a burst over as one ordered batch", () => {
    const { batcher, flushed, timers, tick } = harness();
    const events = [ev("t"), ev("t"), ev("t")];
    events.forEach((e) => batcher.push(e));
    expect(flushed).toHaveLength(0);
    // one timer for the whole burst
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(250);
    tick();
    expect(flushed).toEqual([events]);
    expect(batcher.pendingCount()).toBe(0);
  });

  it("starts a fresh timer for the next burst", () => {
    const { batcher, flushed, timers, tick } = harness();
    batcher.push(ev("t"));
    tick();
    batcher.push(ev("t"));
    tick();
    expect(flushed).toHaveLength(2);
    expect(timers).toHaveLength(2);
  });

  it("flushes now on request and cancels the timer", () => {
    const { batcher, flushed, timers, tick } = harness();
    batcher.push(ev("t"));
    batcher.flushNow();
    expect(flushed).toHaveLength(1);
    expect(timers[0]!.live).toBe(false);
    tick();
    expect(flushed).toHaveLength(1);
  });

  it("flushing nothing delivers nothing", () => {
    const { batcher, flushed } = harness();
    batcher.flushNow();
    expect(flushed).toHaveLength(0);
  });

  it("drops what is pending when disposed", () => {
    const { batcher, flushed, tick } = harness();
    batcher.push(ev("t"));
    batcher.dispose();
    tick();
    expect(flushed).toHaveLength(0);
    expect(batcher.pendingCount()).toBe(0);
  });
});
