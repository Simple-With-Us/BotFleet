// The policy a paired phone depends on when it asks this computer for a voice
// token.  The invariant under test: the phone learns whether a provider is
// set up and receives a short-lived token, and never a permanent key.
import { describe, expect, it } from "vitest";
import {
  resolveStsProvider,
  StsMintThrottle,
  stsKeyStatus,
  stsUnavailableReason,
} from "./sts-access.ts";

describe("key status", () => {
  it("reports configured-or-not without exposing anything else", () => {
    const status = stsKeyStatus((provider) => (provider === "xai" ? "secret-key" : undefined));
    expect(status).toEqual({ xai: true, gemini: false });
    // A boolean about the key, not the key.
    expect(JSON.stringify(status)).not.toContain("secret-key");
  });

  it("distinguishes 'could not read the keys' from 'no keys'", () => {
    const unreadable = stsKeyStatus(() => {
      throw new Error("keychain locked");
    });
    expect(unreadable).toBeNull();
    const empty = stsKeyStatus(() => undefined);
    expect(empty).toEqual({ xai: false, gemini: false });
  });
});

describe("unavailability is truthful and actionable", () => {
  it("names the missing key when the caller asked for one that has none", () => {
    const refusal = stsUnavailableReason("xai", { xai: false, gemini: true });
    expect(refusal?.status).toBe(409);
    expect(refusal?.error).toContain("xAI API key");
    // The sentence says where the fix lives, which is the Mac.
    expect(refusal?.error).toContain("your Mac");
  });

  it("never claims a key is missing when the read itself failed", () => {
    const refusal = stsUnavailableReason("xai", null);
    expect(refusal?.status).toBe(503);
    expect(refusal?.error).not.toMatch(/no .*key/i);
  });

  it("rejects a provider it does not implement rather than guessing one", () => {
    expect(stsUnavailableReason("openai", { xai: true, gemini: true })?.status).toBe(400);
    expect(stsUnavailableReason(undefined, { xai: true, gemini: true })?.status).toBe(400);
  });

  it("allows a provider that is configured", () => {
    expect(stsUnavailableReason("gemini", { xai: true, gemini: true })).toBeNull();
  });
});

describe("provider resolution matches the desktop", () => {
  it("falls back rather than failing when a preference has no key", () => {
    expect(resolveStsProvider({ xai: false, gemini: true }, "xai")).toEqual({
      provider: "gemini",
      reason: "auto-preference",
    });
  });

  it("reports unknown rather than assuming no keys when the read failed", () => {
    expect(resolveStsProvider(null, "xai")).toEqual({ provider: null, reason: "unknown" });
  });

  it("ignores a preference that is not a provider it knows", () => {
    expect(resolveStsProvider({ xai: true, gemini: true }, "openai")).toEqual({
      provider: "xai",
      reason: "auto-only-key",
    });
  });
});

describe("mint throttle", () => {
  it("allows one token per provider per window", () => {
    let now = 1_000;
    const throttle = new StsMintThrottle(10_000, () => now);
    expect(throttle.take("xai")).toBe(true);
    expect(throttle.take("xai")).toBe(false);
    // A different provider is not blocked by the first one's traffic.
    expect(throttle.take("gemini")).toBe(true);
    now += 10_001;
    expect(throttle.take("xai")).toBe(true);
  });

  it("can be reset when the caller needs to re-probe", () => {
    const throttle = new StsMintThrottle(10_000, () => 1_000);
    expect(throttle.take("xai")).toBe(true);
    expect(throttle.take("xai")).toBe(false);
    throttle.reset();
    expect(throttle.take("xai")).toBe(true);
  });
});