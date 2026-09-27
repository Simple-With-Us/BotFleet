// The registry's contract is forward/backward compatibility: a config
// written by a newer or differently-built app must load as an
// unavailable shadow, never crash the fleet. These tests pin that.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setLastAntigravityQuotaSnapshot } from "../antigravity-quota.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import { isCustomInstance, ProviderRegistry } from "./registry.ts";

// registry.ts resolves MiniMax's key from ~/.mmx/config.json / process env —
// stubbed here so a real key sitting in either on the machine running these
// tests can never make describe() reach the real network. getMiniMaxBalance
// itself is mocked per-test below.
// One mutable object behind both mocks so a test can move the "local
// ~/.mmx/config.json" host (the China region, a custom base_url) and assert
// where the balance lookup lands. vi.hoisted because vi.mock factories run
// before ordinary top-level consts exist.
const { localMiniMaxConfig } = vi.hoisted(() => ({
  localMiniMaxConfig: { apiKey: "", url: "https://api.minimax.io/v1", defaultModel: "" },
}));
const GLOBAL_URL = "https://api.minimax.io/v1";
vi.mock("../drivers/minimax.ts", () => ({
  loadLocalMiniMaxConfig: () => localMiniMaxConfig,
  // vi.fn (not a plain arrow) so tests can inspect what it was called
  // WITH — the resolved key stays a constant, but the environment argument
  // is the real per-instance value registry.ts passed in.
  resolveMinimaxCredentials: vi.fn(() => "test-minimax-key"),
  // registry.ts decodes a MiniMax instance's own config through the driver's
  // exported decoder rather than through whatever driver object is
  // registered, so the mock module has to supply it.  Faithful stand-in for
  // the real one's url precedence (own url → MINIMAX_BASE_URL → the global
  // default); the real decoder's agreement with GLOBAL_URL is pinned
  // separately in registry-minimax-url.test.ts, which does not mock this
  // module at all.
  decodeMinimaxConfig: (raw?: { url?: string; urlSource?: string }) => {
    const own = raw?.url?.trim();
    const env = process.env.MINIMAX_BASE_URL?.trim();
    return {
      url: own || env || "https://api.minimax.io/v1",
      // The real decoder's provenance, which resolveMinimaxApiUrl reads to
      // decide whether anything chose a host at all.
      urlSource: own
        ? (raw?.urlSource === "workspace" ? "workspace" : "instance")
        : env ? "environment" : "default",
    };
  },
}));
vi.mock("../minimax-balance.ts", () => ({
  getMiniMaxBalance: vi.fn(),
  // registry.ts also imports this — an incomplete mock module would leave
  // it `undefined` and throw inside describeEntry's try/catch, silently
  // reporting every MiniMax instance as unavailable instead of failing the
  // test loudly. Real value: same as loadLocalMiniMaxConfig's mock above.
  getCachedLocalMiniMaxConfig: () => localMiniMaxConfig,
  // The dual-window badge tests isolate the snapshot path, not the cap
  // broadcast, so the real implementation would only add noise — the
  // actual broadcast logic is covered in server/minimax-balance.test.ts.
  // Returning a plain object that satisfies the call site keeps describe()
  // honest about reporting unavailable when a chunk in registry.ts
  // reaches for an unexpected export.
  applyMiniMaxBalanceToRegistry: () => ({ capped: false }),
}));

import { resolveMinimaxCredentials } from "../drivers/minimax.ts";
import { quotaCooldowns } from "../model-fallback.ts";
import { getMiniMaxBalance } from "../minimax-balance.ts";

/** A Token Plan snapshot with one "general" pool, overridable per test. */
function tokenPlanBalance(general: Partial<{
  remainingPercent: number | null;
  secondaryRemainingPercent: number | null;
  windowsLabel: string | undefined;
  resetsAt: number | null;
  intervalResetsAt: number | null;
  weeklyResetsAt: number | null;
}> = {}) {
  const pool = {
    remainingPercent: 62,
    secondaryRemainingPercent: 40,
    windowsLabel: "5hr/Week",
    resetsAt: null,
    intervalResetsAt: null,
    weeklyResetsAt: null,
    intervalStatus: "active" as const,
    weeklyStatus: "active" as const,
    ...general,
  };
  return {
    source: "token-plan" as const,
    capExists: true,
    status: "ok" as const,
    balanceUsd: null,
    remainingPercent: pool.remainingPercent,
    secondaryRemainingPercent: pool.secondaryRemainingPercent,
    windowsLabel: pool.windowsLabel,
    models: { general: pool },
    resetsAt: pool.intervalResetsAt,
    weeklyResetsAt: pool.weeklyResetsAt,
    fetchedAt: Date.now(),
    error: null,
  };
}

