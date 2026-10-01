// SSR tests for an opened tool row.  This repo renders components with
// react-dom/server (no jsdom), and SSR never runs effects, so the row's state
// comes from the same cache a real response is filed in (`primeItemIo`): that
// is exactly how a row reopened in the app paints on its first frame.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { clearItemIoCache, primeItemIo, type ItemIoRef } from "@/lib/item-io";
import type { ItemIoPayload } from "../../shared/item-io";
import { ITEM_IO_LOADING, ITEM_IO_UNAVAILABLE, ItemIoBlocks } from "./ItemIoBlocks";
import { ToolLine } from "./ToolLine";

afterEach(() => clearItemIoCache());

const THREAD = "thread-1";
const ref: ItemIoRef = { threadId: THREAD, itemId: "toolu_1", turnId: "turn-1" };

const message = (tool: Partial<NonNullable<Message["tool"]>> = {}): Message =>
  ({
    id: "m1",
    at: Date.parse("2026-09-30T20:00:00.000Z"),
    role: "bot",
    kind: "activity",
    tool: {
      name: "Bash",
      ok: true,
      target: "ls -la",
      kind: "execute",
      detail: "3 files",
      itemId: "toolu_1",
      turnId: "turn-1",
      ...tool,
    },
  }) as Message;

const payload = (over: Partial<ItemIoPayload> = {}): ItemIoPayload => ({
  itemId: "toolu_1",
  turnId: "turn-1",
  at: "2026-09-30T20:00:00.000Z",
  input: { text: '{\n  "command": "ls -la"\n}', truncated: false, length: 24 },
  output: { text: "a.ts\nb.ts\nc.ts", truncated: false, length: 13 },
  ...over,
});

const render = (m: Message, props: { threadId?: string; defaultOpen?: boolean } = { threadId: THREAD, defaultOpen: true }) =>
  renderToStaticMarkup(createElement(ToolLine, { message: m, ...props }));

