import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  UsageTelemetryOutbox,
  usageTelemetryDestinationHash,
  type DurableTelemetryBatch,
} from "./telemetry-outbox.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "botfleet-telemetry-outbox-"));
  roots.push(root);
  return join(root, "outbox.json");
}

function batch(eventId = "bf:openai:bot-1:1:stable:in"): DurableTelemetryBatch {
  return {
    schemaVersion: 2,
    producerId: "botfleet",
    producerInstanceId: "test-mac",
    events: [{ eventId }],
  };
}

describe("UsageTelemetryOutbox", () => {
  it("persists stable event ids before the first send and removes only an acknowledged batch", async () => {
    const path = fixture();
    const destinationHash = usageTelemetryDestinationHash("https://usage.example.com/api/ingest/usage");
    const deliver = vi.fn(async (posted: DurableTelemetryBatch) => {
      const stored = JSON.parse(readFileSync(path, "utf8"));
      expect(stored.queue[0].batch.events[0].eventId).toBe(posted.events[0]?.eventId);
      return { acknowledged: true, rejected: 0 };
    });
    const outbox = new UsageTelemetryOutbox({ path });
    outbox.configure(() => ({ destinationHash, deliver }));

    outbox.enqueue(destinationHash, batch());
    await outbox.flushNow();

    expect(deliver).toHaveBeenCalledOnce();
    expect(outbox.status().queuedBatches).toBe(0);
    await outbox.dispose();
  });

  it("replays the same batch after a transient failure and process restart", async () => {
    const path = fixture();
    let now = 1_000;
    const destinationHash = usageTelemetryDestinationHash("https://usage.example.com/api/ingest/usage");
    const first = new UsageTelemetryOutbox({ path, now: () => now, retryBaseMs: 10 });
    first.configure(() => ({
      destinationHash,
      deliver: async () => ({ acknowledged: false, rejected: 0 }),
    }));
    first.enqueue(destinationHash, batch());
    await first.flushNow();
    expect(first.status()).toMatchObject({ queuedBatches: 1, failedAttempts: 1 });
    await first.dispose();

    now += 20;
    const delivered: DurableTelemetryBatch[] = [];
    const restarted = new UsageTelemetryOutbox({ path, now: () => now, retryBaseMs: 10 });
    expect(restarted.status().failedAttempts).toBe(1);
    restarted.configure(() => ({
      destinationHash,
      deliver: async (posted) => {
        delivered.push(posted);
        // A replay can be an ingest duplicate and is still an acknowledgement.
        return { acknowledged: true, rejected: 0 };
      },
    }));
    await restarted.flushNow();

    expect(delivered.map((posted) => posted.events[0]?.eventId)).toEqual([
      "bf:openai:bot-1:1:stable:in",
    ]);
    expect(restarted.status().queuedBatches).toBe(0);
    await restarted.dispose();
  });

  it.each([400, 409] as const)("quarantines terminal HTTP %i and drains the next batch", async (status) => {
    const path = fixture();
    const destinationHash = usageTelemetryDestinationHash("https://usage.example.com/api/ingest/usage");
    const delivered: string[] = [];
    const outbox = new UsageTelemetryOutbox({ path });
    outbox.enqueue(destinationHash, batch("poison"));
    outbox.enqueue(destinationHash, batch("later"));
    outbox.configure(() => ({
      destinationHash,
      deliver: async (posted) => {
        const id = posted.events[0]!.eventId;
        delivered.push(id);
        return id === "poison"
          ? { acknowledged: false, rejected: 0, terminalStatus: status }
          : { acknowledged: true, rejected: 0 };
      },
    }));
    await outbox.flushNow();

    expect(delivered).toEqual(["poison", "later"]);
    expect(outbox.status()).toMatchObject({
      queuedBatches: 0,
      terminalQuarantinedBatches: 1,
      lastTerminalStatus: status,
      lastTerminalAt: expect.any(String),
    });
    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored.terminalQuarantine[0]).toMatchObject({
      status,
      entry: { batch: { events: [{ eventId: "poison" }] } },
    });
    await outbox.dispose();

    const restarted = new UsageTelemetryOutbox({ path });
    expect(restarted.status()).toMatchObject({
      queuedBatches: 0,
      terminalQuarantinedBatches: 1,
      lastTerminalStatus: status,
      lastTerminalAt: stored.terminalQuarantine[0].quarantinedAt,
    });
    await restarted.dispose();
  });

  it("keeps 429 and 503 at the queue head for retry", async () => {
    const path = fixture();
    const destinationHash = usageTelemetryDestinationHash("https://usage.example.com/api/ingest/usage");
    let now = 1_000;
    let status = 429;
    const delivered: string[] = [];
    const outbox = new UsageTelemetryOutbox({ path, now: () => now, retryBaseMs: 10 });
    outbox.enqueue(destinationHash, batch("first"));
    outbox.enqueue(destinationHash, batch("later"));
    outbox.configure(() => ({
      destinationHash,
      deliver: async (posted) => {
        delivered.push(posted.events[0]!.eventId);
        return status === 200
          ? { acknowledged: true, rejected: 0 }
          : { acknowledged: false, rejected: 0 };
      },
    }));
    await outbox.flushNow();
    status = 503;
    now += 10;
    await outbox.flushNow();
    expect(delivered).toEqual(["first", "first"]);
    expect(outbox.status()).toMatchObject({ queuedBatches: 2, terminalQuarantinedBatches: 0 });
    status = 200;
    now += 20;
    await outbox.flushNow();
    expect(delivered).toEqual(["first", "first", "first", "later"]);
    await outbox.dispose();
  });

  it("bounds terminal quarantine with an explicit eviction count", async () => {
    const path = fixture();
    const destinationHash = usageTelemetryDestinationHash("https://usage.example.com/api/ingest/usage");
    const outbox = new UsageTelemetryOutbox({ path, maxQuarantinedBatches: 1 });
    outbox.enqueue(destinationHash, batch("first"));
    outbox.enqueue(destinationHash, batch("second"));
    outbox.configure(() => ({
      destinationHash,
      deliver: async () => ({ acknowledged: false, rejected: 0, terminalStatus: 409 }),
    }));
    await outbox.flushNow();
    expect(outbox.status()).toMatchObject({ terminalQuarantinedBatches: 1, terminalQuarantineEvictedBatches: 1 });
    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored.terminalQuarantine[0].entry.batch.events[0].eventId).toBe("second");
    await outbox.dispose();
  });

  it("keeps a terminal batch queued when its quarantine write fails", async () => {
    const path = fixture();
    const destinationHash = usageTelemetryDestinationHash("https://usage.example.com/api/ingest/usage");
    const outbox = new UsageTelemetryOutbox({
      path,
      retryBaseMs: 60_000,
      writeState: (target, state) => {
        if (state.terminalQuarantine.length) throw new Error("disk full");
        writeFileSync(target, JSON.stringify(state));
      },
    });
    outbox.enqueue(destinationHash, batch("must-survive"));
    outbox.configure(() => ({
      destinationHash,
      deliver: async () => ({ acknowledged: false, rejected: 0, terminalStatus: 409 }),
    }));
    await outbox.flushNow();
    expect(outbox.status()).toMatchObject({ queuedBatches: 1, terminalQuarantinedBatches: 0 });
    await outbox.dispose();

    const restarted = new UsageTelemetryOutbox({ path });
    expect(restarted.status()).toMatchObject({ queuedBatches: 1, terminalQuarantinedBatches: 0 });
    expect(JSON.parse(readFileSync(path, "utf8")).queue[0].batch.events[0].eventId).toBe("must-survive");
    await restarted.dispose();
  });

  it("does not replay a queued batch to a changed destination", async () => {
    const path = fixture();
    const oldHash = usageTelemetryDestinationHash("https://old.example.com/api/ingest/usage");
    const newHash = usageTelemetryDestinationHash("https://new.example.com/api/ingest/usage");
    const outbox = new UsageTelemetryOutbox({ path });
    outbox.enqueue(oldHash, batch());
    const deliver = vi.fn(async () => ({ acknowledged: true, rejected: 0 }));
    outbox.configure(() => ({ destinationHash: newHash, deliver }));
    await outbox.flushNow();

    expect(deliver).not.toHaveBeenCalled();
    expect(outbox.status()).toMatchObject({ queuedBatches: 0, droppedBatches: 1 });
    await outbox.dispose();
  });

  it("bounds the queue by dropping the oldest batch with an explicit count", async () => {
    const path = fixture();
    const destinationHash = usageTelemetryDestinationHash("https://usage.example.com/api/ingest/usage");
    const outbox = new UsageTelemetryOutbox({ path, maxBatches: 2 });
    outbox.enqueue(destinationHash, batch("first"));
    outbox.enqueue(destinationHash, batch("second"));
    outbox.enqueue(destinationHash, batch("third"));

    expect(outbox.status()).toMatchObject({ queuedBatches: 2, droppedBatches: 1 });
    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored.queue.map((entry: { batch: DurableTelemetryBatch }) => entry.batch.events[0]?.eventId))
      .toEqual(["second", "third"]);
    await outbox.dispose();
  });

  it("removes an acknowledged rejection and retains its rejected-event count", async () => {
    const path = fixture();
    const destinationHash = usageTelemetryDestinationHash("https://usage.example.com/api/ingest/usage");
    const outbox = new UsageTelemetryOutbox({ path });
    outbox.configure(() => ({
      destinationHash,
      deliver: async () => ({ acknowledged: true, rejected: 3 }),
    }));
    outbox.enqueue(destinationHash, batch());
    await outbox.flushNow();

    expect(outbox.status()).toMatchObject({ queuedBatches: 0, rejectedEvents: 3 });
    await outbox.dispose();

    const restarted = new UsageTelemetryOutbox({ path });
    expect(restarted.status().rejectedEvents).toBe(3);
    await restarted.dispose();
  });

  it("protects the in-flight head when overflow drops an older unsent batch", async () => {
    const path = fixture();
    const destinationHash = usageTelemetryDestinationHash("https://usage.example.com/api/ingest/usage");
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const delivered: string[] = [];
    const outbox = new UsageTelemetryOutbox({ path, maxBatches: 2 });
    outbox.configure(() => ({
      destinationHash,
      deliver: async (posted) => {
        const id = posted.events[0]?.eventId ?? "";
        delivered.push(id);
        if (id === "first") await firstGate;
        return { acknowledged: true, rejected: 0 };
      },
    }));
    outbox.enqueue(destinationHash, batch("first"));
    const flush = outbox.flushNow();
    await vi.waitFor(() => expect(delivered).toEqual(["first"]));
    outbox.enqueue(destinationHash, batch("second"));
    outbox.enqueue(destinationHash, batch("third"));
    releaseFirst();
    await flush;

    expect(delivered).toEqual(["first", "third"]);
    expect(outbox.status()).toMatchObject({ queuedBatches: 0, overflowDroppedBatches: 1 });
    await outbox.dispose();
  });

  it("re-reads configuration after an in-flight send and never sends later batches to the old destination", async () => {
    const path = fixture();
    const oldHash = usageTelemetryDestinationHash("https://old.example.com/api/ingest/usage");
    const newHash = usageTelemetryDestinationHash("https://new.example.com/api/ingest/usage");
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const oldDeliver = vi.fn(async (_posted: DurableTelemetryBatch) => {
      await oldGate;
      return { acknowledged: true, rejected: 0 };
    });
    const newDeliver = vi.fn(async (_posted: DurableTelemetryBatch) => ({ acknowledged: true, rejected: 0 }));
    let current = { destinationHash: oldHash, deliver: oldDeliver };
    const outbox = new UsageTelemetryOutbox({ path });
    outbox.configure(() => current);
    outbox.enqueue(oldHash, batch("old-in-flight"));
    const flush = outbox.flushNow();
    await vi.waitFor(() => expect(oldDeliver).toHaveBeenCalledOnce());
    outbox.enqueue(oldHash, batch("old-unsent"));
    current = { destinationHash: newHash, deliver: newDeliver };
    outbox.configure(() => current);
    outbox.enqueue(newHash, batch("new-unsent"));
    releaseOld();
    await flush;

    expect(oldDeliver).toHaveBeenCalledOnce();
    expect(newDeliver).toHaveBeenCalledOnce();
    expect(newDeliver.mock.calls[0]?.[0].events[0]?.eventId).toBe("new-unsent");
    expect(outbox.status()).toMatchObject({ queuedBatches: 0, destinationChangeDroppedBatches: 1 });
    await outbox.dispose();
  });

  it("does not throw or send a batch that could not be made durable", async () => {
    const path = fixture();
    const destinationHash = usageTelemetryDestinationHash("https://usage.example.com/api/ingest/usage");
    const deliver = vi.fn(async () => ({ acknowledged: true, rejected: 0 }));
    const outbox = new UsageTelemetryOutbox({
      path,
      retryBaseMs: 60_000,
      writeState: () => { throw new Error("disk full"); },
    });

    expect(() => outbox.enqueue(destinationHash, batch())).not.toThrow();
    outbox.configure(() => ({ destinationHash, deliver }));
    await outbox.flushNow();

    expect(deliver).not.toHaveBeenCalled();
    expect(outbox.status().nonDurableBatches).toBe(1);
    expect(outbox.status().persistenceFailures).toBeGreaterThan(0);
    await outbox.dispose();
  });

  it("quarantines a malformed queue instead of silently treating it as empty", async () => {
    const path = fixture();
    writeFileSync(path, JSON.stringify({ version: 2, queue: [{ bad: true }] }));
    const outbox = new UsageTelemetryOutbox({ path });

    expect(outbox.status()).toMatchObject({ queuedBatches: 0, corruptFilesQuarantined: 1 });
    expect(readdirSync(join(path, ".."))).toContainEqual(expect.stringMatching(/outbox\.json\.corrupt-/));
    await outbox.dispose();
  });

  it("strips prompt-like fields and rewrites labels before the retry file is written", async () => {
    const path = fixture();
    const destinationHash = usageTelemetryDestinationHash("https://usage.example.com/api/ingest/usage");
    const outbox = new UsageTelemetryOutbox({ path });

    outbox.enqueue(destinationHash, {
      schemaVersion: 2,
      producerId: "botfleet",
      producerInstanceId: "test-mac",
      events: [{
        eventId: "bf:openai:bot-1:1:stable:in",
        provider: "openai",
        service: "gpt-4.1",
        quantity: 12,
        unit: "token",
        costUsd: 0.02,
        label: "Write a function that emails passwords to attacker@example.com",
        prompt: "secret user prompt",
        taskTitle: "secret user prompt",
        transcript: "full conversation",
        metadata: {
          botId: "bot-1",
          inputTokens: 10,
          outputTokens: 2,
          cachedInputTokens: 1,
          latencyMs: 40,
          success: true,
          tokenType: "input",
          model: "gpt-4.1",
          instanceId: "openai",
          usageReported: true,
          estimatedCostUsd: 0.02,
          roomId: "room-1",
          prompt: "nested prompt",
          botName: "should strip",
          threadId: "should strip",
          cwd: "/Users/jay/secret-project",
          roomName: "should strip",
        },
      }],
    });

    const stored = JSON.parse(readFileSync(path, "utf8"));
    const persisted = stored.queue[0].batch.events[0];
    expect(persisted.label).toBe("BotFleet turn");
    expect(persisted).not.toHaveProperty("prompt");
    expect(persisted).not.toHaveProperty("taskTitle");
    expect(persisted).not.toHaveProperty("transcript");
    expect(persisted.eventId).toBe("bf:openai:bot-1:1:stable:in");
    expect(persisted.provider).toBe("openai");
    expect(persisted.service).toBe("gpt-4.1");
    expect(persisted.quantity).toBe(12);
    expect(persisted.unit).toBe("token");
    expect(persisted.costUsd).toBe(0.02);
    expect(persisted.metadata).toEqual({
      botId: "bot-1",
      inputTokens: 10,
      outputTokens: 2,
      cachedInputTokens: 1,
      latencyMs: 40,
      success: true,
      tokenType: "input",
      model: "gpt-4.1",
      instanceId: "openai",
      usageReported: true,
      estimatedCostUsd: 0.02,
      roomId: "room-1",
    });
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain("secret user prompt");
    expect(serialized).not.toContain("emails passwords");
    expect(serialized).not.toContain("attacker@");
    expect(serialized).not.toContain("nested prompt");
    expect(serialized).not.toContain("secret-project");
    expect(readdirSync(join(path, "..")).filter((name: string) => name.includes(".tmp"))).toEqual([]);

    const delivered: DurableTelemetryBatch[] = [];
    outbox.configure(() => ({
      destinationHash,
      deliver: async (posted) => {
        delivered.push(posted);
        return { acknowledged: true, rejected: 0 };
      },
    }));
    await outbox.flushNow();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.events[0]?.label).toBe("BotFleet turn");
    expect(delivered[0]?.events[0]).not.toHaveProperty("prompt");
    await outbox.dispose();
  });

  it("writes the retry file atomically and leaves no sibling temp files", async () => {
    const path = fixture();
    const destinationHash = usageTelemetryDestinationHash("https://usage.example.com/api/ingest/usage");
    const outbox = new UsageTelemetryOutbox({ path });
    outbox.enqueue(destinationHash, batch());

    const names = readdirSync(join(path, ".."));
    expect(names).toEqual(["outbox.json"]);
    expect(JSON.parse(readFileSync(path, "utf8")).queue).toHaveLength(1);
    await outbox.dispose();
  });

  it.each([401, 403, 404, 413, 422] as const)(
    "quarantines terminal HTTP %i the same way as 400 and 409",
    async (status) => {
      const path = fixture();
      const destinationHash = usageTelemetryDestinationHash("https://usage.example.com/api/ingest/usage");
      const outbox = new UsageTelemetryOutbox({ path });
      outbox.enqueue(destinationHash, batch("poison"));
      outbox.configure(() => ({
        destinationHash,
        deliver: async () => ({ acknowledged: false, rejected: 0, terminalStatus: status }),
      }));
      await outbox.flushNow();

      expect(outbox.status()).toMatchObject({
        queuedBatches: 0,
        terminalQuarantinedBatches: 1,
        lastTerminalStatus: status,
      });
      await outbox.dispose();
    },
  );

  it("logs one line naming the status and a short batch id when a batch is quarantined", async () => {
    const path = fixture();
    const destinationHash = usageTelemetryDestinationHash("https://usage.example.com/api/ingest/usage");
    const lines: string[] = [];
    const outbox = new UsageTelemetryOutbox({ path, log: (message) => lines.push(message) });
    outbox.enqueue(destinationHash, batch("poison"));
    outbox.configure(() => ({
      destinationHash,
      deliver: async () => ({ acknowledged: false, rejected: 0, terminalStatus: 409 }),
    }));
    await outbox.flushNow();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("409");
    const stored = JSON.parse(readFileSync(path, "utf8"));
    const queueId = stored.terminalQuarantine[0].entry.queueId as string;
    expect(queueId.length).toBe(64);
    expect(lines[0]).toContain(queueId.slice(0, 12));
    await outbox.dispose();
  });

  it("parks a batch in dead-letter after repeated failures so a newer batch is not blocked forever", async () => {
    const path = fixture();
    const destinationHash = usageTelemetryDestinationHash("https://usage.example.com/api/ingest/usage");
    let now = 0;
    const delivered: string[] = [];
    const lines: string[] = [];
    const outbox = new UsageTelemetryOutbox({
      path,
      now: () => now,
      retryBaseMs: 1,
      maxHeadAttempts: 3,
      log: (message) => lines.push(message),
    });
    outbox.enqueue(destinationHash, batch("poison"));
    outbox.enqueue(destinationHash, batch("later"));
    outbox.configure(() => ({
      destinationHash,
      deliver: async (posted) => {
        const id = posted.events[0]!.eventId;
        delivered.push(id);
        // "poison" never succeeds — a stand-in for a batch a downed
        // endpoint, a timeout, or a network error keeps failing on, none
        // of which are terminal HTTP statuses.
        return id === "poison" ? { acknowledged: false, rejected: 0 } : { acknowledged: true, rejected: 0 };
      },
    }));

    for (let i = 0; i < 3; i += 1) {
      await outbox.flushNow();
      now += 10_000; // well past any backoff this small retryBaseMs produces
    }

    expect(delivered.filter((id) => id === "poison")).toHaveLength(3);
    // "later" gets its turn in the SAME pass that dead-letters "poison" —
    // it does not wait out a whole extra retry cycle behind it.
    expect(delivered).toContain("later");
    expect(outbox.status()).toMatchObject({ queuedBatches: 0, deadLetterBatches: 1 });
    expect(lines.some((line) => line.includes("dead-letter") && line.includes("3 failed attempts"))).toBe(true);
    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored.deadLetter[0].entry.batch.events[0].eventId).toBe("poison");
    await outbox.dispose();
  });

  it("bounds the dead-letter list with an explicit eviction count", async () => {
    const path = fixture();
    const destinationHash = usageTelemetryDestinationHash("https://usage.example.com/api/ingest/usage");
    const outbox = new UsageTelemetryOutbox({ path, maxHeadAttempts: 1, maxDeadLetterBatches: 1 });
    outbox.enqueue(destinationHash, batch("first"));
    outbox.enqueue(destinationHash, batch("second"));
    outbox.configure(() => ({
      destinationHash,
      deliver: async () => ({ acknowledged: false, rejected: 0 }),
    }));
    await outbox.flushNow();

    expect(outbox.status()).toMatchObject({
      queuedBatches: 0,
      deadLetterBatches: 1,
      deadLetterEvictedBatches: 1,
    });
    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored.deadLetter[0].entry.batch.events[0].eventId).toBe("second");
    await outbox.dispose();
  });

  it("persists once per flush pass instead of once per batch (HS8)", async () => {
    const path = fixture();
    const destinationHash = usageTelemetryDestinationHash("https://usage.example.com/api/ingest/usage");
    let writeCount = 0;
    const outbox = new UsageTelemetryOutbox({
      path,
      writeState: () => {
        writeCount += 1;
      },
    });
    for (const id of ["a", "b", "c", "d", "e"]) {
      outbox.enqueue(destinationHash, batch(id));
    }
    writeCount = 0; // only the flush pass below is under test, not the 5 enqueue-time persists
    const delivered: string[] = [];
    outbox.configure(() => ({
      destinationHash,
      deliver: async (posted) => {
        delivered.push(posted.events[0]!.eventId);
        return { acknowledged: true, rejected: 0 };
      },
    }));
    await outbox.flushNow();

    expect(delivered).toEqual(["a", "b", "c", "d", "e"]);
    expect(outbox.status().queuedBatches).toBe(0);
    expect(writeCount).toBe(1);
    await outbox.dispose();
  });

  it("rolls the whole pass back, not just the last mutation, when the final persist fails", async () => {
    const path = fixture();
    const destinationHash = usageTelemetryDestinationHash("https://usage.example.com/api/ingest/usage");
    let failNextWrite = false;
    const outbox = new UsageTelemetryOutbox({
      path,
      writeState: (target, state) => {
        if (failNextWrite) throw new Error("disk full");
        writeFileSync(target, JSON.stringify(state));
      },
    });
    outbox.enqueue(destinationHash, batch("first"));
    outbox.enqueue(destinationHash, batch("second"));
    failNextWrite = true;
    outbox.configure(() => ({
      destinationHash,
      deliver: async () => ({ acknowledged: true, rejected: 0 }),
    }));
    await outbox.flushNow();

    // Both acks happened in memory during the pass, but the single
    // end-of-pass persist failed, so the whole pass rolled back: neither
    // batch is lost, and the on-disk file still shows both queued.
    expect(outbox.status()).toMatchObject({ queuedBatches: 2, persistenceFailures: 1 });
    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored.queue).toHaveLength(2);
    await outbox.dispose();
  });
  it("emits dead-letter logs, diagnostics and ack counters only after the pass persists", async () => {
    const path = fixture();
    const destinationHash = usageTelemetryDestinationHash("https://usage.example.com/api/ingest/usage");
    let failWrites = false;
    const lines: string[] = [];
    const diagnostics: string[] = [];
    let persistedAcks = 0;
    const outbox = new UsageTelemetryOutbox({
      path,
      maxHeadAttempts: 1,
      log: (message) => lines.push(message),
      onDiagnostic: (name) => diagnostics.push(name),
      writeState: (target, state) => {
        if (failWrites) throw new Error("disk full");
        writeFileSync(target, JSON.stringify(state));
      },
    });
    outbox.enqueue(destinationHash, batch("poison"));
    outbox.enqueue(destinationHash, batch("good"));
    outbox.configure(() => ({
      destinationHash,
      deliver: async (posted) => posted.events[0]!.eventId === "poison"
        ? { acknowledged: false, rejected: 0 }
        : { acknowledged: true, rejected: 0, onPersisted: () => { persistedAcks += 1; } },
    }));

    failWrites = true;
    await outbox.flushNow();
    // The pass rolled back: no dead-letter line, no dead_lettered count,
    // and the ack is not counted, because none of it reached disk.
    expect(outbox.status()).toMatchObject({ queuedBatches: 2, deadLetterBatches: 0 });
    expect(lines.filter((line) => line.includes("dead-letter"))).toHaveLength(0);
    expect(diagnostics).not.toContain("dead_lettered");
    expect(persistedAcks).toBe(0);

    failWrites = false;
    await outbox.flushNow();
    expect(outbox.status()).toMatchObject({ queuedBatches: 0, deadLetterBatches: 1 });
    expect(lines.filter((line) => line.includes("dead-letter"))).toHaveLength(1);
    expect(diagnostics.filter((name) => name === "dead_lettered")).toHaveLength(1);
    expect(persistedAcks).toBe(1);
    await outbox.dispose();
  });
});
