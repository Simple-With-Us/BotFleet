// Call-mode STT. A single interface (apple vs cloud) so the call flow does
// not have to branch on provider. The apple implementation is a thin wrapper
// over the Electron IPC surface that already drives the Swift SFSpeech helper;
// the assemblyai implementation opens getUserMedia + the existing v3 streaming
// WebSocket from the renderer. Listeners attach before start() so the call
// component can wire transcripts before capture begins.

import {
  startAssemblyAITranscription,
  type AssemblyAITranscriptionSession,
} from "./assemblyai-transcription";

export type STTProvider = "apple" | "assemblyai";

export interface STTTranscriptLine {
  text: string;
  /** True while the model is still finalising the turn. */
  partial: boolean;
  /** Set when a single-shot error payload arrives. The session still emits
   * the matching `onEnd` event so the caller can decide to retry. */
  error?: string;
}

export interface STTEndInfo {
  /** 0 = success (turn ended cleanly), 1 = error, 2 = unsupported platform. */
  code: number;
  reason?: string;
}

export interface STTStartOptions {
  /** Silence duration before the model ends a turn. Apple ignores this in
   *  push-to-talk composer dictation; assemblyai maps it to `min_turn_silence`. */
  endpointMs?: number;
  /** Vocabulary to bias toward. AssemblyAI only; apple ignores this. */
  keyterms?: readonly string[];
  /** Speech model override; assemblyai only. */
  speechModel?: string;
}

export interface STTSession {
  readonly provider: STTProvider;
  start(opts?: STTStartOptions): Promise<void>;
  stop(): Promise<void>;
  /** Finalise the active request, like Apple's `finishSpeech`. */
  finish(): Promise<void>;
  onTranscript(cb: (line: STTTranscriptLine) => void): () => void;
  onEnd(cb: (info: STTEndInfo) => void): () => void;
}

/** Map the Electron preload's speech:transcript payload to the abstract line. */
function toTranscriptLine(line: unknown): STTTranscriptLine | null {
  if (!line || typeof line !== "object") return null;
  const candidate = line as { text?: unknown; partial?: unknown; error?: unknown };
  const text = typeof candidate.text === "string" ? candidate.text : "";
  const partial = candidate.partial !== false;
  const error = typeof candidate.error === "string" ? candidate.error : undefined;
  return { text, partial, error };
}

export function createAppleSTTSession(): STTSession {
  const bridge = typeof window !== "undefined" ? window.ogb : undefined;
  const speechStart = bridge?.speechStart;
  const speechStop = bridge?.speechStop;
  const speechFinish = bridge?.speechFinish;
  const onSpeechTranscript = bridge?.onSpeechTranscript;
  const onSpeechEnd = bridge?.onSpeechEnd;
  if (!speechStart || !speechStop || !speechFinish || !onSpeechTranscript || !onSpeechEnd) {
    throw new Error("Apple STT bridge is unavailable in this build.");
  }
  const transcriptListeners = new Set<(line: STTTranscriptLine) => void>();
  const endListeners = new Set<(info: STTEndInfo) => void>();

  const offTranscript = onSpeechTranscript((raw) => {
    const line = toTranscriptLine(raw);
    if (!line) return;
    for (const cb of transcriptListeners) cb(line);
  });
  const offEnd = onSpeechEnd((raw) => {
    const code = typeof raw?.code === "number" ? raw.code : 1;
    const reason = typeof raw?.reason === "string" ? raw.reason : undefined;
    for (const cb of endListeners) cb({ code, reason });
  });

  const session: STTSession = {
    provider: "apple",
    async start(opts) {
      await speechStart({ endpointMs: opts?.endpointMs ?? 0 });
    },
    async stop() {
      await speechStop();
    },
    async finish() {
      await speechFinish();
    },
    onTranscript(cb) {
      transcriptListeners.add(cb);
      return () => transcriptListeners.delete(cb);
    },
    onEnd(cb) {
      endListeners.add(cb);
      return () => endListeners.delete(cb);
    },
  };
  // The IPC subscriptions live for the lifetime of the page. Tests own the
  // raw listeners so they can detach; production code does not need this.
  (session as STTSession & { __off?: () => void }).__off = () => {
    offTranscript();
    offEnd();
  };
  return session;
}

