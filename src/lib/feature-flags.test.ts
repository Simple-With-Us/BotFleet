import { describe, expect, it } from "vitest";

import { showToolCallsEnabled, skillRecorderEnabled, summarizeToolCallsEnabled } from "./feature-flags";

describe("experimental feature flags", () => {
  it("keeps Teach a skill hidden by default", () => {
    expect(skillRecorderEnabled(null)).toBe(false);
    expect(skillRecorderEnabled({})).toBe(false);
    expect(skillRecorderEnabled({ features: { skillRecorder: false } })).toBe(false);
  });

  it("shows Teach a skill only after explicit opt-in", () => {
    expect(skillRecorderEnabled({ features: { skillRecorder: true } })).toBe(true);
  });

  it("shows tool steps by default, on either side of a config the server has not answered yet", () => {
    // the default flipped when a step started carrying its file, its command
    // and its duration — see shared/tool-activity.ts
    expect(showToolCallsEnabled(null)).toBe(true);
    expect(showToolCallsEnabled({})).toBe(true);
    expect(showToolCallsEnabled({ features: { showToolCalls: true } })).toBe(true);
  });

  it("hides tool steps only after an explicit opt-out", () => {
    expect(showToolCallsEnabled({ features: { showToolCalls: false } })).toBe(false);
  });

  it("summarizes tool-call runs by default unless explicitly disabled", () => {
    expect(summarizeToolCallsEnabled(null)).toBe(true);
    expect(summarizeToolCallsEnabled({})).toBe(true);
    expect(summarizeToolCallsEnabled({ features: { summarizeToolCalls: true } })).toBe(true);
    expect(summarizeToolCallsEnabled({ features: { summarizeToolCalls: false } })).toBe(false);
  });
});