describe("ProviderRegistry", () => {
  it("creates live instances for known drivers", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake", displayName: "Bot A" } });

    const live = registry.get("a");
    expect(live).not.toBeNull();
    expect(live!.driverKind).toBe("fake");
    expect(live!.displayName).toBe("Bot A");
    expect(registry.instances()).toHaveLength(1);
  });

  it("uses defaultConfig when the entry has no config", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });
    // decodeConfig must NOT have been called — defaultConfig() is used verbatim
    expect(fake.decodedConfigs).toHaveLength(0);
    expect(registry.get("a")).not.toBeNull();
  });

  it("reports cli as overridden only when the raw config sets it", async () => {
    // Regression: override detection used to read the DECODED config, whose
    // cli field is always filled in with the driver default — every instance
    // then showed as "custom" though nothing was touched.
    const fake = makeFakeDriver();
    fake.driver.defaultConfig = () => ({ cli: "fakebin" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({
      untouched: { driver: "fake", config: { other: true } },
      overridden: { driver: "fake", config: { cli: "/opt/fake/custom-bin" } },
      bare: { driver: "fake" },
    });

    const described = Object.fromEntries((await registry.describe()).map((d) => [d.instanceId, d]));
    expect(described.untouched.cli).toBeUndefined();
    expect(described.bare.cli).toBeUndefined();
    expect(described.overridden.cli).toBe("/opt/fake/custom-bin");
    expect(described.untouched.cliDefault).toBe("fakebin");
    expect(described.untouched.access).toBe("subscription");
  });

  it("publishes custom-only access from driver metadata", async () => {
    const fake = makeFakeDriver();
    Object.assign(fake.driver.metadata, { access: "custom" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ local: { driver: "fake" } });
    const [described] = await registry.describe();
    expect(described.access).toBe("custom");
  });

  it("keeps an unknown driver as an unavailable shadow instead of failing", async () => {
    const registry = new ProviderRegistry([makeFakeDriver().driver]);
    await registry.load({ mystery: { driver: "from-the-future", displayName: "Tomorrow" } });

    expect(registry.get("mystery")).toBeNull();
    const [described] = await registry.describe();
    expect(described.snapshot.state).toBe("unavailable");
    expect(described.snapshot.reason).toContain("from-the-future");
    expect(described.displayName).toBe("Tomorrow");
    expect(described.models.options).toHaveLength(0);
    // Enabled shadows still publish enabled: true so clients that filter on
    // the flag do not treat a missing field as a special case.
    expect(described.enabled).toBe(true);
    // The shadow ships a computerReach like every other row, and the picker
    // GATES destinations on that field now — so a row that shipped a
    // permissive reach would offer a destination no driver here can drive.
    // Derived from the all-false capabilities the shadow reports, not
    // hardcoded beside them.
    expect(described.computerReach).toEqual({ box: false, vps: false, vm: false, local: false });
  });

  it("preserves enabled: false on a disabled shadow so phone Settings can hide it", async () => {
    // Mac-disabled engines with unknown/invalid config become shadows.  The
    // shadow used to omit `enabled`, and iOS `isEnabled` treats missing as
    // on — so the Engines strip showed engines the Mac had turned off.
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({
      mutedMystery: { driver: "from-the-future", enabled: false, displayName: "Hidden" },
      mutedBroken: { driver: "fake", enabled: false, config: { bad: true } },
    });

    const described = Object.fromEntries((await registry.describe()).map((d) => [d.instanceId, d]));
    expect(described.mutedMystery.enabled).toBe(false);
    expect(described.mutedMystery.snapshot.state).toBe("unavailable");
    expect(described.mutedBroken.enabled).toBe(false);
    expect(described.mutedBroken.snapshot).toMatchObject({
      state: "unavailable",
      reason: "fake: bad config",
    });
  });

  it("still reaches its own box for a shadowed box-native engine", async () => {
    // The other half of the shadow rule: reach is derived from the driver
    // KIND as well as from the capabilities, because a remote agent's reach
    // is a property of where the turn runs.  This is what the client computed
    // for a shadow before the reach shipped, so a shadowed Computer engine
    // must not quietly lose the one destination it has.
    const registry = new ProviderRegistry([makeFakeDriver().driver]);
    await registry.load({ computer: { driver: "boxAgent", displayName: "Computer" } });

    const [described] = await registry.describe();
    expect(described.snapshot.state).toBe("unavailable");
    expect(described.computerReach).toEqual({ box: true, vps: false, vm: false, local: false });
  });

  it("downgrades a config-decode failure to a shadow with the error as reason", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ broken: { driver: "fake", config: { bad: true } } });

    expect(registry.get("broken")).toBeNull();
    const [described] = await registry.describe();
    expect(described.snapshot).toMatchObject({ state: "unavailable", reason: "fake: bad config" });
  });

  it("downgrades a create() rejection to a shadow without touching siblings", async () => {
    const good = makeFakeDriver({ kind: "good" });
    const flaky = makeFakeDriver({ kind: "flaky", failCreate: "boom at create" });
    const registry = new ProviderRegistry([good.driver, flaky.driver]);
    await registry.load({
      g: { driver: "good" },
      f: { driver: "flaky" },
    });

    expect(registry.get("g")).not.toBeNull();
    expect(registry.get("f")).toBeNull();
    const described = await registry.describe();
    const f = described.find((d) => d.instanceId === "f")!;
    expect(f.snapshot).toMatchObject({ state: "unavailable", reason: "boom at create" });
  });

  it("describe() reports a snapshot() failure as unavailable rather than throwing", async () => {
    const fake = makeFakeDriver({ failSnapshot: "provider probe exploded" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.snapshot).toMatchObject({ state: "unavailable", reason: "provider probe exploded" });
  });

  it("forwards a live instance's declared effort levels in describe()", async () => {
    const fake = makeFakeDriver({ effortLevels: ["low", "high"] });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.capabilities.effortLevels).toEqual(["low", "high"]);
  });

  it("omits effortLevels from describe() when the driver declares none", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.capabilities.effortLevels).toBeUndefined();
  });

  it("describe() ships toolLoop from the adapter capability", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    expect((await registry.describe())[0].capabilities.toolLoop).toBe(false);
    Object.assign(registry.get("a")!.adapter.capabilities, { toolLoop: true });
    expect((await registry.describe())[0].capabilities.toolLoop).toBe(true);
  });

  it("reports whether an instance supports isolated approval review", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    expect((await registry.describe())[0].capabilities.approvalReview).toBe(false);
    Object.assign(registry.get("a")!, { reviewPermission: async () => "ok" });
    expect((await registry.describe())[0].capabilities.approvalReview).toBe(true);
  });

  // GET /api/instances used to re-probe every CLI (--version, auth status,
  // model discovery) on every call, costing real seconds on a machine with
  // many engines installed — the engine rail's passive refreshes now pass
  // maxAgeMs so a burst of callers within that window shares one probe.
  it("describe({ maxAgeMs }) serves the memo until it lapses, then re-probes", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });
    const spy = vi.spyOn(registry, "describeFresh");

    await registry.describe({ maxAgeMs: 10_000 });
    await registry.describe({ maxAgeMs: 10_000 });
    await registry.describe({ maxAgeMs: 10_000 });
    expect(spy).toHaveBeenCalledTimes(1);

    // no maxAgeMs (or 0) — the explicit "Check again"/CLI-save path — always
    // re-probes regardless of how fresh the memo is.
    await registry.describe();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight describe() among concurrent callers instead of probing per caller", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });
    const spy = vi.spyOn(registry, "describeFresh");

    await Promise.all([
      registry.describe({ maxAgeMs: 10_000 }),
      registry.describe({ maxAgeMs: 10_000 }),
      registry.describe({ maxAgeMs: 10_000 }),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("disposeAll disposes every live instance and empties the registry", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" }, b: { driver: "fake" } });

    await registry.disposeAll();
    expect(fake.disposed.sort()).toEqual(["a", "b"]);
    expect(registry.entries()).toHaveLength(0);
    expect(registry.get("a")).toBeNull();
  });

  it("marks a `enabled: false` instance as unavailable in describe() so the default-pick filter excludes it", async () => {
    // The lane-B user requirement: disabling an engine must remove it from
    // routing. The picker filters `described.filter(d => d.snapshot.state === "available")`,
    // so a disabled engine needs to publish snapshot.state === "unavailable".
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({
      live: { driver: "fake" },
      muted: { driver: "fake", enabled: false },
    });

    const described = Object.fromEntries((await registry.describe()).map((d) => [d.instanceId, d]));
    expect(described.live.snapshot.state).toBe("available");
    expect(described.muted.snapshot.state).toBe("unavailable");
    expect(described.muted.snapshot.reason).toBe("Disabled in settings");
    // The boolean flag itself surfaces for the UI to render the toggle.
    expect(described.muted.enabled).toBe(false);
  });

  it("reloadInstance reloads only the specified instance and disposes the previous one", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({
      a: { driver: "fake", displayName: "A v1" },
      b: { driver: "fake", displayName: "B v1" },
    });

    expect(registry.get("a")?.displayName).toBe("A v1");
    expect(registry.get("b")?.displayName).toBe("B v1");

    const reloaded = await registry.reloadInstance("a", { driver: "fake", displayName: "A v2" });
    expect(reloaded).not.toBeNull();
    expect(reloaded?.displayName).toBe("A v2");
    expect(registry.get("a")?.displayName).toBe("A v2");
    expect(registry.get("b")?.displayName).toBe("B v1");
    // Only instance 'a' was disposed
    expect(fake.disposed).toEqual(["a"]);
  });

  it("removeInstance disposes and drops only the named instance, leaving siblings untouched", async () => {
    // A deleted custom engine must not force the whole fleet through
    // reloadProviders(): that disposes EVERY provider and settles every
    // busy bot elsewhere as interrupted, destroying unrelated work over an
    // unused engine going away.
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({
      a: { driver: "fake", displayName: "A v1" },
      b: { driver: "fake", displayName: "B v1" },
    });

    await registry.removeInstance("a");

    expect(fake.disposed).toEqual(["a"]);
    expect(registry.get("a")).toBeNull();
    expect(registry.get("b")?.displayName).toBe("B v1");
    expect(registry.instances()).toHaveLength(1);
    expect((await registry.describe()).map((d) => d.instanceId)).toEqual(["b"]);
  });

  it("describeWithFreshInstance updates only the specified instance in the memoized list", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({
      a: { driver: "fake", displayName: "A v1" },
      b: { driver: "fake", displayName: "B v1" },
    });

    const initial = await registry.describe({ maxAgeMs: 60_000 });
    expect(initial.find((i) => i.instanceId === "a")?.displayName).toBe("A v1");

    await registry.reloadInstance("a", { driver: "fake", displayName: "A v2" });
    const fresh = await registry.describeWithFreshInstance("a");

    expect(fresh.find((i) => i.instanceId === "a")?.displayName).toBe("A v2");
    expect(fresh.find((i) => i.instanceId === "b")?.displayName).toBe("B v1");
  });

  describe("dual-window quota badge", () => {
    beforeEach(() => {
      vi.mocked(getMiniMaxBalance).mockReset();
      // Clear call history only (not the implementation) — several tests
      // in this block don't care about resolveMinimaxCredentials at all
      // and rely on its module-mocked "test-minimax-key" return staying in
      // place across tests.
      vi.mocked(resolveMinimaxCredentials).mockClear();
    });

    it("still reports Antigravity's own dual '5hr/Week' badge (pinning the pre-generalization behavior)", async () => {
      setLastAntigravityQuotaSnapshot({
        timestamp: new Date().toISOString(),
        models: [{ label: "Gemini 3.1 Pro", modelId: "gemini-3.1-pro-high", remainingPercentage: 0.5, isExhausted: false }],
        promptCredits: { remainingPercentage: 0.4 },
      });
      try {
        const fake = makeFakeDriver({ kind: "antigravity" });
        const registry = new ProviderRegistry([fake.driver]);
        await registry.load({ antigravity: { driver: "antigravity" } });
        const [described] = await registry.describe();
        expect(described.snapshot.quota?.windowsLabel).toBe("5hr/Week");
        expect(described.snapshot.quota?.models?.["gemini-3.1-pro-high"]?.secondaryRemainingPercent).toBe(40);
      } finally {
        setLastAntigravityQuotaSnapshot(null);
      }
    });

    it("generalizes the dual-window badge to a non-Antigravity engine (MiniMax's Token Plan quota)", async () => {
      vi.mocked(getMiniMaxBalance).mockResolvedValue({
        source: "token-plan",
        capExists: true,
        status: "ok",
        balanceUsd: null,
        remainingPercent: 62,
        secondaryRemainingPercent: 40,
        windowsLabel: "5hr/Week",
        models: {
          general: {
            remainingPercent: 62,
            secondaryRemainingPercent: 40,
            windowsLabel: "5hr/Week",
            resetsAt: Date.now() + 3_600_000,
            intervalResetsAt: Date.now() + 3_600_000,
            weeklyResetsAt: Date.now() + 86_400_000,
            intervalStatus: "active",
            weeklyStatus: "active",
          },
        },
        resetsAt: Date.now() + 3_600_000,
        weeklyResetsAt: Date.now() + 86_400_000,
        fetchedAt: Date.now(),
        error: null,
      });
      const fake = makeFakeDriver({ kind: "minimax" });
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({ minimax: { driver: "minimax" } });
      const [described] = await registry.describe();
      // The regression this pins: before generalizing, windowsLabel was
      // computed only `if (inst.instanceId === "antigravity")` — a second,
      // unrelated engine with real dual-window per-model data got no badge
      // at all, no matter what its own models reported.
      expect(described.snapshot.quota?.windowsLabel).toBe("5hr/Week");
      // "general" is MiniMax's own pool name — it is mapped onto the
      // instance's CATALOG model id ("minimax-1", the fake driver's
      // default), never left under the literal "general" key, because
      // every real consumer (ModelPicker.tsx, turn-safety.ts) keys by
      // catalog model id.
      expect(described.snapshot.quota?.models?.general).toBeUndefined();
      expect(described.snapshot.quota?.models?.["minimax-1"]).toMatchObject({
        remainingPercent: 62,
        secondaryRemainingPercent: 40,
        windowsLabel: "5hr/Week",
      });
      expect(getMiniMaxBalance).toHaveBeenCalledWith("test-minimax-key", "https://api.minimax.io/v1");
    });

    it("falls back to the bare '5hr' badge when only the interval window is known", async () => {
      vi.mocked(getMiniMaxBalance).mockResolvedValue({
        source: "token-plan",
        capExists: true,
        status: "ok",
        balanceUsd: null,
        remainingPercent: 62,
        secondaryRemainingPercent: null,
        windowsLabel: "5hr",
        models: {
          general: {
            remainingPercent: 62,
            secondaryRemainingPercent: null,
            windowsLabel: "5hr",
            resetsAt: null,
            intervalResetsAt: null,
            weeklyResetsAt: null,
            intervalStatus: "unknown",
            weeklyStatus: "unknown",
          },
        },
        resetsAt: null,
        weeklyResetsAt: null,
        fetchedAt: Date.now(),
        error: null,
      });
      const fake = makeFakeDriver({ kind: "minimax" });
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({ minimax: { driver: "minimax" } });
      const [described] = await registry.describe();
      expect(described.snapshot.quota?.windowsLabel).toBe("5hr");
    });

    it("maps the 'general' pool onto every catalog model id and keeps an unrelated 'video' pool out of `models` entirely", async () => {
      // Regression: server/minimax-balance.ts's `models` dict is keyed by
      // MiniMax's own POOL name ("general" = chat, "video" = video
      // generation), not by catalog model id. Every real consumer
      // (ModelPicker.tsx's per-row badge/"Partial quota" chip,
      // turn-safety.ts's eligibleAutoFallbackChain) keys by catalog model
      // id — so an exhausted, unrelated "video" pool must never appear
      // under a chat model's id or mislabel the whole engine as capped.
      vi.mocked(getMiniMaxBalance).mockResolvedValue({
        source: "token-plan",
        capExists: true,
        status: "ok",
        balanceUsd: null,
        remainingPercent: 62,
        secondaryRemainingPercent: 40,
        windowsLabel: "5hr/Week",
        models: {
          general: { remainingPercent: 62, secondaryRemainingPercent: 40, windowsLabel: "5hr/Week", resetsAt: null, intervalResetsAt: null, weeklyResetsAt: null, intervalStatus: "active", weeklyStatus: "active" },
          video: { remainingPercent: 0, secondaryRemainingPercent: 0, windowsLabel: "5hr/Week", resetsAt: null, intervalResetsAt: null, weeklyResetsAt: null, intervalStatus: "active", weeklyStatus: "active" },
        },
        resetsAt: null,
        weeklyResetsAt: null,
        fetchedAt: Date.now(),
        error: null,
      });
      const fake = makeFakeDriver({
        kind: "minimax",
        models: { default: "MiniMax-M3", options: [{ id: "MiniMax-M3", label: "MiniMax M3" }, { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed" }] },
      });
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({ minimax: { driver: "minimax" } });
      const [described] = await registry.describe();
      // Every chat model reads "general"'s reading (uncapped at 62%) —
      // not the exhausted "video" pool.
      expect(described.snapshot.quota?.models?.["MiniMax-M3"]?.capped).toBe(false);
      expect(described.snapshot.quota?.models?.["MiniMax-M2.7-highspeed"]?.capped).toBe(false);
      expect(described.snapshot.quota?.models?.["MiniMax-M3"]?.remainingPercent).toBe(62);
      // Neither MiniMax's own pool names land in `models` — "general" isn't
      // a catalog id, and "video" is a different quota pool entirely.
      expect(described.snapshot.quota?.models?.general).toBeUndefined();
      expect(described.snapshot.quota?.models?.video).toBeUndefined();
    });

    it("caps every chat model when 'general' itself is at 0%, independent of a healthy 'video' pool", async () => {
      vi.mocked(getMiniMaxBalance).mockResolvedValue({
        source: "token-plan",
        capExists: true,
        status: "capped",
        balanceUsd: null,
        remainingPercent: 0,
        secondaryRemainingPercent: 0,
        windowsLabel: "5hr/Week",
        models: {
          general: { remainingPercent: 0, secondaryRemainingPercent: 0, windowsLabel: "5hr/Week", resetsAt: null, intervalResetsAt: null, weeklyResetsAt: null, intervalStatus: "active", weeklyStatus: "active" },
          video: { remainingPercent: 95, secondaryRemainingPercent: 95, windowsLabel: "5hr/Week", resetsAt: null, intervalResetsAt: null, weeklyResetsAt: null, intervalStatus: "active", weeklyStatus: "active" },
        },
        resetsAt: null,
        weeklyResetsAt: null,
        fetchedAt: Date.now(),
        error: null,
      });
      const fake = makeFakeDriver({
        kind: "minimax",
        models: { default: "MiniMax-M3", options: [{ id: "MiniMax-M3", label: "MiniMax M3" }, { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed" }] },
      });
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({ minimax: { driver: "minimax" } });
      const [described] = await registry.describe();
      expect(described.snapshot.quota?.models?.["MiniMax-M3"]?.capped).toBe(true);
      expect(described.snapshot.quota?.models?.["MiniMax-M2.7-highspeed"]?.capped).toBe(true);
    });

    it("resolves a second MiniMax instance's own environment/config.url instead of the reserved instance's", async () => {
      // Regression: registry.ts and server/index.ts both called
      // resolveMinimaxCredentials({}, local) with an EMPTY environment and
      // derived the URL from process.env/local only — a second connection
      // with its own key/host was balance-checked as if it were the
      // reserved instance. resolveMinimaxCredentials is mocked module-wide
      // to always return the same string (see the top-of-file vi.mock), so
      // this test proves the fix by inspecting what it was CALLED WITH
      // (the environment) and by the URL that reached getMiniMaxBalance
      // (real registry.ts logic, not mocked) — not by varying the key.
      vi.mocked(getMiniMaxBalance).mockResolvedValue({
        source: "token-plan",
        capExists: true,
        status: "ok",
        balanceUsd: null,
        remainingPercent: 90,
        secondaryRemainingPercent: null,
        windowsLabel: "5hr",
        models: { general: { remainingPercent: 90, secondaryRemainingPercent: null, windowsLabel: "5hr", resetsAt: null, intervalResetsAt: null, weeklyResetsAt: null, intervalStatus: "active", weeklyStatus: "active" } },
        resetsAt: null,
        weeklyResetsAt: null,
        fetchedAt: Date.now(),
        error: null,
      });
      const fake = makeFakeDriver({ kind: "minimax" });
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({
        minimax: { driver: "minimax" },
        secondMinimax: { driver: "minimax", environment: { MINIMAX_API_KEY: "second-instance-key" }, config: { url: "https://api.minimaxi.com/v1" } },
      });
      await registry.describe();
      const calls = vi.mocked(resolveMinimaxCredentials).mock.calls;
      const reservedCall = calls.find((c) => Object.keys(c[0]).length === 0);
      const secondCall = calls.find((c) => c[0].MINIMAX_API_KEY === "second-instance-key");
      expect(reservedCall).toBeDefined();
      expect(secondCall).toBeDefined();
      // Each instance's own resolved URL reached getMiniMaxBalance: the
      // reserved one falls back to the mocked local.url, the second one
      // uses its own decoded config.url.
      expect(getMiniMaxBalance).toHaveBeenCalledWith("test-minimax-key", "https://api.minimax.io/v1");
      expect(getMiniMaxBalance).toHaveBeenCalledWith("test-minimax-key", "https://api.minimaxi.com/v1");
    });

    it("leaves windowsLabel undefined for an engine with no dual-window source at all", async () => {
      vi.mocked(getMiniMaxBalance).mockResolvedValue({
        source: "unavailable",
        capExists: false,
        status: "unknown",
        balanceUsd: null,
        remainingPercent: null,
        secondaryRemainingPercent: null,
        windowsLabel: undefined,
        models: null,
        resetsAt: null,
        weeklyResetsAt: null,
        fetchedAt: Date.now(),
        error: "no key configured",
      });
      const fake = makeFakeDriver();
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({ a: { driver: "fake" } });
      const [described] = await registry.describe();
      expect(described.snapshot.quota?.windowsLabel).toBeUndefined();
      // A non-MiniMax, non-Antigravity engine must never trigger the
      // MiniMax balance lookup at all.
      expect(getMiniMaxBalance).not.toHaveBeenCalled();
    });

    it("caps every chat model when the WEEKLY window is exhausted even though the 5-hour one is full", async () => {
      // Regression: the per-model verdict read only the interval percent,
      // so an account with a spent weekly allowance kept showing every
      // model as available and stayed in the auto-fallback chain.
      const now = Date.now();
      const weeklyResetsAt = now + (3 * 86_400_000);
      vi.mocked(getMiniMaxBalance).mockResolvedValue(
        tokenPlanBalance({ remainingPercent: 100, secondaryRemainingPercent: 0, intervalResetsAt: now + 1_200_000, weeklyResetsAt }),
      );
      const fake = makeFakeDriver({
        kind: "minimax",
        models: { default: "MiniMax-M3", options: [{ id: "MiniMax-M3", label: "MiniMax M3" }] },
      });
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({ minimax: { driver: "minimax" } });
      const [described] = await registry.describe();
      expect(described.snapshot.quota?.models?.["MiniMax-M3"]?.capped).toBe(true);
      // The reset the row reports is the WEEKLY one — the 5-hour window
      // refilling in twenty minutes changes nothing while the week is out.
      expect(described.snapshot.quota?.models?.["MiniMax-M3"]?.resetsAt).toBe(weeklyResetsAt);
      expect(described.snapshot.quota?.capped).toBe(true);
    });

    it("publishes a top-level cap for an exhausted pay-as-you-go wallet, which reports no pools at all", async () => {
      // An `sk-api-` account answers /account/query_balance, which has no
      // per-model rows — so nothing used to reach `models`, allCatalogCapped
      // stayed false, and ModelPicker plus eligibleAutoFallbackChain kept
      // offering an account with no money in it.
      vi.mocked(getMiniMaxBalance).mockResolvedValue({
        source: "account-balance",
        capExists: true,
        status: "capped",
        balanceUsd: 0,
        remainingPercent: null,
        secondaryRemainingPercent: null,
        windowsLabel: undefined,
        models: null,
        resetsAt: null,
        weeklyResetsAt: null,
        fetchedAt: Date.now(),
        error: null,
      });
      const fake = makeFakeDriver({
        kind: "minimax",
        models: { default: "MiniMax-M3", options: [{ id: "MiniMax-M3", label: "MiniMax M3" }, { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed" }] },
      });
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({ minimax: { driver: "minimax" } });
      const [described] = await registry.describe();
      expect(described.snapshot.quota?.capped).toBe(true);
      expect(described.snapshot.quota?.models?.["MiniMax-M3"]?.capped).toBe(true);
      expect(described.snapshot.quota?.models?.["MiniMax-M2.7-highspeed"]?.capped).toBe(true);
    });

    it("keeps a live per-model cooldown's cap and reset, only filling in the window figures the balance check knows", async () => {
      // quotaCooldowns.record is a REAL 429 from a real turn — the more
      // authoritative signal. The pool mapping must merge into it, never
      // overwrite it back to "available" because the account-wide quota
      // still looks healthy.
      const resetsAt = Date.now() + 900_000;
      quotaCooldowns.record({
        botId: "*",
        instanceId: "minimax",
        model: "MiniMax-M3",
        resetsAt,
        error: "Rate limit reached for MiniMax-M3",
        recordedAt: Date.now(),
      });
      try {
        vi.mocked(getMiniMaxBalance).mockResolvedValue(tokenPlanBalance({ remainingPercent: 62, secondaryRemainingPercent: 40 }));
        const fake = makeFakeDriver({
          kind: "minimax",
          models: { default: "MiniMax-M3", options: [{ id: "MiniMax-M3", label: "MiniMax M3" }, { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed" }] },
        });
        const registry = new ProviderRegistry([fake.driver]);
        await registry.load({ minimax: { driver: "minimax" } });
        const [described] = await registry.describe();
        const capped = described.snapshot.quota?.models?.["MiniMax-M3"];
        expect(capped?.capped).toBe(true);
        expect(capped?.resetsAt).toBe(resetsAt);
        expect(capped?.error).toBe("Rate limit reached for MiniMax-M3");
        // …and it still gains the window figures the cooldown never had.
        expect(capped?.remainingPercent).toBe(62);
        expect(capped?.windowsLabel).toBe("5hr/Week");
        // The model with no cooldown reads the healthy pool as usual.
        expect(described.snapshot.quota?.models?.["MiniMax-M2.7-highspeed"]?.capped).toBe(false);
      } finally {
        quotaCooldowns.clear("*", "minimax", "MiniMax-M3");
      }
    });

    it("balance-checks the host the instance's turns use: the local mmx config's region when nothing else chose one", async () => {
      // MinimaxDriver.create() swaps the built-in default for the host in
      // ~/.mmx/config.json (a China-region or custom base_url login), so a
      // lookup pinned to the global default would send this key to the
      // wrong region and report quota as unavailable.
      localMiniMaxConfig.url = "https://api.minimaxi.com/v1";
      try {
        vi.mocked(getMiniMaxBalance).mockResolvedValue(tokenPlanBalance());
        const fake = makeFakeDriver({ kind: "minimax" });
        const registry = new ProviderRegistry([fake.driver]);
        await registry.load({ minimax: { driver: "minimax" } });
        await registry.describe();
        expect(getMiniMaxBalance).toHaveBeenCalledWith("test-minimax-key", "https://api.minimaxi.com/v1");
      } finally {
        localMiniMaxConfig.url = GLOBAL_URL;
      }
    });

    it("prefers MINIMAX_BASE_URL over the local mmx config, exactly as a turn resolves its host", async () => {
      const previous = process.env.MINIMAX_BASE_URL;
      process.env.MINIMAX_BASE_URL = "https://minimax.internal.example/v1";
      localMiniMaxConfig.url = "https://api.minimaxi.com/v1";
      try {
        vi.mocked(getMiniMaxBalance).mockResolvedValue(tokenPlanBalance());
        const fake = makeFakeDriver({ kind: "minimax" });
        const registry = new ProviderRegistry([fake.driver]);
        await registry.load({ minimax: { driver: "minimax" } });
        await registry.describe();
        expect(getMiniMaxBalance).toHaveBeenCalledWith("test-minimax-key", "https://minimax.internal.example/v1");
      } finally {
        if (previous === undefined) delete process.env.MINIMAX_BASE_URL;
        else process.env.MINIMAX_BASE_URL = previous;
        localMiniMaxConfig.url = GLOBAL_URL;
      }
    });

    it("balance-checks the global host for a reserved instance that explicitly configures it while ~/.mmx is CN", async () => {
      // ~/.mmx/config.json is a workspace-wide DEFAULT, so it yields to any
      // host that was actually chosen — and that question is answered by the
      // decoded config's provenance, never by comparing its url to the global
      // default.  An instance whose config carries a url chose one, even when
      // the url it chose is byte-identical to the unset state's; the driver's
      // own gate reads it the same way, so the balance lookup and the turns
      // agree on the account being reported.
      localMiniMaxConfig.url = "https://api.minimaxi.com/v1";
      try {
        vi.mocked(getMiniMaxBalance).mockResolvedValue(tokenPlanBalance());
        const fake = makeFakeDriver({ kind: "minimax" });
        const registry = new ProviderRegistry([fake.driver]);
        await registry.load({ minimax: { driver: "minimax", config: { url: GLOBAL_URL } } });
        await registry.describe();
        expect(getMiniMaxBalance).toHaveBeenCalledWith("test-minimax-key", GLOBAL_URL);
        expect(getMiniMaxBalance).not.toHaveBeenCalledWith("test-minimax-key", "https://api.minimaxi.com/v1");
      } finally {
        localMiniMaxConfig.url = GLOBAL_URL;
      }
    });

    it("still hands the reserved instance ~/.mmx's host when nothing chose one", async () => {
      // The other half of the same rule: with no url on the entry at all,
      // the machine-wide profile is what decides, which is the whole reason
      // that file is read.
      localMiniMaxConfig.url = "https://api.minimaxi.com/v1";
      try {
        vi.mocked(getMiniMaxBalance).mockResolvedValue(tokenPlanBalance());
        const fake = makeFakeDriver({ kind: "minimax" });
        const registry = new ProviderRegistry([fake.driver]);
        await registry.load({ minimax: { driver: "minimax" } });
        await registry.describe();
        expect(getMiniMaxBalance).toHaveBeenCalledWith("test-minimax-key", "https://api.minimaxi.com/v1");
      } finally {
        localMiniMaxConfig.url = GLOBAL_URL;
      }
    });

    it("keeps reading the host it captured at load when ~/.mmx/config.json changes underneath it", async () => {
      // The driver captures its key and host ONCE, in create()'s closure,
      // and never re-reads them.  A balance lookup that re-resolved them on
      // every describe reported one account's quota while every turn billed
      // another the moment `mmx auth login --api-key …` rewrote the file —
      // and that reading publishes quota.capped, so the mismatch decided
      // auto-fallback too.
      vi.mocked(getMiniMaxBalance).mockResolvedValue(tokenPlanBalance());
      const fake = makeFakeDriver({ kind: "minimax" });
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({ minimax: { driver: "minimax" } });
      localMiniMaxConfig.url = "https://api.minimaxi.com/v1";
      try {
        await registry.describe();
        expect(getMiniMaxBalance).toHaveBeenCalledWith("test-minimax-key", GLOBAL_URL);
        expect(getMiniMaxBalance).not.toHaveBeenCalledWith("test-minimax-key", "https://api.minimaxi.com/v1");
        // …and a reload — the same moment the driver itself re-reads the
        // file — does pick the new host up.
        await registry.reloadInstance("minimax", { driver: "minimax" });
        await registry.describe();
        expect(getMiniMaxBalance).toHaveBeenCalledWith("test-minimax-key", "https://api.minimaxi.com/v1");
      } finally {
        localMiniMaxConfig.url = GLOBAL_URL;
      }
    });

    it("keeps the DRIVER's own quota.capped verdict when the balance endpoint reports nothing", async () => {
      // The MiniMax driver caps itself off its own /models probe (a 402 or
      // 429 classifies as quota_or_region_restriction).  The balance block
      // used to assign straight over snapshot.quota, so a blocked account
      // whose undocumented balance endpoint timed out published
      // capped: false — the green "Available" chip, and still eligible for
      // auto-fallback.
      vi.mocked(getMiniMaxBalance).mockResolvedValue({
        source: "unavailable",
        capExists: false,
        status: "unknown",
        balanceUsd: null,
        remainingPercent: null,
        secondaryRemainingPercent: null,
        windowsLabel: undefined,
        models: null,
        resetsAt: null,
        weeklyResetsAt: null,
        fetchedAt: Date.now(),
        error: "balance lookup timed out",
      });
      const driverResetsAt = Date.now() + 1_800_000;
      const fake = makeFakeDriver({
        kind: "minimax",
        quota: { capped: true, resetsAt: driverResetsAt, error: "MiniMax quota or region restriction (HTTP 402)" },
      });
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({ minimax: { driver: "minimax" } });
      const [described] = await registry.describe();
      expect(described.snapshot.quota?.capped).toBe(true);
      // The driver's own reset and reason survive too — there is no
      // wildcard cooldown here to supply a better one.
      expect(described.snapshot.quota?.resetsAt).toBe(driverResetsAt);
      expect(described.snapshot.quota?.error).toBe("MiniMax quota or region restriction (HTTP 402)");
      // The balance summary is still published alongside it.
      expect(described.snapshot.quota?.minimax?.source).toBe("unavailable");
    });

    it("still reports a healthy MiniMax instance as uncapped when the driver reports no quota of its own", async () => {
      // The guard above must only ever ADD a reason to be capped — a driver
      // that says nothing must not start reading as capped.
      vi.mocked(getMiniMaxBalance).mockResolvedValue(tokenPlanBalance({ remainingPercent: 80, secondaryRemainingPercent: 70 }));
      const fake = makeFakeDriver({ kind: "minimax" });
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({ minimax: { driver: "minimax" } });
      const [described] = await registry.describe();
      expect(described.snapshot.quota?.capped).toBe(false);
    });

    it("pre-populates describe memo from disk cache and updates it after fresh describe", async () => {
      const fake = makeFakeDriver();
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({ test: { driver: "fake" } });

      const tmpDir = join(tmpdir(), `bf-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const cachePath = join(tmpDir, "engine-cache.json");

      mkdirSync(tmpDir, { recursive: true });
      const cachedSnapshot = [{
        instanceId: "cached-instance",
        driverKind: "fake",
        displayName: "Cached",
        enabled: true,
        snapshot: { state: "available" } as const,
        models: { default: "cached-m", options: [] },
        capabilities: { computerMcp: false, agentsMcp: false, localComputerMcp: false },
        computerReach: { local: false, box: false, vps: false },
        access: "subscription",
        install: undefined,
        cli: undefined,
        cliDefault: undefined,
        cliCandidates: [],
        fullAuto: false,
      }];
      writeFileSync(cachePath, JSON.stringify(cachedSnapshot));

      registry.setDiskCachePath(cachePath);
      // Since maxAgeMs is large and cache is present, returns cached instances immediately
      const instant = await registry.describe({ maxAgeMs: 60_000 });
      expect(instant[0].instanceId).toBe("cached-instance");

      // Describe fresh overwrites disk cache with the actual live engines
      const fresh = await registry.describeFresh();
      expect(fresh[0].instanceId).toBe("test");

      // The cache now carries the capture time alongside the instances (see
      // HS26) so a caller passing maxAgeMs without staleWhileRevalidate does
      // not treat an old cache as fresh on the next boot.
      const saved = JSON.parse(readFileSync(cachePath, "utf8"));
      expect(saved.instances[0].instanceId).toBe("test");
      expect(saved.at).toEqual(expect.any(Number));

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("writes the disk cache exactly once per fresh probe", async () => {
      const fake = makeFakeDriver();
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({ test: { driver: "fake" } });

      const tmpDir = join(tmpdir(), `bf-cache-single-write-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const cachePath = join(tmpDir, "engine-cache.json");
      mkdirSync(tmpDir, { recursive: true });
      registry.setDiskCachePath(cachePath);

      const writeFileAtomicModule = await import("../atomic.ts");
      const spy = vi.spyOn(writeFileAtomicModule, "writeFileAtomic");
      try {
        // describe() without a fresh memo goes through refreshDescribe(),
        // which used to call saveDiskCache both inside describeFresh() and
        // again in its own .then() — one probe, two writes.
        await registry.describe();
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("preserves the on-disk capture time across a reload instead of stamping it probed-now", async () => {
      const fake = makeFakeDriver();
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({ test: { driver: "fake" } });

      const tmpDir = join(tmpdir(), `bf-cache-stale-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const cachePath = join(tmpDir, "engine-cache.json");
      mkdirSync(tmpDir, { recursive: true });
      const capturedAt = Date.now() - 10 * 60_000; // 10 minutes ago
      writeFileSync(cachePath, JSON.stringify({
        at: capturedAt,
        instances: [{
          instanceId: "cached-instance",
          driverKind: "fake",
          displayName: "Cached",
          enabled: true,
          snapshot: { state: "available" } as const,
          models: { default: "cached-m", options: [] },
          capabilities: { computerMcp: false, agentsMcp: false, localComputerMcp: false },
          computerReach: { local: false, box: false, vps: false },
          access: "subscription",
          install: undefined,
          cli: undefined,
          cliDefault: undefined,
          cliCandidates: [],
          fullAuto: false,
        }],
      }));

      registry.setDiskCachePath(cachePath);
      // A 1-minute freshness window against a cache captured 10 minutes ago
      // must NOT read as fresh, and with no staleWhileRevalidate opt-in must
      // NOT be returned at all — it would be (the HS26 bug) if
      // setDiskCachePath had stamped the memo probed-now instead of keeping
      // the real capture time, and this call would wrongly short-circuit to
      // the stale "cached-instance" answer instead of actually probing.
      const result = await registry.describe({ maxAgeMs: 60_000 });
      expect(result[0].instanceId).toBe("test");

      rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});

describe("isCustomInstance", () => {
  it("calls an instance custom when it is not its driver's reserved one", () => {
    // `isCustom` is what puts a Delete button on an engine row and what the
    // "added by you" callout keys off, so it has to follow the DRIVER, not a
    // single hard-coded id. MiniMax is the second driver that can carry more
    // than one instance; before this it could carry them and never say so.
    expect(isCustomInstance("openai-compat", "openaiCompat")).toBe(false);
    expect(isCustomInstance("openai-compat", "custom-ollama")).toBe(true);
    expect(isCustomInstance("minimax", "minimax")).toBe(false);
    expect(isCustomInstance("minimax", "custom-minimax-china")).toBe(true);
  });

  it("knows the default fleet's own ids for every driver whose id is not its kind", () => {
    expect(isCustomInstance("claudeAgent", "claude")).toBe(false);
    expect(isCustomInstance("boxAgent", "computer")).toBe(false);
    expect(isCustomInstance("cursorAgent", "cursor")).toBe(false);
    expect(isCustomInstance("codex", "codex")).toBe(false);
  });

  it("fails SAFE for a driver nobody remembered to list", () => {
    // The old table listed two drivers and answered false for every other
    // driver's non-reserved id, hiding the delete button on an instance the
    // operator really did add. The fallback is "reserved id IS the driver
    // kind", which is how the default fleet names every remaining instance.
    expect(isCustomInstance("not-a-real-driver", "not-a-real-driver")).toBe(false);
    expect(isCustomInstance("not-a-real-driver", "custom-something")).toBe(true);
    expect(isCustomInstance("someFutureDriver", "someFutureDriver-2")).toBe(true);
  });
});
