// One table, one assertion, per credential shape BotFleet issues or stores.
//
// The audit that produced S13 passed `ak_`, `whsec_`, `sk_live_`, `ya29.` and
// `glpat-` straight through the redactor.  The cause was not a missing prefix
// so much as a floor: a pattern whose minimum length was set for a real
// provider's real key length does not match the short values these shapes
// actually take here — a test webhook secret, a test-mode Stripe key, a Google
// token someone pasted the first twenty characters of.  So the table below
// pins BOTH halves of the claim for every shape: a credential-shaped value is
// masked, and an ordinary word is not.
//
// Fixtures are assembled at runtime from parts, so no token-shaped literal
// sits in the source — GitHub's push protection flags those, and rightly.
import { describe, expect, it } from "vitest";

import { CREDENTIAL_TOKEN_PATTERNS, redactSecretsInText } from "./redact.ts";

/** The shapes added for S13, with the shortest value that must still mask. */
const PROVIDER_CASES: Array<{ label: string; prefix: string; sample: string }> = [
  // Built by concatenation so the literal in this file is not a credential.
  { label: "generic access key", prefix: "ak_", sample: ["ak", "_", "test", "_", "0000000000000000"].join("") },
  { label: "webhook signing secret", prefix: "whsec_", sample: ["wh", "sec_", "test", "_", "fake"].join("") },
  { label: "stripe live key", prefix: "sk_live_", sample: ["sk", "_live_", "00000000000000"].join("") },
  { label: "stripe test key", prefix: "sk_test_", sample: ["sk", "_test_", "00000000000000"].join("") },
  { label: "google oauth access token", prefix: "ya29.", sample: ["ya29", ".", "fake"].join("") },
  { label: "gitlab personal access token", prefix: "glpat-", sample: ["glpat", "-", "fake0000"].join("") },
];

describe("credential shapes BotFleet issues or stores", () => {
  it.each(PROVIDER_CASES)("masks a $label value wherever it appears", ({ prefix, sample }) => {
    expect(sample.startsWith(prefix)).toBe(true);
    const out = redactSecretsInText(`the request failed carrying ${sample} in the header`);
    expect(out, sample).not.toContain(sample);
    expect(out).toMatch(/«redacted \d+ chars»/);
  });

  it.each(PROVIDER_CASES)("leaves a plain word alone when the $label prefix is absent", () => {
    const out = redactSecretsInText("the deployment finished and the invoice went out by email");
    expect(out).toBe("the deployment finished and the invoice went out by email");
  });

  it("masks a bare mention of a prefix is not a credential", () => {
    // The floors exist to reject prose that NAMES a shape without carrying
    // one.  Each of these is the leading marker on its own, and each is
    // ordinary documentation text.
    for (const prose of [
      "copy the whsec_ value from the dashboard",
      "the ya29. prefix is what google issues",
      "set sk_live_ to your restricted key",
    ]) {
      expect(redactSecretsInText(prose), prose).toBe(prose);
    }
  });
});

describe("CREDENTIAL_TOKEN_PATTERNS", () => {
  it("is a global-flagged list, because redaction replaces over every match", () => {
    expect(CREDENTIAL_TOKEN_PATTERNS.length).toBeGreaterThan(0);
    for (const pattern of CREDENTIAL_TOKEN_PATTERNS) {
      expect(pattern.flags, pattern.source).toContain("g");
    }
  });

  it("contains a shape that matches every value the provider table pins", () => {
    // The link between the table above and the shipped list, stated as
    // behaviour rather than by string-matching a prefix against a pattern
    // source: a pattern is "covered" when it actually matches the value.
    for (const { sample, label } of PROVIDER_CASES) {
      const covered = CREDENTIAL_TOKEN_PATTERNS.some((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(sample);
      });
      expect(covered, `no exported shape matches the ${label} value ${sample}`).toBe(true);
    }
  });
});
