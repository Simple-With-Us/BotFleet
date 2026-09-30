import { describe, expect, it } from "vitest";

import {
  anyLineageLabel,
  applyOwnerDirective,
  classifyModel,
  latestOptions,
  lineageStatus,
  modelPrice,
  newestInClass,
  presentCatalog,
  pricesWithinBand,
  reconcileChain,
  reconcileEntry,
  retiredModel,
  withinPriceBand,
  type LineageContext,
  type LineageSelection,
} from "./model-lineage.ts";

const CLAUDE_IDS = [
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
  "claude-sonnet-5",
  "claude-haiku-4-5",
];
const CODEX_LIVE = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"];
const GROK_IDS = ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"];

const ctx = (driverKind: string, offeredIds: string[], authoritative = true): LineageContext => ({
  driverKind,
  offeredIds,
  authoritative,
});

describe("classifyModel", () => {
  it("classifies current, dated, and legacy Claude ids", () => {
    expect(classifyModel("claudeAgent", "claude-sonnet-5-5")).toMatchObject({ classKey: "sonnet", rank: [5, 5] });
    expect(classifyModel("claudeAgent", "claude-opus-5")).toMatchObject({ classKey: "opus", rank: [5] });
    expect(classifyModel("claudeAgent", "claude-haiku-4-5-20251001")).toMatchObject({ classKey: "haiku", rank: [4, 5] });
    expect(classifyModel("claudeAgent", "claude-sonnet-4-20250514")).toMatchObject({ classKey: "sonnet", rank: [4] });
    expect(classifyModel("claudeAgent", "claude-3-7-sonnet")).toMatchObject({ classKey: "sonnet", rank: [3, 7] });
    expect(classifyModel("claudeAgent", "claude-3-5-haiku-latest")).toMatchObject({ classKey: "haiku", rank: [3, 5] });
  });

  it("leaves custom, local, and unknown ids alone", () => {
    expect(classifyModel("claudeAgent", "claude-sonnet-5-custom")).toBeNull();
    expect(classifyModel("claudeAgent", "ollama::claude-sonnet-5")).toBeNull();
    expect(classifyModel("codex", "gpt-5.5")).toBeNull();
    expect(classifyModel("codex", "gpt-5.3-codex-spark")).toBeNull();
    expect(classifyModel("minimax", "MiniMax-M3")).toBeNull();
    expect(classifyModel("dshAgent", "DeepSeek-V4.1-Flash")).toBeNull();
  });

  it("scopes families to the engine", () => {
    expect(classifyModel("codex", "claude-sonnet-5")).toBeNull();
    expect(classifyModel("droidAgent", "claude-sonnet-5")).toMatchObject({ classKey: "sonnet" });
    expect(classifyModel("grokAgent", "grok-4.7-build-fast")).toMatchObject({ classKey: "grok-build-fast", rank: [4, 7] });
    expect(classifyModel("grok", "grok-4.6")).toMatchObject({ classKey: "grok", rank: [4, 6] });
  });

  it("labels ids the way the catalogs do", () => {
    expect(anyLineageLabel("claude-3-7-sonnet")).toBe("Claude Sonnet 3.7");
    expect(anyLineageLabel("claude-sonnet-5-5")).toBe("Claude Sonnet 5.5");
    expect(anyLineageLabel("gpt-5.6-luna")).toBe("GPT-5.6 Luna");
    expect(anyLineageLabel("grok-4.6")).toBe("Grok 4.6");
    expect(anyLineageLabel("MiniMax-M3")).toBeUndefined();
  });
});

