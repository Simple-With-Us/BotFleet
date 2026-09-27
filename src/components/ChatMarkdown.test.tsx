// ChatMarkdown fence routing — this repo's renderer tests are SSR-only
// (`react-dom/server`'s `renderToStaticMarkup`, see EngineCallout.test.tsx
// and ChatView.test.tsx): no jsdom or @testing-library/react is installed,
// and SSR never runs effects. That makes it a clean place to prove a mermaid
// fence never reaches for the (large, lazily-imported) "mermaid" package
// during SSR: the module factory below throws if anything imports it, and
// since the diagram render only happens inside a `useEffect` — which SSR
// never runs — a passing render() call is itself the proof.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ChatMarkdown } from "./ChatMarkdown";

vi.mock("mermaid", () => {
  throw new Error("ChatMarkdown must not import mermaid while rendering a mermaid fence over SSR");
});

describe("mermaid fences", () => {
  it("renders the diagram placeholder shell instead of the code chrome, without importing mermaid", () => {
    const html = renderToStaticMarkup(
      createElement(ChatMarkdown, { text: "```mermaid\nflowchart LR\n  Ship-->Sea\n```" }),
    );
    expect(html).toContain("Mermaid diagram");
    // the raw-source <pre> fallback is what's on screen — mermaid.render()
    // only ever resolves inside a useEffect, which SSR never runs, so this
    // is the only content path taken.
    expect(html).toContain("<pre");
    expect(html).toContain("flowchart LR");
    // the code chrome's copy title never shows up on the diagram frame
    expect(html).not.toContain("Copy Code");
  });

  it("matches the fence tag case-insensitively", () => {
    const html = renderToStaticMarkup(
      createElement(ChatMarkdown, { text: "```Mermaid\nflowchart LR\n  Ship-->Sea\n```" }),
    );
    expect(html).toContain("Mermaid diagram");
  });

  it("leaves an ordinary fenced code block on the highlighter path, untouched", () => {
    const html = renderToStaticMarkup(
      createElement(ChatMarkdown, { text: "```ts\nconst sea = true;\n```" }),
    );
    expect(html).not.toContain("Mermaid diagram");
    expect(html).toContain("const sea = true;");
    expect(html).toContain(">ts<");
  });
});
