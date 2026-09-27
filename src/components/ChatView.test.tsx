// UI1 (docs/audits/2026-09-24-efficiency-audit.md): the roster and every
// GroupView avatar were already fixed to animate only when there is
// something to show motion for, but four ChatView.tsx sites still defaulted
// to `animated: true` — including the bot-to-bot comm chip, rendered once
// per comm message in the transcript window, so a thread with many handoffs
// mounted dozens of permanent 60fps loops for messages that had already
// settled.
//
// CursorAvatar's `paused` prop (driven by `animated` on BotMascot/BotAvatar)
// gates an internal requestAnimationFrame effect and is not reflected
// anywhere in rendered markup — confirmed by reading its render output,
// which sets `d`/`transform` on ref'd paths imperatively rather than via a
// prop-driven attribute. This repo's renderer tests are SSR-only
// (`react-dom/server`'s `renderToStaticMarkup`, see EngineCallout.test.tsx
// and UsageWhatIfProjection.test.tsx) — no jsdom or @testing-library/react
// is installed, and SSR never runs effects — so a DOM assertion cannot see
// "paused" at all. This pins the source instead, the same technique
// sentry.test.ts already uses for source properties a runtime test in this
// suite cannot observe.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ChatView.tsx"), "utf8");

describe("ChatView mascot avatars stay paused once settled", () => {
  it("renders both the expanded and collapsed bot-to-bot comm chip paused — a settled message never needs motion", () => {
    const commChipLines = SRC.split("\n").filter((line) => line.includes("<BotMascot color={comm.withColor}"));
    expect(commChipLines).toHaveLength(2); // ActivityChip's expanded and collapsed comm-chip renders
    for (const line of commChipLines) {
      expect(line).toContain("animated={false}");
    }
  });

  it("renders the empty-thread mascot paused — the guard above it already requires the bot to be idle", () => {
    const line = SRC.split("\n").find((l) => l.includes("<BotAvatar bot={bot} state={stateForBot(bot)}"));
    expect(line).toContain("animated={false}");
  });

  it("animates the open chat's header mascot only while its bot is busy and the tab is visible", () => {
    expect(SRC).toContain("animated={Boolean(bot.busy) && pageVisible}");
  });
});
