// The bus is the seam every client depends on: events must arrive
// stamped with their instanceId, cross-driver leaks must be dropped, and
// neither logging nor a broken listener may take down the stream.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EVENTS_DIR, ensureDirs } from "../config.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { LOG_TEE_MAX_STRING_CHARS } from "../redact.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import type { AppendWriter } from "../transcript-retention.ts";
import { EventBus } from "./bus.ts";

const testEvent = (over: Partial<RuntimeEvent> = {}): RuntimeEvent =>
  ({
    eventId: "ev-1",
    provider: "fake",
    threadId: "thread-1",
    createdAt: new Date().toISOString(),
    type: "turn.started",
    ...over,
  }) as RuntimeEvent;

async function liveInstance() {
  const fake = makeFakeDriver();
  await fake.driver.create({
    instanceId: "inst-1",
    displayName: undefined,
    environment: {},
    enabled: true,
    config: {},
  });
  return fake.created.get("inst-1")!;
}

describe("EventBus", () => {
  // The tee is queued rather than written on the publish path, so a test that
  // publishes and returns leaves a write in flight.  Every bus a test makes is
  // drained before the next one resets the directory underneath it.
  const buses: EventBus[] = [];
  const makeBus = (...args: ConstructorParameters<typeof EventBus>) => {
    const bus = new EventBus(...args);
    buses.push(bus);
    return bus;
  };

  beforeEach(() => {
    rmSync(EVENTS_DIR, { recursive: true, force: true });
    ensureDirs();
  });

  afterEach(async () => {
    await Promise.all(buses.splice(0).map((bus) => bus.flush()));
  });

  it("stamps events from an attached adapter with the instanceId", async () => {
    const { instance, emit } = await liveInstance();
    const bus = makeBus();
    bus.attach([instance]);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    emit(testEvent());
    expect(seen).toHaveLength(1);
    expect(seen[0].providerInstanceId).toBe("inst-1");
  });

  it("drops events claiming a different driver kind (cross-driver invariant)", async () => {
    const { instance, emit } = await liveInstance();
    const bus = makeBus();
    bus.attach([instance]);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    emit(testEvent({ provider: "impostor" }));
    expect(seen).toHaveLength(0);
  });

  it("tees every published event to the per-thread NDJSON log", async () => {
    const bus = makeBus();
    bus.publish(testEvent({ threadId: "log-me" }));
    await bus.flush();

    const logged = readFileSync(join(EVENTS_DIR, "log-me.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(logged).toHaveLength(1);
    expect(logged[0].type).toBe("turn.started");
  });

  it("never writes to disk on the publish path — the tee is queued and drained", async () => {
    const bus = makeBus();
    const file = join(EVENTS_DIR, "async-tee.ndjson");

    bus.publish(testEvent({ threadId: "async-tee" }));
    bus.publish(testEvent({ eventId: "ev-2", threadId: "async-tee" }));
    // The publisher's own stack is where every other bot's turn, the SSE
    // fan-out and /api/health used to wait for a multi-megabyte append.
    expect(existsSync(file)).toBe(false);
    // One write in flight, one still queued behind it.
    expect(bus.teeStats().pending).toBe(1);

    await bus.flush();
    expect(existsSync(file)).toBe(true);
    expect(bus.teeStats().pending).toBe(0);
  });

  it("writes queued records in publish order, one file and many", async () => {
    const bus = makeBus();
    for (let i = 0; i < 25; i += 1) {
      bus.publish(testEvent({ eventId: `ev-${i}`, threadId: i % 2 === 0 ? "order-a" : "order-b" }));
    }
    await bus.flush();

    const idsIn = (threadId: string) =>
      readFileSync(join(EVENTS_DIR, `${threadId}.ndjson`), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).eventId);
    expect(idsIn("order-a")).toEqual(["ev-0", "ev-2", "ev-4", "ev-6", "ev-8", "ev-10", "ev-12", "ev-14", "ev-16", "ev-18", "ev-20", "ev-22", "ev-24"]);
    expect(idsIn("order-b")).toEqual(["ev-1", "ev-3", "ev-5", "ev-7", "ev-9", "ev-11", "ev-13", "ev-15", "ev-17", "ev-19", "ev-21", "ev-23"]);
  });

  it("drops the oldest queued records under write pressure instead of blocking or growing", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let release = () => undefined as void;
    const blocked = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    let started = false;
    const append: AppendWriter = async () => {
      if (started) return;
      started = true;
      await blocked;
    };
    // A cap of a few hundred bytes is a few events; the point is the shape,
    // not the size.
    const bus = makeBus(append, { maxQueuedBytes: 600 });
    const seen: RuntimeEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    for (let i = 0; i < 40; i += 1) bus.publish(testEvent({ eventId: `ev-${i}`, threadId: "pressure" }));

    const stats = bus.teeStats();
    expect(stats.dropped).toBeGreaterThan(5);
    expect(stats.pendingBytes).toBeLessThanOrEqual(600);
    // Live delivery never notices: that is the whole point of dropping.
    expect(seen.filter((event) => event.eventId.startsWith("ev-"))).toHaveLength(40);
    // A gap in the canonical log is reported in the log itself, once.
    expect(seen.filter((event) => event.type === "runtime.error")).toHaveLength(1);

    release();
    await bus.flush();
    // Summary lines, not one line per dropped record: a log that floods under
    // pressure is the failure it is reporting.
    const summaries = errors.mock.calls.filter((call) => String(call[0]).includes("append-queue: dropped"));
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.length).toBeLessThan(stats.dropped);
    expect(String(summaries[0][0])).toMatch(/dropped \d+ entr(?:y|ies) \(\d+ bytes\)/);
    errors.mockRestore();
  });

  it("redacts credential-shaped content before writing the NDJSON log", async () => {
    const key = `sk-ant-api03-${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
    const bus = makeBus();
    bus.publish(testEvent({
      threadId: "redacted-log",
      type: "runtime.error",
      message: `provider returned ${key}`,
    }));
    await bus.flush();

    const logged = readFileSync(join(EVENTS_DIR, "redacted-log.ndjson"), "utf8");
    expect(logged).not.toContain(key);
    expect(logged).toContain("«redacted");
  });

  it("elides the tail of a huge string so redaction never scans megabytes", async () => {
    // The shape that made this the hottest path in the harness: a tool result
    // carrying a whole file, with a credential in it.
    const key = `sk-ant-api03-${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
    const tail = "TAIL-MARKER-THAT-MUST-NOT-REACH-THE-LOG";
    const message = `read_file returned ${key} then ${"x".repeat(5 * 1024 * 1024)}${tail}`;
    const bus = makeBus();
    bus.publish(testEvent({ threadId: "huge", type: "runtime.error", message }));
    await bus.flush();

    const logged = readFileSync(join(EVENTS_DIR, "huge.ndjson"), "utf8");
    // The head is still redacted …
    expect(logged).not.toContain(key);
    expect(logged).toContain("«redacted");
    // … the tail is gone rather than unredacted, and says so …
    expect(logged).not.toContain(tail);
    expect(logged).toMatch(/\[… \d+ characters elided from log\]/);
    // … and the record is bounded by the cap rather than by the tool result.
    expect(logged.length).toBeLessThan(LOG_TEE_MAX_STRING_CHARS + 4096);
  });

  it("reports an incomplete log once while continuing live delivery", async () => {
    rmSync(EVENTS_DIR, { recursive: true, force: true });
    const bus = makeBus();
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    bus.publish(testEvent());
    bus.publish(testEvent({ eventId: "ev-2", type: "turn.completed", ok: true }));
    await bus.flush();

    // Live delivery is synchronous and unaffected by the state of the disk;
    // the warning follows once the failed write is observed.
    expect(seen.map((event) => event.eventId).slice(0, 2)).toEqual(["ev-1", "ev-2"]);
    expect(seen.filter((event) => event.type === "runtime.error")).toHaveLength(1);
    expect(seen.at(-1)).toMatchObject({
      type: "runtime.error",
      threadId: "thread-1",
      message: expect.stringContaining("event history is incomplete"),
    });
    expect(existsSync(EVENTS_DIR)).toBe(false);
  });

  it("writes the incomplete marker before the first event after logging recovers", async () => {
    let failing = true;
    const writes: string[] = [];
    const append: AppendWriter = vi.fn((_file: string, data: string) => {
      if (failing) throw new Error("disk full");
      writes.push(data);
    });
    const bus = makeBus(append);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    bus.publish(testEvent());
    await bus.flush();
    failing = false;
    bus.publish(testEvent({ eventId: "ev-2", type: "turn.completed", ok: true }));
    await bus.flush();
    bus.publish(testEvent({ eventId: "ev-3" }));
    await bus.flush();

    const recovered = writes[0].trim().split("\n").map((line) => JSON.parse(line));
    expect(recovered.map((event) => event.type)).toEqual(["runtime.error", "turn.completed"]);
    expect(recovered[0].message).toContain("event history is incomplete");
    expect(writes[1].trim()).toContain('"eventId":"ev-3"');
    expect(seen.filter((event) => event.type === "runtime.error")).toHaveLength(1);
  });

  it("a throwing listener does not starve the others", () => {
    const bus = makeBus();
    const seen: RuntimeEvent[] = [];
    bus.subscribe(() => {
      throw new Error("bad listener");
    });
    bus.subscribe((e) => seen.push(e));

    bus.publish(testEvent());
    expect(seen).toHaveLength(1);
  });

  it("drops a SECOND turn.completed for the same turn (one terminal event per turn)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { instance, emit } = await liveInstance();
    const bus = makeBus();
    bus.attach([instance]);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const terminal = testEvent({ type: "turn.completed", ok: true, turnId: "turn-1" });
    emit(terminal);
    emit({ ...terminal, eventId: "ev-2" });

    // Every consumer of turn.completed — the watchdog, the routine receipt,
    // the repeat detector, the usage fold — assumes it fires once.  A driver
    // that emits it twice settles a turn twice with no error anywhere, so
    // the bus says so instead of letting it through.
    expect(seen.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("second turn.completed"));
    errors.mockRestore();
  });

  it("delivers a terminal event for a DIFFERENT turn on the same thread", async () => {
    const { instance, emit } = await liveInstance();
    const bus = makeBus();
    bus.attach([instance]);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    emit(testEvent({ type: "turn.completed", ok: true, turnId: "turn-1" }));
    emit(testEvent({ eventId: "ev-2", type: "turn.completed", ok: true, turnId: "turn-2" }));

    expect(seen.filter((e) => e.type === "turn.completed")).toHaveLength(2);
  });

  it("never guesses: a terminal event with no turnId is always delivered", async () => {
    const { instance, emit } = await liveInstance();
    const bus = makeBus();
    bus.attach([instance]);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    emit(testEvent({ type: "turn.completed", ok: true }));
    emit(testEvent({ eventId: "ev-2", type: "turn.completed", ok: true }));

    expect(seen.filter((e) => e.type === "turn.completed")).toHaveLength(2);
  });

  it("unsubscribe and detachAll stop delivery", async () => {
    const { instance, emit } = await liveInstance();
    const bus = makeBus();
    bus.attach([instance]);
    const seen: RuntimeEvent[] = [];
    const unsub = bus.subscribe((e) => seen.push(e));

    emit(testEvent());
    unsub();
    emit(testEvent());
    expect(seen).toHaveLength(1);

    const seenAfterDetach: RuntimeEvent[] = [];
    bus.subscribe((e) => seenAfterDetach.push(e));
    bus.detachAll();
    emit(testEvent());
    expect(seenAfterDetach).toHaveLength(0);
  });

  it("detach removes a single instance subscription without affecting others", async () => {
    const inst1 = await liveInstance();
    const fake2 = makeFakeDriver();
    await fake2.driver.create({
      instanceId: "inst-2",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: {},
    });
    const inst2 = fake2.created.get("inst-2")!;

    const bus = makeBus();
    bus.attach([inst1.instance, inst2.instance]);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    bus.detach("inst-1");
    inst1.emit(testEvent());
    inst2.emit(testEvent());

    expect(seen).toHaveLength(1);
    expect(seen[0].providerInstanceId).toBe("inst-2");
  });
});
