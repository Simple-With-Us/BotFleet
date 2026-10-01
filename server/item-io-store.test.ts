// The side store keeps what a step took and returned, bounded, redacted and
// rotated.  Every test hands the store its own small directory and small caps,
// so the behaviour is pinned without writing megabytes.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ITEM_ID_MAX_LENGTH, ItemIoStore } from "./item-io-store.ts";
import { ITEM_IO_FIELD_LIMIT, boundText } from "../shared/item-io.ts";

const dirs: string[] = [];
const stores: ItemIoStore[] = [];

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "omb-item-io-"));
  dirs.push(dir);
  return dir;
}

function makeStore(options: ConstructorParameters<typeof ItemIoStore>[0]) {
  const store = new ItemIoStore(options);
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.flush()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const SECRET = `sk-proj-${"b".repeat(24)}`;

describe("recording and reading a step", () => {
  it("merges the start and the end of one step into one answer", async () => {
    const store = makeStore({ dir: tmp() });
    store.record("thread-1", { itemId: "toolu_1", turnId: "turn-1", io: { input: boundText('{\n  "command": "ls"\n}') } });
    store.record("thread-1", { itemId: "toolu_1", turnId: "turn-1", io: { output: boundText("a.ts\nb.ts") } });
    const io = await store.read("thread-1", "toolu_1", "turn-1");
    expect(io).toMatchObject({
      itemId: "toolu_1",
      turnId: "turn-1",
      input: { text: '{\n  "command": "ls"\n}', truncated: false },
      output: { text: "a.ts\nb.ts", truncated: false, length: 9 },
    });
    expect(io).not.toHaveProperty("text");
  });

  it("answers null for a step it never saw", async () => {
    const store = makeStore({ dir: tmp() });
    store.record("thread-1", { itemId: "toolu_1", io: { output: boundText("x") } });
    expect(await store.read("thread-1", "toolu_2")).toBeNull();
    expect(await store.read("thread-2", "toolu_1")).toBeNull();
  });

  it("lets the settled arguments replace the fragment the start carried", async () => {
    const store = makeStore({ dir: tmp() });
    store.record("t", { itemId: "call_1", io: { input: boundText('{"pa') } });
    store.record("t", { itemId: "call_1", io: { input: boundText('{"path":"a"}') } });
    expect((await store.read("t", "call_1"))?.input?.text).toBe('{"path":"a"}');
  });

  it("keeps a context record's full text under its own field", async () => {
    const store = makeStore({ dir: tmp() });
    store.record("t", { itemId: "ctx-1", io: { text: boundText("remember the milk") } });
    const io = await store.read("t", "ctx-1");
    expect(io?.text?.text).toBe("remember the milk");
    expect(io).not.toHaveProperty("input");
  });

  it("narrows to the turn when two turns reuse one item id", async () => {
    const store = makeStore({ dir: tmp() });
    store.record("t", { itemId: "item_0", turnId: "turn-1", io: { output: boundText("first turn") } });
    store.record("t", { itemId: "item_0", turnId: "turn-2", io: { output: boundText("second turn") } });
    expect((await store.read("t", "item_0", "turn-1"))?.output?.text).toBe("first turn");
    expect((await store.read("t", "item_0", "turn-2"))?.output?.text).toBe("second turn");
    // no turn named: the newest wins
    expect((await store.read("t", "item_0"))?.output?.text).toBe("second turn");
  });

  it("writes nothing for a capture with no text in it", async () => {
    const dir = tmp();
    const store = makeStore({ dir });
    store.record("t", { itemId: "a", io: {} });
    store.record("t", { itemId: "a", io: { input: { text: "", truncated: false, length: 0 } } });
    await store.flush();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("skips a line damaged by a trim and still finds the record before it", async () => {
    const dir = tmp();
    const store = makeStore({ dir });
    store.record("t", { itemId: "a", io: { output: boundText("good") } });
    await store.flush();
    const file = join(dir, "t.ndjson");
    writeFileSync(file, `${readFileSync(file, "utf8")}{"v":1,"itemId":"a","output":{"text":"cut of\n`);
    expect((await store.read("t", "a"))?.output?.text).toBe("good");
  });
});

describe("bounds", () => {
  it("cuts a field to 32 KB, says it was cut, and keeps the original length", async () => {
    const store = makeStore({ dir: tmp() });
    const big = "z".repeat(ITEM_IO_FIELD_LIMIT * 3);
    store.record("t", { itemId: "big", io: { output: boundText(big, big.length) } });
    const io = await store.read("t", "big");
    expect(io?.output?.text.length).toBe(ITEM_IO_FIELD_LIMIT);
    expect(io?.output?.truncated).toBe(true);
    expect(io?.output?.length).toBe(big.length);
  });

  it("keeps a driver's own truncation flag and length", async () => {
    const store = makeStore({ dir: tmp() });
    store.record("t", { itemId: "a", io: { output: { text: "head", truncated: true, length: 5_000_000 } } });
    expect(await store.read("t", "a")).toMatchObject({ output: { text: "head", truncated: true, length: 5_000_000 } });
  });

  it("rotates a thread's file at its cap and still serves the generation it displaced", async () => {
    const dir = tmp();
    const store = makeStore({ dir, maxBytes: 1000 });
    for (let i = 0; i < 6; i += 1) {
      store.record("t", { itemId: `item-${i}`, io: { output: boundText(`payload ${i} ${"p".repeat(100)}`) } });
    }
    await store.flush();
    expect(existsSync(join(dir, "t.ndjson"))).toBe(true);
    expect(existsSync(join(dir, "t.ndjson.1"))).toBe(true);
    // the newest is in the live file, an older one in the rotated generation
    expect((await store.read("t", "item-5"))?.output?.text).toContain("payload 5");
    expect((await store.read("t", "item-1"))?.output?.text).toContain("payload 1");
  });

  it("forgets a step once it is two generations old rather than growing forever", async () => {
    const dir = tmp();
    const store = makeStore({ dir, maxBytes: 300 });
    for (let i = 0; i < 12; i += 1) {
      store.record("t", { itemId: `item-${i}`, io: { output: boundText(`payload ${i} ${"p".repeat(120)}`) } });
    }
    await store.flush();
    expect(await store.read("t", "item-0")).toBeNull();
    expect((await store.read("t", "item-11"))?.output?.text).toContain("payload 11");
    const bytes = readdirSync(dir).reduce((sum, name) => sum + readFileSync(join(dir, name)).length, 0);
    // two generations of the cap, plus at most the one record that crossed it
    expect(bytes).toBeLessThan(300 * 2 + 400);
  });

  it("drops its oldest queued records before it grows without bound", async () => {
    const store = makeStore({ dir: tmp(), maxQueuedBytes: 2000, report: () => undefined });
    for (let i = 0; i < 40; i += 1) {
      store.record("t", { itemId: `item-${i}`, io: { output: boundText("q".repeat(500)) } });
    }
    expect(store.stats().pendingBytes).toBeLessThanOrEqual(2600);
    expect(store.stats().dropped).toBeGreaterThan(0);
  });
});

describe("redaction", () => {
  it("never writes a credential to disk", async () => {
    const dir = tmp();
    const store = makeStore({ dir });
    store.record("t", {
      itemId: "a",
      io: { input: boundText(`{"header":"Authorization: Bearer ${SECRET}"}`), output: boundText(`key is ${SECRET}`) },
    });
    await store.flush();
    const onDisk = readFileSync(join(dir, "t.ndjson"), "utf8");
    expect(onDisk).not.toContain(SECRET);
    expect(onDisk).toContain("redacted");
  });

  it("redacts what it serves even when an older record on disk was not", async () => {
    const dir = tmp();
    const store = makeStore({ dir });
    // a record written before a pattern existed: the file holds the secret
    writeFileSync(
      join(dir, "t.ndjson"),
      `${JSON.stringify({ v: 1, at: "2026-09-30T00:00:00.000Z", itemId: "old", output: { text: `token ${SECRET}`, truncated: false, length: 40 } })}\n`,
    );
    const io = await store.read("t", "old");
    expect(io?.output?.text).not.toContain(SECRET);
    expect(io?.output?.text).toContain("redacted");
  });

  it("redacts before it cuts, so a secret straddling the limit is not half shown", async () => {
    const store = makeStore({ dir: tmp() });
    // the cut would land five characters into the secret: cutting first would
    // leave "sk-pr" standing, redacting first leaves the start of a mask
    const padded = `${"x".repeat(ITEM_IO_FIELD_LIMIT - 6)} ${SECRET}`;
    store.record("t", { itemId: "a", io: { output: boundText(padded, padded.length) } });
    const text = (await store.read("t", "a"))?.output?.text ?? "";
    expect(text.length).toBe(ITEM_IO_FIELD_LIMIT);
    expect(text).not.toContain("sk-p");
  });
});

describe("keys and failures", () => {
  it("refuses a thread id that is not safe as a file name", async () => {
    const dir = tmp();
    const store = makeStore({ dir });
    store.record("../escape", { itemId: "a", io: { output: boundText("x") } });
    store.record("a/b", { itemId: "a", io: { output: boundText("x") } });
    await store.flush();
    expect(readdirSync(dir)).toEqual([]);
    expect(await store.read("../escape", "a")).toBeNull();
  });

  it("refuses an empty or oversized item id", async () => {
    const dir = tmp();
    const store = makeStore({ dir });
    store.record("t", { itemId: "", io: { output: boundText("x") } });
    store.record("t", { itemId: "i".repeat(ITEM_ID_MAX_LENGTH + 1), io: { output: boundText("x") } });
    await store.flush();
    expect(readdirSync(dir)).toEqual([]);
    expect(await store.read("t", "")).toBeNull();
  });

  it("finds an item id that carries JSON-significant characters", async () => {
    const store = makeStore({ dir: tmp() });
    const itemId = 'conv "1":step/2';
    store.record("t", { itemId, io: { output: boundText("fine") } });
    expect((await store.read("t", itemId))?.output?.text).toBe("fine");
  });

  it("never throws at its caller when the disk refuses a write", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = makeStore({
      dir: tmp(),
      append: () => {
        throw new Error("disk full");
      },
    });
    expect(() => store.record("t", { itemId: "a", io: { output: boundText("x") } })).not.toThrow();
    await store.flush();
    expect(await store.read("t", "a")).toBeNull();
    expect(error).toHaveBeenCalled();
  });

  it("reports an outage once, counts the rest, and says so when writing recovers", async () => {
    const lines: string[] = [];
    let failing = true;
    const store = makeStore({
      dir: tmp(),
      report: (line) => lines.push(line),
      append: async (file, data, options) => {
        if (failing) throw new Error("ENOSPC: no space left on device");
        await appendFile(file, data, options);
      },
    });
    for (let i = 0; i < 25; i += 1) store.record("t", { itemId: `step-${i}`, io: { output: boundText("x") } });
    await store.flush();
    // twenty-five failed records, one line, naming the reason and no stack
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("ENOSPC");
    expect(lines[0]).not.toContain("    at ");

    failing = false;
    store.record("t", { itemId: "after", io: { output: boundText("back") } });
    await store.flush();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("recovered after 25 failed records");
    expect((await store.read("t", "after"))?.output?.text).toBe("back");

    // a healthy store stays silent
    store.record("t", { itemId: "again", io: { output: boundText("fine") } });
    await store.flush();
    expect(lines).toHaveLength(2);
  });

  it("recreates its directory if it was removed under it", async () => {
    const parent = tmp();
    const dir = join(parent, "item-io");
    const store = makeStore({ dir });
    store.record("t", { itemId: "a", io: { output: boundText("x") } });
    await store.flush();
    expect(existsSync(dir)).toBe(true);
  });
});

describe("cleanup", () => {
  it("removes both generations of a deleted thread and leaves its neighbours", async () => {
    const dir = tmp();
    const store = makeStore({ dir, maxBytes: 300 });
    for (let i = 0; i < 6; i += 1) {
      store.record("gone", { itemId: `item-${i}`, io: { output: boundText(`payload ${i} ${"p".repeat(120)}`) } });
    }
    store.record("kept", { itemId: "a", io: { output: boundText("keep me") } });
    await store.flush();
    expect(existsSync(join(dir, "gone.ndjson.1"))).toBe(true);
    expect(store.remove(["gone"])).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(dir, "gone.ndjson"))).toBe(false);
    expect(existsSync(join(dir, "gone.ndjson.1"))).toBe(false);
    expect(await store.read("gone", "item-5")).toBeNull();
    expect((await store.read("kept", "a"))?.output?.text).toBe("keep me");
  });
});