describe("newest member and hiding", () => {
  it("picks the newest member a catalog offers", () => {
    expect(newestInClass("claudeAgent", "sonnet", CLAUDE_IDS)).toBe("claude-sonnet-5-5");
    expect(newestInClass("claudeAgent", "opus", CLAUDE_IDS)).toBe("claude-opus-5-5");
    expect(newestInClass("codex", "luna", CODEX_LIVE)).toBe("gpt-5.6-luna");
    expect(newestInClass("codex", "luna", ["gpt-6-luna", "gpt-5.6-luna"])).toBe("gpt-6-luna");
    expect(newestInClass("grokAgent", "grok", GROK_IDS)).toBe("grok-4.7");
  });

  it("never resolves onto a retired id", () => {
    expect(newestInClass("grokAgent", "grok", ["grok-4.6", "grok-4.5"])).toBeUndefined();
  });

  it("hides superseded and retired rows, keeps custom rows, and moves a hidden default", () => {
    const grok = presentCatalog("grokAgent", {
      default: "grok-4.6",
      options: [
        ...GROK_IDS.map((id) => ({ id, label: id })),
        { id: "omlx-grok-4.5", label: "local", custom: true },
      ],
    });
    expect(grok.options.map((o) => o.id)).toEqual(["grok-4.7", "grok-4.7-build-fast", "omlx-grok-4.5"]);
    expect(grok.default).toBe("grok-4.7");

    const claude = presentCatalog("claudeAgent", {
      default: "claude-sonnet-5-5",
      options: CLAUDE_IDS.map((id) => ({ id, label: id })),
    });
    expect(claude.options.map((o) => o.id)).toEqual([
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-4-5",
    ]);
  });

  it("returns the same catalog for engines with no lineage", () => {
    const catalog = { default: "MiniMax-M3", options: [{ id: "MiniMax-M3", label: "M3" }] };
    expect(presentCatalog("minimax", catalog)).toBe(catalog);
  });

  it("does not treat a dated twin as newer", () => {
    const droid = presentCatalog("droidAgent", {
      default: "claude-opus-5",
      options: ["claude-haiku-4-5-20251001", "claude-haiku-4-5", "grok-4.7", "grok-4.6"].map((id) => ({ id, label: id })),
    });
    expect(droid.options.map((o) => o.id)).toEqual(["claude-haiku-4-5-20251001", "claude-haiku-4-5", "grok-4.7"]);
  });

  it("offers one Latest choice per class the catalog carries", () => {
    const rows = latestOptions("claudeAgent", CLAUDE_IDS.map((id) => ({ id })));
    expect(rows.map((r) => [r.label, r.resolvedId])).toEqual([
      ["Latest Fable", "claude-fable-5-1"],
      ["Latest Opus", "claude-opus-5-5"],
      ["Latest Sonnet", "claude-sonnet-5-5"],
      ["Latest Haiku", "claude-haiku-4-5"],
    ]);
    expect(latestOptions("codex", CODEX_LIVE.map((id) => ({ id }))).map((r) => r.label)).toEqual([
      "Latest Astra",
      "Latest Sol",
      "Latest Terra",
      "Latest Luna",
    ]);
    expect(latestOptions("minimax", [{ id: "MiniMax-M3" }])).toEqual([]);
  });
});

describe("25% price band", () => {
  it("moves Sonnet 5 to 5.5 (same price) and Opus 5 to 5.5 (20% cheaper)", () => {
    expect(withinPriceBand("claudeAgent", "claude-sonnet-5", "claude-sonnet-5-5")).toBe(true);
    expect(withinPriceBand("claudeAgent", "claude-opus-5", "claude-opus-5-5")).toBe(true);
  });

  it("refuses a move just past 25% when both prices are known", () => {
    // Sonnet 4.6 blends at $6, Sonnet 5.5 at $4: a 33% change.
    expect(withinPriceBand("claudeAgent", "claude-sonnet-4-6", "claude-sonnet-5-5")).toBe(false);
  });

  it("lets the class decide on a subscription engine with no prices, and not on an API engine", () => {
    expect(withinPriceBand("codex", "gpt-5.6-luna", "gpt-6-luna")).toBe(true);
    expect(withinPriceBand("grok", "grok-4.7", "grok-4.8")).toBe(false);
    expect(withinPriceBand("grokAgent", "grok-4.7", "grok-4.8")).toBe(true);
  });

  it("prices the API-key Grok engine from the repo's xAI list prices", () => {
    expect(modelPrice("grok", "grok-4.7")).toEqual({ input: 2, output: 6 });
    expect(withinPriceBand("grok", "grok-4.6", "grok-4.7")).toBe(true);
  });

  it("puts a change of exactly 25% inside the band, either way, and anything past it outside", () => {
    // Blended at 3:1 input:output, so equal input and output prices blend to
    // themselves: $4 -> $5 is +25%, $4 -> $3 is -25%.
    const base = { input: 4, output: 4 };
    expect(pricesWithinBand(base, { input: 5, output: 5 })).toBe(true);
    expect(pricesWithinBand(base, { input: 3, output: 3 })).toBe(true);
    expect(pricesWithinBand(base, { input: 5.01, output: 5.01 })).toBe(false);
    expect(pricesWithinBand(base, { input: 2.99, output: 2.99 })).toBe(false);
    expect(pricesWithinBand({ input: 0, output: 0 }, base)).toBe(false);
  });
});

