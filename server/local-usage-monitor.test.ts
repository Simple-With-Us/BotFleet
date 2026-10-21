import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageQuotaPoller } from "./usage-quota.ts";
import {
  LOCAL_QUOTA_MAX_AGE_MS,
  LOCAL_QUOTA_WRITE_INTERVAL_MS,
  mergeLocalQuotaWindows,
  parseLocalQuotaPayload,
  parseLocalQuotaSnapshot,
  readLocalQuotaSnapshot,
} from "./local-usage-monitor.ts";

const planMetadata = {
  detectedPlanName: "Ultra", userPlanName: "My Pro", userCostUsd: "20.00",
  userRenewalDateText: "Next Friday", userSubtitle: "Work account",
  showCostAndRenewal: true, hasMismatch: true,
};

const now = Date.parse("2026-09-13T08:00:00Z");
const row = (provider = "openai", extra = {}) => ({
  id: "short", provider, providerKey: provider, label: "5h window", remainingPercent: 42,
  occurredAt: new Date(now).toISOString(), resetAt: "2026-09-13T10:00:00Z", window: "5h", ...extra,
});
const payload = (windows: unknown[] = [row()], extra = {}) => ({
  format: "usage-monitor-local-quotas", version: 1, generatedAt: new Date(now).toISOString(), windows, ...extra,
});

