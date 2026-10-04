import { describe, expect, it } from "vitest";
import {
  BUSY_POLL_MS,
  CAPTURE_FAILURE_LIMIT,
  FALLBACK_POLL_MS,
  FRAME_STALE_MS,
  IDLE_POLL_MS,
  captureFailureIsActionable,
  decideCloudPreview,
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
    expect(decision.preferPolled).toBe(false);
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
      preferPolled: true,
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

  // The store never clears `state.screens[botId]`, so a turn-1 frame outlives
  // its turn.  If the polled capture cannot outrank it, the fallback succeeds
  // at fetching a picture and the panel still shows the old one.
  it("lets the polled capture outrank a stale live frame whenever it is polling", () => {
    const stale = decideCloudPreview(
      gate({ botBusy: true, lastFrameAt: T0 - FRAME_STALE_MS - 1, nowMs: T0 }),
    );
    expect(stale.preferPolled).toBe(true);
    // ...and the opposite while the stream is genuinely delivering.
    const live = decideCloudPreview(gate({ botBusy: true, lastFrameAt: T0 - 1_000, nowMs: T0 }));
    expect(live.preferPolled).toBe(false);
  });
});

describe("streamIsDelivering", () => {
  it("needs a frame at all, and needs it recent", () => {
    expect(streamIsDelivering(0, T0)).toBe(false);
    expect(streamIsDelivering(T0 - FRAME_STALE_MS + 1, T0)).toBe(true);
    expect(streamIsDelivering(T0 - FRAME_STALE_MS, T0)).toBe(false);
  });

  it("sits above the server's real publish cadence for a remote capture", () => {
    // ScreenPollers fires every 6s with a 3s min gap, but a VPS capture is a
    // ~17s round trip, so a healthy stream publishes every ~20-25s.  A window
    // under that would flap the fallback on every turn.
    expect(FRAME_STALE_MS).toBeGreaterThan(25_000);
  });
});

describe("captureFailureIsActionable", () => {
  it("tolerates a transient box failure but reports a persistent one", () => {
    expect(captureFailureIsActionable(0)).toBe(false);
    expect(captureFailureIsActionable(CAPTURE_FAILURE_LIMIT - 1)).toBe(false);
    expect(captureFailureIsActionable(CAPTURE_FAILURE_LIMIT)).toBe(true);
  });
});
