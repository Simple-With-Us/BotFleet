// The highlighter's DOM half: which text it reads, the ranges it builds, and
// what it paints per frame.  happy-dom has no CSS.highlights, so the registry
// and Highlight are injected fakes (a Map and a Set) — the same shapes the
// browser exposes — and the frame loop is driven by hand.
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { tokenizeWords } from "../../shared/karaoke-align.ts";
import {
  collectDisplayText,
  createKaraokeHighlighter,
  graphemeBoundaries,
  KARAOKE_HIGHLIGHT_NAMES,
  rangeForOffsets,
  supportsKaraokeHighlight,
  type KaraokeEnv,
} from "./karaoke-highlight";

function mount(html: string): Element {
  const win = new Window({ url: "http://127.0.0.1:5199/" });
  const container = win.document.createElement("div");
  container.className = "chat-md";
  container.innerHTML = html;
  win.document.body.appendChild(container);
  return container as unknown as Element;
}

class FakeHighlight extends Set<AbstractRange> {
  priority = 0;
}

function fakeEnv(overrides: Partial<KaraokeEnv> = {}) {
  const registry = new Map<string, FakeHighlight>();
  const frames: Array<() => void> = [];
  let now = 0;
  const env: Partial<KaraokeEnv> = {
    highlights: registry as unknown as KaraokeEnv["highlights"],
    createHighlight: () => new FakeHighlight(),
    requestFrame: (cb) => frames.push(cb),
    cancelFrame: () => {},
    now: () => now,
    prefersReducedMotion: () => false,
    ...overrides,
  };
  const painted = (name: keyof typeof KARAOKE_HIGHLIGHT_NAMES): string[] =>
    [...(registry.get(KARAOKE_HIGHLIGHT_NAMES[name]) ?? [])].map((r) => (r as Range).toString()).sort();
  return {
    env,
    registry,
    painted,
    setNow: (t: number) => {
      now = t;
    },
    flush: () => {
      const pending = frames.splice(0);
      for (const cb of pending) cb();
      return pending.length;
    },
  };
}

/** word i over [i*300, i*300+250) */
function evenTimeline(count: number): number[] {
  return Array.from({ length: count }, (_, i) => [i * 300, i * 300 + 250]).flat();
}

describe("collectDisplayText", () => {
  it("reads inline formatting as one word and separates blocks", () => {
    const container = mount(
      "<p>Hello <b>bo</b>ld world</p><p>Next <a href='#'>para</a></p><ul><li>one</li><li>two</li></ul>",
    );
    const display = collectDisplayText(container);
    expect(display.text).toBe("Hello bold world\nNext para\none\ntwo");
    expect(display.words.map((w) => w.text)).toEqual(["Hello", "bold", "world", "Next", "para", "one", "two"]);
  });

  it("tokenizes exactly as the aligner does", () => {
    const container = mount("<p>It's <code>pnpm test</code> — 749 “quotes”, café.</p>");
    const display = collectDisplayText(container);
    expect(display.words).toEqual(tokenizeWords(display.text));
  });

  it("skips fenced code, controls and opted-out subtrees, with a break in their place", () => {
    const container = mount(
      "<p>Fixed it:</p><pre><code>const a = 1;</code></pre><p>That's it<button>Copy</button>done<span data-karaoke-skip>hidden</span></p>",
    );
    expect(collectDisplayText(container).text).toBe("Fixed it:\nThat's it\ndone");
  });

  it("treats a line break as a separator", () => {
    const container = mount("<p>first<br>second</p>");
    expect(collectDisplayText(container).words.map((w) => w.text)).toEqual(["first", "second"]);
  });
});

describe("ranges", () => {
  it("builds a range per word, across element boundaries", () => {
    const container = mount("<p>Hello <b>bo</b>ld <i>wo</i><i>rld</i></p>");
    const display = collectDisplayText(container);
    const texts = display.words.map((w) => rangeForOffsets(display, w.start, w.end)?.toString());
    expect(texts).toEqual(["Hello", "bold", "world"]);
  });

  it("splits a word at grapheme boundaries", () => {
    expect(graphemeBoundaries("café")).toEqual([0, 1, 2, 3, 4]);
    expect(graphemeBoundaries("éx")).toEqual([0, 2, 3]);
    expect(graphemeBoundaries("a👍🏽b")).toEqual([0, 1, 5, 6]);
  });
});

describe("feature detection", () => {
  it("reports no support without CSS.highlights, and still tokenizes", () => {
    expect(supportsKaraokeHighlight({ highlights: null, createHighlight: null })).toBe(false);
    const hl = createKaraokeHighlighter(mount("<p>Hello world</p>"), {
      env: { highlights: null, createHighlight: null },
    });
    expect(hl.supported).toBe(false);
    expect(hl.words.map((w) => w.text)).toEqual(["Hello", "world"]);
    hl.play(evenTimeline(2), () => 100);
    hl.renderAt(100);
    expect(hl.currentIndex).toBe(-1);
    hl.dispose();
  });

  it("reports support when both the registry and Highlight exist", () => {
    expect(supportsKaraokeHighlight(fakeEnv().env)).toBe(true);
  });
});

