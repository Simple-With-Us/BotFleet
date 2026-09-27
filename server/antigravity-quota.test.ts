import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ANTIGRAVITY_INSTANCE_ID,
  ANTIGRAVITY_USAGE_SOURCE,
  applyAntigravityUsageToRegistry,
  createAntigravityQuotaPoller,
  findAntigravityUsageBin,
  isAntigravityModelCapped,
  parseAntigravityUsageJson,
  quotaModelsFromSnapshot,
  remainingPercentDisplay,
} from "./antigravity-quota.ts";
import { QuotaCooldownRegistry } from "./model-fallback.ts";

// QuotaCooldownRegistry.get drops cooldowns whose resetsAt is already past
// Date.now().  Hardcoded 2026-09-05T03:58:25Z started failing every PR once
// CI ran after that instant.  Keep fixture resets relative to now.
const RESET_MS = 5 * 24 * 60 * 60 * 1000;
const futureReset = new Date(Date.now() + RESET_MS).toISOString();

const FIXTURE = {
  timestamp: new Date().toISOString(),
  method: "google",
  email: "redacted@example.com",
  models: [
    {
      label: "Claude Opus 4.6 (Thinking)",
      modelId: "claude-opus-4-6-thinking",
      remainingPercentage: 0,
      isExhausted: false,
      resetTime: futureReset,
      timeUntilResetMs: RESET_MS,
      isAutocompleteOnly: false,
    },
    {
      label: "Claude Sonnet 4.6 (Thinking)",
      modelId: "claude-sonnet-4-6",
      remainingPercentage: 0.29751188,
      isExhausted: false,
      resetTime: futureReset,
      timeUntilResetMs: RESET_MS,
      isAutocompleteOnly: false,
    },
    {
      label: "Gemini 2.5 Pro",
      modelId: "gemini-2.5-pro",
      isExhausted: false,
      resetTime: futureReset,
      timeUntilResetMs: RESET_MS,
      isAutocompleteOnly: true,
    },
    {
      label: "Gemini 3.1 Pro (High)",
      modelId: "gemini-3.1-pro-high",
      isExhausted: false,
      resetTime: futureReset,
      timeUntilResetMs: RESET_MS,
      isAutocompleteOnly: false,
    },
    {
      label: "Gemini 3.6 Flash (High)",
      modelId: "gemini-3.6-flash-high",
      isExhausted: true,
      resetTime: futureReset,
      timeUntilResetMs: RESET_MS,
      isAutocompleteOnly: false,
    },
  ],
};

describe("parseAntigravityUsageJson", () => {
  it("reads per-model remaining, exhausted, and autocomplete flags", () => {
    const snapshot = parseAntigravityUsageJson(FIXTURE);
    expect(snapshot.method).toBe("google");
    expect(snapshot.models).toHaveLength(5);
    const opus = snapshot.models.find((model) => model.modelId === "claude-opus-4-6-thinking");
    expect(opus?.remainingPercentage).toBe(0);
    expect(isAntigravityModelCapped(opus!)).toBe(true);
    const sonnet = snapshot.models.find((model) => model.modelId === "claude-sonnet-4-6");
    expect(remainingPercentDisplay(sonnet!)).toBe(29.75);
    expect(isAntigravityModelCapped(sonnet!)).toBe(false);
    const gemini = snapshot.models.find((model) => model.modelId === "gemini-3.1-pro-high");
    expect(gemini?.remainingPercentage).toBeUndefined();
    expect(isAntigravityModelCapped(gemini!)).toBe(true);
    const flash = snapshot.models.find((model) => model.modelId === "gemini-3.6-flash-high");
    expect(isAntigravityModelCapped(flash!)).toBe(true);
    const ac = snapshot.models.find((model) => model.modelId === "gemini-2.5-pro");
    expect(isAntigravityModelCapped(ac!)).toBe(false);
  });

  it("rejects a payload without models", () => {
    expect(() => parseAntigravityUsageJson({ timestamp: "now" })).toThrow(/models/);
  });
});