describe("native Usage Monitor handoff", () => {
  it("reads only supported products and keeps the producer's verdict beside the derived one", () => {
    const result = parseLocalQuotaSnapshot(payload([
      row("xai", { remainingPercent: 0, skip: true, skipReason: "0% remaining", status: "exhausted", isExhausted: true }),
      row("grok-bot"), row("kimi"), row("gemini-cli"),
      row("github-copilot"), row("windsurf"), row("google-antigravity", { label: "Third-Party Models · Weekly", modelId: null }),
    ]), now);
    expect(result.map((value) => value.provider)).toEqual(["xai", "google-antigravity"]);
    // `skip` and `status` stay derived, so every display path keeps the
    // meaning it has always had; the file's own verdict now travels beside
    // them under its own names, which is what the routing path reads.
    expect(result[0]).toMatchObject({
      remainingPercent: 0,
      status: "exhausted",
      skip: false,
      skipReason: null,
      fileSkip: true,
      fileSkipReason: "0% remaining",
      fileStatus: "exhausted",
      isExhausted: true,
    });
    expect(result[1]).toMatchObject({ modelId: null, fileSkip: false, isExhausted: false });
  });

  it("carries plan names and absolute allowances for money, request and credit windows", () => {
    const result = parseLocalQuotaSnapshot(payload([
      row("cursor", {
        id: "cursor-plan", label: "Cursor Plan", window: "billing-cycle", remainingPercent: 0,
        absoluteRemaining: 0, absoluteLimit: 400, quotaUnit: "USD", planName: "ultra",
        skip: true, isExhausted: true, status: "exhausted",
      }),
      row("minimax", {
        id: "m3:interval", label: "MiniMax M3 · 5-hour", window: "5h", remainingPercent: 4,
        absoluteRemaining: 12, absoluteLimit: 300, quotaUnit: "requests", planName: "starter",
      }),
      row("xai", {
        id: "grok-credits", label: "Grok credits", window: "1w", remainingPercent: 35,
        absoluteRemaining: 1750, absoluteLimit: 5000, quotaUnit: "credits",
      }),
    ]), now);
    expect(result.map((value) => [value.absoluteRemaining, value.absoluteLimit, value.quotaUnit, value.planName])).toEqual([
      [0, 400, "USD", "ultra"],
      [12, 300, "requests", "starter"],
      [1750, 5000, "credits", null],
    ]);
    expect(result[0]).toMatchObject({ isExhausted: true, fileSkip: true });
    expect(result[1].status).toBe("near_cap");
  });

  it("retains both plan sources without changing the detected legacy name", () => {
    const parsed = parseLocalQuotaSnapshot(payload([
      row("cursor", { planName: "Ultra", planMetadata: { ...planMetadata, token: "refused" } }),
    ]), now);
    expect(parsed[0].planName).toBe("Ultra");
    expect(parsed[0].planMetadata).toEqual(planMetadata);
    expect(parseLocalQuotaSnapshot(payload(), now)[0].planMetadata).toBeUndefined();
  });

  it("drops an unusable absolute figure without dropping the window", () => {
    const result = parseLocalQuotaSnapshot(payload([
      row("cursor", { absoluteRemaining: -5, absoluteLimit: "400", quotaUnit: "USD", planName: "ultra" }),
    ]), now);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ absoluteRemaining: null, absoluteLimit: null, quotaUnit: "USD", planName: "ultra" });
  });

  it("reports why the grid is empty: fresh, stale, or unreadable", () => {
    expect(parseLocalQuotaPayload(payload(), now).freshness).toMatchObject({ state: "fresh", ageMs: 0 });
    // AgentBar rewrites every five minutes; two missed cycles is the point
    // at which the app is more likely gone than slow.
    expect(LOCAL_QUOTA_MAX_AGE_MS).toBe(3 * LOCAL_QUOTA_WRITE_INTERVAL_MS);
    const late = parseLocalQuotaPayload(payload(), now + LOCAL_QUOTA_MAX_AGE_MS);
    expect(late.freshness).toMatchObject({ state: "stale", generatedAt: new Date(now).toISOString() });
    expect(late.windows).toEqual([]);
    expect(parseLocalQuotaPayload(payload([], { version: 2 }), now).freshness).toEqual({ state: "unreadable" });
    expect(parseLocalQuotaPayload(payload(), now - 61_000).freshness).toEqual({ state: "unreadable" });
  });

  it("carries the producer and its per-provider read failures, capped and as plain text", () => {
    const hostile = `<script>alert("quota")</script> ${"a long unhelpful reason ".repeat(20)}`;
    const parsed = parseLocalQuotaPayload(payload([row()], {
      producer: "codecaps",
      issues: { claude: "Sign in again to refresh quota", kimi: "no BotFleet engine", cursor: hostile },
    }), now);
    expect(parsed.producer).toBe("codecaps");
    // Provider keys are canonicalized, so the producer may spell a provider
    // either way; a provider BotFleet has no engine for is dropped.
    expect(parsed.issues.anthropic).toBe("Sign in again to refresh quota");
    expect(parsed.issues.kimi).toBeUndefined();
    // Angle brackets survive as TEXT — nothing here interprets the reason and
    // the renderer escapes it — but its length cannot take over the row.
    expect(parsed.issues.cursor.startsWith('<script>alert("quota")</script>')).toBe(true);
    expect(parsed.issues.cursor.length).toBeLessThanOrEqual(160);
  });

  it("folds a wrapped reason onto one line instead of dropping it", () => {
    // A reason is prose, so the producer may wrap it; ids and labels are not
    // and keep refusing control characters outright.  Before the fold, a
    // newline anywhere in the reason dropped it and left the engine's row
    // saying nothing — exactly the silence this key exists to end.
    const parsed = parseLocalQuotaPayload(payload([row()], {
      issues: { claude: "  Sign in again.\n\tOpen AgentBar to retry.  ", openai: "stillbroken" },
    }), now);
    expect(parsed.issues.anthropic).toBe("Sign in again. Open AgentBar to retry.");
    expect(parsed.issues.openai).toBeUndefined();
  });

  it("classifies a percentage exactly where the producer does", () => {
    // 0 is exhausted, 20 and below is near its cap, 21 is healthy.  These are
    // the producer's own boundaries, so a row's derived status can never
    // contradict the `status` string travelling beside it in the same row.
    const statuses = parseLocalQuotaSnapshot(payload([
      row("openai", { id: "zero", remainingPercent: 0 }),
      row("xai", { id: "at-threshold", remainingPercent: 20 }),
      row("cursor", { id: "just-above", remainingPercent: 21 }),
    ]), now);
    expect(statuses.map((value) => value.status)).toEqual(["exhausted", "near_cap", "available"]);
  });

  it("parses a handoff carrying neither optional key exactly as before", () => {
    const parsed = parseLocalQuotaPayload(payload(), now);
    expect(parsed.producer).toBeNull();
    expect(parsed.issues).toEqual({});
    expect(parsed.windows).toHaveLength(1);
  });

  it("rejects incompatible, stale, future, and malformed snapshots", () => {
    expect(parseLocalQuotaSnapshot(payload([], { version: 2 }), now)).toEqual([]);
    expect(parseLocalQuotaSnapshot(payload(), now + LOCAL_QUOTA_MAX_AGE_MS)).toEqual([]);
    expect(parseLocalQuotaSnapshot(payload(), now - 61_000)).toEqual([]);
    expect(parseLocalQuotaSnapshot(payload([row("openai", { remainingPercent: "99" })]), now)).toEqual([]);
    expect(parseLocalQuotaSnapshot(payload([row("openai", { remainingPercent: 101 })]), now)).toEqual([]);
    expect(parseLocalQuotaSnapshot(payload([row("openai", { occurredAt: "old" })]), now)).toEqual([]);
    expect(parseLocalQuotaSnapshot(payload([row("openai", { occurredAt: "2026-09-12T08:00:00Z" })]), now)).toEqual([]);
  });

  it("keeps missing or elapsed quotas unknown without inventing a refill", () => {
    const result = parseLocalQuotaSnapshot(payload([
      row("openai", { resetAt: "2026-09-13T07:59:59Z" }),
      row("xai", { remainingPercent: null, resetAt: null }),
    ]), now);
    expect(result.map((value) => value.remainingPercent)).toEqual([null, null]);
  });

  it("clears the producer's verdict once the reset has passed, the way it clears the percentage", () => {
    // A verdict recorded before the boundary describes the period that just
    // ended.  Left set, it was the one thing that kept the Settings grid cell
    // red under a chip reading the blanked percentage and saying "Available",
    // with the routing path — which refuses an end already behind it —
    // diverting nothing.
    const spent = {
      remainingPercent: 0, skip: true, skipReason: "0% remaining",
      status: "exhausted", isExhausted: true,
    };
    const [elapsed] = parseLocalQuotaSnapshot(payload([
      row("openai", { ...spent, resetAt: "2026-09-13T07:59:59Z" }),
    ]), now);
    expect(elapsed).toMatchObject({ remainingPercent: null, status: "unknown", isExhausted: false, fileSkip: false });

    // The same row, one second before its boundary, still carries it.
    const [live] = parseLocalQuotaSnapshot(payload([
      row("openai", { ...spent, resetAt: "2026-09-13T08:00:01Z" }),
    ]), now);
    expect(live).toMatchObject({ remainingPercent: 0, status: "exhausted", isExhausted: true, fileSkip: true });
  });

  it("merges whole provider identities without borrowing another account's weekly cap", () => {
    const local = parseLocalQuotaSnapshot(payload([row()]), now);
    const remote = parseLocalQuotaSnapshot(payload([row("openai", { id: "weekly", window: "1w" }), row("minimax")]), now);
    remote[0].provider = "codex";
    delete remote[0].providerKey;
    const merged = mergeLocalQuotaWindows(remote, local);
    expect(merged.map((value) => `${value.provider}:${value.id}`)).toEqual(["openai:short", "minimax:short"]);
  });

  it("preserves account identity for an unknown local quota", () => {
    const local = parseLocalQuotaSnapshot(payload([row("openai", { remainingPercent: null })]), now);
    const remote = parseLocalQuotaSnapshot(payload([row("openai", { id: "weekly", remainingPercent: 95 })]), now);
    expect(mergeLocalQuotaWindows(remote, local)).toEqual(local);
  });

  it("surfaces native quotas without a configured remote server and removes expired local data", async () => {
    const local = parseLocalQuotaSnapshot(payload(), now);
    let readings = parseLocalQuotaPayload(payload(), now);
    const poller = new UsageQuotaPoller(async () => readings);
    poller.configure({ settings: () => ({}), instances: () => [] });
    await poller.poll();
    expect(poller.getWindows()).toEqual(local);
    expect(poller.getWindows()[0].sourceApp).toBe("usage-monitor-mac:codex");
    expect(poller.getLocalQuota()).toMatchObject({ state: "fresh", producer: null, issues: {} });
    readings = { windows: [], freshness: { state: "missing" }, producer: null, issues: {} };
    await poller.poll();
    expect(poller.getWindows()).toEqual([]);
    expect(poller.getLocalQuota()).toEqual({ state: "missing", producer: null, issues: {} });
  });

  it("reads a bounded regular file and ignores symlinks, bad JSON, and missing files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bf-native-quota-"));
    try {
      const path = join(directory, "quota.json");
      await writeFile(path, JSON.stringify(payload()));
      expect((await readLocalQuotaSnapshot(path, now)).windows).toHaveLength(1);
      const link = join(directory, "link.json");
      await symlink(path, link);
      expect((await readLocalQuotaSnapshot(link, now)).windows).toEqual([]);
      await writeFile(path, "{}");
      expect(await readLocalQuotaSnapshot(path, now)).toEqual({ windows: [], freshness: { state: "unreadable" }, producer: null, issues: {} });
      await writeFile(path, "x".repeat(1_048_577));
      expect((await readLocalQuotaSnapshot(path, now)).windows).toEqual([]);
      // A native app that was never installed is an absence, not a failure.
      expect(await readLocalQuotaSnapshot(join(directory, "missing"), now)).toEqual({ windows: [], freshness: { state: "missing" }, producer: null, issues: {} });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
