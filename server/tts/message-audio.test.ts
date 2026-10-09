// The message-linked speech route against fakes: a fake store row, a fake
// attachment directory, and a voice engine the test releases clip by clip.
// The inline route this replaced could only be pinned by reading
// server/index.ts as text (personal-voice-bounds.test.ts); these tests run
// the real ordering, waiting, and caching rules.
import { describe, expect, it } from "vitest";

import {
  BLOCKING_RESPONSE_BUDGET_MS,
  CLIP_NOT_READY_STATUS,
  CLIP_WAIT_MS,
  LEGACY_REPLY_TOO_LONG,
  MAX_SPEAKABLE_CHARS,
  MAX_UTTERANCES,
  MAX_UTTERANCES_PROGRESSIVE,
  MessageAudio,
  PERSONAL_VOICE_NEEDS_UPDATE,
  PROGRESSIVE_RESPONSE_BUDGET_MS,
  SCRIPT_CHANGED,
  STILL_PREPARING,
  isWrittenScript,
  parseAudioRequest,
  parseClipDevice,
  type AudioMessage,
  type AudioOwner,
  type AudioRequestBody,
  type AudioRouteResult,
  type SummarizedSpeech,
} from "./message-audio.ts";
import { deterministicSpokenText } from "./speech-summary.ts";
import { toUtterances } from "./speech-text.ts";
import { karaokeScriptFromWire } from "../../shared/spoken-script.ts";
import { writtenReply } from "../../shared/voice-summary.ts";
import { DEFAULT_PRONUNCIATIONS, type Pronunciation } from "../../shared/pronunciations.ts";

class NoVoice extends Error {}

type Deferred = { text: string; voice: string | undefined; resolve: () => void; reject: (error: Error) => void };

const THREAD = "th_1";
const MESSAGE = "msg_1";

function sentences(count: number, words = "is a sentence that a voice reads aloud"): string {
  return Array.from({ length: count }, (_, i) => `Line ${i + 1} ${words}.`).join(" ");
}

function setup(options: {
  text?: string;
  voiceText?: string;
  manual?: boolean;
  defaultVoice?: string;
  credentialPending?: boolean;
  failOn?: number;
  summary?: (text: string) => string | SummarizedSpeech;
  pronunciations?: readonly Pronunciation[];
} = {}) {
  const row: AudioMessage = {
    id: MESSAGE,
    text: options.text ?? "First sentence here. Second sentence here. Third sentence here.",
    ...(options.voiceText ? { voiceText: options.voiceText } : {}),
  };
  const files = new Map<string, { bytes: Uint8Array; mime: string }>();
  const speakCalls: Array<{ text: string; voice: string | undefined }> = [];
  const pending: Deferred[] = [];
  const summarized: string[] = [];
  let saved = 0;
  let credentialPending = options.credentialPending ?? false;
  let pronunciations: readonly Pronunciation[] = options.pronunciations ?? [];

  const audio = new MessageAudio({
    message: (threadId, messageId) => (threadId === THREAD && messageId === MESSAGE ? { ...row } : undefined),
    patchMessage: (_threadId, _messageId, patch) => {
      Object.assign(row, patch);
    },
    summarize: async (_threadId, _messageId, text) => {
      summarized.push(text);
      const answer = options.summary ? options.summary(text) : text;
      return typeof answer === "string" ? { text: answer } : answer;
    },
    speak: (text, voice) => {
      speakCalls.push({ text, voice });
      const call = speakCalls.length;
      if (options.failOn === call) return Promise.reject(new Error(`engine failed on clip ${call}`));
      const bytes = new TextEncoder().encode(`${voice}|${text}`);
      if (!options.manual) return Promise.resolve({ bytes, mime: "audio/mpeg" });
      return new Promise((resolve, reject) => {
        pending.push({ text, voice, resolve: () => resolve({ bytes, mime: "audio/mpeg" }), reject });
      });
    },
    saveClip: (bytes, mime) => {
      saved += 1;
      const name = `clip-${saved}.mp3`;
      files.set(name, { bytes, mime });
      return { path: `/api/attachments/${name}`, mime };
    },
    clipExists: (clip) => files.has(clip.path.replace("/api/attachments/", "")),
    readClip: (clip) => files.get(clip.path.replace("/api/attachments/", "")) ?? null,
    defaultVoice: () => options.defaultVoice ?? "",
    pronunciations: () => pronunciations,
    credentialPending: () => credentialPending,
    isNoVoiceConfigured: (error) => error instanceof NoVoice,
  });

  /** Let the job loop run until it parks on the next manual speak. */
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const release = async (count = 1) => {
    for (let i = 0; i < count; i++) {
      await settle();
      const next = pending.shift();
      if (!next) throw new Error("no synthesis is waiting");
      next.resolve();
    }
    await settle();
  };

  return {
    audio,
    row,
    files,
    speakCalls,
    pending,
    summarized,
    release,
    settle,
    setCredentialPending: (value: boolean) => {
      credentialPending = value;
    },
    setPronunciations: (value: readonly Pronunciation[]) => {
      pronunciations = value;
    },
  };
}

const post = (fixture: ReturnType<typeof setup>, owner: AudioOwner, body: AudioRequestBody = {}, startedAt?: number) =>
  fixture.audio.post({ threadId: THREAD, messageId: MESSAGE, owner, body, ...(startedAt !== undefined ? { startedAt } : {}) });

const get = (
  fixture: ReturnType<typeof setup>,
  owner: AudioOwner,
  index: number,
  extra: { device?: string | null; ifNoneMatch?: string; waitMs?: number } = {},
) => fixture.audio.get({ threadId: THREAD, messageId: MESSAGE, owner, index, waitMs: 50, ...extra });

function clipText(result: AudioRouteResult): string {
  if (result.kind !== "clip" || !result.bytes) throw new Error(`expected a clip, got ${JSON.stringify(result)}`);
  return new TextDecoder().decode(result.bytes);
}

describe("parseAudioRequest", () => {
  it("treats a bodyless request as the legacy request", () => {
    expect(parseAudioRequest({})).toEqual({ ok: true, request: { progressive: false, spans: false } });
    expect(parseAudioRequest(undefined)).toEqual({ ok: true, request: { progressive: false, spans: false } });
  });

  it("accepts device and progressive and ignores unknown fields", () => {
    const withExtra: AudioRequestBody = JSON.parse('{"device":"iphone","progressive":true,"later":1}');
    expect(parseAudioRequest(withExtra)).toEqual({
      ok: true,
      request: { device: "iphone", progressive: true, spans: false },
    });
    expect(parseAudioRequest({ device: null, progressive: null, spans: null })).toEqual({ ok: true, request: { progressive: false, spans: false } });
    expect(parseAudioRequest({ device: "mac", progressive: true, spans: true })).toEqual({
      ok: true,
      request: { device: "mac", progressive: true, spans: true },
    });
  });

  it("rejects an unknown device, a non-boolean progressive, and a non-object body", () => {
    // Bodies arrive as parsed JSON of any shape; JSON.parse stands in for readBody.
    const wire = (text: string): AudioRequestBody => JSON.parse(text);
    expect(parseAudioRequest(wire('{"device":"ipad"}'))).toEqual({ ok: false, error: "device must be mac or iphone" });
    expect(parseAudioRequest(wire('{"progressive":"yes"}'))).toEqual({ ok: false, error: "progressive must be true or false" });
    expect(parseAudioRequest(wire('{"spans":1}'))).toEqual({ ok: false, error: "spans must be true or false" });
    expect(parseAudioRequest(wire("[1]"))).toEqual({ ok: false, error: "the audio request must be a JSON object" });
    expect(parseAudioRequest(wire('"mac"'))).toEqual({ ok: false, error: "the audio request must be a JSON object" });
  });

  it("parses the clip GET device query", () => {
    expect(parseClipDevice(null)).toEqual({ ok: true });
    expect(parseClipDevice("")).toEqual({ ok: true });
    expect(parseClipDevice("mac")).toEqual({ ok: true, device: "mac" });
    expect(parseClipDevice("watch")).toEqual({ ok: false, error: "device must be mac or iphone" });
  });
});

