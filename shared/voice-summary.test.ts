import { describe, expect, it } from "vitest";
import { splitVoiceSummary, spokenReply, stripVoiceSummaryTags } from "./voice-summary";

describe("voice summary", () => {
  const reply = "[voice_summary]\nIt is done.\n[/voice_summary]\n[written_answer]\nThe PR is open with tests.\n[/written_answer]";
  it("keeps the full answer and selects the summary for speech", () => {
    expect(splitVoiceSummary(reply)).toEqual({ voice: "It is done.", written: "The PR is open with tests." });
    expect(spokenReply(reply)).toBe("It is done.");
  });

  it("strips brackets and summary from written text display", () => {
    expect(stripVoiceSummaryTags(reply)).toBe("The PR is open with tests.");
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
});
