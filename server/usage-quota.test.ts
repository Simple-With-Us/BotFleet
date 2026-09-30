import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLocalQuotaPayload } from "./local-usage-monitor.ts";
import { quotaCooldowns } from "./model-fallback.ts";
import {
  driverKindsForWindow,
  familiesForWindow,
  modelsToSkip,
  quotaWindowsUrl,
  UsageQuotaPoller,
  windowLengthMs,
  type QuotaPollerSettings,
  type RemoteQuotaWindow,
} from "./usage-quota.ts";

const opus: RemoteQuotaWindow = {
  id: "claude-opus-4-6-thinking",
  provider: "google-antigravity",
  sourceApp: "antigravity-cli",
  label: "Claude Opus 4.6 (Thinking)",
  modelId: "claude-opus-4-6-thinking",
  modelType: "claude-opus",
  window: "weekly",
  remainingPercent: 0,
  resetAt: "2026-09-09T07:04:37Z",
  status: "exhausted",
  skip: true,
  skipReason: "0% remaining",
};

describe("usage quota mapping", () => {
  it("derives quota-windows URL from the ingest endpoint", () => {
    expect(quotaWindowsUrl("https://usage.jays.services/api/ingest/usage")).toBe(
      "https://usage.jays.services/api/quota-windows",
    );
    expect(quotaWindowsUrl("https://usage.jays.services")).toBe(
      "https://usage.jays.services/api/quota-windows",
    );
  });

  it("never applies Grok Bot allowances to Grok CLI or Cursor engines", () => {
    expect(driverKindsForWindow({ ...opus, provider: "xai", providerKey: "grok-bot", sourceApp: "cursor", label: "Weekly" })).toEqual([]);
    expect(driverKindsForWindow({ ...opus, provider: "Grok Bot", sourceApp: "cursor", label: "Weekly" })).toEqual([]);
    expect(driverKindsForWindow({ ...opus, provider: "xai", sourceApp: "grok-build", label: "Grok CLI" })).toEqual(["grokAgent", "grok"]);
  });

  it("maps Antigravity windows onto the Antigravity driver", () => {
    expect(driverKindsForWindow(opus)).toEqual(["antigravityAgent"]);
  });

  it("skips the exact exhausted model id", () => {
    expect(
      modelsToSkip(opus, {
        instanceId: "antigravity",
        driverKind: "antigravityAgent",
        models: { options: [{ id: "claude-opus-4-6-thinking" }, { id: "gemini-3.6-flash-high" }] },
      }),
    ).toEqual(["claude-opus-4-6-thinking"]);
  });

  it("expands a Third-Party group skip across matching catalog ids", () => {
    const group: RemoteQuotaWindow = {
      ...opus,
      id: "3p-weekly",
      label: "Third-Party Models (weekly)",
      modelId: null,
      modelType: "claude",
    };
    expect(familiesForWindow(group)).toContain("gpt");
    expect(
      modelsToSkip(group, {
        instanceId: "antigravity",
        driverKind: "antigravityAgent",
        models: {
          options: [
            { id: "claude-sonnet-4-6" },
            { id: "gpt-oss-120b-medium" },
            { id: "gemini-3.6-flash-high" },
          ],
        },
      }),
    ).toEqual(["claude-sonnet-4-6", "gpt-oss-120b-medium"]);
  });

  it("keeps resolving the pool's legacy Claude and GPT labels to the Third-Party families", () => {
    // Windows stored or ingested before the pool was renamed "Third-Party"
    // still carry the old name, and none of them names a model family.
    const antigravity = {
      instanceId: "antigravity",
      driverKind: "antigravityAgent",
      models: { options: [
        { id: "claude-sonnet-4-6" },
        { id: "gpt-oss-120b-medium" },
        { id: "gemini-3.6-flash-high" },
      ] },
    };
    for (const label of [
      "Claude and GPT models (weekly)",
      "Claude & GPT \u00B7 Weekly",
      "Claude + GPT \u00B7 5-hour",
      "Third Party Models \u00B7 Weekly",
    ]) {
      const group: RemoteQuotaWindow = { ...opus, id: `legacy:${label}`, label, modelId: null, modelType: "" };
      expect(familiesForWindow(group), label).toContain("gpt");
      expect(modelsToSkip(group, antigravity), label).toEqual(["claude-sonnet-4-6", "gpt-oss-120b-medium"]);
    }
  });

  it("maps the producer's own family names onto every catalog model of that family", () => {
    // AgentBar spells a family the way its own menu does — "opus", "sonnet",
    // "haiku" for the Claude subscription and "gemini" / "third-party" for the
    // two Antigravity pools — while the catalog spells the same families
    // "claude-opus", "gemini-pro" and so on.  Unmapped, a family-level window
    // matched no model at all and could only cap an exact modelId.
    const family = (modelType: string, label = "Weekly"): RemoteQuotaWindow =>
      ({ ...opus, id: `family:${modelType}`, label, modelId: null, modelType });
    const claude = {
      instanceId: "claude",
      driverKind: "claudeAgent",
      models: { options: [
        { id: "claude-opus-4-6-thinking" },
        { id: "claude-opus-4-6" },
        { id: "claude-sonnet-4-6" },
        { id: "claude-haiku-4-5" },
      ] },
    };
    expect(modelsToSkip(family("opus"), claude)).toEqual(["claude-opus-4-6-thinking", "claude-opus-4-6"]);
    expect(modelsToSkip(family("sonnet"), claude)).toEqual(["claude-sonnet-4-6"]);
    expect(modelsToSkip(family("haiku"), claude)).toEqual(["claude-haiku-4-5"]);

    const antigravity = {
      instanceId: "antigravity",
      driverKind: "antigravityAgent",
      models: { options: [
        { id: "gemini-3.6-pro" },
        { id: "gemini-3.6-flash-high" },
        { id: "claude-sonnet-4-6" },
        { id: "gpt-oss-120b-medium" },
      ] },
    };
    expect(modelsToSkip(family("gemini"), antigravity)).toEqual(["gemini-3.6-pro", "gemini-3.6-flash-high"]);
    // Both spellings the producer could use for the second pool, and the pool
    // label on its own for a row that names no family at all.
    expect(modelsToSkip(family("third-party"), antigravity)).toEqual(["claude-sonnet-4-6", "gpt-oss-120b-medium"]);
    expect(modelsToSkip(family("thirdParty"), antigravity)).toEqual(["claude-sonnet-4-6", "gpt-oss-120b-medium"]);
    expect(familiesForWindow(family("", "Third-Party Models · Weekly"))).toContain("gpt");
    // A family neither app knows is passed through, so a catalog model spelled
    // the same way still matches instead of the window capping nothing.
    expect(familiesForWindow(family("kimi"))).toEqual(["kimi"]);
  });

  it("maps a Cursor monthly skip onto the whole cursor engine", () => {
    const monthly: RemoteQuotaWindow = {
      id: "cursor-monthly",
      provider: "cursor",
      sourceApp: "cursor-cli",
      label: "Cursor Pro monthly",
      modelId: null,
      modelType: "cursor",
      window: "monthly",
      remainingPercent: 0,
      resetAt: "2026-09-15T00:00:00.000Z",
      status: "exhausted",
      skip: true,
      skipReason: "0% remaining",
    };
    expect(driverKindsForWindow(monthly)).toEqual(["cursorAgent"]);
    expect(
      modelsToSkip(monthly, {
        instanceId: "cursor",
        driverKind: "cursorAgent",
        models: { options: [{ id: "auto" }, { id: "composer-2.5" }] },
      }),
    ).toEqual(["*"]);
  });

  it("maps DeepSeek and DSH windows to their respective driver kinds", () => {
    const dsWindow: RemoteQuotaWindow = {
      id: "deepseek-balance",
      provider: "deepseek",
      sourceApp: "deepseek",
      label: "DeepSeek API",
      modelId: "deepseek-chat",
      modelType: "deepseek",
      window: "monthly",
      remainingPercent: 85,
      resetAt: null,
      status: "available",
      skip: false,
      skipReason: null,
    };
    expect(driverKindsForWindow(dsWindow)).toEqual(["deepseekAgent", "deepseek"]);

    const dshWindow: RemoteQuotaWindow = {
      ...dsWindow,
      id: "dsh-window",
      provider: "dsh",
      sourceApp: "dsh",
      label: "Harness",
    };
    expect(driverKindsForWindow(dshWindow)).toEqual(["dshAgent"]);
  });
});

