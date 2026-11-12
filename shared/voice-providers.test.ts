import { describe, expect, it } from "vitest";

import {
  DEFAULT_CLOUD_STT_LADDER,
  DEFAULT_TTS_LADDER,
  cloudSttCapabilitiesFromConfig,
  resolveCloudSttLadder,
  resolveHostedTtsLadder,
  type VoiceProviderConfig,
} from "./voice-providers.ts";

describe("voice provider ladders", () => {
  it("defaults match the research ordering", () => {
    expect(DEFAULT_TTS_LADDER).toEqual(["xai", "azure", "minimax"]);
    expect(DEFAULT_CLOUD_STT_LADDER).toEqual(["meta", "xai", "assemblyai", "azure", "groq"]);
  });

  it("filters the TTS ladder to providers with credentials", () => {
    const cfg: VoiceProviderConfig = {
      xai: { key: "xai-key" },
      azureSpeech: { key: "az-key", region: "eastus" },
      tts: { key: "mm-key" },
    };
    expect(resolveHostedTtsLadder(cfg)).toEqual(["xai", "azure", "minimax"]);
  });

  it("pins the explicit TTS provider ahead of the ladder", () => {
    const cfg: VoiceProviderConfig = {
      xai: { key: "xai-key" },
      azureSpeech: { key: "az-key", region: "eastus" },
      tts: { key: "mm-key", provider: "minimax" },
    };
    expect(resolveHostedTtsLadder(cfg)).toEqual(["minimax", "xai", "azure"]);
  });

  it("honours a custom TTS ladder override", () => {
    const cfg: VoiceProviderConfig = {
      xai: { key: "xai-key" },
      azureSpeech: { key: "az-key", region: "eastus" },
      tts: { key: "mm-key", ladder: ["minimax", "xai"] },
    };
    expect(resolveHostedTtsLadder(cfg)).toEqual(["minimax", "xai", "azure"]);
  });

  it("falls through cloud STT providers in ladder order", () => {
    const cfg: VoiceProviderConfig = {
      metaSpeech: { key: "meta" },
      xai: { key: "xai" },
      assemblyai: { key: "aai" },
      callStt: { provider: "xai" },
    };
    expect(resolveCloudSttLadder(cfg)).toEqual(["xai", "meta", "assemblyai"]);
  });

  it("reports per-provider cloud STT capability", () => {
    const cfg: VoiceProviderConfig = {
      xai: { key: "xai" },
      groq: { key: "groq" },
    };
    expect(cloudSttCapabilitiesFromConfig(cfg)).toEqual({
      meta: false,
      xai: true,
      assemblyai: false,
      azure: false,
      groq: true,
    });
  });
});
