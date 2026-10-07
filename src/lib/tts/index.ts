import { spokenReply } from "../../../shared/voice-summary";
import { isPersonalVoiceId, type SpeechDevice } from "../../../shared/bot-voice";
// The harness's own projection rules (pure, no Node APIs), so a reply this
// Mac speaks without the harness drops code, links, and markdown the same way.
import { toUtterances } from "../../../server/tts/speech-text";
import { z } from "zod";
import { TtsAudioBodySchema, type TtsAudioBody } from "./schema";
// The speaker — one voice for the whole window.
//
// Deliberately a singleton: two bots talking over each other is never what
// anyone wants, so starting a new utterance cancels whatever was speaking.
// That single rule is also what makes interrupting work — call mode just
// calls stop().
//
// Audio comes from the harness, which holds the MiniMax key.  The renderer
// never sees it, and never talks to MiniMax directly.
//
// Text is split into utterances by the harness too, next to the transform
// that produced it — it is the piece most likely to be tuned against real
// transcripts, and keeping it in one place is the same reasoning as the
// server-computed approval key.
//
// A saved reply always goes through the message audio route, for either
// engine.  The harness resolves this Mac's voice (`device: "mac"`), applies
// the voice summary and the speakable pass, and answers one of two ways:
// - an Apple Personal Voice: `onDevice: true` with the projected utterances,
//   which this Mac's speech helper speaks;
// - a hosted voice: the clips ready so far plus `total` (`progressive`), so
//   the first sentence plays while the rest are still being made.

/** The desktop app is the "mac" device in a bot's per-device voices. */
export const THIS_DEVICE: SpeechDevice = "mac";

export type SpeechStatus = "idle" | "preparing" | "speaking";

export interface SpeechSnapshot {
  status: SpeechStatus;
  /** what is being spoken, so the UI can show a stop button in the right place */
  botId?: string;
  messageId?: string;
  /** the utterance currently audible — call mode shows it as a caption */
  caption?: string;
  /** full voice summary text for distilled read-along */
  voiceText?: string;
  /** zero-based index of the currently spoken word within caption/voiceText */
  wordIndex?: number;
  /** Why the last speak failed.  It keeps `botId` and `messageId`, so the
   * message's own Play button can show the reason. */
  error?: string;
}

interface SpeakOptions {
  /** The voice this Mac uses for the bot: voiceForDevice(bot, "mac"). */
  voiceId?: string;
  botId?: string;
  messageId?: string;
  threadId?: string;
}

export interface SpeakerOptions {
  /** Waits between polls of a clip that is still being made.  A seam so
   * tests do not sleep for real; it must reject when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

type TtsPrepareBody = { ready?: boolean; utterances?: string[]; error?: string };
type Live = () => boolean;

const IDLE: SpeechSnapshot = { status: "idle" };

/** One helper call speaks this much text.  Each call spawns the speech
 * helper once, so a reply is sent as a few paragraph-sized calls rather than
 * one per sentence, and stop still lands between them. */
export const PERSONAL_VOICE_GROUP_CHARS = 600;

/** The harness answers 425 for a clip that is still being made, after it has
 * already waited up to 15 seconds for it. */
const CLIP_NOT_READY = 425;
/** Polls of one clip before giving up: about 15 seconds of server wait plus
 * the Retry-After each, so roughly three minutes. */
const CLIP_NOT_READY_ATTEMPTS = 12;
const DEFAULT_RETRY_MS = 1_000;

export const PERSONAL_VOICE_UNSUPPORTED = "Apple Personal Voice speaks on authorized Apple devices (macOS / iOS).";
export const PERSONAL_VOICE_NOT_ON_THIS_MAC =
  "This bot's Personal Voice is not on this Mac.\u00A0 Pick a voice for this Mac in the bot's Voice settings.";
export const PERSONAL_VOICE_NOT_AUTHORIZED =
  "Personal Voice is not authorized on this Mac.\u00A0 Allow it in System Settings under Accessibility, Personal Voice, or pick another voice for this Mac.";
export const REPLY_TOO_LONG = "This reply is too long to read aloud.";

/** The harness's spoken-character cap (MAX_SPEAKABLE_CHARS in
 * server/tts/message-audio.ts).  A reply this Mac projects for itself is
 * held to the same bound, so a harness that cannot answer does not turn
 * into an unbounded run of speech-helper calls. */
export const MAX_LOCAL_SPEECH_CHARS = 12_000;

/** A non-2xx answer from the message audio route, with its status, so the
 * caller can tell the harness refusing (4xx) from the harness failing. */
export class AudioRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AudioRequestError";
    this.status = status;
  }
}

