// BF-2612 measurement harness: what actually re-executes per streaming frame.
//
// The store batches token deltas to requestAnimationFrame, so during a
// stream `ChatView`'s body runs at most once per animation frame (~60/s)
// while the settled `MessagesList` bails through `memo`. These tests pin the
// probe wiring and price the two paths over a realistic thread: the memoized
// path ChatView takes today (stable `messages` identity, derived values
// computed once) against recomputing the same derivations every frame. The
// printed timings are the measurement; the assertions only keep the harness
// honest, with thresholds loose enough to never flake CI.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  hiddenDisplayCount,
  resolveTranscriptWindow,
  tailDisplayWindowStart,
  TRANSCRIPT_WINDOW_SIZE,
  type WindowableMessage,
} from "@/lib/transcript-window";
import {
  recordChatViewBody,
  recordMessagesListBody,
  resetChatViewRenderProbe,
  snapshotChatViewRenderProbe,
} from "./chatViewRenderProbe";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ChatView.tsx"), "utf8").replace(/\r\n/g, "\n");

describe("chatViewRenderProbe accounting", () => {
  it("counts a bail for every ChatView body the settled list skipped", () => {
    resetChatViewRenderProbe();
    for (let frame = 0; frame < 120; frame += 1) recordChatViewBody();
    recordMessagesListBody(); // initial mount only; streaming frames bail
    const snap = snapshotChatViewRenderProbe();
    expect(snap.chatViewBody).toBe(120);
    expect(snap.messagesListBody).toBe(1);
    expect(snap.messagesListBails).toBe(119);
  });

  it("never reports negative bails", () => {
    resetChatViewRenderProbe();
    recordMessagesListBody();
    expect(snapshotChatViewRenderProbe().messagesListBails).toBe(0);
  });
});

describe("ChatView probe wiring", () => {
  it("records every ChatView body execution", () => {
    expect(SRC).toContain("recordChatViewBody();\n  const { state, dispatch } = useStore();");
  });

  it("records every MessagesList body execution, inside the memo'd component", () => {
    const memoAt = SRC.indexOf("const MessagesList = memo(function MessagesList(");
    const recordAt = SRC.indexOf("recordMessagesListBody();");
    expect(memoAt).toBeGreaterThan(-1);
    expect(recordAt).toBeGreaterThan(memoAt);
  });
});

function threadOf(count: number): WindowableMessage[] {
  const base = Date.UTC(2026, 10, 2, 12, 0, 0);
  return Array.from({ length: count }, (_, i) => ({
    kind: i % 7 === 3 ? "activity" : "text",
    role: i % 2 === 0 ? "user" : "bot",
    at: base + i * 60_000,
    tool: i % 7 === 3 ? { name: "read", ok: true as const } : undefined,
  }));
}

describe("streaming-frame derived work (100 messages x 120 frames)", () => {
  it("prices the memoized path against recomputing every frame", () => {
    const messages = threadOf(100);
    const options = { includeToolCalls: false, summarizeToolCalls: true };
    const frames = 120;

    // Warm the JIT so the printed numbers price the derivations, not the
    // first-call compilation of them.
    for (let i = 0; i < 50; i += 1) {
      const s = tailDisplayWindowStart(messages, options);
      resolveTranscriptWindow(messages, s, TRANSCRIPT_WINDOW_SIZE, null);
      hiddenDisplayCount(messages, s, options);
    }

    // Memoized path: what ChatView does today. `messages` keeps its identity
    // across stream frames, so each derivation runs once, not per frame.
    const memoStart = performance.now();
    const start = tailDisplayWindowStart(messages, options);
    const windowed = resolveTranscriptWindow(messages, start, TRANSCRIPT_WINDOW_SIZE, null);
    const hidden = hiddenDisplayCount(messages, start, options);
    const memoMs = performance.now() - memoStart;

    // Unmemoized path: the same derivations re-run on every frame, which is
    // the cost a broken memo (fresh array/object identity per frame) would pay.
    const recomputeStart = performance.now();
    let checksum = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      const s = tailDisplayWindowStart(messages, options);
      const w = resolveTranscriptWindow(messages, s, TRANSCRIPT_WINDOW_SIZE, null);
      checksum += w.visible.length + hiddenDisplayCount(messages, s, options);
    }
    const recomputeMs = performance.now() - recomputeStart;

    expect(windowed.visible.length).toBeGreaterThan(0);
    expect(hidden).toBe(0);
    expect(checksum).toBe(frames * (windowed.visible.length + hidden));
    console.log(
      `[BF-2612] 100 msgs x ${frames} frames: memoized-once=${memoMs.toFixed(3)}ms, ` +
        `recompute-per-frame total=${recomputeMs.toFixed(3)}ms (${(recomputeMs / frames).toFixed(4)}ms/frame)`,
    );
    // The harness must show separation without depending on machine speed.
    expect(recomputeMs).toBeGreaterThan(memoMs);
    expect(recomputeMs / frames).toBeLessThan(16);
  });
});
