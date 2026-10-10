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
    expect(svg).toMatch(/#0081fb/i);
    expect(svg).toContain("bf-muse-grad-1");
  });

  it("resolves through ProviderMark for both driver kinds", () => {
    for (const kind of ["muse", "museAgent"]) {
      const svg = markup(<ProviderMark driverKind={kind} size={18} />);
      expect(svg).toContain("<svg");
      expect(svg).toMatch(/#0081fb/i);
    }
  });

  it("keeps the artwork inside the square slot it is drawn in", () => {
    // The source asset shipped a padded viewBox that floated the glyph
    // off-centre.  Assert the box is tight around the artwork rather than
    // eyeballing it:  the glyph is wider than tall, so the viewBox must be too.
    const svg = markup(<MuseCodeMark size={18} />);
    const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1] ?? "";
    const [, , w, h] = viewBox.split(/\s+/).map(Number);
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
    expect(w / h).toBeGreaterThan(1.3);
    expect(w / h).toBeLessThan(1.7);
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