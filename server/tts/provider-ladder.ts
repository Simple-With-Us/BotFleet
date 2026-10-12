import type { AppConfig } from "../config.ts";
import {
  type HostedTtsProvider,
  resolveHostedTtsLadder,
} from "../../shared/voice-providers.ts";
import * as azure from "./azure.ts";
import * as minimax from "./minimax.ts";
import * as systemVoices from "./system-voices.ts";
import * as xai from "./xai.ts";
import type { Audio } from "./types.ts";
import { NoVoiceConfigured } from "./errors.ts";

function isSystemProvider(cfg: AppConfig): boolean {
  return cfg.tts?.provider === "system";
}

export class TtsProviderExhausted extends Error {
  readonly attempts: Array<{ provider: HostedTtsProvider; message: string }>;

  constructor(attempts: Array<{ provider: HostedTtsProvider; message: string }>) {
    const summary = attempts.map((a) => `${a.provider}: ${a.message}`).join("; ");
    super(summary || "No voice provider could synthesize this utterance.");
    this.attempts = attempts;
  }
}

async function synthesizeWithProvider(
  cfg: AppConfig,
  provider: HostedTtsProvider,
  text: string,
  voiceId?: string,
): Promise<Audio> {
  switch (provider) {
    case "minimax": {
      const key = cfg.tts?.key;
      if (!key) throw new NoVoiceConfigured("key");
      const voice = voiceId || cfg.tts?.voice;
      if (!voice) throw new NoVoiceConfigured("voice");
      return minimax.synthesize(text, voice, key);
    }
    case "xai": {
      const key = cfg.xai?.key;
      if (!key) throw new NoVoiceConfigured("key");
      const voice = voiceId || cfg.tts?.voice || xai.CANNED_VOICES[0]?.id;
      if (!voice) throw new NoVoiceConfigured("voice");
      return xai.synthesize(text, voice, key);
    }
    case "azure": {
      const key = cfg.azureSpeech?.key;
      const region = cfg.azureSpeech?.region;
      if (!key || !region) throw new NoVoiceConfigured("key");
      const voice = voiceId || cfg.tts?.voice || azure.CANNED_VOICES[0]?.id;
      if (!voice) throw new NoVoiceConfigured("voice");
      return azure.synthesize(text, voice, key, region);
    }
    default: {
      const _never: never = provider;
      throw new Error(`Unknown TTS provider: ${String(_never)}`);
    }
  }
}

/** Try each configured hosted provider in ladder order until one succeeds. */
export async function speakWithFallback(
  cfg: AppConfig,
  text: string,
  voiceId?: string,
  run?: systemVoices.Runner,
): Promise<Audio> {
  if (isSystemProvider(cfg)) {
    const voice = voiceId || cfg.tts?.voice;
    if (!systemVoices.systemVoicesAvailable() && !run) throw new NoVoiceConfigured("key");
    if (!voice) throw new NoVoiceConfigured("voice");
    return systemVoices.synthesizeSystem(text, voice, run);
  }

  const ladder = resolveHostedTtsLadder(cfg);
  if (!ladder.length) throw new NoVoiceConfigured("key");

  const failures: Array<{ provider: HostedTtsProvider; message: string }> = [];
  for (const provider of ladder) {
    try {
      return await synthesizeWithProvider(cfg, provider, text, voiceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof NoVoiceConfigured) throw error;
      failures.push({ provider, message });
    }
  }
  throw new TtsProviderExhausted(failures);
}
