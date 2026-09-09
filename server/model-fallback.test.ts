import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import type { ModelSelection } from "./contracts.ts";
import {
  isQuotaOrCapText,
  isShortProviderErrorText,
  lastUserTextIndex,
  parseQuotaResetTime,
  QuotaCooldownRegistry,
  quotaCooldowns,
  selectTurnFallback,
  sliceIsShortProviderError,
  turnHitQuotaOrCap,
  turnProducedAssistantOutput,
  type FallbackScanMessage, AUTO_FALLBACK_PRIORITY } from "./model-fallback.ts";

const fallbacks: ModelSelection[] = [
  { instanceId: "grok", model: "grok-4" },
  { instanceId: "claude", model: "claude-sonnet-5" },
];

function decide(messagesAfterUser: FallbackScanMessage[], opts: {
  ok?: boolean;
  stopReason?: string | null;
  used?: number;
  chain?: ModelSelection[];
  current?: { instanceId: string; model: string } | null;
} = {}) {
  const textIsError = sliceIsShortProviderError(messagesAfterUser);
  const quotaOrCap = turnHitQuotaOrCap(messagesAfterUser);
  const produced = turnProducedAssistantOutput(messagesAfterUser, { textIsError: textIsError || quotaOrCap });
  return selectTurnFallback({
    ok: (opts.ok ?? false) && !textIsError && !quotaOrCap,
    stopReason: opts.stopReason,
    produced,
    quotaOrCap,
    fallbacks: opts.chain ?? fallbacks,
    used: opts.used ?? 0,
    current: opts.current,
  });
}

describe("turnProducedAssistantOutput", () => {
  it("does not count a tool-start chip (ok undefined) as produced, so 1:1 failover starts the next instance", () => {
    const afterUser: FallbackScanMessage[] = [
      { role: "bot", kind: "activity", tool: { name: "Bash" } },
    ];
    expect(turnProducedAssistantOutput(afterUser)).toBe(false);
    expect(decide(afterUser, { ok: false })).toEqual({
      instanceId: "grok",
      model: "grok-4",
      nextUsed: 1,
    });
  });

  it("room messages with sender attribution use the same gate", () => {
    const afterUser: FallbackScanMessage[] = [
      { role: "bot", kind: "activity", tool: { name: "Read" } },
      { role: "bot", kind: "activity", tool: { name: "error: HTTP 401", ok: false } },
    ];
    expect(turnProducedAssistantOutput(afterUser)).toBe(false);
    expect(decide(afterUser, { ok: false })).toEqual({
      instanceId: "grok",
      model: "grok-4",
      nextUsed: 1,
    });
  });

  it("counts a successful terminal tool result as produced", () => {
    const afterUser: FallbackScanMessage[] = [
      { role: "bot", kind: "activity", tool: { name: "Bash", ok: true } },
    ];
    expect(turnProducedAssistantOutput(afterUser)).toBe(true);
    expect(decide(afterUser, { ok: false })).toBeUndefined();
  });

  it("never counts retry or working activity, even when ok is true", () => {
    expect(
      turnProducedAssistantOutput([
        { role: "bot", kind: "activity", tool: { name: "retrying — attempt 2/3 in 1s — 503", ok: true } },
      ]),
    ).toBe(false);
    expect(
      turnProducedAssistantOutput([
        { role: "bot", kind: "activity", tool: { name: "working", ok: true } },
      ]),
    ).toBe(false);
  });

  it("never counts screen frames", () => {
    expect(turnProducedAssistantOutput([{ role: "bot", kind: "screen" }])).toBe(false);
  });

  it("successful text reply does not fail over", () => {
    const afterUser: FallbackScanMessage[] = [{ role: "bot", kind: "text", text: "Here you go." }];
    expect(turnProducedAssistantOutput(afterUser)).toBe(true);
    expect(decide(afterUser, { ok: true })).toBeUndefined();
  });

  it("a short provider-error text chip is not produced output", () => {
    const afterUser: FallbackScanMessage[] = [
      { role: "bot", kind: "text", text: "rate limit exceeded, try again later" },
    ];
    const textIsError = sliceIsShortProviderError(afterUser);
    expect(textIsError).toBe(true);
    expect(turnProducedAssistantOutput(afterUser, { textIsError })).toBe(false);
    expect(decide(afterUser, { ok: true })).toEqual({
      instanceId: "grok",
      model: "grok-4",
      nextUsed: 1,
    });
  });
});

