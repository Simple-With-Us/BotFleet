import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendHeldWork,
  clampDrainTimeout,
  drainViewOf,
  HELD_SENDS_FILE,
  HELD_SENDS_MAX_AGE_MS,
  inFlightCounts,
  partitionByAge,
  takeHeldWork,
  UPDATE_DRAIN_DEFAULT_TIMEOUT_MS,
  UPDATE_DRAIN_LEASE_GRACE_MS,
  UPDATE_DRAIN_MAX_TIMEOUT_MS,
  UpdateDrain,
  type HeldQueueEntry,
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

  it("tells a listener when the hold starts, renews, and ends, however it ends", () => {
    let now = 10_000;
    const timers: Array<() => void> = [];
    const heard: boolean[] = [];
    const drain: UpdateDrain = new UpdateDrain({
      now: () => now,
      setTimer: (fn) => {
        timers.push(fn);
        return { cancel: () => {} };
      },
      onRelease: () => {},
      onChange: () => heard.push(drain.active),
    });
    drain.begin(60_000);
    drain.begin(60_000);
    drain.stop();
    drain.begin(60_000);
    drain.release("updater");
    drain.begin(60_000);
    timers.at(-1)?.();
    // Started, renewed, stopped, started, released, started, lease ran out.
    expect(heard).toEqual([true, true, false, true, false, true, false]);
    // Nothing held, nothing to hear about.
    drain.stop();
    drain.release("updater");
    expect(heard).toHaveLength(7);
  });

  it("a listener that throws never breaks the hold", () => {
    const lines: string[] = [];
    const drain = new UpdateDrain({
      now: () => 10_000,
      setTimer: () => ({ cancel: () => {} }),
      onRelease: () => {},
      onChange: () => {
        throw new Error("broadcast failed");
      },
      log: (line) => lines.push(line),
    });
    expect(drain.begin(60_000).startedAt).toBe(10_000);
    expect(drain.active).toBe(true);
    expect(drain.stop()).toBe(true);
    expect(lines.join("\n")).toContain("broadcast failed");
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

  it("does not count room rounds waiting in the room queue: they are held and carried", () => {
    // Finding 7: a room whose bots kept answering each other kept an update
    // waiting for about six minutes.
    expect(inFlightCounts({ turns: 1, queuedRooms: 2, groupOperations: 1 }, { queuedRoutineRuns: 0 }))
      .toEqual({ turns: 1, queuedRooms: 0, groupOperations: 1 });
  });
});

function queued(patch: Partial<HeldQueueEntry> = {}): HeldQueueEntry {
  return {
    botId: "bot_busy",
    threadId: "thread_busy",
    heldAt: 1_000,
    items: [{ messageId: "q_1", text: "after you finish", prompt: "after you finish", relayed: true, linqChatId: "chat_2" }],
    ...patch,
  };
}

