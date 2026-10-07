// speakableWithSpans must say exactly what speakable() says, and every span
// it reports must point at the message text that produced it.  The first half
// is pinned against the real server functions; the second half by checking
// each copy span character for character.
//
// The corpus also feeds the shared fixture the Swift mirror reads.  To
// regenerate it after a deliberate rule change:
//   UPDATE_SPEECH_FIXTURES=1 pnpm exec vitest run shared/speech-spans.test.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { speakable, toUtterances } from "../server/tts/speech-text.ts";
import {
  sourceOffsetAt,
  speakableWithSpans,
  utterancesWithSpans,
  type SpeechSpan,
  type SpokenScript,
  type SpokenUtterance,
} from "./speech-spans";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "ios", "Tests", "CompanionCoreTests", "Fixtures", "speech-spans.json");

/** The parity corpus.  Every case here is checked against the server and
 * written to the Swift fixture. */
const SPEECH_SPAN_CORPUS: Array<{ name: string; input: string }> = [
  { name: "empty", input: "" },
  { name: "whitespace only", input: "   \n\n  " },
  { name: "plain sentences", input: "The tests pass now. I changed two files. Want me to push it?" },
  { name: "heading and paragraph", input: "## Results\nAll green" },
  { name: "heading with punctuation", input: "### Done!\nNext up: the iOS side." },
  { name: "bullets", input: "- first thing\n- second thing\n- third thing" },
  { name: "numbered list", input: "1. Open the app\n2) Tap Settings\n3. Pick a voice" },
  { name: "nested list", input: "- outer\n  - inner one\n  - inner two\n- outer again" },
  { name: "blockquote", input: "> Quoted advice here.\n> Second line.\n\nMy reply." },
  { name: "horizontal rule", input: "Above.\n\n---\n\nBelow." },
  { name: "emphasis", input: "**Done** ✅ — [x] shipped the _thing_ and *one* more ~~bug~~." },
  { name: "underscores in identifiers", input: "Set my_var_name and __init__ before snake_case_thing runs." },
  { name: "link", input: "See [the README](https://example.com/a/b?c=d) for more" },
  { name: "bare url", input: "Deployed to https://botfleet.example.com/status now" },
  { name: "angle url", input: "Docs live at <https://example.com/docs> today." },
  { name: "image", input: "Here: ![a chart of build times](https://x.test/c.png) and ![](y.png)." },
  { name: "paths", input: "I changed server/drivers/acp/core.ts and src/components/ChatView.tsx today." },
  { name: "path with accents", input: "Look at docs/café/naïve.ts and ./a/b/c.md." },
  { name: "inline code", input: "Run `pnpm test` first, then `git push origin claude/karaoke-main-text`." },
  { name: "long inline code", input: `Use \`${"x".repeat(60)}\` here` },
  {
    name: "fenced code",
    input: "Here's the fix:\n\n```ts\nconst x: number = 1;\nif (x) throw new Error('no');\n```\n\nThat's it.",
  },
  { name: "unterminated fence", input: "Working on it:\n\n```sh\nnpm test" },
  { name: "tilde fence", input: "Before.\n~~~python\nprint('hi')\n~~~\nAfter." },
  { name: "fence without language", input: "Code:\n```\nplain\n```\nDone." },
  { name: "table", input: "| Name | State |\n| --- | --- |\n| Scout | idle |\n| Runner |  busy  |" },
  { name: "table with empty cells", input: "| a | | c |\n|:-|-:|:-:|\n|  | b | |" },
  { name: "emoji", input: "Shipped 🚀 and celebrated 🎉🎉 — all green ✅." },
  { name: "emoji with skin tone", input: "Nice work 👍🏽 team." },
  { name: "arrows and symbols", input: "Flow: A → B ⇒ C ⬆ done." },
  { name: "numbers and decimals", input: "It dropped to 11.7 seconds per step, i.e. about half. Version 749 is out." },
  { name: "abbreviations", input: "Dr. Smith vs. Mr. Jones, e.g. the No. 3 case, etc. are fine." },
  { name: "ellipses", input: "Wait... it works. Really… yes." },
  { name: "money and percent", input: "It costs $50 or 3.5% more — about 23 dollars." },
  { name: "checkboxes", input: "- [x] done\n- [ ] todo\n- [X] also done" },
  { name: "crlf", input: "Line one.\r\nLine two.\r\n\r\n- item\r\n- item two" },
  { name: "nbsp and bom", input: "Hello world.﻿ Next line." },
  { name: "voice summary tags", input: "[voice_summary]\nIt is done.\n[/voice_summary]\n[written_answer]\nThe PR is open.\n[/written_answer]" },
  { name: "attachment marker", input: 'Look at this\n\n<attached-image path="/a/b/one.png" />\n\nThoughts?' },
  { name: "html entity text", input: "Tom &amp; Jerry use a &lt;div&gt; here." },
  { name: "quotes", input: "He said “hello” and ‘bye’; it's fine." },
  { name: "punctuation pileup", input: "Done.\n\n\n- one\n\n- two" },
  { name: "comma period", input: "First, , then.\n\nSecond ,." },
  { name: "heading only", input: "# Title" },
  { name: "multiple paragraphs", input: "First paragraph here.\n\nSecond paragraph, with a clause.\n\nThird one!" },
  { name: "question boundary quote", input: "Did it work?\" She asked. (Yes.) Then [more] came." },
  { name: "dash spacing", input: "One - two — three – four. 5 - 3 = 2." },
  { name: "mixed markdown", input: "## Plan\n\n1. Read `speech-text.ts`\n2. Write **tests**\n\n```diff\n- a\n+ b\n```\n\nSee https://x.test/y." },
  {
    name: "long sentence",
    input: `I looked at ${Array.from({ length: 40 }, (_, i) => `item ${i}`).join(", ")} and finished.`,
  },
  {
    name: "long sentence without commas",
    input: `Start ${Array.from({ length: 90 }, (_, i) => `word${i}`).join(" ")} end.`,
  },
  { name: "tiny fragments", input: "Yes. No. Maybe so. The whole suite is green and nothing else changed." },
  { name: "unicode letters", input: "Ünïcödé façade — naïve résumé. 日本語のテキスト。 Done." },
];

