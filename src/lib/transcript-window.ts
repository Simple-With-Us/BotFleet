/** Long computer-use threads carry hundreds of rows (inline screenshots
 * included); mounting all of them makes the DOM heavy even though the memoized
 * list bails out of re-renders. Only the last `TRANSCRIPT_WINDOW_SIZE`
 * *display* items mount by default; a pill expands by the same step.
 *
 * Display items, not raw rows: tool chips are off by default, and even when
 * they are on they fold into runs. Counting raw messages let a 133-tool turn
 * push the user prompt that started it out of the default tail — the reader
 * could scroll into earlier calendar days and never see the prompt. */
export const TRANSCRIPT_WINDOW_SIZE = 120;

/** Minimal shape the display-aware window needs. Matches `Message` without
 * importing the store, so this file stays a pure helper. */
export interface WindowableMessage {
  kind?: string;
  role?: string;
  at?: number;
  tool?: { name?: string; ok?: boolean };
  comm?: unknown;
  from?: { botId?: string };
}

export interface TranscriptWindow<T> {
  visible: T[];
  /** Messages hidden before the window — the pill's "(X more)" count. */
  hiddenCount: number;
  /** Messages hidden after a finite search-focus window. */
  laterCount: number;
  /** The boundary actually applied after clamping; expand steps from this,
   * not from the stored value, so a clamped window expands predictably. */
  startIndex: number;
  /** Exclusive end boundary, or the current list length for a tail window. */
  endIndex: number;
}

export interface TranscriptWindowRange {
  start: number;
  end: number;
}

/** Boundary for a fresh window: the last `size` messages. */
export function tailWindowStart(total: number, size: number = TRANSCRIPT_WINDOW_SIZE): number {
  return Math.max(0, total - size);
}

/** One "Show earlier" click: pull the boundary back by another `size`. */
export function expandWindowStart(startIndex: number, size: number = TRANSCRIPT_WINDOW_SIZE): number {
  return Math.max(0, startIndex - size);
}

/** A bounded window containing a search target. Keeping this finite avoids
 * mounting an entire old transcript merely to land on one result. */
export function focusWindowRange(
  total: number,
  targetIndex: number,
  size: number = TRANSCRIPT_WINDOW_SIZE,
): TranscriptWindowRange {
  const safeTotal = Math.max(0, total);
  const safeSize = Math.max(1, size);
  const target = Math.max(0, Math.min(targetIndex, Math.max(0, safeTotal - 1)));
  const start = Math.max(0, Math.min(target - Math.floor(safeSize / 2), Math.max(0, safeTotal - safeSize)));
  return { start, end: Math.min(safeTotal, start + safeSize) };
}

/** Resolve a stored boundary against the current list. The boundary is
 * anchored — appends grow the window instead of sliding it, so rows the
 * reader is looking at never drop out from under them. Anchoring means a
 * thread that shrinks (branch switch, edit rewinding the tail) can leave the
 * boundary at or past the new end; that stale boundary falls back to a fresh
 * tail window rather than blanking the transcript. */
export function resolveTranscriptWindow<T>(
  messages: readonly T[],
  startIndex: number,
  size: number = TRANSCRIPT_WINDOW_SIZE,
  endIndex: number | null = null,
): TranscriptWindow<T> {
  const requestedEnd = endIndex === null ? messages.length : Math.max(0, Math.min(messages.length, endIndex));
  const invalidFiniteWindow = endIndex !== null && startIndex >= requestedEnd;
  const start =
    startIndex >= messages.length || invalidFiniteWindow
      ? tailWindowStart(messages.length, size)
      : Math.max(0, startIndex);
  const end = invalidFiniteWindow ? messages.length : Math.max(start, requestedEnd);
  return {
    visible: messages.slice(start, end),
    hiddenCount: start,
    laterCount: messages.length - end,
    startIndex: start,
    endIndex: end,
  };
}

export interface DisplayWindowOptions {
  includeToolCalls: boolean;
  summarizeToolCalls: boolean;
  size?: number;
}

/** A finished tool chip that Settings currently hides. Errors and bot⇄bot
 * comm chips stay visible even with tool calls off. */
export function isHiddenToolCall(
  message: WindowableMessage,
  includeToolCalls: boolean,
): boolean {
  if (includeToolCalls) return false;
  if (message.kind !== "activity") return false;
  if (message.comm) return false;
  if (message.tool?.name?.startsWith("error:")) return false;
  return true;
}

function isSummarizableTool(message: WindowableMessage): boolean {
  if (message.kind !== "activity" || !message.tool) return false;
  if (message.comm) return false;
  if (message.tool.ok !== true) return false;
  return !message.tool.name?.startsWith("error:");
}

function sameToolRun(left: WindowableMessage, right: WindowableMessage): boolean {
  if (left.role !== right.role) return false;
  if (left.from?.botId !== right.from?.botId) return false;
  if (
    left.at !== undefined &&
    right.at !== undefined &&
    new Date(left.at).toDateString() !== new Date(right.at).toDateString()
  ) {
    return false;
  }
  return true;
}

/** Start index of each on-screen item, oldest first. Hidden tool chips are
 * skipped; consecutive finished tools collapse to one item when summarizing. */
export function displayItemStarts(
  messages: readonly WindowableMessage[],
  options: DisplayWindowOptions,
): number[] {
  const starts: number[] = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i]!;
    if (isHiddenToolCall(message, options.includeToolCalls)) {
      i += 1;
      continue;
    }
    if (options.summarizeToolCalls && isSummarizableTool(message)) {
      starts.push(i);
      i += 1;
      while (
        i < messages.length &&
        isSummarizableTool(messages[i]!) &&
        sameToolRun(message, messages[i]!)
      ) {
        i += 1;
      }
      continue;
    }
    starts.push(i);
    i += 1;
  }
  return starts;
}

/** Boundary for a fresh window counted in display items, not raw rows. */
export function tailDisplayWindowStart(
  messages: readonly WindowableMessage[],
  options: DisplayWindowOptions,
): number {
  const starts = displayItemStarts(messages, options);
  const size = options.size ?? TRANSCRIPT_WINDOW_SIZE;
  if (starts.length <= size) return 0;
  return starts[starts.length - size]!;
}

/** One "Show earlier" click: pull back another `size` display items. */
export function expandDisplayWindowStart(
  messages: readonly WindowableMessage[],
  startIndex: number,
  options: DisplayWindowOptions,
): number {
  const starts = displayItemStarts(messages, options);
  const size = options.size ?? TRANSCRIPT_WINDOW_SIZE;
  const current = starts.findIndex((start) => start >= startIndex);
  const from = current === -1 ? starts.length : current;
  const next = Math.max(0, from - size);
  return starts[next] ?? 0;
}

/** How many on-screen items sit before `startIndex` — the pill's count. */
export function hiddenDisplayCount(
  messages: readonly WindowableMessage[],
  startIndex: number,
  options: DisplayWindowOptions,
): number {
  return displayItemStarts(messages, options).filter((start) => start < startIndex).length;
}
