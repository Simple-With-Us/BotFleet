import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { deriveContextMeter, type CompactOffer } from "../../shared/context-meter.ts";
import { CompactSessionRow, ContextFillBadge, ContextNote, ContextUsageStrip } from "./ContextUsage.tsx";

const render = (node: ReturnType<typeof createElement>) => renderToStaticMarkup(node);
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

describe("ContextUsage", () => {
  const full = deriveContextMeter({ used: 910_800, reportedWindow: 1_000_000 });

  it("draws the percent and the token counts the engine reported", () => {
    const html = render(createElement(ContextUsageStrip, {
      meter: full,
      offer: { state: "hidden" } satisfies CompactOffer,
      pending: false,
      error: null,
      onCompact: () => {},
    }));
    const body = text(html);
    expect(body).toContain("91% used");
    expect(body).toContain("910.8k / 1M");
    expect(html).not.toContain("Compact Session");
  });

  it("leaves the percent off when the window was not reported", () => {
    const html = render(createElement(ContextUsageStrip, {
      meter: deriveContextMeter({ used: 12_400 }),
      offer: { state: "hidden" },
      pending: false,
      error: null,
      onCompact: () => {},
    }));
    expect(text(html)).toContain("12.4k tokens used");
    expect(html).not.toContain("role=\"meter\"");
  });

  it("greys compact and keeps the reason", () => {
    const html = render(createElement(ContextUsageStrip, {
      meter: full,
      offer: { state: "disabled", reason: "Available after the first reply." },
      pending: false,
      error: null,
      onCompact: () => {},
    }));
    expect(html).toContain("disabled");
    expect(html).toContain("Available after the first reply.");
    expect(text(html)).toContain("Compact Session");
  });

  it("puts one note in the thread with the compact link", () => {
    const html = render(createElement(ContextNote, {
      pending: false,
      disabledReason: null,
      onCompact: () => {},
    }));
    expect(html.match(/data-context-note="once"/g)).toHaveLength(1);
    expect(text(html)).toContain("Compacting before your next message");
    expect(text(html)).toContain("Compact Session");
  });

  it("badges a known fill and skips an unknown one", () => {
    expect(text(render(createElement(ContextFillBadge, { meter: full })))).toBe("91%");
    expect(render(createElement(ContextFillBadge, { meter: deriveContextMeter({ used: 10 }) }))).toBe("");
  });

  it("says in the thread when a compaction happened", () => {
    expect(text(render(createElement(CompactSessionRow, { settled: false })))).toBe("Compacting this session.");
    expect(text(render(createElement(CompactSessionRow, { settled: true })))).toBe("Compacted this session.");
  });
});
