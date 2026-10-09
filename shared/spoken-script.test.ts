import { describe, expect, it } from "vitest";

import { toUtterances } from "../server/tts/speech-text.ts";
import { pronounceUtterance, utterancesWithSpans } from "./speech-spans.ts";
import { encodeSpokenSpans, karaokeScriptFromWire, localKaraokeScript, SPOKEN_SPANS_FORMAT } from "./spoken-script.ts";

const SOURCE = [
  "## Status",
  "",
  "Build **749** passed on `main`.  The fix is in server/tts/message-audio.ts.",
  "",
  "```ts",
  "const x = 1;",
  "```",
  "",
  "- First item here",
  "- Second item, with [a link](https://example.com)",
].join("\n");

describe("spoken spans on the wire", () => {
  it("round-trips: every copied span is the source text, at offsets in the joined utterances", () => {
    const spoken = utterancesWithSpans(SOURCE);
    const utterances = spoken.map((u) => u.text);
    expect(utterances).toEqual(toUtterances(SOURCE));
    const wire = encodeSpokenSpans(SOURCE, spoken);
    expect(wire).toMatchObject({ format: SPOKEN_SPANS_FORMAT, source: "written", sourceLength: SOURCE.length });
    expect(wire.utterances).toHaveLength(utterances.length);
    for (const flat of wire.utterances) expect(flat.length % 5).toBe(0);

    const script = karaokeScriptFromWire(utterances, JSON.parse(JSON.stringify(wire)));
    expect(script.spokenText).toBe(utterances.join(" "));
    expect(script.sourceLength).toBe(SOURCE.length);
    expect(script.utterances.map((u) => script.spokenText.slice(u.spokenStart, u.spokenEnd))).toEqual(utterances);
    let copies = 0;
    for (const seg of script.segments) {
      if (seg.kind !== "copy") continue;
      copies += 1;
      expect(script.spokenText.slice(seg.spokenStart, seg.spokenEnd)).toBe(SOURCE.slice(seg.srcStart, seg.srcEnd));
    }
    expect(copies).toBeGreaterThan(3);
    for (let i = 1; i < script.segments.length; i += 1) {
      expect(script.segments[i].srcStart).toBeGreaterThanOrEqual(script.segments[i - 1].srcStart);
      expect(script.segments[i].spokenStart).toBeGreaterThanOrEqual(script.segments[i - 1].spokenEnd);
    }
  });

  it("keeps the utterances but drops spans that do not check out", () => {
    const spoken = utterancesWithSpans(SOURCE);
    const utterances = spoken.map((u) => u.text);
    const good = encodeSpokenSpans(SOURCE, spoken);
    const broken = [
      { ...good, format: 2 },
      { ...good, utterances: good.utterances.slice(1) },
      { ...good, sourceLength: 3 },
      { ...good, utterances: good.utterances.map((flat, i) => (i === 0 ? [...flat, 1] : flat)) },
      { ...good, utterances: good.utterances.map((flat, i) => (i === 0 ? [0, 9_999, 0, 1, 0] : flat)) },
      { ...good, utterances: good.utterances.map((flat, i) => (i === 0 ? [0, 1, 0, 1, 7] : flat)) },
      { ...good, utterances: good.utterances.map((flat, i) => (i === 0 ? [0, 1, -1, 1, 0] : flat)) },
    ];
    for (const wire of broken) {
      const script = karaokeScriptFromWire(utterances, JSON.parse(JSON.stringify(wire)));
      expect(script.spokenText).toBe(utterances.join(" "));
      expect(script.segments).toEqual([]);
      expect(script.sourceLength).toBeNull();
    }
    expect(karaokeScriptFromWire(utterances, null).segments).toEqual([]);
  });

  it("builds the same script locally as the harness sends", () => {
    const spoken = utterancesWithSpans(SOURCE);
    const fromWire = karaokeScriptFromWire(spoken.map((u) => u.text), encodeSpokenSpans(SOURCE, spoken));
    const local = localKaraokeScript(SOURCE);
    expect(local.utterances).toEqual(spoken.map((u) => u.text));
    expect(local.script).toEqual(fromWire);
    expect(local.captions).toEqual(local.utterances);
  });

  it("applies the pronunciation list locally as the harness does for an on-device voice", () => {
    const list = [{ term: "SQL", say: "sequel" }, { term: "cron", say: "kron" }];
    const source = "Run the **SQL** migration, then check `cron`.";
    const spoken = utterancesWithSpans(source).map((u) => pronounceUtterance(u, list));
    const fromWire = karaokeScriptFromWire(spoken.map((u) => u.text), encodeSpokenSpans(source, spoken));
    const local = localKaraokeScript(source, list);
    expect(local.utterances).toEqual(["Run the sequel migration, then check kron."]);
    expect(local.captions).toEqual(["Run the SQL migration, then check cron."]);
    expect(local.script).toEqual(fromWire);
  });
});
