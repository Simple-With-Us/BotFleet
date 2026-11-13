import { describe, expect, it } from "vitest";

import { emptyCloudSttCapabilities } from "../../shared/voice-providers.ts";
import { pickSTTProvider, type ProviderPickerInput } from "./transcription-provider";

const base: ProviderPickerInput = {
  cloudStt: emptyCloudSttCapabilities(),
  appleSpeechAvailable: true,
  explicitPreference: undefined,
  platform: "darwin",
};

function withCloud(overrides: Partial<ProviderPickerInput["cloudStt"]> = {}): ProviderPickerInput {
  return {
    ...base,
    cloudStt: { ...emptyCloudSttCapabilities(), ...overrides },
  };
}

function withUnbridgedProvider(provider: "meta" | "azure" | "groq"): ProviderPickerInput {
  const cloudStt = emptyCloudSttCapabilities();
  cloudStt[provider] = true;
  return { ...base, cloudStt };
}

describe("pickSTTProvider", () => {
  it("returns apple on macOS with no cloud key and no explicit preference", () => {
    expect(pickSTTProvider(base)).toEqual({ provider: "apple" });
  });

  it("keeps apple on macOS even when xAI or AssemblyAI keys are present", () => {
    expect(pickSTTProvider(withCloud({ xai: true, assemblyai: true }))).toEqual({ provider: "apple" });
  });

  it("returns xAI on Windows / Linux when an xAI key is present, ahead of AssemblyAI", () => {
    const input = {
      ...withCloud({ xai: true, assemblyai: true }),
      appleSpeechAvailable: false,
      platform: "win32" as const,
    };
    expect(pickSTTProvider(input)).toEqual({
      provider: "xai",
      reason: "platform-default",
    });
    expect(pickSTTProvider({ ...input, platform: "linux" })).toEqual({
      provider: "xai",
      reason: "platform-default",
    });
  });

  it("returns assemblyai on Windows / Linux when only an AssemblyAI key is configured", () => {
    expect(pickSTTProvider({
      ...withCloud({ assemblyai: true }),
      platform: "win32",
      appleSpeechAvailable: false,
    })).toEqual({
      provider: "assemblyai",
      reason: "platform-default",
    });
  });

  it("prefers assemblyai over unbridged meta on platforms without Apple STT", () => {
    expect(pickSTTProvider({
      ...base,
      platform: "win32",
      appleSpeechAvailable: false,
      cloudStt: { ...emptyCloudSttCapabilities(), meta: true, assemblyai: true },
    })).toEqual({ provider: "assemblyai", reason: "platform-default" });
  });

  it.each(["meta", "azure", "groq"] as const)(
    "keeps Apple dictation available when only %s is configured without a shipped bridge",
    (provider) => {
      const input = withUnbridgedProvider(provider);
      expect(pickSTTProvider(input)).toEqual({ provider: "apple" });
      expect(pickSTTProvider({ ...input, explicitPreference: provider })).toEqual({ provider: "apple" });
    },
  );

  it("honours callStt.ladder order among bridged providers when Apple is unavailable", () => {
    expect(pickSTTProvider({
      ...withCloud({ xai: true, assemblyai: true }),
      appleSpeechAvailable: false,
      platform: "linux",
      ladder: ["assemblyai", "xai"],
    })).toEqual({ provider: "assemblyai", reason: "platform-default" });
  });

  it("returns no-provider on Windows / Linux without a cloud key, with the missing key surfaced", () => {
    expect(pickSTTProvider({ ...base, platform: "win32" })).toEqual({
      provider: null,
      reason: "no-provider",
      missing: "cloud-stt-key",
    });
  });

  it("returns no-provider on macOS when Apple STT is unavailable (helper build failed)", () => {
    expect(
      pickSTTProvider({ ...base, appleSpeechAvailable: false }),
    ).toEqual({
      provider: null,
      reason: "no-provider",
      missing: "apple-bridge-unavailable",
    });
  });

  it("honours an explicit apple preference on macOS even when a cloud key is present", () => {
    expect(
      pickSTTProvider({ ...withCloud({ assemblyai: true }), explicitPreference: "apple" }),
    ).toEqual({ provider: "apple" });
  });

  it("honours an explicit xAI preference when the key is present", () => {
    expect(
      pickSTTProvider({ ...withCloud({ xai: true }), explicitPreference: "xai" }),
    ).toEqual({ provider: "xai", reason: "user-preference" });
  });

  it("honours an explicit assemblyai preference on macOS when a cloud key is present", () => {
    expect(
      pickSTTProvider({ ...withCloud({ assemblyai: true }), explicitPreference: "assemblyai" }),
    ).toEqual({ provider: "assemblyai", reason: "user-preference" });
  });

  it("ignores an explicit apple preference on Windows / Linux (apple is not reachable)", () => {
    expect(
      pickSTTProvider({
        ...withCloud({ assemblyai: true }),
        platform: "win32",
        explicitPreference: "apple",
      }),
    ).toEqual({ provider: "assemblyai", reason: "platform-default" });
  });

  it("falls back from an explicit unbridged preference to a bridged cloud provider", () => {
    expect(
      pickSTTProvider({
        ...withCloud({ meta: true, assemblyai: true }),
        appleSpeechAvailable: false,
        platform: "linux",
        explicitPreference: "meta",
      }),
    ).toEqual({ provider: "assemblyai", reason: "ladder-fallback" });
  });

  it("ignores an explicit assemblyai preference when no cloud key is set", () => {
    expect(
      pickSTTProvider({ ...base, explicitPreference: "assemblyai" }),
    ).toEqual({ provider: "apple" });
    expect(
      pickSTTProvider({ ...base, explicitPreference: "assemblyai", platform: "win32" }),
    ).toEqual({ provider: null, reason: "no-provider", missing: "cloud-stt-key" });
  });
});