describe("an opened tool row with its full input and output", () => {
  it("shows labelled IN and OUT blocks, in monospace, each with a Copy button", () => {
    primeItemIo(ref, { status: "loaded", io: payload() });
    const html = render(message());
    expect(html).toContain('data-io="in"');
    expect(html).toContain('data-io="out"');
    // the JSON arguments, pretty-printed (attribute-escaped quotes)
    expect(html).toContain("&quot;command&quot;: &quot;ls -la&quot;");
    expect(html).toContain("a.ts\nb.ts\nc.ts");
    expect(html).toContain("font-mono");
    expect(html.match(/>Copy</g)).toHaveLength(2);
    // each block and its Copy button name the step, so several open rows do
    // not announce the same bare "IN" and "OUT"
    expect(html).toContain('aria-label="Copy input of Bash"');
    expect(html).toContain('aria-label="Copy output of Bash"');
    expect(html).toContain('aria-label="Input of Bash"');
    expect(html).toContain('aria-label="Output of Bash"');
    // a group, not a landmark: a landmark list would fill with identical names
    expect(html).not.toContain('role="region"');
  });

  it("bounds each block's height and lets it scroll", () => {
    primeItemIo(ref, { status: "loaded", io: payload() });
    const html = render(message());
    expect(html.match(/max-h-56 overflow-auto/g)).toHaveLength(2);
  });

  it("replaces the clipped headline instead of repeating it", () => {
    primeItemIo(ref, { status: "loaded", io: payload() });
    const html = render(message());
    // the clipped "Command" block and the one-line "Output" block are gone
    expect(html).not.toContain(">Command<");
    expect(html).not.toContain(">Output<");
    expect(html).not.toContain(ITEM_IO_UNAVAILABLE);
  });

  it("escapes what a tool printed", () => {
    primeItemIo(ref, {
      status: "loaded",
      io: payload({ output: { text: "<script>alert(1)</script>", truncated: false, length: 25 } }),
    });
    const html = render(message());
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("labels a failed step's output as an error, in the error colour", () => {
    primeItemIo(ref, {
      status: "loaded",
      io: payload({ output: { text: "exit code 2", truncated: false, length: 11 } }),
    });
    const html = render(message({ ok: false, detail: "exit code 2" }));
    expect(html).toContain('data-io="error"');
    expect(html).not.toContain('data-io="out"');
    expect(html).toContain("text-danger");
  });

  it("says plainly what it is not showing when a field was cut", () => {
    primeItemIo(ref, {
      status: "loaded",
      io: payload({ output: { text: "x".repeat(32768), truncated: true, length: 2_410_118 } }),
    });
    const html = render(message());
    expect(html).toContain("Truncated — showing first 32,768 of 2,410,118 characters");
    // and only on the field that was cut
    expect(html.match(/Truncated — showing/g)).toHaveLength(1);
  });

  it("shows only the output for a tool that took no arguments", () => {
    primeItemIo(ref, { status: "loaded", io: payload({ input: undefined }) });
    const html = render(message());
    expect(html).not.toContain('data-io="in"');
    expect(html).toContain('data-io="out"');
  });

  it("keeps the clipped target above the output when the step was recorded without arguments", () => {
    // an engine can report what a call acted on without sending its arguments;
    // the row's own line truncates a long path or command, so the open row must
    // still show it whole
    primeItemIo(ref, { status: "loaded", io: payload({ input: undefined }) });
    const long = "/Users/someone/projects/an-extremely-long-directory-name/src/deeply/nested/file.ts";
    const html = render(message({ target: long, kind: "read" }));
    expect(html).not.toContain('data-io="in"');
    expect(html).toContain('data-io="out"');
    expect(html).toContain(">File<");
    expect(html.indexOf(long)).toBeGreaterThan(-1);
    // the headline comes before the output, as the input block would have
    expect(html.indexOf(">File<")).toBeLessThan(html.indexOf('data-io="out"'));
  });

  it("does not repeat the clipped target when the full input is shown", () => {
    primeItemIo(ref, { status: "loaded", io: payload() });
    const html = render(message({ target: "ls -la", kind: "execute" }));
    expect(html).not.toContain(">Command<");
  });

  it("keeps the one-line result under a recorded input when no output was recorded", () => {
    primeItemIo(ref, { status: "loaded", io: payload({ output: undefined }) });
    const html = render(message({ detail: "3 files" }));
    expect(html).toContain('data-io="in"');
    expect(html).not.toContain('data-io="out"');
    expect(html).toContain("3 files");
  });
});

describe("an opened tool row without its full payload", () => {
  it("says so, and keeps the clipped headline, when nothing was recorded", () => {
    primeItemIo(ref, { status: "unavailable" });
    const html = render(message());
    expect(html).toContain("Full input and output weren&#x27;t recorded for this step.");
    expect(ITEM_IO_UNAVAILABLE).toBe("Full input and output weren't recorded for this step.");
    expect(html).toContain("ls -la");
    expect(html).toContain("3 files");
    expect(html).not.toContain('data-io="in"');
  });

  it("says so for a row recorded before the harness kept a key", () => {
    const html = render(message({ itemId: undefined, turnId: undefined }));
    expect(html).toContain("Full input and output weren&#x27;t recorded for this step.");
    expect(html).toContain("ls -la");
  });

  it("shows a loading note and the clipped headline while the full payload is on its way", () => {
    const html = render(message());
    expect(html).toContain(ITEM_IO_LOADING);
    expect(html).toContain('role="status"');
    expect(html).toContain("ls -la");
  });

  it("offers a retry when loading failed", () => {
    // errors are never cached, so the state is shown through the real blocks
    // the row renders rather than through the cache
    const html = renderToStaticMarkup(
      createElement(ItemIoBlocks, { state: { status: "error", message: "offline" }, onRetry: () => undefined }),
    );
    expect(html).toContain("Couldn&#x27;t load the full input and output.");
    expect(html).toContain(">Retry<");
  });

  it("keeps today's headline and adds nothing for a view that does not know its thread", () => {
    const html = render(message(), { defaultOpen: true });
    expect(html).toContain("ls -la");
    expect(html).toContain("3 files");
    expect(html).not.toContain(ITEM_IO_UNAVAILABLE);
    expect(html).not.toContain(ITEM_IO_LOADING);
    expect(html).not.toContain("data-io");
  });
});

describe("a closed tool row", () => {
  it("renders no payload and asks for none", () => {
    primeItemIo(ref, { status: "loaded", io: payload() });
    const html = render(message(), { threadId: THREAD });
    expect(html).not.toContain("data-io");
    expect(html).toContain('aria-expanded="false"');
  });

  it("is openable for a step the harness may hold the payload of, even with no headline", () => {
    const html = render(message({ target: undefined, detail: undefined, name: "mystery" }), { threadId: THREAD });
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("disabled");
  });

  it("stays unopenable when there is nothing behind it at all", () => {
    const html = render(message({ target: undefined, detail: undefined, name: "mystery", itemId: undefined }), { threadId: THREAD });
    expect(html).toContain("disabled");
  });
});
