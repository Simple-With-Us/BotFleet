import { describe, expect, it } from "vitest";

import {
  DEFAULT_AUTOMATION_ROLLOVER_CAPS,
  automationRolloverCaps,
  automationRolloverSeedText,
  shouldRolloverAutomationThread,
} from "./automation-rollover.ts";

describe("shouldRolloverAutomationThread", () => {
  it("stays quiet on an empty thread", () => {
    expect(shouldRolloverAutomationThread({ turns: 0, messages: 0 })).toBe(false);
  });

  it("rolls when turns hit the default cap", () => {
    expect(
      shouldRolloverAutomationThread({
        turns: DEFAULT_AUTOMATION_ROLLOVER_CAPS.maxTurns,
        messages: 1,
      }),
    ).toBe(true);
    expect(
      shouldRolloverAutomationThread({
        turns: DEFAULT_AUTOMATION_ROLLOVER_CAPS.maxTurns - 1,
        messages: 1,
      }),
    ).toBe(false);
  });

  it("rolls when messages hit the default cap even if turns are low", () => {
    expect(
      shouldRolloverAutomationThread({
        turns: 2,
        messages: DEFAULT_AUTOMATION_ROLLOVER_CAPS.maxMessages,
      }),
    ).toBe(true);
  });

  it("honors custom caps", () => {
    expect(shouldRolloverAutomationThread({ turns: 10, messages: 1 }, { maxTurns: 10, maxMessages: 100 })).toBe(
      true,
    );
    expect(shouldRolloverAutomationThread({ turns: 9, messages: 99 }, { maxTurns: 10, maxMessages: 100 })).toBe(
      false,
    );
  });
});

describe("automationRolloverCaps", () => {
  it("defaults match the documented constants", () => {
    expect(automationRolloverCaps({})).toEqual(DEFAULT_AUTOMATION_ROLLOVER_CAPS);
  });

  it("reads positive env overrides and ignores junk", () => {
    expect(
      automationRolloverCaps({
        OMB_AUTOMATION_ROLLOVER_MAX_TURNS: "50",
        OMB_AUTOMATION_ROLLOVER_MAX_MESSAGES: "120",
      }),
    ).toEqual({ maxTurns: 50, maxMessages: 120 });
    expect(
      automationRolloverCaps({
        OMB_AUTOMATION_ROLLOVER_MAX_TURNS: "0",
        OMB_AUTOMATION_ROLLOVER_MAX_MESSAGES: "nope",
      }),
    ).toEqual(DEFAULT_AUTOMATION_ROLLOVER_CAPS);
  });
});

describe("automationRolloverSeedText", () => {
  it("points at the previous thread without dumping history", () => {
    const text = automationRolloverSeedText({
      previousThreadId: "abc-123",
      previousTitle: "Compile gates",
      turns: 400,
      messages: 900,
    });
    expect(text).toContain("abc-123");
    expect(text).toContain("Compile gates");
    expect(text).toContain("400 turns");
    expect(text).toContain("900 messages");
    expect(text.toLowerCase()).not.toContain("user:");
    expect(text).toContain("fresh task");
  });
});