describe("local subscription caps", () => {
  // Relative to the run, never a pinned date: a fixture whose reset is in the
  // past would stop capping and quietly turn this suite green.
  const now = Date.now();
  const resetAt = new Date(now + (2 * 86_400_000)).toISOString();
  const localWindow = (extra: Partial<RemoteQuotaWindow> = {}): RemoteQuotaWindow => ({
    id: "local-mac:openai:primary",
    provider: "openai",
    providerKey: "openai",
    sourceApp: "usage-monitor-mac:codex",
    source: "Usage Monitor on this Mac",
    label: "Codex weekly",
    modelId: null,
    modelType: "",
    window: "1w",
    remainingPercent: 0,
    resetAt,
    occurredAt: new Date(now).toISOString(),
    // What the local parser produces: a derived status, `skip` left false,
    // and the collector's own verdict beside it.
    status: "exhausted",
    skip: false,
    skipReason: null,
    isExhausted: true,
    fileSkip: true,
    fileSkipReason: "0% remaining",
    ...extra,
  });
  const codex = { instanceId: "codex", driverKind: "codex", models: { options: [{ id: "gpt-5.2-codex" }] } };

  const poller = (windows: RemoteQuotaWindow[], settings: QuotaPollerSettings = {}, instances = [codex]) => {
    const made = new UsageQuotaPoller(async () => ({ windows, freshness: { state: "fresh", generatedAt: new Date(Date.now()).toISOString(), ageMs: 0 }, producer: "codecaps", issues: {} }));
    made.configure({ settings: () => settings, instances: () => instances });
    return made;
  };

  beforeEach(() => { quotaCooldowns.clearWhere(() => true); });
  afterEach(() => { quotaCooldowns.clearWhere(() => true); });

  it("caps the engine on the collector's own verdict, until the window resets", async () => {
    await poller([localWindow()]).poll();
    const cooldown = quotaCooldowns.list().find((cd) => cd.instanceId === "codex");
    expect(cooldown?.source).toBe("usage-monitor-local");
    expect(cooldown?.model).toBe("*");
    expect(cooldown?.resetsAt).toBe(Date.parse(resetAt));
    expect(cooldown?.error).toBe("0% remaining");
  });

  it("never caps on a derived 0% alone", async () => {
    await poller([localWindow({ isExhausted: false, fileSkip: false, fileSkipReason: null })]).poll();
    expect(quotaCooldowns.list()).toEqual([]);
  });

  it("does not let the remote feed's empty payload clear a local cap", async () => {
    // With no ingest URL and no read token the poller applies an empty remote
    // payload on every poll — which is exactly the live configuration here.
    const made = poller([localWindow()]);
    await made.poll();
    await made.poll();
    expect(quotaCooldowns.list().map((cd) => cd.source)).toEqual(["usage-monitor-local"]);
  });

  it("reproduces today's behaviour with the flag off, and releases a cap it already took", async () => {
    const windows = [localWindow()];
    await poller(windows).poll();
    expect(quotaCooldowns.list()).toHaveLength(1);
    await poller(windows, { localQuotaRouting: false }).poll();
    expect(quotaCooldowns.list()).toEqual([]);
  });

  it("diverts nothing for a window whose reset has already passed", async () => {
    // The routing third of the three paths that have to agree about such a
    // row; the grid cell and the engine chip are pinned together in
    // src/lib/usage-monitor-quota.test.ts, against this same parser.
    const clock = Date.now();
    const parsed = parseLocalQuotaPayload({
      format: "usage-monitor-local-quotas",
      version: 1,
      generatedAt: new Date(clock).toISOString(),
      windows: [{
        id: "codex:weekly", provider: "openai", providerKey: "openai", label: "Codex weekly",
        occurredAt: new Date(clock).toISOString(), window: "1w",
        resetAt: new Date(clock - 60_000).toISOString(),
        remainingPercent: 0, status: "exhausted", skip: true, skipReason: "0% remaining", isExhausted: true,
      }],
    }, clock).windows;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ remainingPercent: null, isExhausted: false, fileSkip: false });
    await poller(parsed).poll();
    expect(quotaCooldowns.list()).toEqual([]);
  });

  it("leaves MiniMax and Antigravity to their own pollers", async () => {
    const rows = [
      localWindow({ id: "minimax:weekly", provider: "minimax", providerKey: "minimax", label: "MiniMax weekly" }),
      localWindow({ id: "ag:weekly", provider: "google-antigravity", providerKey: "google-antigravity", label: "Gemini Models · Weekly" }),
    ];
    const instances = [
      { instanceId: "minimax", driverKind: "minimax", models: { options: [{ id: "MiniMax-M3" }] } },
      { instanceId: "antigravity", driverKind: "antigravityAgent", models: { options: [{ id: "gemini-3.6-flash-high" }] } },
    ];
    await poller(rows, {}, instances).poll();
    expect(quotaCooldowns.list()).toEqual([]);
  });

  it("caps one model when the window names one, and the plan when it names none", async () => {
    await poller([localWindow({ id: "codex-model", modelId: "gpt-5.2-codex" })]).poll();
    expect(quotaCooldowns.list().map((cd) => cd.model)).toEqual(["gpt-5.2-codex"]);
  });

  it("ignores a model id this instance's catalog does not list, and falls back to its family", async () => {
    // The producer spells a model the vendor's way; the catalog carries
    // BotFleet's.  A cooldown under an id no bot looks up diverts nothing
    // while still flipping the chip to "Partially capped", and it is
    // re-recorded on every poll, so it cannot be cleared by hand either.
    const claude = {
      instanceId: "claude",
      driverKind: "claudeAgent",
      models: { options: [{ id: "claude-opus-4-6" }, { id: "claude-sonnet-4-6" }] },
    };
    const anthropicRow = (extra: Partial<RemoteQuotaWindow>): RemoteQuotaWindow => localWindow({
      id: "anthropic:weekly",
      provider: "anthropic",
      providerKey: "anthropic",
      sourceApp: "usage-monitor-mac:anthropic",
      label: "Claude weekly",
      ...extra,
    });

    // Unknown id, but the row names the family too: the family answers.
    await poller([anthropicRow({ modelId: "claude-opus-4-1-20250805", modelType: "opus" })], {}, [claude]).poll();
    expect(quotaCooldowns.list().map((cd) => cd.model)).toEqual(["claude-opus-4-6"]);
    quotaCooldowns.clearWhere(() => true);

    // Unknown id and nothing else to go on: the row caps nothing at all,
    // rather than a key that diverts nothing or the whole engine.
    await poller([anthropicRow({ modelId: "claude-opus-4-1-20250805", modelType: "" })], {}, [claude]).poll();
    expect(quotaCooldowns.list()).toEqual([]);
    quotaCooldowns.clearWhere(() => true);

    // And an id the catalog really holds is still capped exactly.
    await poller([anthropicRow({ modelId: "claude-sonnet-4-6", modelType: "sonnet" })], {}, [claude]).poll();
    expect(quotaCooldowns.list().map((cd) => cd.model)).toEqual(["claude-sonnet-4-6"]);
  });

  it("lets a monthly row with an unmatched id cap the whole engine, as any plan-level row does", async () => {
    // The one place the catalog check caps MORE than before rather than less,
    // so it is pinned rather than left implicit.  A monthly / plan-limit row
    // says the allowance itself is spent — `isPlanLevelSkip` has always made
    // that `"*"` — and the old short-circuit on an unmatched id turned it into
    // a cooldown key nothing looked up, which diverted nothing at all.  Only
    // the collector's own verdict reaches this path, never a derived 0%, so
    // the evidence for capping the engine is the producer's own.
    const claude = {
      instanceId: "claude",
      driverKind: "claudeAgent",
      models: { options: [{ id: "claude-opus-4-6" }] },
    };
    await poller([localWindow({
      id: "anthropic:monthly",
      provider: "anthropic",
      providerKey: "anthropic",
      sourceApp: "usage-monitor-mac:anthropic",
      label: "Claude monthly",
      window: "monthly",
      modelId: "claude-opus-4-1-20250805",
      modelType: "opus",
    })], {}, [claude]).poll();
    expect(quotaCooldowns.list().map((cd) => cd.model)).toEqual(["*"]);
  });

  it("caps every model of a family when the window names a family instead of a model", async () => {
    const claude = {
      instanceId: "claude",
      driverKind: "claudeAgent",
      models: { options: [{ id: "claude-opus-4-6-thinking" }, { id: "claude-opus-4-6" }, { id: "claude-sonnet-4-6" }] },
    };
    await poller([localWindow({
      id: "anthropic:opus:weekly",
      provider: "anthropic",
      providerKey: "anthropic",
      sourceApp: "usage-monitor-mac:anthropic",
      label: "Claude Opus weekly",
      modelType: "opus",
    })], {}, [claude]).poll();
    // Both Opus entries, and only those: a spent Opus week must not take
    // Sonnet down with it.
    expect(quotaCooldowns.list().map((cd) => cd.model).sort()).toEqual(["claude-opus-4-6", "claude-opus-4-6-thinking"]);
  });

  it("derives an end from the window token, caps it at eight days, and skips a row with neither", async () => {
    expect(windowLengthMs("5h")).toBe(5 * 3_600_000);
    expect(windowLengthMs("1w")).toBe(7 * 86_400_000);
    expect(windowLengthMs("5-hour")).toBe(5 * 3_600_000);
    expect(windowLengthMs("billing-cycle")).toBeNull();

    const made = poller([localWindow({ resetAt: null, window: "5h" })]);
    await made.poll();
    const derived = quotaCooldowns.list().find((cd) => cd.instanceId === "codex");
    expect(derived?.resetsAt).toBeGreaterThan(Date.now() + (4 * 3_600_000));
    expect(derived?.resetsAt).toBeLessThanOrEqual(Date.now() + (5 * 3_600_000));
    quotaCooldowns.clearWhere(() => true);

    // A monthly window with no reset would otherwise hold the engine for a
    // billing month on the strength of one stale file.
    await poller([localWindow({ resetAt: null, window: "monthly" })]).poll();
    const capped = quotaCooldowns.list().find((cd) => cd.instanceId === "codex");
    expect(capped?.resetsAt).toBeLessThanOrEqual(Date.now() + (8 * 86_400_000));
    quotaCooldowns.clearWhere(() => true);

    await poller([localWindow({ resetAt: null, window: "billing-cycle" })]).poll();
    expect(quotaCooldowns.list()).toEqual([]);
  });

  it("survives a throw out of the local path and keeps polling", async () => {
    // The whole local half is derived from a file any process running as this
    // user can write.  It used to run before `poll()`'s `try`, so one throw
    // left `inFlight` true for the life of the process — every later poll
    // returned at the guard, local caps never lifted, and because `start()`
    // does `void this.poll()` with no `unhandledRejection` handler the
    // rejection terminated the harness on boot, over and over.
    //
    // A row whose `label` throws when read, so this does not depend on the
    // prototype-chain hazard the commit before it fixed.
    // SAFETY: the object is a complete `localWindow()` whose `label` has been
    // redefined as a getter of the same `string` type, so every property the
    // contract names is still present and still typed as declared.
    const exploding = Object.defineProperty({ ...localWindow() }, "label", {
      get() { throw new Error("handoff row exploded"); },
    }) as RemoteQuotaWindow;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let reads = 0;
      const made = new UsageQuotaPoller(async () => {
        reads += 1;
        return { windows: [exploding], freshness: { state: "fresh", generatedAt: new Date().toISOString(), ageMs: 0 }, producer: "codecaps", issues: {} };
      });
      made.configure({ settings: () => ({}), instances: () => [codex] });

      await expect(made.poll()).resolves.toBeUndefined();
      expect(reads).toBe(1);
      // The remote half still ran: unconfigured, it applies an empty payload
      // and clears its own error.
      expect(made.getStatus().lastError).toBeNull();
      // And `inFlight` was released, so the next poll is not swallowed.
      await expect(made.poll()).resolves.toBeUndefined();
      expect(reads).toBe(2);
      // Once for the same failure, not once every thirty seconds.
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]?.[0])).toContain("handoff row exploded");
    } finally {
      logged.mockRestore();
    }
  });
});

