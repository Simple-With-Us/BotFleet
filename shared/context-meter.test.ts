import { describe, expect, it } from "vitest";
import {
  COMPACT_SESSION_LABEL,
  CONTEXT_NOTE_PERCENT,
  CONTEXT_NOTE_TEXT,
  compactOffer,
  contextNoteOpenings,
  deriveContextMeter,
  formatContextCount,
  nextContextNote,
} from "./context-meter.ts";

describe("formatContextCount", () => {
  it("floors abbreviations so a window is never painted larger than it is", () => {
    expect(formatContextCount(910_800)).toBe("910.8k");
    expect(formatContextCount(204_800)).toBe("204.8k");
    expect(formatContextCount(1_000_000)).toBe("1M");
    expect(formatContextCount(1_048_576)).toBe("1M");
    expect(formatContextCount(999)).toBe("999");
    expect(formatContextCount(1500)).toBe("1.5k");
  });
});

describe("deriveContextMeter", () => {
  it("matches the engine's used tokens and window", () => {
    const meter = deriveContextMeter({ used: 910_800, reportedWindow: 1_000_000 });
    expect(meter.percent).toBe(91);
    expect(meter.percentLabel).toBe("91% used");
    expect(meter.summary).toBe("910.8k / 1M");
    expect(meter.bar).toBe(91);
    expect(meter.detail).toBe("910,800 of 1,000,000 tokens.");
  });

  it("floors the percent so a partial fill is not called full", () => {
    expect(deriveContextMeter({ used: 999_999, reportedWindow: 1_000_000 }).percent).toBe(99);
    expect(deriveContextMeter({ used: 1_000_000, reportedWindow: 1_000_000 }).percent).toBe(100);
  });

  it("uses the model's window only when the engine did not report one", () => {
    const meter = deriveContextMeter({ used: 100_000, catalogWindow: 200_000 });
    expect(meter.window).toBe(200_000);
    expect(meter.percent).toBe(50);
    const live = deriveContextMeter({ used: 100_000, reportedWindow: 128_000, catalogWindow: 200_000 });
    expect(live.window).toBe(128_000);
    expect(live.percent).toBe(78);
  });

  it("shows tokens without a percent when the window is unknown", () => {
    const meter = deriveContextMeter({ used: 12_400 });
    expect(meter.percent).toBeNull();
    expect(meter.bar).toBeNull();
    expect(meter.summary).toBe("12.4k tokens used");
    expect(meter.detail).toContain("has not reported the window");
  });

  it("shows the window without inventing usage", () => {
    const meter = deriveContextMeter({ catalogWindow: 1_000_000 });
    expect(meter.percent).toBeNull();
    expect(meter.summary).toBe("1M window");
    expect(meter.used).toBeNull();
  });

  it("says when nothing was reported", () => {
    const meter = deriveContextMeter({});
    expect(meter.percent).toBeNull();
    expect(meter.summary).toBe("Usage not reported");
    expect(deriveContextMeter({ used: Number.NaN, reportedWindow: -1 }).percent).toBeNull();
  });

  it("caps the bar at the window and still prints a percent past it", () => {
    const meter = deriveContextMeter({ used: 250_000, reportedWindow: 200_000 });
    expect(meter.percent).toBe(125);
    expect(meter.bar).toBe(100);
  });

  it("treats a reported zero as empty, not as missing", () => {
    expect(deriveContextMeter({ used: 0, reportedWindow: 200_000 }).percent).toBe(0);
  });
});

describe("compactOffer", () => {
  it("hides the action until the menu is known", () => {
    expect(compactOffer(null)).toEqual({ state: "hidden" });
  });

  it("hides it when this engine does not allow compact", () => {
    expect(compactOffer([])).toEqual({ state: "hidden" });
    expect(compactOffer([
      { id: "engine:compress", name: "compress", enabled: true },
      { id: "botfleet:status", name: "status", enabled: true },
    ])).toEqual({ state: "hidden" });
  });

  it("offers compact only from the engine command", () => {
    expect(compactOffer([
      { id: "engine:compact", name: "compact", enabled: true, disabledReason: null },
    ])).toEqual({ state: "ready", commandId: "engine:compact" });
  });

  it("greys a known compact command and keeps the engine's reason", () => {
    expect(compactOffer([
      { id: "engine:compact", name: "compact", enabled: false, disabledReason: "Available after the first reply." },
    ])).toEqual({ state: "disabled", reason: "Available after the first reply." });
  });

  it("uses a plain reason when the engine gave none", () => {
    expect(compactOffer([
      { id: "engine:compact", name: "compact", enabled: false, disabledReason: "  " },
    ])).toEqual({ state: "disabled", reason: "Compact session is not available right now." });
  });
});

describe("nextContextNote", () => {
  const window = 1000;

  it("opens once when the fill crosses the line and stays quiet after later messages", () => {
    const readings = [100, 500, 800, 900, 910].map((used) => ({
      used,
      window,
      compactReady: true,
    }));
    expect(contextNoteOpenings(readings)).toBe(1);
    let memory = null;
    const visible: boolean[] = [];
    for (const reading of readings) {
      const decision = nextContextNote({ ...reading, memory });
      memory = decision.memory;
      visible.push(decision.show);
    }
    expect(visible).toEqual([false, false, true, true, true]);
  });

  it("can speak again only after the fill drops below the line", () => {
    const readings = [
      { used: 900, window, compactReady: true },
      { used: 200, window, compactReady: true },
      { used: 850, window, compactReady: true },
      { used: 860, window, compactReady: true },
    ];
    expect(contextNoteOpenings(readings)).toBe(2);
  });

  it("does not treat a missing reading as a drop or a new note", () => {
    const first = nextContextNote({ used: 900, window, compactReady: true, memory: null });
    expect(first.opened).toBe(true);
    const gap = nextContextNote({ used: null, window, compactReady: true, memory: first.memory });
    expect(gap.show).toBe(false);
    expect(gap.opened).toBe(false);
    expect(gap.memory).toEqual(first.memory);
    const again = nextContextNote({ used: 910, window, compactReady: true, memory: gap.memory });
    expect(again.opened).toBe(false);
    expect(again.show).toBe(true);
  });

  it("stays hidden when compact is not available or the window is unknown", () => {
    expect(contextNoteOpenings([
      { used: 900, window, compactReady: false },
      { used: 950, window, compactReady: false },
    ])).toBe(0);
    expect(contextNoteOpenings([
      { used: 900, window: null, compactReady: true },
    ])).toBe(0);
    expect(nextContextNote({ used: 799, window: 1000, compactReady: true, memory: null }).show).toBe(false);
  });

  it("uses the sentence the thread shows, once", () => {
    expect(CONTEXT_NOTE_TEXT.endsWith(".")).toBe(true);
    expect(CONTEXT_NOTE_TEXT.includes("  ")).toBe(false);
    expect(COMPACT_SESSION_LABEL).toBe("Compact Session");
  });
});
