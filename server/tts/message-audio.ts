// Message-linked speech: POST /api/threads/:t/messages/:m/audio and the
// per-clip GET /api/threads/:t/messages/:m/audio/:i.
//
// The route used to live inline in server/index.ts and synthesize every clip
// before it sent a single header.  A phone reaches the harness only through
// the companion sidecar, which gives up after 30 seconds without response
// headers (companion/src/proxy.ts HEADERS_TIMEOUT_MS), so any reply long
// enough to need more than 30 seconds of serial synthesis failed on iOS with
// a 504.  It lives here now so the ordering and timing rules below can be
// tested against fakes instead of a spawned harness.
//
// Rules this file keeps:
// - The clip bound runs before the Personal Voice early return, so an
//   on-device voice cannot reach the helper with an unbounded reply
//   (personal-voice-bounds.test.ts).
// - The Personal Voice early return runs before the hosted-voice credential
//   check, so a Personal-Voice-only setup never needs a MiniMax key.
// - Synthesis is one detached job per message and voice.  It outlives the
//   request, saves each clip as it lands, and is joined (never duplicated) by
//   a second device asking for the same voice, so a reply is billed once.
//   Jobs for different voices run side by side: each write re-reads the row
//   and patches it in the same tick, and each voice writes only its own list.
// - One rule says which voice owns the main `audio` list (mainVoice), and
//   every read and write of a voice's clips goes through it.  Reading one
//   list and writing another re-bills the missing clips on every play.
// - A request without `device` or `progressive` behaves exactly as the route
//   always has, because shipped TestFlight builds send neither.
// - What the voice reads (shared/voice-summary.ts voiceScriptKind): by default
//   the reply as written, through the deterministic speakable pass, with the
//   source span of every spoken character (shared/speech-spans.ts).  A model
//   summary is spoken only when the bot's Voice Summary mode was picked
//   explicitly (board 8cc3c806: the speech pass may not paraphrase).
// - `message.voiceText` plus `voiceTextKind` say which script the stored
//   clips were made from.  Clips are only ever served with the utterances
//   they were made from: a different script resets the message's clip lists
//   before synthesis, and a complete set from before this field existed is
//   served as it was made (no spans, no karaoke) instead of being billed
//   again.
// - `spans: true` in the request adds `script` and, for a written script,
//   `spans` (shared/spoken-script.ts) to the answer.  Without it the answer is
//   byte-for-byte what it was, so shipped clients are unaffected.
import { z } from "zod";

import { isPersonalVoiceId, isSpeechDevice, SPEECH_DEVICES, voiceForDevice, type BotVoices, type SpeechDevice } from "../../shared/bot-voice.ts";
import { utterancesWithSpans } from "../../shared/speech-spans.ts";
import { encodeSpokenSpans, type SpokenScriptKind, type SpokenSpansWire } from "../../shared/spoken-script.ts";
import { voiceScriptKind, writtenReply, type VoiceSummaryMode } from "../../shared/voice-summary.ts";
import { toUtterances } from "./speech-text.ts";

export type VoiceClip = { path: string; mime: string };

/** The projected (speakable) text one reply may send to a voice.  MiniMax
 * bills per character, so this is the cost guard. */
export const MAX_SPEAKABLE_CHARS = 12_000;
/** Utterances for a request that waits for every clip (old clients).  Kept at
 * the historical value so their behavior does not change. */
export const MAX_UTTERANCES = 64;
/** Utterances for a progressive request.  First audio no longer waits on the
 * whole reply, so the count only bounds request volume: at a typical 75 to 90
 * characters a sentence, 160 utterances is 12,000 to 14,400 characters, so the
 * character cap above binds first for ordinary prose and this one only stops
 * pathological fragmenting. */
export const MAX_UTTERANCES_PROGRESSIVE = 160;
/** A progressive POST answers within this long of arriving, ready clip or
 * not.  The summary await counts against it, and it stays well inside the
 * companion's 30-second headers deadline. */
export const PROGRESSIVE_RESPONSE_BUDGET_MS = 20_000;
/** How long a clip GET waits for an in-flight clip before answering
 * CLIP_NOT_READY_STATUS.  Under the iOS client's default 20-second request
 * timeout (CompanionClient.makeRequest) as well as the companion's 30, so the
 * phone hears the retryable answer instead of timing out first. */
export const CLIP_WAIT_MS = 15_000;
/** Neither 2xx (a client would play the JSON as audio) nor 5xx (iOS reports
 * every 5xx to Sentry, and this is normal polling).  425 Too Early: the clip
 * exists in the plan but not yet on disk. */