describe("quota and session-limit failover", () => {
  it("matches Grok's session-limit chip", () => {
    const text = "You've hit your session limit · resets 12:10am (America/Chicago)";
    expect(isQuotaOrCapText(text)).toBe(true);
    expect(isShortProviderErrorText(text)).toBe(true);
  });

  it("matches usage-cap and quota chips across various providers", () => {
    expect(isQuotaOrCapText("usage cap reached for this model")).toBe(true);
    expect(isQuotaOrCapText("quota exceeded for this plan")).toBe(true);
    expect(isQuotaOrCapText("You have exhausted your daily quota")).toBe(true);
    expect(isQuotaOrCapText("You've reached your usage limit")).toBe(true);
    expect(isQuotaOrCapText("Insufficient Balance")).toBe(true);
    expect(isQuotaOrCapText("out of credits")).toBe(true);
    expect(isQuotaOrCapText("Your credit balance is too low")).toBe(true);
    expect(isQuotaOrCapText("HTTP 429: Too Many Requests")).toBe(true);
    expect(isQuotaOrCapText("RESOURCE_EXHAUSTED")).toBe(true);
    expect(isQuotaOrCapText("Here is a long successful answer about quotas that is well over five hundred characters. ".repeat(8))).toBe(false);
    expect(isQuotaOrCapText("Done.")).toBe(false);
  });

  it("matches official provider quota chips and ignores near-cap warnings", () => {
    const hits = [
      // Grok TUI / xAI SuperGrok (observed in this room)
      "You've hit your session limit · resets 12:10am (America/Chicago)",
      // grok.com consumer
      "Message limit reached",
      "You've exceeded your messaging allowance for the moment",
      // xAI API
      "429 Too Many Requests",
      // Claude.ai subscription (support.claude.com)
      "5-hour limit reached - resets 3:00pm",
      // Claude API (docs.claude.com / platform.claude.com)
      "You have reached your API usage limits: your organization has crossed its monthly API usage threshold",
      "This request would exceed your organization's rate limit of 30,000 input tokens per minute",
      "rate_limit_error",
      "enforced_spend_limit_reached",
      // Gemini API (ai.google.dev)
      "Resource has been exhausted (e.g. check quota).",
      "You exceeded your current quota, please check your plan and billing details.",
      "429 RESOURCE_EXHAUSTED",
      "Your prepayment credits are depleted.",
      // Codex CLI (openai/codex + help.openai.com)
      "You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again later.",
      "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 6th, 2026 11:41 PM.",
      "usage_limit_exceeded",
      "Rate limit reached for gpt-4.1 in organization org-example on tokens per min (TPM)",
      // Cursor CLI / editor
      "You've reached your monthly limit. Set a new on-demand limit to continue.",
      "Increase limits for faster responses Claude Opus 4.5 is not available in the slow pool. Please switch to Auto.",
      "You're out of usage. Switch to Auto, or ask your admin to increase your limit to continue.",
      "You've hit your rate limit on your current plan",
      "Upgrade your plan to continue",
      // DeepSeek API (api-docs.deepseek.com)
      "402 Insufficient Balance",
      "429 Rate Limit Reached",
      // Kimi Code (kimi.com/code/docs error-reference)
      "You've reached your 5-hour usage limit",
      "You've reached your weekly (7-day) usage limit",
      "You've reached your monthly usage limit for this billing cycle",
      "We're receiving too many requests at the moment. Please wait a moment and try again.",
      "Quota exceeded, please upgrade your plan or retry later",
    ];
    expect(hits.filter((text) => !isQuotaOrCapText(text))).toEqual([]);
    expect(isQuotaOrCapText("Approaching 5-hour limit.")).toBe(false);
    expect(isQuotaOrCapText("You've used 80% of your included usage")).toBe(false);
  });

  it("fails over after successful tools when the last text is a session-limit chip", () => {
    const afterUser: FallbackScanMessage[] = [
      { role: "bot", kind: "activity", tool: { name: "Bash", ok: true } },
      { role: "bot", kind: "activity", tool: { name: "Read", ok: true } },
      { role: "bot", kind: "text", text: "You've hit your session limit · resets 12:10am (America/Chicago)" },
    ];
    expect(turnProducedAssistantOutput(afterUser)).toBe(true);
    expect(turnHitQuotaOrCap(afterUser)).toBe(true);
    expect(decide(afterUser, { ok: true })).toEqual({
      instanceId: "grok",
      model: "grok-4",
      nextUsed: 1,
    });
  });

  it("fails over from an error activity chip that names the quota", () => {
    const afterUser: FallbackScanMessage[] = [
      { role: "bot", kind: "activity", tool: { name: "Bash", ok: true } },
      { role: "bot", kind: "activity", tool: { name: "error: quota exceeded for this plan", ok: false } },
    ];
    expect(turnHitQuotaOrCap(afterUser)).toBe(true);
    expect(decide(afterUser, { ok: false })).toEqual({
      instanceId: "grok",
      model: "grok-4",
      nextUsed: 1,
    });
  });

  it("skips a fallback that is the same engine as the current primary", () => {
    const afterUser: FallbackScanMessage[] = [
      { role: "bot", kind: "text", text: "You've hit your session limit · resets 12:10am (America/Chicago)" },
    ];
    expect(
      decide(afterUser, {
        ok: true,
        current: { instanceId: "grok", model: "grok-4" },
      }),
    ).toEqual({
      instanceId: "claude",
      model: "claude-sonnet-5",
      nextUsed: 2,
    });
  });

  it("does not invent an engine when every saved fallback matches the primary", () => {
    const afterUser: FallbackScanMessage[] = [
      { role: "bot", kind: "text", text: "quota exceeded" },
    ];
    expect(
      decide(afterUser, {
        ok: true,
        current: { instanceId: "claude", model: "claude-opus-5" },
        chain: [{ instanceId: "claude", model: "claude-opus-5" }],
      }),
    ).toBeUndefined();
  });
});

