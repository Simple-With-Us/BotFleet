import { describe, expect, it } from "vitest";

import type { ModelSelection } from "./contracts.ts";
import { STATIC_CODEX_MODELS } from "./drivers/codex-catalog.ts";
import {
  catalogIsAuthoritative,
  catalogIsLive,
  checkLineageWrite,
  claudeModelsTooNewFor,
  gateLineageByCliVersion,
  lineageContextFor,
  matchesStaticFallback,
  parseCliVersion,
  presentDescribedInstances,
  reconcileTurnOverride,
  taskWriteBaseline,
} from "./model-lineage.ts";
import { STATIC_CLAUDE_MODELS } from "./claude-models.ts";
import { STATIC_GROK_MODELS } from "./drivers/acp/grok.ts";
import { reconcileEntry, type LineageContext } from "../shared/model-lineage.ts";
import { fallbackCountAllowed, MAX_MODEL_FALLBACKS } from "../shared/model-limits.ts";

const CODEX_LIVE = {
  default: "gpt-5.6-luna",
  options: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"].map((id) => ({ id, label: id })),
};

interface FixtureInstance {
  driverKind: string;
  models: { default: string; options: Array<{ id: string; label: string; custom?: boolean }> };
}

// A Codex account whose live catalog already lists GPT-6 Luna beside the
// GPT-5.6 Luna a client may still be holding.
const CODEX_LIVE_NEWER = {
  default: "gpt-6-luna",
  options: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-luna", "gpt-5.6-luna"].map((id) => ({ id, label: id })),
};

const instances: Record<string, FixtureInstance> = {
  claude: { driverKind: "claudeAgent", models: STATIC_CLAUDE_MODELS },
  codex: { driverKind: "codex", models: CODEX_LIVE },
  codexNewer: { driverKind: "codex", models: CODEX_LIVE_NEWER },
  grok: { driverKind: "grokAgent", models: STATIC_GROK_MODELS },
  grokApi: { driverKind: "grok", models: { default: "grok-4.7", options: [{ id: "grok-4.7", label: "Grok 4.7" }] } },
  // A Claude engine whose operator added a custom row under an id that reads
  // like an official, newer Sonnet (a proxy that serves its own "sonnet-6").
  claudeCustom: {
    driverKind: "claudeAgent",
    models: {
      default: STATIC_CLAUDE_MODELS.default,
      options: [...STATIC_CLAUDE_MODELS.options, { id: "claude-sonnet-6", label: "Proxy Sonnet 6", custom: true }],
    },
  },
  // A Grok CLI whose config.toml adds its own row under a retired id.
  grokCustom: {
    driverKind: "grokAgent",
    models: {
      default: "grok-4.7",
      options: [
        { id: "grok-4.7", label: "Grok 4.7" },
        { id: "grok-3-mini", label: "My Mini", custom: true },
      ],
    },
  },
  minimax: { driverKind: "minimax", models: { default: "MiniMax-M3", options: [{ id: "MiniMax-M3", label: "MiniMax M3" }] } },
};

const contextFor = (id: string): LineageContext | undefined => lineageContextFor(instances[id]);

