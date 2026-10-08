// The aligner decides which word on screen lights up while a voice reads the
// message.  These pin the behaviours the owner asked for: a skipped word is
// swept quickly, an added word does not drag the highlight forward, and a
// number read out ("seven four nine") still lands on "749".
//
// The cases also feed the shared fixture the Swift mirror reads.  Regenerate
// after a deliberate change with:
//   UPDATE_SPEECH_FIXTURES=1 pnpm exec vitest run shared/karaoke-align.test.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  alignSpokenToDisplay,
  buildKaraokeTimeline,
  estimatedClips,
  fuzzyWordMatch,
  numberKey,
  proportionalWordTimes,
  SPOKEN_EQUIVALENT,
  SPOKEN_EXACT,
  SPOKEN_EXPANDED,
  SPOKEN_INSERTED,
  tokenizeWords,
  wordIndexAtOffset,
  wordKey,
  type KaraokeAlignment,
} from "./karaoke-align.ts";
import { speakableWithSpans, utterancesWithSpans } from "./speech-spans.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "ios", "Tests", "CompanionCoreTests", "Fixtures", "karaoke-align.json");

/** Display word each spoken word landed on, as text ("-" for none). */
function landed(a: KaraokeAlignment): string[] {
  return a.spokenWords.map((_, i) => {
    const j = a.mapping.spokenToDisplay[i];
    return j >= 0 ? a.displayWords[j].text : "-";
  });
}

/** Spoken times: word i spoken over [i*300, i*300+250). */
function evenTimes(count: number): Float64Array {
  const out = new Float64Array(count * 2);
  for (let i = 0; i < count; i += 1) {
    out[2 * i] = i * 300;
    out[2 * i + 1] = i * 300 + 250;
  }
  return out;
}

describe("tokenizeWords", () => {
  it("splits on punctuation and keeps apostrophes inside words", () => {
    expect(tokenizeWords("It's 3.5x — twenty-three “quotes”, don’t!").map((w) => w.text)).toEqual([
      "It's", "3", "5x", "twenty", "three", "quotes", "don’t",
    ]);
  });

  it("reports UTF-16 offsets, including after astral characters", () => {
    const text = "🚀 launch café";
    const words = tokenizeWords(text);
    expect(words.map((w) => [w.start, w.end])).toEqual([[3, 9], [10, 14]]);
    expect(words.map((w) => text.slice(w.start, w.end))).toEqual(["launch", "café"]);
  });

  it("compares words without case, accents or apostrophes", () => {
    expect(wordKey("Don’t")).toBe(wordKey("dont"));
    expect(wordKey("CAFÉ")).toBe("cafe");
    expect(wordKey("ﬁle")).toBe("file");
  });
});

describe("numberKey and fuzzy matching", () => {
  it("reads digits and number words as values", () => {
    expect(numberKey("749")).toBe("749");
    expect(numberKey("007")).toBe("7");
    expect(numberKey("seven")).toBe("7");
    expect(numberKey("twenty")).toBe("20");
    expect(numberKey("hundred")).toBeNull();
  });

  it("tolerates a small spelling difference only between similar long words", () => {
    expect(fuzzyWordMatch("colour", "color")).toBe(true);
    expect(fuzzyWordMatch("analyse", "analyze")).toBe(true);
    expect(fuzzyWordMatch("cat", "car")).toBe(false);
    expect(fuzzyWordMatch("build", "guild")).toBe(false);
  });
});

