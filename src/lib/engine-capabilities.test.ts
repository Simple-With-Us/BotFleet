// Capability registry invariants.  Anything the matrix, the callout, or
// the projection reads depends on the shape of `ENGINE_CAPABILITIES`, so
// the schema tests catch additions before they ship with a missing key
// or a half-filled pricing block.
import { describe, expect, it } from "vitest";

import {
  CAPABILITY_KEYS,
  ENGINE_CAPABILITIES,
  ENGINE_DISPLAY_ORDER,
  capabilityCellLabel,
  engineIdFromDriverKind,
  pricingModeLabel,
  uniqueModelToEngineId,
  type CapabilityKey,
  type PricingMode,
} from "./engine-capabilities.tsx";

const KNOWN_ENGINE_IDS = [
  "grok",
  "cursor",
  "claude",
  "codex",
  "antigravity",
  "deepseek-harness",
  "minimax",
];

describe("ENGINE_CAPABILITIES registry", () => {
  it("keeps Grok API pricing on the API block and reflects Grok 4.7", () => {
    const grok = ENGINE_CAPABILITIES.grok;
    expect(grok.defaultModels[0]).toEqual({ id: "grok-4.7", display: "Grok 4.7", ctxTokens: 500_000 });
    expect(grok.pricing.kind).toBe("subscription+api");
    if (grok.pricing.kind !== "subscription+api") throw new Error("Grok must retain separate subscription and API pricing");
    expect(grok.pricing.subscription.costPerMonth).toBe(99);
    expect(grok.pricing.api).toMatchObject({ inputPer1k: 0.002, cachedInputPer1k: 0.0005, outputPer1k: 0.006 });
  });

  it("still attributes legacy grok-4 tasks to Grok alongside the 4.7 catalog", () => {
    const map = uniqueModelToEngineId();
    expect(map.get("grok-4")).toBe("grok");
    expect(map.get("grok-4.7")).toBe("grok");
    expect(map.get("grok-4.6")).toBe("grok");
    expect(map.get("grok-4.7-build-fast")).toBe("grok");
  });

  it("exposes one entry for every known engine id", () => {
    for (const id of KNOWN_ENGINE_IDS) {
      expect(ENGINE_CAPABILITIES[id], `missing registry entry for ${id}`).toBeDefined();
      expect(ENGINE_CAPABILITIES[id].id).toBe(id);
      expect(ENGINE_CAPABILITIES[id].displayName.length).toBeGreaterThan(0);
    }
  });

  it("covers every capability key in the matrix", () => {
    // Cells in the matrix need a value for every (engine, capability)
    // pair — `capabilityCellLabel` returns "—" when the cell is missing.
    // We require at least one entry per capability, so the matrix shows
    // the row rather than rendering nothing.
    const seen = new Set<CapabilityKey>();
    for (const entry of Object.values(ENGINE_CAPABILITIES)) {
      for (const key of Object.keys(entry.capabilities) as CapabilityKey[]) {
        seen.add(key);
      }
    }
    for (const key of CAPABILITY_KEYS) {
      expect(seen.has(key), `no engine declares the "${key}" capability`).toBe(true);
    }
  });

  it("has at least one default model per engine", () => {
    for (const [id, entry] of Object.entries(ENGINE_CAPABILITIES)) {
      expect(entry.defaultModels.length, `${id} must declare at least one default model`).toBeGreaterThan(0);
      for (const model of entry.defaultModels) {
        expect(model.id.length).toBeGreaterThan(0);
        expect(model.display.length).toBeGreaterThan(0);
      }
    }
  });

  it("fills in both blocks of every subscription+api pricing mode", () => {
    for (const [id, entry] of Object.entries(ENGINE_CAPABILITIES)) {
      if (entry.pricing.kind !== "subscription+api") continue;
      // The task spec is explicit: a `subscription+api` row must have
      // BOTH blocks filled in.  A row with only the subscription block
      // would render "Subscription" in the matrix but "API $X/1k" in the
      // projection — the inconsistency the rewrite removes.
      expect(entry.pricing.subscription.tierLabel.length, `${id}.subscription.tierLabel`).toBeGreaterThan(0);
      expect(Number.isFinite(entry.pricing.api.inputPer1k), `${id}.api.inputPer1k must be a finite number`).toBe(true);
      expect(Number.isFinite(entry.pricing.api.outputPer1k), `${id}.api.outputPer1k must be a finite number`).toBe(true);
    }
  });

  it("fills in subscription.tierLabel for every subscription engine", () => {
    for (const [id, entry] of Object.entries(ENGINE_CAPABILITIES)) {
      const pricing = entry.pricing as PricingMode;
      if (pricing.kind === "subscription" || pricing.kind === "subscription+api") {
        expect(pricing.subscription.tierLabel.length, `${id} subscription.tierLabel`).toBeGreaterThan(0);
      }
    }
  });

  it("lists every engine id in ENGINE_DISPLAY_ORDER", () => {
    expect(new Set(ENGINE_DISPLAY_ORDER)).toEqual(new Set(KNOWN_ENGINE_IDS));
  });

  it("engineIdFromDriverKind maps known driver kinds to registry ids", () => {
    expect(engineIdFromDriverKind("grok")).toBe("grok");
    expect(engineIdFromDriverKind("grokAgent")).toBe("grok");
    expect(engineIdFromDriverKind("claude")).toBe("claude");
    expect(engineIdFromDriverKind("claudeAgent")).toBe("claude");
    expect(engineIdFromDriverKind("dshAgent")).toBe("deepseek-harness");
    expect(engineIdFromDriverKind("dsh")).toBe("deepseek-harness");
    expect(engineIdFromDriverKind("deepseekAgent")).toBe("deepseek-harness");
    expect(engineIdFromDriverKind("deepseek")).toBe("deepseek-harness");
    expect(engineIdFromDriverKind("antigravityAgent")).toBe("antigravity");
    expect(engineIdFromDriverKind("minimax")).toBe("minimax");
    expect(engineIdFromDriverKind("unknown-engine")).toBeNull();
    expect(engineIdFromDriverKind(undefined)).toBeNull();
  });

  it("marks connectedApps 'yes' for every engine whose driver declares composioMcp", () => {
    // The matrix rendered "-" for Claude and Codex because the registry
    // omitted the key while their drivers declare composioMcp
    // (server/drivers/claude.ts, codex.ts, antigravity.ts, and the DSH
    // ACP adapter).  A missing key renders as "-", which reads as
    // "engine cannot do this" — the exact underclaim Codex flagged.
    for (const id of ["claude", "codex", "antigravity", "deepseek-harness"]) {
      expect(ENGINE_CAPABILITIES[id].capabilities.connectedApps, id).toBe("yes");
    }
  });

  it("marks MiniMax connectedApps as 'no' — the driver has no composioMcp", () => {
    // Connected Apps is the Composio bridge, and MiniMax's direct
    // driver declares no composioMcp in server/drivers/minimax.ts
    // (Claude, Codex, Antigravity, pi, and the DSH ACP adapter all
    // declare it).  'limited' still implied a partial channel that does
    // not exist; driving this Mac is the thisComputer row
    // (localComputerMcp), a different thing.  Pin 'no' so a future edit
    // cannot silently regress the matrix to overclaim.
    expect(ENGINE_CAPABILITIES.minimax.capabilities.connectedApps).toBe("no");
  });

  it("pricingModeLabel reads consistently with the pricing block", () => {
    expect(pricingModeLabel({ kind: "free" })).toContain("Free");
    expect(pricingModeLabel({ kind: "unknown" })).toContain("unknown");
    const subscription: PricingMode = {
      kind: "subscription",
      subscription: { tierLabel: "Test", costPerMonth: 9.99 },
    };
    expect(pricingModeLabel(subscription)).toContain("$9.99/mo");
    const api: PricingMode = {
      kind: "api",
      api: { inputPer1k: 0.001, outputPer1k: 0.004 },
    };
    expect(pricingModeLabel(api)).toContain("API");
  });

  it("capabilityCellLabel returns the legacy vocabulary", () => {
    expect(capabilityCellLabel("yes")).toBe("✓");
    expect(capabilityCellLabel("no")).toBe("✗");
    expect(capabilityCellLabel("limited")).toBe("limited");
    expect(capabilityCellLabel("yes-pro-only")).toBe("pro only");
    expect(capabilityCellLabel(undefined)).toBe("—");
  });
});