export const CLIP_NOT_READY_STATUS = 425;
export const CLIP_RETRY_AFTER_SECONDS = 1;
/** A failed job is remembered this long so clip GETs can report its error
 * instead of a bare 404.  A new POST replaces it immediately. */
export const FAILED_JOB_TTL_MS = 60_000;
/** A request with no `device` (a shipped app) for a bot whose voice is a
 * Personal Voice only through the workspace default. */
export const PERSONAL_VOICE_NEEDS_UPDATE =
  "Update BotFleet on this device to read replies with the workspace's Personal Voice.";
/** A job whose script was replaced while it ran (the bot's Voice Summary
 * mode changed); its waiters hear this instead of a short clip list. */
export const SCRIPT_CHANGED = "This reply's spoken text changed while it was being prepared.\u00A0 Play it again.";
/** Per-voice clip lists kept on one message besides the owner's own. */
export const MAX_EXTRA_VOICE_SLOTS = 4;

const SUPPORTED_MIME = new Set(["audio/mpeg", "audio/wav"]);

export interface AudioOwner {
  voice?: string;
  voices?: BotVoices;
  voiceSummaryMode?: VoiceSummaryMode;
  speakReplies?: boolean;
  speechDevices?: string[];
}

export interface AudioMessage {
  id: string;
  text?: string;
  voiceText?: string;
  /** What voiceText is (shared/spoken-script.ts SpokenScriptKind); absent on
   * rows from before karaoke. */
  voiceTextKind?: SpokenScriptKind;
  audio?: VoiceClip[];
  audioVoice?: string;
  audioByVoice?: Record<string, VoiceClip[]>;
}

export interface MessageAudioDeps {
  /** A fresh read of the stored message. */
  message(threadId: string, messageId: string): AudioMessage | undefined;
  patchMessage(threadId: string, messageId: string, patch: Partial<AudioMessage>): void;
  /** The speech text for a reply that has none stored yet (voiceSummaryFor). */
  summarize(threadId: string, messageId: string, text: string): Promise<string>;
  speak(text: string, voice: string | undefined): Promise<{ bytes: Uint8Array; mime: string }>;
  saveClip(bytes: Uint8Array, mime: string): VoiceClip;
  clipExists(clip: VoiceClip): boolean;
  readClip(clip: VoiceClip): { bytes: Uint8Array; mime: string } | null;
  /** cfg.tts.voice: what an empty bot voice means. */
  defaultVoice(): string;
  /** A hosted-voice key is saved but has not reached the harness yet. */
  credentialPending(): boolean;
  /** tts.NoVoiceConfigured, which the route reports as 409, not 502. */
  isNoVoiceConfigured(error: Error): boolean;
  now?(): number;
}

/** Every field either JSON answer can carry; see the POST and GET below. */
export type AudioResponseBody = {
  error?: string;
  audio?: VoiceClip[];
  voiceText?: string;
  utterances?: string[];
  total?: number;
  complete?: boolean;
  voice?: string;
  onDevice?: boolean;
  personalVoice?: boolean;
  retryable?: boolean;
  ready?: number;
  maxUtterances?: number;
  maxCharacters?: number;
  /** Only with `spans: true`: what the voice reads.  "written" is span-aligned
   * to the message (karaoke applies); "summary" is not. */
  script?: SpokenScriptKind;
  /** Only with `spans: true` and a written script. */
  spans?: SpokenSpansWire;
};

export type AudioJsonResult = { kind: "json"; status: number; body: AudioResponseBody; headers?: Record<string, string> };
export type AudioClipResult = { kind: "clip"; status: 200 | 304; headers: Record<string, string>; bytes?: Uint8Array };
export type AudioRouteResult = AudioJsonResult | AudioClipResult;

export type AudioRequest = { device?: SpeechDevice; progressive: boolean; spans: boolean };

/** Body of the POST.  Both fields are optional; unknown fields are ignored so
 * a newer client can add one without breaking an older harness. */
const AudioRequestSchema = z.object(
  {
    device: z.enum(SPEECH_DEVICES, { error: "device must be mac or iphone" }).nullish(),
    progressive: z.boolean({ error: "progressive must be true or false" }).nullish(),
    spans: z.boolean({ error: "spans must be true or false" }).nullish(),
  },
  { error: "the audio request must be a JSON object" },
);

export type AudioRequestBody = z.input<typeof AudioRequestSchema>;

