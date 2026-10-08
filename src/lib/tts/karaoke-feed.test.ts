// The speaker's karaoke feed: what a reply's bubble follows.  The harness
// answers are built with the real span encoder, so the feed sees exactly
// what a harness sends.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { utterancesWithSpans } from "../../../shared/speech-spans";
import { encodeSpokenSpans } from "../../../shared/spoken-script";
import { DEFAULT_MS_PER_CHAR } from "../../../shared/karaoke-align";
import { Speaker } from "./index";
import type { KaraokeClipsFeed, KaraokeFeed, KaraokeFeedEvent, KaraokeLiveFeed } from "./karaoke-feed";

function asClips(feed: KaraokeFeed | null): KaraokeClipsFeed {
  if (feed?.mode !== "clips") throw new Error("expected a clips feed");
  return feed;
}

function asLive(feed: KaraokeFeed | null): KaraokeLiveFeed {
  if (feed?.mode !== "live") throw new Error("expected a live feed");
  return feed;
}
import type { TtsAudioBody } from "./schema";

class FakeAudio {
  static instances: FakeAudio[] = [];
  src: string;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  currentTime = 0;
  duration = Number.NaN;
  pause = vi.fn();
  play = vi.fn(async () => {});
  listeners = new Map<string, Array<() => void>>();
  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

const SOURCE = "Build **749** passed.  The second sentence is here.";
const endpoint = "/api/threads/task_1/messages/msg_1/audio";
const messageOpts = { botId: "bot_1", threadId: "task_1", messageId: "msg_1" };

function written(extra: Partial<TtsAudioBody> = {}): TtsAudioBody {
  const spoken = utterancesWithSpans(SOURCE);
  return {
    audio: [{ path: "/api/attachments/a.mp3", mime: "audio/mpeg" }],
    voiceText: spoken.map((u) => u.text).join(" "),
    utterances: spoken.map((u) => u.text),
    total: spoken.length,
    complete: false,
    voice: "minimax-warm",
    script: "written",
    spans: encodeSpokenSpans(SOURCE, spoken),
    ...extra,
  };
}

function stubFetch(answer: (url: string) => Response) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => answer(String(input))));
}

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const mp3 = () => new Response(new Blob(["mp3"]), { status: 200 });

