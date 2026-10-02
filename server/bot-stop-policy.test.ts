import { describe, expect, it } from "vitest";

import { botStopRefusalMessage, decideBotStop, isBotStoppedError } from "./bot-stop-policy.ts";

// The rule under test, in one sentence: a bot a person stopped stays stopped
// until a person asks for it again.  The regression this file exists for is
// the update/boot resume clearing that stop and re-dispatching the bot by
// itself — which is what "the bot I stopped restarted on its own" was.
describe("decideBotStop", () => {
  it("refuses a system-initiated dispatch to a stopped bot", () => {
    expect(decideBotStop({ stopped: true, personInitiated: false })).toEqual({
      action: "refuse",
      reason: "bot-stopped",
    });
  });

  it("lets a person's own turn through and lifts the stop", () => {
    // Typing into a stopped bot is how you start it again.  Nothing here may
    // regress: a stop that also blocked the owner would be unusable.
    expect(decideBotStop({ stopped: true, personInitiated: true })).toEqual({
      action: "allow",
      clearsStop: true,
    });
  });

  it("allows system work on a bot that is not stopped, without clearing anything", () => {
    expect(decideBotStop({ stopped: false, personInitiated: false })).toEqual({
      action: "allow",
      clearsStop: false,
    });
  });

  it("never lets a system dispatch clear a stop, whatever it is handed", () => {
    // The original bug was a resume carrying a person's OLD prompt.  Whether
    // the bot is stopped or not, a system turn must not touch the flag; the
    // stopped case is the one that has to refuse rather than proceed.
    for (const stopped of [true, false]) {
      const decision = decideBotStop({ stopped, personInitiated: false });
      expect(decision.action === "allow" ? decision.clearsStop : false).toBe(false);
    }
  });
});

describe("isBotStoppedError", () => {
  it("recognises only this policy's refusal, not a real dispatch failure", () => {
    // Callers retry on failure, so mistaking a provider error for a stop (or
    // the reverse) would either spin or silently drop real work.
    expect(isBotStoppedError(Object.assign(new Error("stopped"), { code: "bot_stopped" }))).toBe(true);
    expect(isBotStoppedError(new Error("the provider is out of credit"))).toBe(false);
    expect(isBotStoppedError(undefined)).toBe(false);
    expect(isBotStoppedError("bot_stopped")).toBe(false);
  });
});

describe("botStopRefusalMessage", () => {
  it("tells the person how to undo it", () => {
    expect(botStopRefusalMessage()).toMatch(/stopped/i);
    expect(botStopRefusalMessage()).toMatch(/start it again/i);
  });
});
