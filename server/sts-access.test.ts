// The policy a paired phone depends on when it asks this computer for a voice
// token.  The invariant under test: the phone learns whether a provider is
// set up and receives a short-lived token, and never a permanent key.
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";

import {
  resolveStsProvider,
  StsErrorBodySchema,
  StsMintThrottle,
  StsStatusSchema,
  stsKeyStatus,
  stsSessionTelemetry,
  stsStatusBody,
  stsTokenRequest,
  stsUnavailableReason,
  type StsErrorBody,
  type StsStatus,
  type StsTokenRequest,
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
    // The route parses the body first, so an unimplemented name arrives as
    // null rather than as the string it was.
    expect(stsUnavailableReason(null, { xai: true, gemini: true })?.status).toBe(400);
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
    expect(resolveStsProvider({ xai: true, gemini: true }, null)).toEqual({
      provider: "xai",
      reason: "auto-only-key",
    });
  });
});

describe("the status schema is the type the route publishes", () => {
  it("infers each added schema instead of a hand-written mirror", () => {
    expectTypeOf<StsStatus>().toEqualTypeOf<z.infer<typeof StsStatusSchema>>();
    expectTypeOf<StsTokenRequest>().toEqualTypeOf<z.infer<typeof stsTokenRequest>>();
    expectTypeOf<StsErrorBody>().toEqualTypeOf<z.infer<typeof StsErrorBodySchema>>();
  });

  it("publishes the key booleans and the provider a call would use", () => {
    // Preference has no key, so Auto takes Gemini.  The body is that
    // decision, not a second copy of the preference.
    expect(stsStatusBody({ xai: false, gemini: true }, "xai")).toEqual({
      xai: false,
      gemini: true,
      provider: "gemini",
    });
  });

  it("refuses a body that drops the provider or smuggles another field", () => {
    expect(StsStatusSchema.safeParse({ xai: true, gemini: false }).success).toBe(false);
    expect(
      StsStatusSchema.safeParse({ xai: true, gemini: false, provider: null, token: "secret" }).success,
    ).toBe(false);
    expect(StsStatusSchema.safeParse({ xai: true, gemini: false, provider: "openai" }).success).toBe(false);
  });
});

describe("the request body is parsed at the door", () => {
  it("accepts only the two providers it mints for", () => {
    expect(stsTokenRequest.safeParse({ provider: "xai" }).success).toBe(true);
    expect(stsTokenRequest.safeParse({ provider: "gemini" }).success).toBe(true);
    // A name it does not implement must not reach the mint path.
    expect(stsTokenRequest.safeParse({ provider: "openai" }).success).toBe(false);
    expect(stsTokenRequest.safeParse({}).success).toBe(false);
    expect(stsTokenRequest.safeParse({ provider: 7 }).success).toBe(false);
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
describe("a started voice-call session is reported to Usage Monitor (BF-2435)", () => {
  it("names the vendor and the realtime model, and measures only that a session began", () => {
    expect(stsSessionTelemetry("gemini")).toEqual({
      kind: "sts-session",
      provider: "google-ai",
      service: "gemini-3.8-live",
      label: "BotFleet voice call",
    });
    expect(stsSessionTelemetry("xai")).toMatchObject({ kind: "sts-session", provider: "xai", service: "grok-voice-latest" });
  });

  it("carries no key, token or price", () => {
    for (const provider of ["xai", "gemini"] as const) {
      expect(Object.keys(stsSessionTelemetry(provider)).sort()).toEqual(["kind", "label", "provider", "service"]);
    }
  });
});
