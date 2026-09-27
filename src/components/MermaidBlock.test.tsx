// MermaidBlock shape tests — this repo's renderer tests are SSR-only
// (`react-dom/server`'s `renderToStaticMarkup`, see EngineCallout.test.tsx
// and ChatView.test.tsx): no jsdom or @testing-library/react is installed,
// and SSR never runs effects. The diagram render lives entirely inside a
// `useEffect`, so a passing SSR render — with the "mermaid" module mocked to
// throw if anything reaches for it — is itself the proof that mounting the
// placeholder shell never imports mermaid.
//
// The settle-then-render, cache, and error-line behavior all run inside
// that same effect, which SSR cannot exercise; those are pinned from the
// source instead, the same technique ChatView.test.tsx and sentry.test.ts
// use for effect-driven behavior a renderer test in this suite cannot
// observe.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MermaidBlock } from "./MermaidBlock";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "MermaidBlock.tsx"), "utf8");

vi.mock("mermaid", () => {
  throw new Error("MermaidBlock must not import mermaid over SSR — the render lives inside useEffect, which SSR never runs");
});

describe("MermaidBlock", () => {
  it("renders the raw-source placeholder shell over SSR without importing mermaid", () => {
    const code = "flowchart LR\n  Ship-->Sea";
    const html = renderToStaticMarkup(createElement(MermaidBlock, { code, streaming: false }));
    expect(html).toContain("Mermaid diagram");
    // the raw-source <pre> fallback is what's on screen — mermaid.render()
    // only ever resolves inside a useEffect, which SSR never runs, so the
    // svg state stays null and this is the only content path taken. (The
    // copy button's Lucide icon is itself an inline <svg>, so we assert on
    // the fallback element rather than the absence of any <svg> tag.)
    expect(html).toContain("<pre");
    expect(html).toContain("flowchart LR");
    expect(html).not.toContain('role="alert"');
  });

  it("renders the same shell for a still-streaming fence", () => {
    const html = renderToStaticMarkup(
      createElement(MermaidBlock, { code: "flowchart LR\n  Ship", streaming: true }),
    );
    expect(html).toContain("Mermaid diagram");
    expect(html).toContain("<pre");
  });

  it("imports mermaid only dynamically, inside the settle effect — never at module scope", () => {
    expect(SRC).not.toContain('from "mermaid"');
    expect(SRC).toContain('import("mermaid")');
  });

  it("copies the diagram source, not the rendered SVG", () => {
    expect(SRC).toContain("navigator.clipboard?.writeText(code)");
    const html = renderToStaticMarkup(createElement(MermaidBlock, { code: "flowchart LR\nA-->B", streaming: false }));
    expect(html).toContain('aria-label="Copy Diagram Source"');
    expect(SRC).toContain("This diagram could not be drawn. The source is below.");
    expect(SRC).not.toContain("cause.message");
  });

  // Sentry bug-prediction review on PR #633: the non-streaming render path
  // called render() without first clearing svg/error, so a settled block
  // whose code (or theme) changed briefly kept showing the *previous*
  // diagram or error line while the new render was in flight. The clear
  // must run unconditionally, before the streaming/non-streaming branch —
  // not only inside the streaming branch — so both paths drop stale state
  // the instant the effect re-runs for new code.
  it("clears stale svg/error state before every render, not only the streaming path", () => {
    const settleEffect = SRC.slice(SRC.indexOf("useEffect(() => {"), SRC.indexOf("if (streaming) {"));
    expect(settleEffect).toContain("setSvg(null)");
    expect(settleEffect).toContain("setError(null)");
  });
});
