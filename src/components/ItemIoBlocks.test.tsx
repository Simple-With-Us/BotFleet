import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ITEM_IO_ERROR, ITEM_IO_LOADING, ITEM_IO_UNAVAILABLE, IoBlock, ItemIoBlocks } from "./ItemIoBlocks";

describe("IoBlock", () => {
  it("renders a labelled, focusable, scrollable block", () => {
    const html = renderToStaticMarkup(createElement(IoBlock, { label: "IN", field: { text: "hello", truncated: false, length: 5 } }));
    expect(html).toContain("IN");
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("overflow-auto");
    expect(html).toContain(">hello<");
    expect(html).not.toContain("Truncated");
  });

  it("is a named group, not a landmark, and names its step", () => {
    const f = { text: "hello", truncated: false, length: 5 };
    const named = renderToStaticMarkup(createElement(IoBlock, { label: "OUT", field: f, subject: "Read" }));
    expect(named).toContain('role="group"');
    expect(named).not.toContain('role="region"');
    expect(named).toContain('aria-label="Output of Read"');
    expect(named).toContain('aria-label="Copy output of Read"');
    // without a subject it still says what it is
    const bare = renderToStaticMarkup(createElement(IoBlock, { label: "IN", field: f }));
    expect(bare).toContain('aria-label="Input"');
    expect(bare).toContain('aria-label="Copy input"');
    // the failure label is spoken as an error
    expect(renderToStaticMarkup(createElement(IoBlock, { label: "ERROR", field: f, subject: "Bash" }))).toContain('aria-label="Copy error of Bash"');
  });

  it("does not dim its label with an alpha", () => {
    const html = renderToStaticMarkup(createElement(IoBlock, { label: "IN", field: { text: "x", truncated: false, length: 1 } }));
    expect(html).not.toMatch(/text-ink-secondary\/\d+/);
  });
});

describe("ItemIoBlocks", () => {
  const render = (props: Parameters<typeof ItemIoBlocks>[0]) => renderToStaticMarkup(createElement(ItemIoBlocks, props));

  it("shows the fallback and a loading note while loading", () => {
    const html = render({ state: { status: "loading" }, fallback: createElement("p", null, "headline") });
    expect(html).toContain("headline");
    expect(html).toContain(ITEM_IO_LOADING);
  });

  it("shows the fallback and says nothing was recorded when unavailable", () => {
    const html = render({ state: { status: "unavailable" }, fallback: createElement("p", null, "headline") });
    expect(html).toContain("headline");
    expect(html).toContain("Full input and output weren&#x27;t recorded for this step.");
  });

  it("treats a loaded answer with nothing in it as unavailable", () => {
    const html = render({ state: { status: "loaded", io: { itemId: "a", at: "x" } } });
    expect(html).toContain("recorded for this step");
  });

  it("explains a failure and offers Retry only when it can retry", () => {
    const withRetry = render({ state: { status: "error", message: "offline" }, onRetry: () => undefined });
    expect(withRetry).toContain("Couldn&#x27;t load the full input and output.");
    expect(withRetry).toContain(">Retry<");
    expect(withRetry).toContain('title="offline"');
    expect(render({ state: { status: "error", message: "offline" } })).not.toContain(">Retry<");
  });

  it("shows IN, OUT and TEXT blocks for a loaded answer", () => {
    const f = (text: string) => ({ text, truncated: false, length: text.length });
    const html = render({ state: { status: "loaded", io: { itemId: "a", at: "x", input: f("i"), output: f("o"), text: f("t") } } });
    expect(html).toContain('data-io="in"');
    expect(html).toContain('data-io="out"');
    expect(html).toContain('data-io="text"');
  });

  it("shows the headline in place of the IN block when the step had no arguments", () => {
    const f = (text: string) => ({ text, truncated: false, length: text.length });
    const html = render({
      state: { status: "loaded", io: { itemId: "a", at: "x", output: f("o") } },
      headline: createElement("p", null, "the-target"),
    });
    expect(html).toContain("the-target");
    expect(html.indexOf("the-target")).toBeLessThan(html.indexOf('data-io="out"'));
    // and not alongside a real IN block
    const withInput = render({
      state: { status: "loaded", io: { itemId: "a", at: "x", input: f("i"), output: f("o") } },
      headline: createElement("p", null, "the-target"),
    });
    expect(withInput).not.toContain("the-target");
  });

  it("uses the sentences the rows promise", () => {
    expect(ITEM_IO_UNAVAILABLE).toBe("Full input and output weren't recorded for this step.");
    expect(ITEM_IO_ERROR).toBe("Couldn't load the full input and output.");
    expect(ITEM_IO_LOADING).toBe("Loading the full input and output…");
  });
});