describe("POST /audio, legacy request (no device, not progressive)", () => {
  it("waits for every clip and answers the historical shape plus total and complete", async () => {
    const fixture = setup();
    const result = await post(fixture, { voice: "vA" });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      voiceText: fixture.row.text,
      utterances: ["First sentence here.", "Second sentence here.", "Third sentence here."],
      total: 3,
      complete: true,
      voice: "vA",
    });
    expect(result.body.audio).toHaveLength(3);
    expect(fixture.speakCalls.map((call) => call.voice)).toEqual(["vA", "vA", "vA"]);
    expect(fixture.row.audio).toHaveLength(3);
    expect(fixture.row.audioVoice).toBe("vA");
  });

  it("serves a complete reply from its stored clips without billing again", async () => {
    const fixture = setup();
    await post(fixture, { voice: "vA" });
    const again = await post(fixture, { voice: "vA" });
    expect(again.status).toBe(200);
    expect(again.body.complete).toBe(true);
    expect(fixture.speakCalls).toHaveLength(3);
  });

  it("resumes from the clips already on disk", async () => {
    const fixture = setup({ failOn: 3 });
    const failed = await post(fixture, { voice: "vA" });
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe("engine failed on clip 3");
    expect(fixture.row.audio).toHaveLength(2);
    const retried = await post(fixture, { voice: "vA" });
    expect(retried.status).toBe(200);
    expect(retried.body.audio).toHaveLength(3);
    expect(fixture.speakCalls.map((call) => call.text)).toEqual([
      "First sentence here.",
      "Second sentence here.",
      "Third sentence here.",
      "Third sentence here.",
    ]);
  });

  it("reports a missing voice engine as 409", async () => {
    const fixture = setup();
    const audio = new MessageAudio({
      message: () => ({ ...fixture.row }),
      patchMessage: () => {},
      summarize: async (_t, _m, text) => ({ text }),
      speak: () => Promise.reject(new NoVoice("Add a MiniMax key in Settings on the computer to turn on voice.")),
      saveClip: () => ({ path: "/api/attachments/x.mp3", mime: "audio/mpeg" }),
      clipExists: () => false,
      readClip: () => null,
      defaultVoice: () => "",
      credentialPending: () => false,
      isNoVoiceConfigured: (error) => error instanceof NoVoice,
    });
    const result = await audio.post({ threadId: THREAD, messageId: MESSAGE, owner: { voice: "vA" }, body: {} });
    expect(result.status).toBe(409);
  });

  it("joins a job already running instead of billing twice", async () => {
    const fixture = setup({ manual: true });
    const first = post(fixture, { voice: "vA" });
    const second = post(fixture, { voice: "vA" });
    await fixture.release(3);
    const [a, b] = await Promise.all([first, second]);
    expect(a.body.audio).toEqual(b.body.audio);
    expect(fixture.speakCalls).toHaveLength(3);
  });

  it("reads an off-mode bot's reply as written, under the historical 64-clip cap", async () => {
    // A written reply can be much longer than a distilled one, so a shipped
    // build's cap is the limit that bites.
    const off: AudioOwner = { voice: "vA", voiceSummaryMode: "off" };
    const fixture = setup({ text: sentences(MAX_UTTERANCES) });
    const fits = await post(fixture, off);
    expect(fits.status).toBe(200);
    expect(fits.body.total).toBe(MAX_UTTERANCES);
    expect(fits.body.complete).toBe(true);
    expect(fixture.summarized).toEqual([]);
    expect(fixture.row.voiceTextKind).toBe("written");

    const long = setup({ text: sentences(MAX_UTTERANCES + 1) });
    const refused = await post(long, off);
    expect(refused.status).toBe(413);
    // The shipped app shows the error text: tell the owner what fixes it.
    expect(refused.body).toMatchObject({ error: LEGACY_REPLY_TOO_LONG, total: MAX_UTTERANCES + 1, maxUtterances: MAX_UTTERANCES });
    expect(long.summarized).toEqual([]);
    expect(long.speakCalls).toHaveLength(0);
    // A current build plays the same reply.
    const progressive = await post(long, off, { progressive: true, device: "iphone" });
    expect(progressive.status).toBe(200);
    expect(progressive.body.total).toBe(MAX_UTTERANCES + 1);

    // A reply with nothing to say is not something an update fixes.
    const silent = await post(setup({ text: "---" }), off);
    expect(silent.status).toBe(413);
    expect(silent.body.error).toBe("reply exceeds voice clip limit");
  });

  it("answers within its budget while the clips are still being made, and the next tap gets them", async () => {
    const fixture = setup({ manual: true });
    // The companion gives up after 30 seconds without headers.
    expect(BLOCKING_RESPONSE_BUDGET_MS).toBeLessThan(30_000);
    const waiting = await post(fixture, { voice: "vA" }, {}, Date.now() - BLOCKING_RESPONSE_BUDGET_MS + 20);
    expect(waiting.status).toBe(CLIP_NOT_READY_STATUS);
    expect(waiting.body).toMatchObject({ error: STILL_PREPARING, retryable: true, ready: 0, total: 3 });
    expect(waiting.kind === "json" && waiting.headers?.["retry-after"]).toBe("1");

    // The job kept going after the answer.
    await fixture.release(3);
    const again = await post(fixture, { voice: "vA" });
    expect(again.status).toBe(200);
    expect(again.body.complete).toBe(true);
    expect(again.body.audio).toHaveLength(3);
    expect(fixture.speakCalls).toHaveLength(3);
  });

  it("re-synthesizes the main list when the shared voice changed", async () => {
    const fixture = setup();
    await post(fixture, { voice: "vA" });
    const changed = await post(fixture, { voice: "vC" });
    expect(changed.status).toBe(200);
    expect(fixture.row.audioVoice).toBe("vC");
    expect(fixture.speakCalls.slice(3).map((call) => call.voice)).toEqual(["vC", "vC", "vC"]);
  });
});

