import { describe, expect, it } from "vitest";

import { BOT_OFF_CODE, BOT_OFF_REFUSAL } from "../shared/bot-power.ts";
import { botOffError, isBotOffError } from "./bot-stop-policy.ts";

// The rule under test, in one sentence: Stop cancels only the turn in flight
// and latches nothing, so the only refusal this module still names is an Off
// bot (docs/decisions/2026-11-23-stop-is-this-turn.md).  The regression this
// file exists for is a latch returning in disguise — a persisted stop, a
// snooze, a "stays stopped" gate — which is why the module exports nothing
// that consults stop state.
describe("botOffError", () => {
  it("is a 409 with the stable Off code and the shared refusal wording", () => {
    const error = botOffError();
    expect(error.status).toBe(409);
    expect(error.code).toBe(BOT_OFF_CODE);
    expect(error.message).toBe(BOT_OFF_REFUSAL);
    expect(error).toBeInstanceOf(Error);
  });
});

describe("isBotOffError", () => {
  it("recognizes an Off refusal by its code", () => {
    expect(isBotOffError(botOffError())).toBe(true);
    expect(isBotOffError(Object.assign(new Error("off"), { code: BOT_OFF_CODE }))).toBe(true);
  });

  it("does not classify a provider fault as a decision", () => {
    expect(isBotOffError(new Error("the provider is out of credit"))).toBe(false);
    expect(isBotOffError(undefined)).toBe(false);
    expect(isBotOffError(null)).toBe(false);
    expect(isBotOffError("bot_off")).toBe(false);
  });

  it("does not revive the retired stop latch: a legacy bot_stopped error is not an Off refusal", () => {
    // Nothing throws bot_stopped anymore; if old code or an old peer does,
    // it is an ordinary failure, never a quiet settle.
    expect(isBotOffError(Object.assign(new Error("stopped"), { code: "bot_stopped" }))).toBe(false);
  });
});

describe("the module surface", () => {
  it("exposes no stop state to consult: Stop is this turn, so there is nothing to decide", async () => {
    const policy = await import("./bot-stop-policy.ts");
    expect(Object.keys(policy).sort()).toEqual(["botOffError", "isBotOffError"]);
  });
});