function registryStrings(): string[] {
  const strings: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(ENGINE_CAPABILITIES);
  return strings;
}

/** Two ASCII spaces after a sentence period or colon.  Decimals, URLs, and
 *  abbreviations do not match because they are not ". " / ": " before a letter. */
function assertTwoAsciiSpaces(text: string, where: string) {
  expect(text.match(/\. [A-Za-z]/g), `${where} needs two spaces after a period: ${text}`).toBeNull();
  expect(text.match(/: [A-Za-z]/g), `${where} needs two spaces after a colon: ${text}`).toBeNull();
}

describe("ENGINE_CAPABILITIES user-facing copy", () => {
  const BANNED: RegExp[] = [
    /on this seat/i,
    /\bthis seat\b/i,
    /fleet-recall/i,
    /fleet recall/i,
    /\bJay\b/,
    /\bstrongest\b/i,
    /\bsafest\b/i,
    /right tool/i,
    /budget tier/i,
    /pairs well/i,
    /pairs with/i,
    /\bJWT\b/,
    /prolite/i,
    /renewing/i,
    /2026-10-05/,
    /mid-October/,
    /Grok Bot/,
    /bundled into/i,
    /Bundled with/,
    /\bMavis\b/,
    /\$213\.20/,
    /\$105\.79/,
    /\$99/,
    /\$55/,
    /\$50\b/,
    /PR #/,
    /EFFORT-LOG/,
    /server\//,
  ];

  it("never names the account holder in any displayed string", () => {
    expect(registryStrings().filter((text) => /\bJay\b/.test(text))).toEqual([]);
  });

  it("strips seat diary and ranking voice from every engine", () => {
    const hits = registryStrings().flatMap((text) =>
      BANNED.filter((pattern) => pattern.test(text)).map((pattern) => `${pattern}: ${text}`),
    );
    expect(hits).toEqual([]);
  });

  it("uses two ASCII spaces after periods and colons in engine info prose", () => {
    for (const [id, entry] of Object.entries(ENGINE_CAPABILITIES)) {
      assertTwoAsciiSpaces(entry.whyThisEngine.headline, `${id} headline`);
      for (const line of entry.whyThisEngine.prose) assertTwoAsciiSpaces(line, `${id} prose`);
      assertTwoAsciiSpaces(entry.pricing.notes ?? "", `${id} pricing.notes`);
      if ("subscription" in entry.pricing) {
        assertTwoAsciiSpaces(entry.pricing.subscription.notes ?? "", `${id} subscription.notes`);
        assertTwoAsciiSpaces(entry.pricing.subscription.includedQuota ?? "", `${id} includedQuota`);
      }
      if ("api" in entry.pricing) assertTwoAsciiSpaces(entry.pricing.api.notes ?? "", `${id} api.notes`);
    }
  });

  it("shows a Cursor Ultra plan note without a seat bundle story", () => {
    const pricing = ENGINE_CAPABILITIES.cursor.pricing;
    expect(pricing.kind).toBe("subscription");
    if (pricing.kind !== "subscription") return;
    expect(pricing.subscription.tierLabel).toBe("Cursor Ultra");
    const shown = pricing.notes ?? pricing.subscription.notes;
    expect(shown).toBe(
      "Cursor Ultra subscription.  BotFleet does not register a separate Cursor API rate.",
    );
    expect(pricingModeLabel(pricing)).toBe("Subscription");
    expect(pricingModeLabel(pricing).toLowerCase()).not.toContain("bundled");
  });

  it("bills DeepSeek Harness as DeepSeek PAYG, not a Claude Max bundle", () => {
    const entry = ENGINE_CAPABILITIES["deepseek-harness"];
    expect(entry.pricing.kind).toBe("api");
    if (entry.pricing.kind !== "api") return;
    expect(entry.pricing.api).toMatchObject({
      inputPer1k: 0.00027,
      outputPer1k: 0.0011,
      cachedInputPer1k: 0.00007,
    });
    expect(entry.pricing.notes).toBe(
      "DeepSeek Harness runs DeepSeek models over the harness ACP bridge.  Billing is DeepSeek pay-as-you-go at the public API catalog.  There is no subscription line on this engine.",
    );
    expect(entry.whyThisEngine).toEqual({
      headline: "DeepSeek models over the harness ACP bridge, billed pay-as-you-go.",
      prose: [
        "DeepSeek Harness runs DeepSeek models through BotFleet's harness ACP bridge.  Files, terminal, this computer, web access, connected apps, and cross-bot coordination are available.",
        "Billing is DeepSeek pay-as-you-go.  The rates in Pricing Mode are the public API catalog, not a subscription invoice.",
        "BotFleet does not support image attachments on DeepSeek Harness yet.",
      ],
    });
    expect(entry.capabilities.imageAttachments).toBe("no");
    const copy = [
      entry.pricing.notes ?? "",
      entry.pricing.api.notes ?? "",
      entry.whyThisEngine.headline,
      ...entry.whyThisEngine.prose,
    ].join("\n");
    expect(copy).toContain("BotFleet does not support image attachments");
    expect(copy).not.toContain("Bundled with Claude Max");
    expect(copy).not.toContain("Claude Max");
    expect(copy).not.toContain("same Claude Max seat");
    expect(copy).not.toContain("bundled Claude Max seat");
    expect(copy).not.toContain("pairs with Claude");
    expect(copy).not.toContain("pairs well with Claude");
    expect(copy).not.toContain("Subscription is bundled");
    expect(copy).not.toContain("composer rejects");
    expect(copy).not.toMatch(/this model cannot/i);
    expect(copy).not.toMatch(/\bOpus\b/);
    expect(copy).not.toMatch(/on this seat/i);
    expect(pricingModeLabel(entry.pricing)).toBe("API · $0.00027/1k in");
    expect(pricingModeLabel(entry.pricing).toLowerCase()).not.toContain("bundled");
  });
});