describe("catalog authority", () => {
  it("treats the Codex static fallback as non-authoritative and a live listing as live", () => {
    expect(catalogIsAuthoritative("codex", STATIC_CODEX_MODELS)).toBe(false);
    expect(catalogIsAuthoritative("codex", CODEX_LIVE)).toBe(true);
    expect(catalogIsLive("codex", CODEX_LIVE)).toBe(true);
    expect(catalogIsLive("codex", STATIC_CODEX_MODELS)).toBe(false);
  });

  it("ignores local rows when deciding whether Codex is on its fallback", () => {
    const withLocal = { ...STATIC_CODEX_MODELS, options: [...STATIC_CODEX_MODELS.options, { id: "omlx::qwen", label: "q", custom: true }] };
    expect(catalogIsAuthoritative("codex", withLocal)).toBe(false);
  });

  it("tells a marked static fallback from a live listing that names the same ids", () => {
    // Once the fallback is kept in step with what Codex serves, its ids and
    // the live ids are the same set; only the fallback's row badge differs.
    const ids = CODEX_LIVE.options.map((option) => option.id);
    const marked = {
      default: "gpt-5.6-luna",
      options: ids.map((id) => ({ id, label: id, badge: "Unverified" })),
    };
    expect(matchesStaticFallback(marked, marked)).toBe(true);
    expect(matchesStaticFallback(CODEX_LIVE, marked)).toBe(false);
    expect(
      matchesStaticFallback(
        { ...marked, options: [...marked.options, { id: "omlx::qwen", label: "q", custom: true }] },
        marked,
      ),
    ).toBe(true);
    // An unmarked fallback is recognised by its ids alone.
    const unmarked = { default: "gpt-5.6-luna", options: ids.map((id) => ({ id, label: id })) };
    expect(matchesStaticFallback(CODEX_LIVE, unmarked)).toBe(true);
    expect(matchesStaticFallback({ ...CODEX_LIVE, options: CODEX_LIVE.options.slice(1) }, unmarked)).toBe(false);
  });

  it("treats the Claude static list as authoritative but not live", () => {
    expect(catalogIsAuthoritative("claudeAgent", STATIC_CLAUDE_MODELS)).toBe(true);
    expect(catalogIsLive("claudeAgent", STATIC_CLAUDE_MODELS)).toBe(false);
  });
});

describe("presentDescribedInstances", () => {
  it("hides Grok 4.5 and 4.6 and superseded Claude rows, and marks live catalogs", () => {
    const described: Array<FixtureInstance & { instanceId: string }> = ["grok", "claude", "codex", "minimax"].map(
      (instanceId) => ({ instanceId, ...instances[instanceId]! }),
    );
    const minimax = described[3];
    const presented = presentDescribedInstances(described);
    // Grok Build 0.1 and Composer 2.5 sit in no Grok class, so the lineage
    // leaves them as listed; only the retired 4.5 and 4.6 rows disappear.
    expect(presented[0]!.models.options.map((o) => o.id)).toEqual([
      "grok-4.7",
      "grok-4.7-build-fast",
      "composer-2.5",
      "grok-build-0.1",
    ]);
    expect(presented[1]!.models.options.map((o) => o.id)).toEqual([
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-4-5",
    ]);
    expect(presented[1]!.models.default).toBe("claude-sonnet-5-5");
    expect((presented[2]!.models as { live?: boolean }).live).toBe(true);
    // An engine with no lineage comes back as the same object.
    expect(presented[3]).toBe(minimax);
  });
});