describe("POST /audio, progressive", () => {
  it("answers once the first clip is ready, with the plan and the clips so far", async () => {
    const fixture = setup({ manual: true });
    const pendingResponse = post(fixture, { voice: "vA" }, { progressive: true });
    await fixture.release(1);
    const result = await pendingResponse;
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ total: 3, complete: false, voice: "vA" });
    expect(result.body.audio).toHaveLength(1);
    expect(result.body.utterances).toHaveLength(3);
    await fixture.release(2);
  });

  it("answers inside the budget even when no clip is ready, counting from request arrival", async () => {
    const fixture = setup({ manual: true });
    // The summary (or a slow engine) already used the whole budget.
    const result = await post(fixture, { voice: "vA" }, { progressive: true }, Date.now() - PROGRESSIVE_RESPONSE_BUDGET_MS);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ audio: [], total: 3, complete: false });
    // Empty audio here is not on-device speech.
    expect(result.body.onDevice).toBeUndefined();
    await fixture.release(3);
  });

  it("answers immediately with everything when the reply is already complete", async () => {
    const fixture = setup();
    await post(fixture, { voice: "vA" });
    const result = await post(fixture, { voice: "vA" }, { progressive: true });
    expect(result.body).toMatchObject({ total: 3, complete: true });
    expect(result.body.audio).toHaveLength(3);
  });

  it("reports a job that fails before its first clip", async () => {
    const fixture = setup({ failOn: 1 });
    const result = await post(fixture, { voice: "vA" }, { progressive: true });
    expect(result.status).toBe(502);
  });
});

describe("GET /audio/:i", () => {
  it("answers before the phone's 20-second request timeout and the companion's 30-second deadline", () => {
    expect(CLIP_WAIT_MS).toBeLessThan(20_000);
    expect(PROGRESSIVE_RESPONSE_BUDGET_MS).toBeLessThan(30_000);
  });


  it("waits for an in-flight clip and serves it", async () => {
    const fixture = setup({ manual: true });
    const first = post(fixture, { voice: "vA" }, { progressive: true });
    await fixture.release(1);
    await first;
    const clip = get(fixture, { voice: "vA" }, 1, { waitMs: 5_000 });
    await fixture.release(1);
    const result = await clip;
    expect(result.status).toBe(200);
    expect(clipText(result)).toBe("vA|Second sentence here.");
    expect(result.kind === "clip" && result.headers).toMatchObject({ "content-type": "audio/mpeg", "cache-control": "private, no-cache" });
    await fixture.release(1);
  });

  it("answers the retryable status with Retry-After when the clip is still not ready", async () => {
    const fixture = setup({ manual: true });
    const first = post(fixture, { voice: "vA" }, { progressive: true });
    await fixture.release(1);
    await first;
    const result = await get(fixture, { voice: "vA" }, 2, { waitMs: 20 });
    expect(result.status).toBe(CLIP_NOT_READY_STATUS);
    expect(result.kind === "json" && result.headers).toMatchObject({ "retry-after": "1", "cache-control": "no-store" });
    expect(result.kind === "json" && result.body).toMatchObject({ retryable: true, ready: 1, total: 3 });
    await fixture.release(2);
  });

  it("is 404 past the end of the plan and when nothing is running", async () => {
    const fixture = setup({ manual: true });
    expect((await get(fixture, { voice: "vA" }, 0)).status).toBe(404);
    const first = post(fixture, { voice: "vA" }, { progressive: true });
    await fixture.release(1);
    await first;
    expect((await get(fixture, { voice: "vA" }, 3)).status).toBe(404);
    await fixture.release(2);
  });

  it("reports a failed job's error, and a new POST retries it", async () => {
    const fixture = setup({ failOn: 2 });
    const first = await post(fixture, { voice: "vA" }, { progressive: true });
    expect(first.status).toBe(200);
    await fixture.settle();
    const missing = await get(fixture, { voice: "vA" }, 1);
    expect(missing.status).toBe(502);
    expect(missing.kind === "json" && missing.body.error).toBe("engine failed on clip 2");
    const retried = await post(fixture, { voice: "vA" });
    expect(retried.status).toBe(200);
    expect(retried.body.audio).toHaveLength(3);
  });

  it("keeps a legacy GET reading the main list exactly as before", async () => {
    const fixture = setup();
    await post(fixture, { voice: "vA" });
    const result = await get(fixture, { voice: "vA" }, 0);
    expect(clipText(result)).toBe("vA|First sentence here.");
  });

  it("revalidates with the clip's ETag", async () => {
    const fixture = setup();
    await post(fixture, { voice: "vA" });
    const first = await get(fixture, { voice: "vA" }, 0);
    const etag = first.kind === "clip" ? first.headers.etag : "";
    expect(etag).toMatch(/^"clip-\d+\.mp3"$/);
    const again = await get(fixture, { voice: "vA" }, 0, { ifNoneMatch: etag });
    expect(again.status).toBe(304);
    expect(again.kind === "clip" && again.bytes).toBeUndefined();
  });

  it("rejects an unknown device", async () => {
    const fixture = setup();
    expect((await get(fixture, { voice: "vA" }, 0, { device: "ipad" })).status).toBe(400);
  });
});

describe("per-device voices", () => {
  const owner: AudioOwner = { voice: "vA", voices: { iphone: "vB" } };

  it("speaks the device's own voice and keeps its clips apart from the shared list", async () => {
    const fixture = setup();
    const phone = await post(fixture, owner, { device: "iphone" });
    expect(phone.body.voice).toBe("vB");
    expect(fixture.speakCalls.map((call) => call.voice)).toEqual(["vB", "vB", "vB"]);
    expect(fixture.row.audio).toBeUndefined();
    expect(fixture.row.audioByVoice?.vB).toHaveLength(3);

    const legacy = await post(fixture, owner);
    expect(legacy.body.voice).toBe("vA");
    expect(fixture.row.audio).toHaveLength(3);
    expect(fixture.row.audioByVoice?.vB).toHaveLength(3);

    expect(clipText(await get(fixture, owner, 0, { device: "iphone" }))).toBe("vB|First sentence here.");
    expect(clipText(await get(fixture, owner, 0))).toBe("vA|First sentence here.");
    expect(clipText(await get(fixture, owner, 0, { device: "mac" }))).toBe("vA|First sentence here.");
  });

  it("shares the clips when a device has no override (no double billing)", async () => {
    const fixture = setup();
    await post(fixture, owner);
    const mac = await post(fixture, owner, { device: "mac" });
    expect(mac.body).toMatchObject({ voice: "vA", complete: true });
    expect(fixture.speakCalls).toHaveLength(3);
  });

  it("runs different voices side by side, so one device never waits on the other's whole reply", async () => {
    const fixture = setup({ manual: true });
    const shared = post(fixture, owner);
    const phone = post(fixture, owner, { device: "iphone" });
    await fixture.settle();
    // Both jobs start at once.  The iPhone's first clip does not queue
    // behind every clip of the Mac's voice.
    expect(fixture.speakCalls.map((call) => call.voice).sort()).toEqual(["vA", "vB"]);
    const firstPhone = fixture.pending.findIndex((call) => call.voice === "vB");
    fixture.pending.splice(firstPhone, 1)[0]!.resolve();
    await fixture.settle();
    expect(fixture.row.audioByVoice?.vB).toHaveLength(1);
    expect(fixture.row.audio ?? []).toHaveLength(0);
    expect(clipText(await get(fixture, owner, 0, { device: "iphone" }))).toBe("vB|First sentence here.");

    // Each job writes only its own list; neither loses the other's clips.
    while (fixture.pending.length) await fixture.release(1);
    await Promise.all([shared, phone]);
    expect(fixture.row.audio).toHaveLength(3);
    expect(fixture.row.audioVoice).toBe("vA");
    expect(fixture.row.audioByVoice?.vB).toHaveLength(3);
    expect(fixture.speakCalls).toHaveLength(6);
  });

  it("still joins the running job for the same voice instead of billing twice", async () => {
    const fixture = setup({ manual: true });
    const first = post(fixture, owner, { device: "iphone", progressive: true });
    const second = post(fixture, owner, { device: "iphone" });
    await fixture.release(3);
    await Promise.all([first, second]);
    expect(fixture.speakCalls.map((call) => call.voice)).toEqual(["vB", "vB", "vB"]);
  });
});