describe("reconcileEntry", () => {
  it("resolves a Latest selection against a live catalog and records the real slug", () => {
    const entry = { instanceId: "codex", model: "gpt-5.6-luna", latest: "luna" };
    const live = reconcileEntry(entry, ctx("codex", ["gpt-6-luna", "gpt-5.6-luna"]));
    expect(live.entry).toEqual({ instanceId: "codex", model: "gpt-6-luna", latest: "luna" });
    expect(live.change).toMatchObject({ from: "gpt-5.6-luna", to: "gpt-6-luna", reason: "latest" });
  });

  it("does not resolve against a static fallback catalog", () => {
    const entry = { instanceId: "codex", model: "gpt-5.6-luna", latest: "luna" };
    const staticFallback = reconcileEntry(entry, ctx("codex", ["gpt-6-luna"], false));
    expect(staticFallback.entry).toBe(entry);
    expect(staticFallback.change).toBeUndefined();
  });

  it("keeps the model when the class has no member in the catalog", () => {
    const entry = { instanceId: "codex", model: "gpt-5.6-luna", latest: "luna" };
    expect(reconcileEntry(entry, ctx("codex", ["gpt-5.5"])).entry).toEqual(entry);
  });

  it("drops a Latest flag when the model was explicitly moved to another class", () => {
    const entry = { instanceId: "claude", model: "claude-opus-5-5", latest: "sonnet" };
    expect(reconcileEntry(entry, ctx("claudeAgent", CLAUDE_IDS)).entry).toEqual({
      instanceId: "claude",
      model: "claude-opus-5-5",
    });
  });

  it("drops a Latest flag the engine does not know", () => {
    const entry = { instanceId: "minimax", model: "MiniMax-M3", latest: "sonnet" };
    expect(reconcileEntry(entry, ctx("minimax", ["MiniMax-M3"])).entry).toEqual({
      instanceId: "minimax",
      model: "MiniMax-M3",
    });
  });

  it("floats a retired id on its successor class", () => {
    const result = reconcileEntry({ instanceId: "claude", model: "claude-3-7-sonnet" }, ctx("claudeAgent", CLAUDE_IDS));
    expect(result.entry).toEqual({ instanceId: "claude", model: "claude-sonnet-5-5", latest: "sonnet" });
    expect(result.change?.reason).toBe("retired");

    const grok = reconcileEntry({ instanceId: "grok", model: "grok-4.6", effort: "high" }, ctx("grokAgent", GROK_IDS));
    expect(grok.entry).toEqual({ instanceId: "grok", model: "grok-4.7", effort: "high", latest: "grok" });
  });

  it("leaves a retired id with no successor for the caller to refuse", () => {
    const entry = { instanceId: "grokApi", model: "grok-3-mini" };
    expect(reconcileEntry(entry, ctx("grok", ["grok-4.7"])).entry).toBe(entry);
    expect(retiredModel("grok", "grok-3-mini")).toEqual({ successorClass: null });
  });

  it("moves a pinned superseded id inside the price band and keeps it pinned", () => {
    const result = reconcileEntry({ instanceId: "claude", model: "claude-opus-5" }, ctx("claudeAgent", CLAUDE_IDS));
    expect(result.entry).toEqual({ instanceId: "claude", model: "claude-opus-5-5" });
    expect(result.change?.reason).toBe("superseded");
  });

  it("does not move a pinned id past the price band", () => {
    const entry = { instanceId: "claude", model: "claude-sonnet-4-6" };
    expect(reconcileEntry(entry, ctx("claudeAgent", CLAUDE_IDS)).entry).toBe(entry);
  });

  it("drops an effort the new model does not accept", () => {
    const result = reconcileEntry(
      { instanceId: "claude", model: "claude-opus-5", effort: "max" },
      { ...ctx("claudeAgent", CLAUDE_IDS), effortLevels: () => ["low", "medium", "high"] },
    );
    expect(result.entry).toEqual({ instanceId: "claude", model: "claude-opus-5-5" });
  });
});

