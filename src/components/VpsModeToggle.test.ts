import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VpsModeToggle } from "./VpsModeToggle";

describe("VpsModeToggle", () => {
  it("keeps the two-space sentence gap in the per-bot caption", () => {
    // The caption renders in a plain <p>, where two ASCII spaces collapse to
    // one; the copy rule's NBSP + space pair survives HTML whitespace rules.
    const html = renderToStaticMarkup(createElement(VpsModeToggle, { value: "per-bot", onChange: () => {} }));
    expect(html).toContain("loopback viewer.\u00a0 Idle desktops stop on their own after 8 hours.");
    expect(html).not.toMatch(/\. [A-Z]/);
  });

  it("renders the Shared option in the button row", () => {
    const html = renderToStaticMarkup(createElement(VpsModeToggle, { value: "shared", onChange: () => {} }));
    expect(html).toContain("Shared");
    expect(html).toContain('aria-pressed="true"');
  });

  it("keeps the two-space sentence gap in the shared caption", () => {
    const html = renderToStaticMarkup(createElement(VpsModeToggle, { value: "shared", onChange: () => {} }));
    expect(html).toContain("same time.");
    expect(html).toContain("isolated desktop session");
    expect(html).not.toMatch(/\. [A-Z]/);
  });

  it("renders stored shared as Shared, not Per-Bot", () => {
    const html = renderToStaticMarkup(createElement(VpsModeToggle, { value: "shared", onChange: () => {} }));
    // The Shared button should be the active (pressed) one
    expect(html).toMatch(/Shared.*aria-pressed="true"|aria-pressed="true".*Shared/s);
  });
});
