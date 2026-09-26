import { z } from "zod";

export type AssemblyAITurn = {
  order: number;
  text: string;
  final: boolean;
};

export type AssemblyAITranscript = {
  turns: Map<number, { text: string; final: boolean }>;
  finalText: string;
  partialText: string;
};

export type AssemblyAITranscriptionSession = {
  stop(): Promise<void>;
};

const SAMPLE_RATE = 16_000;
const STREAMING_ENDPOINT = "wss://streaming.assemblyai.com/v3/ws";
const DEFAULT_SPEECH_MODEL = "u3-rt-pro";
const streamingMessageSchema = z.object({
  type: z.string(),
  transcript: z.string().optional(),
  turn_order: z.coerce.number().optional(),
  end_of_turn: z.boolean().optional(),
});

export interface AssemblyAIStreamingUrlParams {
  token: string;
  /** Speech model id; defaults to `u3-rt-pro` (Universal-3.5 Pro Realtime). */
  speechModel?: string;
  /** Per-call keyterm vocabulary; each entry becomes its own repeated
   * `keyterms_prompt` query parameter (AssemblyAI's `doseq=True` shape).
   * Filtered for non-empty trimmed strings; capped at 100. */
  keyterms?: readonly string[];
  /** Server-side endpointing. The streaming model finalizes a turn after
   * this many milliseconds of trailing silence. Clamped server-side to
   * 50–10 000 ms; default 400. */
  minTurnSilenceMs?: number;
}

/** Build the v3 streaming URL. Exported for testability — callers go through
 * `startAssemblyAITranscription`, which mints the token and opens the socket. */
export function buildAssemblyAIStreamingUrl({
  token,
  speechModel = DEFAULT_SPEECH_MODEL,
  keyterms,
  minTurnSilenceMs,
}: AssemblyAIStreamingUrlParams): string {
  const params = new URLSearchParams({
    sample_rate: String(SAMPLE_RATE),
    speech_model: speechModel,
    format_turns: "true",
    token,
  });
  if (typeof minTurnSilenceMs === "number" && Number.isFinite(minTurnSilenceMs) && minTurnSilenceMs > 0) {
    params.set("min_turn_silence", String(Math.round(minTurnSilenceMs)));
  }
  if (keyterms?.length) {
    const cleaned = keyterms
      .map((term) => term.trim())
      .filter((term) => term.length > 0)
      .slice(0, 100);
    for (const term of cleaned) params.append("keyterms_prompt", term);
  }
  return `${STREAMING_ENDPOINT}?${params.toString()}`;
}

export function mergeAssemblyAITurn(
  current: AssemblyAITranscript,
  turn: AssemblyAITurn,
): AssemblyAITranscript {
  if (!turn.text.trim() || !Number.isFinite(turn.order)) return current;
  const turns = new Map(current.turns);
  turns.set(turn.order, { text: turn.text.trim(), final: turn.final });
  const ordered = [...turns.entries()].sort(([left], [right]) => left - right);
  return {
    turns,
    finalText: ordered.filter(([, value]) => value.final).map(([, value]) => value.text).join(" "),
    partialText: ordered.filter(([, value]) => !value.final).map(([, value]) => value.text).join(" "),
  };
}

/** Resample one browser microphone frame to AssemblyAI's PCM16 LE contract. */
export function pcm16FromFloat32(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate = SAMPLE_RATE,
): ArrayBuffer {
  if (!input.length || inputSampleRate <= 0 || outputSampleRate <= 0) return new ArrayBuffer(0);
  const outputLength = Math.max(1, Math.round(input.length * outputSampleRate / inputSampleRate));
  const buffer = new ArrayBuffer(outputLength * 2);
  const view = new DataView(buffer);
  const scale = input.length / outputLength;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * scale;
    const left = Math.min(input.length - 1, Math.floor(position));
    const right = Math.min(input.length - 1, left + 1);
    const amount = position - left;
    const sample = Math.max(-1, Math.min(1, input[left]! * (1 - amount) + input[right]! * amount));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return buffer;
}

export async function startAssemblyAITranscription({
  stream,
  getToken,
  onTurn,
  onError,
  keyterms,
  minTurnSilenceMs,
  speechModel,
}: {
  stream: MediaStream;
  getToken: () => Promise<{ token: string }>;
  onTurn: (turn: AssemblyAITurn) => void;
  onError: (message: string) => void;
  /** Optional vocabulary; passed as repeated `keyterms_prompt` query params. */
  keyterms?: readonly string[];
  /** Optional server-side endpointing in milliseconds. */
  minTurnSilenceMs?: number;
  /** Optional speech model override; defaults to `u3-rt-pro`. */
  speechModel?: string;
}): Promise<AssemblyAITranscriptionSession> {
  const { token } = await getToken();
  const socket = new WebSocket(
    buildAssemblyAIStreamingUrl({ token, keyterms, minTurnSilenceMs, speechModel }),
  );
  const connected = new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("AssemblyAI took too long to connect.")), 10_000);
    socket.addEventListener("open", () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      window.clearTimeout(timer);
      reject(new Error("Could not open the AssemblyAI transcription stream."));
    }, { once: true });
  });
  try {
    await connected;
  } catch (error) {
    socket.close();
    throw error;
  }

  let stopping = false;
  let terminated = false;
  socket.addEventListener("message", (event) => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const parsed = streamingMessageSchema.safeParse(decoded);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === "Turn" && message.transcript !== undefined) {
      onTurn({
        order: message.turn_order ?? Number.NaN,
        text: message.transcript,
        final: message.end_of_turn === true,
      });
    } else if (message.type === "Termination") {
      terminated = true;
    }
  });
  socket.addEventListener("close", () => {
    if (!stopping && !terminated) onError("Cloud transcription disconnected; the original audio is still being saved.");
  });

  let audioContext: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode;
  let processor: ScriptProcessorNode;
  let silentOutput: GainNode;
  try {
    audioContext = new AudioContext();
    if (audioContext.state === "suspended") await audioContext.resume();
    source = audioContext.createMediaStreamSource(stream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);
    silentOutput = audioContext.createGain();
  } catch (error) {
    await audioContext?.close().catch(() => {});
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "Terminate" }));
    socket.close();
    throw error;
  }
  silentOutput.gain.value = 0;
  processor.onaudioprocess = (event) => {
    if (stopping || socket.readyState !== WebSocket.OPEN) return;
    const payload = pcm16FromFloat32(event.inputBuffer.getChannelData(0), audioContext.sampleRate);
    if (payload.byteLength) socket.send(payload);
  };
  source.connect(processor);
  processor.connect(silentOutput);
  silentOutput.connect(audioContext.destination);

  return {
    async stop() {
      if (stopping) return;
      stopping = true;
      processor.onaudioprocess = null;
      source.disconnect();
      processor.disconnect();
      silentOutput.disconnect();
      await audioContext.close().catch(() => {});
      if (socket.readyState !== WebSocket.OPEN) return;
      const finished = new Promise<void>((resolve) => {
        const done = () => resolve();
        socket.addEventListener("close", done, { once: true });
        socket.addEventListener("message", (event) => {
          try {
            const parsed = streamingMessageSchema.safeParse(JSON.parse(String(event.data)));
            if (parsed.success && parsed.data.type === "Termination") resolve();
          } catch {
            // Ignore non-JSON frames while the service drains its final turn.
          }
        });
        window.setTimeout(resolve, 2_500);
      });
      socket.send(JSON.stringify({ type: "Terminate" }));
      await finished;
      socket.close();
    },
  };
}
