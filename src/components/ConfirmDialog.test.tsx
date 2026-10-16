// What ConfirmDialog draws, SSR style like the repo's other component tests:
// no DOM, no focus assertions — the rendered buttons are the evidence.
//
// Most callers ask one question and get two answers.  A caller with a real
// question to ask needs three, and the third must NOT land in the Cancel
// slot: Escape and the Cancel button both mean "change nothing", so an
// affirmative outcome put there would fire on a dismiss.
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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