import { describe, expect, it, vi } from "vitest";
import {
  createModelDiscoveryProbe,
  discoverModelCatalog,
  fetchProviderModels,
  mergeDiscoveredModels,
  type ModelDiscoveryResult,
} from "./model-discovery.ts";
import type { ModelCatalog } from "../contracts.ts";

const KNOWN: ModelCatalog = {
  default: "grok-4.7",
  options: [
    { id: "grok-4.7", label: "Grok 4.7", badge: "fast", badgeTitle: "Faster, cheaper.", contextWindow: 256_000 },
    { id: "grok-4.5", label: "Grok 4.5" },
  ],
};

const rows = (...ids: string[]) => ids.map((id) => ({ id }));

describe("fetchProviderModels", () => {
  it("reads the { data: [...] } shape every OpenAI-compatible provider uses", async () => {
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: rows("a", "b") })));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchProviderModels({ baseUrl: "https://api.example.com/v1", apiKey: "k" });
    expect(result.ok).toBe(true);
    expect(result.rows).toEqual(rows("a", "b"));
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.example.com/v1/models");
    vi.unstubAllGlobals();
  });

  it("reads a bare array too, and trims a trailing slash off the base url", async () => {
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(rows("solo"))));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchProviderModels({ baseUrl: "https://api.example.com/v1/" });
    expect(result.rows).toEqual(rows("solo"));
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.example.com/v1/models");
    vi.unstubAllGlobals();
  });

  it("sends the key as a bearer token and passes provider headers through", async () => {
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [] })));
    vi.stubGlobal("fetch", fetchMock);
    await fetchProviderModels({ baseUrl: "https://x", apiKey: "secret", headers: { "api-version": "2026-01" } });
    // A real Headers instance, not a plain object, so the assertion reads it
    // through the Headers API rather than indexing.
    const sent = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(sent.get("authorization")).toBe("Bearer secret");
    expect(sent.get("api-version")).toBe("2026-01");
    vi.unstubAllGlobals();
  });

  it("omits the authorization header when there is no key", async () => {
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [] })));
    vi.stubGlobal("fetch", fetchMock);
    await fetchProviderModels({ baseUrl: "https://x" });
    const sent = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(sent.has("authorization")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("reports a non-2xx as a miss rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL, _init?: RequestInit) =>
      new Response("nope", { status: 401 })));
    const result = await fetchProviderModels({ baseUrl: "https://x" });
    expect(result).toEqual({ ok: false, status: 401 });
    vi.unstubAllGlobals();
  });

  it("reports a network failure as a miss with no status", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL, _init?: RequestInit) => {
      throw new Error("ECONNREFUSED");
    }));
    const result = await fetchProviderModels({ baseUrl: "https://x" });
    expect(result).toEqual({ ok: false });
    vi.unstubAllGlobals();
  });
});

describe("mergeDiscoveredModels", () => {
  it("keeps hand-written label, badge, and context window for a known id", () => {
    const merged = mergeDiscoveredModels(rows("grok-4.7"), KNOWN);
    expect(merged?.options[0]).toMatchObject({
      id: "grok-4.7",
      label: "Grok 4.7",
      badge: "fast",
      badgeTitle: "Faster, cheaper.",
      contextWindow: 256_000,
    });
  });

  it("adds a newly shipped model with the id as the label", () => {
    const merged = mergeDiscoveredModels(rows("grok-4.7", "grok-5"), KNOWN);
    expect(merged?.options.map((o) => o.id)).toEqual(["grok-4.7", "grok-5"]);
    expect(merged?.options[1].label).toBe("grok-5");
  });

  it("prefers the provider's own name over the bare id for an unknown model", () => {
    const merged = mergeDiscoveredModels([{ id: "grok-5", name: "Grok 5 Preview" }], KNOWN);
    expect(merged?.options[0].label).toBe("Grok 5 Preview");
  });

  it("drops a model the provider retired", () => {
    const merged = mergeDiscoveredModels(rows("grok-4.7"), KNOWN);
    expect(merged?.options.map((o) => o.id)).toEqual(["grok-4.7"]);
  });

  it("never re-aliases a retired id to its replacement", () => {
    // grok-4.5 is gone from the provider; the merge drops it rather than
    // pointing it at grok-4.7 (docs/rollouts/2026-09-18-latest-model-ids.md).
    const merged = mergeDiscoveredModels(rows("grok-4.7"), KNOWN);
    expect(merged?.options.some((o) => o.id === "grok-4.5")).toBe(false);
  });

  it("honors an explicit exclusion — the DSH MiniMax-M2.7 case", () => {
    const merged = mergeDiscoveredModels(rows("MiniMax-M3", "MiniMax-M2.7"), KNOWN, {
      excludeIds: ["MiniMax-M2.7"],
    });
    expect(merged?.options.map((o) => o.id)).toEqual(["MiniMax-M3"]);
  });

  it("keeps the current default when it survived the refresh", () => {
    const merged = mergeDiscoveredModels(rows("grok-5", "grok-4.7"), KNOWN);
    expect(merged?.default).toBe("grok-4.7");
  });

  it("moves the default only when the current one is gone", () => {
    const merged = mergeDiscoveredModels(rows("grok-5", "grok-4.6"), KNOWN);
    expect(merged?.default).toBe("grok-5");
  });

  it("can be told not to keep the default", () => {
    const merged = mergeDiscoveredModels(rows("grok-5", "grok-4.7"), KNOWN, { keepDefault: false });
    expect(merged?.default).toBe("grok-5");
  });

  it("dedupes a provider that lists the same id twice", () => {
    const merged = mergeDiscoveredModels(rows("grok-4.7", "grok-4.7"), KNOWN);
    expect(merged?.options).toHaveLength(1);
  });

  it("ignores malformed rows instead of emitting a nameless option", () => {
    const merged = mergeDiscoveredModels([{ id: "" }, { id: 7 }, null, "grok", rows("grok-4.7")[0]], KNOWN);
    expect(merged?.options.map((o) => o.id)).toEqual(["grok-4.7"]);
  });

  it("returns null for an empty list so the caller keeps its catalog", () => {
    expect(mergeDiscoveredModels([], KNOWN)).toBeNull();
  });

  it("returns null when every row is excluded, rather than an empty picker", () => {
    expect(mergeDiscoveredModels(rows("MiniMax-M2.7"), KNOWN, { excludeIds: ["MiniMax-M2.7"] })).toBeNull();
  });
});

