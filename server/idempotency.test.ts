import { describe, expect, it } from "vitest";

import { IdempotencyCache } from "./idempotency.ts";

describe("IdempotencyCache", () => {
  it("runs an attempt once per key and replays its reply to a retry", async () => {
    const cache = new IdempotencyCache<string>();
    let runs = 0;
    const attempt = async () => {
      runs += 1;
      return `reply-${runs}`;
    };
    const first = cache.run("k1", attempt);
    const retry = cache.run("k1", attempt);
    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    await expect(first.result).resolves.toBe("reply-1");
    await expect(retry.result).resolves.toBe("reply-1");
    expect(runs).toBe(1);
    expect(cache.run("k2", attempt).replayed).toBe(false);
    expect(runs).toBe(2);
  });

  it("shares one in-flight promise with a retry that lands before it settles", async () => {
    const cache = new IdempotencyCache<number>();
    let release!: (value: number) => void;
    const slow = () => new Promise<number>((resolve) => { release = resolve; });
    const first = cache.run("slow", slow);
    const retry = cache.run("slow", slow);
    expect(retry.replayed).toBe(true);
    release(7);
    await expect(Promise.all([first.result, retry.result])).resolves.toEqual([7, 7]);
  });

  it("looks up a known attempt without starting work for an unknown key", async () => {
    const cache = new IdempotencyCache<string>();
    await cache.run("known", async () => "first").result;

    const replay = cache.replay("known");
    expect(replay?.replayed).toBe(true);
    await expect(replay?.result).resolves.toBe("first");
    expect(cache.replay("unknown")).toBeUndefined();
  });

  it("keeps a full cache intact during replay lookup", async () => {
    const cache = new IdempotencyCache<string>({ maxEntries: 2 });
    await cache.run("oldest", async () => "first").result;
    await cache.run("newest", async () => "second").result;

    await expect(cache.replay("oldest")?.result).resolves.toBe("first");
    expect(cache.size).toBe(2);
  });

  it("does not expose in-flight or rejected attempts as committed replays", async () => {
    const cache = new IdempotencyCache<string>();
    let reject!: (error: Error) => void;
    const pending = cache.run("pending", () => new Promise<string>((_, fail) => { reject = fail; }));
    expect(cache.replay("pending")).toBeUndefined();

    reject(new Error("dispatch failed"));
    await expect(pending.result).rejects.toThrow("dispatch failed");
    expect(cache.replay("pending")).toBeUndefined();
  });

  it("forgets a rejected attempt so the caller can retry a real failure", async () => {
    const cache = new IdempotencyCache<string>();
    const failing = cache.run("k", async () => { throw new Error("provider unavailable"); });
    await expect(failing.result).rejects.toThrow("provider unavailable");
    const again = cache.run("k", async () => "ok");
    expect(again.replayed).toBe(false);
    await expect(again.result).resolves.toBe("ok");
  });

  it("expires replies after the ttl and bounds the number of remembered keys", async () => {
    let clock = 1_000;
    const cache = new IdempotencyCache<string>({ ttlMs: 100, maxEntries: 2, now: () => clock });
    await cache.run("a", async () => "a").result;
    clock += 50;
    await cache.run("b", async () => "b").result;
    expect(cache.size).toBe(2);
    // the cap evicts the oldest key before a new one is remembered
    await cache.run("c", async () => "c").result;
    expect(cache.run("a", async () => "a2").replayed).toBe(false);
    clock += 200;
    // everything older than the ttl is gone on the next run
    expect(cache.run("c", async () => "c2").replayed).toBe(false);
  });
});
