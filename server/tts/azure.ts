import type { Audio, VerifyResult, Voice } from "./types.ts";
import { recordSpeechUsage } from "./usage.ts";

const DEFAULT_VOICE = "en-US-JennyNeural";

export const CANNED_VOICES: Voice[] = [
  { id: "en-US-JennyNeural", label: "Jenny", description: "Azure Neural · US English" },
  { id: "en-US-GuyNeural", label: "Guy", description: "Azure Neural · US English" },
  { id: "en-GB-SoniaNeural", label: "Sonia", description: "Azure Neural · UK English" },
];

function endpoint(region: string): string {
  const host = region.trim().toLowerCase();
  return `https://${host}.tts.speech.microsoft.com/cognitiveservices/v1`;
}

function ssml(text: string, voice: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
  return `<speak version="1.0" xml:lang="en-US"><voice name="${voice}">${escaped}</voice></speak>`;
}

export async function verifyKey(key: string, region: string): Promise<VerifyResult> {
  const secret = key.trim();
  const area = region.trim();
  if (!secret || !area) return { ok: false, message: "Add an Azure Speech key and region in Connections." };
  try {
    const response = await fetch(endpoint(area), {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": secret,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      },
      body: ssml("ok", DEFAULT_VOICE),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: "Azure Speech rejected this API key." };
    }
    if (!response.ok) {
      return { ok: false, message: `Azure Speech check failed (HTTP ${response.status}).` };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: "Could not reach Azure Speech. Check the region and connection." };
  }
}

export async function synthesize(text: string, voiceId: string, key: string, region: string): Promise<Audio> {
  const secret = key.trim();
  const area = region.trim();
  if (!secret || !area) throw new Error("Add an Azure Speech key and region in Connections.");
  const voice = voiceId.trim() || DEFAULT_VOICE;
  const response = await fetch(endpoint(area), {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": secret,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
    },
    body: ssml(text, voice),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("Azure Speech rejected this API key.");
    throw new Error(`Azure Speech failed (HTTP ${response.status}).`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  recordSpeechUsage("azure", text.length, "provider");
  return { bytes, mime: "audio/mpeg" };
}