describe("applyAntigravityUsageToRegistry", () => {
  it("caps N/A remaining (Gemini) and remaining 0, and leaves remaining>0 available", () => {
    const registry = new QuotaCooldownRegistry();
    const snapshot = parseAntigravityUsageJson(FIXTURE);
    const applied = applyAntigravityUsageToRegistry(snapshot, registry, Date.now());
    expect(applied.capped.sort()).toEqual([
      "claude-opus-4-6-thinking",
      "gemini-3.1-pro-high",
      "gemini-3.6-flash-high",
    ]);
    expect(registry.get("any-bot", ANTIGRAVITY_INSTANCE_ID, "claude-opus-4-6-thinking")).toMatchObject({
      source: ANTIGRAVITY_USAGE_SOURCE,
      model: "claude-opus-4-6-thinking",
    });
    expect(registry.get("any-bot", ANTIGRAVITY_INSTANCE_ID, "claude-sonnet-4-6")).toBeUndefined();
    expect(registry.get("any-bot", ANTIGRAVITY_INSTANCE_ID, "gemini-3.1-pro-high")).toBeDefined();
    expect(registry.get("any-bot", ANTIGRAVITY_INSTANCE_ID, "gemini-2.5-pro")).toBeUndefined();
    const overlay = quotaModelsFromSnapshot(snapshot);
    expect(overlay["claude-sonnet-4-6"]?.capped).toBe(false);
    expect(overlay["claude-sonnet-4-6"]?.remainingPercent).toBe(29.75);
    expect(overlay["gemini-3.1-pro-high"]?.capped).toBe(true);
    expect(overlay["gemini-3.1-pro-high"]?.remainingPercent).toBe(0);
  });

  it("clears a previously capped model once remaining recovers", () => {
    const registry = new QuotaCooldownRegistry();
    const first = parseAntigravityUsageJson(FIXTURE);
    applyAntigravityUsageToRegistry(first, registry);
    expect(registry.get("bot", ANTIGRAVITY_INSTANCE_ID, "claude-opus-4-6-thinking")).toBeDefined();

    const recovered = structuredClone(FIXTURE);
    recovered.models[0].remainingPercentage = 0.5;
    recovered.models[0].isExhausted = false;
    applyAntigravityUsageToRegistry(parseAntigravityUsageJson(recovered), registry);
    expect(registry.get("bot", ANTIGRAVITY_INSTANCE_ID, "claude-opus-4-6-thinking")).toBeUndefined();
    expect(registry.get("bot", ANTIGRAVITY_INSTANCE_ID, "gemini-3.6-flash-high")).toBeDefined();
  });

  it("does not clear chip-sourced cooldowns on a different engine", () => {
    const registry = new QuotaCooldownRegistry();
    registry.recordInstanceCap("grok", "*", { error: "session limit", source: "chip" });
    applyAntigravityUsageToRegistry(parseAntigravityUsageJson(FIXTURE), registry);
    expect(registry.get("bot", "grok", "grok-4.6")).toBeDefined();
  });
});

