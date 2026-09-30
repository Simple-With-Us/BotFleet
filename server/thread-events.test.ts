import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readThreadEvents } from "./thread-events.ts";

const dirs: string[] = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "omb-thread-events-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const line = (o: unknown) => JSON.stringify(o) + "\n";
const runtime = (event: Record<string, unknown>) => ({ provider: "test", threadId: "t1", ...event });

describe("readThreadEvents", () => {
  it("returns an empty page when neither log exists", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    expect(readThreadEvents({ eventsDir, nativeDir, threadId: "t1" })).toEqual({
      entries: [],
      total: { runtime: 0, native: 0 },
    });
  });

  it("merges runtime and native lines by time, tagging their source", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    writeFileSync(
      join(eventsDir, "t1.ndjson"),
      line(runtime({ eventId: "e1", type: "turn.started", createdAt: "2026-08-17T10:00:00.000Z" })) +
        line(runtime({ eventId: "e2", type: "turn.completed", createdAt: "2026-08-17T10:00:02.000Z", ok: true })),
    );
    writeFileSync(
      join(nativeDir, "t1.ndjson"),
      line({ at: "2026-08-17T10:00:01.000Z", dir: "out", source: "claude.sdk.message", msg: { type: "user" } }),
    );
    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1" });
    expect(page.total).toEqual({ runtime: 2, native: 1 });
    expect(page.entries.map((e) => [e.kind, e.at])).toEqual([
      ["runtime", "2026-08-17T10:00:00.000Z"],
      ["native", "2026-08-17T10:00:01.000Z"],
      ["runtime", "2026-08-17T10:00:02.000Z"],
    ]);
    // each entry keeps its original record whole under `data`
    expect(page.entries[1]).toMatchObject({ kind: "native", data: { dir: "out", msg: { type: "user" } } });
    expect(page.entries[0]).toMatchObject({ kind: "runtime", data: { eventId: "e1" } });
  });

  it("caps each log to its most recent `limit` lines and reports what it skipped", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    let body = "";
    for (let i = 0; i < 10; i++) {
      body += line(runtime({ eventId: `e${i}`, type: "content.delta", createdAt: `2026-08-17T10:00:${String(i).padStart(2, "0")}.000Z`, streamKind: "assistant_text", delta: String(i) }));
    }
    writeFileSync(join(eventsDir, "t1.ndjson"), body);
    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: 3 });
    expect(page.entries.map((e) => (e.data as { eventId: string }).eventId)).toEqual(["e7", "e8", "e9"]);
    expect(page.total.runtime).toBe(10);
  });

  it("skips a corrupt line rather than failing the whole read", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    writeFileSync(
      join(eventsDir, "t1.ndjson"),
      line(runtime({ eventId: "e1", type: "turn.started", createdAt: "2026-08-17T10:00:00.000Z" })) +
        "{not json\n" +
        line(runtime({ eventId: "e2", type: "turn.completed", createdAt: "2026-08-17T10:00:02.000Z", ok: true })),
    );
    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1" });
    expect(page.entries).toHaveLength(2);
    // `total` is the number of non-empty log lines; malformed records are
    // counted but deliberately absent from the returned entries.
    expect(page.total.runtime).toBe(3);
  });

  it("discards JSON-valid records that do not satisfy the inspector wire contract", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    writeFileSync(
      join(eventsDir, "t1.ndjson"),
      line(null) +
        line({ eventId: "incomplete", provider: "claude", threadId: "t1", createdAt: "1", type: "content.delta", streamKind: "assistant_text" }) +
        line({ eventId: "valid", provider: "claude", threadId: "t1", createdAt: "2", type: "content.delta", streamKind: "assistant_text", delta: "ok" }),
    );
    writeFileSync(join(nativeDir, "t1.ndjson"), line(null) + line({ at: "2", dir: "in", source: "claude", msg: {} }));
    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1" });
    expect(page.entries.map((entry) => [entry.kind, (entry.data as { eventId?: string }).eventId])).toEqual([
      ["runtime", "valid"],
      ["native", undefined],
    ]);
    expect(page.total).toEqual({ runtime: 3, native: 2 });
  });

  it("rejects malformed retry telemetry while retaining a valid retry event", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    const retry = (eventId: string, attempt: unknown, delayMs: unknown, reason: unknown) =>
      runtime({ eventId, createdAt: eventId, type: "turn.retrying", attempt, delayMs, reason });
    writeFileSync(
      join(eventsDir, "t1.ndjson"),
      line(retry("fractional", 1.5, 1_000, "overloaded")) +
        line(retry("negative-attempt", -1, 1_000, "overloaded")) +
        line(retry("negative-delay", 1, -1, "overloaded")) +
        line(retry("infinite-delay", 1, Number.POSITIVE_INFINITY, "overloaded")) +
        line(retry("missing-reason", 1, 1_000, undefined)) +
        line(retry("valid-retry", 1, 1_000, "overloaded")),
    );

    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1" });
    expect(page.entries.map((entry) => (entry.data as { eventId: string }).eventId)).toEqual(["valid-retry"]);
  });

  it("keeps walking backward when a corrupt tail record would otherwise consume the limit", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    const body = Array.from({ length: 20 }, (_, i) =>
      line(runtime({ eventId: `e${i}`, type: "content.delta", createdAt: `2026-08-17T10:00:${String(i).padStart(2, "0")}.000Z`, streamKind: "assistant_text", delta: String(i) })),
    ).join("");
    writeFileSync(join(eventsDir, "t1.ndjson"), body + "{broken}\n");
    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: 3 });
    expect(page.entries.map((e) => (e.data as { eventId: string }).eventId)).toEqual(["e17", "e18", "e19"]);
    expect(page.total.runtime).toBe(21);
  });

  it("normalizes non-finite and fractional limits at the helper boundary", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    writeFileSync(join(eventsDir, "t1.ndjson"), line(runtime({ eventId: "e1", createdAt: "1", type: "turn.started" })) + line(runtime({ eventId: "e2", createdAt: "2", type: "turn.started" })));
    expect(readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: Number.NaN }).entries).toHaveLength(2);
    expect(readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: 1.9 }).entries).toHaveLength(1);
  });

  it("updates cached totals from appended bytes and preserves multibyte records across read chunks", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    const file = join(eventsDir, "t1.ndjson");
    writeFileSync(file, line(runtime({ eventId: "large", createdAt: "1", type: "turn.started", text: "🐭".repeat(40_000) })));
    expect(readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: 2 }).total.runtime).toBe(1);

    appendFileSync(file, line(runtime({ eventId: "latest", createdAt: "2", type: "turn.started" })));
    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: 2 });
    expect(page.total.runtime).toBe(2);
    expect(page.entries.map((entry) => (entry.data as { eventId: string }).eventId)).toEqual(["large", "latest"]);
    expect((page.entries[0]!.data as { text: string }).text.startsWith("🐭🐭")).toBe(true);
  });

  // A log rotates at its byte cap (server/transcript-retention.ts): the live
  // file starts fresh and the generation it displaced sits beside it as
  // `<threadId>.ndjson.1`.  The panel must not notice the seam.
  it("completes a short page from the rotated generation, oldest first", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    writeFileSync(
      join(eventsDir, "t1.ndjson.1"),
      line(runtime({ eventId: "e1", createdAt: "1", type: "turn.started" })) + line(runtime({ eventId: "e2", createdAt: "2", type: "turn.started" })),
    );
    writeFileSync(join(eventsDir, "t1.ndjson"), line(runtime({ eventId: "e3", createdAt: "3", type: "turn.started" })));
    writeFileSync(join(nativeDir, "t1.ndjson.1"), line({ at: "1", dir: "out", source: "acp", msg: { rotated: true } }));
    writeFileSync(join(nativeDir, "t1.ndjson"), line({ at: "4", dir: "in", source: "acp", msg: { live: true } }));

    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1" });
    expect(page.entries.map((entry) => entry.at)).toEqual(["1", "1", "2", "3", "4"]);
    expect(page.total).toEqual({ runtime: 3, native: 2 });
  });

  it("takes only the newest lines when the live file alone fills the page, and still counts what is rotated", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    writeFileSync(
      join(eventsDir, "t1.ndjson.1"),
      line(runtime({ eventId: "old1", createdAt: "1", type: "turn.started" })) + line(runtime({ eventId: "old2", createdAt: "2", type: "turn.started" })),
    );
    writeFileSync(
      join(eventsDir, "t1.ndjson"),
      line(runtime({ eventId: "new1", createdAt: "3", type: "turn.started" })) + line(runtime({ eventId: "new2", createdAt: "4", type: "turn.started" })),
    );

    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: 2 });
    expect(page.entries.map((entry) => (entry.data as { eventId: string }).eventId)).toEqual(["new1", "new2"]);
    // "showing 2 of 4": the rotated generation is still on disk and still counted
    expect(page.total.runtime).toBe(4);
  });

  it("reads a live file that is empty because it was just rotated", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    writeFileSync(join(eventsDir, "t1.ndjson.1"), line(runtime({ eventId: "e1", createdAt: "1", type: "turn.started" })));
    writeFileSync(join(eventsDir, "t1.ndjson"), "");

    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1" });
    expect(page.entries.map((entry) => (entry.data as { eventId: string }).eventId)).toEqual(["e1"]);
    expect(page.total.runtime).toBe(1);
  });

  // The window is the reason a page can be short: `readTail` stops after
  // `maxTailBytes` whether or not it has `limit` lines.  Splicing the rotated
  // generation onto a page that stopped there would jump over every record in
  // between and read as one continuous history.
  it("never splices the rotated generation onto a live page cut short by the window", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    const rotated: string[] = [];
    const live: string[] = [];
    let rotatedBody = "";
    let liveBody = "";
    for (let i = 0; i < 100; i++) {
      const eventId = `rotated-${String(i).padStart(4, "0")}`;
      rotated.push(eventId);
      rotatedBody += line(runtime({ eventId, createdAt: String(i).padStart(6, "0"), type: "turn.started" }));
    }
    for (let i = 0; i < 40; i++) {
      const eventId = `live-${String(i).padStart(4, "0")}`;
      live.push(eventId);
      liveBody += line(runtime({ eventId, createdAt: String(1000 + i).padStart(6, "0"), type: "turn.started", text: "x".repeat(4_000) }));
    }
    writeFileSync(join(eventsDir, "t1.ndjson.1"), rotatedBody);
    writeFileSync(join(eventsDir, "t1.ndjson"), liveBody);

    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: 300, maxTailBytes: 64 * 1024 });
    const ids = page.entries.map((entry) => (entry.data as { eventId: string }).eventId);
    // short of `limit`, because the window ran out — not because the file did
    expect(ids.length).toBeGreaterThan(1);
    expect(ids.length).toBeLessThan(live.length);
    // and every row is the contiguous newest run of the LIVE file
    expect(ids).toEqual(live.slice(-ids.length));
    // the rotated generation is still counted, just not spliced on
    expect(page.total.runtime).toBe(140);
  });

  it("still completes a short page from the rotated generation when the live file was read to its first byte", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    writeFileSync(
      join(eventsDir, "t1.ndjson.1"),
      line(runtime({ eventId: "e1", createdAt: "000001", type: "turn.started" })) + line(runtime({ eventId: "e2", createdAt: "000002", type: "turn.started" })),
    );
    writeFileSync(join(eventsDir, "t1.ndjson"), line(runtime({ eventId: "e3", createdAt: "000003", type: "turn.started" })));

    // a window far larger than either file: the live read reaches byte zero
    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: 300, maxTailBytes: 64 * 1024 });
    expect(page.entries.map((entry) => (entry.data as { eventId: string }).eventId)).toEqual(["e1", "e2", "e3"]);
    expect(page.total.runtime).toBe(3);
  });

  // A single record wider than the window leaves the backward scan with no
  // newline to cut on.  Returning nothing there blanks the panel for exactly
  // the thread whose newest message is the reason it was opened — but reading
  // and parsing the record instead would put a multi-megabyte JSON.parse on
  // the event loop, on a route the panel refetches after every turn.  So the
  // page says what is there without touching it.
  it("stands in for a record wider than the window instead of parsing it", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    writeFileSync(
      join(eventsDir, "t1.ndjson"),
      line(runtime({ eventId: "small", createdAt: "000001", type: "turn.started" })) +
        line(runtime({ eventId: "huge", createdAt: "000002", type: "turn.started", text: "x".repeat(200_000) })),
    );

    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: 300, maxTailBytes: 64 * 1024 });
    expect(page.entries).toHaveLength(1);
    const standIn = page.entries[0]!.data as { type: string; message: string; text?: string };
    expect(standIn.type).toBe("runtime.error");
    expect(standIn.message).toMatch(/0\.2 MB record was skipped/);
    // the record itself was never read, so none of its payload is here
    expect(standIn.text).toBeUndefined();
    expect(JSON.stringify(page).length).toBeLessThan(2_000);
    // the count never lied about what is on disk
    expect(page.total.runtime).toBe(2);
  });

  it("stands in for an oversized native record too, naming its size", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    writeFileSync(
      join(nativeDir, "t1.ndjson"),
      line({ at: "000001", dir: "in", source: "acp", msg: { blob: "y".repeat(200_000) } }),
    );

    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: 300, maxTailBytes: 64 * 1024 });
    expect(page.entries).toHaveLength(1);
    const standIn = page.entries[0]!.data as { msg: { skipped: string; bytes: number } };
    expect(standIn.msg.skipped).toMatch(/record was skipped/);
    expect(standIn.msg.bytes).toBeGreaterThan(200_000);
  });

  // The fallback reads to byte zero when the oversized record is the file's
  // first: that live file IS fully read, so the rotated generation behind it
  // still completes the page.
  it("completes the page from the rotated generation when the oversized record starts the live file", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    let rotatedBody = "";
    const rotated: string[] = [];
    for (let i = 0; i < 100; i++) {
      const eventId = `rotated-${String(i).padStart(4, "0")}`;
      rotated.push(eventId);
      rotatedBody += line(runtime({ eventId, createdAt: String(i).padStart(6, "0"), type: "turn.started" }));
    }
    writeFileSync(join(eventsDir, "t1.ndjson.1"), rotatedBody);
    writeFileSync(
      join(eventsDir, "t1.ndjson"),
      line(runtime({ eventId: "huge", createdAt: "999999", type: "turn.started", text: "x".repeat(200_000) })),
    );

    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: 300, maxTailBytes: 64 * 1024 });
    expect(page.entries).toHaveLength(101);
    expect(page.entries.slice(0, 100).map((entry) => (entry.data as { eventId: string }).eventId)).toEqual(rotated);
    expect((page.entries[100]!.data as { message: string }).message).toMatch(/record was skipped/);
    expect(page.total.runtime).toBe(101);
  });

  // Both writers append a record and its newline in one call, so bytes after
  // the last newline are a document cut in half by a kill, not a record.
  it("ignores a torn last line and does not count it", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    writeFileSync(
      join(eventsDir, "t1.ndjson"),
      line(runtime({ eventId: "e1", createdAt: "000001", type: "turn.started" })) +
        line(runtime({ eventId: "e2", createdAt: "000002", type: "turn.started" })) +
        '{"eventId":"torn","provider":"test","threa',
    );

    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1" });
    expect(page.entries.map((entry) => (entry.data as { eventId: string }).eventId)).toEqual(["e1", "e2"]);
    expect(page.total.runtime).toBe(2);
  });

  it("ignores a torn last line behind an oversized record", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    writeFileSync(
      join(eventsDir, "t1.ndjson"),
      line(runtime({ eventId: "huge", createdAt: "000002", type: "turn.started", text: "x".repeat(200_000) })) +
        '{"eventId":"torn","provider":"test","threa',
    );

    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: 300, maxTailBytes: 64 * 1024 });
    expect(page.entries).toHaveLength(1);
    expect((page.entries[0]!.data as { message: string }).message).toMatch(/record was skipped/);
    expect(page.total.runtime).toBe(1);
  });

  // A kill mid-write can leave a live file holding one partial record and no
  // newline at all.  Nothing complete is in there, so the file IS fully read
  // and the rotated generation behind it completes the page — the panel must
  // not say "showing 0 of 100" while a hundred records sit beside it.
  it("completes the page from the rotated generation when the live file is one torn partial", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    let rotatedBody = "";
    const rotated: string[] = [];
    for (let i = 0; i < 100; i++) {
      const eventId = `rotated-${String(i).padStart(4, "0")}`;
      rotated.push(eventId);
      rotatedBody += line(runtime({ eventId, createdAt: String(i).padStart(6, "0"), type: "turn.started" }));
    }
    writeFileSync(join(eventsDir, "t1.ndjson.1"), rotatedBody);
    // the same shape as a 9 MB partial against the 8 MB production window,
    // sized to the window this test injects
    writeFileSync(join(eventsDir, "t1.ndjson"), `{"eventId":"torn","text":"${"x".repeat(200_000)}`);

    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: 300, maxTailBytes: 64 * 1024 });
    expect(page.entries.map((entry) => (entry.data as { eventId: string }).eventId)).toEqual(rotated);
    expect(page.total.runtime).toBe(100);
  });

  // The backward scan used to decode the whole accumulated tail on every
  // 64 KB step, which is quadratic in the window: 12 MB of 100 KB records
  // decoded 524 MB and blocked the event loop for about 150 ms per request.
  it("decodes the tail once, not once per chunk", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    let body = "";
    for (let i = 0; i < 12; i++) {
      body += line(runtime({ eventId: `e${i}`, createdAt: String(i).padStart(6, "0"), type: "turn.started", text: "x".repeat(100_000) }));
    }
    writeFileSync(join(eventsDir, "t1.ndjson"), body);

    const window = 512 * 1024;
    let calls = 0;
    let decoded = 0;
    const page = readThreadEvents({
      eventsDir,
      nativeDir,
      threadId: "t1",
      limit: 300,
      maxTailBytes: window,
      decode: (bytes) => {
        calls += 1;
        decoded += bytes.length;
        return bytes.toString("utf8");
      },
    });

    // the page is still the newest records the window holds
    expect(page.entries.length).toBeGreaterThan(1);
    expect((page.entries.at(-1)!.data as { eventId: string }).eventId).toBe("e11");
    expect(page.total.runtime).toBe(12);
    // one pass over the window, not one per chunk: the old scan decoded
    // 64 + 128 + … + 512 KB for this same fixture
    expect(calls).toBeLessThanOrEqual(2);
    expect(decoded).toBeLessThanOrEqual(window + 64 * 1024);
  });

  // The Trajectory tab reads the runtime log alone: no native tee, no streamed
  // deltas (a paragraph is hundreds of them and the settled item carries the
  // text), long fields clipped, and a flag for records still on disk behind
  // the page.
  describe("runtimeOnly (the Trajectory tab's read)", () => {
    const delta = (i: number) =>
      runtime({ eventId: `d${i}`, type: "content.delta", createdAt: String(i).padStart(6, "0"), streamKind: "assistant_text", delta: "x" });
    const started = (id: string, at: string) => runtime({ eventId: id, type: "turn.started", createdAt: at });

    it("never opens the native tee and leaves the streamed deltas out", () => {
      const eventsDir = tmp();
      const nativeDir = tmp();
      writeFileSync(join(nativeDir, "t1.ndjson"), line({ at: "000002", dir: "in", source: "claude", msg: { type: "user" } }));
      writeFileSync(
        join(eventsDir, "t1.ndjson"),
        line(started("e1", "000001")) + line(delta(2)) + line(delta(3)) + line(started("e4", "000004")),
      );
      const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", runtimeOnly: true });
      expect(page.entries.map((e) => [e.kind, (e.data as { eventId: string }).eventId])).toEqual([
        ["runtime", "e1"],
        ["runtime", "e4"],
      ]);
      // the line count still counts every line, deltas included
      expect(page.total).toEqual({ runtime: 4, native: 0 });
      expect(page.older).toBe(false);
    });

    it("keeps looking back past deltas so the limit counts steps, not tokens", () => {
      const eventsDir = tmp();
      const nativeDir = tmp();
      let body = line(started("first", "000000"));
      for (let i = 1; i <= 50; i++) body += line(delta(i));
      body += line(started("last", "000099"));
      writeFileSync(join(eventsDir, "t1.ndjson"), body);
      const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", runtimeOnly: true, limit: 2 });
      expect(page.entries.map((e) => (e.data as { eventId: string }).eventId)).toEqual(["first", "last"]);
      expect(page.older).toBe(false);
    });

    it("reports older records when the page is full and the file holds more", () => {
      const eventsDir = tmp();
      const nativeDir = tmp();
      let body = "";
      for (let i = 0; i < 5; i++) body += line(started(`e${i}`, String(i).padStart(6, "0")));
      writeFileSync(join(eventsDir, "t1.ndjson"), body);
      const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", runtimeOnly: true, limit: 3 });
      expect(page.entries.map((e) => (e.data as { eventId: string }).eventId)).toEqual(["e2", "e3", "e4"]);
      expect(page.older).toBe(true);
    });

    it("reports older records when the rotated generation holds lines the full live page did not need", () => {
      const eventsDir = tmp();
      const nativeDir = tmp();
      writeFileSync(join(eventsDir, "t1.ndjson.1"), line(started("old", "000001")));
      writeFileSync(join(eventsDir, "t1.ndjson"), line(started("a", "000002")) + line(started("b", "000003")));
      const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", runtimeOnly: true, limit: 2 });
      expect(page.entries.map((e) => (e.data as { eventId: string }).eventId)).toEqual(["a", "b"]);
      expect(page.older).toBe(true);
    });

    it("says nothing is older when the rotated generation completed the page and both were read whole", () => {
      const eventsDir = tmp();
      const nativeDir = tmp();
      writeFileSync(join(eventsDir, "t1.ndjson.1"), line(started("old", "000001")));
      writeFileSync(join(eventsDir, "t1.ndjson"), line(started("a", "000002")));
      const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", runtimeOnly: true, limit: 5 });
      expect(page.entries.map((e) => (e.data as { eventId: string }).eventId)).toEqual(["old", "a"]);
      expect(page.older).toBe(false);
    });

    it("clips long free-text fields and drops the raw payload, leaving ids and times alone", () => {
      const eventsDir = tmp();
      const nativeDir = tmp();
      writeFileSync(
        join(eventsDir, "t1.ndjson"),
        line(
          runtime({
            eventId: "big",
            type: "item.started",
            itemType: "tool",
            itemId: "i1",
            turnId: "t",
            createdAt: "000001",
            title: "write_file",
            arguments: "a".repeat(50_000),
            raw: { source: "x", payload: { huge: "y".repeat(50_000) } },
          }),
        ),
      );
      const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", runtimeOnly: true });
      const event = page.entries[0]!.data as { arguments: string; itemId: string; createdAt: string; raw?: unknown; title: string };
      expect(event.arguments.length).toBeLessThanOrEqual(2000);
      expect(event.arguments.endsWith("…")).toBe(true);
      expect(event).toMatchObject({ itemId: "i1", createdAt: "000001", title: "write_file" });
      expect(event.raw).toBeUndefined();
    });

    // The Trajectory read discards deltas, so on a delta-heavy log the page
    // never fills and the scan walks the whole window.  It used to re-decode
    // and re-parse everything it had buffered after every 64 KB step: 8 MB of
    // deltas cost about 8 seconds on the harness event loop, on a route the
    // tab refetches after every turn.  Each byte must be decoded once.
    it("decodes a delta-heavy log once, not once per chunk", () => {
      const eventsDir = tmp();
      const nativeDir = tmp();
      let body = "";
      let deltas = 0;
      const steps: string[] = [];
      // ~2.3 MB: 16,000 deltas of ~140 bytes with a settled step every 400
      for (let i = 0; i < 16_000; i++) {
        if (i % 400 === 0) {
          const id = `step-${String(i / 400).padStart(3, "0")}`;
          steps.push(id);
          body += line(started(id, String(i).padStart(6, "0")));
        }
        body += line(delta(deltas++));
      }
      writeFileSync(join(eventsDir, "t1.ndjson"), body);

      const window = 1024 * 1024;
      let decoded = 0;
      const page = readThreadEvents({
        eventsDir,
        nativeDir,
        threadId: "t1",
        runtimeOnly: true,
        limit: 1000,
        maxTailBytes: window,
        decode: (bytes) => {
          decoded += bytes.length;
          return bytes.toString("utf8");
        },
      });

      // one pass over the window: the old scan decoded 64 + 128 + … + 1024 KB
      expect(decoded).toBeLessThanOrEqual(window + 128 * 1024);
      // the steps inside the window all came back, in order, none twice
      const ids = page.entries.map((e) => (e.data as { eventId: string }).eventId);
      expect(ids.length).toBeGreaterThan(5);
      expect(ids).toEqual(steps.slice(-ids.length));
      expect(ids.at(-1)).toBe(steps.at(-1));
      expect(page.total.runtime).toBe(16_000 + steps.length);
      expect(page.older).toBe(true);
    });

    it("does not skip a record that only quotes the delta marker in its raw payload", () => {
      const eventsDir = tmp();
      const nativeDir = tmp();
      writeFileSync(
        join(eventsDir, "t1.ndjson"),
        line(runtime({ eventId: "quoted", type: "turn.started", createdAt: "000001", raw: { source: "x", payload: { type: "content.delta" } } })) +
          line(delta(2)),
      );
      const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", runtimeOnly: true });
      expect(page.entries.map((e) => (e.data as { eventId: string }).eventId)).toEqual(["quoted"]);
    });

    it("does not add the older flag to the Inspector's own response", () => {
      const eventsDir = tmp();
      const nativeDir = tmp();
      writeFileSync(join(eventsDir, "t1.ndjson"), line(started("e1", "000001")));
      expect(readThreadEvents({ eventsDir, nativeDir, threadId: "t1" })).not.toHaveProperty("older");
    });
  });

  // The scan cuts its buffer at newlines and joins the held-back first line to
  // the next older chunk.  Compare it with a plain parse of the whole file over
  // lines of mixed width (multi-byte text that straddles 64 KB boundaries),
  // torn and corrupt lines, and streamed deltas, at several limits.
  it("returns exactly what a whole-file parse would, across chunk boundaries", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const expected: string[] = [];
    const expectedAll: string[] = [];
    let body = "";
    for (let i = 0; i < 1400; i++) {
      const id = `e${String(i).padStart(5, "0")}`;
      const roll = next() % 10;
      if (roll === 0) {
        body += "{\"eventId\":\"torn\",\"type\":\"turn.sta\n";
      } else if (roll < 4) {
        body += line(runtime({ eventId: id, type: "content.delta", createdAt: String(i).padStart(6, "0"), streamKind: "assistant_text", delta: "δ".repeat(next() % 40) }));
        expectedAll.push(id);
      } else {
        const title = "日本語é".repeat(1 + (next() % 60));
        body += line(runtime({ eventId: id, type: "item.started", itemType: "tool", createdAt: String(i).padStart(6, "0"), title }));
        expected.push(id);
        expectedAll.push(id);
      }
    }
    writeFileSync(join(eventsDir, "t1.ndjson"), body);
    expect(Buffer.byteLength(body)).toBeGreaterThan(3 * 64 * 1024);

    for (const limit of [1, 7, 60, 300, 2000]) {
      const trajectory = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", runtimeOnly: true, limit });
      expect(trajectory.entries.map((e) => (e.data as { eventId: string }).eventId)).toEqual(expected.slice(-limit));
      expect(trajectory.older).toBe(limit < expected.length);
      const inspector = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit });
      expect(inspector.entries.map((e) => (e.data as { eventId: string }).eventId)).toEqual(expectedAll.slice(-limit));
    }
  });

  it("refuses a thread id that could escape the log directory", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    expect(() => readThreadEvents({ eventsDir, nativeDir, threadId: "../bots" })).toThrow(/thread id/);
  });
});
