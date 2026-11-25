import { describe, expect, it } from "vitest";

import { BOT_OFF_CODE, BOT_OFF_REFUSAL } from "../shared/bot-power.ts";
import { botAutomationsPausedMessage, botOffError, botStopErrorCode, isBotOffError } from "./bot-stop-policy.ts";

// Stop is this turn; Off is the only hold (owner ruling, BF-2453).  The old
// stop latch — decideBotStop, the bot_stopped refusal, the snooze a Stop
// wrote — is gone from the dispatch path, so what this file pins is what
// remains: the Off refusal error, the predicate retrying callers use to tell
// a deliberate refusal from a provider failure, and the snooze skip receipt.
describe("botOffError", () => {
  it("is a 409 with the Off code and the Off refusal wording", () => {
    const error = botOffError();
    expect(error.status).toBe(409);
    expect(error.code).toBe(BOT_OFF_CODE);
    expect(error.code).not.toBe("bot_stopped");
    expect(error.message).toBe(BOT_OFF_REFUSAL);
    expect(error.message).toMatch(/turn it on/i);
  });
});

describe("isBotOffError", () => {
  it("recognises a deliberate refusal, including the legacy stop code", () => {
    // Callers retry on failure, so mistaking a provider error for a refusal
    // (or the reverse) would either spin or silently drop real work.  The
    // legacy bot_stopped code still arrives from turns refused by a build
    // from before Stop became turn-scoped, and it was the same decision.
    expect(isBotOffError(botOffError())).toBe(true);
    expect(isBotOffError(Object.assign(new Error("stopped"), { code: "bot_stopped" }))).toBe(true);
    expect(isBotOffError(new Error("the provider is out of credit"))).toBe(false);
    expect(isBotOffError(undefined)).toBe(false);
    expect(isBotOffError("bot_off")).toBe(false);
  });
});

describe("botStopErrorCode", () => {
  it("classifies both refusal codes and nothing else", () => {
    // server/jobs/wake.ts (BF-2454) parks differently per code, so the read
    // must stay exact: bot_off, the legacy bot_stopped, or undefined.
    expect(botStopErrorCode(botOffError())).toBe(BOT_OFF_CODE);
    expect(botStopErrorCode(Object.assign(new Error("stopped"), { code: "bot_stopped" }))).toBe("bot_stopped");
    expect(botStopErrorCode(new Error("the provider is out of credit"))).toBeUndefined();
    expect(botStopErrorCode(undefined)).toBeUndefined();
  });
});

describe("botAutomationsPausedMessage", () => {
  it("names a pause, not an offline harness", () => {
    expect(botAutomationsPausedMessage()).toMatch(/Automations paused/i);
    expect(botAutomationsPausedMessage()).not.toMatch(/offline/i);
  });
});
