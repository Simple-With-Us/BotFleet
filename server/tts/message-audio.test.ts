// The message-linked speech route against fakes: a fake store row, a fake
// attachment directory, and a voice engine the test releases clip by clip.
// The inline route this replaced could only be pinned by reading
// server/index.ts as text (personal-voice-bounds.test.ts); these tests run
// the real ordering, waiting, and caching rules.
import { describe, expect, it } from "vitest";

import {
  CLIP_NOT_READY_STATUS,
  MAX_SPEAKABLE_CHARS,
  MAX_UTTERANCES,
  MAX_UTTERANCES_PROGRESSIVE,
  MessageAudio,
  PROGRESSIVE_RESPONSE_BUDGET_MS,
  parseAudioRequest,
  parseClipDevice,
  type AudioMessage,
  type AudioOwner,
  type AudioRouteResult,
} from "./message-audio.ts";

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
  summary?: (text: string) => string;
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

  const audio = new MessageAudio({
    message: (threadId, messageId) => (threadId === THREAD && messageId === MESSAGE ? { ...row } : undefined),
    patchMessage: (_threadId, _messageId, patch) => {
      Object.assign(row, patch);
    },
    summarize: async (_threadId, _messageId, text) => {
      summarized.push(text);
      return options.summary ? options.summary(text) : text;
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
  };
}

const post = (fixture: ReturnType<typeof setup>, owner: AudioOwner, body: unknown = {}, startedAt?: number) =>
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
    expect(parseAudioRequest({})).toEqual({ ok: true, request: { progressive: false } });
    expect(parseAudioRequest(undefined)).toEqual({ ok: true, request: { progressive: false } });
  });

  it("accepts device and progressive and ignores unknown fields", () => {
    expect(parseAudioRequest({ device: "iphone", progressive: true, later: 1 })).toEqual({
      ok: true,
      request: { device: "iphone", progressive: true },
    });
    expect(parseAudioRequest({ device: null, progressive: null })).toEqual({ ok: true, request: { progressive: false } });
  });

  it("rejects an unknown device, a non-boolean progressive, and a non-object body", () => {
    expect(parseAudioRequest({ device: "ipad" })).toEqual({ ok: false, error: "device must be mac or iphone" });
    expect(parseAudioRequest({ progressive: "yes" })).toEqual({ ok: false, error: "progressive must be true or false" });
    expect(parseAudioRequest([1])).toMatchObject({ ok: false });
    expect(parseAudioRequest("mac")).toMatchObject({ ok: false });
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
      summarize: async (_t, _m, text) => text,
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

  it("runs one voice at a time on a message", async () => {
    const fixture = setup({ manual: true });
    const shared = post(fixture, owner);
    const phone = post(fixture, owner, { device: "iphone" });
    await fixture.settle();
    expect(fixture.speakCalls.map((call) => call.voice)).toEqual(["vA"]);
    await fixture.release(3);
    await shared;
    expect(fixture.speakCalls.map((call) => call.voice)).toEqual(["vA", "vA", "vA", "vB"]);
    await fixture.release(3);
    await phone;
    expect(fixture.row.audio).toHaveLength(3);
    expect(fixture.row.audioByVoice?.vB).toHaveLength(3);
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

  it("treats a Personal Voice workspace default as on-device", async () => {
    const fixture = setup({ defaultVoice: "personal:default" });
    const result = await post(fixture, { voice: "" });
    expect(result.body).toMatchObject({ onDevice: true, voice: "personal:default" });
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