describe("selectTurnFallback", () => {
  it("cancelled or interrupted does not fail over", () => {
    const afterUser: FallbackScanMessage[] = [{ role: "bot", kind: "activity", tool: { name: "Bash" } }];
    expect(decide(afterUser, { ok: false, stopReason: "cancelled" })).toBeUndefined();
    expect(decide(afterUser, { ok: false, stopReason: "interrupted" })).toBeUndefined();
  });

  it("walks the saved chain by used count", () => {
    const afterUser: FallbackScanMessage[] = [];
    expect(decide(afterUser, { ok: false, used: 1 })).toEqual({
      instanceId: "claude",
      model: "claude-sonnet-5",
      nextUsed: 2,
    });
    expect(decide(afterUser, { ok: false, used: 2 })).toBeUndefined();
  });
});

describe("lastUserTextIndex", () => {
  it("finds the last user text, ignoring later bot chips", () => {
    expect(
      lastUserTextIndex([
        { role: "user", kind: "text", text: "one" },
        { role: "bot", kind: "text", text: "ok" },
        { role: "user", kind: "text", text: "two" },
        { role: "bot", kind: "activity", tool: { name: "Bash" } },
      ]),
    ).toBe(2);
  });
});

describe("parseQuotaResetTime", () => {
  it("parses relative reset durations in minutes and seconds", () => {
    const base = 1700000000000;
    const res1 = parseQuotaResetTime("Rate limit reached. Try again in 15 minutes.", base);
    expect(res1.isQuotaOrCap).toBe(true);
    expect(res1.resetsAt).toBe(base + 15 * 60 * 1000);

    const res2 = parseQuotaResetTime("HTTP 429: Too Many Requests · retry after 45s", base);
    expect(res2.isQuotaOrCap).toBe(true);
    expect(res2.resetsAt).toBe(base + 45 * 1000);
  });

  it("parses Grok style reset time with timezone", () => {
    const text = "You've hit your session limit · resets 12:10am (America/Chicago)";
    const res = parseQuotaResetTime(text);
    expect(res.isQuotaOrCap).toBe(true);
    expect(typeof res.resetsAt).toBe("number");
    expect(res.resetsAt).toBeGreaterThan(Date.now() - 1000);
  });

  it("parses midnight reset", () => {
    const text = "Daily quota exceeded · resets at midnight UTC";
    const res = parseQuotaResetTime(text);
    expect(res.isQuotaOrCap).toBe(true);
    expect(typeof res.resetsAt).toBe("number");
  });

  it("recognizes quota without reset time", () => {
    const text = "Insufficient Balance";
    const res = parseQuotaResetTime(text);
    expect(res.isQuotaOrCap).toBe(true);
    expect(res.resetsAt).toBeNull();
  });
});

