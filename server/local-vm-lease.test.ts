import { describe, expect, it } from "vitest";

import { LocalVmLease, LocalVmLeasePool } from "./local-vm-lease.ts";

describe("LocalVmLease", () => {
  it("serializes different threads while letting the owner renew", () => {
    const lease = new LocalVmLease(100);
    const busy = () => true;

    expect(lease.claim("thread-a", "bot-a", busy, 1_000)).toBe(true);
    expect(lease.claim("thread-b", "bot-b", busy, 1_001)).toBe(false);
    expect(lease.claim("thread-a", "bot-a", busy, 1_002)).toBe(true);
    expect(lease.current(busy, 1_050)).toMatchObject({ threadId: "thread-a", botId: "bot-a" });
  });

  it("expires a wedged owner and allows recovery", () => {
    const lease = new LocalVmLease(100);
    const busy = () => true;

    lease.claim("thread-a", "bot-a", busy, 1_000);

    expect(lease.current(busy, 1_100)).toBeNull();
    expect(lease.claim("thread-b", "bot-b", busy, 1_100)).toBe(true);
  });

  it("refreshes on owner activity and releases when its bot settles", () => {
    const lease = new LocalVmLease(100);
    let ownerBusy = true;
    const busy = () => ownerBusy;

    lease.claim("thread-a", "bot-a", busy, 1_000);
    lease.touch("thread-a", 1_090);
    expect(lease.current(busy, 1_150)).not.toBeNull();

    ownerBusy = false;
    expect(lease.current(busy, 1_151)).toBeNull();
  });

  it("does not revive an expired owner from a delayed event", () => {
    const lease = new LocalVmLease(100);
    const busy = () => true;

    lease.claim("thread-a", "bot-a", busy, 1_000);
    lease.touch("thread-a", 1_100);

    expect(lease.current(busy, 1_100)).toBeNull();
    expect(lease.claim("thread-b", "bot-b", busy, 1_100)).toBe(true);
  });

  it("only lets the owning thread release the lease", () => {
    const lease = new LocalVmLease(100);
    const busy = () => true;
    lease.claim("thread-a", "bot-a", busy, 1_000);

    lease.release("thread-b");
    expect(lease.current(busy, 1_001)).not.toBeNull();
    lease.release("thread-a");
    expect(lease.current(busy, 1_002)).toBeNull();
  });

  it("refuses a second member of the same room thread", () => {
    // A 1:1 thread has exactly one bot, so matching the thread was the same
    // as matching the turn.  A room thread is shared by every member, and
    // since the room lane started resolving computers two members can reach
    // this fence at once.  Comparing the thread alone admitted the second
    // one into the container the first was already clicking inside, and
    // overwrote the record's botId — after which the first member's unwind
    // handed the container back while the second was still using it.
    const lease = new LocalVmLease(100);
    const busy = () => true;

    expect(lease.claim("room-1", "bot-a", busy, 1_000)).toBe(true);
    expect(lease.claim("room-1", "bot-b", busy, 1_001)).toBe(false);
    expect(lease.current(busy, 1_002)).toMatchObject({ threadId: "room-1", botId: "bot-a" });
  });

  it("still lets the one bot on a 1:1 thread renew its own claim", () => {
    // The 1:1 lane must be untouched by the room fix: the same thread and
    // the same bot is a renewal, exactly as before.
    const lease = new LocalVmLease(100);
    const busy = () => true;

    expect(lease.claim("thread-a", "bot-a", busy, 1_000)).toBe(true);
    expect(lease.claim("thread-a", "bot-a", busy, 1_050)).toBe(true);
    expect(lease.current(busy, 1_100)).toMatchObject({ threadId: "thread-a", botId: "bot-a" });
  });

  it("will not let one room member release another member's claim", () => {
    // The mirror of the claim rule.  `releaseLocalVmThread` names the bot
    // whose turn is unwinding, and on a shared thread that name is the only
    // thing separating a finished turn from a live one.
    const lease = new LocalVmLease(100);
    const busy = () => true;
    lease.claim("room-1", "bot-a", busy, 1_000);

    lease.release("room-1", "bot-b");
    expect(lease.current(busy, 1_001)).not.toBeNull();
    lease.release("room-1", "bot-a");
    expect(lease.current(busy, 1_002)).toBeNull();
  });
});

describe("LocalVmLeasePool", () => {
  it("allows distinct bot targets concurrently while serializing each target", () => {
    const pool = new LocalVmLeasePool(100);
    const busy = () => true;

    expect(pool.forTarget("bot:a").claim("thread-a", "bot-a", busy, 1_000)).toBe(true);
    expect(pool.forTarget("bot:b").claim("thread-b", "bot-b", busy, 1_000)).toBe(true);
    expect(pool.forTarget("bot:a").claim("thread-c", "bot-c", busy, 1_001)).toBe(false);
    expect(pool.forTarget("bot:b").current(busy, 1_002)).toMatchObject({ botId: "bot-b" });
  });

  it("keeps one lane per bot in shared mode instead of serializing every bot on the container key", () => {
    // Shared Local VM now hands each bot its own lane, so two bots share the
    // CONTAINER without sharing a desktop.  The pool itself is unchanged: what
    // moved is which lane key a bot resolves to.
    const pool = new LocalVmLeasePool(100);
    const busy = () => true;
    const lane = (botId: string) => `localvm-bot:${botId}`;

    expect(pool.forTarget(lane("bot-a")).claim("thread-a", "bot-a", busy, 1_000)).toBe(true);
    expect(pool.forTarget(lane("bot-b")).claim("thread-b", "bot-b", busy, 1_001)).toBe(true);
    // A second turn on the SAME bot's lane is still refused.
    expect(pool.forTarget(lane("bot-a")).claim("thread-c", "bot-c", busy, 1_002)).toBe(false);
  });
});
