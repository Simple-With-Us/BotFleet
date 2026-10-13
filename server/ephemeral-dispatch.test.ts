import { describe, expect, it } from "vitest";

import { formatEphemeralResultMessage } from "./ephemeral-dispatch.ts";

describe("formatEphemeralResultMessage", () => {
  it("wraps successful output with the routine name", () => {
    expect(
      formatEphemeralResultMessage({
        ownerThreadId: "owner",
        ephemeralThreadId: "ephemeral",
        routineName: "Designer classify",
        ok: true,
        output: "pass",
      }),
    ).toBe("[Designer classify] pass");
  });

  it("reports empty success without pretending there was text", () => {
    expect(
      formatEphemeralResultMessage({
        ownerThreadId: "owner",
        ephemeralThreadId: "ephemeral",
        routineName: "Gate",
        ok: true,
        output: "   ",
      }),
    ).toBe("[Gate] One-shot run completed with no text output.");
  });

  it("surfaces failure detail on the owner thread", () => {
    expect(
      formatEphemeralResultMessage({
        ownerThreadId: "owner",
        ephemeralThreadId: "ephemeral",
        routineName: "Webhook",
        ok: false,
        error: "engine offline",
      }),
    ).toBe("[Webhook] One-shot run failed: engine offline");
  });
});
