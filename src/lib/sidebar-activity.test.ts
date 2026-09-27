import { describe, expect, it } from "vitest";
import type { Bot, Message } from "@/state/store";
import { botStatusText, botWaitReason } from "./sidebar-activity";

const bot = (id: string, name: string, extra: Partial<Bot> = {}): Bot =>
  ({ id, name, threadId: `${id}0`, ...extra }) as unknown as Bot;

const optionsMessage = (card: Partial<Message["card"]>): Message =>
  ({ id: "m", role: "bot", kind: "options", at: 0, card: { title: "", subtitle: "", options: [], ...card } }) as Message;

const activityMessage = (extra: Partial<Message>): Message =>
  ({ id: "m", role: "bot", kind: "activity", at: 0, ...extra }) as Message;

describe("botWaitReason", () => {
  it("reports a plain question when the bot's own open card has no tool", () => {
    const asker = bot("a", "Alpha", { activity: "waiting-on-you" });
    const last = optionsMessage({ requestId: "r1" });
    expect(botWaitReason(asker, last, [asker])).toEqual({ kind: "question" });
  });

  it("reports approval-needed when the open card is a permission ask", () => {
    const asker = bot("a", "Alpha", { activity: "waiting-on-you" });
    const last = optionsMessage({ requestId: "r1", tool: "Bash" });
    expect(botWaitReason(asker, last, [asker])).toEqual({ kind: "approval" });
  });

  it("names the teammate on a peer-approval card via its allowKey, not the card's prose title", () => {
    const asker = bot("a", "Alpha", { activity: "waiting-on-you" });
    const target = bot("b", "Beta");
    const last = optionsMessage({ requestId: "r1", tool: "ask_bot", allowKey: `ask_bot:${target.id}` });
    expect(botWaitReason(asker, last, [asker, target])).toEqual({ kind: "teammate", name: "Beta" });
  });

  it("falls back to a plain question when waiting-on-you but the last message is not the open card", () => {
    const asker = bot("a", "Alpha", { activity: "waiting-on-you" });
    const last = activityMessage({ tool: { name: "Read file.ts" } });
    expect(botWaitReason(asker, last, [asker])).toEqual({ kind: "question" });
  });

  it("ignores an already-answered card even if it is still the thread tail", () => {
    const asker = bot("a", "Alpha", { activity: "waiting-on-you" });
    const last = optionsMessage({ requestId: "r1", tool: "Bash", answered: "allow" });
    expect(botWaitReason(asker, last, [asker])).toEqual({ kind: "question" });
  });

  it("names the teammate a busy bot just messaged via ask_bot, from the comm chip", () => {
    const asker = bot("a", "Alpha", { busy: true });
    const target = bot("b", "Beta");
    const last = activityMessage({
      tool: { name: "Messaged @Beta" },
      comm: { groupId: "g", withBotId: "b", withName: "Beta", withColor: "blue" },
    });
    expect(botWaitReason(asker, last, [asker, target])).toEqual({ kind: "teammate", name: "Beta" });
  });

  it("names the teammate a busy bot just queued a delegate_bot handoff to, from the chip text", () => {
    const asker = bot("a", "Alpha", { busy: true });
    const target = bot("b", "Beta");
    const last = activityMessage({ tool: { name: "Delegated to @Beta: check the deploy" } });
    expect(botWaitReason(asker, last, [asker, target])).toEqual({ kind: "teammate", name: "Beta" });
  });

  it("does not invent a teammate out of a delegation chip naming a bot that no longer exists", () => {
    const asker = bot("a", "Alpha", { busy: true });
    const last = activityMessage({ tool: { name: "Delegated to @Ghost: cleanup" } });
    expect(botWaitReason(asker, last, [asker])).toBeNull();
  });

  it("returns null for a busy bot doing ordinary work", () => {
    const asker = bot("a", "Alpha", { busy: true });
    const last = activityMessage({ tool: { name: "Read file.ts" } });
    expect(botWaitReason(asker, last, [asker])).toBeNull();
  });

  it("returns null for an idle bot", () => {
    const asker = bot("a", "Alpha", {});
    expect(botWaitReason(asker, undefined, [asker])).toBeNull();
  });
});

describe("botStatusText", () => {
  it("renders each reason's copy and falls back to the pre-existing Working…/empty text", () => {
    const busy = bot("a", "Alpha", { busy: true });
    const idle = bot("a", "Alpha", {});
    expect(botStatusText(busy, { kind: "teammate", name: "Beta" })).toBe("Waiting on @Beta…");
    expect(botStatusText(busy, { kind: "approval" })).toBe("Waiting for approval…");
    expect(botStatusText(busy, { kind: "question" })).toBe("Waiting for you…");
    expect(botStatusText(busy, null)).toBe("Working…");
    expect(botStatusText(idle, null)).toBe("");
  });
});
