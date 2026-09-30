// SSR tests for the Trajectory tab.  This repo's component tests render with
// react-dom/server (no jsdom), so they pin the markup a first paint produces:
// the lanes and their labels, each step's line, the modes, the empty and error
// states.  Effects (fetching, the live tail, focus movement) do not run under
// SSR; their logic lives in pure modules with their own tests
// (trajectory.test.ts, runtime-feed.test.ts, thread-view.test.ts).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../../server/contracts.ts";
import { buildTrajectory, type Trajectory, type TrajectoryInput } from "@/lib/trajectory";
import { clearItemIoCache, primeItemIo } from "@/lib/item-io";
import { ThreadViewSwitch } from "./ThreadViewSwitch.tsx";
import { STEP_WINDOW, TrajectoryPanel, TrajectoryView, type TrajectoryMode, type TrajectoryPanelProps } from "./TrajectoryView.tsx";
import { TrajectoryTimeline } from "./TrajectoryTimeline.tsx";
import { rovingKeyDown, spanKeyDown, stepKeyDown, tabStop } from "./TrajectoryRows.tsx";

// ── fixture ───────────────────────────────────────────────────────────
const T0 = Date.parse("2026-09-29T14:00:00.000Z");
let n = 0;
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const base = (sec: number, turnId = "t1") => ({ eventId: `e${++n}`, provider: "claude" as const, threadId: "th", createdAt: at(sec), turnId });
const ev = (sec: number, rest: Record<string, unknown>, turnId?: string) => ({ ...base(sec, turnId), ...rest }) as RuntimeEvent;

const events = (): RuntimeEvent[] => [
  ev(0, { type: "turn.started" }),
  ev(1, { type: "item.completed", itemType: "assistant_text", text: "Let me look at the config." }),
  ev(2, { type: "item.started", itemType: "tool", itemId: "a", title: "Read", target: "src/config.ts" }),
  ev(4, { type: "item.completed", itemType: "tool", itemId: "a", ok: true, detail: "42 lines" }),
  ev(5, { type: "item.started", itemType: "tool", itemId: "b", title: "Bash", target: "pnpm test" }),
  ev(15, { type: "item.completed", itemType: "tool", itemId: "b", ok: false, detail: "exit 1" }),
  ev(16, { type: "item.updated", itemType: "reasoning", tokens: 300 }),
  ev(18, { type: "item.completed", itemType: "assistant_text", text: "Two tests fail." }),
  ev(20, { type: "turn.completed", ok: true, usage: { input: 12_000, output: 800 }, cost: 0.03 }),
  ev(3600, { type: "turn.started" }, "t2"),
  ev(3605, { type: "turn.completed", ok: true }, "t2"),
];
const inputs: TrajectoryInput[] = [{ id: "u1", at: T0 - 500, role: "user", text: "Please run the suite" }];

const build = (over: Parameters<typeof buildTrajectory>[1] = {}): Trajectory => buildTrajectory(events(), { inputs, ...over });

const noop = () => {};
function render(over: Partial<TrajectoryPanelProps> & { trajectory?: Trajectory } = {}, mode: TrajectoryMode = "duration") {
  return renderToStaticMarkup(
    createElement(TrajectoryPanel, {
      trajectory: build(),
      mode,
      onMode: noop,
      query: "",
      onQuery: noop,
      expanded: new Set<string>(),
      onToggle: noop,
      ...over,
    }),
  );
}
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