describe("Claude CLI version gate", () => {
  const claude = lineageContextFor(instances.claude)!;
  const optionIds = (models: { options: Array<{ id: string }> }) => models.options.map((option) => option.id);

  it("reads the version the CLI prints", () => {
    expect(parseCliVersion("2.1.284 (Claude Code)")).toEqual([2, 1, 284]);
    expect(parseCliVersion(null)).toBeUndefined();
    expect(parseCliVersion("claude")).toBeUndefined();
  });

  it("names the models an older CLI's own catalog does not list yet", () => {
    expect([...claudeModelsTooNewFor("2.1.232 (Claude Code)")]).toEqual(["claude-opus-5-5"]);
    expect([...claudeModelsTooNewFor("2.1.279")]).toEqual(["claude-opus-5-5"]);
    expect(claudeModelsTooNewFor("2.1.280").size).toBe(0);
    expect(claudeModelsTooNewFor("3.0.0").size).toBe(0);
    expect(claudeModelsTooNewFor(undefined).size).toBe(0);
  });

  it("moves nothing on a Claude engine until its CLI has reported a version", () => {
    expect(gateLineageByCliVersion(claude, undefined)?.authoritative).toBe(false);
    const pinned = { instanceId: "claude", model: "claude-opus-5" };
    expect(reconcileEntry(pinned, gateLineageByCliVersion(claude, null)).entry).toBe(pinned);
  });

  it("keeps a pinned Opus 5 on Opus 5 for a CLI too old for Opus 5.5, and moves it on a new one", () => {
    const pinned = { instanceId: "claude", model: "claude-opus-5" };
    const old = gateLineageByCliVersion(claude, "2.1.232 (Claude Code)")!;
    expect(old.offeredIds).not.toContain("claude-opus-5-5");
    expect(old.offeredIds).toContain("claude-sonnet-5-5");
    expect(reconcileEntry(pinned, old).entry).toBe(pinned);
    // Latest Opus resolves to what that CLI can run.
    expect(reconcileEntry({ ...pinned, latest: "opus" }, old).entry.model).toBe("claude-opus-5");
    expect(reconcileEntry(pinned, gateLineageByCliVersion(claude, "2.1.284 (Claude Code)")).entry.model).toBe("claude-opus-5-5");
  });

  it("leaves other engines alone", () => {
    const codex = lineageContextFor(instances.codex)!;
    expect(gateLineageByCliVersion(codex, undefined)).toBe(codex);
  });

  it("offers Opus 5 instead of Opus 5.5 in the picker for an older CLI", () => {
    const [old] = presentDescribedInstances([{ ...instances.claude, snapshot: { version: "2.1.232 (Claude Code)" } }]);
    expect(optionIds(old!.models)).toEqual(expect.arrayContaining(["claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"]));
    expect(optionIds(old!.models)).not.toContain("claude-opus-5-5");
    expect(old!.models.default).toBe("claude-sonnet-5-5");
    const [current] = presentDescribedInstances([{ ...instances.claude, snapshot: { version: "2.1.284 (Claude Code)" } }]);
    expect(optionIds(current!.models)).toContain("claude-opus-5-5");
    expect(optionIds(current!.models)).not.toContain("claude-opus-5");
  });
});

describe("reconcileTurnOverride", () => {
  it("resolves a floating override and asks for a fresh Codex session only when the model moved", () => {
    const codexNewer = lineageContextFor({
      driverKind: "codex",
      models: { ...CODEX_LIVE, options: [...CODEX_LIVE.options, { id: "gpt-6-luna", label: "GPT-6 Luna" }] },
    });
    expect(reconcileTurnOverride({ instanceId: "codex", model: "gpt-5.6-luna", latest: "luna" }, codexNewer)).toEqual({
      selection: { instanceId: "codex", model: "gpt-6-luna", latest: "luna" },
      freshSession: true,
    });
    expect(reconcileTurnOverride({ instanceId: "codex", model: "gpt-6-luna", latest: "luna" }, codexNewer).freshSession).toBe(false);
    // A pinned override with no newer member in the band stays as it is.
    expect(reconcileTurnOverride({ instanceId: "codex", model: "gpt-5.6-luna" }, contextFor("codex"))).toEqual({
      selection: { instanceId: "codex", model: "gpt-5.6-luna" },
      freshSession: false,
    });
  });

  it("never asks for a fresh session on an engine that applies the model on resume", () => {
    const moved = reconcileTurnOverride({ instanceId: "claude", model: "claude-sonnet-5", latest: "sonnet" }, contextFor("claude"));
    expect(moved.selection.model).toBe("claude-sonnet-5-5");
    expect(moved.freshSession).toBe(false);
  });
});

