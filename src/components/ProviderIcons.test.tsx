import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ProviderMark, MuseCodeMark, MiniMaxMark } from "./ProviderIcons";

function markup(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

describe("MuseCodeMark", () => {
  it("draws real artwork, not the two-letter monogram fallback", () => {
    // Muse Code had no case in `ProviderMark`, so the engine rail rendered a
    // bare "M" — the one tile that looked like a placeholder next to real
    // marks.  A monogram is a text node with no <svg> at all.
    const svg = markup(<MuseCodeMark size={18} />);
    expect(svg).toContain("<svg");
    expect(svg).not.toContain(">M<");
  });

  it("is the Meta loop in the brand blue, not an arbitrary colour", () => {
    const svg = markup(<MuseCodeMark size={18} />);
    expect(svg).toMatch(/#087cf0/i);
    expect(svg).not.toContain("linearGradient");
    expect(svg.match(/<path/g)).toHaveLength(1);
  });

  it("resolves through ProviderMark for both driver kinds", () => {
    for (const kind of ["muse", "museAgent"]) {
      const svg = markup(<ProviderMark driverKind={kind} size={18} />);
      expect(svg).toContain("<svg");
      expect(svg).toMatch(/#087cf0/i);
    }
  });

  it("keeps the artwork inside the square slot it is drawn in", () => {
    // The compact source uses its canonical 24px icon box, which keeps the
    // cut-out loop centered and consistent with the other rail icons.
    const svg = markup(<MuseCodeMark size={18} />);
    const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1] ?? "";
    const [, , w, h] = viewBox.split(/\s+/).map(Number);
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
    expect(w / h).toBe(1);
  });
});

describe("MiniMaxMark", () => {
  it("uses MiniMax's own red-to-orange palette, not the blue rebrand", () => {
    // The mark was painted navy-to-blue, which is why it read as an anonymous
    // squiggle rather than a logo.
    const svg = markup(<MiniMaxMark size={18} />);
    expect(svg).toMatch(/#E5195F/i);
    expect(svg).toMatch(/#FF6B35/i);
    // The old Harness-rebrand ramp must be gone.
    expect(svg).not.toMatch(/#0A2540/i);
    expect(svg).not.toMatch(/#1E40AF/i);
  });
});

describe("ProviderMark monogram fallback", () => {
  it("still monograms an engine we hold no artwork for", () => {
    // The fallback is still correct behaviour for a genuinely unknown engine;
    // this guards the Muse fix against being "solved" by deleting it.
    const svg = markup(<ProviderMark driverKind="totallyUnknownEngine" size={18} />);
    expect(svg).not.toContain("<svg");
  });
});

import { createElement } from "react";

// Every other provider mark paints one token, and no theme can hand it
// another one.
//
// Why this suite exists (owner, 2026-10-10): the engine rail in the model picker
// showed most logos in the theme's accent colour. Two causes, both invisible to
// the type checker, so both get pinned here:
//
//   1. Marks that inherited `--color-ink` followed whatever the palette's main
//      text was. Put main text on the accent and every logo became an accent
//      chip.
//   2. Marks that carried their brand's paint (DeepSeek #4D6BFE, Claude
//      #D97757, three gradient stacks) put ten palettes side by side.
//
// A mark is a silhouette: the shape is what tells one engine from another. So
// the assertion is on the rendered markup — every neutral mark must name the
// mark token and carry no paint of its own — which fails the moment anyone
// adds `fill="#D97757"` back, without anyone having to notice a screenshot.
//
// Scope after the rebase onto #1047: the MiniMax and Muse Code marks deliberately
// wear their fixed brand paint (red-to-orange gradient, compact Meta blue) so the
// rail tiles read as logos rather than placeholders. Those four driver kinds
// live in BRAND_KINDS below with their own theme-immunity assertion instead of
// this loop. Re-neutralising them is a product call for Jay, not a cleanup.
/** Driver kinds the picker renders through a neutral mark.  A new engine that
 *  reaches ProviderMark through one of these paths must obey the same rule. */
const DRIVER_KINDS = [
  "grok",
  "grokAgent",
  "deepseek",
  "deepseekAgent",
  "dsh",
  "dshAgent",
  "claude",
  "claudeAgent",
  "codex",
  "openai",
  "openai-compat",
  "kimi",
  "kimiAgent",
  "droid",
  "droidAgent",
  "cursor",
  "cursorAgent",
  "gemini",
  "geminiAgent",
  "antigravity",
  "antigravityAgent",
  "opencodeGo",
  "qwenAgent",
  "hermesAgent",
  "boxAgent",
  "localModels",
  "piAgent",
  // Unregistered: falls through to the two-letter monogram.
  "museSparkAgent",
] as const;

/** Driver kinds that deliberately wear fixed brand paint (#1047). Fixed means
 *  no theme can recolor them either — the assertion below pins exactly that:
 *  brand paint with no theme hook, never the accent. */
const BRAND_KINDS = ["minimax", "minimaxAgent", "mcode", "mcodeAgent", "muse", "museAgent"] as const;

function markupFor(kind: string): string {
  return renderToStaticMarkup(createElement(ProviderMark, { driverKind: kind, size: 16 }));
}

describe("provider marks", () => {
  it("paints the mark token and no paint of its own", () => {
    for (const kind of DRIVER_KINDS) {
      const html = markupFor(kind);
      // The token, by class.  Cursor is the one raster mark (a monochrome PNG
      // that inverts in dark mode), so it has no fill to check.
      if (kind !== "cursor" && kind !== "cursorAgent") {
        expect(html, `${kind} must name the mark token`).toMatch(/class="[^"]*\b(fill-mark|text-mark)\b/);
      }
      // No paint of its own: no hex, no named colour, no gradient reference, no
      // custom property on the element or any of its paths.  `fill="currentColor"`
      // is the one allowed spelling, and it is still neutral — the mark token
      // arrives as the element's text colour, which is how the lucide-style
      // marks (Hermes) and the monogram paint.
      for (const fill of html.match(/\sfill="([^"]*)"/g) ?? []) {
        expect(fill, `${kind} must not carry an inline fill`).toMatch(/^\sfill="(currentColor|none)"$/);
      }
      expect(html, `${kind} must not reference a gradient`).not.toContain("url(#");
      expect(html, `${kind} must not name a custom property`).not.toContain("var(--");
      // And it can never be the accent, whichever way it is spelled.
      expect(html, `${kind} must not name the accent`).not.toMatch(/color-accent/);
    }
  });

  it("keeps the deliberate brand marks theme-immune too", () => {
    // MiniMax and Muse Code wear fixed brand paint by product decision (#1047),
    // so they are exempt from the neutral loop above — but the exemption ends
    // there. Their static markup must name no theme hook at all (no custom
    // property, no accent, no ink token), which is what makes a palette unable
    // to recolor them, and must still carry the deliberate paint.
    for (const kind of BRAND_KINDS) {
      const html = markupFor(kind);
      expect(html, `${kind} must name no theme hook`).not.toContain("var(--");
      expect(html, `${kind} must never be the accent`).not.toMatch(/color-accent|color-ink/);
      expect(html, `${kind} must carry its deliberate brand paint`).toMatch(/#[0-9a-fA-F]{6}|url\(#/);
    }
  });

  it("renders every driver kind as some mark, not an empty box", () => {
    for (const kind of [...DRIVER_KINDS, ...BRAND_KINDS]) {
      expect(markupFor(kind).length, `${kind} rendered nothing`).toBeGreaterThan(20);
    }
  });

  it("keeps the monogram fallback on the mark token too", () => {
    // An unregistered engine used to fall back to `text-ink-secondary`, which
    // is how two logos in the same rail could differ in tone.
    expect(markupFor("museSparkAgent")).toContain("text-mark");
  });

  it("keeps a mark routed from a model id theme-immune too", () => {
    // The picker resolves the mark from the model name when it can, so a row
    // can be painted by a path this loop above never names. A MiniMax model on
    // the DSH engine reaches the deliberate brand mark by model, not by driver
    // kind — so it carries the brand paint, pinned theme-hook-free per above.
    const html = renderToStaticMarkup(
      createElement(ProviderMark, { driverKind: "dshAgent", model: "MiniMax-M3.1-Flash-Preview", size: 16 }),
    );
    expect(html).not.toContain("var(--");
    expect(html).not.toMatch(/color-accent|color-ink/);
    expect(html).toMatch(/#[0-9a-fA-F]{6}|url\(#/);

    // A Claude model on an engine that is not the Claude engine stays neutral.
    const routed = renderToStaticMarkup(
      createElement(ProviderMark, { driverKind: "grok", model: "claude-sonnet-5", size: 16 }),
    );
    expect(routed).toContain("fill-mark");
    expect(routed).not.toMatch(/color-accent/);
  });
});