export function parseAudioRequest(body: AudioRequestBody | null | undefined): { ok: true; request: AudioRequest } | { ok: false; error: string } {
  if (body === undefined || body === null) return { ok: true, request: { progressive: false, spans: false } };
  const parsed = AudioRequestSchema.safeParse(body);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid audio request" };
  const request: AudioRequest = { progressive: parsed.data.progressive === true, spans: parsed.data.spans === true };
  if (parsed.data.device) request.device = parsed.data.device;
  return { ok: true, request };
}

/** `?device=` on the clip GET.  Absent means the legacy owner voice. */
export function parseClipDevice(value: string | null | undefined): { ok: true; device?: SpeechDevice } | { ok: false; error: string } {
  if (value === null || value === undefined || value === "") return { ok: true };
  return isSpeechDevice(value) ? { ok: true, device: value } : { ok: false, error: "device must be mac or iphone" };
}

interface ClipJob {
  voice: string;
  utterances: string[];
  voiceText: string;
  voiceTextKind: SpokenScriptKind;
  clips: VoiceClip[];
  settled: boolean;
  error?: Error;
  listeners: Set<() => void>;
  done: Promise<VoiceClip[]>;
}

function attachmentName(clip: VoiceClip): string | null {
  return clip.path.match(/^\/api\/attachments\/([\w.-]+)$/)?.[1] ?? null;
}

/** Keep the newest MAX_EXTRA_VOICE_SLOTS entries (insertion order). */
function boundSlots(map: Record<string, VoiceClip[]>): Record<string, VoiceClip[]> {
  const keys = Object.keys(map);
  while (keys.length > MAX_EXTRA_VOICE_SLOTS) delete map[keys.shift()!];
  return map;
}

export class MessageAudio {
  private readonly jobs = new Map<string, ClipJob>();
  private readonly deps: MessageAudioDeps;

  constructor(deps: MessageAudioDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** An empty voice means the workspace default; resolve it so the cache key
   * and the Personal Voice check see the voice that will actually speak. */
  private effective(voice: string | undefined | null): string {
    return voice || this.deps.defaultVoice() || "";
  }

  private ownerVoice(owner: AudioOwner): string {
    return this.effective(owner.voice);
  }

  /** The voice the main `audio` list holds: `audioVoice`, or the owner's
   * voice on rows older than that field.  The one ownership rule for both
   * reading (slotClips) and writing (slotPatch). */
  private mainVoice(message: AudioMessage | undefined, ownerVoice: string): string {
    return message?.audioVoice ?? ownerVoice;
  }

  /** The clips stored for `voice`: the main list when it holds that voice,
   * otherwise the voice's entry in the side map. */
  private slotClips(message: AudioMessage, voice: string, ownerVoice: string): VoiceClip[] | undefined {
    if (this.mainVoice(message, ownerVoice) === voice) return message.audio;
    return message.audioByVoice?.[voice];
  }

  /** Where clips for `voice` are written: wherever slotClips reads them.
   * The owner's own voice also takes the main list back from another voice,
   * because clients that send no device read only that list; the voice it
   * held moves to the side map, so its device does not pay for it again. */
  private slotPatch(message: AudioMessage | undefined, voice: string, ownerVoice: string, clips: VoiceClip[]): Partial<AudioMessage> {
    const main = this.mainVoice(message, ownerVoice);
    if (main === voice) return { audio: [...clips], audioVoice: voice };
    const map = { ...message?.audioByVoice };
    const put = (key: string, list: VoiceClip[]) => {
      delete map[key];
      map[key] = [...list];
    };
    if (voice !== ownerVoice) {
      put(voice, clips);
      return { audioByVoice: boundSlots(map) };
    }
    delete map[voice];
    if (message?.audio?.length) put(main, message.audio);
    return { audio: [...clips], audioVoice: voice, audioByVoice: boundSlots(map) };
  }

  private notify(job: ClipJob): void {
    // A listener may delete itself; deleting the entry being visited is safe
    // while iterating a Set.
    for (const listener of job.listeners) listener();
  }

  private waitFor(job: ClipJob, ready: (job: ClipJob) => boolean, ms: number): Promise<void> {
    if (ready(job) || job.settled || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      // No timer for an unbounded wait: setTimeout treats Infinity as 1 ms.
      const timer = Number.isFinite(ms) ? setTimeout(() => finish(), ms) : undefined;
      timer?.unref?.();
      const finish = () => {
        if (timer) clearTimeout(timer);
        job.listeners.delete(check);
        resolve();
      };
      const check = () => {
        if (ready(job) || job.settled) finish();
      };
      job.listeners.add(check);
    });
  }

