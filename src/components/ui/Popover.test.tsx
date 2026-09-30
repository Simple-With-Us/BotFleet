// Popover: SSR markup (closed and open) plus the pure placement math.  This
// repo's component tests are server-render only — no jsdom, no Testing
// Library — so the interactive behavior (hover intent, focus, pin, Escape,
// outside press) is pinned by source below where a runtime test cannot see it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Popover, placePopover, POPOVER_ANCHOR_GAP, POPOVER_VIEWPORT_MARGIN } from "./Popover.tsx";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "Popover.tsx"), "utf8");
const M = POPOVER_VIEWPORT_MARGIN;
const G = POPOVER_ANCHOR_GAP;

const render = (props: { defaultOpen?: boolean; titleAside?: string } = {}) =>
  renderToStaticMarkup(
    createElement(Popover, {
      title: "Session Statistics",
      trigger: "2 turns",
      className: "chip",
      children: createElement("p", null, "Body"),
      ...props,
    }),
  );

describe("Popover markup", () => {
  it("renders only a labelled trigger while closed", () => {
    const html = render();
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('type="button"');
    expect(html).toContain("2 turns");
    // closed: no dialog, no body, and nothing for aria-controls to point at
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("Body");
    expect(html).not.toContain("aria-controls");
  });

  it("renders a dialog named by its heading, wired to the trigger, when open", () => {
    const html = render({ defaultOpen: true, titleAside: "645k tokens" });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Session Statistics");
    expect(html).toContain("645k tokens");
    expect(html).toContain("Body");
    const controls = /aria-controls="([^"]+)"/.exec(html)?.[1];
    expect(controls).toBeTruthy();
    // the dialog carries the id the trigger controls
    expect(html).toContain(`id="${controls}"`);
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(labelledBy).toBeTruthy();
    // ...and is named by the heading inside it
    expect(html).toMatch(new RegExp(`<h3 id="${labelledBy!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>Session Statistics</h3>`));
    // not modal: it is a peek, so it must not claim the page
    expect(html).not.toContain("aria-modal");
  });

  it("starts hidden until it has been measured, so it never flashes at 0,0", () => {
    expect(render({ defaultOpen: true })).toContain("visibility:hidden");
  });

  it("animates only for people who have not asked for reduced motion", () => {
    const html = render({ defaultOpen: true });
    expect(html).toContain("motion-safe:animate-pop-in");
    expect(html).not.toMatch(/(^|[\s"])animate-pop-in/);
  });
});

describe("Popover behavior (pinned by source)", () => {
  it("opens on hover and keyboard focus, and click pins", () => {
    expect(SRC).toContain("onPointerEnter={enter}");
    expect(SRC).toContain("onFocus={onFocus}");
    expect(SRC).toContain('matches(":focus-visible")');
    expect(SRC).toContain("onClick={onClick}");
    expect(SRC).toContain("setPinned(true)");
  });

  it("ignores the emulated touch hover, so a tap pins instead of flashing", () => {
    expect(SRC).toContain('event.pointerType === "touch"');
  });

  it("closes on Escape and on a press outside the trigger and panel", () => {
    expect(SRC).toContain('event.key !== "Escape"');
    expect(SRC).toContain('addEventListener("pointerdown"');
    expect(SRC).toContain("triggerRef.current?.contains(target)");
    expect(SRC).toContain("panelRef.current?.contains(target)");
  });

  it("portals to body and re-places on resize, scroll, and its own size changes", () => {
    expect(SRC).toContain("createPortal(panel, document.body)");
    expect(SRC).toContain('addEventListener("resize", place)');
    expect(SRC).toContain('addEventListener("scroll", place, true)');
    expect(SRC).toContain("new ResizeObserver(place)");
  });
});

describe("placePopover", () => {
  const viewport = { width: 1000, height: 700 };
  const panel = { width: 240, height: 120 };

  it("sits above the trigger, centered on it", () => {
    const anchor = { top: 600, left: 400, width: 100, height: 20 };
    expect(placePopover(anchor, panel, viewport)).toEqual({
      placement: "top",
      top: 600 - G - panel.height,
      left: 450 - panel.width / 2,
    });
  });

  it("clamps to the left and right edges", () => {
    expect(placePopover({ top: 600, left: 0, width: 40, height: 20 }, panel, viewport).left).toBe(M);
    expect(placePopover({ top: 600, left: 960, width: 40, height: 20 }, panel, viewport).left).toBe(viewport.width - panel.width - M);
  });

  it("flips below when there is no room above but room below", () => {
    const anchor = { top: 40, left: 400, width: 100, height: 20 };
    const placed = placePopover(anchor, panel, viewport);
    expect(placed.placement).toBe("bottom");
    expect(placed.top).toBe(60 + G);
  });

  it("stays above when it fits there, even if below has more room", () => {
    expect(placePopover({ top: 300, left: 400, width: 100, height: 20 }, panel, viewport).placement).toBe("top");
  });

  it("picks the roomier side when it fits on neither, and still stays inside the viewport", () => {
    const tall = { width: 240, height: 900 };
    const placed = placePopover({ top: 500, left: 400, width: 100, height: 20 }, tall, viewport);
    expect(placed.placement).toBe("top"); // 484 above vs 152 below
    expect(placed.top).toBe(M);
  });

  it("pins a panel wider than the viewport to the margin instead of a negative left", () => {
    expect(placePopover({ top: 600, left: 10, width: 40, height: 20 }, { width: 2000, height: 100 }, viewport).left).toBe(M);
  });

  it("honors a preference for below and flips up only when below has no room", () => {
    expect(placePopover({ top: 100, left: 400, width: 100, height: 20 }, panel, viewport, "bottom").placement).toBe("bottom");
    expect(placePopover({ top: 660, left: 400, width: 100, height: 20 }, panel, viewport, "bottom").placement).toBe("top");
  });
});
