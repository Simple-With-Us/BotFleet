import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { clearItemIoCache, primeItemIo } from "@/lib/item-io";
import type { ContextInjectionRef } from "../../shared/context-injection";
import { ContextInjectionRow, ContextInjectionRows } from "./ContextInjectionRows";

afterEach(() => clearItemIoCache());

const memory: ContextInjectionRef = { id: "ctx-1", source: "memory", preview: "likes tea and quiet", bytes: 412 };
const handoff: ContextInjectionRef = { id: "ctx-2", source: "handoff", preview: "You are joining this conversation mid-thread", bytes: 4300 };

describe("the closed row", () => {
  it("reads as a quiet footnote: label, preview, size", () => {
    const html = renderToStaticMarkup(createElement(ContextInjectionRow, { entry: memory, threadId: "t" }));
    expect(html).toContain("Context injection · memory");
    expect(html).toContain("likes tea and quiet");
    expect(html).toContain("412 B");
    expect(html).toContain('aria-expanded="false"');
    // dimmer than a tool row
    expect(html).toContain("text-ink-secondary/70");
    expect(html).not.toContain("data-io");
  });

  it("names each source in its own words", () => {
    const html = renderToStaticMarkup(createElement(ContextInjectionRows, { entries: [memory, handoff], threadId: "t" }));
    expect(html).toContain("Context injection · memory");
    expect(html).toContain("Context injection · handoff");
    expect(html).toContain("4.2 KB");
    expect(html).toContain('role="group"');
  });

  it("renders nothing for a message with no injections", () => {
    expect(renderToStaticMarkup(createElement(ContextInjectionRows, { entries: undefined, threadId: "t" }))).toBe("");
    expect(renderToStaticMarkup(createElement(ContextInjectionRows, { entries: [], threadId: "t" }))).toBe("");
  });
});

describe("the opened row", () => {
  const open = (entry: ContextInjectionRef) =>
    renderToStaticMarkup(createElement(ContextInjectionRow, { entry, threadId: "t", defaultOpen: true }));

  it("shows the full text the model was given, with a Copy button", () => {
    primeItemIo(
      { threadId: "t", itemId: "ctx-1" },
      {
        status: "loaded",
        io: { itemId: "ctx-1", at: "2026-09-30T20:00:00.000Z", text: { text: "likes tea\nand quiet\nhates meetings", truncated: false, length: 34 } },
      },
    );
    const html = open(memory);
    expect(html).toContain('data-io="text"');
    expect(html).toContain("likes tea\nand quiet\nhates meetings");
    expect(html).toContain(">Copy<");
    expect(html).toContain("The bot&#x27;s own MEMORY.md, added to its prompt.");
    expect(html).toContain('aria-expanded="true"');
  });

  it("says when the text was cut", () => {
    primeItemIo(
      { threadId: "t", itemId: "ctx-2" },
      {
        status: "loaded",
        io: { itemId: "ctx-2", at: "2026-09-30T20:00:00.000Z", text: { text: "x".repeat(32768), truncated: true, length: 131072 } },
      },
    );
    expect(open(handoff)).toContain("Truncated — showing first 32,768 of 131,072 characters");
  });

  it("keeps the preview and says so when the text was never recorded", () => {
    primeItemIo({ threadId: "t", itemId: "ctx-1" }, { status: "unavailable" });
    const html = open(memory);
    expect(html).toContain("likes tea and quiet");
    expect(html).toContain("Full input and output weren&#x27;t recorded for this step.");
  });

  it("shows the preview and a loading note while the text is on its way", () => {
    const html = open(memory);
    expect(html).toContain("likes tea and quiet");
    expect(html).toContain("Loading the full input and output…");
  });

  it("escapes what was injected", () => {
    primeItemIo(
      { threadId: "t", itemId: "ctx-1" },
      { status: "loaded", io: { itemId: "ctx-1", at: "x", text: { text: "<img src=x onerror=alert(1)>", truncated: false, length: 28 } } },
    );
    const html = open(memory);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
