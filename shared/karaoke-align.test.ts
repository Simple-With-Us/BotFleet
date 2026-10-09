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
  alignmentQuality,
  buildKaraokeTimeline,
  FOLLOW_SPOKEN_MIN,
  karaokeFollowable,
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

// ── distilled scripts ─────────────────────────────────────────────────────
//
// What the default voice reads: the DeepSeek rewrite (server/tts/
// speech-summary.ts DEEPSEEK_FLASH_TTS_PROMPT), against what the Mac renders
// for the reply (block text joined with "\n", fenced code and its header left
// out, link labels shown, inline code as text).  Written the way the prompt
// makes the model write: numbers and codes spelled out, acronyms letter by
// letter, "dot com", lists retold with "First" and "Next", pause tags, light
// rewording, code skipped.

/** The display word the `nth` spoken word reading `text` landed on. */
function landedOn(a: KaraokeAlignment, text: string, nth = 0): string {
  let seen = 0;
  for (let i = 0; i < a.spokenWords.length; i += 1) {
    if (a.spokenWords[i].text !== text) continue;
    if (seen === nth) {
      const j = a.mapping.spokenToDisplay[i];
      return j >= 0 ? a.displayWords[j].text : "-";
    }
    seen += 1;
  }
  throw new Error(`no spoken word ${text} #${nth}`);
}

/** Real paths from this change, for the list-retold cases. */
const PATHS = [
  "server/tts/message-audio.ts", "server/tts/speech-summary.ts", "shared/karaoke-align.ts", "shared/spoken-script.ts",
  "src/lib/tts/index.ts", "src/lib/karaoke-session.ts", "ios/Sources/CompanionCore/KaraokeAlign.swift",
  "server/tts/speech-text.ts", "shared/speech-spans.ts", "shared/voice-summary.ts", "src/lib/tts/karaoke-feed.ts",
  "ios/App/Karaoke.swift", "ios/App/Session.swift", "ios/Sources/CompanionCore/KaraokeScript.swift",
  "ios/Sources/CompanionCore/MessageVoice.swift", "src/components/VoiceSettings.tsx", "src/lib/tts/schema.ts",
  "server/store.ts", "server/index.ts", "src/lib/karaoke-highlight.ts", "shared/bot-voice.ts",
  "server/tts/minimax.ts", "src/components/ChatMarkdown.tsx", "ios/App/ChatView.swift", "docs/tts-karaoke.md",
];

/** A status table as the Mac renders it: one cell per line. */
const STATUS_TABLE = [
  "Here is where every bot stands:",
  "Bot", "State", "Last run", "Branch",
  "Scout", "idle", "3:15 PM", "main",
  "Builder", "running", "3:40 PM", "claude/voice-distill-karaoke",
  "Archivist", "idle", "2:05 PM", "main",
  "Reviewer", "failed", "3:42 PM", "codex/review-sweep",
  "Courier", "idle", "1:10 PM", "main",
  "Janitor", "idle", "12:30 PM", "main",
  "Scribe", "idle", "11:55 AM", "docs/tts-notes",
  "Watcher", "idle", "3:00 PM", "main",
].join("\n");

const BRIEF_REPLY = [
  "I tracked down the flaky test in the cache suite.",
  "The failure only showed up when two workers warmed the cache at the same time.  The second worker read a half-written entry and the assertion on the entry size failed.",
  "I added a lock around the warm-up and a retry on a short read.  I also wrote a regression test that starts eight workers at once; it failed 9 times out of 10 before the fix and passes 50 out of 50 now.",
  "The other two failures in that run were the known network timeout, which is unrelated.",
].join("\n");