beforeEach(() => {
  FakeAudio.instances = [];
  vi.restoreAllMocks();
  vi.stubGlobal("Audio", FakeAudio);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice-test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("karaoke feed for a hosted voice", () => {
  it("publishes clip windows and an audio clock when the first clip starts, and ends when the reply does", async () => {
    stubFetch((url) => (url === endpoint ? jsonResponse(written()) : mp3()));
    const speaker = new Speaker();
    const seen: Array<KaraokeFeed | null> = [];
    speaker.subscribeKaraoke((feed) => seen.push(feed));
    const speaking = speaker.speak("raw text", { ...messageOpts, voiceId: "minimax-warm" });

    await vi.waitFor(() => expect(FakeAudio.instances.length).toBe(1));
    const feed = asClips(speaker.karaoke);
    expect(feed.mode).toBe("clips");
    expect(feed.messageId).toBe("msg_1");
    expect(seen).toEqual([null, feed]);
    const utterances = utterancesWithSpans(SOURCE).map((u) => u.text);
    expect(feed.script.spokenText).toBe(utterances.join(" "));
    expect(feed.script.segments.length).toBeGreaterThan(0);
    // Estimated windows, back to back.
    expect(feed.clips[0]).toMatchObject({ startMs: 0, durationMs: utterances[0].length * DEFAULT_MS_PER_CHAR });
    expect(feed.clips[1].startMs).toBe(feed.clips[0].durationMs);

    const events: KaraokeFeedEvent[] = [];
    feed.subscribe((event) => events.push(event));
    const first = FakeAudio.instances[0];
    first.duration = 1.5;
    first.fire("loadedmetadata");
    expect(events).toEqual([{ type: "clips" }]);
    expect(feed.clips[0].durationMs).toBe(1500);
    expect(feed.clips[1].startMs).toBe(1500);

    first.currentTime = 0.75;
    expect(feed.clock()).toBe(750);
    // A clip reporting past its own end is held at it.
    first.currentTime = 9;
    expect(feed.clock()).toBe(1500);
    first.onended?.();

    await vi.waitFor(() => expect(FakeAudio.instances.length).toBe(2));
    // Between clips, and at the start of the next, the clock does not jump back.
    expect(feed.clock()).toBe(1500);
    const second = FakeAudio.instances[1];
    second.currentTime = 0.2;
    expect(feed.clock()).toBe(1700);
    second.onended?.();

    await speaking;
    expect(events.at(-1)).toEqual({ type: "end", reason: "finished" });
    expect(feed.ended).toBe("finished");
    expect(speaker.karaoke).toBeNull();
    expect(seen.at(-1)).toBeNull();
  });

  it("ends the feed as stopped when the reader is stopped", async () => {
    stubFetch((url) => (url === endpoint ? jsonResponse(written()) : mp3()));
    const speaker = new Speaker();
    const speaking = speaker.speak("raw text", { ...messageOpts, voiceId: "minimax-warm" });
    await vi.waitFor(() => expect(FakeAudio.instances.length).toBe(1));
    const feed = speaker.karaoke!;
    speaker.stop();
    await speaking;
    expect(feed.ended).toBe("stopped");
    expect(speaker.karaoke).toBeNull();
  });

  it("publishes an unguided feed for a distilled script and for a harness that does not say", async () => {
    // Spans that came with a distilled script would index the wrong text, so
    // they are ignored unless the script is the written one.
    const distilled = written({ script: "summary" });
    for (const body of [distilled, written({ script: undefined, spans: undefined })]) {
      FakeAudio.instances = [];
      stubFetch((url) => (url === endpoint ? jsonResponse(body) : mp3()));
      const speaker = new Speaker();
      const seen: Array<KaraokeFeed | null> = [];
      speaker.subscribeKaraoke((feed) => seen.push(feed));
      const speaking = speaker.speak("raw text", { ...messageOpts, voiceId: "minimax-warm" });
      await vi.waitFor(() => expect(FakeAudio.instances.length).toBe(1));
      const feed = speaker.karaoke;
      expect(feed?.mode).toBe("clips");
      expect(feed?.script.spokenText).toBe(body.utterances?.join(" "));
      expect(feed?.script.segments).toEqual([]);
      FakeAudio.instances[0].onended?.();
      await vi.waitFor(() => expect(FakeAudio.instances.length).toBe(2));
      FakeAudio.instances[1].onended?.();
      await speaking;
      expect(seen.at(-1)).toBeNull();
      expect(seen.filter((f) => f !== null)).toHaveLength(1);
    }
  });

  it("keeps the utterances and plays on when the spans are malformed", async () => {
    stubFetch((url) => (url === endpoint ? jsonResponse({ ...written(), spans: { format: 9 } }) : mp3()));
    const speaker = new Speaker();
    const speaking = speaker.speak("raw text", { ...messageOpts, voiceId: "minimax-warm" });
    await vi.waitFor(() => expect(FakeAudio.instances.length).toBe(1));
    const feed = speaker.karaoke!;
    expect(feed.script.segments).toEqual([]);
    expect(feed.script.spokenText.length).toBeGreaterThan(0);
    speaker.stop();
    await speaking;
  });
});

describe("karaoke feed for a Personal Voice", () => {
  function stubPersonalVoice(speak: (text: string, voiceId: string, options?: { onRange?: (r: { location: number; length: number; elapsedMs: number | null }) => void }) => Promise<void>) {
    const stop = vi.fn().mockResolvedValue(undefined);
    const spy = vi.fn(speak);
    vi.stubGlobal("window", { ogb: { personalVoice: { speak: spy, stop } } });
    return spy;
  }

  it("passes each word the helper reports on as an offset into the whole spoken text", async () => {
    const sentence = "This sentence is about seventy characters long, give or take a few more.";
    const source = Array.from({ length: 12 }, (_, i) => `Item ${i + 1} says: ${sentence}`).join("\n\n");
    const spoken = utterancesWithSpans(source);
    const utterances = spoken.map((u) => u.text);
    let feed: KaraokeLiveFeed | null = null;
    const ranges: Array<{ offset: number; atMs: number }> = [];
    const speak = stubPersonalVoice(async (text, _voice, options) => {
      // The second word of every group.
      const at = text.indexOf(" ") + 1;
      options?.onRange?.({ location: at, length: 4, elapsedMs: 250 });
    });
    stubFetch(() =>
      jsonResponse({
        audio: [],
        voiceText: utterances.join(" "),
        utterances,
        total: utterances.length,
        complete: true,
        onDevice: true,
        personalVoice: true,
        voice: "personal:mac-voice",
        script: "written",
        spans: encodeSpokenSpans(source, spoken),
      }),
    );
    const speaker = new Speaker();
    speaker.subscribeKaraoke((next) => {
      if (next?.mode === "live" && !feed) {
        feed = next;
        next.subscribe((event) => {
          if (event.type === "range") ranges.push({ offset: event.offset, atMs: event.atMs });
        });
      }
    });
    const before = performance.now();
    await speaker.speak(source, { ...messageOpts, voiceId: "personal:mac-voice" });

    expect(speak.mock.calls.length).toBeGreaterThan(1);
    const spokenText = utterances.join(" ");
    expect(feed!.script.spokenText).toBe(spokenText);
    expect(ranges).toHaveLength(speak.mock.calls.length);
    for (let i = 0; i < ranges.length; i += 1) {
      const group = speak.mock.calls[i][0];
      const base = spokenText.indexOf(group);
      expect(base).toBeGreaterThanOrEqual(0);
      expect(ranges[i].offset).toBe(base + group.indexOf(" ") + 1);
      // The word started 250 ms after this group's zero, never in the future.
      expect(ranges[i].atMs).toBeGreaterThanOrEqual(before - 1);
      expect(ranges[i].atMs).toBeLessThanOrEqual(performance.now() + 1);
    }
    expect(feed!.ended).toBe("finished");
  });

  it("ignores reports that arrive after the reader was stopped", async () => {
    let report: ((r: { location: number; length: number; elapsedMs: number | null }) => void) | undefined;
    let release: () => void = () => {};
    stubPersonalVoice((_text, _voice, options) => {
      report = options?.onRange;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const spoken = utterancesWithSpans(SOURCE);
    stubFetch(() =>
      jsonResponse({
        audio: [],
        utterances: spoken.map((u) => u.text),
        total: spoken.length,
        complete: true,
        onDevice: true,
        voice: "personal:mac-voice",
        script: "written",
        spans: encodeSpokenSpans(SOURCE, spoken),
      }),
    );
    const speaker = new Speaker();
    const speaking = speaker.speak(SOURCE, { ...messageOpts, voiceId: "personal:mac-voice" });
    await vi.waitFor(() => expect(report).toBeDefined());
    const feed = asLive(speaker.karaoke);
    report!({ location: 0, length: 5, elapsedMs: null });
    expect(feed.lastRange?.offset).toBe(0);
    speaker.stop();
    report!({ location: 6, length: 3, elapsedMs: null });
    expect(feed.lastRange?.offset).toBe(0);
    release();
    await speaking;
    expect(feed.ended).toBe("stopped");
  });
});
