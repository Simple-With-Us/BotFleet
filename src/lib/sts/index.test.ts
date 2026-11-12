import { describe, expect, it } from "vitest";
import { pickStsProvider, STS_PROVIDERS, type StsCapability } from "./index";

const base: StsCapability = {
  platform: "darwin",
  keys: {},
  bridgeAvailable: true,
};

describe("pickStsProvider", () => {
  it("reports no provider when nothing is configured", () => {
    expect(pickStsProvider(base)).toEqual({ provider: null, reason: "no-provider", missing: "key" });
  });

  it("reports a missing bridge distinctly from a missing key", () => {
    expect(pickStsProvider({ ...base, bridgeAvailable: false })).toEqual({
      provider: null,
      reason: "not-supported",
      missing: "bridge",
    });
  });

  it("uses the only configured key under Auto", () => {
    expect(pickStsProvider({ ...base, keys: { gemini: true } })).toEqual({
      provider: "gemini",
      reason: "auto-only-key",
    });
  });

  it("prefers the earlier provider in the list when both are configured", () => {
    expect(pickStsProvider({ ...base, keys: { xai: true, gemini: true } })).toEqual({
      provider: "xai",
      reason: "auto-only-key",
    });
  });

  it("honours an explicit preference that has a key", () => {
    expect(
      pickStsProvider({ ...base, keys: { xai: true, gemini: true }, explicitPreference: "gemini" }),
    ).toEqual({ provider: "gemini", reason: "user-preference" });
  });

  it("degrades to Auto when the preferred provider has no key", () => {
    expect(
      pickStsProvider({ ...base, keys: { xai: true }, explicitPreference: "gemini" }),
    ).toEqual({ provider: "xai", reason: "auto-preference" });
  });

  it("reports a missing key when the preference is unusable and nothing is configured", () => {
    expect(pickStsProvider({ ...base, explicitPreference: "gemini" })).toEqual({
      provider: null,
      reason: "no-provider",
      missing: "key",
    });
  });

  it("treats an explicitly-null preference as Auto", () => {
    expect(
      pickStsProvider({ ...base, keys: { gemini: true }, explicitPreference: null }),
    ).toEqual({ provider: "gemini", reason: "auto-only-key" });
  });
});

describe("STS_PROVIDERS", () => {
  it("is a non-empty, duplicate-free preference order", () => {
    expect(STS_PROVIDERS.length).toBeGreaterThan(0);
    expect(new Set(STS_PROVIDERS).size).toBe(STS_PROVIDERS.length);
  });
});