describe("discoverModelCatalog", () => {
  const ok = (ids: string[]): ModelDiscoveryResult => ({ ok: true, status: 200, rows: rows(...ids) });

  it("returns the merged catalog on a good probe", async () => {
    const catalog = await discoverModelCatalog(async () => ok(["grok-4.7", "grok-5"]), () => KNOWN);
    expect(catalog?.options.map((o) => o.id)).toEqual(["grok-4.7", "grok-5"]);
  });

  it("returns null on a failed probe so the caller keeps the old catalog", async () => {
    const catalog = await discoverModelCatalog(async () => ({ ok: false, status: 503 }), () => KNOWN);
    expect(catalog).toBeNull();
  });

  it("returns null when the provider answers 200 with nothing usable", async () => {
    const catalog = await discoverModelCatalog(async () => ({ ok: true, status: 200, rows: [] }), () => KNOWN);
    expect(catalog).toBeNull();
  });

  it("merges against the catalog as it is now, not a stale snapshot", async () => {
    // A caller that already refreshed to grok-5 must keep grok-5's label
    // rather than fall back to the module-level constant.
    const current: ModelCatalog = { default: "grok-5", options: [{ id: "grok-5", label: "Grok 5" }] };
    const catalog = await discoverModelCatalog(async () => ok(["grok-5"]), () => current);
    expect(catalog?.options[0].label).toBe("Grok 5");
    expect(catalog?.default).toBe("grok-5");
  });
});

describe("createModelDiscoveryProbe", () => {
  it("reuses one answer for concurrent callers inside the TTL", async () => {
    let calls = 0;
    const probe = createModelDiscoveryProbe(60_000, async () => {
      calls += 1;
      return { ok: true, status: 200, rows: [] };
    });
    await Promise.all([probe(), probe(), probe()]);
    expect(calls).toBe(1);
  });

  it("refetches once the TTL has passed", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const probe = createModelDiscoveryProbe(1_000, async () => {
        calls += 1;
        return { ok: true, status: 200, rows: [] };
      });
      await probe();
      await probe();
      expect(calls).toBe(1);
      vi.advanceTimersByTime(1_001);
      await probe();
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves sequential awaits from the memo, not just concurrent ones", async () => {
    // The bug this guards: clearing the memo in a `finally` made every
    // *settled* probe forget itself, so a second sequential call refetched
    // and the TTL bought nothing.  A registry describe loop is sequential.
    let calls = 0;
    const probe = createModelDiscoveryProbe(60_000, async () => {
      calls += 1;
      return { ok: true, status: 200, rows: [] };
    });
    await probe();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await probe();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await probe();
    expect(calls).toBe(1);
  });

  it("does cache a resolved probe until the TTL, then forgets it", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const probe = createModelDiscoveryProbe(1_000, async () => {
        calls += 1;
        return { ok: true, status: 200, rows: [] };
      });
      await probe();
      vi.advanceTimersByTime(1_001);
      await probe();
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cache a rejected probe, and does not leak an unhandled rejection", async () => {
    let calls = 0;
    const probe = createModelDiscoveryProbe(60_000, async () => {
      calls += 1;
      throw new Error("boom");
    });
    await expect(probe()).rejects.toThrow("boom");
    await expect(probe()).rejects.toThrow("boom");
    expect(calls).toBe(2);
  });
});