describe("which voice owns the main clip list", () => {
  it("finishes a partial main list for a device voice once, not on every play", async () => {
    // The shared voice was V and the reply got two of four clips (a
    // mid-reply engine error).  The iPhone then chose Workspace default,
    // which moved the shared voice to "" (the default W) and pinned the
    // Mac to V.
    const fixture = setup({ text: sentences(4), failOn: 3 });
    const before: AudioOwner = { voice: "vV" };
    const failed = await post(fixture, before);
    expect(failed.status).toBe(502);
    expect(fixture.row.audio).toHaveLength(2);
    expect(fixture.row.audioVoice).toBe("vV");

    const after: AudioOwner = { voice: "", voices: { mac: "vV" } };
    const setupDefault = setup({ text: sentences(4), defaultVoice: "vW" });
    Object.assign(setupDefault.row, fixture.row);
    for (const [name, file] of fixture.files) setupDefault.files.set(name, file);

    const first = await post(setupDefault, after, { device: "mac" });
    expect(first.status).toBe(200);
    expect(first.body.audio).toHaveLength(4);
    expect(setupDefault.speakCalls).toHaveLength(2);
    for (let play = 0; play < 2; play++) {
      const again = await post(setupDefault, after, { device: "mac" });
      expect(again.body).toMatchObject({ complete: true, voice: "vV" });
    }
    // Two clips billed in all, then none: not 2, 4, 6.
    expect(setupDefault.speakCalls).toHaveLength(2);
    // Every clip of the plan is served, not just the first two.
    expect(clipText(await get(setupDefault, after, 3, { device: "mac" }))).toBe("vV|Line 4 is a sentence that a voice reads aloud.");
  });

  it("serves a no-device GET the owner voice's clips while the main list holds another voice", async () => {
    const fixture = setup({ defaultVoice: "vW" });
    // V was the shared voice and the iPhone had W of its own.
    const before: AudioOwner = { voice: "vV", voices: { iphone: "vW" } };
    await post(fixture, before);
    await post(fixture, before, { device: "iphone" });
    expect(fixture.row.audioVoice).toBe("vV");
    expect(fixture.row.audioByVoice?.vW).toHaveLength(3);

    // The shared voice is now the default W, and the Mac kept V.  A shipped
    // app (no device) is served W's stored clips, and its index GETs must
    // read the same list rather than V's clips from the main list.
    const after: AudioOwner = { voice: "", voices: { mac: "vV", iphone: "vW" } };
    const legacy = await post(fixture, after);
    expect(legacy.body).toMatchObject({ voice: "vW", complete: true });
    expect(clipText(await get(fixture, after, 0))).toBe("vW|First sentence here.");
    expect(clipText(await get(fixture, after, 0, { device: "mac" }))).toBe("vV|First sentence here.");
    expect(fixture.speakCalls).toHaveLength(6);
  });

  it("moves another voice's main list aside when the owner's voice takes it back", async () => {
    const fixture = setup();
    await post(fixture, { voice: "vA" });
    await post(fixture, { voice: "vC" });
    expect(fixture.row.audioVoice).toBe("vC");
    expect(fixture.row.audioByVoice?.vA).toHaveLength(3);
    // A device still on vA plays its clips without paying for them again.
    const mac = await post(fixture, { voice: "vC", voices: { mac: "vA" } }, { device: "mac" });
    expect(mac.body).toMatchObject({ voice: "vA", complete: true });
    expect(fixture.speakCalls).toHaveLength(6);
  });
});

describe("Personal Voice", () => {
  it("returns on-device speech before the hosted-voice credential check", async () => {
    const fixture = setup({ credentialPending: true });
    const owner: AudioOwner = { voice: "English_Graceful_Lady", voices: { mac: "personal:mac-voice" } };
    const mac = await post(fixture, owner, { device: "mac", progressive: true });
    expect(mac.status).toBe(200);
    expect(mac.body).toMatchObject({
      audio: [],
      onDevice: true,
      personalVoice: true,
      voice: "personal:mac-voice",
      total: 3,
      complete: true,
      voiceText: "First sentence here. Second sentence here. Third sentence here.",
    });
    const phone = await post(fixture, owner, { device: "iphone" });
    expect(phone.status).toBe(409);
    expect(phone.body.error).toBe("Voice synthesis is waiting for its encrypted credential");
    expect(fixture.speakCalls).toHaveLength(0);
  });

  it("keeps the legacy shared Personal Voice on-device too", async () => {
    const fixture = setup({ credentialPending: true });
    const result = await post(fixture, { voice: "apple-personal:shared" });
    expect(result.body).toMatchObject({ onDevice: true, voice: "apple-personal:shared" });
  });

  it("treats a Personal Voice workspace default as on-device for a client that names its device", async () => {
    const fixture = setup({ defaultVoice: "personal:default" });
    const result = await post(fixture, { voice: "" }, { device: "iphone", progressive: true });
    expect(result.body).toMatchObject({ onDevice: true, voice: "personal:default" });
    expect(fixture.speakCalls).toHaveLength(0);
  });

  it("tells a shipped app (no device) to update instead of an empty success it cannot play", async () => {
    const fixture = setup({ defaultVoice: "personal:default" });
    const result = await post(fixture, { voice: "" });
    expect(result.status).toBe(409);
    expect(result.body.error).toBe(PERSONAL_VOICE_NEEDS_UPDATE);
    expect(fixture.speakCalls).toHaveLength(0);
  });

  it("is still bounded by the clip limit", async () => {
    const fixture = setup({ text: sentences(MAX_UTTERANCES + 6) });
    const result = await post(fixture, { voice: "personal:x" });
    expect(result.status).toBe(413);
  });
});