describe("observed Antigravity catalog aliases", () => {
  it("routes opaque Gemini and third-party quotas through actual picker IDs, then recovers", () => {
    const now = Date.now();
    const snapshot = parseAntigravityUsageJson({ models: [
      { modelId: "MODEL_PLACEHOLDER_M318", label: "Gemini 3.8 Flash (High)", remainingPercentage: 0, resetTime: new Date(now + 60_000).toISOString() },
      { modelId: "MODEL_PLACEHOLDER_M35", label: "Claude Sonnet 4.6 (Thinking)", remainingPercentage: 1 },
      { modelId: "MODEL_OPENAI_GPT_OSS_120B_MEDIUM", label: "GPT-OSS 120B (Medium)", remainingPercentage: 0 },
      { modelId: "MODEL_PLACEHOLDER_UNKNOWN", label: "Unknown future model", remainingPercentage: 0 },
    ] });
    const registry = new QuotaCooldownRegistry();
    applyAntigravityUsageToRegistry(snapshot, registry, now);
    const primary = { instanceId: "antigravity", model: "gemini-3.8-flash-high", fallbacks: [
      { instanceId: "antigravity", model: "gpt-oss-120b-medium" },
      { instanceId: "antigravity", model: "claude-sonnet-4-6" },
    ] };
    expect(registry.resolveModel("bot", primary, now)).toMatchObject({ isFallback: true, selection: { model: "claude-sonnet-4-6" } });
    expect(quotaModelsFromSnapshot(snapshot, now)[primary.model]?.capped).toBe(true);
    expect(registry.get("bot", "antigravity", "gemini-2.5-flash", now)).toBeUndefined();
    expect(registry.resolveModel("bot", primary, now + 60_001).isFallback).toBe(false);
    expect(quotaModelsFromSnapshot(snapshot, now + 60_001)[primary.model]).toMatchObject({ capped: false, remainingPercent: null });
    snapshot.models[0].remainingPercentage = 1;
    applyAntigravityUsageToRegistry(snapshot, registry, now);
    expect(registry.get("bot", "antigravity", primary.model, now)).toBeUndefined();
    expect(registry.get("bot", "antigravity", "MODEL_PLACEHOLDER_M318", now)).toBeUndefined();
  });

  it.each([false, true])("retains the latest or indefinite alias reset independent of input order (%s)", (reverse) => {
    const now = Date.now();
    const rows = [
      { modelId: "MODEL_PLACEHOLDER_M318", label: "Gemini 3.8 Flash (High)", remainingPercentage: 0, resetTime: new Date(now + 60_000).toISOString() },
      { modelId: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)", remainingPercentage: 0, resetTime: new Date(now + 3_600_000).toISOString() },
    ];
    const registry = new QuotaCooldownRegistry();
    const snapshot = parseAntigravityUsageJson({ timestamp: new Date(now).toISOString(), models: reverse ? rows.toReversed() : rows });
    applyAntigravityUsageToRegistry(snapshot, registry, now);
    expect(registry.get("bot", "antigravity", "gemini-3.8-flash-high", now + 60_001)?.resetsAt).toBe(now + 3_600_000);
    expect(quotaModelsFromSnapshot(snapshot, now + 60_001)["gemini-3.8-flash-high"]?.capped).toBe(true);
    delete snapshot.models.find((row) => row.modelId === "gemini-3.8-flash-high")!.resetTime;
    applyAntigravityUsageToRegistry(snapshot, registry, now);
    expect(registry.get("bot", "antigravity", "gemini-3.8-flash-high", now + 3_600_001)?.resetsAt).toBeNull();
  });

  it("anchors a relative reset to the sampled timestamp rather than each picker refresh", () => {
    const now = Date.now();
    const snapshot = parseAntigravityUsageJson({ timestamp: new Date(now).toISOString(), models: [
      { modelId: "MODEL_PLACEHOLDER_M318", label: "Gemini 3.8 Flash (High)", remainingPercentage: 0, timeUntilResetMs: 60_000 },
    ] });
    expect(quotaModelsFromSnapshot(snapshot, now + 30_000)["gemini-3.8-flash-high"]?.resetsAt).toBe(now + 60_000);
    expect(quotaModelsFromSnapshot(snapshot, now + 60_001)["gemini-3.8-flash-high"]?.capped).toBe(false);
  });

  it("does not let an available duplicate alias overwrite an exhausted reading", () => {
    const snapshot = parseAntigravityUsageJson({ models: [
      { modelId: "MODEL_PLACEHOLDER_M318", label: "Gemini 3.8 Flash (High)", remainingPercentage: 0 },
      { modelId: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)", remainingPercentage: 1 },
    ] });
    const registry = new QuotaCooldownRegistry();
    applyAntigravityUsageToRegistry(snapshot, registry);
    expect(registry.get("bot", "antigravity", "gemini-3.8-flash-high")).toBeDefined();
    expect(quotaModelsFromSnapshot(snapshot)["gemini-3.8-flash-high"]?.capped).toBe(true);
  });
});

