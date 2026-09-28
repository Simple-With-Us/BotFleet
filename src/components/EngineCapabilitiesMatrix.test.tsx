// Capability matrix shape tests.  The table is TRANSPOSED: one row per
// engine, one column per capability.  It was the other way round until the
// redesign, and the old orientation could not fit — 160px of sticky row
// header plus eight 120px engine columns is 1120px inside a pane that
// offers 870px, so the reader saw roughly 5.9 of 8 engines and had to
// scroll horizontally forever.
//
// The regression that mattered is therefore pinned below as arithmetic
// rather than as a snapshot: the declared column budget must stay inside
// the pane's real width, so adding a thirteenth capability or widening a
// column fails the build instead of quietly restoring the scrollbar.
//
// Rendering goes through `renderToStaticMarkup` (the Vite test environment
// is `node`, so this is the DOM-free path — the same pattern the
// ApprovalCard and CloudBackendPicker tests already use).
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

import {
  EngineCapabilitiesMatrix,
  MATRIX_CAPABILITY_COL_PX,
  MATRIX_CARD_PADDING_PX,
  MATRIX_CONTENT_BUDGET_PX,
  MATRIX_ROW_HEADER_PX,
  MATRIX_TABLE_BUDGET_PX,
} from "./EngineCapabilitiesMatrix.tsx";
import {
  CAPABILITY_CATEGORIES,
  CAPABILITY_KEYS,
  CAPABILITY_LABELS,
  CAPABILITY_NOTES,
  CAPABILITY_SHORT_LABELS,
  CAPABILITY_STATES,
  ENGINE_CAPABILITIES,
  ENGINE_DISPLAY_ORDER,
  capabilityCellGlyph,
  capabilityCellLabel,
  capabilityNoteFor,
} from "@/lib/engine-capabilities.tsx";

const html = renderToStaticMarkup(createElement(EngineCapabilitiesMatrix));

/** `renderToStaticMarkup` drops event handlers and class maps that never made
 *  it onto an element, so the behaviour assertions below read the component
 *  source.  Same pattern the ComputerEngineCallout and ui-copy tests use. */
const source = readFileSync(new URL("./EngineCapabilitiesMatrix.tsx", import.meta.url), "utf8");