describe("a handoff row that names a prototype member", () => {
  // The handoff is read from disk on every poll and any process running as
  // this user can write it.  Before the guards in quota-window-map.ts a
  // `modelType` of "constructor" resolved to the `Object` function, so
  // `new Set(familiesForWindow(...))` threw `function is not iterable` out of
  // `poll()` — which `start()` calls fire-and-forget, with no process-level
  // `unhandledRejection` handler anywhere in the repo (pinned at
  // server/secret-persistence.test.ts) — and the harness died, then died
  // again on every restart because the same file was read again.
  const clock = Date.now();
  const claude = { instanceId: "claude", driverKind: "claudeAgent", models: { options: [{ id: "claude-opus-4-6" }] } };
  const handoff = (row: Record<string, unknown>) => ({
    format: "usage-monitor-local-quotas",
    version: 1,
    generatedAt: new Date(clock).toISOString(),
    windows: [{
      id: "local-mac:anthropic:weekly",
      provider: "anthropic",
      providerKey: "anthropic",
      label: "Weekly",
      occurredAt: new Date(clock).toISOString(),
      window: "1w",
      resetAt: new Date(clock + (3 * 86_400_000)).toISOString(),
      isExhausted: true,
      ...row,
    }],
  });

  // The REAL parser on every poll, so the row the poller sees is one the
  // producer could actually write rather than a hand-built window — and a
  // read counter, because the wedge this pins is invisible from one poll.
  function hostilePoller(payload: unknown) {
    let reads = 0;
    const made = new UsageQuotaPoller(async () => {
      reads += 1;
      return parseLocalQuotaPayload(payload);
    });
    made.configure({ settings: () => ({}), instances: () => [claude] });
    return { made, reads: () => reads };
  }

  beforeEach(() => { quotaCooldowns.clearWhere(() => true); });
  afterEach(() => { quotaCooldowns.clearWhere(() => true); });

  it("keeps polling instead of throwing on a modelType of \"constructor\"", async () => {
    const { made, reads } = hostilePoller(handoff({ modelType: "constructor" }));
    await expect(made.poll()).resolves.toBeUndefined();
    // "constructor" is a family no catalog model is spelled with, so the row
    // caps nothing: it is ignored, never obeyed.
    expect(quotaCooldowns.list()).toEqual([]);
    expect(reads()).toBe(1);
    // And the poll released `inFlight`, so the next one really runs instead
    // of returning at the guard for the life of the process.
    await expect(made.poll()).resolves.toBeUndefined();
    expect(reads()).toBe(2);
    expect(quotaCooldowns.list()).toEqual([]);
  });

  it("does not cap on a window token of \"constructor\" with no reset", async () => {
    const { made } = hostilePoller(handoff({ window: "constructor", resetAt: null, modelType: "" }));
    await expect(made.poll()).resolves.toBeUndefined();
    // An end BotFleet cannot compute is one it could never release, so the
    // row does not cap at all — the same answer "billing-cycle" gets.
    expect(quotaCooldowns.list()).toEqual([]);
  });

  it("answers null for every prototype member of the window-length table", () => {
    for (const key of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
      expect(windowLengthMs(key)).toBeNull();
    }
    // Without costing the table the tokens it really holds.
    expect(windowLengthMs("weekly")).toBe(7 * 86_400_000);
    expect(windowLengthMs("session")).toBe(5 * 3_600_000);
  });
});
