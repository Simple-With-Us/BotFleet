import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";

import type { EffortLevel, ModelSelection } from "./contracts.ts";
import {
  AUTO_FALLBACK_PRIORITY,
  DEFAULT_QUOTA_COOLDOWN_TTL_MS,
  bootRecoveryTurnOpts,
  isQuotaOrCapText,
  isShortProviderErrorText,
  lastTurnStartIndex,
  parseQuotaResetTime,
  providerErrorCodeFromStopReason,
  QuotaCooldownRegistry,
  quotaCooldowns,
  quotaOrCapFromErrorCode,
  selectTurnFallback,
  shouldReplayPersistedStarter,
  sliceIsShortProviderError,
  turnHitQuotaOrCap,
  turnQuotaOrCapEvidence,
  turnProducedAssistantOutput,
  inheritedUnattended,
  type FallbackScanMessage,
  unattendedModelDowngrade,
} from "./model-fallback.ts";
import { eligibleAutoFallbackChain, type AutoFallbackCandidate } from "./turn-safety.ts";

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
  const quotaOrCap = Boolean(turnQuotaOrCapEvidence(messagesAfterUser, opts.ok ?? false));
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

  it("never counts a notice chip or Antigravity host control notice as produced output", () => {
    expect(
      turnProducedAssistantOutput([
        { role: "bot", kind: "activity", tool: { name: "notice", ok: true, kind: "notice" } },
      ]),
    ).toBe(false);
    expect(
      turnProducedAssistantOutput([
        {
          role: "bot",
          kind: "activity",
          tool: {
            name: "Antigravity has no approval cards, so BotFleet checks its tool execution policy instead.  A policy that would run shell commands on this computer unasked stops the turn.",
            ok: true,
          },
        },
      ]),
    ).toBe(false);
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

  it("does not turn ordinary successful prose or quoted examples into provider failures", () => {
    const prose = [
      "The billing fix is merged.",
      "The subscription accounting review is complete.",
      "Capacity planning is documented.",
      "I added coverage for quota exceeded and rate limit errors.",
      "You've reached the end of the billing review.",
      "Quota exceeded handling is documented.",
      "Rate limit parsing is tested.",
      "Your subscription limit fix is merged.",
      "You've hit your usage limit handling in a regression test.",
      "This request would exceed the old timeout, so I increased it.",
      "This request would exceed the token limit in our test harness, so I split it into batches.",
      "HTTP 429 handling is covered by tests.",
      "> Quota exceeded, please upgrade your plan.",
      'The provider may say "You have reached your usage limit".',
    ];
    for (const text of prose) {
      expect(isQuotaOrCapText(text), text).toBe(false);
      expect(isShortProviderErrorText(text), text).toBe(false);
      expect(turnQuotaOrCapEvidence([{ role: "bot", kind: "text", text }], true), text).toBeUndefined();
      expect(decide([{ role: "bot", kind: "text", text }], { ok: true }), text).toBeUndefined();
    }
  });

  it("keeps observed Antigravity quota failures eligible for fallback", () => {
    const text = "Antigravity: Individual quota reached for this account";
    expect(isQuotaOrCapText(text)).toBe(true);
    expect(
      turnQuotaOrCapEvidence([
        { role: "bot", kind: "activity", tool: { name: `error: ${text}`, ok: false } },
      ], false),
    ).toEqual({ text, source: "provider-error" });
  });

  it("does not promote successful assistant prose after a failed turn into provider evidence", () => {
    const text = "I added coverage for quota exceeded and rate limit errors.";
    expect(turnQuotaOrCapEvidence([{ role: "bot", kind: "text", text }], false)).toBeUndefined();
  });

  it("binds quota status to the actual error activity instead of earlier assistant text", () => {
    const afterUser: FallbackScanMessage[] = [
      { role: "bot", kind: "text", text: "The billing review is complete." },
      { role: "bot", kind: "activity", tool: { name: "error: API request failed: 429 rate limit reached · retry after 45s", ok: false } },
    ];
    expect(turnQuotaOrCapEvidence(afterUser, false)).toEqual({
      text: "API request failed: 429 rate limit reached · retry after 45s",
      source: "provider-error",
    });
    expect(parseQuotaResetTime("API request failed: 429 rate limit reached · retry after 45s", 1_000, true)).toEqual({
      isQuotaOrCap: true,
      resetsAt: 46_000,
      rawTimeText: "retry after 45s",
    });
  });

  it("does not revive an earlier retry error after the turn completes successfully", () => {
    const afterUser: FallbackScanMessage[] = [
      { role: "bot", kind: "activity", tool: { name: "error: 429 rate limit reached", ok: false } },
      { role: "bot", kind: "activity", tool: { name: "retrying — attempt 2/3 in 1s — 429", ok: true } },
      { role: "bot", kind: "text", text: "The retry completed the billing review." },
    ];
    expect(turnQuotaOrCapEvidence(afterUser, true)).toBeUndefined();
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

  it("prompt_too_large does not fail over — the next engine gets the same prompt", () => {
    const afterUser: FallbackScanMessage[] = [];
    expect(decide(afterUser, { ok: false, stopReason: "prompt_too_large" })).toBeUndefined();
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

describe("providerErrorCodeFromStopReason", () => {
  it("parses the error:<code> stopReason a chat-completions driver's loop emits", () => {
    expect(providerErrorCodeFromStopReason("error:invalid_credentials")).toBe("invalid_credentials");
    expect(providerErrorCodeFromStopReason("error:quota_or_region_restriction")).toBe(
      "quota_or_region_restriction",
    );
    expect(providerErrorCodeFromStopReason("error:upstream_outage")).toBe("upstream_outage");
    expect(providerErrorCodeFromStopReason("error:model_catalog_outage")).toBe("model_catalog_outage");
  });

  it("returns undefined for a CLI engine's plain error stopReason — no structured code at all", () => {
    expect(providerErrorCodeFromStopReason("error")).toBeUndefined();
  });

  it("returns undefined for a non-error stopReason and for null/undefined", () => {
    expect(providerErrorCodeFromStopReason("end_turn")).toBeUndefined();
    expect(providerErrorCodeFromStopReason("interrupted")).toBeUndefined();
    expect(providerErrorCodeFromStopReason(null)).toBeUndefined();
    expect(providerErrorCodeFromStopReason(undefined)).toBeUndefined();
  });
});

describe("quotaOrCapFromErrorCode", () => {
  it("is true for quota_or_region_restriction and upstream_outage — the chain is consulted for an outage too", () => {
    expect(quotaOrCapFromErrorCode("quota_or_region_restriction")).toBe(true);
    expect(quotaOrCapFromErrorCode("upstream_outage")).toBe(true);
  });

  it("is false for invalid_credentials — the setup affordance handles it, not failover", () => {
    expect(quotaOrCapFromErrorCode("invalid_credentials")).toBe(false);
  });

  it("is false for model_catalog_outage and inactive_subscription", () => {
    expect(quotaOrCapFromErrorCode("model_catalog_outage")).toBe(false);
    expect(quotaOrCapFromErrorCode("inactive_subscription")).toBe(false);
  });

  it("is undefined when there is no structured code, so the caller falls back to the regex path", () => {
    expect(quotaOrCapFromErrorCode(undefined)).toBeUndefined();
  });
});

describe("structured provider-error code feeds selectTurnFallback exactly as index.ts wires it", () => {
  // Mirrors index.ts's turn.completed fold exactly: with no CONFIGURED
  // fallback chain on the bot, the #90 auto chain is only offered when
  // quotaOrCap is true — this is where invalid_credentials and a plain CLI
  // "error" are kept off the auto-failover path, not inside
  // selectTurnFallback's own produced/quotaOrCap gate (that gate only
  // matters once a chain has already been handed to it).
  const compose = (stopReason: string, current = { instanceId: "minimax", model: "MiniMax-M3" }) => {
    const code = providerErrorCodeFromStopReason(stopReason);
    const quotaOrCap = quotaOrCapFromErrorCode(code) ?? false;
    const chain = quotaOrCap ? [{ instanceId: "claude", model: "claude-sonnet-5" }] : undefined;
    return selectTurnFallback({
      ok: false,
      stopReason,
      produced: false,
      quotaOrCap,
      fallbacks: chain,
      used: 0,
      current,
    });
  };

  it("a 429 (quota_or_region_restriction) sets quotaOrCap and consults the chain, where today's regex over an HTTP status string does not", () => {
    expect(compose("error:quota_or_region_restriction")).toMatchObject({
      instanceId: "claude",
      model: "claude-sonnet-5",
    });
  });

  it("a 502 (upstream_outage) also consults the chain, where a plain provider_error simply fails today", () => {
    expect(compose("error:upstream_outage")).toMatchObject({ instanceId: "claude", model: "claude-sonnet-5" });
  });

  it("a 401 (invalid_credentials) does not fail over — the setup affordance is the correct response, not another engine with no better luck", () => {
    expect(compose("error:invalid_credentials")).toBeUndefined();
  });

  it("a CLI engine's plain 'error' stopReason is untouched — no structured code, so no auto chain is offered here either", () => {
    expect(compose("error")).toBeUndefined();
  });
});

describe("AUTO_FALLBACK_PRIORITY — #90 auto-failover ordering", () => {
  // index.ts's autoFallbackChain hands this exact array to
  // eligibleAutoFallbackChain, so asserting through that function is
  // asserting the shipped ordering rather than a parallel copy of it.
  const candidate = (instanceId: string): AutoFallbackCandidate => ({
    instanceId,
    snapshot: { state: "available", authenticated: true },
    models: { default: `${instanceId}-model` },
  });
  const pick = (instanceIds: string[]) =>
    eligibleAutoFallbackChain(instanceIds.map(candidate), {
      botId: "bot-1",
      currentInstanceId: "current",
      isCooling: () => false,
      priority: AUTO_FALLBACK_PRIORITY,
    })[0]?.instanceId;

  it("fits the failing dispatch's effort to what the fallback model offers", () => {
    const codex: AutoFallbackCandidate = {
      instanceId: "codex",
      driverKind: "codex",
      capabilities: { effortLevels: ["low", "medium", "high", "xhigh"] },
      snapshot: { state: "available", authenticated: true },
      models: { default: "gpt-6" },
    };
    const run = (effort: EffortLevel | undefined, candidate = codex) =>
      eligibleAutoFallbackChain([candidate], {
        botId: "bot-1",
        currentInstanceId: "claude",
        effort,
        isCooling: () => false,
        priority: AUTO_FALLBACK_PRIORITY,
      })[0];
    // max is not offered by Codex: step down to its top level, not a 409.
    expect(run("max")?.effort).toBe("xhigh");
    // A supported effort is kept as-is.
    expect(run("medium")?.effort).toBe("medium");
    // No lower offered level: send no effort.
    expect(run("none")).not.toHaveProperty("effort");
    // A fallback engine without effort support never gets one.
    const noEffort = { ...codex, capabilities: {} };
    expect(run("high", noEffort)).not.toHaveProperty("effort");
    // Per-model levels win over the engine's list.
    const perModel = { ...codex, models: { default: "gpt-6", options: [{ id: "gpt-6", effortLevels: ["low", "high"] as EffortLevel[] }] } };
    expect(run("xhigh", perModel)?.effort).toBe("high");
    expect(run(undefined)).not.toHaveProperty("effort");
  });

  it("prefers minimax over the lower-priority openaiCompat and grok instances", () => {
    expect(pick(["grok", "openaiCompat", "minimax"])).toBe("minimax");
  });

  it("still prefers codex over minimax — the ladder is codex, then minimax, then openaiCompat", () => {
    expect(pick(["openaiCompat", "minimax", "codex"])).toBe("codex");
    expect(pick(["openaiCompat", "minimax"])).toBe("minimax");
  });

  it("leaves every existing CLI ordering unchanged: claude, antigravity, gemini, codex, openaiCompat, grok", () => {
    expect(pick(["grok", "codex", "openaiCompat", "claude", "gemini", "antigravity"])).toBe("claude");
    expect(pick(["grok", "codex", "openaiCompat", "gemini", "antigravity"])).toBe("antigravity");
    expect(pick(["grok", "codex", "openaiCompat", "gemini"])).toBe("gemini");
    expect(pick(["grok", "codex", "openaiCompat"])).toBe("codex");
    expect(pick(["grok", "openaiCompat"])).toBe("openaiCompat");
  });

  it("sorts an unlisted driver last, behind every named rung of the ladder", () => {
    expect(pick(["custom-engine", "grok"])).toBe("grok");
    expect(pick(["custom-engine", "minimax"])).toBe("minimax");
    expect(pick(["custom-engine"])).toBe("custom-engine");
  });

  it("places minimax after codex and before openaiCompat in the array itself", () => {
    const codexIdx = AUTO_FALLBACK_PRIORITY.indexOf("codex");
    const minimaxIdx = AUTO_FALLBACK_PRIORITY.indexOf("minimax");
    const openaiCompatIdx = AUTO_FALLBACK_PRIORITY.indexOf("openaiCompat");
    expect(codexIdx).toBeGreaterThanOrEqual(0);
    expect(codexIdx).toBeLessThan(minimaxIdx);
    expect(minimaxIdx).toBeLessThan(openaiCompatIdx);
  });
});

describe("lastTurnStartIndex", () => {
  it("finds the last user text, ignoring later bot chips", () => {
    expect(
      lastTurnStartIndex([
        { role: "user", kind: "text", text: "one" },
        { role: "bot", kind: "text", text: "ok" },
        { role: "user", kind: "text", text: "two" },
        { role: "bot", kind: "activity", tool: { name: "Bash" } },
      ]),
    ).toBe(2);
  });

  it("also finds an auto-delivered system-role instruction that started the turn", () => {
    expect(
      lastTurnStartIndex([
        { role: "system", kind: "text", text: "routine fired" },
        { role: "bot", kind: "text", text: "session limit hit" },
      ]),
    ).toBe(0);
  });

  it("prefers the later of a user message and a system instruction", () => {
    expect(
      lastTurnStartIndex([
        { role: "user", kind: "text", text: "one" },
        { role: "system", kind: "text", text: "webhook fired" },
        { role: "bot", kind: "activity", tool: { name: "Bash" } },
      ]),
    ).toBe(1);
  });
});

describe("shouldReplayPersistedStarter", () => {
  it("replays a webhook/system prompt that only got as far as an activity chip", () => {
    const messages: FallbackScanMessage[] = [
      { role: "system", kind: "text", text: "webhook fired" },
      { role: "bot", kind: "activity", tool: { name: "Bash" } },
    ];
    expect(shouldReplayPersistedStarter(messages, 0)).toBe(true);
  });

  it("does not replay a completed prompt when the in-flight turn was a card continuation", () => {
    const messages: FallbackScanMessage[] = [
      { role: "user", kind: "text", text: "connect slack" },
      { role: "bot", kind: "text", text: "please connect Slack" },
      { role: "bot", kind: "connector" },
    ];
    expect(shouldReplayPersistedStarter(messages, 0)).toBe(false);
  });

  it("does not replay after a successful tool result (side effects already ran)", () => {
    const messages: FallbackScanMessage[] = [
      { role: "system", kind: "text", text: "webhook fired" },
      { role: "bot", kind: "activity", tool: { name: "Bash", ok: true } },
    ];
    expect(shouldReplayPersistedStarter(messages, 0)).toBe(false);
  });
});

describe("bootRecoveryTurnOpts", () => {
  it("forwards webhook automationSource and marks unattended on both replay and BOOT_RECOVERY_NOTICE paths", () => {
    const resume = { role: "system", automationSource: "webhook" as const };
    const notice = bootRecoveryTurnOpts(resume, false);
    const replay = bootRecoveryTurnOpts(resume, true);
    expect(notice).toEqual({ automationSource: "webhook", unattended: true });
    expect(replay).toEqual(notice);
  });

  it("marks resource recovery unattended even when the persisted starter already produced a tool result", () => {
    expect(bootRecoveryTurnOpts({ role: "system", automationSource: "resource" }, false)).toEqual({
      automationSource: "resource",
      unattended: true,
    });
  });

  it("forwards schedule automationSource so the recovery notice stores as system", () => {
    expect(bootRecoveryTurnOpts({ role: "system", automationSource: "schedule" }, false)).toEqual({
      automationSource: "schedule",
      unattended: true,
    });
  });

  it("marks a system starter without a source unattended so recovery is not treated as a person typing", () => {
    expect(bootRecoveryTurnOpts({ role: "system" }, false)).toEqual({
      automationSource: undefined,
      unattended: true,
    });
  });

  it("leaves an ordinary human starter attended and without an automationSource", () => {
    expect(bootRecoveryTurnOpts({ role: "user" }, true)).toEqual({
      automationSource: undefined,
      unattended: undefined,
    });
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

  // Behaviour pin for the hoisted Intl.DateTimeFormat in computeNextOccurrence:
  // the zoned search must land on the same instant it always did, and it must
  // build its formatter once per parse rather than once per candidate minute.
  it("resolves a zoned time-of-day reset to the exact next instant in that zone", () => {
    // 12:00 UTC on Fri, Sep 25, 2026 is 7:00 AM CDT (UTC-5).
    const now = Date.UTC(2026, 8, 25, 12, 0, 0);
    const res = parseQuotaResetTime("You've hit your session limit · resets 12:10am (America/Chicago)", now);
    // The next 12:10 AM in Chicago is 05:10 UTC the following day.
    expect(res.resetsAt).toBe(Date.UTC(2026, 8, 26, 5, 10, 0));

    // Same wall time in winter, when Chicago is UTC-6.
    const winter = Date.UTC(2026, 0, 15, 12, 0, 0);
    const winterRes = parseQuotaResetTime("You've hit your session limit · resets 3:30pm (America/Chicago)", winter);
    expect(winterRes.resetsAt).toBe(Date.UTC(2026, 0, 15, 21, 30, 0));
  });

  it("builds the zone formatter once per parse, not once per candidate minute", () => {
    const now = Date.UTC(2026, 8, 25, 12, 0, 0);
    const spy = vi.spyOn(Intl, "DateTimeFormat");
    try {
      parseQuotaResetTime("You've hit your session limit · resets 12:10am (America/Chicago)", now);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("falls back to local time for a zone Intl does not recognize", () => {
    const now = Date.UTC(2026, 8, 25, 12, 0, 0);
    const res = parseQuotaResetTime("You've hit your session limit · resets 12:10am (Not/AZone)", now);
    const local = new Date(now);
    local.setHours(0, 10, 0, 0);
    if (local.getTime() <= now) local.setDate(local.getDate() + 1);
    expect(res.resetsAt).toBe(local.getTime());
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

  it("drops only legacy sourceless prose cooldowns while retaining terminal chips and named sources", () => {
    const file = `${tmpdir()}/quota-cooldowns-prose-${Date.now()}.json`;
    writeFileSync(file, JSON.stringify({
      version: 1,
      cooldowns: [
        {
          botId: "prose-bot",
          instanceId: "grok",
          model: "grok-4",
          resetsAt: null,
          error: "The subscription accounting review is complete.",
          recordedAt: Date.now(),
        },
        {
          botId: "chip-bot",
          instanceId: "grok",
          model: "grok-4",
          resetsAt: null,
          error: "You've hit your session limit · resets in 30 minutes",
          recordedAt: Date.now(),
        },
        {
          botId: "prefixed-cap-bot",
          instanceId: "grok",
          model: "grok-4",
          resetsAt: null,
          error: "API request failed: 429 rate limit reached",
          recordedAt: Date.now(),
        },
        {
          botId: "monitor-bot",
          instanceId: "antigravity",
          model: "gemini",
          resetsAt: null,
          error: "opaque provider telemetry",
          recordedAt: Date.now(),
          source: "antigravity-usage",
        },
      ],
    }));
    const writes: string[] = [];
    const registry = new QuotaCooldownRegistry();
    registry.enablePersist(file, (_path, json) => {
      writes.push(json);
      writeFileSync(file, json);
    });

    expect(registry.get("prose-bot", "grok", "grok-4")).toBeUndefined();
    expect(registry.get("chip-bot", "grok", "grok-4")?.source).toBeUndefined();
    expect(registry.get("prefixed-cap-bot", "grok", "grok-4")?.source).toBeUndefined();
    expect(registry.get("monitor-bot", "antigravity", "gemini")?.source).toBe("antigravity-usage");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]).cooldowns).toHaveLength(3);
  });

  it("clearWhere removes a deleted instance's cooldowns even when they never expire, leaving other instances untouched", () => {
    // server/index.ts's DELETE /api/instances/:id relies on exactly this: a
    // recreated custom engine reuses the same slug/instance id, so a stale
    // wildcard cooldown with no resetsAt — which list()/get() would
    // otherwise never age out — must not survive the delete and immediately
    // cap the replacement the moment it exists.
    const registry = new QuotaCooldownRegistry();
    registry.recordInstanceCap("custom-ollama", "*", { error: "Session limit or usage cap reached" });
    registry.record({
      botId: "bot1",
      instanceId: "custom-ollama",
      model: "llama3",
      resetsAt: null,
      error: "per-model cap",
      recordedAt: Date.now(),
    });
    registry.recordInstanceCap("codex", "*", { error: "unrelated engine, must survive" });

    expect(registry.list().length).toBe(3);

    registry.clearWhere((cooldown) => cooldown.instanceId === "custom-ollama");

    const remaining = registry.list();
    expect(remaining.length).toBe(1);
    expect(remaining[0].instanceId).toBe("codex");
    expect(registry.forInstance("custom-ollama")).toBeUndefined();
  });

  it("assigns default 15-minute cooldown TTL when resetsAt is null or undefined for non-usage sources", () => {
    const registry = new QuotaCooldownRegistry();
    const now = Date.now();
    registry.record({
      botId: "bot1",
      instanceId: "antigravity",
      model: "gemini-3.8-flash-high",
      resetsAt: null,
      error: "quota exceeded",
      recordedAt: now,
    });
    const cd = registry.get("bot1", "antigravity", "gemini-3.8-flash-high", now);
    expect(cd).toBeDefined();
    expect(cd?.resetsAt).toBe(now + DEFAULT_QUOTA_COOLDOWN_TTL_MS);
    expect(registry.get("bot1", "antigravity", "gemini-3.8-flash-high", now + DEFAULT_QUOTA_COOLDOWN_TTL_MS + 1)).toBeUndefined();
  });
});

describe("inheritedUnattended", () => {
  const marked = () => true;
  it("does not let a leftover mark downgrade a scheduled, manual, or typed turn", () => {
    expect(inheritedUnattended({}, marked)).toBe(false);
    expect(inheritedUnattended(undefined, marked)).toBe(false);
    expect(inheritedUnattended({ commsDepth: 0 }, marked)).toBe(false);
  });
  it("inherits the mark for card continuations and delegated work", () => {
    expect(inheritedUnattended({ cardContinuation: true }, marked)).toBe(true);
    expect(inheritedUnattended({ commsDepth: 1 }, marked)).toBe(true);
    expect(inheritedUnattended({ cardContinuation: true }, () => false)).toBe(false);
  });
  it("honors an explicit caller flag", () => {
    expect(inheritedUnattended({ unattended: true }, () => false)).toBe(true);
    expect(inheritedUnattended({ unattended: false, cardContinuation: true }, marked)).toBe(false);
  });
});

describe("unattendedModelDowngrade", () => {
  const gemini: ModelSelection = { instanceId: "gemini", model: "gemini-3.1-pro-preview" };
  const claude: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };

  it("leaves attended turns untouched", () => {
    expect(unattendedModelDowngrade(gemini, { effortLevels: ["low"] })).toEqual(gemini);
    expect(
      unattendedModelDowngrade(gemini, {
        unattended: false,
        automationSource: undefined,
        effortLevels: ["low"],
      }),
    ).toEqual(gemini);
  });

  it("downgrades model and effort on unattended turns when the engine offers effort", () => {
    expect(
      unattendedModelDowngrade(gemini, { unattended: true, effortLevels: ["low"] }),
    ).toEqual({ ...gemini, model: "gemini-3.1-flash-preview", effort: "low" });
  });

  it("downgrades the model but omits effort when the engine has no effortLevels", () => {
    // Antigravity / some API drivers reject effort at the turn-start capability
    // check; stamping "low" would 409 the whole unattended turn.
    const antigravity: ModelSelection = { instanceId: "antigravity", model: "claude-opus-4-1" };
    const out = unattendedModelDowngrade(antigravity, { unattended: true, effortLevels: undefined });
    expect(out).toEqual({ ...antigravity, model: "claude-opus-4-1".replace("-pro", "-flash") });
    expect(out).not.toHaveProperty("effort");
  });

  it("downgrades fresh webhook and resource deliveries, which carry automationSource not unattended", () => {
    for (const automationSource of ["webhook", "resource"]) {
      expect(
        unattendedModelDowngrade(gemini, { automationSource, effortLevels: ["low"] }),
      ).toEqual({ ...gemini, model: "gemini-3.1-flash-preview", effort: "low" });
    }
  });

  it("leaves schedule/manual automation and plain turns on the selected model", () => {
    for (const automationSource of ["schedule", "manual", undefined]) {
      expect(
        unattendedModelDowngrade(gemini, { automationSource, effortLevels: ["low"] }),
      ).toEqual(gemini);
    }
  });

  it("never overrides an explicit caller modelSelection", () => {
    expect(
      unattendedModelDowngrade(gemini, {
        unattended: true,
        automationSource: "webhook",
        hasExplicitSelection: true,
        effortLevels: ["low"],
      }),
    ).toEqual(gemini);
  });

  it("never downgrades onto a model that is itself in quota cooldown", () => {
    const pro: ModelSelection = { instanceId: "antigravity", model: "gemini-3.1-pro-high" };
    // Flash is cooling: keep the resolver-vetted Pro selection untouched.
    expect(
      unattendedModelDowngrade(pro, {
        unattended: true,
        isCooling: (_instanceId, model) => model === "gemini-3.8-flash-high",
      }),
    ).toEqual(pro);
    // Flash is free: downgrade as usual.
    expect(
      unattendedModelDowngrade(pro, {
        unattended: true,
        isCooling: () => false,
      }),
    ).toEqual({ ...pro, model: "gemini-3.8-flash-high" });
  });

  it("resolves downgrade families from the driver kind for custom instances", () => {
    // An operator-added second Claude under an arbitrary id shares the
    // claude family downgrade; a second Antigravity shares antigravity's.
    expect(
      unattendedModelDowngrade(
        { instanceId: "claude2", model: "claude-sonnet-4-5" },
        { unattended: true, driverKind: "claudeAgent" },
      ).model,
    ).toBe("claude-haiku-4-5");
    expect(
      unattendedModelDowngrade(
        { instanceId: "gravity", model: "gemini-3.1-pro-high" },
        { unattended: true, driverKind: "antigravityAgent" },
      ).model,
    ).toBe("gemini-3.8-flash-high");
    // An unknown driver kind downgrades nothing — even when the instance id
    // looks like a reserved family (openai-compat mounted as "claude").
    expect(
      unattendedModelDowngrade(
        { instanceId: "mystery", model: "mystery-large" },
        { unattended: true, driverKind: "mysteryDriver" },
      ).model,
    ).toBe("mystery-large");
    expect(
      unattendedModelDowngrade(
        { instanceId: "claude", model: "claude-sonnet-5" },
        { unattended: true, driverKind: "openai-compat" },
      ).model,
    ).toBe("claude-sonnet-5");
    // Missing driverKind still falls back to the instance id (tests / callers
    // that never resolve a kind).
    expect(
      unattendedModelDowngrade(
        { instanceId: "claude", model: "claude-sonnet-5" },
        { unattended: true },
      ).model,
    ).toBe("claude-haiku-4-5");
  });

  it("gates effort:low on the model-specific allowed efforts, not engine-wide", () => {
    // Engine advertises low, but this model's catalog omits it — stamping
    // low would 409 at startTurn's modelEffortLevels check.
    const selection: ModelSelection = { instanceId: "codex", model: "gpt-special" };
    const engineWide = ["low", "medium", "high"] as const;
    const modelOnly = ["medium", "high"] as const;
    expect(
      unattendedModelDowngrade(selection, {
        unattended: true,
        effortLevels: modelOnly,
      }),
    ).toEqual(selection);
    expect(
      unattendedModelDowngrade(selection, {
        unattended: true,
        effortLevels: engineWide,
      }),
    ).toEqual({ ...selection, effort: "low" });
    // Resolver is evaluated on the post-rewrite model id.
    expect(
      unattendedModelDowngrade(
        { instanceId: "claude", model: "claude-sonnet-5" },
        {
          unattended: true,
          driverKind: "claudeAgent",
          effortLevels: (model) => (model === "claude-haiku-4-5" ? ["medium", "high"] : engineWide),
        },
      ),
    ).toEqual({ instanceId: "claude", model: "claude-haiku-4-5" });
    expect(
      unattendedModelDowngrade(
        { instanceId: "claude", model: "claude-sonnet-5" },
        {
          unattended: true,
          driverKind: "claudeAgent",
          effortLevels: (model) => (model === "claude-haiku-4-5" ? ["low", "medium"] : []),
        },
      ),
    ).toEqual({ instanceId: "claude", model: "claude-haiku-4-5", effort: "low" });
  });

  it("maps Antigravity Pro ids to Flash ids the catalog actually offers", () => {
    // gemini-3.1-flash-high/low do not exist on Antigravity — the rewrite
    // must land on an offered id or the unattended turn fails at turn start.
    expect(
      unattendedModelDowngrade(
        { instanceId: "antigravity", model: "gemini-3.1-pro-high" },
        { unattended: true },
      ).model,
    ).toBe("gemini-3.8-flash-high");
    expect(
      unattendedModelDowngrade(
        { instanceId: "antigravity", model: "gemini-3.1-pro-low" },
        { unattended: true },
      ).model,
    ).toBe("gemini-3.8-flash-low");
    // Same-family Flash exists for 2.5, so keep it.
    expect(
      unattendedModelDowngrade(
        { instanceId: "antigravity", model: "gemini-2.5-pro" },
        { unattended: true },
      ).model,
    ).toBe("gemini-2.5-flash");
    // Custom / local-inject routes outside the static catalog keep the
    // configured model, even with "-pro" in the id.
    for (const model of ["my-proxy-gemini-pro-high", "gemini-3.9-pro-high", "local-qwen-pro"]) {
      expect(
        unattendedModelDowngrade(
          { instanceId: "antigravity", model },
          { unattended: true, driverKind: "antigravityAgent" },
        ).model,
      ).toBe(model);
    }
    // Non-Pro Antigravity models are left alone.
    expect(
      unattendedModelDowngrade(
        { instanceId: "antigravity", model: "claude-sonnet-4-6" },
        { unattended: true },
      ).model,
    ).toBe("claude-sonnet-4-6");
  });

  it("keeps custom and local-inject Claude routes as configured", () => {
    for (const model of ["ollama::my-sonnet-model", "lmstudio::qwen-opus-distill", "my-opus-proxy"]) {
      expect(
        unattendedModelDowngrade(
          { instanceId: "claude", model },
          { unattended: true, driverKind: "claudeAgent" },
        ).model,
      ).toBe(model);
    }
    // Built-in Claude routes still downgrade.
    expect(
      unattendedModelDowngrade(
        { instanceId: "claude", model: "claude-opus-5" },
        { unattended: true, driverKind: "claudeAgent" },
      ).model,
    ).toBe("claude-haiku-4-5");
  });

  it("rewrites only built-in Claude Sonnet/Opus ids, not custom look-alikes", () => {
    const down = (model: string) =>
      unattendedModelDowngrade({ instanceId: "claude", model }, { unattended: true, driverKind: "claudeAgent" }).model;
    for (const model of ["claude-sonnet-5-custom", "claude-opus-5-local", "claude-sonnet-latest-proxy"]) {
      expect(down(model)).toBe(model);
    }
    // Catalog ids and older official version ids still downgrade.
    for (const model of ["claude-sonnet-5", "claude-opus-5", "claude-sonnet-4-5", "claude-opus-4-1-20250805"]) {
      expect(down(model)).toBe("claude-haiku-4-5");
    }
  });

  it("pins Claude downgrades to the driver's current Haiku", () => {
    expect(
      unattendedModelDowngrade(claude, { unattended: true, effortLevels: ["low"] }),
    ).toEqual({ ...claude, model: "claude-haiku-4-5", effort: "low" });
    expect(
      unattendedModelDowngrade(
        { instanceId: "claude", model: "claude-opus-4-1" },
        { unattended: true, effortLevels: ["low"] },
      ),
    ).toEqual({ instanceId: "claude", model: "claude-haiku-4-5", effort: "low" });
  });
});
