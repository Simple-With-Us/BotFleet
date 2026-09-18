import { describe, expect, it } from "vitest";

import {
  allowsMultipleBotThreads,
  automationLaneTitle,
  CONVERSATION_MODES,
  DEFAULT_CONVERSATION_MODE,
  parseConversationMode,
  roomRole,
  rosterPrimaryLabel,
} from "../shared/conversation-mode.ts";

describe("conversation mode", () => {
  it("defaults to simple, and reads leftover fleet as projects", () => {
    expect(DEFAULT_CONVERSATION_MODE).toBe("simple");
    expect(parseConversationMode(undefined)).toBe("simple");
    expect(parseConversationMode("threads")).toBe("simple");
    expect(parseConversationMode("fleet")).toBe("projects");
    expect(parseConversationMode("projects")).toBe("projects");
    expect(CONVERSATION_MODES).toEqual(["simple", "projects"]);
  });

  it("only projects mint extra conversations", () => {
    expect(allowsMultipleBotThreads("simple")).toBe(false);
    expect(allowsMultipleBotThreads("projects")).toBe(true);
  });

  it("treats rooms as group threads in simple and categories in projects", () => {
    expect(roomRole("simple")).toBe("group-thread");
    expect(roomRole("projects")).toBe("category");
    expect(rosterPrimaryLabel("simple").newLabel).toBe("New Bot");
    expect(rosterPrimaryLabel("projects").newLabel).toBe("New Bot");
  });

  it("names automation lanes by type in projects mode", () => {
    expect(automationLaneTitle("simple", "webhook")).toBe("Triggers");
    expect(automationLaneTitle("projects", "webhook")).toBe("Webhooks");
    expect(automationLaneTitle("projects", "resource")).toBe("Resources");
    expect(automationLaneTitle("projects", "schedule")).toBe("Schedules");
  });
});
