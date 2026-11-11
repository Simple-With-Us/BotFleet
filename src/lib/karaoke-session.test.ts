// @vitest-environment happy-dom
// A rendered reply following its voice: alignment from the real spoken
// script, painting through injected CSS.highlights fakes (happy-dom has none),
// and frames driven by hand.
import { describe, expect, it } from "vitest";

import { estimatedClips } from "../../shared/karaoke-align";
import { karaokeScriptFromWire, localKaraokeScript } from "../../shared/spoken-script";
import { toUtterances } from "../../server/tts/speech-text";
import { attachKaraoke, KARAOKE_LINGER_MS } from "./karaoke-session";
import { KARAOKE_HIGHLIGHT_NAMES, type KaraokeEnv } from "./karaoke-highlight";
import { ClipsKaraoke, LiveKaraoke } from "./tts/karaoke-feed";

const SOURCE = [
  "Build **749** passed on main.",
  "",
  "```ts",
  "const answer = 42;",
  "```",
  "",
  "See [the guide](https://example.com/guide) for the rest.",
].join("\n");

/** What ChatMarkdown renders for SOURCE, near enough. */
const RENDERED =
  "<p>Build <strong>749</strong> passed on main.</p>" +
  "<pre><code>const answer = 42;</code></pre>" +
  "<p>See <a href='https://example.com/guide'>the guide</a> for the rest.</p>";

function mount(html: string): Element {
  const container = document.createElement("div");
  container.innerHTML = `<div class="chat-md">${html}</div>`;
  document.body.appendChild(container);
  return container;
}

class FakeHighlight extends Set<AbstractRange> {
  priority = 0;
}

function fakeEnv() {
  const registry = new Map<string, FakeHighlight>();
  const frames: Array<() => void> = [];
  let now = 0;
  const env: Partial<KaraokeEnv> = {
    highlights: registry,
    createHighlight: () => new FakeHighlight(),
    requestFrame: (cb) => frames.push(cb),
    cancelFrame: () => {},
    now: () => now,
    prefersReducedMotion: () => false,
  };
  const painted = (name: keyof typeof KARAOKE_HIGHLIGHT_NAMES): string[] =>
    [...(registry.get(KARAOKE_HIGHLIGHT_NAMES[name]) ?? [])].map((r) => String(r));
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  return {
    env,
    registry,
    painted,
    scheduled,
    schedule: (fn: () => void, ms: number) => {
      scheduled.push({ fn, ms });
      return () => {};
    },
    setNow: (t: number) => {
      now = t;
    },
    flush: () => {
      const pending = frames.splice(0);
      for (const cb of pending) cb();
    },
  };
}

function clipsFeed() {
  const { script } = localKaraokeScript(SOURCE);
  const feed = new ClipsKaraoke("msg_1", script, estimatedClips(script.utterances));
  const audio = { currentTime: 0, duration: Number.NaN };
  feed.attach(0, audio);
  return { feed, audio, script };
}

