import { describe, expect, it } from "vitest";
import type { Message } from "./store.ts";
import { lastInterruptedChatStarter } from "./update-turn-starter.ts";

const starter = (id: string, role: Message["role"], text: string, automationSource?: Message["automationSource"]): Message =>
  ({ id, at: 1, role, kind: "text", text, automationSource });

describe("forced-update chat starter selection", () => {
  it("chooses the latest delegated system starter over an older human prompt or bot reply", () => {
    const messages = [
      starter("human", "user", "old question"),
      starter("delegate", "system", "Run delegated check", "delegation"),
      starter("reply", "bot", "working"),
    ];
    expect(lastInterruptedChatStarter(messages)?.id).toBe("delegate");
  });
  it("does not treat routine, webhook, or resource instructions as chat turns", () => {
    expect(lastInterruptedChatStarter([
      starter("human", "user", "question"),
      starter("webhook", "system", "hook", "webhook"),
      starter("schedule", "system", "tick", "schedule"),
    ])?.id).toBe("human");
    expect(lastInterruptedChatStarter([starter("resource", "system", "alert", "resource")])).toBeUndefined();
  });
  it("ignores empty text and accepts a legacy user starter", () => {
    expect(lastInterruptedChatStarter([starter("human", "user", "work"), starter("empty", "system", "  ", "delegation")])?.id).toBe("human");
  });
});
