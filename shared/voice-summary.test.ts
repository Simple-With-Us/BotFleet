import { describe, expect, it } from "vitest";
import {
  resolveVoiceSummaryMode,
  voiceScriptKind,
  splitVoiceSummary,
  spokenReply,
  stripVoiceSummaryTags,
  writtenReply,
} from "./voice-summary";

describe("voice summary", () => {
  const reply = "[voice_summary]\nIt is done.\n[/voice_summary]\n[written_answer]\nThe PR is open with tests.\n[/written_answer]";
  it("keeps the full answer and selects the summary for speech", () => {
    expect(splitVoiceSummary(reply)).toEqual({ voice: "It is done.", written: "The PR is open with tests." });
    expect(spokenReply(reply)).toBe("It is done.");
  });

  it("strips brackets and summary from written text display", () => {
    expect(stripVoiceSummaryTags(reply)).toBe("The PR is open with tests.");
  });

  it("writtenReply returns full written answer or strips tags", () => {
    expect(writtenReply(reply)).toBe("The PR is open with tests.");
    expect(writtenReply("Plain reply without any tags")).toBe("Plain reply without any tags");
  });

  it("never reads bracket tags even on malformed or incomplete output", () => {
    const incomplete = "[voice_summary]\nhi\n[/voice_summary]\nunfinished";
    expect(spokenReply(incomplete)).toBe("hi");
    expect(stripVoiceSummaryTags(incomplete)).toBe("unfinished");
  });

  it("handles streaming written answers without brackets", () => {
    const streaming = "[voice_summary]\nSummary here.\n[/voice_summary]\n[written_answer]\nStreaming answer in progress...";
    expect(stripVoiceSummaryTags(streaming)).toBe("Streaming answer in progress...");
    expect(spokenReply(streaming)).toBe("Summary here.");
  });

  it("preserves ordinary text that mentions [written_answer] without protocol start", () => {
    const ordinary = "Here is an example code snippet that mentions [written_answer] in a comment.";
    expect(stripVoiceSummaryTags(ordinary)).toBe(ordinary);
  });

  describe("resolveVoiceSummaryMode", () => {
    it("reads the reply as written when no mode is saved, for voice bots and text-only bots alike", () => {
      expect(resolveVoiceSummaryMode({})).toBe("off");
      expect(resolveVoiceSummaryMode(null)).toBe("off");
      expect(resolveVoiceSummaryMode(undefined)).toBe("off");
      const voiceBot: { voiceSummaryMode?: "off" | "on_demand" | "always"; speakReplies: boolean; speechDevices: string[] } = {
        speakReplies: true,
        speechDevices: ["mac"],
      };
      expect(resolveVoiceSummaryMode(voiceBot)).toBe("off");
      expect(voiceScriptKind(voiceBot)).toBe("written");
    });

    it("keeps an explicit mode", () => {
      expect(resolveVoiceSummaryMode({ voiceSummaryMode: "off" })).toBe("off");
      expect(resolveVoiceSummaryMode({ voiceSummaryMode: "on_demand" })).toBe("on_demand");
      expect(resolveVoiceSummaryMode({ voiceSummaryMode: "always" })).toBe("always");
    });

    it("speaks a summary only when the owner picked one", () => {
      expect(voiceScriptKind({ voiceSummaryMode: "off" })).toBe("written");
      expect(voiceScriptKind({ voiceSummaryMode: "on_demand" })).toBe("summary");
      expect(voiceScriptKind({ voiceSummaryMode: "always" })).toBe("summary");
    });
  });
});

describe("literal delimiters inside the written answer", () => {
  it("does not truncate the written answer at a quoted closing tag", () => {
    const text = "[voice_summary]Short.[/voice_summary]\n[written_answer]Use the tag [/written_answer] to end it, then continue with more detail.[/written_answer]";
    expect(stripVoiceSummaryTags(text)).toContain("then continue with more detail.");
    expect(splitVoiceSummary(text)?.written).toContain("then continue with more detail.");
  });
});