describe("attachKaraoke with a hosted voice", () => {
  it("aligns with the spans and rolls the spoken word in, leaving every other word alone", () => {
    const fx = fakeEnv();
    const { feed, audio, script } = clipsFeed();
    const session = attachKaraoke(mount(RENDERED), feed, SOURCE, { env: fx.env, schedule: fx.schedule });
    expect(session.alignment?.guided).toBe(true);
    // The code block is not on screen as words; its spoken mention is not
    // paired with any of them.
    const display = session.highlighter.words.map((w) => w.text);
    expect(display).not.toContain("answer");
    expect(display).toContain("749");

    // Halfway through "passed" by the clip's own clock.
    const spokenPassed = session.alignment!.spokenWords.findIndex((w) => w.text === "passed");
    const word = session.alignment!.spokenWords[spokenPassed];
    const clip = feed.clips[0];
    const startMs = clip.startMs + (clip.durationMs * word.start) / (clip.spokenEnd - clip.spokenStart);
    audio.currentTime = (startMs + 30) / 1000;
    fx.flush();
    const current = fx.painted("current");
    expect(current).toHaveLength(1);
    expect("passed".startsWith(current[0])).toBe(true);
    // Nothing dims the rest of the message when reading starts.
    expect(fx.painted("ahead")).toEqual([]);
    expect(script.spokenText).toContain("749");
    session.dispose();
    expect(fx.registry.size).toBe(0);
  });

  it("re-times the words when a clip's real length arrives", () => {
    const fx = fakeEnv();
    const { feed, audio } = clipsFeed();
    const session = attachKaraoke(mount(RENDERED), feed, SOURCE, { env: fx.env, schedule: fx.schedule });
    audio.currentTime = 0.05;
    fx.flush();
    expect(fx.painted("current")[0]).toBeTruthy();
    // The first clip is much longer than estimated: at 1.0 s it is still on
    // an early word, not past the clip's estimated end.
    feed.measure(0, 30);
    audio.currentTime = 1.0;
    fx.flush();
    const current = fx.painted("current");
    expect(current).toHaveLength(1);
    expect(["Build", "749"].some((w) => w.startsWith(current[0]))).toBe(true);
    session.dispose();
  });

  it("falls back to unguided alignment when the spans index other text", () => {
    const fx = fakeEnv();
    const { feed } = clipsFeed();
    const session = attachKaraoke(mount(RENDERED), feed, `${SOURCE} plus an edit`, { env: fx.env, schedule: fx.schedule });
    expect(session.alignment?.guided).toBe(false);
    expect(session.alignment?.mapping.displayCount).toBe(session.highlighter.words.length);
    session.dispose();
  });

  it("lingers on a finished reply, but clears at once when stopped", () => {
    const fx = fakeEnv();
    const first = clipsFeed();
    attachKaraoke(mount(RENDERED), first.feed, SOURCE, { env: fx.env, schedule: fx.schedule });
    first.audio.currentTime = 0.05;
    fx.flush();
    expect(fx.registry.size).toBeGreaterThan(0);
    first.feed.end("finished");
    expect(fx.registry.size).toBeGreaterThan(0);
    expect(fx.scheduled).toEqual([{ fn: expect.any(Function), ms: KARAOKE_LINGER_MS }]);
    fx.scheduled[0].fn();
    expect(fx.registry.size).toBe(0);

    const second = clipsFeed();
    attachKaraoke(mount(RENDERED), second.feed, SOURCE, { env: fx.env, schedule: fx.schedule });
    second.audio.currentTime = 0.05;
    fx.flush();
    second.feed.end("stopped");
    expect(fx.registry.size).toBe(0);
  });

  it("paints nothing where CSS.highlights is missing", () => {
    const { feed } = clipsFeed();
    const session = attachKaraoke(mount(RENDERED), feed, SOURCE, { env: { highlights: null, createHighlight: null } });
    expect(session.highlighter.supported).toBe(false);
    expect(session.alignment).toBeNull();
    session.dispose();
  });
});

describe("attachKaraoke with a script that has spans", () => {
  // A reply that is mostly bare links: the deterministic script reads each
  // one as "a link", so few spoken words match a word on screen.  The spans
  // still say which link each "a link" stands for.
  const LINKS_SOURCE = [
    "Sources:",
    "",
    ...Array.from({ length: 8 }, (_, i) => `- https://example.com/docs/page-${i}/section`),
    "",
    "Done.",
  ].join("\n");
  const LINKS_RENDERED =
    "<p>Sources:</p><ul>" +
    Array.from({ length: 8 }, (_, i) => `<li><a href='https://example.com/docs/page-${i}/section'>https://example.com/docs/page-${i}/section</a></li>`).join("") +
    "</ul><p>Done.</p>";

  it("follows a link list read as \"a link\" each time", () => {
    const fx = fakeEnv();
    const { script } = localKaraokeScript(LINKS_SOURCE);
    const feed = new LiveKaraoke("msg_1", script);
    const session = attachKaraoke(mount(LINKS_RENDERED), feed, LINKS_SOURCE, { env: fx.env, schedule: fx.schedule });
    expect(session.alignment?.guided).toBe(true);
    expect(session.alignment?.followable).toBe(true);
    fx.setNow(1_000);
    feed.range(script.spokenText.lastIndexOf("Done"), 990);
    // The 56 link words before "Done" were never reported; the cue sweeps
    // them quickly and lands on "Done" instead of staying dark.
    let landed = false;
    for (let t = 1_050; t <= 5_000 && !landed; t += 50) {
      fx.setNow(t);
      fx.flush();
      const current = fx.painted("current");
      landed = current.length === 1 && "Done".startsWith(current[0]);
    }
    expect(landed).toBe(true);
    session.dispose();
  });
});

