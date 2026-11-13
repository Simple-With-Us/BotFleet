// Horizontal geometry for one chat bubble row.
//
// The rule, in one place: a bubble's width is a function of the transcript's
// width alone.  Nothing that appears beside it may enter that calculation,
// because every bit of it mounts, unmounts and changes width while a thread
// is open:
//
//   * the edit pencil is gated on `!bot.busy`, so it leaves every user
//     message the moment a turn starts and comes back when the turn ends;
//   * Regenerate is gated on `isLastBotText && !bot.busy`, so the newest bot
//     message carries one more button than the ones above it;
//   * the hover timestamp reads "4:39 AM" for today and "8/12 4:39 AM" for
//     any earlier day — about 34px wider — so the messages above a day
//     separator measure differently from the ones below it.
//
// While that chrome sat in the flow beside the bubble it set the bubble's
// used width, and bubbles in one column stopped sharing an edge.  So the
// chrome is out of the flow now: a fixed-width gutter reserves the lane, the
// chrome floats inside it, and the bubble's box never hears about it.  A row
// carries exactly one gutter — leading for the user's own column, trailing
// for a bot's — so nothing sits between a bubble and the edge it aligns to.
//
// Kept as literal strings so Tailwind's scanner sees every class.
//
// The chrome itself stacks three rows tall (date/time; copy, reply, pin;
// reactions) below @4xl of the `chat` container — trading width for height so
// a narrow window doesn't squeeze the bubble — and lays back out as the
// original single row once the container is wide enough that the old, wider
// reserve no longer costs the bubble anything.  See ChatView's `botChrome` /
// human chrome for the three rows themselves.

/** Blank lane reserved beside every bubble for its hover chrome, once it's
 * stacked three rows tall (narrow container: below `@4xl/chat`). */
export const BUBBLE_GUTTER_REM = 7;

/** The same lane, wide enough for the chrome laid out as one row again —
 * unchanged from the original single-row design, and still what's reserved
 * once the container passes `@4xl/chat`. */
export const BUBBLE_GUTTER_REM_WIDE = 13;

/** Widest a bubble is ever allowed to be, chrome or no chrome. */
export const BUBBLE_MAX_WIDTH_REM = 42;

/** `gap-1.5` between the gutter and the bubble, in px. */
export const BUBBLE_ROW_GAP = 6;

/** The row itself.  `flex-nowrap` so a bubble is never pushed onto a line of
 * its own, `items-end` so a short bubble sits on the baseline of a tall one. */
export const BUBBLE_ROW = "flex w-full items-end gap-1.5 flex-nowrap";

/** The reserved lane.  `shrink-0` keeps the reserve honest under pressure,
 * `self-stretch` gives the absolutely positioned chrome inside it a box with
 * the bubble's height to center against, and the width itself grows once the
 * `chat` container (see ChatView) is wide enough to afford the old one-row
 * chrome without squeezing the bubble. */
export const BUBBLE_GUTTER = "relative w-[7rem] shrink-0 self-stretch @4xl/chat:w-[13rem]";

/** The chrome, parked in the gutter and out of the flow.  It is free to be
 * wider than the reserve: it only ever overflows into the blank half of the
 * row, and only while the pointer is over the message.  Stacked (a column of
 * up to three rows) below `@4xl/chat`; a single row, exactly as before,
 * once the container passes it. */
export const BUBBLE_CHROME =
  "absolute inset-y-0 flex flex-col justify-center gap-0.5 @4xl/chat:flex-row @4xl/chat:gap-1.5";

/** Every bubble is capped identically — settled, streaming or being edited. */
export const BUBBLE_MAX_WIDTH = "max-w-[42rem]";

/** A settled bubble hugs its text; `min-w-0` keeps one unbreakable token from
 * forcing the box past the cap and out of the column. */
export const BUBBLE_WIDTH = "w-fit min-w-0 max-w-[42rem]";

/** The inline editor fills the same box a bubble would have had, so opening
 * an editor never moves the message it replaces. */
export const BUBBLE_EDITOR_WIDTH = "w-full min-w-0 max-w-[42rem]";

export type BubbleSide = "user" | "bot";

/** Classes for a bubble row.  Note the argument: which column the message is
 * in is the ONLY thing that may change a bubble's box.
 *
 * `chrome` anchors to the edge nearest the bubble and, stacked, hugs that
 * same edge on every row (`items-end`/`items-start`); once the container is
 * wide enough to fall back to one row, it re-centers vertically like the
 * original design (`@4xl/chat:items-center`). */
export function bubbleRow(side: BubbleSide) {
  const user = side === "user";
  return {
    row: `${BUBBLE_ROW} ${user ? "justify-end" : "justify-start"}`,
    gutter: BUBBLE_GUTTER,
    chrome: `${BUBBLE_CHROME} ${user ? "right-0 items-end @4xl/chat:items-center" : "left-0 items-start @4xl/chat:items-center"}`,
    /** the user's gutter precedes the bubble; a bot's follows it */
    gutterSide: user ? ("leading" as const) : ("trailing" as const),
    width: BUBBLE_WIDTH,
    editorWidth: BUBBLE_EDITOR_WIDTH,
  };
}

/** What a box contributes to the width of the line it sits on.  An
 * absolutely positioned box contributes nothing — that is the whole point of
 * parking the chrome. */
export function flowWidth(className: string, measured: number): number {
  return /(?:^|\s)absolute(?:\s|$)/.test(className) ? 0 : measured;
}

/** Where a user bubble's edges land, derived from the classes above rather
 * than restated: the gutter is the reserve or whatever the chrome actually
 * takes in the flow, whichever is larger. */
export function bubbleBox({
  rowWidth,
  chromeWidth,
  contentWidth,
  rootFontSize = 16,
}: {
  rowWidth: number;
  /** what the chrome measures when it is mounted */
  chromeWidth: number;
  /** the bubble's preferred width — its text on one line */
  contentWidth: number;
  rootFontSize?: number;
}) {
  const gutter = Math.max(BUBBLE_GUTTER_REM * rootFontSize, flowWidth(BUBBLE_CHROME, chromeWidth));
  const available = Math.max(0, rowWidth - gutter - BUBBLE_ROW_GAP);
  const width = Math.min(contentWidth, BUBBLE_MAX_WIDTH_REM * rootFontSize, available);
  // one gutter per row, and it is the leading child: nothing stands between
  // the bubble and the right edge it aligns to
  return { left: rowWidth - width, right: rowWidth, width };
}