export const DISTILLED_CASES: Array<{
  name: string;
  spoken: string;
  display: string;
  followable: boolean;
  /** [spoken word, occurrence, display word it must land on] */
  lands: Array<[string, number, string]>;
}> = [
  {
    name: "distilled: list, decimal, issue number, percent, code skipped, link",
    // - Bumped the API timeout to 3.5 seconds / - Fixed issue #749 ... / a
    // ```sh block / Details are in [the rollout doc](https://...).
    display: "The deploy finished.  Here is what changed:\nBumped the API timeout to 3.5 seconds\nFixed issue #749 in the webhook retry loop\nCut memory use by 40%\nRun this to verify:\nDetails are in the rollout doc.",
    spoken: "The deploy finished. Here is what changed. <#0.3#> First, the A P I timeout was bumped to three point five seconds. <#0.3#> Next, issue seven four nine in the webhook retry loop was fixed. <#0.3#> Finally, memory use was cut by forty percent. You can run a short test command to verify it. <#0.5#> The details are in the rollout doc.",
    followable: true,
    lands: [
      ["A", 0, "API"], ["P", 0, "API"], ["I", 0, "API"], ["three", 0, "3"], ["point", 0, "3"], ["five", 0, "5"],
      ["seven", 0, "749"], ["four", 0, "749"], ["nine", 0, "749"], ["forty", 0, "40"], ["percent", 0, "40"],
      ["webhook", 0, "webhook"], ["rollout", 0, "rollout"], ["doc", 0, "doc"],
    ],
  },
  {
    name: "distilled: flight codes, times, dates, money",
    display: "Two flights fit your dates:\nAA2314 leaves at 3:15 PM on 10/24 for $250\nDL982 leaves at 6:00 PM for $310\nBook soon, since fares rose 12% this week.",
    spoken: "Two flights fit your dates. <#0.3#> First, A A two three one four leaves at three fifteen p m on October twenty-fourth for two hundred and fifty dollars. <#0.3#> Next, D L nine eight two leaves at six p m for three hundred and ten dollars. Book soon, since fares rose twelve percent this week.",
    followable: true,
    lands: [
      ["A", 0, "AA2314"], ["four", 0, "AA2314"], ["fifteen", 0, "15"], ["p", 0, "PM"], ["m", 0, "PM"],
      ["twenty", 0, "24"], ["fourth", 0, "24"], ["fifty", 0, "250"], ["dollars", 0, "250"], ["D", 0, "DL982"],
      ["two", 2, "DL982"], ["six", 0, "6"], ["ten", 0, "310"], ["twelve", 0, "12"],
    ],
  },
  {
    name: "distilled: acronyms and spoken URLs",
    display: "I checked CPU and GPU load on the VM.  Both are under 30%.  The dashboard is at grafana.example.com/d/abc123 and the API docs are at docs.example.com.",
    spoken: "I checked C P U and G P U load on the V M. Both are under thirty percent. The dashboard is at grafana dot example dot com, and the A P I docs are at docs dot example dot com.",
    followable: true,
    lands: [
      ["C", 0, "CPU"], ["U", 1, "GPU"], ["V", 0, "VM"], ["M", 0, "VM"], ["thirty", 0, "30"], ["grafana", 0, "grafana"],
      ["dot", 0, "grafana"], ["example", 0, "example"], ["com", 0, "com"], ["docs", 1, "docs"], ["com", 1, "com"],
    ],
  },
  {
    name: "distilled: inline code spelled, code block skipped",
    // Add a lint script to `package.json`: / ```json ... ``` / Then run
    // `pnpm lint` and commit the change.
    display: "Add a lint script to package.json:\nThen run pnpm lint and commit the change.",
    spoken: "Add a lint script to the package dot json file. Then run p n p m lint, and commit the change.",
    followable: true,
    lands: [["package", 0, "package"], ["json", 0, "json"], ["p", 0, "pnpm"], ["m", 0, "pnpm"], ["lint", 1, "lint"], ["commit", 0, "commit"]],
  },
  {
    name: "distilled: plural acronyms, ampersand, Q3, hyphens, thousands",
    display: "R&D signed off on the three new APIs.  Q3 revenue was up 12%, and the sign-up flow now handles 1,200 users per minute.",
    spoken: "R and D signed off on the three new A P Is. Q three revenue was up twelve percent, and the sign up flow now handles one thousand two hundred users per minute.",
    followable: true,
    lands: [
      ["R", 0, "R"], ["and", 0, "R"], ["D", 0, "D"], ["Is", 0, "APIs"], ["Q", 0, "Q3"], ["three", 1, "Q3"],
      ["twelve", 0, "12"], ["sign", 0, "sign"], ["one", 0, "1"], ["hundred", 0, "200"], ["users", 0, "users"],
    ],
  },
  {
    name: "distilled: commit hash dropped, path renamed",
    display: "Merged in a1b2c3d.  The fix is in server/tts/message-audio.ts, and CI is green on all 4 jobs.",
    spoken: "Merged. The fix is in the message audio file, and C I is green on all four jobs.",
    followable: true,
    lands: [["Merged", 0, "Merged"], ["message", 0, "message"], ["audio", 0, "audio"], ["C", 0, "CI"], ["four", 0, "4"], ["jobs", 0, "jobs"]],
  },
  {
    name: "distilled: a list of paths retold in one line",
    display: "I changed these files:\nserver/tts/message-audio.ts\nserver/tts/speech-summary.ts\nshared/karaoke-align.ts\nshared/spoken-script.ts\nsrc/lib/tts/index.ts\nsrc/lib/karaoke-session.ts\nios/Sources/CompanionCore/KaraokeAlign.swift\nAll the tests pass.",
    spoken: "I changed seven files, mostly in the speech and karaoke code. All the tests pass.",
    followable: true,
    lands: [["changed", 0, "changed"], ["files", 0, "files"], ["tests", 0, "tests"], ["pass", 0, "pass"]],
  },
  {
    // Under a tenth of the words on screen pair; the rest are swept.
    name: "distilled: a list of twelve paths retold in one line",
    display: `I changed these files:\n${PATHS.slice(0, 12).join("\n")}\nAll the tests pass.`,
    spoken: "I changed twelve files, mostly in the speech and karaoke code. All the tests pass.",
    followable: true,
    lands: [["changed", 0, "changed"], ["files", 0, "files"], ["tests", 0, "tests"], ["pass", 0, "pass"]],
  },
  {
    name: "distilled: a list of twenty-five paths retold in one line",
    display: `I changed these files:\n${PATHS.join("\n")}\nAll the tests pass.`,
    spoken: "I changed twenty five files, mostly in the speech and karaoke code. All the tests pass.",
    followable: true,
    lands: [["changed", 0, "changed"], ["files", 0, "files"], ["tests", 0, "tests"], ["pass", 0, "pass"]],
  },
  {
    name: "distilled: a status table retold in one sentence",
    display: STATUS_TABLE,
    spoken: "Every bot is idle except Builder, which is running, and Reviewer, which failed.",
    followable: true,
    lands: [["Builder", 0, "Builder"], ["running", 0, "running"], ["Reviewer", 0, "Reviewer"], ["failed", 0, "failed"]],
  },
  {
    // This repo's own yyyymmddHHMM build numbers: twelve words, one code.
    name: "distilled: a twelve-digit build number read digit by digit",
    display: "The build number is 202610081532.",
    spoken: "The build number is two zero two six one zero zero eight one five three two.",
    followable: true,
    lands: [["number", 0, "number"], ["two", 0, "202610081532"], ["eight", 0, "202610081532"], ["two", 2, "202610081532"]],
  },
  {
    name: "distilled: a ten-digit order number read digit by digit",
    display: "Your order number is 4711923856.",
    spoken: "Your order number is four seven one one nine two three eight five six.",
    followable: true,
    lands: [["order", 0, "order"], ["four", 0, "4711923856"], ["six", 0, "4711923856"]],
  },
  {
    name: "distilled: a nine-character id read character by character",
    display: "The run id is abcdef123.",
    spoken: "The run id is a b c d e f one two three.",
    followable: true,
    lands: [["id", 0, "id"], ["b", 0, "abcdef123"], ["three", 0, "abcdef123"]],
  },
  {
    name: "condensed, in order",
    display: BRIEF_REPLY,
    spoken: "I tracked down the flaky cache test. Two workers warmed the cache at once. I added a lock and a regression test, and it passes now.",
    followable: true,
    lands: [["tracked", 0, "tracked"], ["warmed", 0, "warmed"], ["lock", 0, "lock"], ["regression", 0, "regression"], ["passes", 0, "passes"]],
  },
  {
    name: "brief summary reusing the reply's words",
    display: BRIEF_REPLY,
    spoken: "In short, the flaky cache test was a race between workers, and it is fixed now.",
    followable: false,
    lands: [],
  },
  {
    name: "brief summary in new words",
    display: BRIEF_REPLY,
    spoken: "Good news: that intermittent problem is solved, and nothing else needs your attention today.",
    followable: false,
    lands: [],
  },
];

