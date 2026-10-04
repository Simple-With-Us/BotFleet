import { describe, expect, it } from "vitest";
import {
  BUSY_POLL_MS,
  CAPTURE_FAILURE_LIMIT,
  FALLBACK_POLL_MS,
  IDLE_POLL_MS,
  captureFailureIsActionable,
  decideCloudPreview,
  type CloudPreviewGate,
} from "./computer-preview";

const ready: CloudPreviewGate = {
  phase: "ready",
  panelView: "computer",
  botBusy: false,
  sawFrame: false,
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
    expect(decideCloudPreview(gate({ botBusy: true, sawFrame: false })).poll).toBe(true);
    expect(decideCloudPreview(gate({ botBusy: true, sawFrame: false })).intervalMs).toBe(FALLBACK_POLL_MS);
  });

  it("treats a connecting stream as no evidence at all", () => {
    // An open socket is not a frame.  Connecting is the state every panel
    // starts in, so gating on it would hang the preview on first paint.
    expect(decideCloudPreview(gate({ botBusy: true, streamState: "connecting" })).poll).toBe(true);
  });

  it("stops polling once the busy turn has proven it streams frames", () => {
    // The original intent, preserved: no wasted box commands when the stream
    // is already feeding the preview.
    expect(decideCloudPreview(gate({ botBusy: true, sawFrame: true })).poll).toBe(false);
  });

  it("polls at the busy cadence when the stream has failed", () => {
    const decision = decideCloudPreview(gate({ botBusy: true, streamState: "failed" }));
    expect(decision).toEqual({ poll: true, intervalMs: BUSY_POLL_MS });
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
    expect(decideCloudPreview(gate({ botBusy: false, sawFrame: true })).poll).toBe(true);
  });
});

describe("captureFailureIsActionable", () => {
  it("tolerates a transient box failure but reports a persistent one", () => {
    expect(captureFailureIsActionable(0)).toBe(false);
    expect(captureFailureIsActionable(CAPTURE_FAILURE_LIMIT - 1)).toBe(false);
    expect(captureFailureIsActionable(CAPTURE_FAILURE_LIMIT)).toBe(true);
  });
});
