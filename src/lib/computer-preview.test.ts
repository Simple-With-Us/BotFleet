import { describe, expect, it } from "vitest";
import {
  BUSY_POLL_MS,
  CAPTURE_FAILURE_LIMIT,
  FALLBACK_POLL_MS,
  FRAME_STALE_MS,
  IDLE_POLL_MS,
  captureFailureIsActionable,
  decideCloudPreview,
  newestPreview,
  streamIsDelivering,
  type CloudPreviewGate,
} from "./computer-preview";

const T0 = 1_700_000_000_000;

const ready: CloudPreviewGate = {
  phase: "ready",
  panelView: "computer",
  botBusy: false,
  lastFrameAt: 0,
  nowMs: T0,
  streamState: "connected",
  viewerOpen: false,
  pageVisible: true,
};

const gate = (patch: Partial<CloudPreviewGate> = {}): CloudPreviewGate => ({ ...ready, ...patch });

describe("decideCloudPreview", () => {
  // The regression this exists for: a busy bot whose stream has not delivered
  // anything yet used to get no poll and no frames, so the panel spun on
  // "Waiting for the first frame…" until the turn ended.
  it("keeps polling for a busy bot whose stream has not delivered a frame yet", () => {
    const decision = decideCloudPreview(gate({ botBusy: true, lastFrameAt: 0 }));
    expect(decision.poll).toBe(true);
    expect(decision.intervalMs).toBe(FALLBACK_POLL_MS);
  });

  it("treats a connecting stream as no evidence at all", () => {
    // An open socket is not a frame.  Connecting is the state every panel
    // starts in, so gating on it would hang the preview on first paint.
    expect(decideCloudPreview(gate({ botBusy: true, streamState: "connecting" })).poll).toBe(true);
  });

  it("stops polling only while the busy turn is actually delivering", () => {
    // The original intent, preserved: no wasted box commands while the stream
    // is feeding the preview.
    const decision = decideCloudPreview(
      gate({ botBusy: true, lastFrameAt: T0 - 1_000, nowMs: T0 }),
    );
    expect(decision.poll).toBe(false);
  });

  it("resumes polling when a stream that painted once goes quiet", () => {
    // The server's poller swallows capture errors, so "delivered a frame at
    // some point" is not evidence that it still is.  A boolean latched the
    // fallback off for the rest of the turn and froze the preview.
    const decision = decideCloudPreview(
      gate({ botBusy: true, lastFrameAt: T0 - FRAME_STALE_MS - 1, nowMs: T0 }),
    );
    expect(decision.poll).toBe(true);
    expect(decision.intervalMs).toBe(FALLBACK_POLL_MS);
  });

  it("polls at the busy cadence when the stream has failed", () => {
    expect(decideCloudPreview(gate({ botBusy: true, streamState: "failed" }))).toEqual({
      poll: true,
      intervalMs: BUSY_POLL_MS,
    });
  });

  it("keeps the idle cadence for an idle bot with no frame", () => {
    expect(decideCloudPreview(gate({ botBusy: false })).intervalMs).toBe(IDLE_POLL_MS);
  });

  it("does not poll outside a ready cloud computer", () => {
    for (const phase of ["checking", "starting", "vm", "local", "off", "error", "vps-stopped"]) {
      expect(decideCloudPreview(gate({ phase })).poll, phase).toBe(false);
    }
  });

  it("stands down while the live desktop window owns the screen or the page is hidden", () => {
    expect(decideCloudPreview(gate({ botBusy: true, viewerOpen: true })).poll).toBe(false);
    expect(decideCloudPreview(gate({ botBusy: true, pageVisible: false })).poll).toBe(false);
    expect(decideCloudPreview(gate({ panelView: "android" })).poll).toBe(false);
  });

  it("still polls an idle bot with a stale frame, so the preview can refresh", () => {
    expect(decideCloudPreview(gate({ botBusy: false, lastFrameAt: T0 - 1_000 })).poll).toBe(true);
  });

  it("does not claim a source preference in states where it never polls", () => {
    // Nothing polls in these states, so no capture is made fresher by them,
    // and the store's live frame must keep the pre-existing precedence.
    for (const patch of [{ viewerOpen: true }, { pageVisible: false }, { phase: "starting" }]) {
      expect(Object.keys(decideCloudPreview(gate(patch)))).toEqual(["poll", "intervalMs"]);
      expect(decideCloudPreview(gate(patch)).poll, JSON.stringify(patch)).toBe(false);
    }
  });
});

describe("streamIsDelivering", () => {
  it("needs a frame at all, and needs it recent", () => {
    expect(streamIsDelivering(0, T0)).toBe(false);
    expect(streamIsDelivering(T0 - FRAME_STALE_MS + 1, T0)).toBe(true);
    expect(streamIsDelivering(T0 - FRAME_STALE_MS, T0)).toBe(false);
  });

  it("sits well clear of the server's real publish cadence for a remote capture", () => {
    // ScreenPollers fires every 6s with a 3s min gap, but a VPS capture is a
    // ~17s round trip, so a healthy stream publishes every ~20-25s.  Every
    // breach queues another full SSH capture onto an already-slow box, so the
    // window is sized to the worst plausible cadence, not the median.
    expect(FRAME_STALE_MS).toBeGreaterThanOrEqual(45_000);
  });
});

describe("captureFailureIsActionable", () => {
  it("tolerates a transient box failure but reports a persistent one", () => {
    expect(captureFailureIsActionable(0)).toBe(false);
    expect(captureFailureIsActionable(CAPTURE_FAILURE_LIMIT - 1)).toBe(false);
    expect(captureFailureIsActionable(CAPTURE_FAILURE_LIMIT)).toBe(true);
  });
});

describe("newestPreview", () => {
  const live = { png: "live", mime: "image/png" };
  const polled = { png: "polled", mime: "image/png" };

  // Both sources persist — the store never clears `live`, and `polledFrame`
  // survives until a capture replaces it — so preferring by which one exists
  // makes the preview jump backwards in time.
  it("paints the newer capture, not merely the one that exists", () => {
    // Stream delivered at t=5000; capture landed at t=1000.  The capture is
    // older, so the streamed frame wins.
    expect(newestPreview(live, polled, 1_000, 5_000)).toBe(live);
    // Capture landed at t=9000, after the stream's t=5000 frame.
    expect(newestPreview(live, polled, 9_000, 5_000)).toBe(polled);
  });

  it("keeps the turn's final streamed frame after the turn ends", () => {
    // Turn ends with live at t=35s; the last mid-turn capture is older.  The
    // idle poll takes ~17s to land, and until it does the streamed frame is
    // the newer picture.
    expect(newestPreview(live, polled, 17_000, 35_000)).toBe(live);
  });

  it("lets any capture outrank a prior turn when nothing streamed this turn", () => {
    // lastFrameAt resets to 0 on a new turn, so a mid-turn capture cannot be
    // beaten by the previous turn's final frame.
    expect(newestPreview(live, polled, 500, 0)).toBe(polled);
  });

  it("falls back to whichever single source exists", () => {
    expect(newestPreview(live, null, 0, 5_000)).toBe(live);
    expect(newestPreview(undefined, polled, 5_000, 0)).toBe(polled);
    expect(newestPreview(undefined, null, 0, 0)).toBeNull();
  });
});