describe("reconcileChain", () => {
  const contexts: Record<string, LineageContext> = {
    claude: ctx("claudeAgent", CLAUDE_IDS),
    codex: ctx("codex", CODEX_LIVE),
    grok: ctx("grokAgent", GROK_IDS),
  };
  const contextFor = (id: string) => contexts[id];

  it("rewrites the primary and every fallback, and is idempotent", () => {
    const deployer: LineageSelection = {
      instanceId: "dsh",
      model: "DeepSeek-V4.1-Flash",
      fallbacks: [
        { instanceId: "claude", model: "claude-3-7-sonnet" },
        { instanceId: "codex", model: "gpt-5.6-luna" },
        { instanceId: "grok", model: "grok-4.5" },
      ],
    };
    const first = reconcileChain(deployer, contextFor);
    expect(first.selection).toEqual({
      instanceId: "dsh",
      model: "DeepSeek-V4.1-Flash",
      fallbacks: [
        { instanceId: "claude", model: "claude-sonnet-5-5", latest: "sonnet" },
        { instanceId: "codex", model: "gpt-5.6-luna" },
        { instanceId: "grok", model: "grok-4.7", latest: "grok" },
      ],
    });
    expect(first.changes.map((c) => c.slot)).toEqual(["fallback 1", "fallback 3"]);
    const second = reconcileChain(first.selection, contextFor);
    expect(second.changes).toEqual([]);
    expect(second.selection).toEqual(first.selection);
  });

  it("drops a fallback the pass made identical to the primary", () => {
    const result = reconcileChain(
      {
        instanceId: "claude",
        model: "claude-sonnet-5-5",
        fallbacks: [{ instanceId: "claude", model: "claude-sonnet-5" }, { instanceId: "codex", model: "gpt-5.5" }],
      },
      contextFor,
    );
    expect(result.selection.fallbacks).toEqual([{ instanceId: "codex", model: "gpt-5.5" }]);
    expect(result.changes.at(-1)).toMatchObject({ slot: "fallback 1", to: "" });
  });

  it("keeps a placeholder fallback that already matched the primary", () => {
    const result = reconcileChain(
      {
        instanceId: "claude",
        model: "claude-sonnet-5",
        fallbacks: [{ instanceId: "claude", model: "claude-sonnet-5" }],
      },
      contextFor,
    );
    expect(result.selection).toEqual({
      instanceId: "claude",
      model: "claude-sonnet-5-5",
      fallbacks: [{ instanceId: "claude", model: "claude-sonnet-5-5" }],
    });
  });

  it("leaves unknown instances and engines without lineage untouched", () => {
    const selection = { instanceId: "minimax", model: "MiniMax-M3", fallbacks: [{ instanceId: "gone", model: "x" }] };
    expect(reconcileChain(selection, contextFor)).toEqual({ selection, changes: [] });
  });
});

describe("applyOwnerDirective", () => {
  it("floats every Sonnet and every Luna, and nothing else", () => {
    const kinds: Record<string, string> = { claude: "claudeAgent", codex: "codex", grok: "grokAgent" };
    const { selection, flagged } = applyOwnerDirective(
      {
        instanceId: "claude",
        model: "claude-sonnet-5",
        fallbacks: [
          { instanceId: "codex", model: "gpt-5.6-luna" },
          { instanceId: "claude", model: "claude-opus-5" },
          { instanceId: "grok", model: "grok-4.7" },
        ],
      },
      (id) => kinds[id],
    );
    expect(selection).toEqual({
      instanceId: "claude",
      model: "claude-sonnet-5",
      latest: "sonnet",
      fallbacks: [
        { instanceId: "codex", model: "gpt-5.6-luna", latest: "luna" },
        { instanceId: "claude", model: "claude-opus-5" },
        { instanceId: "grok", model: "grok-4.7" },
      ],
    });
    expect(flagged.map((f) => f.slot)).toEqual(["primary", "fallback 1"]);
  });
});

describe("lineageStatus", () => {
  const claude = presentCatalog("claudeAgent", {
    default: "claude-sonnet-5-5",
    options: CLAUDE_IDS.map((id) => ({ id, label: id })),
  }).options;

  it("marks explicitly retired ids and names the successor", () => {
    expect(lineageStatus("claudeAgent", "claude-3-7-sonnet", claude, false)).toEqual({
      kind: "retired",
      successor: { model: "claude-sonnet-5-5", latest: "sonnet" },
    });
    expect(lineageStatus("grok", "grok-3-mini", [{ id: "grok-4.7" }], true)).toEqual({ kind: "retired" });
  });

  it("marks an older class member superseded", () => {
    expect(lineageStatus("claudeAgent", "claude-sonnet-5", claude, false)).toEqual({
      kind: "superseded",
      successor: { model: "claude-sonnet-5-5", latest: "sonnet" },
    });
  });

  it("reports not-in-catalog only for a live catalog", () => {
    const codex = CODEX_LIVE.map((id) => ({ id }));
    expect(lineageStatus("codex", "gpt-4o", codex, true)).toEqual({ kind: "not-in-catalog" });
    expect(lineageStatus("codex", "gpt-4o", codex, false)).toEqual({ kind: "ok" });
    expect(lineageStatus("codex", "omlx::qwen", codex, true)).toEqual({ kind: "ok" });
    expect(lineageStatus("codex", "gpt-5.6-luna", codex, true)).toEqual({ kind: "ok" });
  });

  it("offers the class the live catalog does have for a member it does not list", () => {
    const codex = CODEX_LIVE.map((id) => ({ id }));
    expect(lineageStatus("codex", "gpt-6-luna", codex, true)).toEqual({
      kind: "not-in-catalog",
      successor: { model: "gpt-5.6-luna", latest: "luna" },
    });
    expect(lineageStatus("codex", "gpt-6-luna", codex, false)).toEqual({ kind: "ok" });
  });
});
