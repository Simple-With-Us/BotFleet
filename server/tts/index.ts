// Voice, wired to config. Three engines live behind this file: MiniMax
// (minimax.ts, the default; needs a key), ElevenLabs (elevenlabs.ts), and the Mac's built-in voices
// (system-voices.ts, no key).  This file is only the part that reads
// ~/.botfleet/config.json, picks the engine, and decides whether there
// is a voice at all.
import type { AppConfig } from "../config.ts";
import * as minimax from "./minimax.ts";
import * as systemVoices from "./system-voices.ts";

export type VoiceProvider = "minimax" | "system";

export class NoVoiceConfigured extends Error {
  // a plain field rather than a constructor parameter property: the harness
  // runs under `node --experimental-strip-types`, which is strip-ONLY, so a
  // parameter property is rejected at load time even though it typechecks
  readonly reason: "key" | "voice";

  constructor(reason: "key" | "voice") {
    super(
      reason === "key"
        ? "Add a MiniMax key in Settings on the computer to turn on voice."
        : "Pick a voice in the agent profile.",
    );
    this.reason = reason;
  }
}

export function voiceProvider(cfg: AppConfig): VoiceProvider {
  if (cfg.tts?.provider === "system") return "system";
  // Default to MiniMax.  Legacy configs with provider: "elevenlabs" fall
  // through here and use MiniMax — ElevenLabs support was removed.
  return "minimax";
}

/** The system provider needs no credential — it is only ever offered where
 * the platform actually has it, so "configured" means "this engine can
 * speak", not "a key is on file". */
export function providerConfigured(cfg: AppConfig): boolean {
  const provider = voiceProvider(cfg);
  if (provider === "system") return systemVoices.systemVoicesAvailable();
  return Boolean(cfg.tts?.key);
}

export function voiceConfigured(cfg: AppConfig): boolean {
  if (voiceProvider(cfg) === "system") {
    return systemVoices.systemVoicesAvailable() && Boolean(cfg.tts?.voice);
  }
  return Boolean(cfg.tts?.key && cfg.tts?.voice);
}

/** A per-bot voice is a complete choice too; it should not be blocked just
 * because the app-wide fallback has not been selected yet. */
export function voiceReady(cfg: AppConfig, voiceId?: string): boolean {
  if (voiceProvider(cfg) === "system") {
    return systemVoices.systemVoicesAvailable() && Boolean(voiceId || cfg.tts?.voice);
  }
  return Boolean(cfg.tts?.key && (voiceId || cfg.tts?.voice));
}

/** What the settings panel needs. Never includes the key — same write-only
 * rule as every other credential. */
export function describeVoice(cfg: AppConfig) {
  return {
    configured: providerConfigured(cfg),
    ready: voiceConfigured(cfg),
    voice: cfg.tts?.voice || "",
    provider: voiceProvider(cfg),
    optimizedSummary: cfg.tts?.optimizedSummary === true,
  };
}

export function verifyKey(key: string, _cfg: AppConfig) {
  return minimax.verifyKey(key);
}

export async function listVoices(cfg: AppConfig, run?: systemVoices.Runner): Promise<minimax.Voice[]> {
  if (voiceProvider(cfg) === "system") return systemVoices.listSystemVoices(run);
  const key = cfg.tts?.key;
  let voices: minimax.Voice[] = [];
  if (key) {
    try {
      voices = await minimax.listVoices(key);
    } catch {
      voices = [...minimax.listClonedVoices(), ...minimax.CANNED_VOICES];
    }
  } else {
    voices = [...minimax.listClonedVoices(), ...minimax.CANNED_VOICES];
  }
  if (cfg.tts?.voice && !voices.some((v) => v.id === cfg.tts?.voice)) {
    const defaultVoiceId = cfg.tts.voice;
    voices.unshift({ id: defaultVoiceId, label: defaultVoiceId, description: "Workspace default" });
  }
  return voices;
}

export function addCustomVoice(voiceId: string, label?: string) {
  return minimax.addCustomVoice(voiceId, label);
}

export function deleteCustomVoice(voiceId: string) {
  return minimax.deleteCustomVoice(voiceId);
}

export function listCustomVoices() {
  return minimax.listClonedVoices();
}

/** Synthesize one utterance. Throws NoVoiceConfigured when there is nothing
 * to speak with, which the route turns into a 409 the client can explain. */
export function speak(cfg: AppConfig, text: string, voiceId?: string, run?: systemVoices.Runner) {
  if (voiceProvider(cfg) === "system") {
    const voice = voiceId || cfg.tts?.voice;
    // An injected runner is the cross-platform test seam for `/usr/bin/say`;
    // production calls omit it and remain strictly Darwin-gated.
    if (!systemVoices.systemVoicesAvailable() && !run) throw new NoVoiceConfigured("key");
    if (!voice) throw new NoVoiceConfigured("voice");
    return systemVoices.synthesizeSystem(text, voice, run);
  }
  const key = cfg.tts?.key;
  if (!key) throw new NoVoiceConfigured("key");
  const voice = voiceId || cfg.tts?.voice;
  if (!voice) throw new NoVoiceConfigured("voice");
  return minimax.synthesize(text, voice, key);
}

/** Clone a voice.  The harness route unpacks the base64 body and passes
 * { voiceId, audioBase64 } so this thin adapter normalises the shape. */
export async function cloneVoice(
  cfg: AppConfig,
  { voiceId, audioBase64, filename }: { voiceId: string; audioBase64: string; filename: string },
) {
  const key = cfg.tts?.key;
  if (voiceProvider(cfg) !== "minimax") throw new Error("Switch to MiniMax to clone a voice.");
  if (!key) throw new Error("No MiniMax key is configured.");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(audioBase64) || audioBase64.length % 4 !== 0) throw new Error("Audio data is not valid base64.");
  const buffer = Buffer.from(audioBase64, "base64");
  return minimax.cloneVoice(buffer, filename, voiceId, key);
}

export type { Voice } from "./minimax.ts";
