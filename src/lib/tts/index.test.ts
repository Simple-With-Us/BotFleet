import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  groupForPersonalVoice,
  MAX_LOCAL_SPEECH_CHARS,
  personalVoiceErrorMessage,
  PERSONAL_VOICE_GROUP_CHARS,
  PERSONAL_VOICE_NOT_ON_THIS_MAC,
  REPLY_TOO_LONG,
  Speaker,
} from "./index";
import type { TtsAudioBody } from "./schema";

class FakeAudio {
  static instances: FakeAudio[] = [];
  static get latest(): FakeAudio | null {
    return FakeAudio.instances.at(-1) ?? null;
  }

  src: string;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  currentTime = 0;
  duration = 10;
  pause = vi.fn();
  play = vi.fn(async () => {});

  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }
}

/** The bodies the voice routes answer with: an audio answer, a failure, or
 * a /api/tts/prepare answer. */
type AudioErrorBody = {
  error: string;
  retryable?: boolean;
  ready?: number;
  total?: number;
  maxUtterances?: number;
  maxCharacters?: number;
};
type PrepareBody = { ready: boolean; utterances: string[] };

function json(body: TtsAudioBody | AudioErrorBody | PrepareBody, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function mp3(): Response {
  return new Response(new Blob(["mp3"]), { status: 200 });
}

const endpoint = "/api/threads/task_1/messages/msg_1/audio";
const clip = (index: number) => `${endpoint}/${index}?device=mac`;
const messageOpts = { botId: "bot_1", threadId: "task_1", messageId: "msg_1" };

type Call = { url: string; method: string; body?: unknown; contentType?: string };

/** fetch stand-in that records every request and answers from `route`. */
function stubFetch(route: (call: Call, calls: Call[]) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        contentType: headers.get("content-type") ?? undefined,
      };
      calls.push(call);
      return route(call, calls);
    }),
  );
  return calls;
}

/** Wait for the nth clip to start, then end it. */
async function finishClip(n: number) {
  await vi.waitFor(() => expect(FakeAudio.instances.length).toBeGreaterThanOrEqual(n));
  FakeAudio.instances[n - 1].onended?.();
}

function stubPersonalVoice(speak = vi.fn().mockResolvedValue(undefined)) {
  const stop = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("window", { ogb: { personalVoice: { speak, stop } } });
  return { speak, stop };
}

const noSleep = vi.fn(async (_ms: number, _signal: AbortSignal) => {});

