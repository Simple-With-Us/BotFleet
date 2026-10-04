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
 * stream publishes every ~20-25s.  30s sits just above that.
 *
 * The window is deliberately biased short.  Treating a quiet stream as live
 * freezes the preview on a stale image, which is the bug being fixed; treating
 * a working stream as quiet only costs one extra screenshot, because the
 * fallback's own capture then repaints the panel.  Flapping is cheap,
 * freezing is not.
 */
export const FRAME_STALE_MS = 30_000;

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
  /**
   * True when a polled screenshot is the fresher picture and must win the
   * render.  The store's `live` frame is never cleared, so whenever the gate
   * is polling because the stream has not proven itself, `live` is a stale
   * image from an earlier turn and must not shadow the capture that is
   * actually keeping the preview alive.
   */
  preferPolled: boolean;
}

/** Is the stream demonstrably still delivering as of `nowMs`? */
export function streamIsDelivering(lastFrameAt: number, nowMs: number): boolean {
  return lastFrameAt > 0 && nowMs - lastFrameAt < FRAME_STALE_MS;
}

/**
 * Should the panel fetch a screenshot on its own, and which source should
 * paint while it does?
 *
 * The only case that suppresses the poll is a busy bot whose stream delivered
 * a frame recently.  A busy bot with a quiet stream falls back to polling,
 * because nothing else is going to paint the preview.
 */
export function decideCloudPreview(gate: CloudPreviewGate): CloudPreviewDecision {
  const idle: CloudPreviewDecision = { poll: false, intervalMs: IDLE_POLL_MS, preferPolled: true };
  if (gate.phase !== "ready") return idle;
  if (gate.panelView !== "computer") return idle;
  if (gate.viewerOpen) return idle;
  if (!gate.pageVisible) return idle;

  // A broken stream stops being the preferred source immediately.
  if (gate.streamState === "failed") {
    return { poll: true, intervalMs: gate.botBusy ? BUSY_POLL_MS : IDLE_POLL_MS, preferPolled: true };
  }

  if (gate.botBusy && streamIsDelivering(gate.lastFrameAt, gate.nowMs)) {
    return { poll: false, intervalMs: BUSY_POLL_MS, preferPolled: false };
  }
  if (gate.botBusy) {
    // Busy, and the stream is not currently delivering.  Poll — slowly —
    // because this is the only thing that will ever fill the preview.
    return { poll: true, intervalMs: FALLBACK_POLL_MS, preferPolled: true };
  }
  return { poll: true, intervalMs: IDLE_POLL_MS, preferPolled: true };
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
