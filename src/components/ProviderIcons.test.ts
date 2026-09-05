import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProviderMark } from "./ProviderIcons";

const mark = (driverKind: string, props: { size?: number; className?: string } = {}) =>
  renderToStaticMarkup(createElement(ProviderMark, { driverKind, ...props }));

describe("ProviderMark", () => {
  it("falls back to a letter badge for a driver kind it does not know", () => {
    const html = mark("not-a-real-driver");
    expect(html).toContain("<span");
    expect(html).toContain(">N</span>");
    expect(html).not.toContain("<svg");
  });

  it("renders a MiniMax mark rather than the fallback letter badge", () => {
    const html = mark("minimax");
    expect(html).toContain("<svg");
    // the badge is the only <span> this component ever emits, so its absence
    // is what separates "has a mark" from "fell through to the M badge"
    expect(html).not.toContain("<span");
    expect(html).not.toContain(">M</span>");
  });

  it("honours the shared sizing and className contract for the MiniMax mark", () => {
    const html = mark("minimax", { size: 24, className: "opacity-70" });
    expect(html).toContain('width="24"');
    expect(html).toContain('height="24"');
    expect(html).toContain("opacity-70");
  });
});
