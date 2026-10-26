import { describe, expect, it } from "vitest";

import { stateWithSpeech } from "./mascot";

describe("stateWithSpeech", () => {
  it("draws the bot that is speaking as speaking", () => {
    // The mouth moving is the thing a listener is watching, so the state
    // that says so wins over whatever else the bot happens to be doing.
    expect(stateWithSpeech("working", { status: "speaking", botId: "a" }, "a")).toBe("speaking");
  });

  it("leaves the other bots alone", () => {
    // The snapshot names one bot, so only that bot changes.
    expect(stateWithSpeech("working", { status: "speaking", botId: "a" }, "b")).toBe("working");
  });

  it("keeps the state while the voice is still being prepared", () => {
    // Nothing is audible yet, so there is no mouth to move.
    expect(stateWithSpeech("working", { status: "preparing", botId: "a" }, "a")).toBe("working");
  });

  it("keeps the state when the voice is idle", () => {
    expect(stateWithSpeech("idle", { status: "idle" }, "a")).toBe("idle");
  });

  it("keeps the state when the bot has no id to be named by", () => {
    // Without an id the snapshot cannot say which bot is talking, so nothing
    // changes rather than every bot claiming to be the one speaking.
    expect(stateWithSpeech("working", { status: "speaking", botId: "a" }, undefined)).toBe("working");
  });

  it("has no state of its own to give when the caller had none", () => {
    expect(stateWithSpeech(undefined, { status: "idle" }, "a")).toBeUndefined();
  });
});
