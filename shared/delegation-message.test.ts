import { describe, expect, it } from "vitest";

import {
  DELEGATION_PREFIX_MID,
  DELEGATION_PREFIX_START,
  delegationMessageView,
  isDelegationMessage,
} from "./delegation-message";

describe("shared/delegation-message", () => {
  const sample =
    "[Delegated by @Compiler, another bot in this BotFleet workspace. Do the work and reply directly.]\n\nBotFleet #649 required compile FAILED on main.\n\nPlease check.\n\n[Reason: BotFleet #649 required compile FAILED on main]";

  it("identifies delegation messages by prefix or automationSource", () => {
    expect(isDelegationMessage({ text: sample })).toBe(true);
    expect(isDelegationMessage({ automationSource: "delegation" })).toBe(true);
    expect(isDelegationMessage({ text: "Hello there" })).toBe(false);
    expect(isDelegationMessage({})).toBe(false);
  });

  it("parses prefixed delegation text with reason and payload", () => {
    const view = delegationMessageView(sample);
    expect(view).toEqual({
      senderName: "Compiler",
      reason: "BotFleet #649 required compile FAILED on main",
      payload: "BotFleet #649 required compile FAILED on main.\n\nPlease check.",
      headline: "Delegated by @Compiler",
      subtitle: "Reason: BotFleet #649 required compile FAILED on main",
    });
  });

  it("parses prefixed delegation text without reason", () => {
    const text =
      "[Delegated by @Compiler, another bot in this BotFleet workspace. Do the work and reply directly.]\n\nRun the test suite please.";
    const view = delegationMessageView(text);
    expect(view).toEqual({
      senderName: "Compiler",
      reason: undefined,
      payload: "Run the test suite please.",
      headline: "Delegated by @Compiler",
      subtitle: "Run the test suite please.",
    });
  });

  it("parses delegation from automationSource without prefix", () => {
    const view = delegationMessageView("Execute background audit", "Fixer", "delegation");
    expect(view).toEqual({
      senderName: "Fixer",
      reason: undefined,
      payload: "Execute background audit",
      headline: "Delegated by @Fixer",
      subtitle: "Execute background audit",
    });
  });

  it("returns null for non-delegation messages", () => {
    expect(delegationMessageView("User typed text")).toBeNull();
    expect(delegationMessageView("")).toBeNull();
  });
});
