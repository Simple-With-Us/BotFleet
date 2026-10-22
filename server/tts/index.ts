// Voice, wired to config. Three engines live behind this file: MiniMax
// (minimax.ts, the default; needs a key), ElevenLabs (elevenlabs.ts), and the Mac's built-in voices
// (system-voices.ts, no key).  This file is only the part that reads
// ~/.botfleet/config.json, picks the engine, and decides whether there
// is a voice at all.
import { isPersonalVoiceId, readableVoiceId } from "../../shared/bot-voice.ts";
import { applyPronunciations, effectivePronunciations, type Pronunciation } from "../../shared/pronunciations.ts";
import { stripPauseTags } from "../../shared/spoken-script.ts";
import type { AppConfig } from "../config.ts";
import * as azure from "./azure.ts";
import * as minimax from "./minimax.ts";
import * as systemVoices from "./system-voices.ts";
import * as xai from "./xai.ts";

import {
  type HostedTtsProvider,
  type TtsProvider,
  isHostedTtsProvider,
  parseTtsProvider,
  resolveHostedTtsLadder,
} from "../../shared/voice-providers.ts";
import { speakWithFallback } from "./provider-ladder.ts";

export type VoiceProvider = TtsProvider;
export { NoVoiceConfigured } from "./errors.ts";
import { NoVoiceConfigured } from "./errors.ts";

export function voiceProvider(cfg: AppConfig): VoiceProvider {
  const explicit = parseTtsProvider(cfg.tts?.provider);
  if (explicit) return explicit;
  const ladder = resolveHostedTtsLadder(cfg);
  if (ladder.length) return ladder[0]!;
  // Legacy configs with provider: "elevenlabs" fall through here and use
  // MiniMax — ElevenLabs support was removed.
  return "minimax";
}

/** The system provider needs no credential — it is only ever offered where
 * the platform actually has it, so "configured" means "this engine can
 * speak", not "a key is on file". */
export function providerConfigured(cfg: AppConfig): boolean {
  const provider = voiceProvider(cfg);
  if (provider === "system") return systemVoices.systemVoicesAvailable();
  if (provider === "xai") return Boolean(cfg.xai?.key);
  if (provider === "azure") return Boolean(cfg.azureSpeech?.key && cfg.azureSpeech?.region);
  return Boolean(cfg.tts?.key);
}

export function voiceConfigured(cfg: AppConfig): boolean {
  if (isPersonalVoice(cfg.tts?.voice)) return true;
  if (voiceProvider(cfg) === "system") {
    return systemVoices.systemVoicesAvailable() && Boolean(cfg.tts?.voice);
  }
  return Boolean(cfg.tts?.key && cfg.tts?.voice);
}

/** The prefix rule lives in shared/bot-voice.ts so the clients and the
 * iOS mirror cannot drift from what the harness refuses to synthesize. */
export function isPersonalVoice(voiceId?: string): boolean {
  return isPersonalVoiceId(voiceId);
}

/** A per-bot voice is a complete choice too; it should not be blocked just
 * because the app-wide fallback has not been selected yet. */
export function voiceReady(cfg: AppConfig, voiceId?: string): boolean {
  if (isPersonalVoice(voiceId)) {
    // Apple Personal Voices speak on-device on authorized Apple devices (macOS / iOS).
    return true;
  }
  if (voiceProvider(cfg) === "system") {
    return systemVoices.systemVoicesAvailable() && Boolean(voiceId || cfg.tts?.voice);
  }
  return Boolean(cfg.tts?.key && (voiceId || cfg.tts?.voice));
}

/** The pronunciation list in force: the saved one, or the seeded defaults
 * when it has never been saved (shared/pronunciations.ts). */
export function pronunciations(cfg: AppConfig): readonly Pronunciation[] {
  return effectivePronunciations(cfg.tts?.pronunciations);
}

/** What the settings panel needs. Never includes the key — same write-only
 * rule as every other credential.  `voice` is the workspace default voice
 * (every bot without a voice of its own speaks with it); it is a setting,
 * not a secret, so both clients show it by name.  `pronunciations` is the
 * list in force, defaults included, so a client never has to know them. */
export function describeVoice(cfg: AppConfig) {
  return {
    configured: providerConfigured(cfg),
    ready: voiceConfigured(cfg),
    voice: cfg.tts?.voice || "",
    provider: voiceProvider(cfg),
    optimizedSummary: cfg.tts?.optimizedSummary === true,
    pronunciations: pronunciations(cfg).map((entry) => ({ term: entry.term, say: entry.say })),
  };
}

export function verifyKey(key: string, cfg: AppConfig) {
  const provider = voiceProvider(cfg);
  if (provider === "xai") return xai.verifyKey((cfg.xai?.key ?? key).trim());
  if (provider === "azure") {
    return azure.verifyKey((cfg.azureSpeech?.key ?? key).trim(), cfg.azureSpeech?.region ?? "");
  }
  return minimax.verifyKey(key);
}

export async function listVoices(cfg: AppConfig, run?: systemVoices.Runner): Promise<minimax.Voice[]> {
  const provider = voiceProvider(cfg);
  if (provider === "system") return systemVoices.listSystemVoices(run);
  if (provider === "xai") return [...xai.CANNED_VOICES];
  if (provider === "azure") return [...azure.CANNED_VOICES];
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
    voices.unshift({ id: defaultVoiceId, label: readableVoiceId(defaultVoiceId), description: "Workspace default" });
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
 * to speak with, which the route turns into a 409 the client can explain.
 *
 * The pronunciation list is applied here, the one layer every hosted and
 * built-in synthesis goes through (message clips, Try, call mode), and only
 * to the text sent to the engine: scripts and clip caches never see it, so a
 * list edit re-bills nothing and applies to new synthesis only.  The list is
 * idempotent (shared/pronunciations.ts), so text that already says "sequel"
 * is left as it is. */
export function speak(cfg: AppConfig, rawText: string, voiceId?: string, run?: systemVoices.Runner) {
  const provider = voiceProvider(cfg);
  let text = applyPronunciations(rawText, pronunciations(cfg));
  // MiniMax pause tags are for that engine only; macOS `say` reads them aloud
  // or truncates the utterance after the first marker.
  if (provider === "system") text = stripPauseTags(text);
  // The workspace default can be a Personal Voice too; it must never reach
  // a hosted engine as if it were one of that engine's ids.
  if (isPersonalVoice(voiceId || cfg.tts?.voice)) {
    throw new Error("Apple Personal Voices speak on-device on authorized Apple devices (macOS and iOS) and cannot be synthesized on the server.");
  }
  if (provider === "system") {
    const voice = voiceId || cfg.tts?.voice;
    if (!systemVoices.systemVoicesAvailable() && !run) throw new NoVoiceConfigured("key", "system");
    if (!voice) throw new NoVoiceConfigured("voice", "system");
  } else {
    const ladder = resolveHostedTtsLadder(cfg);
    const hosted: HostedTtsProvider = isHostedTtsProvider(provider) ? provider : "minimax";
    if (!ladder.length) throw new NoVoiceConfigured("key", hosted);
    if (provider === "minimax" && !(voiceId || cfg.tts?.voice)) throw new NoVoiceConfigured("voice", "minimax");
  }
  return speakWithFallback(cfg, text, voiceId, run);
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