describe("a user stop must not fail over", () => {
  // The bug this guards: the owner pressed Stop for two minutes on a bot with
  // a saved chain.  Had the stop reached the driver without a harness latch,
  // each press would have killed the attempt and immediately started the next
  // engine — "Stop does nothing" becoming "Stop falls over to another model".
  it("still fails over on exit_before_result, which is why the harness latch is load-bearing", () => {
    // Antigravity, claude and codex ALL settle a killed turn this way; none
    // of them reports "interrupted" for a user stop.  So this gate cannot
    // tell a user stop from a crash, and must not be asked to.
    expect(decide([], { ok: false, stopReason: "exit_before_result" })).toEqual({
      instanceId: "grok",
      model: "grok-4",
      nextUsed: 1,
    });
  });

  it("suppresses the chain only for the two stop reasons a driver never reports on a user stop", () => {
    expect(decide([], { ok: false, stopReason: "interrupted" })).toBeUndefined();
    expect(decide([], { ok: false, stopReason: "cancelled" })).toBeUndefined();
  });

  it("skips the chain when the caller has already latched the turn as stopped", () => {
    // How server/index.ts consumes its stoppedTurns latch: a stopped turn
    // never reaches selectTurnFallback at all.  Stopping is per-request, so
    // the saved chain itself is untouched and the next message gets it whole.
    const userStopped = true;
    const next = userStopped ? undefined : decide([], { ok: false, stopReason: "exit_before_result" });
    expect(next).toBeUndefined();
    expect(decide([], { ok: false, stopReason: "exit_before_result", used: 0 })).toBeDefined();
  });
});

