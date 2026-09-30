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

  it("uses the sentences the rows promise", () => {
    expect(ITEM_IO_UNAVAILABLE).toBe("Full input and output weren't recorded for this step.");
    expect(ITEM_IO_ERROR).toBe("Couldn't load the full input and output.");
    expect(ITEM_IO_LOADING).toBe("Loading the full input and output…");
  });
});