describe("limits", () => {
  it("bounds the projected speech, not the raw reply", async () => {
    // A huge fenced block speaks as "a code block", so this reply is short.
    const code = "```ts\n" + "const value = 1;\n".repeat(1_500) + "```";
    expect(code.length).toBeGreaterThan(MAX_SPEAKABLE_CHARS);
    const fixture = setup({ text: `Here is the change. ${code} That is all.` });
    const result = await post(fixture, { voice: "vA", voiceSummaryMode: "off" });
    expect(result.status).toBe(200);
    expect(result.body.utterances).toHaveLength(2);
  });

  it("refuses projected speech over the character cap for every voice", async () => {
    const long = sentences(140, "is a sentence padded so that the projected speech grows long enough to pass the character cap");
    expect(long.length).toBeGreaterThan(MAX_SPEAKABLE_CHARS);
    const fixture = setup({ text: long });
    for (const owner of [{ voice: "vA" }, { voice: "personal:x" }]) {
      const result = await post(fixture, owner, { progressive: true });
      expect(result.status).toBe(413);
      expect(result.body).toMatchObject({ error: "reply exceeds voice clip limit", maxCharacters: MAX_SPEAKABLE_CHARS });
    }
  });

  it("allows more utterances for a progressive request than for a legacy one", async () => {
    const fixture = setup({ text: sentences(100, "is short") });
    const legacy = await post(fixture, { voice: "personal:x" });
    expect(legacy.status).toBe(413);
    expect(legacy.body.maxUtterances).toBe(MAX_UTTERANCES);
    const progressive = await post(fixture, { voice: "personal:x" }, { progressive: true });
    expect(progressive.status).toBe(200);
    expect(progressive.body.total).toBe(100);

    const tooMany = setup({ text: sentences(MAX_UTTERANCES_PROGRESSIVE + 5, "is short") });
    const refused = await post(tooMany, { voice: "personal:x" }, { progressive: true });
    expect(refused.status).toBe(413);
    expect(refused.body.maxUtterances).toBe(MAX_UTTERANCES_PROGRESSIVE);
  });
});

describe("speech text", () => {
  it("summarizes a reply with no stored speech text", async () => {
    const fixture = setup({ summary: () => "A short spoken version." });
    const result = await post(fixture, { voice: "personal:x", voiceSummaryMode: "always" });
    expect(fixture.summarized).toHaveLength(1);
    expect(result.body.utterances).toEqual(["A short spoken version."]);
  });

  it("uses stored speech text before summarizing", async () => {
    const fixture = setup({ voiceText: "Stored speech text." });
    const result = await post(fixture, { voice: "personal:x", voiceSummaryMode: "always" });
    expect(fixture.summarized).toHaveLength(0);
    expect(result.body.utterances).toEqual(["Stored speech text."]);
  });

  it("speaks the written answer when summaries are off", async () => {
    const fixture = setup({
      text: "[voice_summary]\nShort.\n[/voice_summary]\n[written_answer]\nThe full written answer here.\n[/written_answer]",
      voiceText: "Ignored stored text.",
    });
    const result = await post(fixture, { voice: "personal:x", voiceSummaryMode: "off" });
    expect(result.body.utterances).toEqual(["The full written answer here."]);
  });
});

