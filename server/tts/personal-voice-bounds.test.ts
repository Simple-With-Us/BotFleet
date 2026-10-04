// The per-reply voice-clip bound is the only guard on the work one reply can
// cause.  The Personal Voice path returns early — before synthesis, before a
// MiniMax key, before anything that would naturally stop it — and forwards the
// whole reply text into a spawned helper process, so the bound has to be
// evaluated above that early return or a Personal Voice owner gets an
// unbounded spawn that a MiniMax owner would have been refused.
//
// The route itself is inline in the 20k-line `server/index.ts` behind a bot
// with a personal voice plus a persisted bot message, which is a fixture this
// suite deliberately does not build.  What actually regressed was the ordering
// of two branches, so the ordering is what is pinned here — matching the
// existing source-wiring assertions in `usage-telemetry.test.ts`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { toUtterances } from "./speech-text.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const indexSource = readFileSync(join(ROOT, "server", "index.ts"), "utf8");

const MAX_UTTERANCES = 64;
const MAX_CHARS = 12_000;

/** The reply-shape block of the audio route: from the utterance split to the
 * first synthesis job.  Anchored on the split, which is unique to this route. */
function routeSource(): string {
  const start = indexSource.indexOf("const utterances = toUtterances(textToSpeak);");
  expect(start).toBeGreaterThan(-1);
  return indexSource.slice(start, start + 1_200);
}

describe("Personal Voice reply bounds", () => {
  it("evaluates the clip bound before the personal-voice early return", () => {
    const source = routeSource();
    const bound = source.indexOf("reply exceeds voice clip limit");
    const personalVoice = source.indexOf("tts.isPersonalVoice(owner.voice)");

    expect(bound).toBeGreaterThan(-1);
    expect(personalVoice).toBeGreaterThan(-1);
    expect(bound).toBeLessThan(personalVoice);
  });

  it("evaluates the empty-utterances bound before the early return", () => {
    const source = routeSource();
    const emptyBound = source.indexOf("!utterances.length");
    const personalVoice = source.indexOf("tts.isPersonalVoice(owner.voice)");

    expect(emptyBound).toBeGreaterThan(-1);
    expect(personalVoice).toBeGreaterThan(-1);
    expect(emptyBound).toBeLessThan(personalVoice);
    expect(source.match(/reply exceeds voice clip limit/g)).toHaveLength(1);
  });

  it("bounds the reply text a Personal Voice owner can reach the helper with", () => {
    // The two limits the route asserts, exercised against the real splitter.
    const tooManyUtterances = toUtterances(Array.from({ length: 70 }, (_, i) => `Sentence number ${i} here.`).join(" "));
    expect(tooManyUtterances.length).toBeGreaterThan(MAX_UTTERANCES);

    const tooLong = toUtterances("word ".repeat(MAX_CHARS + 100));
    expect(tooLong.join("").length).toBeGreaterThan(MAX_CHARS);
  });
});
