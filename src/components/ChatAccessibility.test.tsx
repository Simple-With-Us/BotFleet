import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { CopyButton } from "./CopyButton";

/**
 * Accessibility regression tests for the Mac chat surface.
 *
 * These exist because each of these was a real defect found by measurement,
 * not by inspection: the transcript sits in `role="log" aria-live="polite"`,
 * and the streaming bubble was a child of it, so every token frame rewrote a
 * live node and re-announced the whole bubble. Each test below would fail if
 * the corresponding fix were reverted.
 */

function renderBubble(props: Partial<Parameters<typeof CopyButton>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(CopyButton, {
      text: "hello",
      requestId: "req-123",
      messageId: "msg-456",
      ...props,
    }),
  );
}

describe("CopyButton keyboard access", () => {
  it("exposes the ID menu as a real menu to assistive tech", () => {
    const html = renderBubble();
    // A mouse-only menu needs an explicit role/expanded state, otherwise AT
    // sees an ordinary button with no indication a menu exists.
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
  });

  it("tells keyboard and screen-reader users how to reach the ID menu", () => {
    const html = renderBubble();
    // The old label said only "right-click for ID", which is unreachable by
    // keyboard and meaningless to a screen reader.
    expect(html).toMatch(/Shift\+Enter/);
    expect(html).not.toMatch(/\(right-click for ID\)/i);
  });

  it("omits menu semantics entirely when there is no ID to copy", () => {
    const html = renderToStaticMarkup(createElement(CopyButton, { text: "hello" }));
    expect(html).not.toContain("aria-haspopup");
    expect(html).toContain("Copy Message");
  });
});

describe("streaming isolation (ChatView)", () => {
  it("keeps the streaming bubble out of the transcript live region", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");

    // The transcript container is a polite live region. If the streaming
    // bubble does not open an `aria-live="off"` region of its own, every
    // token frame announces. Assert the pairing exists.
    expect(src).toMatch(/role="log"/);
    expect(src).toMatch(/aria-live="polite"/);

    // The streaming bubble is the one rendered while `streaming` is truthy.
    const streamingBlock = src.match(/\{!popping && streaming \? \([\s\S]*?\n            \) : null\}/);
    expect(streamingBlock).not.toBeNull();
    expect(streamingBlock![0]).toContain('aria-live="off"');
    expect(streamingBlock![0]).toContain('aria-busy="true"');
  });

  it("gives every settled bubble an accessible identity", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
    // An anonymous div announces only its prose — no speaker, no time.
    expect(src).toMatch(/role="article"/);
    expect(src).toMatch(/aria-label=\{`\$\{humanTyped \? "You"/);
  });
});