/** The harness could not be asked: the request never got an answer, or the
 * answer was a server failure.  A 4xx (413 too long, 404, 409) is the
 * harness deciding, and is shown rather than worked around. */
function harnessUnavailable(error: unknown): boolean {
  if (error instanceof AudioRequestError) return error.status >= 500;
  return !(error instanceof DOMException && error.name === "AbortError");
}

/** Pack sentences (or paragraphs) into helper-call-sized groups, in order.
 * A single part longer than `max` is its own group; the helper chunks it. */
export function groupForPersonalVoice(parts: string[], max = PERSONAL_VOICE_GROUP_CHARS): string[] {
  const groups: string[] = [];
  let current = "";
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (current && current.length + 1 + part.length > max) {
      groups.push(current);
      current = part;
    } else {
      current = current ? `${current} ${part}` : part;
    }
  }
  if (current) groups.push(current);
  return groups;
}

/** The speech helper reports failures as short codes, and Electron wraps
 * them ("Error invoking remote method …: Error: voice-not-found").  Turn the
 * two a person can act on into a sentence. */
export function personalVoiceErrorMessage(message: string): string {
  if (message.includes("voice-not-found")) return PERSONAL_VOICE_NOT_ON_THIS_MAC;
  if (message.includes("personal-voice-not-authorized")) return PERSONAL_VOICE_NOT_AUTHORIZED;
  return message;
}

function paragraphs(text: string): string[] {
  return text.split(/\n\s*\n/);
}

/** `{ error }`, the harness's failure body on every voice route. */
const ErrorBodySchema = z.object({ error: z.string().trim().min(1) });

/** The harness's own sentence for a failed response, when it sent one. */
async function responseError(response: Response): Promise<string | undefined> {
  const parsed = ErrorBodySchema.safeParse(await response.json().catch(() => ({})));
  return parsed.success ? parsed.data.error : undefined;
}

function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  if (!header || !Number.isFinite(seconds) || seconds < 0) return DEFAULT_RETRY_MS;
  return Math.min(5_000, Math.max(250, seconds * 1_000));
}

