import { describe, expect, it } from "vitest";
import { acceptComposerTranscript } from "./composer-dictation";
describe("composer transcript ownership", () => {
  it("accepts a cloud final while mic-off drains, but not later turns", () => {
    expect(acceptComposerTranscript(false, false, false)).toBe(true);
    expect(acceptComposerTranscript(true, true, false)).toBe(true);
    expect(acceptComposerTranscript(true, false, false)).toBe(false);
  });
  it("rejects every update after a call takes the microphone", () => {
    expect(acceptComposerTranscript(false, false, true)).toBe(false);
    expect(acceptComposerTranscript(true, true, true)).toBe(false);
  });
});
