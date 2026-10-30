import { describe, expect, it } from "vitest";
import { ClaudeSingleCallLedger, billedClaudeCallEventId } from "./claude-billed-call.ts";

const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 };
const message = { id: "msg-1", model: "claude-test", usage };

describe("single-call billed proof", () => {
  it("accepts identical content-block repeats only after an exactly reconciled own result", () => {
    const ledger = new ClaudeSingleCallLedger();
    ledger.observe(message, true);
    expect(ledger.proof()).toBeUndefined();
    ledger.observe(message, true);
    ledger.result(usage, true);
    expect(ledger.proof()).toEqual({ id: "msg-1", model: "claude-test", input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
  });

  it.each([
    { ...message, id: "" },
    { ...message, usage: { ...usage, output_tokens: undefined } },
    { ...message, usage: { ...usage, output_tokens: -1 } },
    { ...message, usage: { ...usage, output_tokens: 0.5 } },
    { ...message, usage: { ...usage, output_tokens: Number.MAX_SAFE_INTEGER + 1 } },
    { ...message, usage: { ...usage, input_tokens: Number.MAX_SAFE_INTEGER } },
    { ...message, usage: { ...usage, cache_creation: { ephemeral_5m_input_tokens: 99 } } },
  ])("fails open for incomplete or inconsistent call evidence %j", (bad) => {
    const ledger = new ClaudeSingleCallLedger();
    ledger.observe(bad, true);
    ledger.result(usage, true);
    expect(ledger.proof()).toBeUndefined();
  });

  it("keeps multiple calls, changed streaming usage, and a legacy CLI without ownership", () => {
    for (const [next, owned] of [
      [{ ...message, id: "msg-2" }, true],
      [{ ...message, usage: { ...usage, output_tokens: 21 } }, true],
      [message, false],
    ] as const) {
      const ledger = new ClaudeSingleCallLedger();
      ledger.observe(message, true);
      ledger.observe(next, owned);
      ledger.result(usage, true);
      expect(ledger.proof()).toBeUndefined();
    }
  });

  it("requires all aggregate components to match and keeps multiple own results", () => {
    for (const key of Object.keys(usage) as Array<keyof typeof usage>) {
      const ledger = new ClaudeSingleCallLedger();
      ledger.observe(message, true);
      ledger.result({ ...usage, [key]: usage[key] + 1 }, true);
      expect(ledger.proof()).toBeUndefined();
    }
    const ledger = new ClaudeSingleCallLedger();
    ledger.observe(message, true);
    ledger.result(usage, true);
    ledger.observe(message, true);
    ledger.result(usage, true);
    expect(ledger.proof()).toBeUndefined();
  });

  it("never treats a foreign result as billed and clears its candidates", () => {
    const ledger = new ClaudeSingleCallLedger();
    ledger.observe(message, true);
    ledger.result(usage, false);
    expect(ledger.proof()).toBeUndefined();
    ledger.result(usage, true);
    expect(ledger.proof()).toBeUndefined();
  });

  it("derives an unambiguous bounded per-session call event identity", () => {
    expect(billedClaudeCallEventId("s", "m")).toMatch(/^bf-call-v1:[a-f0-9]{64}$/);
    expect(billedClaudeCallEventId("ab", "c")).not.toBe(billedClaudeCallEventId("a", "bc"));
  });
});