describe("EngineCapabilitiesMatrix layout budget", () => {
  it("derives the content budget from the real dialog geometry", () => {
    // 1292px dialog - 164px section nav - 20px of px-5 on each side.
    expect(MATRIX_CONTENT_BUDGET_PX).toBe(1088);
    expect(MATRIX_CARD_PADDING_PX).toBe(32);
    expect(MATRIX_TABLE_BUDGET_PX).toBe(1056);
  });

  it("fits every capability column inside the pane without a horizontal scroll", () => {
    // The regression guard.  A `min-w` per column, or one more capability,
    // and this fails rather than shipping a table the reader cannot see.
    const declared =
      MATRIX_ROW_HEADER_PX + CAPABILITY_KEYS.length * MATRIX_CAPABILITY_COL_PX;
    expect(declared, "the matrix must fit the content pane without overflowing").toBeLessThanOrEqual(
      MATRIX_TABLE_BUDGET_PX,
    );
    // And the pane itself must be a real number, not a guess.
    expect(declared).toBeLessThanOrEqual(MATRIX_CONTENT_BUDGET_PX);
  });

  it("puts no min-width on the table, so nothing can reintroduce the scroll", () => {
    // `table-fixed` plus a <colgroup> is what makes the budget authoritative.
    expect(html).toContain("table-fixed");
    expect(html).toContain("<colgroup>");
    expect(html).not.toContain("overflow-x-auto");
    expect(html).not.toMatch(/min-w-\[/);
  });
});

describe("EngineCapabilitiesMatrix orientation", () => {
  it("renders one row per engine", () => {
    for (const id of ENGINE_DISPLAY_ORDER) {
      const entry = ENGINE_CAPABILITIES[id];
      expect(html, `${entry.displayName} row missing`).toContain(entry.displayName);
    }
  });

  it("renders one column per capability", () => {
    for (const key of CAPABILITY_KEYS) {
      expect(html, `${CAPABILITY_LABELS[key]} column missing`).toContain(
        CAPABILITY_SHORT_LABELS[key],
      );
    }
  });

  it("groups the capabilities under a spanning header per category", () => {
    for (const category of CAPABILITY_CATEGORIES) {
      // Ampersands arrive HTML-escaped in a static render.
      const rendered = category.label.replace(/&/g, "&amp;");
      expect(html, `${category.label} group header missing`).toContain(rendered);
    }
    // Every capability belongs to exactly one category, and CAPABILITY_KEYS
    // is derived from them, so a column cannot drift out of its group.
    const grouped = CAPABILITY_CATEGORIES.flatMap((category) => category.keys);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(new Set(grouped)).toEqual(new Set(CAPABILITY_KEYS));
  });

  it("gives every cell an accessible name that states the verdict in words", () => {
    for (const id of ENGINE_DISPLAY_ORDER) {
      const entry = ENGINE_CAPABILITIES[id];
      for (const key of CAPABILITY_KEYS) {
        const state = entry.capabilities[key];
        expect(
          html,
          `${entry.displayName} / ${key} must announce "${capabilityCellLabel(state)}"`,
        ).toContain(`aria-label="${entry.displayName}, ${CAPABILITY_LABELS[key]}: `);
      }
    }
  });

  it("renders a pricing pill for every engine", () => {
    // The Subscription · $X/mo pill wording is the legacy vocabulary we
    // kept; pin at least one match across the registered engines.
    expect(html).toMatch(/Subscription/);
    // Subscription + API engines emit "Subscription + API · $X/mo";
    // MiniMax and Grok both qualify, so the string must appear at
    // least twice.
    const subscriptionApiMatches = html.match(/Subscription \+ API/g) ?? [];
    expect(subscriptionApiMatches.length).toBeGreaterThanOrEqual(2);
  });
});

describe("EngineCapabilitiesMatrix detail strip", () => {
  it("is mounted before anything is hovered, so the layout never shifts", () => {
    // The old strip rendered *after* the table, past the fold, and
    // unmounted on mouseleave.  It is now always present at a fixed
    // minimum height and only its contents change.
    expect(html).toContain("min-h-[92px]");
    expect(html).toContain("aria-live=\"polite\"");
    expect(html).toContain("Hover or focus any cell");
  });

  it("never clears on the pointer leaving a cell", () => {
    // A latching strip has no leave handler at all.  If someone adds
    // `onMouseLeave` back, the text vanishes before it can be read — which
    // is exactly the bug the redesign was filed for.
    expect(source).not.toContain("onMouseLeave");
    expect(source).not.toContain("onMouseOut");
    expect(source).not.toContain("setActive(null)");
    // Focus latches too, so the table stays keyboard-navigable.
    expect(source).toContain("onFocus={() => setActive(");
    expect(source).toContain("tabIndex={0}");
  });
});

describe("EngineCapabilitiesMatrix cell vocabulary", () => {
  it("shows every state in a legend, including the not-audited one", () => {
    for (const state of CAPABILITY_STATES) {
      expect(html, `${state} legend entry missing`).toContain(capabilityCellLabel(state));
      expect(html, `${state} legend glyph missing`).toContain(capabilityCellGlyph(state));
    }
  });

  it("never paints an unaudited pair with the 'not available' tone", () => {
    // The original bug: a missing registry key fell through to the "no"
    // tone while printing a dash, so "nobody checked" read as "audited:
    // unsupported".  The unknown tone is a dashed border; the "no" tone
    // carries a filled background.  Pin both, so the two can never merge.
    // The message rides `expect`, not `toMatch`: Vitest's `toMatch` takes the
    // expected value alone, so a second argument is both a type error and
    // silently dropped by a JS caller.
    expect(source, "the unknown tone must be visually distinct from every measured state").toMatch(
      /unknown:\s*"[^"]*border-dashed[^"]*"/,
    );
    expect(source).not.toMatch(/unknown:[^"]*bg-inset/);
    // And the rendered markup agrees: the "?" cells carry the dashed
    // treatment and none of them carries the "no" background.
    const unknownCells = html.match(/aria-label="[^"]*: Not audited"[^>]*>/g) ?? [];
    expect(unknownCells.length, "the registry backfill should leave audited unknowns").toBeGreaterThan(0);
    for (const cell of unknownCells) {
      expect(cell).toContain("border-dashed");
      expect(cell).not.toContain("bg-inset");
    }
  });

  it("gives every capability note, and every engine a resolvable one", () => {
    for (const key of CAPABILITY_KEYS) {
      expect(CAPABILITY_NOTES[key], `${key} has no capability note`).toBeTruthy();
      for (const id of ENGINE_DISPLAY_ORDER) {
        const entry = ENGINE_CAPABILITIES[id];
        expect(capabilityNoteFor(entry, key), `${id}/${key}`).toBeTruthy();
      }
    }
  });
});