function checkSpans(input: string, script: SpokenScript): void {
  let cursor = 0;
  let lastSrc = 0;
  for (const seg of script.segments) {
    expect(seg.spokenStart).toBe(cursor);
    expect(seg.spokenEnd).toBeGreaterThan(seg.spokenStart);
    expect(seg.srcStart).toBeGreaterThanOrEqual(lastSrc);
    expect(seg.srcEnd).toBeGreaterThanOrEqual(seg.srcStart);
    expect(seg.srcEnd).toBeLessThanOrEqual(input.length);
    if (seg.kind === "copy") {
      expect(script.text.slice(seg.spokenStart, seg.spokenEnd)).toBe(input.slice(seg.srcStart, seg.srcEnd));
    }
    cursor = seg.spokenEnd;
    lastSrc = seg.srcStart;
  }
  expect(cursor).toBe(script.text.length);
}

function checkUtterances(input: string, script: SpokenScript, utterances: SpokenUtterance[]): void {
  expect(utterances.map((u) => u.text)).toEqual(toUtterances(input));
  for (const u of utterances) {
    expect(script.text.slice(u.spokenStart, u.spokenEnd)).toBe(u.text);
    checkSpans(input, { text: u.text, segments: u.segments });
  }
}

/** Seeded so a failure is reproducible from its printed case. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let r = Math.imul(a ^ (a >>> 15), 1 | a);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = [
  "Hello there.", "## Heading", "# H1!", "- item", "* star item", "+ plus", "1. one", "2) two", "> quote",
  "```ts\nconst a = 1;\n```", "```\nx\n", "~~~\ny\n~~~", "`code`", `\`${"y".repeat(45)}\``, "**bold**", "__under__",
  "*em*", "_em_", "~~gone~~", "[label](http://a.b/c)", "![alt](i.png)", "https://ex.am/ple?q=1", "<https://x.y>",
  "a/b/c.ts", "./x/y.json", "| a | b |", "|---|---|", "[x] task", "[ ] task", "🚀", "✅", "→", "11.7", "e.g.", "etc.",
  "Dr.", "...", "…", "—", "–", " - ", ",", ".", "!", "?", ";", ":", "\n", "\n\n", "\r\n", "\t", "  ", " ", "﻿",
  "749", "twenty-three", "it's", "don’t", "“quoted”", "naïve", "日本", "word", "another word", "(paren)",
  "[voice_summary]", "[/written_answer]", "&amp;", "<attached-file path=\"/a/b.txt\" />", "***", "---", "___",
];

function fuzzCase(seed: number): string {
  const random = mulberry32(seed);
  const count = 3 + Math.floor(random() * 14);
  let out = "";
  for (let i = 0; i < count; i += 1) {
    out += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)];
    const joiner = random();
    out += joiner < 0.5 ? " " : joiner < 0.7 ? "\n" : joiner < 0.8 ? "\n\n" : "";
  }
  return out;
}

describe("speakableWithSpans", () => {
  it("says exactly what speakable() says, for the whole corpus", () => {
    for (const { name, input } of SPEECH_SPAN_CORPUS) {
      const script = speakableWithSpans(input);
      expect(script.text, name).toBe(speakable(input));
      checkSpans(input, script);
    }
  });

  it("splits exactly like toUtterances(), keeping spans", () => {
    for (const { input } of SPEECH_SPAN_CORPUS) {
      const script = speakableWithSpans(input);
      checkUtterances(input, script, utterancesWithSpans(input));
      // a small cap exercises the clause and word cuts
      expect(utterancesWithSpans(input, { maxChars: 40 }).map((u) => u.text)).toEqual(
        toUtterances(input, { maxChars: 40 }),
      );
    }
  });

  it("matches the server over a seeded fuzz of markdown fragments", () => {
    for (let seed = 1; seed <= 600; seed += 1) {
      const input = fuzzCase(seed);
      const script = speakableWithSpans(input);
      expect(script.text, `seed ${seed}: ${JSON.stringify(input)}`).toBe(speakable(input));
      checkSpans(input, script);
      checkUtterances(input, script, utterancesWithSpans(input));
    }
  });

  it("traces copied words back to their place in the message", () => {
    const input = "## Plan\n\nRead [the docs](https://x.test/d) then run `pnpm test`.";
    const script = speakableWithSpans(input);
    expect(script.text).toBe("Plan. Read the docs then run pnpm test.");
    const at = script.text.indexOf("docs");
    expect(input.slice(sourceOffsetAt(script.segments, at), sourceOffsetAt(script.segments, at) + 4)).toBe("docs");
    const run = script.text.indexOf("pnpm");
    expect(input.slice(sourceOffsetAt(script.segments, run)).startsWith("pnpm test")).toBe(true);
  });

  it("marks words the rules wrote as inserts over what they replaced", () => {
    const input = "Fixed it:\n\n```ts\nconst a = 1;\n```\n\nThen see https://example.com/x now.";
    const script = speakableWithSpans(input);
    const inserts = script.segments.filter((s) => s.kind === "insert");
    const code = inserts.find((s) => script.text.slice(s.spokenStart, s.spokenEnd).includes("TypeScript code block"));
    expect(code).toBeDefined();
    expect(input.slice(code!.srcStart, code!.srcEnd)).toContain("const a = 1;");
    const link = inserts.find((s) => script.text.slice(s.spokenStart, s.spokenEnd).includes("a link"));
    expect(input.slice(link!.srcStart, link!.srcEnd)).toContain("https://example.com/x");
  });

  it("gives every utterance its place in the whole script", () => {
    const input = "The tests pass now. I changed two files. Want me to push it?";
    const utterances = utterancesWithSpans(input);
    expect(utterances.map((u) => [u.spokenStart, u.spokenEnd])).toEqual([
      [0, 19],
      [20, 40],
      [41, 60],
    ]);
    // local spoken offsets, global source offsets
    expect(utterances[1].segments[0]).toMatchObject({ spokenStart: 0, srcStart: 20, kind: "copy" });
  });

  it("joins a merged fragment with an empty insert at the boundary", () => {
    const utterances = utterancesWithSpans("Yes. The whole suite is green and nothing else changed.");
    expect(utterances).toHaveLength(1);
    const joiner = utterances[0].segments.find((s) => s.kind === "insert");
    expect(joiner).toMatchObject({ spokenStart: 4, spokenEnd: 5, srcStart: 4, srcEnd: 5 });
  });
});

// ── shared fixture for the Swift mirror ───────────────────────────────────

type CompactSpan = [number, number, number, number, 0 | 1];
const compact = (segments: SpeechSpan[]): CompactSpan[] =>
  segments.map((s) => [s.spokenStart, s.spokenEnd, s.srcStart, s.srcEnd, s.kind === "copy" ? 0 : 1]);

function fixtureCases() {
  const cases = [
    ...SPEECH_SPAN_CORPUS,
    ...Array.from({ length: 40 }, (_, i) => ({ name: `fuzz ${i + 1}`, input: fuzzCase(1000 + i) })),
  ];
  return cases.map(({ name, input }) => {
    const script = speakableWithSpans(input);
    return {
      name,
      input,
      text: script.text,
      segments: compact(script.segments),
      utterances: utterancesWithSpans(input).map((u) => ({
        text: u.text,
        spokenStart: u.spokenStart,
        spokenEnd: u.spokenEnd,
        segments: compact(u.segments),
      })),
      utterances40: utterancesWithSpans(input, { maxChars: 40 }).map((u) => u.text),
    };
  });
}

describe("speech-spans fixture", () => {
  it("is current with the TypeScript implementation", () => {
    const expected = {
      note: "Generated by shared/speech-spans.test.ts (UPDATE_SPEECH_FIXTURES=1).  Do not hand-edit.  Offsets are UTF-16 code units; segments are [spokenStart, spokenEnd, srcStart, srcEnd, kind] with kind 0 = copy, 1 = insert.",
      cases: fixtureCases(),
    };
    // One case per line: small, and a rule change shows up as a per-case diff.
    const serialized = `{"note":${JSON.stringify(expected.note)},"cases":[\n${expected.cases
      .map((c) => JSON.stringify(c))
      .join(",\n")}\n]}\n`;
    if (process.env.UPDATE_SPEECH_FIXTURES === "1" || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, serialized);
    }
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(expected);
  });
});
