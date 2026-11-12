// How full one conversation is, from figures the engine already reported.
//
// `used` is the last settled turn's input (`TaskUsage.lastInput`): the
// tokens that filled the window, not the running sum of every turn.
// `window` is the size the engine reported on that turn when it sent one,
// otherwise the model's published window.  A missing figure stays missing.
// Nothing here invents a zero or a percent from a total the engine did not
// call a window fill.

export const CONTEXT_NOTE_PERCENT = 80;

export const COMPACT_SESSION_LABEL = "Compact Session";

export const CONTEXT_NOTE_TEXT =
  "Compacting before your next message keeps later replies fast and lighter on your usage.";

const GAP = "\u00A0 ";

/** A non-negative finite token count, or null when the engine did not report one. */
export function reportedTokens(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/** Abbreviate a token count by flooring, so a window is never painted larger than it is. */
export function formatContextCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "";
  const whole = Math.floor(tokens);
  if (whole < 1000) return String(whole);
  const scale = whole < 1_000_000 ? 1000 : 1_000_000;
  const suffix = scale === 1000 ? "k" : "M";
  const tenths = Math.floor(whole / (scale / 10));
  const text = (tenths / 10).toFixed(1).replace(/\.0$/, "");
  return `${text}${suffix}`;
}

export interface ContextMeter {
  used: number | null;
  window: number | null;
  /** Whole percent, floored.  Null when either figure is missing.  May exceed 100. */
  percent: number | null;
  /** Bar width, 0–100.  Null when `percent` is null. */
  bar: number | null;
  usedLabel: string | null;
  windowLabel: string | null;
  percentLabel: string | null;
  summary: string;
  detail: string;
}

export function deriveContextMeter(input: {
  used?: number | null;
  reportedWindow?: number | null;
  catalogWindow?: number | null;
}): ContextMeter {
  const used = reportedTokens(input.used);
  const reportedWindow = reportedTokens(input.reportedWindow);
  const catalogWindow = reportedTokens(input.catalogWindow);
  const window = reportedWindow !== null && reportedWindow > 0
    ? reportedWindow
    : catalogWindow !== null && catalogWindow > 0
      ? catalogWindow
      : null;
  const percent = used !== null && window !== null ? Math.floor((used / window) * 100) : null;
  const usedLabel = used === null ? null : formatContextCount(used);
  const windowLabel = window === null ? null : formatContextCount(window);
  const exact = (n: number) => n.toLocaleString("en-US");
  let summary = "Usage not reported";
  let detail = "This engine has not reported context usage.";
  if (used !== null && window !== null && usedLabel && windowLabel) {
    summary = `${usedLabel} / ${windowLabel}`;
    detail = `${exact(used)} of ${exact(window)} tokens.`;
  } else if (used !== null && usedLabel) {
    summary = `${usedLabel} tokens used`;
    detail = `${exact(used)} tokens used.${GAP}This engine has not reported the window.`;
  } else if (window !== null && windowLabel) {
    summary = `${windowLabel} window`;
    detail = `The window is ${exact(window)} tokens.${GAP}Usage has not been reported yet.`;
  }
  return {
    used,
    window,
    percent,
    bar: percent === null ? null : Math.min(100, Math.max(0, percent)),
    usedLabel,
    windowLabel,
    percentLabel: percent === null ? null : `${percent}% used`,
    summary,
    detail,
  };
}

export interface CompactCommand {
  id: string;
  name: string;
  enabled: boolean;
  disabledReason?: string | null;
}

export type CompactOffer =
  | { state: "hidden" }
  | { state: "disabled"; reason: string }
  | { state: "ready"; commandId: string };

const COMPACT_UNAVAILABLE = "Compact session is not available right now.";

/** `/compact` only where that engine's menu offers it.  Anything else stays hidden. */
export function compactOffer(commands: readonly CompactCommand[] | null): CompactOffer {
  if (commands === null) return { state: "hidden" };
  const compact = commands.find((command) => command.name === "compact" && command.id === "engine:compact");
  if (!compact) return { state: "hidden" };
  if (compact.enabled) return { state: "ready", commandId: compact.id };
  const reason = compact.disabledReason?.trim();
  return { state: "disabled", reason: reason ? reason : COMPACT_UNAVAILABLE };
}

export interface ContextNoteMemory {
  /** The used-token count when this fill first crossed the line. */
  shownAtUsed: number;
}

export interface ContextNoteDecision {
  show: boolean;
  /** True only on the crossing that first shows the note. */
  opened: boolean;
  memory: ContextNoteMemory | null;
}

/**
 * One note per climb past the line.  Later messages while it stays full
 * keep the same note.  A drop below the line forgets it, so the next climb
 * can speak once.  A turn that reports nothing is not that drop.
 */
export function nextContextNote(input: {
  used: number | null;
  window: number | null;
  compactReady: boolean;
  memory: ContextNoteMemory | null;
}): ContextNoteDecision {
  const meter = deriveContextMeter({ used: input.used, reportedWindow: input.window });
  const near = meter.percent !== null && meter.percent >= CONTEXT_NOTE_PERCENT;
  if (!near || !input.compactReady || input.used === null) {
    const dropped = meter.percent !== null && meter.percent < CONTEXT_NOTE_PERCENT;
    return { show: false, opened: false, memory: dropped ? null : input.memory };
  }
  if (input.memory) return { show: true, opened: false, memory: input.memory };
  return { show: true, opened: true, memory: { shownAtUsed: input.used } };
}

/** Walk a conversation's readings and record each time the note first appears. */
export function contextNoteOpenings(
  readings: readonly { used: number | null; window: number | null; compactReady: boolean }[],
): number {
  let memory: ContextNoteMemory | null = null;
  let opened = 0;
  for (const reading of readings) {
    const decision = nextContextNote({ ...reading, memory });
    memory = decision.memory;
    if (decision.opened) opened += 1;
  }
  return opened;
}
