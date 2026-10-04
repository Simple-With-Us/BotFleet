import { spokenReply } from "../../../shared/voice-summary";
import { TtsAudioBodySchema } from "./schema";
// The speaker — one voice for the whole window.
//
// Deliberately a singleton: two bots talking over each other is never what
// anyone wants, so starting a new utterance cancels whatever was speaking.
// That single rule is also what makes interrupting work — call mode just
// calls stop().
//
// Audio comes from the harness (POST /api/tts/speak), which holds the
// MiniMax key. The renderer never sees it, and never talks to
// MiniMax directly.
//
// Text is split into utterances by the harness too, next to the transform
// that produced it — it is the piece most likely to be tuned against real
// transcripts, and keeping it in one place is the same reasoning as the
// server-computed approval key.

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
  error?: string;
}

interface SpeakOptions {
  voiceId?: string;
  botId?: string;
  messageId?: string;
  threadId?: string;
}

type TtsPrepareBody = { ready?: boolean; utterances?: string[]; error?: string };
type TtsErrorBody = { error?: string };

const IDLE: SpeechSnapshot = { status: "idle" };

export class Speaker {
  private snapshot: SpeechSnapshot = IDLE;
  private watchers = new Set<(s: SpeechSnapshot) => void>();
  /** bumped on every speak()/stop(); async work whose token is stale exits */
  private token = 0;
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private settlePlayback: ((finished: boolean) => void) | null = null;
  private request: AbortController | null = null;

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

    const isPersonal =
      typeof opts.voiceId === "string" &&
      (opts.voiceId.startsWith("personal:") || opts.voiceId.startsWith("apple-personal:"));

    if (isPersonal) {
      this.set({ status: "preparing", botId: opts.botId, messageId: opts.messageId, caption: text, voiceText: text, wordIndex: 0 });
      if (typeof window !== "undefined" && window.ogb?.personalVoice?.speak) {
        try {
          this.set({ status: "speaking", botId: opts.botId, messageId: opts.messageId, caption: text, voiceText: text, wordIndex: 0 });
          await window.ogb.personalVoice.speak(text, opts.voiceId);
          if (live()) this.set(IDLE);
        } catch (error) {
          if (live()) this.set({ ...IDLE, error: error instanceof Error ? error.message : String(error) });
        } finally {
          if (this.request === controller) this.request = null;
        }
        return;
      }
      this.set({
        ...IDLE,
        error: "Apple Personal Voice speaks on authorized Apple devices (macOS / iOS).",
      });
      if (this.request === controller) this.request = null;
      return;
    }

    if (opts.messageId && opts.botId) {
      this.set({ status: "preparing", botId: opts.botId, messageId: opts.messageId });
      try {
        // The server owns the message text and selected voice. Repeated taps
        // retrieve the same paid clips rather than synthesizing them again.
        const threadId = opts.threadId;
        if (!threadId) throw new Error("The message thread is unavailable.");
        const endpoint = `/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(opts.messageId)}/audio`;
        const response = await fetch(endpoint, { method: "POST", signal: controller.signal });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? `Voice service returned ${response.status}`);
        const parsed = TtsAudioBodySchema.safeParse(await response.json());
        if (!parsed.success) throw new Error("Voice service returned an invalid response.");
        const { audio, voiceText, utterances, onDevice } = parsed.data;
        if (onDevice || (!audio?.length && voiceText)) {
          if (typeof window !== "undefined" && window.ogb?.personalVoice?.speak) {
            const speechText = voiceText ?? text;
            this.set({ status: "speaking", botId: opts.botId, messageId: opts.messageId, caption: speechText, voiceText: speechText, wordIndex: 0 });
            await window.ogb.personalVoice.speak(speechText, opts.voiceId);
            if (live()) this.set(IDLE);
          } else {
            throw new Error("Apple Personal Voice speaks on authorized Apple devices (macOS / iOS).");
          }
          return;
        }
        for (let i = 0; i < audio.length && live(); i++) {
          const clip = await fetch(`${endpoint}/${i}`, { signal: controller.signal });
          if (!clip.ok) throw new Error(`Voice clip could not be loaded (${clip.status}).`);
          const caption = utterances?.[i] ?? voiceText;
          this.set({ status: "speaking", botId: opts.botId, messageId: opts.messageId, caption, voiceText, wordIndex: 0 });
          if (!(await this.play(await clip.blob(), live, caption))) throw new Error("The voice clip could not be played.");
        }
        if (live()) this.set(IDLE);
      } catch (error) {
        if (live()) this.set({ ...IDLE, error: error instanceof Error ? error.message : String(error) });
      } finally {
        if (this.request === controller) this.request = null;
      }
      return;
    }
    this.set({ status: "preparing", botId: opts.botId, messageId: opts.messageId });
    let utterances: string[];
    try {
      utterances = await this.prepare(spokenReply(text), opts.voiceId, controller.signal);
    } catch (e) {
      if (live()) this.set({ ...IDLE, error: e instanceof Error ? e.message : String(e) });
      if (this.request === controller) this.request = null;
      return;
    }
    if (!live()) return;
    if (!utterances.length) {
      this.set(IDLE);
      if (this.request === controller) this.request = null;
      return;
    }

    // Prefetch: request utterance n+1 while n is audible. This is what buys
    // responsiveness without holding a streaming socket open for the whole
    // turn — the only gap the listener hears is the first.
    type Rendered = { blob: Blob; error?: never } | { blob?: never; error: unknown };
    const render = (utterance: string): Promise<Rendered> =>
      this.render(utterance, opts.voiceId, controller.signal).then(
        (blob) => ({ blob }),
        (error: unknown) => ({ error }),
      );
    let next: Promise<Rendered> | null = render(utterances[0]);
    for (let i = 0; i < utterances.length; i += 1) {
      const current = next;
      next = i + 1 < utterances.length ? render(utterances[i + 1]) : null;
      if (!current) break;
      const rendered = await current;
      if ("error" in rendered) {
        if (live()) {
          this.set({
            ...IDLE,
            error: rendered.error instanceof Error ? rendered.error.message : String(rendered.error),
          });
        }
        if (this.request === controller) this.request = null;
        return;
      }
      if (!live()) return;
      this.set({ status: "speaking", botId: opts.botId, messageId: opts.messageId, caption: utterances[i], wordIndex: 0 });
      const finished = await this.play(rendered.blob, live, utterances[i]);
      if (!finished || !live()) {
        if (live()) this.set({ ...IDLE, error: "The generated voice clip couldn't be played." });
        if (this.request === controller) this.request = null;
        return;
      }
    }
    if (live()) this.set(IDLE);
    if (this.request === controller) this.request = null;
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
    if (!res.ok) {
      const body: TtsErrorBody = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `the voice service returned ${res.status}`);
    }
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
