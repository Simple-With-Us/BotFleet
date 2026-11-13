// The line a chat or a room shows while an update holds new work.  Rendered
// the way this suite renders everything (react-dom/server, no jsdom), so the
// view is props-only; the hook that feeds it is covered in
// src/lib/update-control.test.ts.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UpdateDrainNotice, UpdateDrainNoticeView } from "./UpdateDrainNotice";
import type { UpdateDrain } from "@/lib/update-control";

const MINUTE = 60_000;
const drain: UpdateDrain = {
  startedAt: 0,
  windowEndsAt: 6 * MINUTE,
  deadline: 8 * MINUTE,
  bots: 3,
  rooms: 0,
  held: { sends: 1, rooms: 1, routineRuns: 0 },
};

const render = (value: UpdateDrain | null, now: number) =>
  renderToStaticMarkup(createElement(UpdateDrainNoticeView, { drain: value, now }));

describe("UpdateDrainNoticeView", () => {
  it("says a message sent now is saved, and when the restart begins", () => {
    const html = render(drain, 0);
    expect(html).toContain('data-testid="update-drain-notice"');
    expect(html).toContain('role="status"');
    expect(html).toContain("BotFleet is updating.");
    expect(html).toContain("Messages you send now are saved and will run after the restart.");
    expect(html).toContain("The restart begins within about 6 minutes.");
  });

  it("keeps the wide gap between sentences, never the six characters &nbsp;", () => {
    const html = render(drain, 0);
    expect(html).toContain(".  Messages");
    expect(html).not.toContain("&nbsp;");
    expect(html).not.toMatch(/agent/i);
  });

  it("counts down as the window runs out", () => {
    expect(render(drain, 5 * MINUTE + 20_000)).toContain("within about 40 seconds.");
    expect(render(drain, 6 * MINUTE)).toContain("The restart begins shortly.");
  });

  it("is silent when nothing is held, or when the hold's lease has run out", () => {
    expect(render(null, 0)).toBe("");
    expect(render(drain, 8 * MINUTE)).toBe("");
    expect(render(drain, 9 * MINUTE)).toBe("");
  });

  it("renders nothing before the first answer, so a chat never flashes a notice", () => {
    // No effects run in a server render, and the watcher starts empty.
    expect(renderToStaticMarkup(createElement(UpdateDrainNotice))).toBe("");
  });
});

// The surfaces are large components this suite cannot render, so what must be
// true of them is pinned in their source, as ChatView.test.tsx does.
const here = dirname(fileURLToPath(import.meta.url));
const source = (name: string) => readFileSync(join(here, name), "utf8").replace(/\r\n/g, "\n");

describe("where the hold shows up", () => {
  it("sits directly above the composer in a chat and in a room", () => {
    for (const view of ["ChatView.tsx", "GroupView.tsx"]) {
      expect(source(view), view).toMatch(/<UpdateDrainNotice \/>\n\s*<Composer\b/);
    }
  });

  it("tells the queued chip's reason apart from a busy bot's", () => {
    const composer = source("Composer.tsx");
    expect(composer).toContain("queuedChipLabel(");
    expect(composer).not.toContain("Queued — sends when {busyName} finishes");
  });

  it("draws the floating card's bar from the same rule as its label, so a wait is never a frozen bar", () => {
    const banner = source("UpdateBanner.tsx");
    expect(banner).toContain("runningPercent(running)");
    expect(banner).not.toMatch(/typeof running\.progress === "number"/);
  });

  it("shows the hold on the card, the Settings subtitle and the sidebar button", () => {
    expect(source("UpdateBanner.tsx")).toContain("drainLabel(holding, now)");
    expect(source("SettingsModal.tsx")).toContain("drainLabel(activeDrain(status, holdNow), holdNow)");
    expect(source("Sidebar.tsx")).toContain("drainLabel(hold, Date.now())");
  });
});
