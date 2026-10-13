import type { Audio, VerifyResult, Voice } from "./types.ts";
import { recordSpeechUsage } from "./usage.ts";

const API = "https://api.x.ai/v1/tts";
const DEFAULT_VOICE = "eve";

export const CANNED_VOICES: Voice[] = [
  { id: "eve", label: "Eve", description: "xAI · default" },
  { id: "ara", label: "Ara", description: "xAI" },
  { id: "rex", label: "Rex", description: "xAI" },
  { id: "sal", label: "Sal", description: "xAI" },
  { id: "leo", label: "Leo", description: "xAI" },
];

export async function verifyKey(key: string): Promise<VerifyResult> {
  const secret = key.trim();
  if (!secret) return { ok: false, message: "Add an xAI API key in Connections." };
  try {
    const response = await fetch(API, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "ok", voice_id: DEFAULT_VOICE, language: "en" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: "xAI rejected this API key." };
    }
    if (!response.ok) {
      return { ok: false, message: `xAI voice check failed (HTTP ${response.status}).` };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: "Could not reach xAI. Check your connection." };
  }
}

export async function synthesize(text: string, voiceId: string, key: string): Promise<Audio> {
  const secret = key.trim();
  if (!secret) throw new Error("Add an xAI API key in Connections.");
  const response = await fetch(API, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      text,
      voice_id: voiceId.trim() || DEFAULT_VOICE,
      language: "en",
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("xAI rejected this API key.");
    throw new Error(`xAI speech failed (HTTP ${response.status}).`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  recordSpeechUsage("xai", text.length, "provider");
  return { bytes, mime: response.headers.get("content-type")?.split(";")[0]?.trim() || "audio/mpeg" };
}
