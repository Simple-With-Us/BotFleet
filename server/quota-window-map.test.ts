import { describe, expect, it } from "vitest";

import {
  canonicalQuotaProvider,
  driverKindsForWindow,
  engineMeterNote,
  familiesForWindow,
  isPlanLevelSkip,
  isSupportedQuotaProvider,
  lookupOwn,
  modelsToSkip,
  MODEL_TYPE_FAMILIES,
  modelTypeFromId,
  NEAR_CAP_PERCENT,
  quotaProviderForDriver,
  type QuotaWindowMatch,
} from "./quota-window-map.ts";

function window(overrides: Partial<QuotaWindowMatch> = {}): QuotaWindowMatch {
  return {
    provider: "",
    sourceApp: null,
    label: "",
    skip: false,
    ...overrides,
  };
}

describe("driverKindsForWindow — droid/Factory", () => {
  it("maps a Factory-provider window onto droidAgent", () => {
    expect(driverKindsForWindow(window({ provider: "factory", label: "Factory weekly" }))).toEqual(["droidAgent"]);
  });

  it("maps a window merely labeled 'droid' onto droidAgent", () => {
    expect(driverKindsForWindow(window({ label: "Droid session cap" }))).toEqual(["droidAgent"]);
  });

  it("does not map an unrelated window onto droidAgent", () => {
    expect(driverKindsForWindow(window({ provider: "openai", label: "ChatGPT weekly" }))).not.toContain("droidAgent");
  });
});

describe("engineMeterNote", () => {
  it("returns an explicit metered note for pi, qwen, hermes, opencodeGo and boxAgent", () => {
    for (const kind of ["piAgent", "qwenAgent", "hermesAgent", "opencodeGo", "boxAgent"]) {
      const note = engineMeterNote(kind);
      expect(note).not.toBeNull();
      expect(note?.kind).toBe("metered");
      expect(note?.copy.length).toBeGreaterThan(0);
      // Sentence-case status-line convention: no leading capital, no
      // trailing period — matches the rest of the Fleet Quotas row copy.
      expect(note?.copy[0]).toBe(note?.copy[0]?.toLowerCase());
      expect(note?.copy.endsWith(".")).toBe(false);
    }
  });

  it("returns null for an engine with a real Usage Monitor window family", () => {
    expect(engineMeterNote("droidAgent")).toBeNull();
    expect(engineMeterNote("cursorAgent")).toBeNull();
  });

  it("does not claim Qwen/DashScope as the sole biller for qwenAgent — its injected-model path can point at any endpoint", () => {
    // qwen.ts's `host::model` inject path can reach a local host or any
    // OpenAI-compatible endpoint the owner registered, not only Alibaba's
    // own Qwen Cloud/DashScope API — the copy must not name a single vendor
    // as if BotFleet knows who actually bills.
    const copy = engineMeterNote("qwenAgent")?.copy ?? "";
    expect(copy).not.toMatch(/billed to your own Qwen\/DashScope key/i);
  });

  it("returns null for an unknown driver kind", () => {
    expect(engineMeterNote("someFutureEngine")).toBeNull();
  });
});