function abortError(): Error {
  return new DOMException("The speech request was stopped.", "AbortError");
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function personalVoiceBridge(): NonNullable<NonNullable<Window["ogb"]>["personalVoice"]> | null {
  if (typeof window === "undefined") return null;
  const bridge = window.ogb?.personalVoice;
  return bridge?.speak ? bridge : null;
}

export class Speaker {
  private snapshot: SpeechSnapshot = IDLE;
  private watchers = new Set<(s: SpeechSnapshot) => void>();
  /** bumped on every speak()/stop(); async work whose token is stale exits */
  private token = 0;
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private settlePlayback: ((finished: boolean) => void) | null = null;
  private request: AbortController | null = null;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(options: SpeakerOptions = {}) {
    this.sleep = options.sleep ?? abortableSleep;
  }

  subscribe(fn: (s: SpeechSnapshot) => void): () => void {
    this.watchers.add(fn);
    fn(this.snapshot);
    return () => this.watchers.delete(fn);
  }

  get state(): SpeechSnapshot {
    return this.snapshot;
  }

  private set(next: SpeechSnapshot) {
    this.snapshot = next;
    for (const watcher of [...this.watchers]) watcher(next);
  }

  /** True while this exact message is the one being spoken. */
  isSpeaking(messageId?: string): boolean {
    if (this.snapshot.status === "idle") return false;
    return messageId ? this.snapshot.messageId === messageId : true;
  }

  stop() {
    this.token += 1;
    this.request?.abort();
    this.request = null;
    if (typeof window !== "undefined") {
      void window.ogb?.personalVoice?.stop?.();
    }
    // Pausing/removing an <audio> source does not reliably fire `ended` or
    // `error`. Resolve the play promise ourselves so every interrupted
    // speak() settles and call mode cannot leak a forever-pending task.
    if (this.settlePlayback) this.settlePlayback(false);
    else this.teardownAudio();
    if (this.snapshot.status !== "idle" || this.snapshot.error) this.set(IDLE);
  }

  private teardownAudio() {
    if (this.audio) {
      this.audio.pause();
      this.audio.ontimeupdate = null;
      this.audio.src = "";
      this.audio = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  /**
   * Speak a message. Resolves when it finishes, is interrupted, or fails —
   * never rejects, because a voice failing is a thing to show, not a thing
   * that should take a caller's turn down with it.
   */
  async speak(text: string, opts: SpeakOptions = {}): Promise<void> {
    this.stop();
    const mine = this.token;
    const controller = new AbortController();
    this.request = controller;
    const live = () => this.token === mine && !controller.signal.aborted;

    try {
      this.set({ status: "preparing", botId: opts.botId, messageId: opts.messageId });
      if (opts.messageId && opts.botId) {
        await this.speakMessage(text, opts, live, controller.signal);
      } else if (isPersonalVoiceId(opts.voiceId)) {
        // A sample or a call prompt: no saved reply to project, so the
        // text is spoken as given.
        await this.speakOnDevice(paragraphs(text), opts.voiceId ?? "", opts, live);
      } else {
        await this.speakText(text, opts, live, controller.signal);
      }
      if (live()) this.set(IDLE);
    } catch (error) {
      if (live()) {
        this.set({
          status: "idle",
          botId: opts.botId,
          messageId: opts.messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (this.request === controller) this.request = null;
    }
  }

  /** A saved reply: the harness owns its text and resolves this Mac's voice.
   * Repeated taps retrieve the same paid clips rather than synthesizing them
   * again. */
  private async speakMessage(text: string, opts: SpeakOptions, live: Live, signal: AbortSignal): Promise<void> {
    const threadId = opts.threadId;
    if (!threadId) throw new Error("The message thread is unavailable.");
    const endpoint = `/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(opts.messageId ?? "")}/audio`;
    let body: TtsAudioBody;
    try {
      body = await this.requestAudio(endpoint, signal);
    } catch (error) {
      if (!live()) return;
      // A Personal Voice costs nothing and needs no harness to be heard.
      // When the harness cannot be asked at all, project the reply here with
      // its own rules and the same length bound, rather than leave the owner
      // with silence.  A refusal (413, 4xx) is shown instead.
      if (isPersonalVoiceId(opts.voiceId) && personalVoiceBridge() && harnessUnavailable(error)) {
        const utterances = toUtterances(spokenReply(text));
        if (!utterances.length) throw error;
        const spoken = utterances.join(" ");
        if (spoken.length > MAX_LOCAL_SPEECH_CHARS) throw new Error(REPLY_TOO_LONG);
        await this.speakOnDevice(utterances, opts.voiceId ?? "", opts, live, spoken);
        return;
      }
      throw error;
    }
    if (!live()) return;
    if (body.onDevice) {
      // The harness's own resolution of this Mac's voice wins over the
      // renderer's copy of the bot, which can be a moment stale.
      const voice = body.voice || opts.voiceId || "";
      const parts = body.utterances?.length ? body.utterances : paragraphs(body.voiceText ?? spokenReply(text));
      await this.speakOnDevice(parts, voice, opts, live, body.voiceText);
      return;
    }
    await this.playClips(endpoint, body, opts, live, signal);
  }

  private async requestAudio(endpoint: string, signal: AbortSignal): Promise<TtsAudioBody> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device: THIS_DEVICE, progressive: true }),
      signal,
    });
    if (!response.ok) {
      if (response.status === 413) throw new AudioRequestError(REPLY_TOO_LONG, 413);
      throw new AudioRequestError((await responseError(response)) ?? `Voice service returned ${response.status}`, response.status);
    }
    const parsed = TtsAudioBodySchema.safeParse(await response.json().catch(() => ({})));
    if (!parsed.success) throw new Error("Voice service returned an invalid response.");
    return parsed.data;
  }

  /** Play every clip in order.  Clip n+1 is fetched while clip n is
   * audible, so the only gap the listener hears is the first one. */
  private async playClips(
    endpoint: string,
    first: TtsAudioBody,
    opts: SpeakOptions,
    live: Live,
    signal: AbortSignal,
  ): Promise<void> {
    const total = first.total ?? first.audio.length;
    const utterances = first.utterances ?? [];
    const voiceText = first.voiceText;
    // A clip the harness no longer knows (it restarted, or forgot a failed
    // job) is resumed by asking for the reply again, once.
    let resumed = false;
    const resume = async (): Promise<boolean> => {
      if (resumed) return false;
      resumed = true;
      await this.requestAudio(endpoint, signal);
      return true;
    };
    type Loaded = { blob: Blob; error?: never } | { blob?: never; error: unknown };
    const load = (index: number): Promise<Loaded> =>
      this.fetchClip(`${endpoint}/${index}?device=${THIS_DEVICE}`, signal, resume).then(
        (blob) => ({ blob }),
        (error) => ({ error }),
      );

    let next: Promise<Loaded> | null = total > 0 ? load(0) : null;
    for (let index = 0; index < total && next; index += 1) {
      const loaded: Loaded = await next;
      if (!live()) return;
      if ("error" in loaded) throw loaded.error;
      next = index + 1 < total ? load(index + 1) : null;
      const caption = utterances[index] ?? voiceText;
      this.set({ status: "speaking", botId: opts.botId, messageId: opts.messageId, caption, voiceText, wordIndex: 0 });
      if (!(await this.play(loaded.blob, live, caption))) {
        if (!live()) return;
        throw new Error("The voice clip could not be played.");
      }
    }
  }

  private async fetchClip(url: string, signal: AbortSignal, resume: () => Promise<boolean>): Promise<Blob> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(url, { signal });
      if (response.ok) return response.blob();
      if (response.status === CLIP_NOT_READY && attempt + 1 < CLIP_NOT_READY_ATTEMPTS) {
        await this.sleep(retryAfterMs(response.headers.get("retry-after")), signal);
        continue;
      }
      if (response.status === CLIP_NOT_READY) throw new Error("The voice clip took too long to prepare.");
      const reason = await responseError(response);
      if (response.status === 404 && (await resume())) continue;
      throw new Error(reason ?? `Voice clip could not be loaded (${response.status}).`);
    }
  }

  /** Speak on this Mac through the Personal Voice helper, a paragraph-sized
   * group per call.  stop() ends the current call through the bridge and
   * the token check ends the loop. */
  private async speakOnDevice(
    parts: string[],
    voiceId: string,
    opts: SpeakOptions,
    live: Live,
    voiceText?: string,
  ): Promise<void> {
    const bridge = personalVoiceBridge();
    if (!bridge) throw new Error(PERSONAL_VOICE_UNSUPPORTED);
    for (const group of groupForPersonalVoice(parts)) {
      if (!live()) return;
      this.set({
        status: "speaking",
        botId: opts.botId,
        messageId: opts.messageId,
        caption: group,
        voiceText: voiceText ?? group,
        wordIndex: 0,
      });
      try {
        await bridge.speak(group, voiceId);
      } catch (error) {
        throw new Error(personalVoiceErrorMessage(error instanceof Error ? error.message : String(error)));
      }
    }
  }

  /** Text that is not a saved reply (a sample, a call prompt): split by the
   * harness, then synthesized one utterance at a time. */
  private async speakText(text: string, opts: SpeakOptions, live: Live, signal: AbortSignal): Promise<void> {
    const utterances = await this.prepare(spokenReply(text), opts.voiceId, signal);
    if (!live() || !utterances.length) return;

    // Prefetch: request utterance n+1 while n is audible. This is what buys
    // responsiveness without holding a streaming socket open for the whole
    // turn — the only gap the listener hears is the first.
    type Rendered = { blob: Blob; error?: never } | { blob?: never; error: unknown };
    const render = (utterance: string): Promise<Rendered> =>
      this.render(utterance, opts.voiceId, signal).then(
        (blob) => ({ blob }),
        (error) => ({ error }),
      );
    let next: Promise<Rendered> | null = render(utterances[0]);
    for (let i = 0; i < utterances.length && next; i += 1) {
      const current: Promise<Rendered> = next;
      next = i + 1 < utterances.length ? render(utterances[i + 1]) : null;
      const rendered = await current;
      if (!live()) return;
      if ("error" in rendered) throw rendered.error;
      this.set({ status: "speaking", botId: opts.botId, messageId: opts.messageId, caption: utterances[i], wordIndex: 0 });
      const finished = await this.play(rendered.blob, live, utterances[i]);
      if (!live()) return;
      if (!finished) throw new Error("The generated voice clip couldn't be played.");
    }
  }

  private async prepare(text: string, voiceId: string | undefined, signal: AbortSignal): Promise<string[]> {
    const res = await fetch("/api/tts/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voiceId }),
      signal,
    });
    const body: TtsPrepareBody = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `the voice service returned ${res.status}`);
    if (!body.ready) {
      throw new Error("Add a voice engine key in a bot profile on this computer, then pick a voice for the bot.");
    }
    return body.utterances ?? [];
  }

  private async render(text: string, voiceId: string | undefined, signal: AbortSignal): Promise<Blob> {
    const res = await fetch("/api/tts/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voiceId }),
      signal,
    });
    if (!res.ok) throw new Error((await responseError(res)) ?? `the voice service returned ${res.status}`);
    return res.blob();
  }

  /** Resolves true when the clip finished, false when it was interrupted. */
  private play(blob: Blob, live: () => boolean, caption?: string): Promise<boolean> {
    return new Promise((resolve) => {
      if (!live()) return resolve(false);
      this.teardownAudio();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.audio = audio;
      this.objectUrl = url;
      let settled = false;
      const words = caption?.trim().split(/\s+/).filter(Boolean) ?? [];

      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        audio.onended = null;
        audio.onerror = null;
        audio.ontimeupdate = null;
        if (this.settlePlayback === done) this.settlePlayback = null;
        if (this.audio === audio) this.teardownAudio();
        resolve(ok);
      };
      this.settlePlayback = done;
      audio.onended = () => done(true);
      // a clip that cannot decode should not strand the whole message
      audio.onerror = () => done(false);

      if (words.length > 0) {
        audio.ontimeupdate = () => {
          if (!live() || settled) return;
          const duration = audio.duration;
          if (duration && Number.isFinite(duration) && duration > 0) {
            const progress = Math.min(1, Math.max(0, audio.currentTime / duration));
            const idx = Math.min(words.length - 1, Math.floor(progress * words.length));
            if (idx !== this.snapshot.wordIndex) {
              this.set({ ...this.snapshot, wordIndex: idx });
            }
          }
        };
      }

      audio.play().catch(() => done(false));
    });
  }
}

export const speaker = new Speaker();
