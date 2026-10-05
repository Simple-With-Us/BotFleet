// The Routines header is the window drag region in mac-inset Electron chrome:
// `<header style={dragStyle}>` carries `-webkit-app-region: drag`, and that
// region swallows pointer events, so every control left inside it drags the
// window instead of answering a click.  ChatView and GroupView already wrap
// each interactive cluster in `noDragStyle`; the calendar control row is the
// one that was missed (prev/today/next, the bot filter, the 1/3/7-day toggle).
//
// These renderer tests are SSR-only — `react-dom/server`, no jsdom and no
// @testing-library/react — and SSR runs no effects, so a runtime assertion
// cannot see which region a click lands in.  This pins the source instead,
// the same technique ChatView.test.ts uses for renderer behaviour this suite
// cannot observe.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(new URL("./RoutinesPage.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const LINES = SRC.split("\n");
const open = LINES.findIndex((line) => line.trim() === "<header");
const close = LINES.findIndex((line, i) => i > open && line.includes("</header>"));
/** Every control that a drag region would swallow, and the cluster it lives in. */
const CONTROLS = [
  'aria-label="Previous Dates"',
  'aria-label="Next Dates"',
  "<select",
  "setViewDays(days)",
  'onClick={() => setSection("webhooks")}',
  "onClick={() => setAttentionOpen(true)}",
  "onClick={goToday}",
];

describe("RoutinesPage header keeps its controls clickable", () => {
  it("makes exactly one element the window drag region, and it is the header", () => {
    const dragRegions = LINES.filter((line) => line.includes("style={dragStyle}"));
    expect(dragRegions).toHaveLength(1);
    expect(dragRegions[0]).toBe(LINES[open + 1]!);
  });

  it("keeps every header control in a no-drag cluster", () => {
    // Walk out to the nearest ancestor that sets a drag-region style: the
    // file's clusters open their own tags, and an inner wrapper (the date
    // cluster inside the calendar row) sets no style of its own.
    for (const control of CONTROLS) {
      const at = LINES.findIndex((line, i) => i > open && i < close && line.includes(control));
      expect(at, `no header cluster carries ${control}`).toBeGreaterThan(open);
      let region: string | undefined;
      for (let i = at; i > open; i -= 1) {
        if (LINES[i]!.includes("style={dragStyle}")) { region = "drag"; break; }
        if (LINES[i]!.includes("style={noDragStyle}")) { region = "no-drag"; break; }
      }
      expect(region, `${control} sits in a ${region ?? "styleless"} region`).toBe("no-drag");
    }
  });
});