describe("the spoken script: distilled by default (owner correction, 2026-10-08)", () => {
  const REPLY = [
    "The deploy finished.  Here is what changed:",
    "",
    "- Bumped the API timeout to 3.5 seconds",
    "- Fixed issue #749 in the webhook retry loop",
    "",
    "```sh",
    "pnpm test --filter server",
    "```",
    "",
    "Details are in [the rollout doc](https://example.com/docs/rollout.md).",
  ].join("\n");
  const DISTILLED =
    "The deploy finished. Here is what changed. <#0.3#> First, the A P I timeout was bumped to three point five seconds. " +
    "<#0.3#> Next, issue seven four nine in the webhook retry loop was fixed. The details are in the rollout doc.";

  it("distills an unset-mode reply for a voice bot and a text-only bot, and speaks the distilled text", async () => {
    for (const owner of [{ voice: "vA", speakReplies: true }, { voice: "vA", speechDevices: ["iphone"] }, { voice: "vA" }]) {
      const fixture = setup({ text: REPLY, summary: () => DISTILLED });
      const result = await post(fixture, owner, { device: "mac", progressive: true, spans: true });
      expect(result.status).toBe(200);
      expect(fixture.summarized).toEqual([REPLY]);
      const expected = toUtterances(DISTILLED);
      expect(result.body.utterances).toEqual(expected);
      expect(result.body.voiceText).toBe(DISTILLED);
      await fixture.settle();
      // MiniMax gets the distilled words, pause tags and all.
      expect(fixture.speakCalls.map((call) => call.text)).toEqual(expected);
      expect(fixture.speakCalls.some((call) => call.text.includes("<#0.3#>"))).toBe(true);
      expect(fixture.speakCalls.some((call) => call.text.includes("seven four nine"))).toBe(true);
      expect(result.body.script).toBe("summary");
      expect(result.body).not.toHaveProperty("spans");
      expect(fixture.row.voiceTextKind).toBe("summary");
      expect(fixture.row.voiceText).toBe(DISTILLED);
    }
  });

  it("gives Personal Voice the distilled utterances, without the MiniMax pause tags", async () => {
    for (const device of ["mac", "iphone"] as const) {
      const fixture = setup({ text: REPLY, summary: () => DISTILLED });
      const result = await post(fixture, { voice: "personal:x" }, { device, progressive: true, spans: true });
      expect(result.status).toBe(200);
      expect(result.body.onDevice).toBe(true);
      expect(fixture.summarized).toHaveLength(1);
      expect(fixture.speakCalls).toHaveLength(0);
      const utterances = result.body.utterances ?? [];
      expect(utterances.join(" ")).not.toContain("<#");
      expect(utterances.join(" ")).toContain("three point five seconds");
      expect(result.body.voiceText).toBe(utterances.join(" "));
      expect(result.body.total).toBe(utterances.length);
      expect(result.body.script).toBe("summary");
    }
  });

  it("labels the distiller's deterministic fallback as written, with spans for karaoke", async () => {
    // No key, a timeout, or a cut-off rewrite: the stand-in is the
    // span-aligned deterministic script (speech-summary.ts).
    const fixture = setup({ text: REPLY, summary: (text) => deterministicSpokenText(text) });
    const result = await post(fixture, { voice: "vA", speakReplies: true }, { device: "mac", progressive: true, spans: true });
    expect(fixture.summarized).toHaveLength(1);
    expect(result.body.script).toBe("written");
    expect(result.body.spans).toMatchObject({ format: 1, source: "written", sourceLength: writtenReply(REPLY).length });
    expect(result.body.utterances).toEqual(toUtterances(writtenReply(REPLY)));
    // The clips stay stamped as the distiller path's, so the mode is unchanged.
    expect(fixture.row.voiceTextKind).toBe("summary");
    const script = karaokeScriptFromWire(result.body.utterances ?? [], result.body.spans);
    expect(script.segments.length).toBeGreaterThan(0);
  });

  it("reuses distilled text stored before karaoke, with its clips, without asking again or billing", async () => {
    // A row from before #952: voiceText is the distilled rewrite and there
    // is no voiceTextKind.
    const fixture = setup({ text: REPLY, voiceText: DISTILLED, summary: () => "Should not be asked." });
    const stored = toUtterances(DISTILLED);
    fixture.row.audio = stored.map((_, i) => {
      fixture.files.set(`old-${i}.mp3`, { bytes: new Uint8Array([i]), mime: "audio/mpeg" });
      return { path: `/api/attachments/old-${i}.mp3`, mime: "audio/mpeg" };
    });
    const clips = [...fixture.row.audio];
    for (const body of [{}, { device: "mac" as const, progressive: true, spans: true }]) {
      const result = await post(fixture, { voice: "vA", speakReplies: true }, body);
      expect(result.status).toBe(200);
      expect(result.body.utterances).toEqual(stored);
      expect(result.body.audio).toEqual(clips);
    }
    expect(fixture.summarized).toEqual([]);
    expect(fixture.speakCalls).toEqual([]);
    expect(fixture.row.audio).toEqual(clips);

    // Personal Voice reads the same stored text, minus the pause tags.
    const phone = await post(fixture, { voice: "personal:x" }, { device: "iphone", progressive: true, spans: true });
    expect(fixture.summarized).toEqual([]);
    expect(phone.body.utterances?.join(" ")).toBe(stored.join(" ").replace(/ ?<#0\.3#> ?/g, " ").replace(/ {2,}/g, " "));
    expect(phone.body.script).toBe("summary");
  });

  it("distills a reply #952 read as written, replacing its word-for-word clips", async () => {
    // Played while #952 made the written script the default: stamped
    // "written".  The owner wants the distilled reading, so it is made once.
    const written = toUtterances(writtenReply(REPLY));
    const fixture = setup({ text: REPLY, summary: () => DISTILLED });
    fixture.row.voiceText = written.join(" ");
    fixture.row.voiceTextKind = "written";
    fixture.row.audio = written.map((_, i) => {
      fixture.files.set(`w-${i}.mp3`, { bytes: new Uint8Array([i]), mime: "audio/mpeg" });
      return { path: `/api/attachments/w-${i}.mp3`, mime: "audio/mpeg" };
    });
    const result = await post(fixture, { voice: "vA", speakReplies: true });
    expect(fixture.summarized).toHaveLength(1);
    expect(result.body.utterances).toEqual(toUtterances(DISTILLED));
    expect(fixture.speakCalls.map((call) => call.text)).toEqual(toUtterances(DISTILLED));
    expect(result.body.audio?.some((clip) => clip.path.startsWith("/api/attachments/w-"))).toBe(false);
    expect(fixture.row.voiceTextKind).toBe("summary");
    // And the next play is served from the distilled clips.
    const calls = fixture.speakCalls.length;
    await post(fixture, { voice: "vA", speakReplies: true });
    expect(fixture.speakCalls).toHaveLength(calls);
  });
});

describe("the distiller's stand-in and clips of the same text", () => {
  const REPLY = [
    "The deploy finished.  Here is what changed:",
    "",
    "- Bumped the API timeout to 3.5 seconds",
    "- Fixed issue #749 in the webhook retry loop",
    "",
    "Details are in [the rollout doc](https://example.com/docs/rollout.md).",
  ].join("\n");
  const DISTILLED = "The deploy finished. First, the A P I timeout is now three point five seconds. Next, issue seven four nine is fixed.";
  const OWNER: AudioOwner = { voice: "vA", speakReplies: true };
  const withWrittenClips = (fixture: ReturnType<typeof setup>) => {
    const written = toUtterances(deterministicSpokenText(REPLY));
    fixture.row.voiceText = deterministicSpokenText(REPLY);
    fixture.row.voiceTextKind = "written";
    fixture.row.audio = written.map((_, i) => {
      fixture.files.set(`w-${i}.mp3`, { bytes: new Uint8Array([i]), mime: "audio/mpeg" });
      return { path: `/api/attachments/w-${i}.mp3`, mime: "audio/mpeg" };
    });
    return [...fixture.row.audio];
  };

  it("recognizes the reply as written however it was reached", () => {
    expect(isWrittenScript(REPLY, deterministicSpokenText(REPLY))).toBe(true);
    expect(isWrittenScript(REPLY, DISTILLED)).toBe(false);
  });

  it("asks the distiller again after a passing failure, and reuses the stand-in's clips while it is down", async () => {
    let down = true;
    const fixture = setup({
      text: REPLY,
      summary: (text) => (down ? { text: deterministicSpokenText(text), retry: true } : DISTILLED),
    });
    const standIn = toUtterances(deterministicSpokenText(REPLY));
    const first = await post(fixture, OWNER, { device: "mac", progressive: true, spans: true });
    await fixture.settle();
    expect(first.body.utterances).toEqual(standIn);
    expect(fixture.speakCalls).toHaveLength(standIn.length);
    // Stamped as the reply as written, not kept as the distilled script.
    expect(fixture.row.voiceTextKind).toBe("written");

    // Still down: asked again, and the same text is served from its clips.
    const second = await post(fixture, OWNER);
    expect(fixture.summarized).toHaveLength(2);
    expect(fixture.speakCalls).toHaveLength(standIn.length);
    expect(second.body.audio).toEqual(fixture.row.audio);

    // Back up: the rewrite replaces the stand-in, and is kept from then on.
    down = false;
    const third = await post(fixture, OWNER);
    expect(fixture.summarized).toHaveLength(3);
    expect(third.body.utterances).toEqual(toUtterances(DISTILLED));
    expect(fixture.speakCalls.slice(standIn.length).map((call) => call.text)).toEqual(toUtterances(DISTILLED));
    expect(fixture.row.voiceTextKind).toBe("summary");
    expect(fixture.row.voiceText).toBe(DISTILLED);
    const calls = fixture.speakCalls.length;
    await post(fixture, OWNER);
    expect(fixture.summarized).toHaveLength(3);
    expect(fixture.speakCalls).toHaveLength(calls);
  });

  it("keeps the clips of a reply read as written when the distiller settles on the very same text", async () => {
    // Played while #952 made the written script the default, then the
    // distiller skips it (a short plain reply) or has no key: the same text.
    const fixture = setup({ text: REPLY, summary: (text) => deterministicSpokenText(text) });
    const clips = withWrittenClips(fixture);
    for (const device of ["mac", "iphone"] as const) {
      const result = await post(fixture, OWNER, { device, progressive: true, spans: true });
      expect(result.status).toBe(200);
      expect(result.body.audio).toEqual(clips);
      expect(result.body.script).toBe("written");
    }
    expect(fixture.speakCalls).toEqual([]);
    expect(fixture.row.audio).toEqual(clips);
    // Settled as the distilled script, so it is not asked for again.
    expect(fixture.row.voiceTextKind).toBe("summary");
    expect(fixture.summarized).toHaveLength(1);
  });

  it("keeps those clips through a passing failure too", async () => {
    const fixture = setup({ text: REPLY, summary: (text) => ({ text: deterministicSpokenText(text), retry: true }) });
    const clips = withWrittenClips(fixture);
    const result = await post(fixture, OWNER);
    expect(result.body.audio).toEqual(clips);
    expect(fixture.speakCalls).toEqual([]);
    expect(fixture.row.voiceTextKind).toBe("written");
  });
});

describe("the spoken script: as written in off mode, span-aligned for karaoke", () => {
  const OFF: AudioOwner = { voice: "vA", voiceSummaryMode: "off" };
  const MARKDOWN = [
    "The build number is **749** and the tests pass.",
    "",
    "```ts",
    "const answer = 42;",
    "```",
    "",
    "See [the guide](https://example.com/guide) for more.",
  ].join("\n");

  it("reads the reply as written and never asks the distiller", async () => {
    const fixture = setup({ text: MARKDOWN, summary: () => "Seven four nine.  A paraphrase." });
    const result = await post(fixture, OFF);
    expect(result.status).toBe(200);
    expect(fixture.summarized).toHaveLength(0);
    const expected = toUtterances(writtenReply(MARKDOWN));
    expect(result.body.utterances).toEqual(expected);
    expect(fixture.speakCalls.map((call) => call.text)).toEqual(expected);
    // The stored stamp says these clips speak exactly this script.
    expect(fixture.row.voiceText).toBe(expected.join(" "));
    expect(fixture.row.voiceTextKind).toBe("written");
  });

  it("answers exactly as before unless the client asks for spans", async () => {
    const fixture = setup({ text: MARKDOWN });
    const plain = await post(fixture, { voice: "vA" }, { device: "mac", progressive: true });
    expect(plain.body).not.toHaveProperty("script");
    expect(plain.body).not.toHaveProperty("spans");
    const onDevice = await post(fixture, { voice: "personal:x" }, { device: "mac", progressive: true });
    expect(onDevice.body).not.toHaveProperty("spans");
  });

  it("carries per-utterance spans into the written reply, for hosted and on-device voices", async () => {
    const source = writtenReply(MARKDOWN);
    for (const owner of [OFF, { voice: "personal:x", voiceSummaryMode: "off" as const }]) {
      const fixture = setup({ text: MARKDOWN });
      const result = await post(fixture, owner, { device: "mac", progressive: true, spans: true });
      expect(result.status).toBe(200);
      expect(result.body.script).toBe("written");
      const spans = result.body.spans;
      expect(spans).toMatchObject({ format: 1, source: "written", sourceLength: source.length });
      expect(spans?.utterances).toHaveLength(result.body.utterances?.length ?? -1);
      const script = karaokeScriptFromWire(result.body.utterances ?? [], spans);
      expect(script.sourceLength).toBe(source.length);
      expect(script.segments.length).toBeGreaterThan(0);
      // Every copied span is the message text itself, character for character.
      for (const seg of script.segments) {
        if (seg.kind === "copy") {
          expect(script.spokenText.slice(seg.spokenStart, seg.spokenEnd)).toBe(source.slice(seg.srcStart, seg.srcEnd));
        }
      }
      // "749" is spoken as written, not spelled out.
      expect(script.spokenText).toContain("749");
    }
  });

  it("speaks the distilled script for a summary mode, and carries no spans for it", async () => {
    const fixture = setup({ text: MARKDOWN, summary: () => "A short spoken version." });
    const result = await post(fixture, { voice: "vA", voiceSummaryMode: "on_demand" }, { device: "mac", progressive: true, spans: true });
    expect(fixture.summarized).toHaveLength(1);
    expect(result.body.utterances).toEqual(["A short spoken version."]);
    expect(result.body.script).toBe("summary");
    expect(result.body).not.toHaveProperty("spans");
    expect(fixture.row.voiceTextKind).toBe("summary");
  });

  it("does not take a written script for a summary", async () => {
    const fixture = setup({ text: MARKDOWN, summary: () => "A short spoken version." });
    await post(fixture, OFF);
    expect(fixture.row.voiceTextKind).toBe("written");
    const summary = await post(fixture, { voice: "vA", voiceSummaryMode: "always" });
    expect(fixture.summarized).toHaveLength(1);
    expect(summary.body.utterances).toEqual(["A short spoken version."]);
    // The summary's clips replaced the written ones; none were reused.
    expect(fixture.speakCalls.at(-1)?.text).toBe("A short spoken version.");
    expect(summary.body.audio).toHaveLength(1);
  });

  it("drops a summary's clips when the written script is spoken, and the other way round", async () => {
    const fixture = setup({ summary: () => "A short spoken version." });
    await post(fixture, { voice: "vA", voiceSummaryMode: "always" });
    expect(fixture.speakCalls).toHaveLength(1);
    const written = await post(fixture, OFF, { spans: true });
    expect(written.body.script).toBe("written");
    expect(written.body.utterances).toEqual(["First sentence here.", "Second sentence here.", "Third sentence here."]);
    expect(fixture.speakCalls).toHaveLength(4);
    // Played again: served from the stored written clips, nothing billed.
    await post(fixture, OFF);
    expect(fixture.speakCalls).toHaveLength(4);
  });

  it("serves a complete set of clips from before the stamp as it was made, without spans or billing", async () => {
    const fixture = setup({ text: MARKDOWN, voiceText: "Seven four nine is the build. That is all for now." });
    const legacy = toUtterances("Seven four nine is the build. That is all for now.");
    fixture.row.audio = legacy.map((_, i) => {
      fixture.files.set(`old-${i}.mp3`, { bytes: new Uint8Array([i]), mime: "audio/mpeg" });
      return { path: `/api/attachments/old-${i}.mp3`, mime: "audio/mpeg" };
    });
    const result = await post(fixture, OFF, { device: "mac", progressive: true, spans: true });
    expect(result.status).toBe(200);
    expect(result.body.utterances).toEqual(legacy);
    expect(result.body.audio).toEqual(fixture.row.audio);
    expect(result.body.script).toBe("summary");
    expect(result.body).not.toHaveProperty("spans");
    expect(fixture.speakCalls).toHaveLength(0);
  });

  it("stamps a set from before the stamp that already speaks the written script", async () => {
    const fixture = setup({ voiceText: "First sentence here. Second sentence here. Third sentence here." });
    fixture.row.audio = [0, 1, 2].map((i) => {
      fixture.files.set(`old-${i}.mp3`, { bytes: new Uint8Array([i]), mime: "audio/mpeg" });
      return { path: `/api/attachments/old-${i}.mp3`, mime: "audio/mpeg" };
    });
    const result = await post(fixture, OFF, { spans: true });
    expect(result.body.script).toBe("written");
    expect(result.body.spans?.utterances).toHaveLength(3);
    expect(fixture.speakCalls).toHaveLength(0);
    expect(fixture.row.voiceTextKind).toBe("written");
  });

  it("re-synthesizes an unfinished set from before the stamp, dropping every voice's old clips", async () => {
    const fixture = setup({ voiceText: "A paraphrase one. A paraphrase two." });
    fixture.files.set("old-0.mp3", { bytes: new Uint8Array([0]), mime: "audio/mpeg" });
    fixture.files.set("side-0.mp3", { bytes: new Uint8Array([1]), mime: "audio/mpeg" });
    fixture.row.audio = [{ path: "/api/attachments/old-0.mp3", mime: "audio/mpeg" }];
    fixture.row.audioByVoice = { vB: [{ path: "/api/attachments/side-0.mp3", mime: "audio/mpeg" }] };
    const result = await post(fixture, OFF, { spans: true });
    expect(result.body.script).toBe("written");
    expect(fixture.speakCalls.map((call) => call.text)).toEqual(["First sentence here.", "Second sentence here.", "Third sentence here."]);
    expect(result.body.audio?.map((clip) => clip.path)).not.toContain("/api/attachments/old-0.mp3");
    expect(fixture.row.audioByVoice).toBeUndefined();
  });

  it("fails the waiters of a job whose script was replaced mid-way instead of answering short", async () => {
    const fixture = setup({ manual: true, summary: () => "A short spoken version that is long enough." });
    const summary = post(fixture, { voice: "vA", voiceSummaryMode: "always" });
    await fixture.settle();
    const written = post(fixture, OFF);
    await fixture.settle();
    await fixture.release(1);
    const failed = await summary;
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe(SCRIPT_CHANGED);
    await fixture.release(3);
    const done = await written;
    expect(done.status).toBe(200);
    expect(done.body.audio).toHaveLength(3);
    expect(fixture.row.audio).toHaveLength(3);
    expect(fixture.row.voiceTextKind).toBe("written");
  });

  it("stops another voice's job once the reply's script changed, so it cannot stamp the old script back", async () => {
    const fixture = setup({ manual: true, summary: () => "A short spoken version of the reply." });
    // The Mac speaks the bot's own voice (the main list); the iPhone has its own.
    const owner: AudioOwner = { voice: "vA", voices: { iphone: "vB" }, voiceSummaryMode: "off" };
    const resolveFor = async (voice: string, text?: string) => {
      await fixture.settle();
      const at = fixture.pending.findIndex((call) => call.voice === voice && (text === undefined || call.text === text));
      if (at < 0) throw new Error(`no synthesis is waiting for ${voice}`);
      fixture.pending.splice(at, 1)[0].resolve();
      await fixture.settle();
    };

    const mac = post(fixture, owner, { progressive: true, device: "mac" });
    const phone = post(fixture, owner, { progressive: true, device: "iphone" });
    await resolveFor("vA");
    await resolveFor("vB");
    await Promise.all([mac, phone]);
    expect(fixture.row.voiceTextKind).toBe("written");

    // The owner picks All Messages, and the iPhone plays the reply.
    const summaryOwner: AudioOwner = { ...owner, voiceSummaryMode: "always" };
    const phoneAgain = post(fixture, summaryOwner, { progressive: true, device: "iphone" });
    await fixture.settle();
    expect(fixture.row.voiceTextKind).toBe("summary");
    expect(fixture.row.audio).toBeUndefined();

    // The Mac's written job finishes its second clip.  It must not write.
    const billedBefore = fixture.speakCalls.length;
    await resolveFor("vA");
    expect(fixture.row.voiceTextKind).toBe("summary");
    expect(fixture.row.voiceText).toBe("A short spoken version of the reply.");
    expect(fixture.row.audio).toBeUndefined();
    // ...and it bills nothing more.
    expect(fixture.speakCalls.filter((call, i) => i >= billedBefore && call.voice === "vA")).toEqual([]);

    await resolveFor("vB", "A short spoken version of the reply.");
    const done = await phoneAgain;
    expect(done.status).toBe(200);
    expect(done.body.complete).toBe(true);
    // The finished summary clips are this script's: the next play is free.
    const calls = fixture.speakCalls.length;
    const replay = await post(fixture, summaryOwner, { progressive: true, device: "iphone" });
    expect(replay.body.complete).toBe(true);
    expect(fixture.speakCalls).toHaveLength(calls);
  });
});

describe("the pronunciation list (shared/pronunciations.ts)", () => {
  const REPLY = "Run the **SQL** migration, then check `cron`.\n\nUse OAuth for the GUI.";

  it("hands an on-device voice the written script respelled, with spans still on the original terms", async () => {
    const fixture = setup({ text: REPLY, pronunciations: DEFAULT_PRONUNCIATIONS });
    const result = await post(fixture, { voice: "personal:x", voiceSummaryMode: "off" }, { device: "iphone", progressive: true, spans: true });
    expect(result.body.onDevice).toBe(true);
    expect(result.body.utterances).toEqual(["Run the sequel migration, then check kron.", "Use oh auth for the gooey."]);
    expect(result.body.voiceText).toBe("Run the sequel migration, then check kron. Use oh auth for the gooey.");
    expect(result.body.script).toBe("written");
    const source = writtenReply(REPLY);
    const script = karaokeScriptFromWire(result.body.utterances ?? [], result.body.spans);
    expect(script.sourceLength).toBe(source.length);
    const spoken = script.spokenText;
    const at = (word: string) => script.segments.find((seg) => spoken.slice(seg.spokenStart, seg.spokenEnd) === word);
    expect(source.slice(at("sequel")!.srcStart, at("sequel")!.srcEnd)).toBe("SQL");
    expect(source.slice(at("oh auth")!.srcStart, at("oh auth")!.srcEnd)).toBe("OAuth");
    expect(source.slice(at("gooey")!.srcStart, at("gooey")!.srcEnd)).toBe("GUI");
    // Nothing about the stored row changed.
    expect(fixture.row.voiceText).toBeUndefined();
  });

  it("respells a distilled on-device script after taking the pause tags out", async () => {
    const fixture = setup({
      text: REPLY,
      summary: () => "Run the SQL migration. <#0.3#> Then check cron and OAuth.",
      pronunciations: DEFAULT_PRONUNCIATIONS,
    });
    const result = await post(fixture, { voice: "personal:x", voiceSummaryMode: "always" }, { device: "mac", progressive: true, spans: true });
    expect(result.body.utterances?.join(" ")).toBe("Run the sequel migration. Then check kron and oh auth.");
    expect(result.body.script).toBe("summary");
    // The stored script is the distiller's, as it was written.
    expect(fixture.row.voiceText).toBeUndefined();
  });

  it("never puts the list in a hosted script or its cache, so a list edit re-bills nothing", async () => {
    const fixture = setup({ text: REPLY, pronunciations: DEFAULT_PRONUNCIATIONS });
    const owner: AudioOwner = { voice: "vA", voiceSummaryMode: "off" };
    const first = await post(fixture, owner, { device: "mac", progressive: true, spans: true });
    await fixture.settle();
    const plain = toUtterances(writtenReply(REPLY));
    // The engine-side pass (server/tts/index.ts speak) respells; the job
    // hands it the script as stored.
    expect(first.body.utterances).toEqual(plain);
    expect(fixture.speakCalls.map((call) => call.text)).toEqual(plain);
    expect(fixture.row.voiceText).toBe(plain.join(" "));
    const clips = [...(fixture.row.audio ?? [])];
    expect(clips).toHaveLength(plain.length);

    fixture.setPronunciations([{ term: "SQL", say: "S Q L" }]);
    const again = await post(fixture, owner, { device: "mac", progressive: true, spans: true });
    expect(again.body.audio).toEqual(clips);
    expect(fixture.speakCalls).toHaveLength(plain.length);
    expect(fixture.row.audio).toEqual(clips);
  });
});