  private failure(error: Error): AudioJsonResult {
    return { kind: "json", status: this.deps.isNoVoiceConfigured(error) ? 409 : 502, body: { error: error.message } };
  }

  /** Resolves once the job has finished, either way. */
  private settled(job: ClipJob): Promise<void> {
    return this.waitFor(job, () => false, Number.POSITIVE_INFINITY);
  }

  /** Whether the message's stored clips were made from this script. */
  private ownsClips(message: AudioMessage, voiceText: string, kind: SpokenScriptKind): boolean {
    if (message.voiceTextKind) return message.voiceTextKind === kind && message.voiceText === voiceText;
    // A row from before voiceTextKind: its clips belong to whatever voiceText
    // it holds, as they always have, and only a summary may keep them.
    return kind === "summary" && (!message.voiceText || message.voiceText === voiceText);
  }

  /** Start the job for (message, voice), or return the one already running.
   * A failed job is replaced: asking again is how a client retries.  So is a
   * job for another script (the bot's Voice Summary mode changed mid-way); the
   * old one stops at its next clip without writing. */
  private ensureJob(
    threadId: string,
    messageId: string,
    voice: string,
    ownerVoice: string,
    utterances: string[],
    voiceText: string,
    voiceTextKind: SpokenScriptKind,
  ): ClipJob {
    const key = `${threadId}:${messageId}:${voice}`;
    const running = this.jobs.get(key);
    if (running && !running.error && running.voiceText === voiceText) return running;

    const job: ClipJob = {
      voice,
      utterances,
      voiceText,
      voiceTextKind,
      clips: [],
      settled: false,
      listeners: new Set(),
      done: Promise.resolve([]),
    };
    const current = () => this.jobs.get(key) === job;
    const stamp = { voiceText, voiceTextKind };
    // Registered before the body runs: the body checks current() each clip.
    this.jobs.set(key, job);
    job.done = (async () => {
      let message = this.deps.message(threadId, messageId);
      if (!message) throw new Error("The reply is no longer available.");
      if (!this.ownsClips(message, voiceText, voiceTextKind)) {
        // The stored clips (every voice's) speak another script.  Drop them
        // so no list ever pairs old audio with these utterances.
        this.deps.patchMessage(threadId, messageId, { audio: undefined, audioVoice: undefined, audioByVoice: undefined, ...stamp });
        message = this.deps.message(threadId, messageId) ?? message;
      }
      const kept: VoiceClip[] = [];
      for (const clip of this.slotClips(message, voice, ownerVoice) ?? []) {
        if (kept.length >= utterances.length || !this.deps.clipExists(clip)) break;
        kept.push(clip);
      }
      job.clips = kept;
      this.deps.patchMessage(threadId, messageId, { ...this.slotPatch(message, voice, ownerVoice, kept), ...stamp });
      this.notify(job);
      for (const utterance of utterances.slice(kept.length)) {
        if (!current()) throw new Error(SCRIPT_CHANGED);
        const audio = await this.deps.speak(utterance, voice || undefined);
        if (!current()) throw new Error(SCRIPT_CHANGED);
        if (!SUPPORTED_MIME.has(audio.mime)) throw new Error("The voice engine returned an unsupported audio format.");
        const saved = this.deps.saveClip(audio.bytes, audio.mime);
        job.clips = [...job.clips, saved];
        this.deps.patchMessage(threadId, messageId, {
          ...this.slotPatch(this.deps.message(threadId, messageId), voice, ownerVoice, job.clips),
          ...stamp,
        });
        this.notify(job);
      }
      return job.clips;
    })();

    job.done.then(
      () => {
        job.settled = true;
        if (this.jobs.get(key) === job) this.jobs.delete(key);
        this.notify(job);
      },
      (reason) => {
        job.settled = true;
        job.error = reason instanceof Error ? reason : new Error(String(reason));
        this.notify(job);
        const timer = setTimeout(() => {
          if (this.jobs.get(key) === job) this.jobs.delete(key);
        }, FAILED_JOB_TTL_MS);
        timer.unref?.();
      },
    );
    return job;
  }

