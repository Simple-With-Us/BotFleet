import { describe, expect, it } from "vitest";

import type { ModelSelection } from "./contracts.ts";
import { STATIC_CODEX_MODELS } from "./drivers/codex-catalog.ts";
import {
  catalogIsAuthoritative,
  catalogIsLive,
  checkLineageWrite,
  lineageContextFor,
  matchesStaticFallback,
  presentDescribedInstances,
} from "./model-lineage.ts";
import { STATIC_CLAUDE_MODELS } from "./claude-models.ts";
import { STATIC_GROK_MODELS } from "./drivers/acp/grok.ts";
import type { LineageContext } from "../shared/model-lineage.ts";

const CODEX_LIVE = {
  default: "gpt-5.6-luna",
  options: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"].map((id) => ({ id, label: id })),
};

interface FixtureInstance {
  driverKind: string;
  models: { default: string; options: Array<{ id: string; label: string; custom?: boolean }> };
}

const instances: Record<string, FixtureInstance> = {
  claude: { driverKind: "claudeAgent", models: STATIC_CLAUDE_MODELS },
  codex: { driverKind: "codex", models: CODEX_LIVE },
  grok: { driverKind: "grokAgent", models: STATIC_GROK_MODELS },
  grokApi: { driverKind: "grok", models: { default: "grok-4.7", options: [{ id: "grok-4.7", label: "Grok 4.7" }] } },
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
    expect(presented[0]!.models.options.map((o) => o.id)).toEqual(["grok-4.7", "grok-4.7-build-fast"]);
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

  it("lets a saved retired leftover through so another slot can still be edited", () => {
    const saved: ModelSelection = {
      instanceId: "claude",
      model: "claude-sonnet-5-5",
      fallbacks: [{ instanceId: "grokApi", model: "grok-3-mini" }],
    };
    const edited: ModelSelection = { ...saved, model: "claude-opus-5-5" };
    expect(write(edited, saved).ok).toBe(true);
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
