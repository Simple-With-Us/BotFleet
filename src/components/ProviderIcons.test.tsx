// Every provider mark paints one token, and no theme can hand it another one.
//
// Why this file exists (owner, 2026-10-10): the engine rail in the model picker
// showed most logos in the theme's accent colour. Two causes, both invisible to
// the type checker, so both get pinned here:
//
//   1. Marks that inherited `--color-ink` followed whatever the palette's main
//      text was. Put main text on the accent and every logo became an accent
//      chip.
//   2. Marks that carried their brand's paint (DeepSeek #4D6BFE, Claude
//      #D97757, three gradient stacks) put ten palettes side by side.
//
// A brand mark is a silhouette: the shape is what tells one engine from
// another. So the assertion is on the rendered markup — every mark must name
// the mark token and carry no paint of its own — which fails the moment anyone
// adds `fill="#D97757"` back, without anyone having to notice a screenshot.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ProviderMark } from "./ProviderIcons.tsx";

/** Driver kinds the picker renders.  A new engine that reaches
 *  ProviderMark through one of these paths must obey the same rule. */
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
  "minimax",
  "minimaxAgent",
  "mcode",
  "mcodeAgent",
  "hermesAgent",
  "boxAgent",
  "localModels",
  "piAgent",
  // Unregistered: falls through to the two-letter monogram.
  "museSparkAgent",
] as const;

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

  it("renders every driver kind as some mark, not an empty box", () => {
    for (const kind of DRIVER_KINDS) {
      expect(markupFor(kind).length, `${kind} rendered nothing`).toBeGreaterThan(20);
    }
  });

  it("keeps the monogram fallback on the mark token too", () => {
    // An unregistered engine used to fall back to `text-ink-secondary`, which
    // is how two logos in the same rail could differ in tone.
    expect(markupFor("museSparkAgent")).toContain("text-mark");
  });

  it("keeps a mark routed from a model id neutral too", () => {
    // The picker resolves the mark from the model name when it can, so a row
    // can be painted by a path this loop above never names.  A MiniMax model on
    // the DSH engine is the case that reaches the MiniMax mark by model, not by
    // driver kind — and it is the one that used to arrive pre-painted.
    const html = renderToStaticMarkup(
      createElement(ProviderMark, { driverKind: "dshAgent", model: "MiniMax-M3.1-Flash-Preview", size: 16 }),
    );
    expect(html).toContain("fill-mark");
    for (const fill of html.match(/\sfill="([^"]*)"/g) ?? []) expect(fill).toMatch(/currentColor|none/);
    expect(html).not.toMatch(/color-accent|url\(#/);

    // Same for a Claude model on an engine that is not the Claude engine.
    const routed = renderToStaticMarkup(
      createElement(ProviderMark, { driverKind: "grok", model: "claude-sonnet-5", size: 16 }),
    );
    expect(routed).toContain("fill-mark");
    expect(routed).not.toMatch(/color-accent/);
  });
});