/** Detach the IPC subscriptions created by `createAppleSTTSession`. Test-only;
 * the renderer never tears these down in production because a single
 * Electron window owns one Swift helper session for its lifetime. */
export function disposeAppleSTTSession(session: STTSession): void {
  const off = (session as STTSession & { __off?: () => void }).__off;
  off?.();
}

export function createAssemblyAISTTSession(): STTSession {
  const bridge = typeof window !== "undefined" ? window.ogb : undefined;
  const tokenMint = bridge?.transcription?.streamingToken;
  if (!tokenMint) {
    throw new Error("AssemblyAI streaming bridge is unavailable in this build.");
  }
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("This environment cannot capture the microphone.");
  }

  const transcriptListeners = new Set<(line: STTTranscriptLine) => void>();
  const endListeners = new Set<(info: STTEndInfo) => void>();

  let stream: MediaStream | null = null;
  let session: AssemblyAITranscriptionSession | null = null;
  let running = false;

  const releaseMedia = () => {
    if (!stream) return;
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  };

  const emitEnd = (info: STTEndInfo) => {
    for (const cb of endListeners) cb(info);
  };

  return {
    provider: "assemblyai",
    async start(opts) {
      if (running) return;
      running = true;
      let media: MediaStream;
      try {
        media = await navigator.mediaDevices.getUserMedia({
          audio: {
            // Enable OS-level AEC when the host supports it; the call flow
            // is half-duplex by design, but a tail of the bot's reply can
            // still leak into the captured mic stream while the playback
            // fade-out finishes. AEC + noise suppression reduce that drift.
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (error) {
        running = false;
        const reason = (error as Error)?.message ?? String(error);
        emitEnd({ code: 1, reason: `Microphone unavailable: ${reason}` });
        return;
      }
      if (!running) {
        for (const track of media.getTracks()) track.stop();
        return;
      }
      stream = media;
      try {
        session = await startAssemblyAITranscription({
          stream,
          getToken: () => tokenMint(),
          onTurn: (turn) => {
            const line: STTTranscriptLine = {
              text: turn.text,
              partial: !turn.final,
            };
            for (const cb of transcriptListeners) cb(line);
          },
          onError: (message) => {
            emitEnd({ code: 1, reason: message });
          },
          keyterms: opts?.keyterms,
          minTurnSilenceMs: opts?.endpointMs,
          speechModel: opts?.speechModel,
        });
      } catch (error) {
        running = false;
        releaseMedia();
        const reason = (error as Error)?.message ?? String(error);
        emitEnd({ code: 1, reason });
      }
    },
    async stop() {
      if (!running) return;
      running = false;
      const live = session;
      session = null;
      try {
        await live?.stop();
      } catch {
        // best-effort; the WebSocket may already be closed
      }
      releaseMedia();
      emitEnd({ code: 0, reason: "stopped" });
    },
    async finish() {
      if (!running) return;
      running = false;
      const live = session;
      session = null;
      try {
        await live?.stop();
      } catch {
        // best-effort
      }
      releaseMedia();
      emitEnd({ code: 0, reason: "finished" });
    },
    onTranscript(cb) {
      transcriptListeners.add(cb);
      return () => transcriptListeners.delete(cb);
    },
    onEnd(cb) {
      endListeners.add(cb);
      return () => endListeners.delete(cb);
    },
  };
}

/** Factory that picks an implementation by name. Throws if the requested
 * provider has no usable bridge on this platform. */
export function createSTTSession(provider: STTProvider): STTSession {
  return provider === "apple" ? createAppleSTTSession() : createAssemblyAISTTSession();
}