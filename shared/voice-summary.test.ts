import { describe, expect, it } from "vitest";
import { splitVoiceSummary, spokenReply } from "./voice-summary";

describe("voice summary", () => {
  const reply = "[voice_summary]\nIt is done.\n[/voice_summary]\n[written_answer]\nThe PR is open with tests.\n[/written_answer]";
  it("keeps the full answer and selects the summary for speech", () => {
    expect(splitVoiceSummary(reply)).toEqual({ voice: "It is done.", written: "The PR is open with tests." });
    expect(spokenReply(reply)).toBe("It is done.");
  });
  it("does not conceal malformed or incomplete output", () => {
    const incomplete = "[voice_summary]\nhi\n[/voice_summary]\nunfinished";
    expect(splitVoiceSummary(incomplete)).toBeNull();
    expect(spokenReply(incomplete)).toBe(incomplete);
  });
});