describe("checkLineageWrite", () => {
  const write = (selection: ModelSelection, current?: ModelSelection, raw: unknown = selection) =>
    checkLineageWrite(selection, raw, current, contextFor);

  it("rewrites retired ids on write and floats them on their successor class", () => {
    const result = write({
      instanceId: "dsh",
      model: "DeepSeek-V4.1-Flash",
      fallbacks: [
        { instanceId: "claude", model: "claude-3-7-sonnet" },
        { instanceId: "grok", model: "grok-4.6" },
      ],
    });
    expect(result).toMatchObject({
      ok: true,
      selection: {
        fallbacks: [
          { instanceId: "claude", model: "claude-sonnet-5-5", latest: "sonnet" },
          { instanceId: "grok", model: "grok-4.7", latest: "grok" },
        ],
      },
    });
  });

  it("resolves a Latest pick to the slug it will run", () => {
    const result = write({ instanceId: "claude", model: "claude-sonnet-5", latest: "sonnet" });
    expect(result).toMatchObject({ ok: true, selection: { model: "claude-sonnet-5-5", latest: "sonnet" } });
  });

  it("refuses a newly introduced retired id with no successor and names the slot", () => {
    const result = write({
      instanceId: "claude",
      model: "claude-sonnet-5-5",
      fallbacks: [{ instanceId: "codex", model: "gpt-5.5" }, { instanceId: "grokApi", model: "grok-3-mini" }],
    });
    expect(result).toEqual({ ok: false, error: 'retired model "grok-3-mini" in fallback 2 — choose another model' });
  });

  it("accepts a retired-looking id that the engine's catalog lists as the operator's own custom row", () => {
    const custom: ModelSelection = {
      instanceId: "claude",
      model: "claude-sonnet-5-5",
      fallbacks: [{ instanceId: "grokCustom", model: "grok-3-mini" }],
    };
    const result = write(custom);
    expect(result).toMatchObject({ ok: true, selection: { fallbacks: [{ instanceId: "grokCustom", model: "grok-3-mini" }] } });
    expect(result.ok && result.selection.fallbacks?.[0]?.latest).toBeFalsy();
    // The same id on an engine that does not list it is still refused.
    expect(write({ ...custom, fallbacks: [{ instanceId: "grok", model: "grok-3-mini" }] })).toEqual({
      ok: false,
      error: 'retired model "grok-3-mini" in fallback 1 — choose another model',
    });
  });

  it("lets a saved retired leftover through so another slot can still be edited", () => {
    const saved: ModelSelection = {
      instanceId: "claude",
      model: "claude-sonnet-5-5",
      fallbacks: [{ instanceId: "grokApi", model: "grok-3-mini" }],
    };
    const edited: ModelSelection = { ...saved, model: "claude-opus-5-5" };
    expect(write(edited, saved).ok).toBe(true);
  });

  it("lets one saved dead target cover one slot only, not a duplicate added by the write", () => {
    const saved: ModelSelection = {
      instanceId: "claude",
      model: "claude-sonnet-5-5",
      fallbacks: [{ instanceId: "grokApi", model: "grok-3-mini" }],
    };
    const duplicated: ModelSelection = {
      ...saved,
      fallbacks: [{ instanceId: "grokApi", model: "grok-3-mini" }, { instanceId: "grokApi", model: "grok-3-mini" }],
    };
    expect(write(duplicated, saved)).toEqual({
      ok: false,
      error: 'retired model "grok-3-mini" in fallback 2 — choose another model',
    });
    // Two saved copies still grandfather two.
    const savedTwice: ModelSelection = { ...saved, fallbacks: duplicated.fallbacks };
    expect(write({ ...savedTwice, model: "claude-opus-5-5" }, savedTwice).ok).toBe(true);
  });

  it("leaves an operator's custom id alone even when it reads like a retired or superseded official one", () => {
    const grok = lineageContextFor({
      driverKind: "grokAgent",
      models: {
        default: "grok-4.7",
        options: [
          { id: "grok-4.7", label: "Grok 4.7" },
          { id: "grok-4.6", label: "My Grok", custom: true },
        ],
      },
    });
    const result = checkLineageWrite(
      { instanceId: "g", model: "grok-4.6" },
      { instanceId: "g", model: "grok-4.6" },
      undefined,
      () => grok,
    );
    expect(result).toMatchObject({ ok: true, selection: { model: "grok-4.6" } });
    expect((result as { changes: unknown[] }).changes).toEqual([]);
  });

  it("passes custom and local ids no catalog lists", () => {
    const result = write({ instanceId: "codex", model: "omlx::qwen3-coder", fallbacks: [{ instanceId: "claude", model: "my-proxy-model" }] });
    expect(result).toMatchObject({ ok: true, selection: { model: "omlx::qwen3-coder", fallbacks: [{ model: "my-proxy-model" }] } });
  });

  it("carries Latest forward when a client that predates it re-sends the same model", () => {
    const saved: ModelSelection = {
      instanceId: "claude",
      model: "claude-sonnet-5-5",
      latest: "sonnet",
      fallbacks: [{ instanceId: "codex", model: "gpt-5.6-luna", latest: "luna" }],
    };
    // What the shipped iOS app sends after an effort-only edit.
    const ios = {
      instanceId: "claude",
      model: "claude-sonnet-5-5",
      effort: "high",
      fallbacks: [{ instanceId: "codex", model: "gpt-5.6-luna" }],
    } as ModelSelection;
    const result = write(ios, saved, JSON.parse(JSON.stringify(ios)));
    expect(result).toMatchObject({
      ok: true,
      selection: { latest: "sonnet", effort: "high", fallbacks: [{ latest: "luna" }] },
    });
  });

  it("keeps a float when an older client removes the fallback in front of it", () => {
    // The shipped iOS app removes a fallback by index and re-sends the rest
    // without `latest`, so the floating Fallback 2 arrives as Fallback 1.
    const saved: ModelSelection = {
      instanceId: "claude",
      model: "claude-opus-5-5",
      fallbacks: [
        { instanceId: "codex", model: "gpt-5.6-luna" },
        { instanceId: "claude", model: "claude-sonnet-5-5", latest: "sonnet" },
      ],
    };
    const ios: ModelSelection = { instanceId: "claude", model: "claude-opus-5-5", fallbacks: [{ instanceId: "claude", model: "claude-sonnet-5-5" }] };
    const result = write(ios, saved, JSON.parse(JSON.stringify(ios)));
    expect(result).toMatchObject({ ok: true, selection: { fallbacks: [{ model: "claude-sonnet-5-5", latest: "sonnet" }] } });
    expect(result.ok && result.selection.latest).toBeUndefined();
  });

  it("never hands a pinned entry the float of another place that names the same model", () => {
    // Primary pinned on Sonnet 5.5, Fallback 1 floating on the same slug
    // (the settings UI seeds a new fallback from the primary).  Each keeps
    // its own answer when an older client re-sends the chain unchanged.
    const saved: ModelSelection = {
      instanceId: "claude",
      model: "claude-sonnet-5-5",
      fallbacks: [{ instanceId: "claude", model: "claude-sonnet-5-5", latest: "sonnet" }],
    };
    const ios: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5-5", fallbacks: [{ instanceId: "claude", model: "claude-sonnet-5-5" }] };
    const result = write(ios, saved, JSON.parse(JSON.stringify(ios)));
    expect(result.ok && result.selection.latest).toBeUndefined();
    expect(result.ok && result.selection.fallbacks?.[0]?.latest).toBe("sonnet");
  });

  it("does not float an entry the older client moved onto a different model", () => {
    const saved: ModelSelection = {
      instanceId: "claude",
      model: "claude-opus-5-5",
      fallbacks: [{ instanceId: "claude", model: "claude-sonnet-5-5", latest: "sonnet" }],
    };
    const ios: ModelSelection = { instanceId: "claude", model: "claude-opus-5-5", fallbacks: [{ instanceId: "claude", model: "claude-haiku-4-5" }] };
    const result = write(ios, saved, JSON.parse(JSON.stringify(ios)));
    expect(result.ok && result.selection.fallbacks?.[0]).toEqual({ instanceId: "claude", model: "claude-haiku-4-5" });
  });

  it("refuses a Latest class the engine does not have, naming the slot and the classes it does", () => {
    const typo = write({ instanceId: "claude", model: "claude-sonnet-5-5", latest: "sonnett" });
    expect(typo.ok).toBe(false);
    expect(!typo.ok && typo.error).toMatch(/^modelSelection\.latest "sonnett" in primary is not a model class on instance "claude"/);
    expect(!typo.ok && typo.error).toMatch(/sonnet/);

    const inFallback = write({
      instanceId: "claude",
      model: "claude-sonnet-5-5",
      fallbacks: [{ instanceId: "codex", model: "gpt-5.6-luna", latest: "sonnet" }],
    });
    expect(inFallback.ok).toBe(false);
    expect(!inFallback.ok && inFallback.error).toMatch(/in fallback 1 is not a model class on instance "codex"/);

    // An engine with no Latest classes at all never floats anything.
    const none = write({ instanceId: "minimax", model: "MiniMax-M3", latest: "sonnet" });
    expect(none).toMatchObject({ ok: false });
    expect(!none.ok && none.error).toMatch(/no Latest classes/);
  });

  it("refuses a Latest class the model does not belong to", () => {
    const result = write({ instanceId: "claude", model: "claude-opus-5-5", latest: "sonnet" });
    expect(result).toEqual({
      ok: false,
      error: 'modelSelection.latest "sonnet" in primary does not match model "claude-opus-5-5"',
    });
    // The class of the model on a different engine does not carry over.
    expect(write({ instanceId: "codex", model: "gpt-5.6-luna", latest: "sonnet" }).ok).toBe(false);
  });

  it("accepts a Latest that fits: a member of the class, a retired id on its successor, a saved leftover", () => {
    expect(write({ instanceId: "claude", model: "claude-sonnet-5", latest: "sonnet" }).ok).toBe(true);
    expect(write({ instanceId: "claude", model: "claude-3-7-sonnet", latest: "sonnet" }).ok).toBe(true);
    expect(write({ instanceId: "codex", model: "gpt-5.6-luna", latest: "luna" }).ok).toBe(true);
    // A saved entry the write merely re-sends is not judged again, so a
    // leftover cannot block editing another slot.
    const leftover: ModelSelection = { instanceId: "claude", model: "claude-opus-5-5", latest: "sonnet" };
    expect(write({ ...leftover, effort: "high" }, leftover).ok).toBe(true);
    // An engine the harness does not know has nothing to check against.
    expect(write({ instanceId: "ghost", model: "whatever", latest: "sonnett" }).ok).toBe(true);
  });

  describe("a custom catalog row never floats", () => {
    it("refuses latest on a custom row that reads like an official class member, naming the slot", () => {
      const primary = write({ instanceId: "claudeCustom", model: "claude-sonnet-6", latest: "sonnet" });
      expect(primary).toEqual({
        ok: false,
        error:
          'modelSelection.latest "sonnet" in primary cannot apply to custom model "claude-sonnet-6" on instance "claudeCustom" ' +
          "(a custom catalog row stays pinned — drop the latest field)",
      });
      const inFallback = write({
        instanceId: "claude",
        model: "claude-sonnet-5-5",
        fallbacks: [{ instanceId: "claudeCustom", model: "claude-sonnet-6", latest: "sonnet" }],
      });
      expect(inFallback.ok).toBe(false);
      expect(!inFallback.ok && inFallback.error).toMatch(/in fallback 1 cannot apply to custom model "claude-sonnet-6"/);
      // A custom row reading like a retired id (the Grok CLI's own row) is no exception.
      expect(write({ instanceId: "grokCustom", model: "grok-3-mini", latest: "grok" }).ok).toBe(false);
    });

    it("still saves the custom row pinned, whether latest is absent or null", () => {
      expect(write({ instanceId: "claudeCustom", model: "claude-sonnet-6" })).toMatchObject({
        ok: true,
        selection: { instanceId: "claudeCustom", model: "claude-sonnet-6" },
      });
      const nulled = write({ instanceId: "claudeCustom", model: "claude-sonnet-6" }, undefined, {
        instanceId: "claudeCustom",
        model: "claude-sonnet-6",
        latest: null,
      });
      expect(nulled.ok).toBe(true);
      expect(nulled.ok && nulled.selection.latest).toBeUndefined();
    });

    it("lets an entry the saved chain already holds through, so a leftover cannot block editing another slot", () => {
      const leftover: ModelSelection = { instanceId: "claudeCustom", model: "claude-sonnet-6", latest: "sonnet" };
      expect(write({ ...leftover, effort: "high" }, leftover).ok).toBe(true);
      // Only that exact entry: the same custom id with a different class is a new float.
      expect(write({ ...leftover, latest: "opus" }, leftover).ok).toBe(false);
    });

    it("keeps the official id floating: the same model on an engine with no such custom row is accepted", () => {
      expect(write({ instanceId: "claude", model: "claude-sonnet-5-5", latest: "sonnet" }).ok).toBe(true);
    });
  });

  describe("a stale write of a model the float has since moved past", () => {
    const resolved: ModelSelection = {
      instanceId: "codexNewer",
      model: "gpt-6-luna",
      latest: "luna",
      fallbacks: [{ instanceId: "claude", model: "claude-sonnet-5-5", latest: "sonnet" }],
    };
    const staleWrite = (ios: ModelSelection, saved: ModelSelection = resolved) =>
      write(ios, saved, JSON.parse(JSON.stringify(ios)));

    it("keeps Latest Luna when the shipped iOS app writes back the GPT-5.6 Luna it read", () => {
      const result = staleWrite({
        instanceId: "codexNewer",
        model: "gpt-5.6-luna",
        effort: "high",
        fallbacks: [{ instanceId: "claude", model: "claude-sonnet-5-5" }],
      });
      expect(result).toMatchObject({
        ok: true,
        selection: {
          instanceId: "codexNewer",
          model: "gpt-6-luna",
          latest: "luna",
          fallbacks: [{ model: "claude-sonnet-5-5", latest: "sonnet" }],
        },
      });
      // Nothing moved relative to what is saved, so the busy gate sees no edit.
      expect(result.ok && result.selection.model).toBe(result.ok && result.current?.model);
    });

    it("works the same in a fallback slot and for a Claude float", () => {
      const saved: ModelSelection = {
        instanceId: "claude",
        model: "claude-opus-5-5",
        fallbacks: [{ instanceId: "claude", model: "claude-sonnet-5-5", latest: "sonnet" }],
      };
      const result = staleWrite(
        { instanceId: "claude", model: "claude-opus-5-5", fallbacks: [{ instanceId: "claude", model: "claude-sonnet-5" }] },
        saved,
      );
      expect(result.ok && result.selection.fallbacks?.[0]).toEqual({
        instanceId: "claude",
        model: "claude-sonnet-5-5",
        latest: "sonnet",
      });
      expect(result.ok && result.selection.latest).toBeUndefined();
    });

    it("pins when the write says so, or when the entry is not an older member of the saved class", () => {
      // the picker's explicit pin
      const pin: ModelSelection = { instanceId: "codexNewer", model: "gpt-5.6-luna" };
      const explicit = write(pin, resolved, { instanceId: "codexNewer", model: "gpt-5.6-luna", latest: null });
      expect(explicit.ok && explicit.selection.latest).toBeUndefined();
      // another class on the same engine
      const sol = staleWrite({ instanceId: "codexNewer", model: "gpt-5.6-sol" });
      expect(sol.ok && sol.selection.latest).toBeUndefined();
      // another engine
      const otherEngine = staleWrite({ instanceId: "codex", model: "gpt-5.6-luna" });
      expect(otherEngine.ok && otherEngine.selection.latest).toBeUndefined();
      // the saved entry is pinned, so there is no float to carry
      const pinned = staleWrite({ instanceId: "codexNewer", model: "gpt-5.6-luna" }, { instanceId: "codexNewer", model: "gpt-6-luna" });
      expect(pinned.ok && pinned.selection.latest).toBeUndefined();
      // an older saved float is not "newer" than what the client sent
      const older = staleWrite(
        { instanceId: "codexNewer", model: "gpt-6-luna" },
        { instanceId: "codexNewer", model: "gpt-5.6-luna", latest: "luna" },
      );
      expect(older.ok && older.selection.model).toBe("gpt-6-luna");
    });

    it("never takes a float from an exact match, and each saved float is used once", () => {
      // Fallback 1 floats and has resolved forward to GPT-6 Luna.  The write
      // lists a stale GPT-5.6 Luna first and the exact GPT-6 Luna after it:
      // the exact copy claims the float, the stale one is left pinned.
      const saved: ModelSelection = {
        instanceId: "codexNewer",
        model: "gpt-5.6-sol",
        fallbacks: [{ instanceId: "codexNewer", model: "gpt-6-luna", latest: "luna" }],
      };
      const result = staleWrite(
        {
          instanceId: "codexNewer",
          model: "gpt-5.6-sol",
          fallbacks: [{ instanceId: "codexNewer", model: "gpt-5.6-luna" }, { instanceId: "codexNewer", model: "gpt-6-luna" }],
        },
        saved,
      );
      expect(result.ok && result.selection.fallbacks?.[0]?.latest).toBeUndefined();
      expect(result.ok && result.selection.fallbacks?.[1]).toMatchObject({ model: "gpt-6-luna", latest: "luna" });
    });
  });

  it("pins when the picker sends latest: null", () => {
    const saved: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5-5", latest: "sonnet" };
    const parsed: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5-5" };
    const result = write(parsed, saved, { instanceId: "claude", model: "claude-sonnet-5-5", latest: null });
    expect(result.ok && result.selection.latest).toBeUndefined();
  });

  it("reconciles the saved chain too, so a stale saved id does not look like an edit", () => {
    const saved: ModelSelection = { instanceId: "claude", model: "claude-3-7-sonnet" };
    const result = write({ instanceId: "claude", model: "claude-3-7-sonnet" }, saved);
    expect(result.ok && result.current).toEqual(result.ok && result.selection);
  });
});

