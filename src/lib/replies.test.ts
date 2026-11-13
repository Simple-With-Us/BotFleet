import { describe, expect, it } from "vitest";

import { automationSourceLabel, replyAuthor, replySnippet } from "./replies";
import type { Message } from "@/state/store";

const base: Message = { id: "m1", at: 1, role: "bot", kind: "text", text: "hello" };

describe("reply display", () => {
  it("uses human labels and member attribution", () => {
    expect(replyAuthor({ ...base, role: "user" })).toBe("You");
    expect(replyAuthor({ ...base, from: { botId: "b", name: "Scout", color: "green" } })).toBe("Scout");
    expect(replyAuthor(base, "Mochi")).toBe("Mochi");
  });

  it("labels auto-delivered runs, not You", () => {
    expect(replyAuthor({ ...base, role: "system", text: "Morning brief" })).toBe("Scheduled Run");
  });

  it("labels a manual Run Now or resource alert distinctly, not as Scheduled Run", () => {
    expect(replyAuthor({ ...base, role: "system", automationSource: "manual", text: "Run Now" })).toBe("Run Now");
    expect(replyAuthor({ ...base, role: "system", automationSource: "resource", text: "disk pressure" })).toBe(
      "Resource Alert",
    );
    expect(replyAuthor({ ...base, role: "system", automationSource: "webhook", text: "issue opened" })).toBe(
      "Webhook",
    );
  });

  it("doesn't call a peer bot's ask_bot reply 'You' just because it's role: user", () => {
    // ask_bot replies are mirrored in with role: "user" so they align right
    // like anything else the human sees on that side — but they still carry
    // `from.botId`, and that's what should decide the label, not the role.
    expect(
      replyAuthor({ ...base, role: "user", from: { botId: "b", name: "Scout", color: "green" } }),
    ).toBe("Scout");
  });

  it("turns saved images into a readable bounded snippet", () => {
    expect(replySnippet('<attached-image path="/tmp/a.png" /> hi\nthere')).toBe("[image] hi there");
    expect(replySnippet("123456", 5)).toBe("1234…");
  });
});

describe("automationSourceLabel", () => {
  it("falls back to sniffing the resource-trigger marker on a row persisted before automationSource existed", () => {
    expect(automationSourceLabel(undefined, "some text\n[UNTRUSTED RESOURCE SAMPLE]\n{}")).toBe("Resource Alert");
    expect(automationSourceLabel(undefined, "a real schedule fire")).toBe("Scheduled Run");
  });

  it("prefers the persisted automationSource over sniffing", () => {
    expect(automationSourceLabel("manual", "[UNTRUSTED RESOURCE SAMPLE]")).toBe("Run Now");
    expect(automationSourceLabel("schedule", "anything")).toBe("Scheduled Run");
    expect(automationSourceLabel("delegation", "anything")).toBe("Delegated Task");
  });

  it("sniffs delegation text marker when automationSource is missing", () => {
    expect(
      automationSourceLabel(
        undefined,
        "[Delegated by @Compiler, another bot in this BotFleet workspace. Do the work and reply directly.]\n\nRun CI",
      ),
    ).toBe("Delegated Task");
    expect(automationSourceLabel(undefined, "Consult another bot in this BotFleet workspace tomorrow")).toBe("Scheduled Run");
    expect(automationSourceLabel(undefined, "[Delegated by @Compiler] not the full marker")).toBe("Scheduled Run");
  });
});