describe("the held-work carrier", () => {
  it("round-trips sends and queued entries, keeps an earlier update's, and is private", () => {
    const dir = dataDir();
    appendHeldWork(dir, { sends: [send()] });
    appendHeldWork(dir, { sends: [send({ botId: "bot_two", relayed: true, linqChatId: "chat_1" })], queued: [queued()] });
    const path = join(dir, HELD_SENDS_FILE);
    // POSIX permissions: Windows reports 0o666 for any writable file.
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    const taken = takeHeldWork(dir);
    expect(taken.sends.map((item) => [item.botId, item.relayed, item.linqChatId])).toEqual([
      ["bot_one", false, undefined],
      ["bot_two", true, "chat_1"],
    ]);
    // Carried exactly as queued: relay mark and Linq chat intact.
    expect(taken.queued).toEqual([queued()]);
    // Taken means gone: the next boot does not run them again.
    expect(existsSync(path)).toBe(false);
    expect(takeHeldWork(dir)).toEqual({ sends: [], queued: [], rooms: [] });
  });

  it("carries held room rounds, and a round it cannot read costs only itself", () => {
    const dir = dataDir();
    const round = {
      groupId: "room_1", threadId: "thread_room", botId: "bot_member", hop: 1,
      turnSelection: { instanceId: "claude", model: "sonnet", effort: "high" }, heldAt: 1_000,
    };
    appendHeldWork(dir, { rooms: [round] });
    appendHeldWork(dir, { sends: [send()] });
    expect(takeHeldWork(dir)).toMatchObject({ sends: [send()], rooms: [round] });
    writeFileSync(join(dir, HELD_SENDS_FILE), JSON.stringify({ version: 1, sends: [], rooms: [round, { groupId: "x" }] }));
    expect(takeHeldWork(dir).rooms).toEqual([round]);
  });

  it("refuses to write an entry the next boot would drop, so the caller can still run it", () => {
    // The written shape is checked against the schema the boot reads with
    // (`HeldWorkSchema`), and the type is derived from it.
    const dir = dataDir();
    expect(() => appendHeldWork(dir, { sends: [send({ heldAt: Number.NaN })] })).toThrow();
    expect(existsSync(join(dir, HELD_SENDS_FILE))).toBe(false);
    appendHeldWork(dir, { sends: [send()] });
    expect(() => appendHeldWork(dir, { queued: [queued({ items: [] })] })).toThrow();
    // What was already carried is untouched by the refused write.
    expect(takeHeldWork(dir).sends).toEqual([send()]);
  });

  it("writes nothing when nothing is held", () => {
    const dir = dataDir();
    appendHeldWork(dir, { sends: [], queued: [] });
    expect(existsSync(join(dir, HELD_SENDS_FILE))).toBe(false);
  });

  it("drops a malformed entry and an unreadable file instead of failing boot", () => {
    const dir = dataDir();
    const path = join(dir, HELD_SENDS_FILE);
    writeFileSync(path, JSON.stringify({
      version: 1,
      sends: [send(), { botId: 5 }],
      queued: [queued(), queued({ items: [] }), { botId: "x" }],
    }));
    const taken = takeHeldWork(dir);
    expect(taken.sends).toHaveLength(1);
    expect(taken.queued).toHaveLength(1);
    // A file from before queued entries existed reads as sends only.
    writeFileSync(path, JSON.stringify({ version: 1, sends: [send()] }));
    expect(takeHeldWork(dir)).toMatchObject({ sends: [send()], queued: [], rooms: [] });
    writeFileSync(path, "{ not json");
    const lines: string[] = [];
    expect(takeHeldWork(dir, (line: string) => lines.push(line))).toEqual({ sends: [], queued: [], rooms: [] });
    expect(lines[0]).toContain(HELD_SENDS_FILE);
    expect(existsSync(path)).toBe(false);
  });

  it("an unreadable leftover does not stop new work being saved", () => {
    const dir = dataDir();
    writeFileSync(join(dir, HELD_SENDS_FILE), "garbage");
    appendHeldWork(dir, { queued: [queued()] });
    expect(JSON.parse(readFileSync(join(dir, HELD_SENDS_FILE), "utf8")).queued).toHaveLength(1);
  });

  it("does not run work that waited far longer than an update takes", () => {
    const fresh = send({ heldAt: 1_000 });
    const old = send({ botId: "bot_old", heldAt: 1_000 - HELD_SENDS_MAX_AGE_MS - 1 });
    expect(partitionByAge([fresh, old], 2_000)).toEqual({ run: [fresh], stale: [old] });
    const staleQueue = queued({ heldAt: 1_000 - HELD_SENDS_MAX_AGE_MS - 1 });
    expect(partitionByAge([staleQueue], 2_000)).toEqual({ run: [], stale: [staleQueue] });
  });
});

describe("drainViewOf", () => {
  const status = { startedAt: 10_000, timeoutMs: 6 * 60_000, deadline: 10_000 + 6 * 60_000 + UPDATE_DRAIN_LEASE_GRACE_MS };

  it("is nothing when nothing is held", () => {
    expect(drainViewOf(null, { bots: 3 })).toBeNull();
  });

  it("ends the window where the updater's own does, not where the lease does", () => {
    const view = drainViewOf(status, { bots: 3, rooms: 1, held: { sends: 2, rooms: 1, routineRuns: 4 } });
    expect(view).toEqual({
      startedAt: 10_000,
      // The lease slack is for an updater that never comes back: nobody waits it out.
      windowEndsAt: 10_000 + 6 * 60_000,
      deadline: status.deadline,
      bots: 3,
      rooms: 1,
      held: { sends: 2, rooms: 1, routineRuns: 4 },
    });
    expect(view?.deadline).toBe(view!.windowEndsAt + UPDATE_DRAIN_LEASE_GRACE_MS);
  });

  it("reads missing, negative and fractional counts as whole numbers, and carries no text", () => {
    const view = drainViewOf(status, { bots: -2, rooms: 1.9, held: { sends: Number.NaN, routineRuns: 2 } });
    expect(view).toMatchObject({ bots: 0, rooms: 1, held: { sends: 0, rooms: 0, routineRuns: 2 } });
    expect(Object.keys(view!).sort()).toEqual(["bots", "deadline", "held", "rooms", "startedAt", "windowEndsAt"]);
  });

  it("never ends the window before it began, whatever the lease slack", () => {
    expect(drainViewOf(status, {}, 24 * 60 * 60_000)?.windowEndsAt).toBe(10_000);
  });
});
