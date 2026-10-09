import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendHeldSends,
  clampDrainTimeout,
  HELD_SENDS_FILE,
  HELD_SENDS_MAX_AGE_MS,
  inFlightCounts,
  partitionHeldSends,
  takeHeldSends,
  UPDATE_DRAIN_DEFAULT_TIMEOUT_MS,
  UPDATE_DRAIN_LEASE_GRACE_MS,
  UPDATE_DRAIN_MAX_TIMEOUT_MS,
  UpdateDrain,
  type HeldSend,
} from "./update-drain.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function dataDir(): string {
  const root = mkdtempSync(join(tmpdir(), "update-drain-"));
  roots.push(root);
  return root;
}

function send(patch: Partial<HeldSend> = {}): HeldSend {
  return {
    botId: "bot_one",
    threadId: "thread_one",
    prompt: "check the deploy",
    userMessageId: "msg_two",
    excludeIds: ["msg_one", "msg_two"],
    relayed: false,
    heldAt: 1_000,
    ...patch,
  };
}

/** A drain on a fake clock with timers a test fires by hand. */
function drainRig() {
  let now = 10_000;
  const timers: Array<{ fn: () => void; at: number; cancelled: boolean }> = [];
  const releases: string[] = [];
  const drain = new UpdateDrain({
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { fn, at: now + ms, cancelled: false };
      timers.push(timer);
      return { cancel: () => { timer.cancelled = true; } };
    },
    onRelease: (reason) => releases.push(reason),
  });
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers) {
      if (!timer.cancelled && timer.at <= now) {
        timer.cancelled = true;
        timer.fn();
      }
    }
  };
  return { drain, releases, advance, timers };
}

describe("UpdateDrain", () => {
  it("holds until released, and releasing lets held work go exactly once", () => {
    const { drain, releases } = drainRig();
    expect(drain.active).toBe(false);
    const status = drain.begin(60_000);
    expect(drain.active).toBe(true);
    expect(status).toEqual({ startedAt: 10_000, timeoutMs: 60_000, deadline: 10_000 + 60_000 + UPDATE_DRAIN_LEASE_GRACE_MS });
    expect(drain.release("updater")).toBe(true);
    expect(drain.active).toBe(false);
    expect(releases).toEqual(["updater"]);
    // A second release has nothing to let go.
    expect(drain.release("updater")).toBe(false);
    expect(releases).toEqual(["updater"]);
  });

  it("releases itself when the updater never comes back", () => {
    const { drain, releases, advance } = drainRig();
    drain.begin(60_000);
    advance(60_000);
    expect(drain.active).toBe(true);
    advance(UPDATE_DRAIN_LEASE_GRACE_MS);
    expect(drain.active).toBe(false);
    expect(releases).toEqual(["lease-expired"]);
  });

  it("a renewal keeps the start and moves the lease", () => {
    const { drain, releases, advance } = drainRig();
    drain.begin(60_000);
    advance(30_000);
    const renewed = drain.begin(60_000);
    expect(renewed.startedAt).toBe(10_000);
    // The first lease would have run out here; the renewed one has not.
    advance(60_000 + UPDATE_DRAIN_LEASE_GRACE_MS - 30_000);
    expect(drain.active).toBe(true);
    advance(30_000);
    expect(releases).toEqual(["lease-expired"]);
  });

  it("stopping clears the lease without releasing: the fence took over", () => {
    const { drain, releases, advance } = drainRig();
    drain.begin(60_000);
    expect(drain.stop()).toBe(true);
    advance(24 * 60 * 60_000);
    expect(releases).toEqual([]);
    expect(drain.stop()).toBe(false);
  });

  it("clamps a requested window", () => {
    expect(clampDrainTimeout(undefined)).toBe(UPDATE_DRAIN_DEFAULT_TIMEOUT_MS);
    expect(clampDrainTimeout("nonsense")).toBe(UPDATE_DRAIN_DEFAULT_TIMEOUT_MS);
    expect(clampDrainTimeout(-5)).toBe(UPDATE_DRAIN_DEFAULT_TIMEOUT_MS);
    expect(clampDrainTimeout("90000")).toBe(90_000);
    expect(clampDrainTimeout(10)).toBe(1_000);
    expect(clampDrainTimeout(Number.MAX_SAFE_INTEGER)).toBe(UPDATE_DRAIN_MAX_TIMEOUT_MS);
  });
});

describe("what a drain waits for", () => {
  it("counts work in flight and not work that is only held", () => {
    const counts = { turns: 2, queuedSends: 3, routineRuns: 5, admissions: 0 };
    const inFlight = inFlightCounts(counts, { queuedRoutineRuns: 4 });
    // Three held sends and four queued receipts are held; two turns and one
    // running routine are in flight.
    expect(inFlight).toEqual({ turns: 2, queuedSends: 0, routineRuns: 1, admissions: 0 });
    // The input is left alone.
    expect(counts.queuedSends).toBe(3);
    // Nothing to subtract from is not invented.
    expect(inFlightCounts({ boot: 1 }, { queuedRoutineRuns: 2 })).toEqual({ boot: 1 });
  });
});

describe("the held-sends carrier", () => {
  it("round-trips sends, keeps an earlier update's, and is private", () => {
    const dir = dataDir();
    appendHeldSends(dir, [send()]);
    appendHeldSends(dir, [send({ botId: "bot_two", relayed: true, linqChatId: "chat_1" })]);
    const path = join(dir, HELD_SENDS_FILE);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const taken = takeHeldSends(dir);
    expect(taken.map((item) => [item.botId, item.relayed, item.linqChatId])).toEqual([
      ["bot_one", false, undefined],
      ["bot_two", true, "chat_1"],
    ]);
    // Taken means gone: the next boot does not run them again.
    expect(existsSync(path)).toBe(false);
    expect(takeHeldSends(dir)).toEqual([]);
  });

  it("writes nothing when nothing is held", () => {
    const dir = dataDir();
    appendHeldSends(dir, []);
    expect(existsSync(join(dir, HELD_SENDS_FILE))).toBe(false);
  });

  it("drops a malformed entry and an unreadable file instead of failing boot", () => {
    const dir = dataDir();
    const path = join(dir, HELD_SENDS_FILE);
    writeFileSync(path, JSON.stringify({ version: 1, sends: [send(), { botId: 5 }] }));
    expect(takeHeldSends(dir)).toHaveLength(1);
    writeFileSync(path, "{ not json");
    const lines: string[] = [];
    expect(takeHeldSends(dir, (line) => lines.push(line))).toEqual([]);
    expect(lines[0]).toContain(HELD_SENDS_FILE);
    expect(existsSync(path)).toBe(false);
  });

  it("an unreadable leftover does not stop new sends being saved", () => {
    const dir = dataDir();
    writeFileSync(join(dir, HELD_SENDS_FILE), "garbage");
    appendHeldSends(dir, [send()]);
    expect(JSON.parse(readFileSync(join(dir, HELD_SENDS_FILE), "utf8")).sends).toHaveLength(1);
  });

  it("does not run a send that waited far longer than an update takes", () => {
    const fresh = send({ heldAt: 1_000 });
    const old = send({ botId: "bot_old", heldAt: 1_000 - HELD_SENDS_MAX_AGE_MS - 1 });
    expect(partitionHeldSends([fresh, old], 2_000)).toEqual({ run: [fresh], stale: [old] });
  });
});
