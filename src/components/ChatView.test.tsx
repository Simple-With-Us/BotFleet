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

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ChatView.tsx"), "utf8").replace(/\r\n/g, "\n");

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

describe("ChatView footer chips", () => {
  it("renders the session chips from the open thread's task, directly under the composer", () => {
    const composer = SRC.indexOf("<Composer\n");
    const bar = SRC.indexOf("<ThreadStatsBar stats={activeTask?.stats} usage={activeTask?.usage} />");
    expect(composer).toBeGreaterThan(-1);
    expect(bar).toBeGreaterThan(composer);
    // nothing else opens between the two: the chips sit right under the composer
    expect(SRC.slice(composer, bar)).not.toMatch(/<(?:div|section|main)\b/);
    expect(SRC).toContain("const activeTask = bot.tasks?.find((t) => t.threadId === bot.threadId);");
  });
});

describe("ChatView Trajectory switch", () => {
  it("puts the Chat | Trajectory switch in the header, remembered per thread", () => {
    expect(SRC).toContain("const [threadView, setThreadView] = useThreadView(bot.threadId);");
    expect(SRC).toContain("<ThreadViewSwitch view={threadView} onChange={setThreadView} />");
    // in the header's right-hand cluster, ahead of the find button, and not among the thread tabs
    expect(SRC.indexOf("<ThreadViewSwitch")).toBeLessThan(SRC.indexOf('aria-label={trajectoryOpen ? "Search Steps" : "Find in Conversation"}'));
    expect(SRC.indexOf("<ThreadViewSwitch")).toBeLessThan(SRC.indexOf("<ThreadTabs bot={bot} />"));
  });

  // The switch sits beside a button that used to unmount in Trajectory, which
  // slid the switch about 38px under the pointer as it was clicked.
  it("keeps the magnifier mounted in Trajectory, where it searches the steps", () => {
    expect(SRC).not.toMatch(/\{!trajectoryOpen && \(\s*<button\s+onClick=\{\(\) => setFindOpen/);
    expect(SRC).toContain("onClick={() => (trajectoryOpen ? requestTrajectorySearch() : setFindOpen((open) => !open))}");
    expect(SRC).toContain('title={trajectoryOpen ? "Search Steps (⌘F)" : "Find in Conversation (⌘F)"}');
  });

  it("sends the find shortcut to the steps' search box while Trajectory is showing", () => {
    expect(SRC).toContain("if (trajectoryOpen) requestTrajectorySearch();\n        else setFindOpen(true);");
    expect(SRC).toContain("  }, [trajectoryOpen]);");
  });

  // Home and PageUp in the step list must not turn off follow on the hidden chat
  it("leaves the chat's Home and PageUp handling off while Trajectory is showing", () => {
    expect(SRC).toContain("    if (trajectoryOpen) return;\n    const onKey = (e: KeyboardEvent) => {\n      if (e.key === \"PageUp\"");
    expect(SRC).toContain("  }, [setBottomFollow, trajectoryOpen]);");
  });

  it("keeps the chat pane mounted but hidden in Trajectory, so its scroll, draft and stream survive", () => {
    expect(SRC).toContain('cn("relative min-h-0 flex-1 @container/chat", trajectoryOpen && "hidden")');
  });

  it("does not pin the hidden chat pane's scroll to zero while Trajectory is open", () => {
    expect(SRC).toContain("if (!el || !followRef.current || trajectoryOpen) return;");
    expect(SRC).toContain("follow, composerHeight, trajectoryOpen]);");
  });

  it("mounts the Trajectory view keyed by thread, fed the thread's own state", () => {
    expect(SRC).toMatch(/\{trajectoryOpen && \(\s*<TrajectoryView\s+key=\{bot\.threadId\}\s+threadId=\{bot\.threadId\}\s+messages=\{serverMessages\}\s+running=\{Boolean\(bot\.busy\)\}\s+knownTurns=\{activeTask\?\.usage\?\.turns\}\s*\/>\s*\)\}/);
  });

  it("hides the chat-only chrome (find, pinned banner, execution timeline) while in Trajectory", () => {
    expect(SRC).toContain("{findOpen && !trajectoryOpen && <ChatFindBar");
    expect(SRC).toContain("{!trajectoryOpen && (\n        <PinnedBanner");
    expect(SRC).toContain("showToolCallsEnabled(state.config) && !trajectoryOpen && <TaskTimeline");
  });
});

describe("ChatView step payloads and injected context", () => {
  it("hands each tool row its thread, so opening it can read the step's full input and output", () => {
    expect(SRC).toContain("<ToolLine message={message} actor={message.from?.name ?? bot.name} threadId={bot.threadId} />");
  });

  it("puts a message's injected-context rows directly under it, behind the tool-calls setting", () => {
    const row = SRC.indexOf("{row}\n");
    const rows = SRC.indexOf("<ContextInjectionRows entries={m.contextInjections} threadId={bot.threadId} />");
    expect(row).toBeGreaterThan(-1);
    expect(rows).toBeGreaterThan(row);
    // nothing else opens between the message and its rows
    expect(SRC.slice(row, rows)).not.toMatch(/<(?:Bubble|ActivityChip|ToolLine)\b/);
    expect(SRC).toContain("{showToolCalls && m.contextInjections?.length ? (");
  });
});