describe("QuotaCooldownRegistry", () => {
  it("resolves fallback when primary is on active cooldown and switches back once expired", () => {
    const registry = new (quotaCooldowns.constructor as any)();
    const primary: ModelSelection = {
      instanceId: "grok",
      model: "grok-4",
      fallbacks: [{ instanceId: "claude", model: "claude-sonnet-5" }],
    };

    const now = 1700000000000;
    const resetsAt = now + 60000;

    registry.record({
      botId: "bot1",
      instanceId: "grok",
      model: "grok-4",
      resetsAt,
      error: "session limit",
      recordedAt: now,
    });

    // While in cooldown (now + 10s): uses fallback
    const resolution1 = registry.resolveModel("bot1", primary, now + 10000);
    expect(resolution1.isFallback).toBe(true);
    expect(resolution1.selection.instanceId).toBe("claude");
    expect(resolution1.selection.model).toBe("claude-sonnet-5");

    // After resetsAt (now + 70s): switches back to primary
    const resolution2 = registry.resolveModel("bot1", primary, now + 70000);
    expect(resolution2.isFallback).toBe(false);
    expect(resolution2.selection.instanceId).toBe("grok");
    expect(resolution2.selection.model).toBe("grok-4");
  });

  it("applies instance-level wildcard cap to all bots and lists active cooldowns", () => {
    const registry = new (quotaCooldowns.constructor as any)();
    const primary: ModelSelection = {
      instanceId: "codex",
      model: "gpt-5.4",
      fallbacks: [{ instanceId: "antigravity", model: "gemini-3.8-flash-high" }],
    };

    registry.recordInstanceCap("codex", "*", { error: "Codex session limit reached" });

    // Any bot targeting codex should automatically use fallback
    const resolved = registry.resolveModel("any-bot-id", primary);
    expect(resolved.isFallback).toBe(true);
    expect(resolved.selection.instanceId).toBe("antigravity");
    expect(resolved.selection.model).toBe("gemini-3.8-flash-high");
    expect(resolved.cooldown?.error).toBe("Codex session limit reached");

    // Cooldown list includes the instance cap
    const active = registry.list();
    expect(active.length).toBe(1);
    expect(active[0].instanceId).toBe("codex");
    expect(active[0].botId).toBe("*");
  });

  it("treats a per-model cooldown as an instance cap for the picker", () => {
    const registry = new (quotaCooldowns.constructor as any)();
    registry.record({
      botId: "monitor",
      instanceId: "cursor",
      model: "gpt-5",
      resetsAt: Date.now() + 60_000,
      error: "You've hit your usage limit",
      recordedAt: Date.now(),
    });
    const cd = registry.forInstance("cursor");
    expect(cd?.instanceId).toBe("cursor");
    expect(cd?.error).toBe("You've hit your usage limit");
  });

  it("persists and reloads cooldowns, skipping expired rows", () => {
    const file = `${tmpdir()}/quota-cooldowns-${Date.now()}.json`;
    const first = new QuotaCooldownRegistry();
    const writes: string[] = [];
    first.enablePersist(file, (_path, json) => {
      writes.push(json);
      writeFileSync(file, json);
    });
    const now = Date.now();
    first.recordInstanceCap("antigravity", "claude-opus-4-6-thinking", {
      resetsAt: now + 60_000,
      error: "exhausted",
      source: "antigravity-usage",
    });
    first.recordInstanceCap("grok", "*", { resetsAt: now - 1, error: "expired", source: "chip" });
    expect(writes.length).toBeGreaterThan(0);

    const second = new QuotaCooldownRegistry();
    second.enablePersist(file, (_path, json) => writeFileSync(file, json));
    expect(second.get("bot", "antigravity", "claude-opus-4-6-thinking")?.error).toBe("exhausted");
    expect(second.get("bot", "grok", "grok-4.6")).toBeUndefined();
  });
});

describe("AUTO_FALLBACK_PRIORITY", () => {
  it("keeps the established CLI order ahead of the newcomers", () => {
    // The six that were already here, in the order they were already in.
    // Adding a rail must never reshuffle the ladder a user has been living
    // with — a failover that lands somewhere new is a surprise, not a fix.
    const established = ["claude", "antigravity", "gemini", "codex", "openaiCompat", "grok"];
    expect(AUTO_FALLBACK_PRIORITY.filter((id) => established.includes(id))).toEqual(established);
  });

  it("reaches both DeepSeek rails, below codex and above openaiCompat", () => {
    const at = (id: string) => AUTO_FALLBACK_PRIORITY.indexOf(id);
    expect(at("dsh")).toBeGreaterThan(at("codex"));
    expect(at("deepseek")).toBeGreaterThan(at("codex"));
    expect(at("dsh")).toBeLessThan(at("openaiCompat"));
    expect(at("deepseek")).toBeLessThan(at("openaiCompat"));
    // dsh is the default-fleet member; deepseek is custom-only, so it sits behind.
    expect(at("dsh")).toBeLessThan(at("deepseek"));
  });

  it("lists no id twice", () => {
    expect(new Set(AUTO_FALLBACK_PRIORITY).size).toBe(AUTO_FALLBACK_PRIORITY.length);
  });
});
