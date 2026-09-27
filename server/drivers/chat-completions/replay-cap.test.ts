import { describe, expect, it } from "vitest";

import { capReplayedTranscript, DEFAULT_REPLAY_CAP } from "./replay-cap.ts";
import type { SendTurnInput } from "../../contracts.ts";

type Transcript = NonNullable<SendTurnInput["transcript"]>;

const user = (
  text: string,
  toolResults: NonNullable<NonNullable<SendTurnInput["transcript"]>[number]["toolResults"]> | undefined = undefined,
): Transcript[number] => ({ role: "user", text, ...(toolResults ? { toolResults } : {}) });
const assistant = (
  text: string,
  toolCalls: NonNullable<NonNullable<SendTurnInput["transcript"]>[number]["toolCalls"]> | undefined = undefined,
): Transcript[number] => ({ role: "assistant", text, ...(toolCalls ? { toolCalls } : {}) });

// Pairing rule under test: an older CALL only travels with a newer RESULT
// that carries the same tool-call id; leading orphaned results are dropped.
describe("capReplayedTranscript", () => {
  it("returns an empty array for an empty or missing transcript", () => {
    expect(capReplayedTranscript(undefined)).toEqual([]);
    expect(capReplayedTranscript([])).toEqual([]);
  });

  it("returns every entry when everything fits", () => {
    const t: Transcript = [user("a"), assistant("b"), user("c")];
    expect(capReplayedTranscript(t)).toEqual(t);
  });

  it("returns a NEW array, not a reference to the input", () => {
    const t: Transcript = [user("a"), assistant("b")];
    const out = capReplayedTranscript(t);
    expect(out).not.toBe(t);
    expect(out).toEqual(t);
  });

  it("drops the OLDEST entries first, keeping the newest intact", () => {
    // 60 entries at ~6 bytes each -> > the 60-entry default ceiling by
    // exactly the 61st, so the helper keeps exactly the last 60.
    const t: Transcript = Array.from({ length: 61 }, (_, i) => user(`turn ${i}`));
    const out = capReplayedTranscript(t);
    expect(out).toHaveLength(60);
    expect(out[0]).toEqual(user("turn 1"));
    expect(out.at(-1)).toEqual(user("turn 60"));
  });

  it("bounds by BYTES, not just message count", () => {
    // Each user message is 1 KiB.  200 KiB / 1 KiB = 200 entries at the
    // byte limit, but the default entry-count cap is 60 — so we should
    // see 60, not 200.  Conversely, a single 300 KiB message alone
    // overflows the 200 KiB byte budget and the helper keeps it anyway
    // (the "newest entry wins" rule), but no further entries are added.
    const big = "x".repeat(1024);
    const t: Transcript = Array.from({ length: 250 }, () => user(big));
    const out = capReplayedTranscript(t);
    expect(out).toHaveLength(60);
  });

  it("keeps the latest tool-call / tool-result pair intact when budget cuts the front", () => {
    // Long history (gets dropped), then an assistant tool_call (kept),
    // then a user tool_result (kept).  The pair must survive so the
    // model can reason about its last tool output instead of re-calling.
    // maxEntries: 2 forces the cap to cut to exactly the pair — the
    // default 60-entry budget would happily keep all 102 small entries.
    const t: Transcript = [
      ...Array.from({ length: 100 }, (_, i) => user(`old ${i}`)),
      assistant("calling search", [
        { id: "call-x", name: "search", arguments: '{"q":"x"}' },
      ]),
      user("", [{ id: "call-x", result: "hit-1" }]),
    ];
    const out = capReplayedTranscript(t, { maxEntries: 2 });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ role: "assistant", text: "calling search" });
    expect(out[0].toolCalls?.[0]).toMatchObject({ id: "call-x", name: "search" });
    expect(out[1]).toMatchObject({ role: "user" });
    expect(out[1].toolResults?.[0]).toMatchObject({ id: "call-x", result: "hit-1" });
  });

  it("never pairs an older tool RESULT with a newer tool CALL", () => {
    // The byte cut lands on r1 (the result of an earlier call).  r1 must not
    // be kept as a "partner" of the newer c2 call: that would open the
    // transcript on an orphaned result, which the provider rejects.
    const big = "Z".repeat(300);
    const t: Transcript = [
      assistant("a", [{ id: "c1", name: "n", arguments: "{}" }]),
      user("", [{ id: "c1", result: big }]),
      assistant("b", [{ id: "c2", name: "n", arguments: big }]),
      user("", [{ id: "c2", result: "ok" }]),
    ];
    const out = capReplayedTranscript(t, { maxBytes: 400 });
    expect(out[0].toolResults).toBeUndefined();
    expect(out).toEqual(t.slice(2));
  });

  it("does not pair a call and result whose ids differ", () => {
    const big = "Z".repeat(300);
    const t: Transcript = [
      user("start"),
      assistant("a", [{ id: "c1", name: "n", arguments: big }]),
      user("", [{ id: "other", result: "ok" }]),
    ];
    const out = capReplayedTranscript(t, { maxBytes: 100 });
    // The mismatched call is not kept as a pair partner, and the lone
    // result left at the front is skipped.
    expect(out).toEqual([]);
  });

  it("skips a leading tool result when the entry cap cuts between a call and its result", () => {
    const t: Transcript = [
      user("q"),
      assistant("calling", [{ id: "c1", name: "n", arguments: "{}" }]),
      user("", [{ id: "c1", result: "r" }]),
      assistant("done"),
      user("next"),
    ];
    const out = capReplayedTranscript(t, { maxEntries: 3 });
    expect(out).toEqual([assistant("done"), user("next")]);
  });

  it("respects a custom maxEntries override", () => {
    const t: Transcript = Array.from({ length: 20 }, (_, i) => user(`t${i}`));
    const out = capReplayedTranscript(t, { maxEntries: 5 });
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual(user("t15"));
    expect(out.at(-1)).toEqual(user("t19"));
  });

  it("respects a custom maxBytes override and counts UTF-8 not chars", () => {
    // 100 chars of ASCII = 100 bytes; 100 chars of multi-byte = up to 400
    // bytes.  Cap at 250 bytes and fill with four-byte emoji chars; the
    // helper should keep far fewer than 250 chars.
    const emoji = "\u{1F600}"; // 4 UTF-8 bytes
    const t: Transcript = Array.from({ length: 200 }, () => user(emoji));
    const out = capReplayedTranscript(t, { maxBytes: 250 });
    // 250 bytes / 4 bytes-per-entry = 62 entries max, plus the "newest
    // entry always wins" rule may push that to 63.  Anything above 64
    // would be a byte-counting bug.
    expect(out.length).toBeLessThanOrEqual(64);
    expect(out.length).toBeGreaterThan(0);
  });

  it("keeps the single newest entry even if it alone overflows maxBytes", () => {
    // One huge message past the cap.  The newest-entry-wins rule means
    // the helper returns that one entry rather than an empty array —
    // dropping the only thing the model knows about would be a worse
    // failure mode than the original uncapped replay.
    const t: Transcript = [user("a"), user("x".repeat(10_000))];
    const out = capReplayedTranscript(t, { maxBytes: 100 });
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("x".repeat(10_000));
  });

  it("counts tool-call arguments and tool-result payloads toward the byte budget", () => {
    const big = "Z".repeat(500);
    const t: Transcript = [
      user("first"),
      assistant("a", [{ id: "c1", name: "n", arguments: big }]),
      user("", [{ id: "c1", result: big }]),
      assistant("b", [{ id: "c2", name: "n", arguments: big }]),
      user("", [{ id: "c2", result: big }]),
    ];
    // 1000 bytes total tool payloads alone > 600-byte cap; two of the
    // five entries (~150 bytes each for text + ids) also count, so the
    // newest pair (entries 4 + 5) is what fits.
    const out = capReplayedTranscript(t, { maxBytes: 600 });
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe("assistant");
    expect(out[1].role).toBe("user");
  });

  it("DEFAULT_REPLAY_CAP keeps total replay under 200 KiB and 60 entries", () => {
    expect(DEFAULT_REPLAY_CAP.maxBytes).toBe(200 * 1024);
    expect(DEFAULT_REPLAY_CAP.maxEntries).toBe(60);
    // sanity: the byte budget trips FIRST when entries are large.  80
    // entries × 5 KiB = 400 KiB > 200 KiB cap, so the helper keeps the
    // newest 40 entries (exactly the byte budget) rather than 60.
    const t: Transcript = Array.from({ length: 80 }, () => user("x".repeat(5_000)));
    expect(capReplayedTranscript(t)).toHaveLength(40);
  });
});