describe("alignSpokenToDisplay", () => {
  it("pairs identical text word for word", () => {
    const a = alignSpokenToDisplay({ spokenText: "The tests pass now.", displayText: "The tests pass now." });
    expect(Array.from(a.mapping.spokenToDisplay)).toEqual([0, 1, 2, 3]);
    expect(Array.from(a.mapping.spokenKind)).toEqual([1, 1, 1, 1]);
  });

  it("skips display words the voice left out", () => {
    const a = alignSpokenToDisplay({
      spokenText: "I changed core.ts today",
      displayText: "I changed server/drivers/acp/core.ts today",
    });
    expect(landed(a)).toEqual(["I", "changed", "core", "ts", "today"]);
    const skipped = a.displayWords.filter((_, j) => a.mapping.displayFirstSpoken[j] < 0).map((w) => w.text);
    expect(skipped).toEqual(["server", "drivers", "acp"]);
  });

  it("attaches words the voice added to the word before them", () => {
    const a = alignSpokenToDisplay({
      spokenText: "Fixed it. (a TypeScript code block) That's it.",
      displayText: "Fixed it:\nThat's it.",
    });
    expect(landed(a)).toEqual(["Fixed", "it", "it", "it", "it", "it", "That's", "it"]);
    expect(Array.from(a.mapping.spokenKind).slice(2, 6)).toEqual([0, 0, 0, 0]);
  });

  it("lands digits read one by one on the number", () => {
    const a = alignSpokenToDisplay({ spokenText: "Flight seven four nine leaves", displayText: "Flight 749 leaves" });
    expect(landed(a)).toEqual(["Flight", "749", "749", "749", "leaves"]);
    expect(a.mapping.spokenKind[1]).toBe(SPOKEN_EXPANDED);
    expect(a.mapping.displayFirstSpoken[1]).toBe(1);
    expect(a.mapping.displayLastSpoken[1]).toBe(3);
  });

  it("lands cardinals, hyphenated numbers and years on their digits", () => {
    expect(landed(alignSpokenToDisplay({ spokenText: "about twenty-three items", displayText: "about 23 items" })))
      .toEqual(["about", "23", "23", "items"]);
    expect(landed(alignSpokenToDisplay({
      spokenText: "version seven hundred and forty nine ships",
      displayText: "version 749 ships",
    }))).toEqual(["version", "749", "749", "749", "749", "749", "ships"]);
    expect(landed(alignSpokenToDisplay({ spokenText: "in twenty twenty six", displayText: "in 2026" })))
      .toEqual(["in", "2026", "2026", "2026"]);
    expect(landed(alignSpokenToDisplay({ spokenText: "since nineteen eighty four", displayText: "since 1984" })))
      .toEqual(["since", "1984", "1984", "1984"]);
    const single = alignSpokenToDisplay({ spokenText: "seven days", displayText: "7 days" });
    expect(single.mapping.spokenKind[0]).toBe(SPOKEN_EQUIVALENT);
  });

  it("lands a spelled-out acronym on the acronym", () => {
    expect(landed(alignSpokenToDisplay({ spokenText: "the A P I works", displayText: "the API works" })))
      .toEqual(["the", "API", "API", "API", "works"]);
  });

  it("ignores punctuation and curly quotes", () => {
    const a = alignSpokenToDisplay({
      spokenText: "He said “hello,” and don’t worry.",
      displayText: "He said \"hello\" and don't worry",
    });
    expect(Array.from(a.mapping.spokenKind).every((k) => k === SPOKEN_EXACT)).toBe(true);
  });

  it("uses the script's spans to pair repeated words with the right copy", () => {
    const source = "## Plan\n\nRead [the docs](https://x.test/d) then run `pnpm test`.\n\n```ts\nconst docs = 1;\n```\n\nThe docs are the docs.";
    const script = speakableWithSpans(source);
    // what ChatMarkdown renders (the fence's text is excluded by the highlighter)
    const display = "Plan\nRead the docs then run pnpm test.\nThe docs are the docs.";
    const a = alignSpokenToDisplay({ spokenText: script.text, displayText: display, segments: script.segments, sourceText: source });
    expect(a.guided).toBe(true);
    const docs = a.spokenWords.map((w, i) => (w.key === "docs" ? a.mapping.spokenToDisplay[i] : -1)).filter((j) => j >= 0);
    const displayDocs = a.displayWords.map((w, j) => (w.key === "docs" ? j : -1)).filter((j) => j >= 0);
    expect(docs).toEqual(displayDocs);
  });

  it("follows the spans past a long code block in text with no word used once", () => {
    // Nothing anchors the projection, and the fence's words are on the
    // source side only.  A fixed band around a straight line followed the
    // wrong copy of the sentence and misplaced nearly every word.
    const sentence = "Then run the build again and check the log for the same error.";
    const para = [sentence, sentence, sentence, sentence, sentence].join(" ");
    const shell = Array.from({ length: 60 }, (_, i) => `echo step ${i} && make target${i % 3} --flag value`).join("\n");
    const source = [para, `\`\`\`sh\n${shell}\n\`\`\``, para, para, para, para, para].join("\n\n");
    const display = [para, para, para, para, para, para].join("\n");
    const script = speakableWithSpans(source);
    const a = alignSpokenToDisplay({ spokenText: script.text, displayText: display, segments: script.segments, sourceText: source });
    expect(a.guided).toBe(true);
    // Every word the voice reads from the reply lands on its own copy on
    // screen, in order; only "a shell code block" has none.
    const spokenFromReply = a.spokenWords
      .map((w, i) => ({ i, insert: script.segments.find((g) => g.spokenStart <= w.start && w.start < g.spokenEnd)?.kind === "insert" }))
      .filter((w) => !w.insert)
      .map((w) => a.mapping.spokenToDisplay[w.i]);
    expect(spokenFromReply).toEqual(a.displayWords.map((_, j) => j));
  });

  it("is monotonic: display indices never go backwards", () => {
    const script = speakableWithSpans("One two three. Three two one. One one one two.");
    const a = alignSpokenToDisplay({ spokenText: script.text, displayText: "One two three. Three two one. One one one two." });
    let last = -1;
    for (const j of a.mapping.spokenToDisplay) {
      expect(j).toBeGreaterThanOrEqual(last);
      last = j;
    }
  });

  it("handles empty sides", () => {
    expect(alignSpokenToDisplay({ spokenText: "", displayText: "words here" }).mapping.displayFirstSpoken[0]).toBe(-1);
    expect(Array.from(alignSpokenToDisplay({ spokenText: "words here", displayText: "" }).mapping.spokenToDisplay)).toEqual([-1, -1]);
  });

  it("aligns a 3000-word message within the frame budget", () => {
    const vocabulary = ["the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog", "and", "runs", "far", "away"];
    const words = Array.from({ length: 3000 }, (_, i) => (i % 13 === 12 ? String(i) : vocabulary[i % 13]));
    const source = words
      .map((w, i) => (i % 40 === 0 ? `\n\n**${w}**` : i % 97 === 0 ? `[${w}](https://x.test/${i})` : w))
      .join(" ");
    const display = source.replace(/\*\*/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
    const script = speakableWithSpans(source);
    const unguidedSpoken = words.filter((_, i) => i % 50 !== 7).join(" ");

    // This Mac is often under very heavy load, so the budget is scaled by a
    // calibration loop that takes about 20 ms on an idle machine, and each
    // measurement is the best of several runs.
    const best = (fn: () => void): number => {
      let min = Number.POSITIVE_INFINITY;
      for (let r = 0; r < 7; r += 1) {
        const t0 = performance.now();
        fn();
        min = Math.min(min, performance.now() - t0);
      }
      return min;
    };
    let sink = 0;
    const calibration = best(() => {
      for (let i = 0; i < 20_000_000; i += 1) sink += i & 7;
    });
    const scale = Math.max(1, calibration / 20);
    const guided = best(() => {
      alignSpokenToDisplay({ spokenText: script.text, displayText: display, segments: script.segments, sourceText: source });
    });
    const unguided = best(() => {
      alignSpokenToDisplay({ spokenText: unguidedSpoken, displayText: words.join(" ") });
    });
    console.info(
      `karaoke-align 3000 words: guided ${guided.toFixed(1)} ms, unguided ${unguided.toFixed(1)} ms, `
        + `calibration ${calibration.toFixed(1)} ms (scale ${scale.toFixed(2)}), sink ${sink & 1}`,
    );
    expect(guided).toBeLessThan(20 * scale * 1.5);
    expect(unguided).toBeLessThan(20 * scale * 1.5);
  });
});

describe("buildKaraokeTimeline", () => {
  it("gives paired words their spoken time", () => {
    const a = alignSpokenToDisplay({ spokenText: "one two three", displayText: "one two three" });
    expect(Array.from(buildKaraokeTimeline(evenTimes(3), a.mapping))).toEqual([0, 250, 300, 550, 600, 850]);
  });

  it("sweeps skipped words quickly just before the next spoken word", () => {
    const a = alignSpokenToDisplay({ spokenText: "See now", displayText: "See https example com now" });
    const t = buildKaraokeTimeline(evenTimes(2), a.mapping, { skipStepMs: 40, skipMaxMs: 320 });
    // "See" 0-250, then the three skipped words share 180-300 (borrowing from
    // the pause and half of "See"), then "now" at 300.
    expect(t[0]).toBe(0);
    expect(t[1]).toBeLessThanOrEqual(250);
    expect(t[2]).toBeGreaterThanOrEqual(125);
    expect(t[7]).toBe(300);
    expect(t[8]).toBe(300);
    for (let j = 1; j < 5; j += 1) expect(t[2 * j]).toBeGreaterThanOrEqual(t[2 * (j - 1)]);
    expect(t[7] - t[2]).toBeLessThanOrEqual(320);
  });

  it("caps a long skipped run", () => {
    const display = `start ${Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ")} end`;
    const a = alignSpokenToDisplay({ spokenText: "start end", displayText: display });
    const times = new Float64Array([0, 200, 5000, 5200]);
    const t = buildKaraokeTimeline(times, a.mapping, { skipStepMs: 40, skipMaxMs: 320 });
    expect(t[2]).toBe(5000 - 320);
    expect(t[2 * 41]).toBe(5000);
  });

  it("lets added words extend the word before them", () => {
    const a = alignSpokenToDisplay({ spokenText: "Fixed it a code block then", displayText: "Fixed it then" });
    const t = buildKaraokeTimeline(evenTimes(6), a.mapping);
    expect(t[2]).toBe(300); // "it" starts when spoken
    expect(t[3]).toBe(1450); // ... and lasts through "a code block"
    expect(t[4]).toBe(1500);
  });

  it("spreads display words evenly when nothing pairs", () => {
    const a = alignSpokenToDisplay({ spokenText: "", displayText: "a b c d" });
    expect(Array.from(buildKaraokeTimeline(new Float64Array(0), a.mapping))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("timing helpers", () => {
  it("spreads clip time over words by character offset", () => {
    const utterances = utterancesWithSpans("The tests pass now. I changed two files.");
    const script = speakableWithSpans("The tests pass now. I changed two files.");
    const words = tokenizeWords(script.text);
    const clips = [
      { spokenStart: utterances[0].spokenStart, spokenEnd: utterances[0].spokenEnd, startMs: 0, durationMs: 1900 },
      { spokenStart: utterances[1].spokenStart, spokenEnd: utterances[1].spokenEnd, startMs: 2000, durationMs: 2000 },
    ];
    const t = proportionalWordTimes(words, clips);
    expect(t[0]).toBe(0);
    expect(t[1]).toBe(300); // "The" is 3 of 19 characters
    expect(t[8]).toBe(2000); // "I" starts the second clip
    expect(t[2 * words.length - 1]).toBe(2000 + (2000 * 19) / 20);
  });

  it("estimates back-to-back clips at a steady pace", () => {
    expect(estimatedClips([{ spokenStart: 0, spokenEnd: 10 }, { spokenStart: 11, spokenEnd: 15 }], 50)).toEqual([
      { spokenStart: 0, spokenEnd: 10, startMs: 0, durationMs: 500 },
      { spokenStart: 11, spokenEnd: 15, startMs: 500, durationMs: 200 },
    ]);
  });

  it("finds the spoken word at a Personal Voice range location", () => {
    const words = tokenizeWords("Hello there, friend.");
    expect(wordIndexAtOffset(words, 0)).toBe(0);
    expect(wordIndexAtOffset(words, 6)).toBe(1);
    expect(wordIndexAtOffset(words, 11)).toBe(2);
    expect(wordIndexAtOffset(words, 19)).toBe(-1);
  });
});

// ── shared fixture for the Swift mirror ───────────────────────────────────

const ALIGN_CASES: Array<{ name: string; spoken?: string; display: string; source?: string }> = [
  { name: "identical", spoken: "The tests pass now.", display: "The tests pass now." },
  { name: "skipped path", spoken: "I changed core.ts today", display: "I changed server/drivers/acp/core.ts today" },
  { name: "inserted code block", spoken: "Fixed it. (a TypeScript code block) That's it.", display: "Fixed it:\nThat's it." },
  { name: "digits", spoken: "Flight seven four nine leaves at twenty-three hundred", display: "Flight 749 leaves at 2300" },
  { name: "cardinal", spoken: "version seven hundred and forty nine ships", display: "version 749 ships" },
  { name: "years", spoken: "in twenty twenty six and nineteen eighty four or twenty oh five", display: "in 2026 and 1984 or 2005" },
  { name: "acronym", spoken: "The A P I is version two", display: "The API is version 2" },
  { name: "quotes", spoken: "He said “hello,” and don’t worry.", display: "He said \"hello\" and don't worry" },
  { name: "fuzzy", spoken: "the colour of the analyse step", display: "the color of the analyze step" },
  { name: "substitution", spoken: "See a link now", display: "See https://example.com/x now" },
  { name: "repeats unguided", spoken: "One two three. Three two one. One one one two.", display: "One two three. Three two one. One one one two." },
  { name: "empty spoken", spoken: "", display: "words here" },
  { name: "empty display", spoken: "words here", display: "" },
  { name: "unicode", spoken: "Ünïcödé façade naïve résumé 日本語", display: "Unicode facade — naive resume, 日本語!" },
  {
    name: "guided markdown",
    source: "## Plan\n\nRead [the docs](https://x.test/d) then run `pnpm test`.\n\n```ts\nconst docs = 1;\n```\n\nThe docs are the docs.",
    display: "Plan\nRead the docs then run pnpm test.\nThe docs are the docs.",
  },
  {
    name: "guided table and list",
    source: "| Name | State |\n| --- | --- |\n| Scout | idle |\n\n1. First item\n2. Second item with **bold** text\n\nSee https://example.com/status now.",
    display: "Name\nState\nScout\nidle\nFirst item\nSecond item with bold text\nSee https://example.com/status now.",
  },
  {
    name: "guided long code block",
    // 30 fence lines and four copies of one paragraph: 20 of the 56 words
    // landed on the wrong copy before the fence was taken out.
    source: [
      "Run the build and check the log. Run the build and check the log.",
      `\`\`\`sh\n${Array.from({ length: 30 }, (_, i) => `make target${i} --flag value`).join("\n")}\n\`\`\``,
      ...Array.from({ length: 3 }, () => "Run the build and check the log. Run the build and check the log."),
    ].join("\n\n"),
    display: Array.from({ length: 4 }, () => "Run the build and check the log. Run the build and check the log.").join("\n"),
  },
  {
    name: "guided emoji and paths",
    source: "Shipped 🚀 the fix in server/tts/minimax.ts — 3 files, 749 lines.",
    display: "Shipped 🚀 the fix in server/tts/minimax.ts — 3 files, 749 lines.",
  },
];

function fixtureCases() {
  return ALIGN_CASES.map((c) => {
    const script = c.source !== undefined ? speakableWithSpans(c.source) : null;
    const spokenText = script ? script.text : c.spoken ?? "";
    const a = alignSpokenToDisplay({
      spokenText,
      displayText: c.display,
      segments: script?.segments,
      sourceText: c.source,
    });
    const times = evenTimes(a.spokenWords.length);
    return {
      name: c.name,
      source: c.source ?? null,
      spokenText,
      displayText: c.display,
      spokenWords: a.spokenWords.map((w) => [w.start, w.end, w.key]),
      displayWords: a.displayWords.map((w) => [w.start, w.end, w.key]),
      guided: a.guided,
      spokenToDisplay: Array.from(a.mapping.spokenToDisplay),
      spokenKind: Array.from(a.mapping.spokenKind),
      displayFirstSpoken: Array.from(a.mapping.displayFirstSpoken),
      displayLastSpoken: Array.from(a.mapping.displayLastSpoken),
      timeline: Array.from(buildKaraokeTimeline(times, a.mapping)),
    };
  });
}

describe("karaoke-align fixture", () => {
  it("is current with the TypeScript implementation", () => {
    const expected = {
      note: "Generated by shared/karaoke-align.test.ts (UPDATE_SPEECH_FIXTURES=1).  Do not hand-edit.  Word offsets are UTF-16; spoken word i is timed [i*300, i*300+250) for the timeline; spokenKind 0 inserted, 1 exact, 2 equivalent, 3 fuzzy, 4 substituted, 5 expanded.",
      cases: fixtureCases(),
    };
    const serialized = `{"note":${JSON.stringify(expected.note)},"cases":[\n${expected.cases
      .map((c) => JSON.stringify(c))
      .join(",\n")}\n]}\n`;
    if (process.env.UPDATE_SPEECH_FIXTURES === "1" || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, serialized);
    }
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(expected);
  });

  it("covers every pairing kind", () => {
    const kinds = new Set(fixtureCases().flatMap((c) => c.spokenKind));
    for (const kind of [SPOKEN_INSERTED, 1, 2, 3, 4, 5]) expect(kinds.has(kind)).toBe(true);
  });
});