describe("attachKaraoke with a Personal Voice", () => {
  it("cues each reported word, including the newest one reported before it attached", () => {
    const fx = fakeEnv();
    const { script } = localKaraokeScript(SOURCE);
    const feed = new LiveKaraoke("msg_1", script);
    fx.setNow(1_000);
    feed.range(script.spokenText.indexOf("749"), 990);
    const session = attachKaraoke(mount(RENDERED), feed, SOURCE, { env: fx.env, schedule: fx.schedule });
    // "Build" was skipped past (the cue sweeps it in 40 ms), then "749".
    fx.setNow(1_100);
    fx.flush();
    expect(fx.painted("current")).toHaveLength(1);
    expect("749".startsWith(fx.painted("current")[0])).toBe(true);

    fx.setNow(1_400);
    feed.range(script.spokenText.indexOf("passed"), 1_380);
    fx.setNow(1_420);
    fx.flush();
    expect("passed".startsWith(fx.painted("current")[0])).toBe(true);
    // The word just spoken trails off instead of snapping back.
    expect(fx.painted("trail").some((text) => "749".startsWith(text) || text === "749")).toBe(true);
    session.dispose();
    expect(fx.registry.size).toBe(0);
  });
});

describe("attachKaraoke with a distilled script", () => {
  // What the default voice reads for SOURCE: the DeepSeek rewrite, with the
  // number spelled out, the code block skipped, a pause tag, and the link
  // read by its label.  No spans.
  const DISTILLED = "Build seven four nine passed on main. <#0.3#> See the guide for the rest.";

  it("follows the rendered words without spans, landing the spelled number on 749", () => {
    const fx = fakeEnv();
    const script = karaokeScriptFromWire(toUtterances(DISTILLED));
    const feed = new LiveKaraoke("msg_1", script);
    const session = attachKaraoke(mount(RENDERED), feed, SOURCE, { env: fx.env, schedule: fx.schedule });
    expect(session.alignment?.guided).toBe(false);
    expect(session.alignment?.followable).toBe(true);

    fx.setNow(1_000);
    feed.range(script.spokenText.indexOf("four"), 990);
    fx.setNow(1_100);
    fx.flush();
    expect(fx.painted("current")).toHaveLength(1);
    expect("749".startsWith(fx.painted("current")[0])).toBe(true);
    // "passed on main See the" were never reported (the clock jumped), so
    // the cue sweeps them in 40 ms apiece before "guide" rolls in.
    fx.setNow(1_400);
    feed.range(script.spokenText.indexOf("guide"), 1_390);
    fx.setNow(1_700);
    fx.flush();
    expect(fx.painted("current")).toHaveLength(1);
    expect("guide".startsWith(fx.painted("current")[0])).toBe(true);
    session.dispose();
  });

  it("shows no highlight for a brief summary that does not line up with the message", () => {
    const fx = fakeEnv();
    const script = karaokeScriptFromWire(["Good news, everything shipped and nothing else needs your attention."]);
    const feed = new LiveKaraoke("msg_1", script);
    const session = attachKaraoke(mount(RENDERED), feed, SOURCE, { env: fx.env, schedule: fx.schedule });
    expect(session.alignment?.followable).toBe(false);
    fx.setNow(1_000);
    feed.range(script.spokenText.indexOf("shipped"), 990);
    fx.setNow(1_100);
    fx.flush();
    expect(fx.painted("current")).toEqual([]);
    expect(fx.registry.size).toBe(0);
    session.dispose();
  });
});