describe("timeline painting", () => {
  it("dims what is ahead, rolls the current word in, and trails the last one", () => {
    const fake = fakeEnv();
    const hl = createKaraokeHighlighter(mount("<p>alpha beta gamma delta</p>"), { env: fake.env });
    hl.play(evenTimeline(4), () => 0);
    expect(fake.registry.get(KARAOKE_HIGHLIGHT_NAMES.current)?.priority).toBe(3);

    hl.renderAt(-1);
    expect(fake.painted("ahead")).toEqual(["alpha", "beta", "delta", "gamma"]);

    // halfway through "gamma" (600-850): "gam" lit, "ma" still dim, "beta"
    // (ended at 550) trailing
    hl.renderAt(725);
    expect(hl.currentIndex).toBe(2);
    expect(fake.painted("current")).toEqual(["gam"]);
    expect(fake.painted("ahead")).toEqual(["delta", "ma"]);
    expect(fake.painted("trail")).toEqual(["beta"]);

    // after the end: nothing dim, nothing current
    hl.renderAt(2000);
    expect(fake.painted("ahead")).toEqual([]);
    expect(fake.painted("current")).toEqual([]);
    expect(fake.painted("trail")).toEqual([]);

    // seeking back re-dims
    hl.renderAt(310);
    expect(fake.painted("ahead")).toEqual(["delta", "eta", "gamma"]);
    expect(fake.painted("current")).toEqual(["b"]);
    hl.dispose();
  });

  it("steps whole words with reduced motion, without trails or flashes", () => {
    const fake = fakeEnv();
    const hl = createKaraokeHighlighter(mount("<p>alpha beta gamma</p>"), { env: fake.env, reducedMotion: true });
    // "beta" is swept in 40 ms: never shown as current under reduced motion
    hl.play([0, 250, 250, 290, 300, 550], () => 0);
    hl.renderAt(10);
    expect(fake.painted("current")).toEqual(["alpha"]);
    hl.renderAt(260);
    expect(fake.painted("current")).toEqual([]);
    hl.renderAt(301);
    expect(fake.painted("current")).toEqual(["gamma"]);
    expect(fake.painted("trail")).toEqual([]);
    hl.dispose();
  });

  it("runs on frames from the clock and stops after the last word", () => {
    const fake = fakeEnv();
    let t = 0;
    const hl = createKaraokeHighlighter(mount("<p>one two</p>"), { env: fake.env });
    hl.play(evenTimeline(2), () => t);
    t = 100;
    fake.flush();
    expect(hl.currentIndex).toBe(0);
    t = 5000;
    fake.flush();
    expect(fake.flush()).toBe(0); // the loop ended
    hl.dispose();
  });

  it("clears its highlights on stop and leaves another message's alone", () => {
    const fake = fakeEnv();
    const first = createKaraokeHighlighter(mount("<p>first message</p>"), { env: fake.env });
    first.play(evenTimeline(2), () => 0);
    const second = createKaraokeHighlighter(mount("<p>second message</p>"), { env: fake.env });
    second.play(evenTimeline(2), () => 0);
    first.stop();
    expect(fake.registry.size).toBe(3);
    second.stop();
    expect(fake.registry.size).toBe(0);
  });
});

describe("live cues", () => {
  it("lights the cued word and sweeps skipped ones before it", () => {
    const fake = fakeEnv();
    const hl = createKaraokeHighlighter(mount("<p>See https example com now</p>"), {
      env: fake.env,
      skipStepMs: 40,
      skipMaxMs: 320,
    });
    fake.setNow(1000);
    hl.cue(0, 250);
    hl.renderAt(1100);
    expect(hl.currentIndex).toBe(0);

    fake.setNow(1300);
    hl.cue(4, 250); // jump past three skipped words: 120 ms of sweep first
    hl.renderAt(1300);
    expect(hl.currentIndex).toBe(1);
    hl.renderAt(1350);
    expect(hl.currentIndex).toBe(2);
    hl.renderAt(1425);
    expect(hl.currentIndex).toBe(4);
    expect(fake.painted("ahead")).toEqual(["ow"]);
    hl.dispose();
  });

  it("extends the same word when it is cued again", () => {
    const fake = fakeEnv();
    const hl = createKaraokeHighlighter(mount("<p>749 flights</p>"), { env: fake.env });
    fake.setNow(0);
    hl.cue(0, 100); // "seven"
    fake.setNow(100);
    hl.cue(0, 100); // "four"
    hl.renderAt(150);
    expect(hl.currentIndex).toBe(0);
    hl.dispose();
  });
});