describe("distilled scripts", () => {
  for (const c of DISTILLED_CASES) {
    it(`${c.name}: ${c.followable ? "follows the main text" : "is not followed"}`, () => {
      const a = alignSpokenToDisplay({ spokenText: c.spoken, displayText: c.display });
      expect(a.guided).toBe(false);
      expect(a.followable).toBe(c.followable);
      for (const [spoken, nth, display] of c.lands) expect(`${spoken}#${nth} -> ${landedOn(a, spoken, nth)}`).toBe(`${spoken}#${nth} -> ${display}`);
      // Pause tags are not words.
      expect(a.spokenWords.some((w) => w.text === "0")).toBe(false);
      if (!c.followable) return;
      // Every display word gets a time, starts never go backwards, and a
      // skipped run is swept in at most 320 ms.
      const timeline = buildKaraokeTimeline(evenTimes(a.spokenWords.length), a.mapping);
      for (let j = 0; j < a.displayWords.length; j += 1) {
        expect(timeline[2 * j + 1]).toBeGreaterThanOrEqual(timeline[2 * j]);
        if (j > 0) expect(timeline[2 * j]).toBeGreaterThanOrEqual(timeline[2 * (j - 1)]);
      }
      let run = 0;
      let runStart = 0;
      for (let j = 0; j <= a.displayWords.length; j += 1) {
        const skipped = j < a.displayWords.length && a.mapping.displayFirstSpoken[j] < 0;
        if (skipped) {
          if (run === 0) runStart = timeline[2 * j];
          run += 1;
        } else if (run > 0) {
          expect(timeline[2 * (j - 1) + 1] - runStart).toBeLessThanOrEqual(320 + 1e-9);
          run = 0;
        }
      }
    });
  }

  it("keeps faithful rewrites well clear of the follow threshold, and summaries under it", () => {
    const ratio = (n: number, d: number) => (d === 0 ? 1 : n / d);
    for (const c of DISTILLED_CASES) {
      const a = alignSpokenToDisplay({ spokenText: c.spoken, displayText: c.display });
      const q = a.quality;
      const spoken = ratio(q.spokenMatched, q.spokenContent);
      const display = ratio(q.displayMatched, q.displayContent);
      if (c.name.startsWith("distilled:")) {
        // A real rewrite pairs most of what it says, well over the bar.
        expect(spoken, c.name).toBeGreaterThan(1.5 * (FOLLOW_SPOKEN_MIN.num / FOLLOW_SPOKEN_MIN.den));
      }
      if (!c.followable) {
        // A summary misses on what it says, not on how much of the screen
        // it covers.
        expect(spoken, c.name).toBeLessThan(FOLLOW_SPOKEN_MIN.num / FOLLOW_SPOKEN_MIN.den);
        expect(display, c.name).toBeLessThan(1 / 16);
      }
    }
  });

  it("does not follow a script with nothing paired, and counts only content words", () => {
    const a = alignSpokenToDisplay({ spokenText: "the and of a", displayText: "the and of a" });
    expect(a.quality).toEqual({ spokenContent: 0, spokenMatched: 0, displayContent: 0, displayMatched: 0 });
    expect(a.followable).toBe(false);
    expect(karaokeFollowable({ spokenContent: 3, spokenMatched: 1, displayContent: 8, displayMatched: 1 })).toBe(true);
    expect(karaokeFollowable({ spokenContent: 4, spokenMatched: 1, displayContent: 8, displayMatched: 1 })).toBe(false);
    // How much of the screen is covered is not a bar: a long list retold in
    // a sentence covers almost none of it and is still followed.
    expect(karaokeFollowable({ spokenContent: 3, spokenMatched: 1, displayContent: 9, displayMatched: 1 })).toBe(true);
    expect(karaokeFollowable({ spokenContent: 9, spokenMatched: 6, displayContent: 129, displayMatched: 6 })).toBe(true);
    const b = alignSpokenToDisplay({ spokenText: "The deploy finished.", displayText: "The deploy finished." });
    expect(alignmentQuality(b.spokenWords, b.displayWords, b.mapping)).toEqual(b.quality);
    expect(b.quality).toEqual({ spokenContent: 2, spokenMatched: 2, displayContent: 2, displayMatched: 2 });
  });

  it("always follows a script with spans, even one that reads a list of links as \"a link\"", () => {
    const source = ["Sources:", "", ...Array.from({ length: 8 }, (_, i) => `- https://example.com/docs/page-${i}/section`), "", "Done."].join("\n");
    const display = ["Sources:", ...Array.from({ length: 8 }, (_, i) => `https://example.com/docs/page-${i}/section`), "Done."].join("\n");
    const script = speakableWithSpans(source);
    const a = alignSpokenToDisplay({ spokenText: script.text, displayText: display, segments: script.segments, sourceText: source });
    expect(a.guided).toBe(true);
    // Unguided, this little pairs would not be followed.
    expect(karaokeFollowable(a.quality)).toBe(false);
    expect(a.followable).toBe(true);
    expect(landedOn(a, "Done")).toBe("Done");
  });

  it("joins a code read out one character at a time up to forty characters", () => {
    const spell = (code: string) => code.split("").map((c) => (/[0-9]/.test(c) ? ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][Number(c)] : c)).join(" ");
    const hash40 = "ef9876543210abcdef1234567890abcdef123456";
    const at = alignSpokenToDisplay({ spokenText: `Merged as ${spell(hash40)}.`, displayText: `Merged as ${hash40}.` });
    expect(at.followable).toBe(true);
    expect(at.mapping.spokenKind.filter((k) => k === SPOKEN_EXPANDED)).toHaveLength(40);
    // One more character is past the cap: nothing joins, and nothing breaks.
    const past = alignSpokenToDisplay({ spokenText: `Merged as ${spell(`${hash40}7`)}.`, displayText: `Merged as ${hash40}7.` });
    expect(past.mapping.spokenKind.filter((k) => k === SPOKEN_EXPANDED)).toHaveLength(0);
  });

  it("blanks pause tags without moving any spoken word's offsets", () => {
    const spoken = "Done. <#0.3#> Next, the tests. <#1.25#> Done.";
    const a = alignSpokenToDisplay({ spokenText: spoken, displayText: "Done.\nThe tests.\nDone." });
    expect(a.spokenWords.map((w) => spoken.slice(w.start, w.end))).toEqual(["Done", "Next", "the", "tests", "Done"]);
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
  { name: "joined words and codes", spoken: "Fly jet blue on the twenty first, gate B twelve, code zero zero seven", display: "Fly JetBlue on the 21st, gate B12, code 007" },
  {
    name: "joined run at the cap",
    spoken: "Merged as e f nine eight seven six five four three two one zero a b c d e f one two three four five six seven eight nine zero a b c d e f one two three four five six.",
    display: "Merged as ef9876543210abcdef1234567890abcdef123456.",
  },
  {
    name: "joined run past the cap",
    spoken: "Merged as e f nine eight seven six five four three two one zero a b c d e f one two three four five six seven eight nine zero a b c d e f one two three four five six seven.",
    display: "Merged as ef9876543210abcdef1234567890abcdef1234567.",
  },
  {
    name: "guided link list",
    source: ["Sources:", "", ...Array.from({ length: 8 }, (_, i) => `- https://example.com/docs/page-${i}/section`), "", "Done."].join("\n"),
    display: ["Sources:", ...Array.from({ length: 8 }, (_, i) => `https://example.com/docs/page-${i}/section`), "Done."].join("\n"),
  },
  ...DISTILLED_CASES.map((c) => ({ name: c.name, spoken: c.spoken, display: c.display })),
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
      quality: [a.quality.spokenContent, a.quality.spokenMatched, a.quality.displayContent, a.quality.displayMatched],
      followable: a.followable,
    };
  });
}

describe("karaoke-align fixture", () => {
  it("is current with the TypeScript implementation", () => {
    const expected = {
      note: "Generated by shared/karaoke-align.test.ts (UPDATE_SPEECH_FIXTURES=1).  Do not hand-edit.  Word offsets are UTF-16; spoken word i is timed [i*300, i*300+250) for the timeline; spokenKind 0 inserted, 1 exact, 2 equivalent, 3 fuzzy, 4 substituted, 5 expanded; quality is [spokenContent, spokenMatched, displayContent, displayMatched].",
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