describe("createAntigravityQuotaPoller", () => {
  it("parses injected CLI JSON and records cooldowns", async () => {
    const registry = new QuotaCooldownRegistry();
    const poller = createAntigravityQuotaPoller({
      registry,
      exec: async () => JSON.stringify(FIXTURE),
      log: () => {},
    });
    const snapshot = await poller.tick(true);
    expect(snapshot?.models).toHaveLength(5);
    expect(registry.get("bot", ANTIGRAVITY_INSTANCE_ID, "gemini-3.6-flash-high")?.error).toMatch(
      /antigravity-usage/,
    );
    poller.stop();
  });

  it("leaves cooldowns alone when the CLI is missing", async () => {
    const registry = new QuotaCooldownRegistry();
    registry.recordInstanceCap(ANTIGRAVITY_INSTANCE_ID, "claude-opus-4-6-thinking", {
      error: "prior",
      source: ANTIGRAVITY_USAGE_SOURCE,
    });
    const poller = createAntigravityQuotaPoller({
      registry,
      exec: async () => {
        const error = new Error("spawn antigravity-usage ENOENT");
        (error as NodeJS.ErrnoException).code = "ENOENT";
        throw error;
      },
      log: () => {},
    });
    await poller.tick(true);
    expect(registry.get("bot", ANTIGRAVITY_INSTANCE_ID, "claude-opus-4-6-thinking")?.error).toBe("prior");
    poller.stop();
  });

  // OP3 / HS13: the poller used to spawn the CLI every 60s whether or not
  // any bot uses Antigravity — 1,440 spawns a day at idle.
  it("never spawns the CLI while isConfigured() is false, and resumes once it is true", async () => {
    let configured = false;
    let execCalls = 0;
    const poller = createAntigravityQuotaPoller({
      exec: async () => {
        execCalls += 1;
        return JSON.stringify(FIXTURE);
      },
      log: () => {},
      isConfigured: () => configured,
    });

    await poller.tick(true);
    expect(execCalls).toBe(0);
    expect(poller.lastSnapshot()).toBeNull();

    configured = true;
    const snapshot = await poller.tick(true);
    expect(execCalls).toBe(1);
    expect(snapshot?.models).toHaveLength(5);
    poller.stop();
  });

  it("backs off exponentially on consecutive failures and resets the instant one succeeds", async () => {
    let now = 0;
    let execCalls = 0;
    let fail = true;
    const poller = createAntigravityQuotaPoller({
      now: () => now,
      intervalMs: 60_000,
      exec: async () => {
        execCalls += 1;
        if (fail) throw new Error("boom");
        return JSON.stringify(FIXTURE);
      },
      log: () => {},
    });

    now = 0;
    await poller.tick(true); // attempt 1 (forced): fails, backoff -> nextAttemptAt = 60_000
    expect(execCalls).toBe(1);

    now = 59_999;
    await poller.tick(false); // still inside the backoff window: no spawn
    expect(execCalls).toBe(1);

    now = 60_000;
    await poller.tick(false); // attempt 2: fails, backoff -> nextAttemptAt = 60_000 + 120_000 = 180_000
    expect(execCalls).toBe(2);

    now = 179_999;
    await poller.tick(false); // still inside the LONGER window from attempt 2: no spawn
    expect(execCalls).toBe(2);

    now = 180_000;
    fail = false; // recovers on attempt 3
    await poller.tick(false);
    expect(execCalls).toBe(3);
    expect(poller.lastSnapshot()?.models).toHaveLength(5);

    // Reset on success: the very next tick, with no delay at all, spawns
    // again immediately rather than honoring a stale backoff.
    fail = true;
    await poller.tick(false);
    expect(execCalls).toBe(4);
    poller.stop();
  });

  it("collapses repeated identical poll failures into one log line", async () => {
    let now = 0;
    const lines: string[] = [];
    const poller = createAntigravityQuotaPoller({
      now: () => now,
      intervalMs: 1,
      exec: async () => {
        throw new Error("boom");
      },
      log: (message) => lines.push(message),
    });

    await poller.tick(true);
    now += 1;
    await poller.tick(true);
    now += 1;
    await poller.tick(true);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("poll failed: boom");
    poller.stop();
  });

  it("retries a truncated JSON response once immediately, then backs off like any other failure", async () => {
    let now = 0;
    let execCalls = 0;
    const poller = createAntigravityQuotaPoller({
      now: () => now,
      intervalMs: 60_000,
      exec: async () => {
        execCalls += 1;
        throw new SyntaxError("Unexpected end of JSON input");
      },
      log: () => {},
    });

    await poller.tick(true); // attempt 1: truncated -> free immediate retry, nextAttemptAt reset to 0
    expect(execCalls).toBe(1);

    await poller.tick(false); // attempt 2 (the free retry, same tick's clock): still truncated -> now backs off for real
    expect(execCalls).toBe(2);

    await poller.tick(false); // backoff is active: no spawn
    expect(execCalls).toBe(2);

    now = 60_000;
    await poller.tick(false); // attempt 3: backoff elapsed, still truncated -> escalates further (no more free retries this incident)
    expect(execCalls).toBe(3);

    await poller.tick(false); // immediately after attempt 3: the escalated backoff is active, no spawn
    expect(execCalls).toBe(3);
    poller.stop();
  });
});

describe("findAntigravityUsageBin", () => {
  it("prefers ANTIGRAVITY_USAGE_BIN when the file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-usage-"));
    const bin = join(dir, "antigravity-usage");
    writeFileSync(bin, "");
    expect(findAntigravityUsageBin({ ANTIGRAVITY_USAGE_BIN: bin }, (path) => path === bin)).toBe(bin);
  });

  it("populates secondaryRemainingPercent and windowsLabel from promptCredits", () => {
    const fixtureWithCredits = {
      ...FIXTURE,
      promptCredits: {
        available: 500,
        monthly: 50000,
        usedPercentage: 0.99,
        remainingPercentage: 0.01,
      },
    };
    const snapshot = parseAntigravityUsageJson(fixtureWithCredits);
    const overlay = quotaModelsFromSnapshot(snapshot);
    expect(overlay["claude-sonnet-4-6"]?.secondaryRemainingPercent).toBeUndefined();
    expect(overlay["claude-sonnet-4-6"]?.windowsLabel).toBe("5hr");
    expect(overlay["gemini-3.1-pro-high"]?.secondaryRemainingPercent).toBe(1);
    expect(overlay["gemini-3.1-pro-high"]?.windowsLabel).toBe("5hr/Week");
  });
});
