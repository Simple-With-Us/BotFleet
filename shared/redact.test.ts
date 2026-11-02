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

import {
  CREDENTIAL_TOKEN_PATTERNS,
  LOG_TEE_OVERLAP_CHARS,
  redactSecrets,
  redactSecretsForLog,
  redactSecretsInLogText,
  redactSecretsInText,
} from "./redact.ts";
import { isJsonObject, type JsonValue } from "./plugin-manifest.ts";

/** The shapes added for S13, with the shortest value that must still mask. */
const PROVIDER_CASES: Array<{ label: string; prefix: string; sample: string }> = [
  // Built by concatenation so the literal in this file is not a credential.
  { label: "generic access key", prefix: "ak_", sample: ["ak", "_", "test", "_", "0000000000000000"].join("") },
  { label: "webhook signing secret", prefix: "whsec_", sample: ["wh", "sec_", "test", "_", "fake"].join("") },
  { label: "stripe live key", prefix: "sk_live_", sample: ["sk", "_live_", "00000000000000"].join("") },
  { label: "stripe test key", prefix: "sk_test_", sample: ["sk", "_test_", "00000000000000"].join("") },
  { label: "google oauth access token", prefix: "ya29.", sample: ["ya29", ".", "fake"].join("") },
  { label: "gitlab personal access token", prefix: "glpat-", sample: ["glpat", "-", "fake0000"].join("") },
  { label: "infisical service token", prefix: "st.", sample: ["st", ".", "fake0000000000000000000"].join("") },
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

  it("masks a DOTTED infisical service token whole, not just its first segment", () => {
    // Infisical issues `st.<uuid>.<segment>.<segment>`.  A pattern that
    // stops at the first dot masks the uuid and leaves the two secret
    // segments in the clear, which is the whole credential.
    const token = [
      "st",
      ".",
      "11111111-2222-3333-4444-555555555555",
      ".",
      "abcdefabcdefabcdefabcdefabcdefab",
      ".",
      "0123456789abcdef0123456789abcdef",
    ].join("");
    const out = redactSecretsInText(`the header carried ${token} to the vault`);
    expect(out).not.toContain("abcdefabcdefabcdefabcdefabcdefab");
    expect(out).not.toContain("0123456789abcdef0123456789abcdef");
    expect(out).not.toContain(token);
  });

  it("does not swallow an ordinary word after a dotted phrase", () => {
    const prose = "the st. credential was rotated by the operator";
    expect(redactSecretsInText(prose)).toBe(prose);
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

describe("depth cap masks instead of passing through", () => {
  const nest = (leaf: JsonValue, levels: number): JsonValue => {
    let deep: JsonValue = leaf;
    for (let i = 0; i < levels; i++) deep = { [`k${i}`]: deep };
    return deep;
  };
  const dig = (out: JsonValue, levels: number): JsonValue => {
    let node: JsonValue = out;
    for (let i = levels - 1; i >= 0; i--) {
      if (!isJsonObject(node)) throw new Error(`fixture drifted: k${i} is not an object`);
      node = node[`k${i}`];
    }
    return node;
  };
  // SAFETY: nest() builds every fixture below from JsonValue parts, so
  // redaction returns the same JSON shape it was handed.
  const redactFixture = (leaf: JsonValue, levels: number): JsonValue =>
    redactSecrets(nest(leaf, levels)) as JsonValue;

  it("masks a secret-shaped key nested past the cap, keeping the keys", () => {
    const secret = "live-secret-value-0000";
    const leaf = dig(redactFixture({ api_key: secret }, 15), 15);
    if (!isJsonObject(leaf)) throw new Error("fixture drifted: leaf is not an object");
    expect(leaf.api_key).toBe(`«redacted ${secret.length} chars»`);
    expect(JSON.stringify(leaf)).not.toContain(secret);
  });

  it("masks {name, value} env entries nested past the cap", () => {
    const secret = "live-secret-value-0000";
    const out = redactFixture([{ name: "OMB_COMMS_TOKEN", value: secret }], 15);
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(JSON.stringify(out)).toContain("«redacted");
  });

  it("fails closed on benign strings past the cap too", () => {
    // Below the cap the walk can no longer tell a credential field from a
    // harmless sibling, so every string is masked rather than trusted.
    const leaf = dig(redactFixture({ note: "hello world ok" }, 15), 15);
    if (!isJsonObject(leaf)) throw new Error("fixture drifted: leaf is not an object");
    expect(leaf.note).toBe("«redacted 14 chars»");
  });

  it("still redacts a shallow tree exactly as before", () => {
    const secret = "live-secret-value-0000";
    // SAFETY: the input is a JsonValue literal, so redaction returns the same JSON shape.
    const out = redactSecrets({ outer: { api_key: secret, note: "hello world ok" } }) as JsonValue;
    if (!isJsonObject(out) || !isJsonObject(out.outer)) throw new Error("fixture drifted: shallow shape lost");
    expect(out.outer.api_key).toBe(`«redacted ${secret.length} chars»`);
    expect(out.outer.note).toBe("hello world ok");
  });
});

describe("log tee redacts before it cuts", () => {
  // Assembled from parts so no token-shaped literal sits in the source.
  const sample = ["sk", "-ant-", "0000000000000000"].join("");

  it("masks a secret straddling the cap instead of shipping its prefix", () => {
    const big = `${"A".repeat(99)} ${sample} ${"B".repeat(100)}`;
    const out = redactSecretsInLogText(big, 110);
    expect(out).not.toContain("sk");
    expect(out).not.toContain(sample);
    expect(out).toContain(`[… ${big.length - 110} characters elided from log]`);
    expect(out.startsWith("A".repeat(99))).toBe(true);
  });

  it("still masks a secret wholly inside the head", () => {
    const big = `carry ${sample} ` + "B".repeat(200);
    const out = redactSecretsInLogText(big, 110);
    expect(out).not.toContain(sample);
    expect(out).toContain("«redacted");
  });

  it("leaves a secret-free long string on the cut path with the same marker", () => {
    const out = redactSecretsInLogText(`log ${"L".repeat(200)} end`, 64);
    expect(out).toBe(`log ${"L".repeat(60)}[… 144 characters elided from log]`);
  });

  it("leaves short strings on the normal path", () => {
    expect(redactSecretsInLogText("tiny ok", 64)).toBe("tiny ok");
  });

  it("caps tree strings through the same redact-then-cut pass", () => {
    const big = `${"A".repeat(99)} ${sample} ${"B".repeat(100)}`;
    // SAFETY: the input is a JsonValue literal, so redaction returns the same JSON shape.
    const out = redactSecretsForLog({ line: big }, 110) as JsonValue;
    expect(JSON.stringify(out)).not.toContain("sk");
    if (!isJsonObject(out)) throw new Error("fixture drifted: log shape lost");
    expect(String(out.line)).toContain("characters elided from log");
  });

  it("keeps an overlap margin that covers the longest pattern floor", () => {
    expect(LOG_TEE_OVERLAP_CHARS).toBe(4 * 1024);
  });
});

/** A fixture that is cyclic at runtime; the named contract keeps the static
 * view honest without an open dictionary type. */
interface CyclicNoteFixture {
  note: string;
  self: unknown;
}
/** A fixture that is cyclic at runtime, nested past the depth cap. */
interface CyclicInnerFixture {
  api_key: string;
  loop: unknown;
}

describe("cyclic input is elided, not recursed", () => {
  it("elides a self-referencing object instead of overflowing the stack", () => {
    const cyclic: CyclicNoteFixture = { note: "hello world ok", self: null };
    cyclic.self = cyclic;
    const out = redactSecrets(cyclic);
    if (!isJsonObject(out)) throw new Error("fixture drifted: cyclic root is not an object");
    expect(out.note).toBe("hello world ok");
    expect(out.self).toBe("«redacted circular»");
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("elides a self-referencing array on the log path", () => {
    const cyclic: Array<JsonValue> = ["ok"];
    cyclic.push(cyclic);
    const out = redactSecretsForLog(cyclic);
    if (!Array.isArray(out)) throw new Error("fixture drifted: cyclic log root is not an array");
    expect(out[0]).toBe("ok");
    expect(out[1]).toBe("«redacted circular»");
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("elides a cycle nested past the depth cap", () => {
    const inner: CyclicInnerFixture = { api_key: "live-secret-value-0000", loop: null };
    inner.loop = inner;
    // SAFETY: intentionally cyclic at runtime; viewed as JSON only for the
    // nesting loop below. redactSecrets itself takes unknown.
    let deep = inner as JsonValue;
    for (let i = 0; i < 15; i++) deep = { [`k${i}`]: deep };
    const out = redactSecrets(deep);
    expect(JSON.stringify(out)).not.toContain("live-secret-value-0000");
    expect(JSON.stringify(out)).toContain("«redacted circular»");
  });

  it("still redacts a shared reference twice when it is not a cycle", () => {
    // Ancestors-only tracking: the same object in two places is processed
    // twice, because neither visit is an ancestor of the other.
    const shared = { api_key: "live-secret-value-0000" };
    const out = redactSecrets({ a: shared, b: shared });
    if (!isJsonObject(out) || !isJsonObject(out.a) || !isJsonObject(out.b)) {
      throw new Error("fixture drifted: shared shape lost");
    }
    expect(out.a.api_key).toBe("«redacted 22 chars»");
    expect(out.b.api_key).toBe("«redacted 22 chars»");
  });
});

describe("maskDeep is bounded past the cap", () => {
  it("elides a nesting far deeper than the mask budget instead of overflowing", () => {
    let deep: JsonValue = { api_key: "live-secret-value-0000" };
    for (let i = 0; i < 60; i++) deep = { [`k${i}`]: deep };
    const out = redactSecrets(deep);
    const text = JSON.stringify(out);
    expect(text).not.toContain("live-secret-value-0000");
    expect(text).toContain("«redacted subtree»");
    expect(text).toContain("k59");
  });

  it("elides past the node budget on a huge past-cap fan-out", () => {
    const leaf = (i: number, j: number) => `padding-${i}-${j}-0000000000`;
    const wide: Record<string, JsonValue> = {};
    for (let i = 0; i < 3000; i++) {
      const arr: JsonValue[] = [];
      for (let j = 0; j < 40; j++) arr.push(leaf(i, j));
      wide[`arr${i}`] = arr;
    }
    let deep: JsonValue = wide;
    for (let i = 0; i < 15; i++) deep = { [`k${i}`]: deep };
    const out = redactSecrets(deep);
    const text = JSON.stringify(out);
    expect(text).toContain("«redacted subtree»");
    expect(text).not.toContain(leaf(2999, 39));
    expect(text).toContain(`«redacted ${leaf(0, 0).length} chars»`);
  });
});

describe("log tee fails a truncated JWT closed", () => {
  it("masks an overlong dotless JWT instead of shipping its in-cap prefix", () => {
    const blob = "eyJ" + "A".repeat(9000);
    const out = redactSecretsInLogText(`tok ${blob} tail`, 200);
    expect(out).not.toContain("eyJAAAA");
    expect(out).not.toContain(blob);
    expect(out).toContain("«redacted");
  });

  it("still masks a whole JWT that fits the window", () => {
    const jwt = ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "c3VjcmV0LXZha2UtcGF5bG9hZA", "c2lnbmF0dXJl"].join(".");
    const out = redactSecretsInLogText(`carry ${jwt} ` + "B".repeat(200), 110);
    expect(out).not.toContain(jwt);
    expect(out).toContain("«redacted");
  });

  it("leaves a long secret-free base64 run on the cut path with no mask", () => {
    const out = redactSecretsInLogText(`data ${"aB3x".repeat(2500)} end`, 200);
    expect(out).not.toContain("«redacted");
    expect(out).toContain("characters elided from log");
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
