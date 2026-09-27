import { describe, expect, it } from "vitest";

import { pickSTTProvider, type ProviderPickerInput } from "./transcription-provider";

const base: PickInput = {
  cloudSttConfigured: false,
  appleSpeechAvailable: true,
  explicitPreference: undefined,
  platform: "darwin",
};
type PickInput = ProviderPickerInput;

describe("pickSTTProvider", () => {
  it("returns apple on macOS with no cloud key and no explicit preference", () => {
    expect(pickSTTProvider(base)).toEqual({ provider: "apple" });
  });

  it("returns assemblyai on macOS when a cloud key is configured", () => {
    expect(pickSTTProvider({ ...base, cloudSttConfigured: true })).toEqual({
      provider: "assemblyai",
      reason: "macos-with-key",
    });
  });

  it("returns assemblyai on Windows / Linux when a cloud key is configured", () => {
    expect(pickSTTProvider({ ...base, platform: "win32", cloudSttConfigured: true })).toEqual({
      provider: "assemblyai",
      reason: "platform-default",
    });
    expect(pickSTTProvider({ ...base, platform: "linux", cloudSttConfigured: true })).toEqual({
      provider: "assemblyai",
      reason: "platform-default",
    });
  });

  it("returns no-provider on Windows / Linux without a cloud key, with the missing key surfaced", () => {
    expect(pickSTTProvider({ ...base, platform: "win32" })).toEqual({
      provider: null,
      reason: "no-provider",
      missing: "cloud-stt-key",
    });
    expect(pickSTTProvider({ ...base, platform: "linux" })).toEqual({
      provider: null,
      reason: "no-provider",
      missing: "cloud-stt-key",
    });
  });

  it("returns no-provider on macOS when Apple STT is unavailable (helper build failed)", () => {
    expect(
      pickSTTProvider({ ...base, appleSpeechAvailable: false, cloudSttConfigured: false }),
    ).toEqual({
      provider: null,
      reason: "no-provider",
      missing: "apple-bridge-unavailable",
    });
  });

  it("honours an explicit apple preference on macOS even when a cloud key is present", () => {
    expect(
      pickSTTProvider({ ...base, cloudSttConfigured: true, explicitPreference: "apple" }),
    ).toEqual({ provider: "apple" });
  });

  it("honours an explicit assemblyai preference on macOS when a cloud key is present", () => {
    expect(
      pickSTTProvider({ ...base, cloudSttConfigured: true, explicitPreference: "assemblyai" }),
    ).toEqual({ provider: "assemblyai", reason: "user-preference" });
  });

  it("ignores an explicit apple preference on Windows / Linux (apple is not reachable)", () => {
    expect(
      pickSTTProvider({
        ...base,
        platform: "win32",
        cloudSttConfigured: true,
        explicitPreference: "apple",
      }),
    ).toEqual({ provider: "assemblyai", reason: "platform-default" });
  });

  it("ignores an explicit assemblyai preference when no cloud key is set", () => {
    expect(
      pickSTTProvider({ ...base, cloudSttConfigured: false, explicitPreference: "assemblyai" }),
    ).toEqual({ provider: "apple" });
    expect(
      pickSTTProvider({ ...base, cloudSttConfigured: false, explicitPreference: "assemblyai", platform: "win32" }),
    ).toEqual({ provider: null, reason: "no-provider", missing: "cloud-stt-key" });
  });
});