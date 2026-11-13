// xAI call-mode STT.  The renderer captures the microphone and posts PCM
// to the harness; the harness holds cfg.xai.key and talks to
// wss://api.x.ai/v1/stt.  The permanent key never reaches this file.
import { z } from "zod";

import { pcm16FromFloat32 } from "./assemblyai-transcription";

export type XaiSttTurn = {
  text: string;
  final: boolean;
};

export type XaiTranscriptionSession = {
  stop(): Promise<void>;
};

export interface XaiCreateSessionBody {
  language?: string;
  keyterms?: readonly string[];
  endpointMs?: number;
}

interface SessionCreated {
  sessionId: string;
}

const SessionCreatedSchema = z.object({
  sessionId: z.string().min(1),
  error: z.string().optional(),
});
const SessionErrorSchema = z.object({
  error: z.string().optional(),
});
const SessionEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("partial"), text: z.string(), final: z.boolean() }),
  z.object({ type: z.literal("done"), duration: z.number().optional() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export type SessionEvent = z.infer<typeof SessionEventSchema>;

export interface XaiCaptureStream {
  getTracks(): ReadonlyArray<{ stop(): void }>;
}

export interface XaiCaptureHandle {
  stop(): Promise<void>;
}

export interface XaiTranscriptionDeps {
  createSession?: (body: XaiCreateSessionBody) => Promise<SessionCreated>;
  postAudio?: (sessionId: string, bytes: ArrayBuffer) => Promise<void>;
  stopSession?: (sessionId: string) => Promise<void>;
  subscribe?: (sessionId: string, onEvent: (event: SessionEvent) => void) => () => void;
  attachCapture?: (stream: XaiCaptureStream, onPcm: (bytes: ArrayBuffer) => void, shouldSend: () => boolean) => Promise<XaiCaptureHandle>;
}

const defaultDeps: Required<XaiTranscriptionDeps> = {
  async createSession(body) {
    const res = await fetch("/api/stt/xai/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => null);
    const created = SessionCreatedSchema.safeParse(payload);
    if (res.ok && created.success) return { sessionId: created.data.sessionId };
    const failed = SessionErrorSchema.safeParse(payload);
    throw new Error(failed.success && failed.data.error ? failed.data.error : "Could not start xAI dictation.");
  },
  async postAudio(sessionId, bytes) {
    const res = await fetch(`/api/stt/xai/sessions/${encodeURIComponent(sessionId)}/audio`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
    if (!res.ok && res.status !== 204) {
      const failed = SessionErrorSchema.safeParse(await res.json().catch(() => null));
      throw new Error(failed.success && failed.data.error ? failed.data.error : "Could not send audio to xAI dictation.");
    }
  },
  async stopSession(sessionId) {
    await fetch(`/api/stt/xai/sessions/${encodeURIComponent(sessionId)}/stop`, { method: "POST" }).catch(() => {});
  },
  subscribe(sessionId, onEvent) {
    const source = new EventSource(`/api/stt/xai/sessions/${encodeURIComponent(sessionId)}/events`);
    source.onmessage = (event) => {
      try {
        const parsed = SessionEventSchema.safeParse(JSON.parse(String(event.data)));
        if (parsed.success) onEvent(parsed.data);
      } catch {
        // Ignore a malformed frame; the next one may still be useful.
      }
    };
    source.onerror = () => {
      onEvent({ type: "error", message: "xAI dictation disconnected." });
    };
    return () => source.close();
  },
  async attachCapture(stream, onPcm, shouldSend) {
    return attachPcmCapture(stream, onPcm, shouldSend);
  },
};

export async function startXaiTranscription({
  stream,
  onTurn,
  onError,
  keyterms,
  minTurnSilenceMs,
  language,
  deps = {},
}: {
  stream: XaiCaptureStream;
  onTurn: (turn: XaiSttTurn) => void;
  onError: (message: string) => void;
  keyterms?: readonly string[];
  minTurnSilenceMs?: number;
  language?: string;
  deps?: XaiTranscriptionDeps;
}): Promise<XaiTranscriptionSession> {
  const io = { ...defaultDeps, ...deps };
  const created = await io.createSession({
    language: language ?? globalThis.navigator?.language,
    keyterms,
    endpointMs: minTurnSilenceMs,
  });
  const sessionId = created.sessionId;

  let stopping = false;
  const unsubscribe = io.subscribe(sessionId, (event) => {
    if (event.type === "partial" && event.text.trim()) {
      onTurn({ text: event.text, final: event.final });
    } else if (event.type === "error" && !stopping) {
      onError(event.message || "xAI dictation failed.");
    }
  });

  const chunks: Uint8Array[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let sending = Promise.resolve();

  const flushAudio = async () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!chunks.length) return;
    const pending = chunks.splice(0);
    const total = pending.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const packed = new Uint8Array(total);
    let offset = 0;
    for (const chunk of pending) {
      packed.set(chunk, offset);
      offset += chunk.byteLength;
    }
    await io.postAudio(sessionId, packed.buffer);
  };

  const enqueueAudio = (payload: ArrayBuffer) => {
    if (stopping || !payload.byteLength) return;
    chunks.push(new Uint8Array(payload));
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        sending = sending.then(flushAudio).catch((error) => {
          if (!stopping) onError(error instanceof Error ? error.message : String(error));
        });
      }, 150);
    }
  };

  let capture: XaiCaptureHandle;
  try {
    capture = await io.attachCapture(stream, enqueueAudio, () => !stopping);
  } catch (error) {
    try {
      await io.stopSession(sessionId);
    } finally {
      unsubscribe();
    }
    throw error;
  }

  return {
    async stop() {
      if (stopping) return;
      stopping = true;
      await capture.stop().catch(() => {});
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      sending = sending.then(flushAudio);
      await sending.catch(() => {});
      try {
        await io.stopSession(sessionId);
      } finally {
        unsubscribe();
      }
    },
  };
}

async function attachPcmCapture(
  stream: XaiCaptureStream,
  onPcm: (bytes: ArrayBuffer) => void,
  shouldSend: () => boolean,
): Promise<XaiCaptureHandle> {
  const audioContext = new AudioContext();
  if (audioContext.state === "suspended") await audioContext.resume();
  // SAFETY: the browser AudioContext typings require MediaStream, and this
  // capture path only ever receives a live getUserMedia stream in production.
  const source = audioContext.createMediaStreamSource(stream as MediaStream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const silentOutput = audioContext.createGain();
  silentOutput.gain.value = 0;
  processor.onaudioprocess = (event) => {
    if (!shouldSend()) return;
    const payload = pcm16FromFloat32(event.inputBuffer.getChannelData(0), audioContext.sampleRate);
    if (payload.byteLength) onPcm(payload);
  };
  source.connect(processor);
  processor.connect(silentOutput);
  silentOutput.connect(audioContext.destination);
  return {
    async stop() {
      processor.onaudioprocess = null;
      source.disconnect();
      processor.disconnect();
      silentOutput.disconnect();
      await audioContext.close().catch(() => {});
    },
  };
}
