// How the cloud computer preview decides where its next picture comes from.
//
// The panel has two sources: the harness screen stream (SSE frames pushed
// while a turn is in flight) and an on-demand screenshot POST.  The stream
// only exists between turn dispatch and turn completion, because the server
// registers a poller inside `startTurn` and tears it down when the turn
// settles.  So "the stream is connected" and "the stream will ever deliver a
// frame" are different facts, and conflating them is what made the panel sit
// on "Waiting for the first frame…" for a whole turn.
//
// These are pure so the rule can be pinned by tests instead of by a spinner
// somebody has to watch to believe.

export type ScreenStreamState = "connecting" | "connected" | "failed";

export interface CloudPreviewGate {
  /** Panel phase; only a ready cloud computer has a preview to fetch. */
  phase: string;
  /** The Android/Computer tab switch. */
  panelView: string;
  /** The bot is mid-turn, so a turn-scoped stream is the cheaper source. */
  botBusy: boolean;
  /**
   * Has the CURRENT turn's stream actually delivered a frame?  This — not the
   * socket being open — is what proves the stream can feed the preview.
   */
  sawFrame: boolean;
  streamState: ScreenStreamState;
  /** The standalone live-desktop window owns the screen while it is open. */
  viewerOpen: boolean;
  pageVisible: boolean;
}

export interface CloudPreviewDecision {
  poll: boolean;
  /**
   * Milliseconds between screenshot attempts.  A remote capture costs real
   * wall-clock time (seconds over SSH on the VPS backend), so the silent-stream
   * fallback deliberately polls slower than the historical busy cadence rather
   * than queueing captures that cannot possibly land in time.
   */
  intervalMs: number;
}

/** The historical busy cadence, kept for the proven-stream case. */
export const BUSY_POLL_MS = 4_000;
/** An idle bot's preview only needs to prove it still works. */
export const IDLE_POLL_MS = 30_000;
/** A silent stream on a busy bot: still the only source, but be gentle. */
export const FALLBACK_POLL_MS = 10_000;

/**
 * Should the panel fetch a screenshot on its own?
 *
 * The only case that suppresses the poll is a busy bot whose current turn has
 * already proven it streams frames — there the stream is cheaper and the
 * screenshot is a wasted box command.  A busy bot with no frame yet falls back
 * to polling, because nothing else is going to paint the preview.
 */
export function decideCloudPreview(gate: CloudPreviewGate): CloudPreviewDecision {
  if (gate.phase !== "ready") return { poll: false, intervalMs: IDLE_POLL_MS };
  if (gate.panelView !== "computer") return { poll: false, intervalMs: IDLE_POLL_MS };
  if (gate.viewerOpen) return { poll: false, intervalMs: IDLE_POLL_MS };
  if (!gate.pageVisible) return { poll: false, intervalMs: IDLE_POLL_MS };

  // A broken stream stops being the preferred source immediately.
  if (gate.streamState === "failed") {
    return { poll: true, intervalMs: gate.botBusy ? BUSY_POLL_MS : IDLE_POLL_MS };
  }

  if (gate.botBusy && gate.sawFrame) {
    return { poll: false, intervalMs: BUSY_POLL_MS };
  }
  if (gate.botBusy) {
    // Busy, stream open, and still nothing.  Poll — slowly — because this is
    // the only thing that will ever fill the preview for this turn.
    return { poll: true, intervalMs: FALLBACK_POLL_MS };
  }
  return { poll: true, intervalMs: IDLE_POLL_MS };
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
