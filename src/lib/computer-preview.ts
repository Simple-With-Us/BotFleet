// How the cloud computer preview decides where its next picture comes from.
//
// The panel has two sources: the harness screen stream (SSE frames pushed
// while a turn is in flight) and an on-demand screenshot POST.  The stream
// only exists between turn dispatch and turn completion, because the server
// registers a poller inside `startTurn` and tears it down when the turn
// settles.  So "the stream is connected" and "the stream is delivering right
// now" are different facts, and conflating them is what made the panel sit
// on "Waiting for the first frame…" for a whole turn.
//
// These are pure so the rule can be pinned by tests instead of by a spinner
// somebody has to watch to believe.

export type ScreenStreamState = "connecting" | "connected" | "failed";

/** The historical busy cadence, kept for the proven-stream case. */
export const BUSY_POLL_MS = 4_000;
/** An idle bot's preview only needs to prove it still works. */
export const IDLE_POLL_MS = 30_000;
/** A silent stream on a busy bot: still the only source, but be gentle. */
export const FALLBACK_POLL_MS = 10_000;

/**
 * How long a delivered frame still counts as evidence that the stream works.
 *
 * The server's poller fires every 6s with a 3s minimum gap, but a remote
 * capture is a real round trip — roughly 17s on the VPS backend — so a healthy
 * stream publishes every ~20-25s, and a box under load can take appreciably
 * longer.
 *
 * The window is sized to the WORST plausible cadence rather than the median.
 * Every breach restarts the poll effect, which fires an immediate full remote
 * screenshot; a box that is already missing its cadence would then absorb
 * another ~17s SSH capture, and if a frame lands first that capture is thrown
 * away.  Tightening the window does not fix a slow stream, it piles load onto
 * the most contended box and amplifies the problem.  The cost of erring long
 * is a dead stream freezing the preview for up to 45s instead of 30s, which
 * is a delay, not a wrong picture.
 */
export const FRAME_STALE_MS = 45_000;

export interface CloudPreviewGate {
  /** Panel phase; only a ready cloud computer has a preview to fetch. */
  phase: string;
  /** The Android/Computer tab switch. */
  panelView: string;
  /** The bot is mid-turn, so a turn-scoped stream is the cheaper source. */
  botBusy: boolean;
  /**
   * When the stream last delivered a frame for the current turn, or 0 for
   * never.  A frame proves the stream *can* deliver, not that it still is.
   */
  lastFrameAt: number;
  /** Injected clock, so the staleness rule is testable. */
  nowMs: number;
  streamState: ScreenStreamState;
  /** The standalone live-desktop window owns the screen while it is open. */
  viewerOpen: boolean;
  pageVisible: boolean;
}

export interface CloudPreviewDecision {
  poll: boolean;
  /**
   * Milliseconds between screenshot attempts.  A remote capture costs real
   * wall-clock time, so the silent-stream fallback deliberately polls slower
   * than the historical busy cadence rather than queueing captures that
   * cannot possibly land in time.
   */
  intervalMs: number;
}

/** Is the stream demonstrably still delivering as of `nowMs`? */
export function streamIsDelivering(lastFrameAt: number, nowMs: number): boolean {
  return lastFrameAt > 0 && nowMs - lastFrameAt < FRAME_STALE_MS;
}

/**
 * Should the panel fetch a screenshot on its own?
 *
 * The only case that suppresses the poll is a busy bot whose stream delivered
 * a frame recently.  A busy bot with a quiet stream falls back to polling,
 * because nothing else is going to paint the preview.
 */
export function decideCloudPreview(gate: CloudPreviewGate): CloudPreviewDecision {
  const idle: CloudPreviewDecision = { poll: false, intervalMs: IDLE_POLL_MS };
  if (gate.phase !== "ready") return idle;
  if (gate.panelView !== "computer") return idle;
  if (gate.viewerOpen) return idle;
  if (!gate.pageVisible) return idle;

  // A broken stream stops being the preferred source immediately.
  if (gate.streamState === "failed") {
    return { poll: true, intervalMs: gate.botBusy ? BUSY_POLL_MS : IDLE_POLL_MS };
  }

  if (gate.botBusy && streamIsDelivering(gate.lastFrameAt, gate.nowMs)) {
    return { poll: false, intervalMs: BUSY_POLL_MS };
  }
  if (gate.botBusy) {
    // Busy, and the stream is not currently delivering.  Poll — slowly —
    // because this is the only thing that will ever fill the preview.
    return { poll: true, intervalMs: FALLBACK_POLL_MS };
  }
  return { poll: true, intervalMs: IDLE_POLL_MS };
}

/** A preview picture, from either source. */
export interface PreviewFrame {
  png: string;
  mime: string;
}

/**
 * Which picture to paint, decided by AGE and never by nullability.
 *
 * Both sources persist: the store's `live` frame is written but never
 * cleared, and `polledFrame` is replaced only when a capture lands.  So
 * "one exists" says nothing about which is newer, and preferring by
 * nullability makes the preview jump backwards in time — a mid-turn capture
 * left over from before a turn ends would outrank the turn's final streamed
 * frame.  Timestamps are the only honest comparison, and `lastFrameAt === 0`
 * (nothing streamed this turn) correctly lets any capture outrank a prior
 * turn's frame.
 */
export function newestPreview(
  live: PreviewFrame | undefined,
  polled: PreviewFrame | null,
  polledAt: number,
  lastFrameAt: number,
): PreviewFrame | null {
  if (polled && polledAt > lastFrameAt) return polled;
  return live ?? polled ?? null;
}

/**
 * Consecutive failed captures tolerated before the panel says so out loud.
 * A box mid-command fails transiently and must not raise an alarm; a box that
 * fails every time must not be allowed to look like a slow one.
 */
export const CAPTURE_FAILURE_LIMIT = 3;

/** Has the capture been failing long enough to be worth telling the user? */
export function captureFailureIsActionable(failures: number): boolean {
  return failures >= CAPTURE_FAILURE_LIMIT;
}

/**
 * Should a cloud capture error be taken down because the cloud capture stopped?
 *
 * The banner is cleared by the next GOOD capture, so it is only ever as stale as
 * the gap between the last failure and the next success.  The poll effect is
 * torn down the moment the gate stops asking for captures — a turn's stream
 * resumes and delivers, the viewer opens, the tab is hidden — and a torn-down
 * effect never comes back with a success, so the red "Couldn't capture this
 * computer's screen" banner sits over a preview that is updating perfectly
 * well.  An error that outlives its cause is its own bug.
 *
 * The cloud path ONLY, deliberately.  `phase === "vm"` also reports
 * `poll: false`, and the Local VM's own capture failure writes the same
 * `captureProblem` string with its own `vmFailures` counter; resetting on a
 * blanket `!poll` would erase a live, accurate VM error and, worse, zero the
 * counter so the next transient desktop hiccup re-raised the banner after a
 * single failure.  Anything that is not a cloud phase is somebody else's
 * message.
 */
export function cloudCaptureErrorIsStale(phase: string, poll: boolean): boolean {
  return phase === "ready" && !poll;
}
