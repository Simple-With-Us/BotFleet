// SSR test for the footer chips.  Popover panels are closed on first render,
// so this pins the chips themselves; the panel rows come from the same pure
// derivations that thread-stats.test.ts covers.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TaskStats, TaskUsage } from "@/state/store";
import { ThreadStatsBar } from "./ThreadStatsBar.tsx";

const usage = (over: Partial<TaskUsage> = {}): TaskUsage => ({ input: 600_000, output: 45_000, cachedInput: 546_000, costUsd: 1.23, turns: 2, ...over });
const stats = (over: Partial<TaskStats> = {}): TaskStats => ({
  turns: 2,
  steps: 27,
  modelMs: 280_000,
  toolMs: 1_336_000,
  ttftMsSum: 3_000,
  ttftSamples: 2,
  tpsTokens: 9_200,
  tpsMs: 100_000,
  ...over,
});
const render = (props: { stats?: TaskStats; usage?: TaskUsage }) => renderToStaticMarkup(createElement(ThreadStatsBar, props));
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

describe("ThreadStatsBar", () => {
  it("shows both chips with the figures a full thread has", () => {
    const html = render({ stats: stats(), usage: usage() });
    const t = text(html);
    expect(t).toContain("2 turns · 27 steps · 92 tok/s");
    expect(t).toContain("645k tok · Cache hit 91%");
    expect(html).toContain('aria-label="Session Summary"');
    expect(html.match(/aria-haspopup="dialog"/g)).toHaveLength(2);
  });

  it("names each chip with every figure, spaced, so a screen reader does not fuse them", () => {
    // the visible spans sit side by side with no text between them
    // ("2 turns27 steps"), and the narrow-width ones are display:none, so the
    // accessible name has to be an explicit, complete label
    const html = render({ stats: stats(), usage: usage() });
    expect(html).toContain('aria-label="Session Statistics: 2 turns, 27 steps, 92 tok/s"');
    expect(html).toContain('aria-label="Token Usage: 645k tok, cache hit 91%"');
    // each label contains the chip's visible text, so voice control can say it
    for (const visible of ["2 turns", "27 steps", "92 tok/s", "645k tok", "91%"]) expect(html).toContain(visible);
  });

  it("leaves unknown figures out of the accessible name too", () => {
    const html = render({ stats: stats({ steps: 0, tpsTokens: undefined, tpsMs: undefined }), usage: usage({ cachedInput: undefined }) });
    expect(html).toContain('aria-label="Session Statistics: 2 turns"');
    expect(html).toContain('aria-label="Token Usage: 645k tok"');
  });

  it("renders nothing when there is neither timing nor spend", () => {
    expect(render({})).toBe("");
    expect(render({ usage: usage({ input: 0, output: 0, cachedInput: undefined, turns: 1 }) })).toBe("");
  });

  it("hides the stats chip for a thread from before timing was recorded, keeping the token chip", () => {
    const t = text(render({ usage: usage() }));
    expect(t).not.toContain("turns");
    expect(t).toContain("645k tok");
  });

  it("leaves steps and tok/s out when they are unknown, never as a zero", () => {
    const t = text(render({ stats: stats({ steps: 0, tpsTokens: undefined, tpsMs: undefined }), usage: usage() }));
    expect(t).toContain("2 turns");
    expect(t).not.toContain("0 steps");
    expect(t).not.toContain("tok/s");
  });

  it("leaves the cache hit out for an engine that reports none", () => {
    const t = text(render({ usage: usage({ cachedInput: undefined }) }));
    expect(t).toContain("645k tok");
    expect(t).not.toContain("Cache hit");
  });

  it("sheds tok/s first, then steps, then the cache hit as the footer narrows", () => {
    const html = render({ stats: stats(), usage: usage() });
    // the container-query threshold on the span that holds each piece
    const threshold = (needle: string) => {
      // ">" so this finds the visible text, not the same words in an aria-label
      const at = html.indexOf(`>${needle}`);
      const before = html.slice(Math.max(0, at - 260), at);
      const found = [...before.matchAll(/@min-\[(\d+)rem\]\/statsbar:inline/g)].at(-1);
      return found ? Number(found[1]) : undefined;
    };
    const rate = threshold("92 tok/s");
    const steps = threshold("27 steps");
    const cache = threshold("Cache hit 91%");
    expect(rate).toBeDefined();
    expect(steps).toBeDefined();
    expect(cache).toBeDefined();
    expect(rate!).toBeGreaterThan(steps!);
    expect(steps!).toBeGreaterThan(cache!);
    // the turn count and the token total never hide
    expect(html).toMatch(/<span>2 turns<\/span>/);
    expect(html).toMatch(/<span>645k tok<\/span>/);
  });

  it("uses theme tokens only, so every skin and both themes read correctly", () => {
    const html = render({ stats: stats(), usage: usage() });
    expect(html).toContain("text-ink-secondary");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/\b(?:bg|text|border)-(?:white|black|gray|slate|zinc|neutral)/);
  });
});