describe("the producer's family names", () => {
  const claudeCatalog = {
    instanceId: "claude",
    driverKind: "claudeAgent",
    models: { options: [
      { id: "claude-opus-4-6-thinking" },
      { id: "claude-opus-4-6" },
      { id: "claude-sonnet-4-6" },
      { id: "claude-haiku-4-5" },
    ] },
  };
  const family = (modelType: string, label = "Weekly"): QuotaWindowMatch =>
    window({ provider: "anthropic", label, modelType, modelId: null, skip: true, window: "1w" });

  it("caps every catalog model of a family the producer named, and only that family", () => {
    // AgentBar spells the Claude subscription's families the way its own menu
    // does; the catalog spells them "claude-opus" and so on.  Unmapped, a
    // family-level window matched nothing and could only cap an exact modelId.
    expect(modelsToSkip(family("opus"), claudeCatalog))
      .toEqual(["claude-opus-4-6-thinking", "claude-opus-4-6"]);
    expect(modelsToSkip(family("sonnet"), claudeCatalog)).toEqual(["claude-sonnet-4-6"]);
    expect(modelsToSkip(family("haiku"), claudeCatalog)).toEqual(["claude-haiku-4-5"]);
    // Every family the map names has to be a spelling the catalog itself
    // produces — each one is a fixed point of modelTypeFromId — or the entry
    // would look wired up while matching no model at all, which is the whole
    // failure this map exists to end.
    for (const [name, families] of Object.entries(MODEL_TYPE_FAMILIES)) {
      expect(families.length, name).toBeGreaterThan(0);
      expect(familiesForWindow(family(name)), name).toEqual(families);
      for (const spelling of families) expect(modelTypeFromId(spelling), spelling).toBe(spelling);
    }
  });

  it("splits Antigravity's two pools by family as well as by label", () => {
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
    expect(modelsToSkip(family("third-party"), antigravity)).toEqual(["claude-sonnet-4-6", "gpt-oss-120b-medium"]);
    // Both camelCase spellings the producer could equally write.  Lowercasing
    // alone reaches "thirdparty" but runs "thirdPartyModels" into one word
    // that matches nothing, so the humps are split before the key is folded.
    expect(modelsToSkip(family("thirdParty"), antigravity)).toEqual(["claude-sonnet-4-6", "gpt-oss-120b-medium"]);
    expect(modelsToSkip(family("thirdPartyModels"), antigravity)).toEqual(["claude-sonnet-4-6", "gpt-oss-120b-medium"]);
    expect(modelsToSkip(family("geminiModels"), antigravity)).toEqual(["gemini-3.6-pro", "gemini-3.6-flash-high"]);
    // The pool's label alone still answers, for a row naming no family.
    expect(familiesForWindow(family("", "Third-Party Models · Weekly"))).toContain("gpt");
  });

  it("leaves the catalog's own spellings and an unknown family alone", () => {
    // A window already spelled the catalog's way must not be remapped, and a
    // family neither app knows is passed through rather than dropped, so a
    // catalog model spelled the same way still matches.
    expect(familiesForWindow(family("claude-opus"))).toEqual(["claude-opus"]);
    expect(familiesForWindow(family("kimi"))).toEqual(["kimi"]);
    expect(familiesForWindow(family(""))).toEqual([]);
    expect(modelTypeFromId("claude-opus-4-6-thinking")).toBe("claude-opus");
  });

  it("keeps the plan-level and unskipped answers the map was not allowed to move", () => {
    // modelsToSkip, isPlanLevelSkip and driverKindsForWindow were added to,
    // never reshaped: a window that is not skipped still caps nothing, a
    // monthly one still caps the whole engine ahead of any family, and a
    // family window still reaches the driver its provider names.
    expect(modelsToSkip({ ...family("opus"), skip: false }, claudeCatalog)).toEqual([]);
    const monthly = { ...family("opus"), window: "monthly" };
    expect(isPlanLevelSkip(monthly)).toBe(true);
    expect(modelsToSkip(monthly, claudeCatalog)).toEqual(["*"]);
    expect(isPlanLevelSkip(family("opus"))).toBe(false);
    expect(driverKindsForWindow(family("opus"))).toEqual(["claudeAgent"]);
    // An exact model id still wins over its family.
    expect(modelsToSkip({ ...family("opus"), modelId: "claude-opus-4-6" }, claudeCatalog)).toEqual(["claude-opus-4-6"]);
  });

  it("puts near-cap exactly where the producer puts it", () => {
    // One constant behind the server's derived status, the grid cell and the
    // engine chip (src/lib/quota-display.ts re-exports this very binding).
    expect(NEAR_CAP_PERCENT).toBe(20);
  });
});

describe("dictionary lookups on untrusted handoff text", () => {
  // The handoff is a file any process running as this user can write, and
  // every table in quota-window-map.ts is indexed with text out of it.  A
  // bare `TABLE[key]` answers Object.prototype's own members, so a modelType
  // of "constructor" resolved to the `Object` function, `??` never fired, and
  // `new Set(familiesForWindow(...))` threw `function is not iterable` — out
  // of a poll the harness runs fire-and-forget on boot.
  const POLLUTED = ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty", "propertyIsEnumerable"];
  const catalog = {
    instanceId: "claude",
    driverKind: "claudeAgent",
    models: { options: [{ id: "claude-opus-4-6" }] },
  };

  it("passes a prototype member through as an ordinary family name", () => {
    for (const key of POLLUTED) {
      const row = window({ provider: "anthropic", label: "Weekly", modelType: key, modelId: null, skip: true, window: "1w" });
      const families = familiesForWindow(row);
      expect(Array.isArray(families)).toBe(true);
      // Passed through unchanged, exactly as any other family the map does
      // not know — never the prototype member of that name.
      expect(families).toEqual([key]);
      // The throw the finding reproduced: this is the call that did it.
      expect(() => modelsToSkip(row, catalog)).not.toThrow();
      expect(modelsToSkip(row, catalog)).toEqual([]);
    }
  });

  it("keeps a prototype member out of the provider, driver and meter tables", () => {
    for (const key of POLLUTED) {
      expect(typeof canonicalQuotaProvider({ providerKey: key })).toBe("string");
      expect(isSupportedQuotaProvider({ providerKey: key })).toBe(false);
      expect(quotaProviderForDriver(key)).toBeNull();
      expect(engineMeterNote(key)).toBeNull();
    }
  });

  it("still answers for the keys the tables really hold", () => {
    // The guard must not cost the lookups their real entries.
    expect(familiesForWindow(window({ provider: "anthropic", label: "Weekly", modelType: "opus" }))).toEqual(["claude-opus"]);
    expect(canonicalQuotaProvider({ providerKey: "claude-code" })).toBe("anthropic");
    expect(quotaProviderForDriver("claudeAgent")).toBe("anthropic");
    expect(engineMeterNote("piAgent")?.kind).toBe("metered");
    expect(lookupOwn(MODEL_TYPE_FAMILIES, "opus")).toEqual(["claude-opus"]);
    expect(lookupOwn(MODEL_TYPE_FAMILIES, "constructor")).toBeUndefined();
  });
});
