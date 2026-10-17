// @vitest-environment happy-dom
// What ConfirmDialog draws, SSR style like the repo's other component tests:
// no DOM, no focus assertions — the rendered buttons are the evidence.
//
// Most callers ask one question and get two answers.  A caller with a real
// question to ask needs three, and the third must NOT land in the Cancel
// slot: Escape and the Cancel button both mean "change nothing", so an
// affirmative outcome put there would fire on a dismiss.
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "./ConfirmDialog";

const render = (props: Partial<ComponentProps<typeof ConfirmDialog>> = {}) =>
  renderToStaticMarkup(
    createElement(ConfirmDialog, {
      open: true,
      title: "Delete Scout?",
      body: "This cannot be undone.",
      onCancel: () => {},
      onConfirm: () => {},
      ...props,
    }),
  );

const buttons = (html: string) => html.match(/<button/g) ?? [];

describe("ConfirmDialog", () => {
  it("renders nothing at all when closed", () => {
    expect(render({ open: false })).toBe("");
  });

  it("draws exactly two buttons by default, so every existing caller is unchanged", () => {
    const html = render({ confirmLabel: "Delete", cancelLabel: "Cancel" });
    expect(html).toContain(">Delete</button>");
    expect(html).toContain(">Cancel</button>");
    expect(buttons(html)).toHaveLength(2);
  });

  it("draws a third action between Cancel and Confirm when one is given", () => {
    const html = render({
      cancelLabel: "Keep It On",
      altLabel: "Power Off After This Turn",
      confirmLabel: "Stop It And Power Off",
      onAlt: () => {},
    });
    expect(html).toContain(">Keep It On</button>");
    expect(html).toContain(">Power Off After This Turn</button>");
    expect(html).toContain(">Stop It And Power Off</button>");
    expect(buttons(html)).toHaveLength(3);
    // order matters: keep it on, then the reversible choice, then the
    // destructive one — destructive stays rightmost where a muscle memory
    // already expects it
    expect(html.indexOf("Keep It On")).toBeLessThan(html.indexOf("Power Off After This Turn"));
    expect(html.indexOf("Power Off After This Turn")).toBeLessThan(html.indexOf("Stop It And Power Off"));
  });

  it("draws no third button when a label arrives without a handler", () => {
    // A label with nothing to call is a promise with no action behind it, so
    // it is not offered at all.
    const html = render({ altLabel: "Power Off After This Turn" });
    expect(html).not.toContain("Power Off After This Turn");
    expect(buttons(html)).toHaveLength(2);
  });

  it("wraps the button row so three long labels cannot overflow the dialog", () => {
    const html = render({ altLabel: "Power Off After This Turn", onAlt: () => {} });
    expect(html).toContain("flex-wrap");
  });
});

// The focus half of the dialog, in a DOM, because it is the part SSR cannot
// see.  Callers pass an inline `onCancel`, and this dialog opens over a
// working bot — whose turn keeps streaming — so the parent re-renders while
// the dialog is open.  An effect keyed on that callback re-runs on every one
// of those renders and pulls focus back to the first button, so a person
// tabbing to "Stop It And Power Off" gets yanked back mid-keystroke.
describe("ConfirmDialog focus", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root!.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  const show = (nonce: number) =>
    act(() => {
      root!.render(
        createElement(ConfirmDialog, {
          open: true,
          title: "Scout Is Working",
          body: "Turning Scout off stops new work.",
          confirmLabel: "Stop It And Power Off",
          cancelLabel: "Keep It On",
          altLabel: "Power Off After This Turn",
          // A fresh inline closure every render, exactly as every caller
          // passes it.  `nonce` stands in for the streamed bot update that
          // makes a caller re-render while the dialog is open.
          onCancel: () => {},
          onAlt: () => {},
          onConfirm: () => {},
          nonce,
        } as ComponentProps<typeof ConfirmDialog> & { nonce: number }),
      );
    });

  const focusedLabel = () => document.activeElement?.textContent ?? null;

  it("starts on the reversible answer, not the destructive one", () => {
    show(1);
    expect(focusedLabel()).toBe("Power Off After This Turn");
  });

  it("leaves focus alone when the parent re-renders", () => {
    show(1);
    const button = Array.from(document.querySelectorAll("button")).find(
      (el) => el.textContent === "Stop It And Power Off",
    );
    expect(button).toBeDefined();
    act(() => button!.focus());
    expect(focusedLabel()).toBe("Stop It And Power Off");

    // The turn streams another update and the caller re-renders.
    show(2);
    expect(focusedLabel()).toBe("Stop It And Power Off");
  });

  it("still calls the newest onCancel on Escape", () => {
    const first = vi.fn();
    const second = vi.fn();
    act(() => {
      root!.render(
        createElement(ConfirmDialog, {
          open: true,
          title: "Scout Is Working",
          body: "Turning Scout off stops new work.",
          onCancel: first,
          onAlt: () => {},
          onConfirm: () => {},
        }),
      );
    });
    act(() => {
      root!.render(
        createElement(ConfirmDialog, {
          open: true,
          title: "Scout Is Working",
          body: "Turning Scout off stops new work.",
          onCancel: second,
          onAlt: () => {},
          onConfirm: () => {},
        }),
      );
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    // Holding the callback in a ref must not freeze the stale one.
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});