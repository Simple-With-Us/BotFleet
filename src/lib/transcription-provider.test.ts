import { describe, expect, it } from "vitest";

import { emptyCloudSttCapabilities } from "../../shared/voice-providers.ts";
import { pickSTTProvider, type ProviderPickerInput } from "./transcription-provider";

const base: ProviderPickerInput = {
  cloudStt: emptyCloudSttCapabilities(),
  appleSpeechAvailable: true,
  explicitPreference: undefined,
  platform: "darwin",
};

function withAssemblyAi(): ProviderPickerInput {
  return {
    ...base,
    cloudStt: { ...emptyCloudSttCapabilities(), assemblyai: true },
  };
}

function withUnbridgedProvider(provider: "xai" | "meta" | "azure" | "groq"): ProviderPickerInput {
  const cloudStt = emptyCloudSttCapabilities();
  cloudStt[provider] = true;
  return { ...base, cloudStt };
}

describe("pickSTTProvider", () => {
  it("returns apple on macOS with no cloud key and no explicit preference", () => {
    expect(pickSTTProvider(base)).toEqual({ provider: "apple" });
  });

  it("returns assemblyai on macOS when a cloud key is configured", () => {
    expect(pickSTTProvider(withAssemblyAi())).toEqual({
      provider: "assemblyai",
      reason: "macos-with-key",
    });
  });

  it("returns assemblyai on Windows / Linux when a cloud key is configured", () => {
    expect(pickSTTProvider({ ...withAssemblyAi(), platform: "win32" })).toEqual({
      provider: "assemblyai",
      reason: "platform-default",
    });
    expect(pickSTTProvider({ ...withAssemblyAi(), platform: "linux" })).toEqual({
      provider: "assemblyai",
      reason: "platform-default",
    });
  });

  it("prefers assemblyai when meta is configured but not bridged in this build", () => {
    expect(pickSTTProvider({
      ...base,
      cloudStt: { ...emptyCloudSttCapabilities(), meta: true, assemblyai: true },
    })).toEqual({ provider: "assemblyai", reason: "macos-with-key" });
  });

  it.each(["xai", "meta", "azure", "groq"] as const)(
    "keeps Apple dictation available when only %s is configured without a shipped bridge",
    (provider) => {
      const input = withUnbridgedProvider(provider);
      expect(pickSTTProvider(input)).toEqual({ provider: "apple" });
      expect(pickSTTProvider({ ...input, explicitPreference: provider })).toEqual({ provider: "apple" });
    },
  );

  it("honours callStt.ladder order among bridged providers", () => {
    expect(pickSTTProvider({
      ...withAssemblyAi(),
      ladder: ["groq", "assemblyai"],
    })).toEqual({ provider: "assemblyai", reason: "macos-with-key" });
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
      pickSTTProvider({ ...withAssemblyAi(), explicitPreference: "apple" }),
    ).toEqual({ provider: "apple" });
  });

  it("honours an explicit assemblyai preference on macOS when a cloud key is present", () => {
    expect(
      pickSTTProvider({ ...withAssemblyAi(), explicitPreference: "assemblyai" }),
    ).toEqual({ provider: "assemblyai", reason: "user-preference" });
  });

  it("ignores an explicit apple preference on Windows / Linux (apple is not reachable)", () => {
    expect(
      pickSTTProvider({
        ...withAssemblyAi(),
        platform: "win32",
        explicitPreference: "apple",
      }),
    ).toEqual({ provider: "assemblyai", reason: "platform-default" });
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
