// Capability registry invariants.  Anything the matrix, the callout, or
// the projection reads depends on the shape of `ENGINE_CAPABILITIES`, so
// the schema tests catch additions before they ship with a missing key
// or a half-filled pricing block.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CAPABILITY_CATEGORIES,
  CAPABILITY_KEYS,
  CAPABILITY_NOTES,
  CAPABILITY_STATES,
  ENGINE_CAPABILITIES,
  ENGINE_DISPLAY_ORDER,
  capabilityCellGlyph,
  capabilityCellLabel,
  capabilityNoteFor,
  engineIdFromDriverKind,
  pricingModeLabel,
  uniqueModelToEngineId,
  type CapabilityKey,
  type CapabilityState,
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
  "mcode",
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
      // Walk the declared vocabulary rather than `Object.keys`, so the keys
      // collected here are CapabilityKey by construction instead of strings
      // laundered into them.  A key an engine declares outside the vocabulary
      // cannot reach this set, and the stray-key case is pinned separately
      // below.
      for (const key of CAPABILITY_KEYS) {
        if (entry.capabilities[key] !== undefined) seen.add(key);
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
      const pricing = entry.pricing;
      if (pricing.kind === "subscription" || pricing.kind === "subscription+api") {
        expect(pricing.subscription.tierLabel.length, `${id} subscription.tierLabel`).toBeGreaterThan(0);
      }
    }
  });

  it("lists every engine id in ENGINE_DISPLAY_ORDER", () => {
    expect(new Set(ENGINE_DISPLAY_ORDER)).toEqual(new Set(KNOWN_ENGINE_IDS));
  });

  it("resolves every display-ordered id to a real registry entry", () => {
    // The matrix builds its rows by mapping ENGINE_DISPLAY_ORDER through
    // ENGINE_CAPABILITIES and filtering out whatever is missing.  An id
    // with no entry therefore vanishes from the table with no error at
    // all — a new engine that someone added to the display order but not
    // to the registry would just be absent.  That is the bug this pins.
    for (const id of ENGINE_DISPLAY_ORDER) {
      const entry = ENGINE_CAPABILITIES[id];
      expect(entry, `ENGINE_DISPLAY_ORDER lists "${id}" with no registry entry`).toBeDefined();
      expect(entry.id, `registry key "${id}" must match its own id field`).toBe(id);
    }
  });

  it("has every registered engine declare every capability key explicitly", () => {
    // This is the test that ends the "the registry omitted it" regression
    // class, which had bitten four times before.  A missing key used to
    // render as a dash wearing the "not available" tone, which reads as
    // "audited: this engine cannot do it" — an underclaim that is
    // indistinguishable, to a reader, from the truth.  Now a key must be
    // declared, and "I have not checked" is spelled "unknown".
    const states = new Set<CapabilityState>(CAPABILITY_STATES);
    for (const id of ENGINE_DISPLAY_ORDER) {
      const entry = ENGINE_CAPABILITIES[id];
      for (const key of CAPABILITY_KEYS) {
        const state = entry.capabilities[key];
        expect(
          state,
          `${id}.capabilities.${key} is missing — declare a real state or "unknown"`,
        ).toBeDefined();
        expect(
          state !== undefined && states.has(state),
          `${id}.capabilities.${key} is "${state}", which is not a CapabilityState`,
        ).toBe(true);
      }
      // And no stray keys outside the vocabulary.
      const declaredKeys: readonly string[] = CAPABILITY_KEYS;
      for (const key of Object.keys(entry.capabilities)) {
        expect(
          declaredKeys.includes(key),
          `${id}.capabilities.${key} is not a declared CapabilityKey`,
        ).toBe(true);
      }
    }
  });

  it("groups every capability under exactly one named category", () => {
    // CAPABILITY_KEYS is derived from the categories, so a column can
    // never drift out of its group — but a duplicated or dropped key
    // would still render a malformed spanning header.
    const grouped = CAPABILITY_CATEGORIES.flatMap((category) => category.keys);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(new Set(grouped)).toEqual(new Set(CAPABILITY_KEYS));
    for (const category of CAPABILITY_CATEGORIES) {
      expect(category.label.length, `${category.id} needs a label`).toBeGreaterThan(0);
    }
  });

  it("explains what every capability means, and prefers the engine's own note", () => {
    for (const key of CAPABILITY_KEYS) {
      const note = CAPABILITY_NOTES[key];
      expect(note, `${key} has no capability note`).toBeTruthy();
      expect(
        (note ?? "").length,
        `${key} note is too short to explain the capability`,
      ).toBeGreaterThan(40);
    }
    // Resolution order: engine-specific note, then the shared capability
    // note, then the engine headline — never an empty strip.
    expect(ENGINE_CAPABILITIES.grok.capabilityNotes?.longContext).toBeTruthy();
    expect(capabilityNoteFor(ENGINE_CAPABILITIES.grok, "longContext")).toBe(
      ENGINE_CAPABILITIES.grok.capabilityNotes!.longContext,
    );
    // A pair with no engine override falls back to the shared note.
    const fallback = capabilityNoteFor(ENGINE_CAPABILITIES.grok, "files");
    expect(fallback).toBe(CAPABILITY_NOTES.files);
    // And an engine with neither still gets its headline rather than blank.
    expect(
      capabilityNoteFor({ ...ENGINE_CAPABILITIES.grok, capabilityNotes: {} }, "files"),
    ).toBe(CAPABILITY_NOTES.files);
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
    // The MiniMax Code CLI driver carries the Agent suffix like every other
    // ACP coding CLI, so the suffix strip has to reach the mcode row.
    expect(engineIdFromDriverKind("mcodeAgent")).toBe("mcode");
    expect(engineIdFromDriverKind("mcode")).toBe("mcode");
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

  it("keeps MiniMax Code a distinct engine row on the same Token Plan", () => {
    // MiniMax Code is its own engine, not an alias of the direct MiniMax one:
    // a separate driver kind, its own row in the matrix, its own display
    // name.  The subscription is shared, so the plan block matches.
    const mcode = ENGINE_CAPABILITIES.mcode;
    const minimaxEntry = ENGINE_CAPABILITIES.minimax;
    expect(mcode.displayName).toBe("MiniMax Code");
    expect(mcode.id).toBe("mcode");
    // Distinct chips: the two rows sit next to each other in the matrix.
    expect(mcode.capabilityBadgeColor).not.toBe(minimaxEntry.capabilityBadgeColor);
    expect(mcode.pricing.kind).toBe("subscription+api");
    if (mcode.pricing.kind !== "subscription+api" || minimaxEntry.pricing.kind !== "subscription+api") {
      throw new Error("both MiniMax engines must retain separate subscription and API pricing");
    }
    expect(mcode.pricing.subscription.tierLabel).toBe(minimaxEntry.pricing.subscription.tierLabel);
    expect(mcode.pricing.subscription.costPerMonth).toBe(minimaxEntry.pricing.subscription.costPerMonth);
    expect(mcode.pricing.api).toEqual(minimaxEntry.pricing.api);
    // The ACP core mounts MCP servers for this driver, so Connected Apps and
    // images are genuinely available here even though the direct MiniMax
    // engine declares neither.
    expect(mcode.capabilities.connectedApps).toBe("yes");
    expect(mcode.capabilities.imageAttachments).toBe("yes");
    expect(minimaxEntry.capabilities.connectedApps).toBe("no");
    // The matrix lists the ids a live mcode session actually advertises, so
    // the engine's declared models and the picker's rows agree.
    expect(mcode.defaultModels.map((m) => m.id)).toEqual([
      "MiniMax-M3",
      "MiniMax-M3-thinking",
      "MiniMax-M3.1-Flash-Preview-thinking",
      "MiniMax-M2.7-highspeed-thinking",
      "MiniMax-M2.7-thinking",
    ]);
    // The flash preview tier is the one a current mcode install defaults to,
    // so it must be reachable in the matrix too.  It is deliberately not the
    // first row: a preview id is never what a fresh install hands someone who
    // has not asked for it.
    expect(mcode.defaultModels[0].id).toBe("MiniMax-M3");
    expect(
      mcode.defaultModels.find((m) => m.id === "MiniMax-M3.1-Flash-Preview-thinking")?.ctxTokens,
    ).toBe(1_000_000);
  });

  it("leaves MiniMax-M3 unmapped rather than crediting one of its two engines", () => {
    // The shared flagship model id belongs to both MiniMax engines, so the
    // unique-model map must not first-win it onto either one.  Engine-tagged
    // usage still attributes correctly through engineIdFromDriverKind.
    const map = uniqueModelToEngineId();
    expect(map.get("MiniMax-M3")).toBeUndefined();
    expect(engineIdFromDriverKind("minimax")).toBe("minimax");
    expect(engineIdFromDriverKind("mcodeAgent")).toBe("mcode");
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

  it("capabilityCellLabel states the verdict in words", () => {
    // The glyph and the word are separate functions now.  The word is what
    // the cell's `title`, its accessible name, and the detail strip read;
    // conflating the two is what let a dash wear the "not available" tone.
    expect(capabilityCellLabel("yes")).toBe("Available");
    expect(capabilityCellLabel("no")).toBe("Not available");
    expect(capabilityCellLabel("limited")).toBe("Limited");
    expect(capabilityCellLabel("yes-pro-only")).toBe("Pro plan only");
    // A missing key and an explicit "unknown" say the same thing, and
    // neither of them says "not available".
    expect(capabilityCellLabel("unknown")).toBe("Not audited");
    expect(capabilityCellLabel(undefined)).toBe("Not audited");
  });

  it("capabilityCellGlyph is one compact character per state", () => {
    for (const state of CAPABILITY_STATES) {
      expect(capabilityCellGlyph(state).length, `${state} glyph`).toBe(1);
    }
    expect(capabilityCellGlyph("yes")).toBe("✓");
    expect(capabilityCellGlyph("no")).toBe("✗");
    // Unaudited and missing share the glyph, so "nobody checked" can
    // never be mistaken for a measured "no".
    expect(capabilityCellGlyph("unknown")).toBe("?");
    expect(capabilityCellGlyph(undefined)).toBe("?");
    // Every glyph is visually distinct from every other.
    expect(new Set(CAPABILITY_STATES.map(capabilityCellGlyph)).size).toBe(CAPABILITY_STATES.length);
  });
});

/** The registry as JSON, parsed at its boundary.  The registry is
 *  `JSON.stringify`d on its way to the server, so JSON is the shape it has,
 *  and parsing it here is what lets the walk below branch on real values
 *  instead of on representations. */
const registryJson = z.json();
type RegistryValue = z.infer<typeof registryJson>;
const registryText = z.string();
const registryBranch = z.record(z.string(), z.json());

function registryStrings(): string[] {
  const strings: string[] = [];
  const walk = (value: RegistryValue) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value === null) return;
    const branch = registryBranch.safeParse(value);
    if (branch.success) {
      Object.values(branch.data).forEach(walk);
      return;
    }
    const text = registryText.safeParse(value);
    if (text.success) strings.push(text.data);
  };
  walk(registryJson.parse(ENGINE_CAPABILITIES));
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
      // Per-engine capability notes are shown verbatim in the matrix detail
      // strip, so they carry the same sentence-gap rule as the prose above.
      for (const [key, note] of Object.entries(entry.capabilityNotes ?? {})) {
        assertTwoAsciiSpaces(note ?? "", `${id} capabilityNotes.${key}`);
      }
    }
  });

  it("uses two ASCII spaces after periods and colons in the shared capability notes", () => {
    for (const [key, note] of Object.entries(CAPABILITY_NOTES)) {
      const parsed = registryText.safeParse(note);
      if (!parsed.success) throw new Error(`CAPABILITY_NOTES.${key} must be text`);
      assertTwoAsciiSpaces(parsed.data, `CAPABILITY_NOTES.${key}`);
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
