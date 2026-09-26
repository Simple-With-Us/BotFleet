// MiniMax TTS — the only network voice engine.
//
// One request per utterance, the renderer already prefetches the next clip
// while the current one plays, which gets the same perceived latency as a
// streaming socket without the moving parts. The renderer only ever sees
// opaque mp3 bytes — the API key never leaves this process.
//
// TTS endpoint: POST  https://api.minimax.io/v1/t2a_v2   (sync, ≤10K chars)
// Voice list:   GET   https://api.minimax.io/v1/voice/list (also the verifyKey probe)
// Cloned voice: same /v1/t2a_v2, voice_id set to the cloned voice_id from cfg.
//
// Native contract, not the OpenAI-compatible shape:
//   body: { model, text, stream:false, output_format:"hex",
//           voice_setting:{voice_id, speed, vol, pitch},
//           audio_setting:{sample_rate, bitrate, format, channel},
//           language_boost }
//   response: { data:{audio:"<hex>"}, base_resp:{status_code, status_msg} }
// An error response surfaces base_resp.status_msg verbatim.
import type { VerifyResult } from "./elevenlabs.ts";

const API = process.env.MINIMAX_API_URL || "https://api.minimax.io";
const MODEL = process.env.MINIMAX_SPEECH_MODEL || "speech-2.8-turbo";
const MAX_CHARS = 10_000;

export type { VerifyResult };

export interface Voice {
  id: string;
  label: string;
  description?: string;
}

export interface Audio {
  bytes: Uint8Array;
  mime: string;
}

interface BaseResponse {
  status_code: number;
  status_msg?: string;
}

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Pull the human-readable error out of a MiniMax response. They use
 * `base_resp.status_msg`; fall back to top-level `message` for the rare
 * non-con-con envelope. */
function message(status: number, what: string, body: any): string {
  const theirs =
    ((Object.prototype.toString.call(body?.base_resp?.status_msg) === "[object String]") && body.base_resp.status_msg.trim()) ||
    ((Object.prototype.toString.call(body?.message) === "[object String]") && body.message.trim()) ||
    "";
  if (status === 401 || status === 403) {
    return theirs ? `MiniMax rejected that key: ${theirs}` : "MiniMax rejected that key. Get a fresh one from platform.minimax.io/user/basic-information/interface-key.";
  }
  if (status === 429) return theirs || "MiniMax is rate-limiting this account — wait a moment and try again.";
  if (status === 402) return theirs || "MiniMax says this account is out of credit.";
  return theirs ? `${what} failed: ${theirs}` : `${what} failed (${status})`;
}

/** Check a key before we store it: a rejected credential must fail at the
 * paste, not hours later in another panel with nothing to act on.
 *
 * We probe /v1/voice/list — it returns the system catalog so a successful
 * response doubles as the voice list. */
export async function verifyKey(key: string): Promise<VerifyResult> {
  try {
    const res = await fetch(`${API}/v1/voice/list`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
    // SAFETY: safeJson only returns the JSON envelope on a successful
    // parse, and the documented MiniMax voice-list contract is
    // VoiceListResponse; the cast is the boundary that narrows to it.
    const body = (await safeJson(res)) as VoiceListResponse | null;
    if (res.ok && body?.base_resp?.status_code === 0) return { ok: true };
    return { ok: false, message: message(res.status, "checking that key", body) };
  } catch {
    return { ok: false, message: "Couldn't reach MiniMax to check that key — check your connection." };
  }
}

interface VoiceListItem {
  voice_id?: string;
  voice_name?: string;
  description?: string;
  language?: string | string[];
  gender?: string;
}

interface VoiceListResponse {
  voice_list?: VoiceListItem[];
  base_resp?: BaseResponse;
}

/** List MiniMax system voices. The picker only shows curated English/Chinese/
 * Japanese defaults today; cloning adds entries on top later. */
export async function listVoices(key: string): Promise<Voice[]> {
  const res = await fetch(`${API}/v1/voice/list`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20_000),
  });
  // SAFETY: safeJson returns the parsed envelope, and the documented
  // MiniMax voice-list contract is VoiceListResponse; the cast narrows.
  const body = (await safeJson(res)) as VoiceListResponse | null;
  if (!res.ok || body?.base_resp?.status_code !== 0) {
    throw new Error(message(res.status, "listing voices", body));
  }
  return (body?.voice_list ?? [])
    .map((v): Voice => {
      const id = String(v.voice_id ?? "");
      const lang = Array.isArray(v.language) ? v.language.join("/") : v.language;
      return {
        id,
        label: String(v.voice_name ?? v.voice_id ?? "Voice"),
        description: [lang, v.gender].filter(Boolean).join(" · ") || undefined,
      };
    })
    .filter((v) => v.id);
}

export interface SynthesizeOptions {
  voiceId: string;
  /** Voice id can be a system voice_id OR a cloned voice_id. */
  speed?: number;
  vol?: number;
  pitch?: number;
  format?: "mp3" | "pcm" | "flac";
  sampleRate?: number;
  bitrate?: number;
  languageBoost?: string;
}

interface T2AResponse {
  data?: { audio?: string; status?: number };
  extra_info?: { audio_format?: string; audio_length?: number };
  base_resp?: BaseResponse;
}

/** Synthesize one utterance to mp3 bytes. Throws if MiniMax returns a
 * non-zero status_code or the audio payload is empty. */
export async function synthesize(
  text: string,
  voiceId: string,
  key: string,
  options: SynthesizeOptions = { voiceId: "" },
): Promise<Audio> {
  const trimmed = text.trim();
  if (!trimmed) return { bytes: new Uint8Array(), mime: "audio/mpeg" };
  if (trimmed.length > MAX_CHARS) {
    throw new Error(`utterance is ${trimmed.length} chars; MiniMax accepts at most ${MAX_CHARS} per request`);
  }
  const body = {
    model: MODEL,
    text: trimmed,
    stream: false,
    output_format: "hex",
    voice_setting: {
      voice_id: voiceId,
      speed: options.speed ?? 1.0,
      vol: options.vol ?? 1.0,
      pitch: options.pitch ?? 0,
    },
    audio_setting: {
      sample_rate: options.sampleRate ?? 24_000,
      bitrate: options.bitrate ?? 128_000,
      format: options.format ?? "mp3",
      channel: 1,
    },
    language_boost: options.languageBoost ?? "auto",
  };
  const res = await fetch(`${API}/v1/t2a_v2`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  }).catch(() => {
    throw new Error("Couldn't reach MiniMax to speak — check your connection.");
  });
  // SAFETY: safeJson returns the parsed envelope, and the documented
  // MiniMax T2A contract is T2AResponse; the cast narrows to it.
  const parsed = (await safeJson(res)) as T2AResponse | null;
  if (!res.ok || parsed?.base_resp?.status_code !== 0 || !parsed.data?.audio) {
    throw new Error(message(res.status, "speaking", parsed));
  }
  // output_format "hex" — decode each pair of hex chars into a byte.
  const hex = parsed.data.audio;
  if (hex.length % 2 !== 0) {
    throw new Error("MiniMax returned odd-length hex audio");
  }
  const bytes = Buffer.from(hex, "hex");
  const format = parsed.extra_info?.audio_format ?? body.audio_setting.format;
  const mime = format === "wav" ? "audio/wav" : format === "pcm" ? "audio/pcm" : "audio/mpeg";
  return { bytes, mime };
}