// ── duration ──────────────────────────────────────────────────────────
describe("TrajectoryPanel: Duration", () => {
  const html = render();

  it("draws the three labelled lanes", () => {
    for (const lane of ["Input", "Model", "Tools"]) {
      expect(html).toContain(`>${lane}</span>`);
      expect(html).toContain(`aria-label="${lane} lane,`);
    }
    expect(html).toContain('aria-label="Timeline"');
  });

  it("gives every span a button that names its outcome", () => {
    expect(html).toContain('aria-label="Read, 2s, started ');
    expect(html).toMatch(/aria-label="Bash, 10s, started [\d:]+, failed"/);
    expect(html).toMatch(/aria-label="Read, 2s, started [\d:]+, succeeded"/);
    expect(html.match(/aria-haspopup="dialog"/g)!.length).toBeGreaterThan(5);
  });

  it("makes each lane ONE tab stop, however many spans it holds", () => {
    // the strip sits ahead of the step list, so a tab stop per span would be
    // hundreds of Tab presses before the list
    const lanes = html.slice(html.indexOf('aria-label="Timeline"'), html.indexOf('aria-label="Legend"')).split(/aria-label="(?:Input|Model|Tools) lane,/).slice(1);
    expect(lanes).toHaveLength(3);
    for (const lane of lanes) {
      const buttons = lane.match(/<button\b[^>]*>/g)!;
      expect(buttons.length).toBeGreaterThan(0);
      expect(buttons.filter((tag) => tag.includes('tabindex="0"'))).toHaveLength(1);
      expect(buttons.filter((tag) => tag.includes('tabindex="-1"'))).toHaveLength(buttons.length - 1);
      expect(buttons.every((tag) => tag.includes("data-span"))).toBe(true);
    }
    // the tools lane really has several, so this is not vacuous
    expect(lanes[2]!.match(/<button\b/g)!.length).toBeGreaterThan(1);
  });

  it("marks the idle hour between the turns as a gap, with its length", () => {
    expect(html).toContain(">1h later<");
    expect(html).toMatch(/title="1h later"/);
  });

  it("lists each step as one line with its kind badge", () => {
    const t = text(html);
    expect(t).toContain("USER Please run the suite");
    expect(t).toContain("ASSISTANT Let me look at the config.");
    expect(t).toContain("TOOL Read src/config.ts");
    expect(t).toContain("→ returned 42 lines");
    expect(t).toContain("TOOL Bash pnpm test");
    expect(t).toContain("REASONING about 300 tokens");
    expect(t).toContain("ASSISTANT Two tests fail.");
  });

  it("names an assistant step that only called a tool", () => {
    expect(text(html)).toContain("(tool call only)");
  });

  it("summarises the thread and offers no older-steps note for a whole log", () => {
    expect(text(html)).toMatch(/\d+ steps · 2 turns · /);
    expect(html).not.toContain("Older steps were trimmed");
  });

  it("makes exactly one step the tab stop", () => {
    const listHtml = html.slice(html.indexOf('aria-label="Steps"'));
    expect(listHtml.match(/tabindex="0"/g)).toHaveLength(1);
    expect(listHtml.match(/data-step/g)!.length).toBeGreaterThan(5);
    // the first step is the one
    expect(listHtml.indexOf('tabindex="0"')).toBeLessThan(listHtml.indexOf('tabindex="-1"'));
  });

  it("shows the mode toggle with Duration pressed, and a labelled search", () => {
    expect(html).toContain('aria-label="Trajectory View"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Duration</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Turns</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Calls</);
    expect(html).toContain("Search Steps");
    expect(html).toContain('type="search"');
  });

  it("says a turn is running while one is", () => {
    const running = buildTrajectory(events().slice(0, 4), { inputs, running: true, now: T0 + 30_000 });
    const runningHtml = render({ trajectory: running });
    expect(runningHtml).toContain("Running");
    expect(html).not.toMatch(/>Running</);
  });
});

// ── turns ─────────────────────────────────────────────────────────────
describe("TrajectoryPanel: Turns", () => {
  const html = render({}, "turns");

  it("groups steps under a heading per turn, with duration and tokens", () => {
    expect(html.match(/<h3/g)).toHaveLength(2);
    const t = text(html);
    expect(t).toContain("Turn 1");
    expect(t).toContain("Turn 2");
    expect(t).toMatch(/Turn 1 [\d:]+ · 20s · 2 tool calls · model 8s · tools 12s · 12k in · 800 out · \$0\.03/);
    // the Duration timeline is not part of this view
    expect(html).not.toContain('aria-label="Timeline"');
  });

  it("keeps the message that started a turn with that turn", () => {
    const t = text(html);
    expect(t).not.toContain("Outside a Turn");
    expect(t.indexOf("Turn 1")).toBeLessThan(t.indexOf("Please run the suite"));
    expect(t.indexOf("Please run the suite")).toBeLessThan(t.indexOf("Turn 2"));
  });

  it("does not drop a message after the last turn", () => {
    const late = buildTrajectory(events(), { inputs: [...inputs, { id: "u9", at: T0 + 4000 * 1000, role: "user", text: "still there?" }] });
    const t = text(render({ trajectory: late }, "turns"));
    expect(t).toContain("Outside a Turn");
    expect(t.indexOf("Turn 2")).toBeLessThan(t.indexOf("Outside a Turn"));
    expect(t).toContain("still there?");
  });

  it("shows a turn that recorded no steps, so none goes missing", () => {
    expect(text(html)).toContain("Turn 2");
    expect(text(html)).toContain("No steps in this turn.");
  });

  it("marks an unfinished or failed turn", () => {
    const cut = buildTrajectory([ev(0, { type: "turn.started" }), ev(1, { type: "item.started", itemType: "tool", itemId: "x", title: "Bash" })]);
    expect(render({ trajectory: cut }, "turns")).toContain("Never finished");
    const failed = buildTrajectory([ev(0, { type: "turn.started" }), ev(1, { type: "turn.completed", ok: false, stopReason: "error" })]);
    expect(render({ trajectory: failed }, "turns")).toContain(">Failed<");
  });

  it("calls a turn the person stopped Stopped, not Failed", () => {
    const stopped = buildTrajectory([ev(0, { type: "turn.started" }), ev(1, { type: "turn.completed", ok: false, stopReason: "interrupted" })]);
    const stoppedHtml = render({ trajectory: stopped }, "turns");
    expect(stoppedHtml).toContain(">Stopped<");
    expect(stoppedHtml).not.toContain(">Failed<");
    expect(stoppedHtml).not.toContain("Turn failed");
    // the trail still says so, as CONTEXT
    expect(text(stoppedHtml)).toContain("CONTEXT Stopped interrupted");
  });

  it("labels a running turn's token figure as the latest, never as a total", () => {
    const usage = ev(1, { type: "thread.token-usage.updated", input: 900, output: 30 });
    const running = buildTrajectory([ev(0, { type: "turn.started" }), usage], { running: true, now: T0 + 5000 });
    expect(text(render({ trajectory: running }, "turns"))).toContain("latest 900 in · 30 out");
    // a settled turn without usage shows none at all
    const settled = buildTrajectory([ev(0, { type: "turn.started" }), usage, ev(2, { type: "turn.completed", ok: false, stopReason: "error" })]);
    expect(text(render({ trajectory: settled }, "turns"))).not.toMatch(/\d in ·/);
  });
});

// ── calls ─────────────────────────────────────────────────────────────
describe("TrajectoryPanel: Calls", () => {
  const html = render({}, "calls");

  it("is a table of tool calls with sortable columns", () => {
    expect(html).toContain("<table");
    expect(html).toContain('<caption class="sr-only">Tool calls</caption>');
    const t = text(html);
    expect(t).toMatch(/Tool Started ↑ Duration Outcome Arguments/);
    expect(t).toContain("Read");
    expect(t).toContain("Bash");
    expect(t).toContain("Succeeded");
    expect(t).toContain("Failed");
    expect(t).toContain("pnpm test");
    // started is the active sort, ascending
    expect(html).toContain('aria-sort="ascending"');
    // only the tool rows: no assistant text, no user message
    expect(t).not.toContain("Two tests fail");
    expect(t).not.toContain("Please run the suite");
  });

  it("says so when the thread has no tool calls", () => {
    const quiet = buildTrajectory([ev(0, { type: "turn.started" }), ev(1, { type: "item.completed", itemType: "assistant_text", text: "hi" }), ev(2, { type: "turn.completed", ok: true })]);
    expect(text(render({ trajectory: quiet }, "calls"))).toContain("No tool calls in this thread yet.");
  });
});

// ── search ────────────────────────────────────────────────────────────
describe("TrajectoryPanel: search", () => {
  it("filters the list to matching steps and says how many", () => {
    const html = render({ query: "pnpm" });
    const t = text(html);
    expect(t).toContain("TOOL Bash pnpm test");
    expect(t).not.toContain("Let me look");
    expect(t).toMatch(/1 of \d+ steps/);
    expect(html).toContain('aria-label="Clear Search"');
    expect(html).toContain('value="pnpm"');
  });

  it("matches results and assistant text, case-insensitively", () => {
    expect(text(render({ query: "EXIT 1" }))).toContain("TOOL Bash");
    expect(text(render({ query: "TWO TESTS" }))).toContain("Two tests fail.");
  });

  it("filters the calls table and the turn groups too", () => {
    expect(text(render({ query: "config" }, "calls"))).toContain("Read");
    expect(text(render({ query: "config" }, "calls"))).not.toContain("Bash");
    const turns = render({ query: "two tests" }, "turns");
    expect(turns.match(/<h3/g)).toHaveLength(1);
  });

  it("says nothing matched, without dropping the controls", () => {
    const html = render({ query: "zzzz" });
    expect(text(html)).toContain("No steps match “zzzz”.");
    expect(html).toContain('type="search"');
  });

  it("keeps the timeline in view while searching (it shows the thread, not the matches)", () => {
    expect(render({ query: "pnpm" })).toContain('aria-label="Timeline"');
  });
});

// ── expanding a step ──────────────────────────────────────────────────
describe("TrajectoryPanel: an opened step", () => {
  it("expands in place with its full detail", () => {
    const trajectory = build();
    const tool = trajectory.rows.find((r) => r.title === "Bash")!;
    const html = render({ trajectory, expanded: new Set([tool.id]) });
    expect(html).toContain(`id="${tool.id}::detail"`);
    expect(html).toContain(`aria-controls="${tool.id}::detail"`);
    const detail = text(html.slice(html.indexOf(`id="${tool.id}::detail"`)));
    expect(detail).toContain("Duration 10s");
    expect(detail).toContain("Outcome Failed");
    expect(detail).toContain("Target pnpm test");
    expect(detail).toContain("Result exit 1");
  });

  it("leaves every other step closed", () => {
    const trajectory = build();
    const html = render({ trajectory, expanded: new Set([trajectory.rows[1]!.id]) });
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(1);
    expect(html.match(/::detail"/g)!.length).toBe(2); // aria-controls + the detail's own id
  });

  it("opens a call in the table too", () => {
    const trajectory = build();
    const tool = trajectory.rows.find((r) => r.title === "Read")!;
    const html = render({ trajectory, expanded: new Set([tool.id]) }, "calls");
    expect(text(html.slice(html.indexOf(`id="${tool.id}::detail"`)))).toContain("Result 42 lines");
  });
});

// ── a step's full input and output ────────────────────────────────────
describe("TrajectoryPanel: an opened step reads its full payload", () => {
  afterEach(() => clearItemIoCache());

  const ioEvents = (): RuntimeEvent[] => [
    ev(0, { type: "turn.started" }),
    ev(1, { type: "item.started", itemType: "tool", itemId: "toolu_1", title: "Bash", target: "ls" }),
    ev(3, { type: "item.completed", itemType: "tool", itemId: "toolu_1", ok: true, detail: "3 files" }),
    ev(5, { type: "turn.completed", ok: true }),
  ];
  const field = (value: string, over: Record<string, unknown> = {}) => ({ text: value, truncated: false, length: value.length, ...over });
  const open = (trajectory: Trajectory, props: Partial<TrajectoryPanelProps> = {}, mode: TrajectoryMode = "duration") => {
    const tool = trajectory.rows.find((r) => r.kind === "tool")!;
    const html = render({ trajectory, expanded: new Set([tool.id]), threadId: "th", ...props }, mode);
    return html.slice(html.indexOf(`id="${tool.id}::detail"`));
  };

  it("shows the whole input and output, labelled, instead of the clipped line", () => {
    const trajectory = buildTrajectory(ioEvents());
    primeItemIo(
      { threadId: "th", itemId: "toolu_1", turnId: "t1" },
      { status: "loaded", io: { itemId: "toolu_1", at: "x", input: field('{\n  "command": "ls"\n}'), output: field("a.ts\nb.ts\nc.ts") } },
    );
    const html = open(trajectory);
    expect(html).toContain('data-io="in"');
    expect(html).toContain('data-io="out"');
    expect(html).toContain("a.ts\nb.ts\nc.ts");
    // the clipped "Result 3 files" block is what it replaced
    expect(text(html)).not.toContain("Result 3 files");
  });

  it("says when a field was cut", () => {
    const trajectory = buildTrajectory(ioEvents());
    primeItemIo(
      { threadId: "th", itemId: "toolu_1", turnId: "t1" },
      { status: "loaded", io: { itemId: "toolu_1", at: "x", output: field("x".repeat(100), { truncated: true, length: 9000 }) } },
    );
    expect(text(open(trajectory))).toContain("Truncated — showing first 100 of 9,000 characters");
  });

  it("keeps the clipped result and says nothing was recorded when it was not", () => {
    const trajectory = buildTrajectory(ioEvents());
    primeItemIo({ threadId: "th", itemId: "toolu_1", turnId: "t1" }, { status: "unavailable" });
    const detail = text(open(trajectory));
    expect(detail).toContain("Result 3 files");
    expect(detail).toContain("Full input and output weren't recorded for this step.");
  });

  it("keeps the clipped result and shows a loading note while the payload is on its way", () => {
    const detail = text(open(buildTrajectory(ioEvents())));
    expect(detail).toContain("Result 3 files");
    expect(detail).toContain("Loading the full input and output…");
  });

  it("reads it in the Calls table too", () => {
    const trajectory = buildTrajectory(ioEvents());
    primeItemIo(
      { threadId: "th", itemId: "toolu_1", turnId: "t1" },
      { status: "loaded", io: { itemId: "toolu_1", at: "x", output: field("from the table") } },
    );
    expect(open(trajectory, {}, "calls")).toContain("from the table");
  });

  it("asks for nothing when the tab has no thread to ask about", () => {
    const html = open(buildTrajectory(ioEvents()), { threadId: undefined });
    expect(html).not.toContain("data-io");
    expect(html).not.toContain("Loading the full input and output");
    expect(text(html)).toContain("Result 3 files");
  });

  it("shows an injected context row's full text, fetched when it opens", () => {
    const { turnId: _none, ...stamp } = base(0);
    const trajectory = buildTrajectory([
      { ...stamp, type: "context.injected", itemId: "ctx-1", source: "memory", preview: "likes tea", bytes: 9 } as RuntimeEvent,
      ...ioEvents(),
    ]);
    const row = trajectory.rows.find((r) => r.title === "Context injection · memory")!;
    expect(row).toBeDefined();
    primeItemIo(
      { threadId: "th", itemId: "ctx-1" },
      { status: "loaded", io: { itemId: "ctx-1", at: "x", text: field("likes tea\nand quiet") } },
    );
    const html = render({ trajectory, expanded: new Set([row.id]), threadId: "th" });
    const detail = html.slice(html.indexOf(`id="${row.id}::detail"`));
    expect(detail).toContain('data-io="text"');
    expect(detail).toContain("likes tea\nand quiet");
  });

  it("lists an injection as a CONTEXT step beside the steps it preceded", () => {
    const { turnId: _none, ...stamp } = base(0);
    const trajectory = buildTrajectory([
      { ...stamp, type: "context.injected", itemId: "ctx-1", source: "skill", preview: "Use the phone skill.", bytes: 20 } as RuntimeEvent,
      ...ioEvents(),
    ]);
    const html = render({ trajectory, threadId: "th" });
    expect(html).toContain("CONTEXT");
    expect(text(html)).toContain("Context injection · skill 20 B Use the phone skill.");
  });
});

// ── the states around it ──────────────────────────────────────────────
describe("TrajectoryPanel: states", () => {
  const empty = buildTrajectory([]);

  it("shows an empty state for a thread with no events", () => {
    const t = text(render({ trajectory: empty }));
    expect(t).toContain("No steps yet");
    expect(t).toContain("Steps appear here as this thread's bot works.");
    expect(t).not.toContain("Timeline");
  });

  it("does not show the empty state while it is still loading", () => {
    const t = text(render({ trajectory: empty, loading: true }));
    expect(t).toContain("Loading steps…");
    expect(t).not.toContain("No steps yet");
  });

  it("says why it could not load, and offers another try", () => {
    const html = render({ trajectory: empty, error: "500", onRetry: noop });
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("Couldn't load this thread's steps: 500");
    expect(text(html)).toContain("Try Again");
    expect(text(html)).not.toContain("No steps yet");
  });

  it("says older steps were trimmed — quietly, as a note, not an alert", () => {
    const html = render({ trajectory: build({ olderOnDisk: true }) });
    expect(html).toContain('role="note"');
    expect(text(html)).toContain("Older steps were trimmed.");
    expect(html).not.toContain('role="alert"');
  });

  it("says it too when the task banked more turns than the log shows", () => {
    expect(text(render({ trajectory: build({ knownTurns: 9 }) }))).toContain("Older steps were trimmed.");
  });

  it("windows a long thread and offers the earlier steps", () => {
    const many: RuntimeEvent[] = [ev(0, { type: "turn.started" })];
    for (let i = 0; i < STEP_WINDOW + 40; i++) many.push(ev(1 + i, { type: "item.completed", itemType: "assistant_text", text: `step number ${i}` }));
    many.push(ev(9999, { type: "turn.completed", ok: true }));
    const html = render({ trajectory: buildTrajectory(many) });
    expect(text(html)).toContain("Show Earlier Steps (40 more)");
    // the newest are the ones shown
    expect(html).toContain(`step number ${STEP_WINDOW + 39}`);
    expect(html).not.toContain("step number 0<");
  });
});

// ── the switch and the keyboard ───────────────────────────────────────
describe("ThreadViewSwitch", () => {
  const render2 = (view: "chat" | "trajectory") => renderToStaticMarkup(createElement(ThreadViewSwitch, { view, onChange: noop }));

  it("offers Chat and Trajectory as a pressed pair, not as tabs", () => {
    const chat = render2("chat");
    expect(chat).toContain('aria-label="Thread View"');
    expect(chat).toMatch(/aria-pressed="true"[^>]*aria-label="Chat"/);
    expect(chat).toMatch(/aria-pressed="false"[^>]*aria-label="Trajectory"/);
    expect(chat).not.toContain('role="tab');
    expect(render2("trajectory")).toMatch(/aria-pressed="true"[^>]*aria-label="Trajectory"/);
  });

  it("keeps the names when the labels fold away on a narrow header", () => {
    const html = render2("chat");
    expect(html).toContain("@max-4xl/chathead:hidden");
    expect(html).toContain('aria-label="Chat"');
  });
});

describe("keyboard navigation", () => {
  it("makes the last-used step the tab stop, else the first", () => {
    expect(tabStop(["a", "b", "c"], null)).toBe("a");
    expect(tabStop(["a", "b", "c"], "b")).toBe("b");
    // a step that scrolled out of the window or was filtered away
    expect(tabStop(["a", "b", "c"], "gone")).toBe("a");
    expect(tabStop([], "a")).toBeUndefined();
  });

  function steps(count: number) {
    const focused: number[] = [];
    const nodes = Array.from({ length: count }, (_, i) => ({ closest: () => nodes[i], focus: () => focused.push(i) }));
    const currentTarget = { querySelectorAll: () => nodes };
    const press = (key: string, from: number, extra: Record<string, unknown> = {}) => {
      const preventDefault = vi.fn();
      stepKeyDown({ key, altKey: false, ctrlKey: false, metaKey: false, ...extra, target: nodes[from], currentTarget, preventDefault } as never);
      return preventDefault;
    };
    return { focused, press };
  }

  it("moves down and up between steps, stopping at the ends", () => {
    const { focused, press } = steps(3);
    press("ArrowDown", 0);
    press("ArrowDown", 2);
    press("ArrowUp", 2);
    press("ArrowUp", 0);
    expect(focused).toEqual([1, 2, 1, 0]);
  });

  it("jumps to the first and last with Home and End, and stops the page scrolling", () => {
    const { focused, press } = steps(5);
    expect(press("End", 1)).toHaveBeenCalled();
    press("Home", 3);
    expect(focused).toEqual([4, 0]);
  });

  it("leaves other keys and modified keys alone", () => {
    const { focused, press } = steps(3);
    expect(press("Enter", 0)).not.toHaveBeenCalled();
    expect(press("ArrowDown", 0, { metaKey: true })).not.toHaveBeenCalled();
    expect(press("ArrowDown", 0, { altKey: true })).not.toHaveBeenCalled();
    expect(focused).toEqual([]);
  });

  it("moves between a timeline lane's spans with Left and Right, and not with Up and Down", () => {
    const focused: number[] = [];
    const nodes = Array.from({ length: 4 }, (_, i) => ({ closest: () => nodes[i], focus: () => focused.push(i) }));
    const currentTarget = { querySelectorAll: (selector: string) => (selector === "[data-span]" ? nodes : []) };
    const press = (key: string, from: number) => {
      const preventDefault = vi.fn();
      spanKeyDown({ key, altKey: false, ctrlKey: false, metaKey: false, target: nodes[from], currentTarget, preventDefault } as never);
      return preventDefault;
    };
    press("ArrowRight", 0);
    press("ArrowRight", 3);
    press("ArrowLeft", 3);
    press("End", 0);
    press("Home", 2);
    expect(focused).toEqual([1, 3, 2, 3, 0]);
    expect(press("ArrowDown", 0)).not.toHaveBeenCalled();
    expect(press("ArrowUp", 1)).not.toHaveBeenCalled();
  });

  it("builds a handler for any selector and key pair", () => {
    const focused: number[] = [];
    const nodes = Array.from({ length: 3 }, (_, i) => ({ closest: () => nodes[i], focus: () => focused.push(i) }));
    const handler = rovingKeyDown("[data-x]", "j", "k");
    handler({ key: "k", altKey: false, ctrlKey: false, metaKey: false, target: nodes[0], currentTarget: { querySelectorAll: () => nodes }, preventDefault: vi.fn() } as never);
    expect(focused).toEqual([1]);
  });

  it("ignores a key pressed outside any step (the search box)", () => {
    const preventDefault = vi.fn();
    stepKeyDown({
      key: "ArrowDown",
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      target: { closest: () => null },
      currentTarget: { querySelectorAll: () => [] },
      preventDefault,
    } as never);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

// ── re-rendering ──────────────────────────────────────────────────────
describe("re-rendering", () => {
  const isMemo = (component: unknown) => (component as { $$typeof?: symbol }).$$typeof === Symbol.for("react.memo");

  // The chat above re-renders on every streamed frame (it reads the stream
  // context).  This tab shows none of that text, so it must not follow.
  it("keeps the view, the timeline and the step rows out of the chat's streaming re-renders", () => {
    expect(isMemo(TrajectoryView)).toBe(true);
    expect(isMemo(TrajectoryTimeline)).toBe(true);
  });

  it("still renders through the memo wrappers", () => {
    const html = renderToStaticMarkup(createElement(TrajectoryView, { threadId: "th", messages: [], running: false }));
    // no fetch under SSR: the first paint is the loading state
    expect(html).toContain("Loading steps");
    expect(renderToStaticMarkup(createElement(TrajectoryTimeline, { trajectory: build() }))).toContain('aria-label="Timeline"');
  });
});

// ── the live tail (effects do not run under SSR, so pinned by source) ─
describe("the live tail's wiring", () => {
  const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "TrajectoryView.tsx"), "utf8").replace(/\r\n/g, "\n");

  // The bot's busy flag flips right behind the turn's last events; a view that
  // has heard "not busy" but not "turn.completed" draws the turn as interrupted.
  it("delivers a turn starting or settling at once, not on the batch timer", () => {
    expect(SRC).toContain('const settles = event.type === "turn.completed" || event.type === "runtime.error";');
    expect(SRC).toContain('if (settles || event.type === "turn.started") batcher.flushNow();');
  });

  it("reads the log again when a turn settles, when the live tail overflows, and after a stream gap", () => {
    expect(SRC).toContain("if (settles) reload.soon(SETTLE_RELOAD_MS);");
    // overflow uses ifIdle: a stream that overflows every batch must not keep
    // restarting the wait (see createDelayedRun)
    expect(SRC).toContain("if (overflow) reload.ifIdle(BURST_RELOAD_MS);");
    expect(SRC).toContain("subscribeRuntimeGap(() => reload.soon(BURST_RELOAD_MS))");
  });

  it("reads the log again when the bot stops running without this tab having heard the turn end", () => {
    expect(SRC).toContain("if (wasRunning.current && !running) reloader.current?.soon(SETTLE_RELOAD_MS);");
  });

  it("answers the header's search request by focusing its own search box", () => {
    expect(SRC).toContain("onTrajectorySearchRequest(() => {");
    expect(SRC).toContain("ref={searchRef}");
  });
});
