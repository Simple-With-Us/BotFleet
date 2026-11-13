import { describe, expect, it } from "vitest";

import { instructionCardLabel, modelControlLabel, speakAloudLabel } from "./chat-accessibility";

const GAP = ".\u00A0 ";

describe("instructionCardLabel", () => {
  it("says what fired and the instruction's first line", () => {
    expect(instructionCardLabel({
      headline: "Scheduled Run",
      subtitle: "Check the nightly deploy",
    })).toBe(`Scheduled Run${GAP}Check the nightly deploy`);
  });

  it("names a webhook, its event, the detail, and when it arrived", () => {
    expect(instructionCardLabel({
      name: "Webhook",
      headline: "deployment.failed",
      subtitle: "ci",
      when: "3 minutes ago",
    })).toBe(`Webhook${GAP}deployment.failed${GAP}ci${GAP}3 minutes ago`);
  });

  it("does not repeat a headline that is already the name", () => {
    expect(instructionCardLabel({
      name: "Scheduled Run",
      headline: "Scheduled Run",
      subtitle: "  Scheduled Run  ",
    })).toBe("Scheduled Run");
  });

  it("collapses a blank card to a plain name", () => {
    expect(instructionCardLabel({ headline: "  ", subtitle: "" })).toBe("Automated instruction");
  });
});

describe("modelControlLabel", () => {
  it("keeps the model name when the header shows only the mark", () => {
    expect(modelControlLabel("Claude Sonnet")).toBe("Model, Claude Sonnet");
    expect(modelControlLabel("Claude Sonnet", "Retired")).toBe("Model, Claude Sonnet, Retired");
  });

  it("still names the control when no model is resolved", () => {
    expect(modelControlLabel("  ")).toBe("Model, Choose a model");
  });
});

describe("speakAloudLabel", () => {
  it("says whether spoken replies are on", () => {
    expect(speakAloudLabel(true)).toBe("Speak replies aloud, on");
    expect(speakAloudLabel(false)).toBe("Speak replies aloud, off");
  });
});