  async post(input: {
    threadId: string;
    messageId: string;
    owner: AudioOwner;
    body: AudioRequestBody | null | undefined;
    /** When the request arrived; the progressive budget counts from here. */
    startedAt?: number;
  }): Promise<AudioJsonResult> {
    const startedAt = input.startedAt ?? this.now();
    const parsed = parseAudioRequest(input.body);
    if (!parsed.ok) return { kind: "json", status: 400, body: { error: parsed.error } };
    const { device, progressive, spans } = parsed.request;
    const { threadId, messageId, owner } = input;
    const message = this.deps.message(threadId, messageId);
    if (!message?.text?.trim()) return { kind: "json", status: 404, body: { error: "no such reply" } };

    const ownerVoice = this.ownerVoice(owner);
    // Shipped clients send no device: they keep the shared voice.
    const voice = this.effective(device ? voiceForDevice(owner, device) : owner.voice);

    // What the voice reads.  Written: the reply itself, span-aligned, the same
    // string every time.  Summary: a model rewrite, kept once made.
    const kind = voiceScriptKind(owner);
    let utterances: string[];
    let textToSpeak: string;
    let spansWire: SpokenSpansWire | undefined;
    if (kind === "written") {
      const source = writtenReply(message.text);
      const spoken = utterancesWithSpans(source);
      utterances = spoken.map((u) => u.text);
      textToSpeak = utterances.join(" ");
      if (spans) spansWire = encodeSpokenSpans(source, spoken);
    } else {
      // A written-mode script is not a summary; summarize instead of reusing it.
      textToSpeak = message.voiceText && message.voiceTextKind !== "written"
        ? message.voiceText
        : await this.deps.summarize(threadId, messageId, message.text);
      utterances = toUtterances(textToSpeak);
    }
    /** `script` and `spans`, only for a client that asked. */
    const extra = (script: SpokenScriptKind = kind): Partial<AudioResponseBody> =>
      spans ? { script, ...(script === "written" && spansWire ? { spans: spansWire } : {}) } : {};

    const spoken = utterances.join(" ");
    const maxUtterances = progressive ? MAX_UTTERANCES_PROGRESSIVE : MAX_UTTERANCES;
    // The bound is on the projected speech, not the raw reply: a long fenced
    // block becomes "a code block" and must not push a short spoken reply
    // over the limit.  It runs before the Personal Voice return on purpose.
    if (!utterances.length || utterances.length > maxUtterances || spoken.length > MAX_SPEAKABLE_CHARS) {
      return {
        kind: "json",
        status: 413,
        body: { error: "reply exceeds voice clip limit", total: utterances.length, maxUtterances, maxCharacters: MAX_SPEAKABLE_CHARS },
      };
    }

    if (isPersonalVoiceId(voice)) {
      // Shipped clients send no device and read only `audio`.  They speak a
      // bot whose own voice is a Personal Voice without asking, so the one
      // they can reach here came from the workspace default, and an empty
      // success would leave them silent with no error.
      if (!device && !isPersonalVoiceId(owner.voice)) {
        return { kind: "json", status: 409, body: { error: PERSONAL_VOICE_NEEDS_UPDATE } };
      }
      return {
        kind: "json",
        status: 200,
        body: { audio: [], voiceText: spoken, utterances, total: utterances.length, complete: true, onDevice: true, personalVoice: true, voice, ...extra() },
      };
    }

    if (this.deps.credentialPending()) {
      return { kind: "json", status: 409, body: { error: "Voice synthesis is waiting for its encrypted credential" } };
    }

    const cached = this.slotClips(message, voice, ownerVoice);
    const complete = (list: VoiceClip[] | undefined, count: number): list is VoiceClip[] =>
      list?.length === count && list.every((clip) => this.deps.clipExists(clip));
    if (this.ownsClips(message, textToSpeak, kind) && complete(cached, utterances.length)) {
      return {
        kind: "json",
        status: 200,
        body: { audio: cached, voiceText: textToSpeak, utterances, total: utterances.length, complete: true, voice, ...extra() },
      };
    }
    if (kind === "written" && !message.voiceTextKind) {
      // Clips made before voiceTextKind existed, from whatever the row's
      // voiceText was then (often a model paraphrase).  A complete set is
      // served as it was made rather than billed again; it simply has no
      // karaoke.  When it turns out to be this very script, it is stamped.
      const legacy = toUtterances(message.voiceText ?? writtenReply(message.text));
      if (legacy.length && complete(cached, legacy.length)) {
        if (legacy.length === utterances.length && legacy.every((text, i) => text === utterances[i])) {
          this.deps.patchMessage(threadId, messageId, { voiceText: textToSpeak, voiceTextKind: kind });
          return {
            kind: "json",
            status: 200,
            body: { audio: cached, voiceText: textToSpeak, utterances, total: utterances.length, complete: true, voice, ...extra() },
          };
        }
        return {
          kind: "json",
          status: 200,
          body: {
            audio: cached,
            voiceText: message.voiceText ?? legacy.join(" "),
            utterances: legacy,
            total: legacy.length,
            complete: true,
            voice,
            ...extra("summary"),
          },
        };
      }
    }

    const job = this.ensureJob(threadId, messageId, voice, ownerVoice, utterances, textToSpeak, kind);
    if (!progressive) {
      await this.settled(job);
      if (job.error) return this.failure(job.error);
      return {
        kind: "json",
        status: 200,
        body: { audio: [...job.clips], voiceText: job.voiceText, utterances: job.utterances, total: job.utterances.length, complete: true, voice, ...extra() },
      };
    }

    const remaining = startedAt + PROGRESSIVE_RESPONSE_BUDGET_MS - this.now();
    await this.waitFor(job, (current) => current.clips.length > 0, remaining);
    if (job.error && job.clips.length === 0) return this.failure(job.error);
    const total = job.utterances.length;
    return {
      kind: "json",
      status: 200,
      body: {
        audio: [...job.clips],
        voiceText: job.voiceText,
        utterances: job.utterances,
        total,
        complete: job.clips.length === total,
        voice,
        ...extra(),
      },
    };
  }

