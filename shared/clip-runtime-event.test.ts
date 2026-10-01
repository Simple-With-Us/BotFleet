import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../server/contracts.ts";
import { clipRuntimeEvent, TRAJECTORY_FIELD_LIMIT } from "./clip-runtime-event.ts";

const base = { eventId: "e1", provider: "claude", threadId: "t1", createdAt: "2026-09-29T10:00:00.000Z", turnId: "turn1", itemId: "i1" } as const;

describe("clipRuntimeEvent", () => {
  it("returns the very same object when nothing needs cutting", () => {
    const event: RuntimeEvent = { ...base, type: "item.completed", itemType: "tool", ok: true, detail: "3 rows" };
    expect(clipRuntimeEvent(event)).toBe(event);
  });

  it("clips a long tool argument and marks the cut", () => {
    const event: RuntimeEvent = { ...base, type: "item.started", itemType: "tool", title: "write_file", arguments: "x".repeat(10_000) };
    const clipped = clipRuntimeEvent(event) as Extract<RuntimeEvent, { type: "item.started" }>;
    expect(clipped.arguments).toHaveLength(TRAJECTORY_FIELD_LIMIT);
    expect(clipped.arguments!.endsWith("…")).toBe(true);
    expect(clipped.title).toBe("write_file");
    expect(clipped.itemId).toBe("i1");
  });

  it("clips a result detail, assistant text, a request summary, and an error message", () => {
    const long = "y".repeat(5_000);
    const detail = clipRuntimeEvent({ ...base, type: "item.completed", itemType: "tool", ok: false, detail: long }) as { detail: string };
    const text = clipRuntimeEvent({ ...base, type: "item.completed", itemType: "assistant_text", text: long }) as { text: string };
    const summary = clipRuntimeEvent({ ...base, type: "request.opened", requestType: "permission", tool: "Bash", summary: long }) as { summary: string };
    const message = clipRuntimeEvent({ ...base, type: "runtime.error", message: long }) as { message: string };
    for (const value of [detail.detail, text.text, summary.summary, message.message]) expect(value).toHaveLength(TRAJECTORY_FIELD_LIMIT);
  });

  it("honours a smaller limit", () => {
    const event: RuntimeEvent = { ...base, type: "item.completed", itemType: "assistant_text", text: "abcdefghij" };
    expect((clipRuntimeEvent(event, 5) as { text: string }).text).toBe("abcd…");
  });

  it("never leaves half a surrogate pair at the cut", () => {
    const text = `${"a".repeat(3)}😀😀😀`;
    const out = (clipRuntimeEvent({ ...base, type: "item.completed", itemType: "assistant_text", text }, 5) as { text: string }).text;
    expect(out).toBe("aaa…");
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(out)).toBe(false);
  });

  it("drops the raw provider payload but keeps everything else", () => {
    const event: RuntimeEvent = {
      ...base,
      type: "turn.completed",
      ok: true,
      cost: 0.01,
      usage: { input: 10, output: 2 },
      raw: { source: "claude", payload: { big: true } },
    };
    const clipped = clipRuntimeEvent(event);
    expect(clipped).not.toHaveProperty("raw");
    expect(clipped).toMatchObject({ type: "turn.completed", ok: true, cost: 0.01, usage: { input: 10, output: 2 } });
    // the input is not mutated
    expect(event.raw).toBeDefined();
  });
});
