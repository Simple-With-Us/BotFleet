/** Microphone capture for MiniMax voice cloning (Mac desktop). */

export const VOICE_CLONE_MIN_SECONDS = 10;
export const VOICE_CLONE_MAX_SECONDS = 5 * 60;

export function canRecordVoiceCloneOnDevice(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

function preferredRecorderMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
  return candidates.find((mime) => MediaRecorder.isTypeSupported(mime));
}

function extensionForMime(mime: string): "m4a" | "wav" | "webm" {
  if (mime.startsWith("audio/mp4")) return "m4a";
  if (mime.startsWith("audio/wav")) return "wav";
  return "webm";
}

function mixDownToMono(buffer: AudioBuffer): Float32Array {
  const { length, numberOfChannels } = buffer;
  if (numberOfChannels === 1) return buffer.getChannelData(0);
  const mixed = new Float32Array(length);
  for (let channel = 0; channel < numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) mixed[i] += data[i] / numberOfChannels;
  }
  return mixed;
}

/** Encode a decoded buffer as 16-bit PCM WAV. */
export function encodeWavFromAudioBuffer(buffer: AudioBuffer): Blob {
  const samples = mixDownToMono(buffer);
  const sampleRate = buffer.sampleRate;
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const dataSize = samples.length * bytesPerSample;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }

  return new Blob([header, pcm], { type: "audio/wav" });
}

export async function recordingBlobToCloneFile(blob: Blob, mimeType: string): Promise<File> {
  const ext = extensionForMime(mimeType);
  if (ext === "m4a") {
    return new File([blob], "voice-clone-recording.m4a", { type: mimeType.split(";")[0] });
  }
  if (ext === "wav") {
    return new File([blob], "voice-clone-recording.wav", { type: "audio/wav" });
  }
  const audioContext = new AudioContext();
  try {
    const decoded = await audioContext.decodeAudioData(await blob.arrayBuffer());
    const wav = encodeWavFromAudioBuffer(decoded);
    return new File([wav], "voice-clone-recording.wav", { type: "audio/wav" });
  } finally {
    await audioContext.close();
  }
}

export type MicRecorder = {
  stop(): Promise<File>;
  cancel(): void;
};

/** Start microphone capture; call `stop()` to produce a clone-ready audio file. */
export async function startMicRecorder(): Promise<MicRecorder> {
  if (!canRecordVoiceCloneOnDevice()) {
    throw new Error("Microphone recording needs the BotFleet desktop app on a Mac.");
  }
  const mimeType = preferredRecorderMime();
  if (!mimeType) throw new Error("This browser cannot record audio for voice cloning.");

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(stream, { mimeType });
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  recorder.start(1_000);

  const release = () => {
    stream.getTracks().forEach((track) => track.stop());
  };

  return {
    stop: async () => {
      if (recorder.state !== "inactive") {
        await new Promise<void>((resolve) => {
          recorder.addEventListener("stop", () => resolve(), { once: true });
          recorder.stop();
        });
      }
      release();
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType });
      if (!blob.size) throw new Error("No audio was captured — try recording again.");
      return recordingBlobToCloneFile(blob, recorder.mimeType || mimeType);
    },
    cancel: () => {
      if (recorder.state !== "inactive") recorder.stop();
      release();
    },
  };
}