describe("taskWriteBaseline", () => {
  const chain = (count: number): ModelSelection => ({
    instanceId: "claude",
    model: "claude-sonnet-5-5",
    fallbacks: Array.from({ length: count }, (_, index) => ({ instanceId: "codex", model: `m${index}` })),
  });
  const overCap = MAX_MODEL_FALLBACKS + 1;

  it("holds a brand-new task override to the cap even when the bot keeps an older, longer chain", () => {
    const base = taskWriteBaseline(undefined, chain(overCap));
    // The bot's selection still feeds the lineage check and the float carry.
    expect(base?.selection).toEqual(chain(overCap));
    // The cap grandfathers nothing: a task with no override replaces no chain.
    expect(base?.storedFallbacks).toBe(0);
    expect(fallbackCountAllowed(overCap, base?.storedFallbacks)).toBe(false);
    expect(fallbackCountAllowed(MAX_MODEL_FALLBACKS, base?.storedFallbacks)).toBe(true);
  });

  it("grandfathers a task's own over-cap override, so re-sending it unchanged still saves", () => {
    const own = chain(overCap);
    const base = taskWriteBaseline(own, chain(1));
    expect(base?.selection).toBe(own);
    expect(base?.storedFallbacks).toBe(overCap);
    expect(fallbackCountAllowed(overCap, base?.storedFallbacks)).toBe(true);
    expect(fallbackCountAllowed(overCap + 1, base?.storedFallbacks)).toBe(false);
  });

  it("prefers the task's override over the bot's selection, and is empty when neither is saved", () => {
    const task = chain(1);
    expect(taskWriteBaseline(task, chain(2))?.selection).toBe(task);
    expect(taskWriteBaseline(undefined, undefined)).toBeUndefined();
    expect(taskWriteBaseline({ instanceId: "claude", model: "claude-sonnet-5-5" }, chain(2))?.storedFallbacks).toBe(0);
  });
});