describe("Speaker lifecycle", () => {
  beforeEach(() => {
    FakeAudio.instances = [];
    noSleep.mockClear();
    vi.restoreAllMocks();
    vi.stubGlobal("Audio", FakeAudio);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice-test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("settles an in-progress speak when stop interrupts audio", async () => {
    stubFetch((call) => (call.url.endsWith("/prepare") ? json({ ready: true, utterances: ["Hello there."] }) : mp3()));
    const speaker = new Speaker();
    const speaking = speaker.speak("Hello there.");
    await vi.waitFor(() => expect(FakeAudio.latest).not.toBeNull());

    speaker.stop();

    await expect(speaking).resolves.toBeUndefined();
    expect(FakeAudio.latest!.pause).toHaveBeenCalled();
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("aborts preparation when stopped instead of leaving a request alive", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }),
    );
    const speaker = new Speaker();
    const speaking = speaker.speak("A long response");

    speaker.stop();

    await expect(speaking).resolves.toBeUndefined();
    expect(signal?.aborted).toBe(true);
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("asks the message route for this Mac's progressive audio and never sends text to the synthesis route", async () => {
    const calls = stubFetch((call) =>
      call.url === endpoint
        ? json({ audio: [{ path: "/api/attachments/clip.mp3", mime: "audio/mpeg" }], total: 1, complete: true })
        : mp3(),
    );
    const speaker = new Speaker();
    const speaking = speaker.speak("Saved reply", messageOpts);
    await finishClip(1);
    await speaking;

    expect(calls.map((call) => call.url)).toEqual([endpoint, clip(0)]);
    expect(calls[0]).toMatchObject({
      method: "POST",
      contentType: "application/json",
      body: { device: "mac", progressive: true },
    });
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("plays the first clip before the rest exist, polls a clip that is not ready, and prefetches the next", async () => {
    let clipOneAsks = 0;
    const calls = stubFetch((call) => {
      if (call.url === endpoint) {
        return json({
          audio: [],
          voiceText: "First sentence. Second sentence.",
          utterances: ["First sentence.", "Second sentence."],
          total: 2,
          complete: false,
        });
      }
      if (call.url === clip(0)) return mp3();
      if (call.url === clip(1)) {
        clipOneAsks += 1;
        return clipOneAsks === 1
          ? json({ error: "This voice clip is still being prepared.", retryable: true, ready: 1, total: 2 }, 425, { "retry-after": "1" })
          : mp3();
      }
      return json({ error: "unexpected" }, 500);
    });
    const speaker = new Speaker({ sleep: noSleep });
    const speaking = speaker.speak("Saved reply", messageOpts);

    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    expect(speaker.state).toMatchObject({ status: "speaking", caption: "First sentence.", messageId: "msg_1" });
    // Clip 1 is requested (and retried) while clip 0 is still playing.
    await vi.waitFor(() => expect(clipOneAsks).toBe(2));
    expect(noSleep).toHaveBeenCalledWith(1_000, expect.any(AbortSignal));
    expect(FakeAudio.instances).toHaveLength(1);

    await finishClip(1);
    await vi.waitFor(() => expect(speaker.state.caption).toBe("Second sentence."));
    await finishClip(2);
    await speaking;

    expect(calls.map((call) => call.url)).toEqual([endpoint, clip(0), clip(1), clip(1)]);
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("does not read an empty progressive answer as on-device speech", async () => {
    const { speak } = stubPersonalVoice();
    stubFetch((call) =>
      call.url === endpoint ? json({ audio: [], voiceText: "Hello.", utterances: ["Hello."], total: 1, complete: false }) : mp3(),
    );
    const speaker = new Speaker({ sleep: noSleep });
    const speaking = speaker.speak("Hello.", { ...messageOpts, voiceId: "minimax-warm" });
    await finishClip(1);
    await speaking;

    expect(speak).not.toHaveBeenCalled();
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("resumes a clip the harness forgot by asking for the reply again, once", async () => {
    let clipAsks = 0;
    const calls = stubFetch((call) => {
      if (call.url === endpoint) return json({ audio: [], utterances: ["Only."], total: 1, complete: false });
      clipAsks += 1;
      return clipAsks === 1 ? json({ error: "no such voice clip" }, 404) : mp3();
    });
    const speaker = new Speaker({ sleep: noSleep });
    const speaking = speaker.speak("Only.", messageOpts);
    await finishClip(1);
    await speaking;

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${endpoint}`,
      `GET ${clip(0)}`,
      `POST ${endpoint}`,
      `GET ${clip(0)}`,
    ]);
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("stops after one resume when the clip is still missing", async () => {
    const calls = stubFetch((call) =>
      call.url === endpoint
        ? json({ audio: [], utterances: ["Only."], total: 1, complete: false })
        : json({ error: "no such voice clip" }, 404),
    );
    const speaker = new Speaker({ sleep: noSleep });
    await speaker.speak("Only.", messageOpts);

    expect(calls.filter((call) => call.method === "POST")).toHaveLength(2);
    expect(speaker.state).toEqual({ status: "idle", botId: "bot_1", messageId: "msg_1", error: "no such voice clip" });
  });

  it("reports a failed synthesis job on the message instead of retrying forever", async () => {
    stubFetch((call) =>
      call.url === endpoint
        ? json({ audio: [], utterances: ["Only."], total: 1, complete: false })
        : json({ error: "MiniMax refused the request" }, 502),
    );
    const speaker = new Speaker({ sleep: noSleep });
    await speaker.speak("Only.", messageOpts);

    expect(speaker.state).toMatchObject({ status: "idle", messageId: "msg_1", error: "MiniMax refused the request" });
  });

  it("gives up on a clip that never becomes ready", async () => {
    let clipAsks = 0;
    stubFetch((call) => {
      if (call.url === endpoint) return json({ audio: [], utterances: ["Only."], total: 1, complete: false });
      clipAsks += 1;
      return json({ error: "This voice clip is still being prepared.", retryable: true }, 425, { "retry-after": "1" });
    });
    const speaker = new Speaker({ sleep: noSleep });
    await speaker.speak("Only.", messageOpts);

    expect(clipAsks).toBe(12);
    expect(speaker.state.error).toBe("The voice clip took too long to prepare.");
  });

  it("says a reply is too long instead of the raw 413", async () => {
    stubFetch(() => json({ error: "reply exceeds voice clip limit", total: 300, maxUtterances: 160, maxCharacters: 12000 }, 413));
    const speaker = new Speaker();
    await speaker.speak("Long reply", { ...messageOpts, voiceId: "minimax-warm" });

    expect(speaker.state.error).toBe(REPLY_TOO_LONG);
  });

  it("updates wordIndex on ontimeupdate during playback", async () => {
    stubFetch((call) =>
      call.url === endpoint
        ? json({
            audio: [{ path: "/api/attachments/clip.mp3", mime: "audio/mpeg" }],
            voiceText: "First second third fourth",
            utterances: ["First second third fourth"],
            total: 1,
            complete: true,
          })
        : mp3(),
    );
    const speaker = new Speaker();
    const speaking = speaker.speak("First second third fourth", messageOpts);
    await vi.waitFor(() => expect(FakeAudio.latest).not.toBeNull());

    expect(speaker.state.wordIndex).toBe(0);

    // 4 words across 10s: word 0 = 0-2.5s, word 1 = 2.5-5s, word 2 = 5-7.5s, word 3 = 7.5-10s
    FakeAudio.latest!.currentTime = 3.0;
    FakeAudio.latest!.ontimeupdate?.();
    expect(speaker.state.wordIndex).toBe(1);

    FakeAudio.latest!.currentTime = 6.0;
    FakeAudio.latest!.ontimeupdate?.();
    expect(speaker.state.wordIndex).toBe(2);

    FakeAudio.latest!.onended?.();
    await speaking;
    expect(speaker.state.status).toBe("idle");
  });

  it("passes a per-bot voice through preparation and synthesis for text that is not a saved reply", async () => {
    const calls = stubFetch((call) =>
      call.url.endsWith("/prepare") ? json({ ready: true, utterances: ["Distinct voice."] }) : mp3(),
    );
    const speaker = new Speaker();
    const speaking = speaker.speak("Distinct voice.", { voiceId: "voice-bot" });
    await finishClip(1);
    await speaking;

    expect(calls.map((call) => call.body)).toEqual([
      { text: "Distinct voice.", voiceId: "voice-bot" },
      { text: "Distinct voice.", voiceId: "voice-bot" },
    ]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:voice-test");
  });
});

describe("Speaker with an Apple Personal Voice on this Mac", () => {
  beforeEach(() => {
    FakeAudio.instances = [];
    vi.restoreAllMocks();
    vi.stubGlobal("Audio", FakeAudio);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("speaks the harness's projected utterances, not the raw message, with the voice the harness resolved", async () => {
    const { speak } = stubPersonalVoice();
    const calls = stubFetch(() =>
      json({
        audio: [],
        voiceText: "Morning. The tests went green.",
        utterances: ["Morning.", "The tests went green."],
        total: 2,
        complete: true,
        onDevice: true,
        personalVoice: true,
        voice: "personal:mac-voice",
      }),
    );
    const speaker = new Speaker();
    await speaker.speak("**Morning.**  The tests went green: `pnpm test`.", {
      ...messageOpts,
      voiceId: "personal:stale-copy",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ device: "mac", progressive: true });
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith("Morning. The tests went green.", "personal:mac-voice");
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("speaks a long reply as paragraph-sized calls, in order", async () => {
    const { speak } = stubPersonalVoice();
    const sentence = "This sentence is about seventy characters long, give or take a few more.";
    const utterances = Array.from({ length: 20 }, (_, i) => `${i + 1}. ${sentence}`);
    stubFetch(() => json({ audio: [], utterances, total: utterances.length, complete: true, onDevice: true, voice: "personal:mac-voice" }));
    const speaker = new Speaker();
    await speaker.speak("long", messageOpts);

    const spoken = speak.mock.calls.map(([text]) => String(text));
    expect(spoken.length).toBeGreaterThan(1);
    expect(spoken.length).toBeLessThan(utterances.length);
    for (const text of spoken) expect(text.length).toBeLessThanOrEqual(PERSONAL_VOICE_GROUP_CHARS);
    expect(spoken.join(" ")).toBe(utterances.join(" "));
  });

  it("stops between helper calls when stop interrupts", async () => {
    let speaker: Speaker | null = null;
    const speak = vi.fn(async () => {
      // stop() lands while the first group is being spoken.
      speaker?.stop();
    });
    const { stop } = stubPersonalVoice(speak);
    const utterances = Array.from({ length: 20 }, (_, i) => `Sentence ${i + 1} is here to make this long enough to split into groups.`);
    stubFetch(() => json({ audio: [], utterances, total: utterances.length, complete: true, onDevice: true, voice: "personal:mac-voice" }));
    speaker = new Speaker();
    await speaker.speak("long", messageOpts);

    expect(speak).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalled();
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("falls back to the reply's spoken text when the harness cannot be asked", async () => {
    const { speak } = stubPersonalVoice();
    stubFetch(() => json({ error: "harness unavailable" }, 503));
    const speaker = new Speaker();
    await speaker.speak("[voice_summary]Short version.[/voice_summary][written_answer]Long written version.[/written_answer]", {
      ...messageOpts,
      voiceId: "personal:mac-voice",
    });

    expect(speak).toHaveBeenCalledWith("Short version.", "personal:mac-voice");
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("shows a reply that is too long instead of reading it here when the harness answers 413", async () => {
    const { speak } = stubPersonalVoice();
    stubFetch(() => json({ error: "reply exceeds voice clip limit", total: 400, maxUtterances: 160, maxCharacters: 12_000 }, 413));
    const speaker = new Speaker();
    await speaker.speak("A long reply with `code` and https://example.com/a/very/long/link in it.", {
      ...messageOpts,
      voiceId: "personal:mac-voice",
    });

    expect(speak).not.toHaveBeenCalled();
    expect(speaker.state).toEqual({ status: "idle", botId: "bot_1", messageId: "msg_1", error: REPLY_TOO_LONG });
  });

  it("shows the harness's own sentence for any other refusal instead of reading the reply here", async () => {
    const { speak } = stubPersonalVoice();
    stubFetch(() => json({ error: "no such reply" }, 404));
    const speaker = new Speaker();
    await speaker.speak("Hello there.", { ...messageOpts, voiceId: "personal:mac-voice" });

    expect(speak).not.toHaveBeenCalled();
    expect(speaker.state).toEqual({ status: "idle", botId: "bot_1", messageId: "msg_1", error: "no such reply" });
  });

  it("projects the reply with the harness's rules when the harness cannot be reached", async () => {
    const { speak } = stubPersonalVoice();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const speaker = new Speaker();
    const reply = [
      "## Done",
      "",
      "I updated **two files**.  See https://github.com/example/repo/pull/12 for the diff.",
      "",
      "```ts",
      "const answer = 42;",
      "```",
    ].join("\n");
    await speaker.speak(reply, { ...messageOpts, voiceId: "personal:mac-voice" });

    const spoken = speak.mock.calls.map(([text]) => String(text)).join(" ");
    expect(spoken).toContain("two files");
    expect(spoken).not.toMatch(/https?:|`|\*\*|##|const answer/);
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("holds a reply it projects itself to the harness's length bound", async () => {
    const { speak } = stubPersonalVoice();
    stubFetch(() => json({ error: "harness unavailable" }, 503));
    const speaker = new Speaker();
    const sentence = "This sentence is long enough to count toward the spoken character bound.";
    const reply = Array.from({ length: Math.ceil(MAX_LOCAL_SPEECH_CHARS / sentence.length) + 10 }, () => sentence).join(" ");
    await speaker.speak(reply, { ...messageOpts, voiceId: "personal:mac-voice" });

    expect(speak).not.toHaveBeenCalled();
    expect(speaker.state).toMatchObject({ status: "idle", error: REPLY_TOO_LONG });
  });

  it("names a Personal Voice that is not on this Mac instead of the helper's code", async () => {
    stubPersonalVoice(vi.fn().mockRejectedValue(new Error("Error invoking remote method 'personal-voice:speak': Error: voice-not-found")));
    stubFetch(() => json({ audio: [], utterances: ["Hi."], total: 1, complete: true, onDevice: true, voice: "personal:iphone-voice" }));
    const speaker = new Speaker();
    await speaker.speak("Hi.", messageOpts);

    expect(speaker.state).toEqual({ status: "idle", botId: "bot_1", messageId: "msg_1", error: PERSONAL_VOICE_NOT_ON_THIS_MAC });
  });

  it("speaks a sample on-device without calling the harness", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { speak, stop } = stubPersonalVoice();

    const speaker = new Speaker();
    await speaker.speak("Personal voice reply", {
      voiceId: "personal:com.apple.speech.voice.Jay",
      botId: "bot_1",
    });

    expect(speak).toHaveBeenCalledWith("Personal voice reply", "personal:com.apple.speech.voice.Jay");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(speaker.state.status).toBe("idle");

    speaker.stop();
    expect(stop).toHaveBeenCalled();
  });

  it("handles unsupported platform for personal voice when ogb bridge is absent", async () => {
    vi.stubGlobal("window", {});
    const speaker = new Speaker();
    await speaker.speak("Personal voice reply", {
      voiceId: "personal:com.apple.speech.voice.Jay",
      botId: "bot_1",
    });

    expect(speaker.state.error).toContain("Apple Personal Voice speaks on authorized Apple devices");
  });
});

describe("groupForPersonalVoice", () => {
  it("packs parts in order up to the limit and keeps an oversized part whole", () => {
    expect(groupForPersonalVoice(["One.", "Two.", "Three."], 9)).toEqual(["One. Two.", "Three."]);
    expect(groupForPersonalVoice(["A much longer sentence.", "B."], 10)).toEqual(["A much longer sentence.", "B."]);
    expect(groupForPersonalVoice(["  ", "", "Only."])).toEqual(["Only."]);
  });
});

describe("personalVoiceErrorMessage", () => {
  it("turns helper codes into sentences and passes other errors through", () => {
    expect(personalVoiceErrorMessage("voice-not-found")).toBe(PERSONAL_VOICE_NOT_ON_THIS_MAC);
    expect(personalVoiceErrorMessage("Error invoking remote method: Error: personal-voice-not-authorized")).toContain(
      "Personal Voice is not authorized on this Mac",
    );
    expect(personalVoiceErrorMessage("Personal Voice did not finish speaking.")).toBe(
      "Personal Voice did not finish speaking.",
    );
  });
});
