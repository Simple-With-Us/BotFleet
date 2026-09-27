import { describe, expect, it } from "vitest";
import type { Message } from "./store.ts";
import { lastInterruptedChatStarter, resumedDelegationChannel } from "./update-turn-starter.ts";

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

describe("delegated watch restoration", () => {
  const linked: Message = {
    ...starter("delegate", "system", "Check this", "delegation"),
    from: { botId: "source", name: "Source", color: "blue" },
    comm: { groupId: "channel", withBotId: "source", withName: "Source", withColor: "blue" },
  };
  const channel = { id: "channel", dm: true, memberIds: ["source", "target"] };
  it("accepts the exact persisted sender, target, and DM channel", () => {
    expect(resumedDelegationChannel(linked, "target", channel)).toBe("channel");
  });
  it("rejects stale, altered, or unrelated links", () => {
    expect(resumedDelegationChannel({ ...linked, automationSource: "webhook" }, "target", channel)).toBeUndefined();
    expect(resumedDelegationChannel({ ...linked, comm: undefined }, "target", channel)).toBeUndefined();
    expect(resumedDelegationChannel({ ...linked, from: undefined }, "target", channel)).toBeUndefined();
    expect(resumedDelegationChannel({ ...linked, comm: { ...linked.comm!, withBotId: "other" } }, "target", channel)).toBeUndefined();
    expect(resumedDelegationChannel(linked, "other", channel)).toBeUndefined();
    expect(resumedDelegationChannel(linked, "target", { ...channel, dm: false })).toBeUndefined();
    expect(resumedDelegationChannel(linked, "target", { ...channel, id: "other" })).toBeUndefined();
  });
});