  private serveClip(clip: VoiceClip, ifNoneMatch: string | undefined): AudioClipResult | null {
    const name = attachmentName(clip);
    if (!name) return null;
    const audio = this.deps.readClip(clip);
    if (!audio || !SUPPORTED_MIME.has(audio.mime)) return null;
    // The same URL can name a different clip later (a device's voice
    // changed), so clients revalidate instead of caching for a year.
    const etag = `"${name}"`;
    const headers = { "cache-control": "private, no-cache", etag, "x-content-type-options": "nosniff" };
    if (ifNoneMatch && ifNoneMatch.split(",").some((tag) => tag.trim() === etag)) {
      return { kind: "clip", status: 304, headers };
    }
    return {
      kind: "clip",
      status: 200,
      headers: { ...headers, "content-type": audio.mime, "content-length": String(audio.bytes.byteLength) },
      bytes: audio.bytes,
    };
  }

  async get(input: {
    threadId: string;
    messageId: string;
    owner: AudioOwner;
    index: number;
    /** The raw `?device=` value. */
    device?: string | null;
    ifNoneMatch?: string;
    /** Test seam; production uses CLIP_WAIT_MS. */
    waitMs?: number;
  }): Promise<AudioRouteResult> {
    const parsedDevice = parseClipDevice(input.device);
    if (!parsedDevice.ok) return { kind: "json", status: 400, body: { error: parsedDevice.error } };
    const { threadId, messageId, owner, index } = input;
    const notFound: AudioJsonResult = { kind: "json", status: 404, body: { error: "no such voice clip" } };
    const message = this.deps.message(threadId, messageId);
    if (!message || !Number.isSafeInteger(index) || index < 0) return notFound;

    const ownerVoice = this.ownerVoice(owner);
    const device = parsedDevice.device;
    const voice = this.effective(device ? voiceForDevice(owner, device) : owner.voice);
    // No device is the legacy request, which means the owner's voice.  It
    // reads through the same rule as the POST that planned it, so its index
    // GETs never get another voice's clips from the main list.
    const stored = this.slotClips(message, voice, ownerVoice);
    const storedClip = stored?.[index];
    if (storedClip) {
      const served = this.serveClip(storedClip, input.ifNoneMatch);
      if (served) return served;
    }

    const job = this.jobs.get(`${threadId}:${messageId}:${voice}`);
    if (!job) return notFound;
    const total = job.utterances.length;
    if (index >= total) return notFound;
    if (!job.settled && job.clips.length <= index) {
      await this.waitFor(job, (current) => current.clips.length > index, input.waitMs ?? CLIP_WAIT_MS);
    }
    const ready = job.clips[index];
    if (ready) {
      const served = this.serveClip(ready, input.ifNoneMatch);
      if (served) return served;
    }
    if (job.error) return this.failure(job.error);
    if (job.settled) return notFound;
    return {
      kind: "json",
      status: CLIP_NOT_READY_STATUS,
      body: { error: "This voice clip is still being prepared.", retryable: true, ready: job.clips.length, total },
      headers: { "retry-after": String(CLIP_RETRY_AFTER_SECONDS), "cache-control": "no-store" },
    };
  }
}
