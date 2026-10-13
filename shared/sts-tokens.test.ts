// The token policy both the desktop renderer and a paired phone depend on.
// The rule these protect: a client never holds a permanent provider key, and
// an unavailable provider says which key is missing rather than failing
// silently.
import { describe, expect, it } from "vitest";
import {
  GEMINI_TOKEN_ENDPOINT,
  isStsProvider,
  mintGeminiLiveToken,
  mintStsToken,
  mintXaiRealtimeToken,
  pickStsProvider,
  stsKeyNotice,
  XAI_TOKEN_ENDPOINT,
  type StsKeyStatus,
} from "./sts-tokens.ts";

/** A fetch double that records what it was asked for and answers with a
 *  body.  Written once so no test has to assert on a cast of its own. */
function fetchDouble(reply: StsVendorReply, init: { status?: number } = {}) {
  const calls: { url: string; headers: Headers; body: string }[] = [];
  const impl: typeof fetch = async (input, requestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(requestInit?.headers),
      body: String(requestInit?.body ?? ""),
    });
    return new Response(JSON.stringify(reply), { status: init.status ?? 200 });
  };
  return { impl, calls };
}

/** A vendor mint body, in any of the layouts these two APIs answer with. */
type StsVendorReply = Record<string, string | { value?: string; token?: string } | undefined>;

const bothKeys: StsKeyStatus = { xai: true, gemini: true };
const noKeys: StsKeyStatus = { xai: false, gemini: false };

describe("provider selection", () => {
  it("honours a preference that has a key", () => {
    expect(pickStsProvider(bothKeys, "gemini")).toEqual({ provider: "gemini", reason: "user-preference" });
  });

  it("falls back to auto when the preferred provider has no key, rather than failing", () => {
    // The pinned provider is simply not offered, so a call still happens.
    expect(pickStsProvider({ xai: false, gemini: true }, "xai")).toEqual({
      provider: "gemini",
      reason: "auto-preference",
    });
  });

  it("reports no provider when nothing is configured", () => {
    expect(pickStsProvider(noKeys, "xai")).toEqual({ provider: null, reason: "no-provider" });
  });

  it("prefers xai when auto and both keys exist, matching provider order", () => {
    expect(pickStsProvider(bothKeys)).toEqual({ provider: "xai", reason: "auto-only-key" });
  });
});

describe("unavailability is truthful", () => {
  it("names the missing key so the user knows what to add", () => {
    expect(stsKeyNotice("xai", noKeys).reason).toContain("xAI API key");
    expect(stsKeyNotice("gemini", noKeys).reason).toContain("Gemini API key");
  });

  it("never reads as 'no key' when the status is merely unknown", () => {
    // A failed probe is not a missing key, and saying so would send someone
    // to Settings to add a key they already have.
    expect(stsKeyNotice("xai", null).reason).toBeNull();
  });

  it("reports configured separately from its sentence", () => {
    expect(stsKeyNotice("gemini", bothKeys)).toEqual({ configured: true, reason: "Key configured." });
  });
});

describe("minting", () => {
  it("sends the permanent key only in the request, and returns only the token", async () => {
    const { impl, calls } = fetchDouble({ client_secret: { value: "ephemeral-token" } });

    const result = await mintXaiRealtimeToken("xai-permanent-key", { fetchImpl: impl });

    expect(result).toEqual({ token: "ephemeral-token", expiresInSeconds: 300 });
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer xai-permanent-key");
    // The permanent key is never part of what the caller gets back.
    expect(JSON.stringify(result)).not.toContain("xai-permanent-key");
  });

  it("names the endpoint it used", async () => {
    const { impl, calls } = fetchDouble({ client_secret: { value: "t" } });
    await mintXaiRealtimeToken("k", { fetchImpl: impl });
    expect(calls[0]?.url).toBe(XAI_TOKEN_ENDPOINT);
  });

  it("clamps an out-of-range TTL instead of trusting the caller", async () => {
    const { impl, calls } = fetchDouble({ client_secret: { value: "t" } });
    await mintXaiRealtimeToken("k", { fetchImpl: impl, expiresInSeconds: 99_999 });
    const sent: unknown = JSON.parse(calls[0]?.body ?? "{}");
    expect(sent).toMatchObject({ expires_after: { seconds: 3600 } });
  });

  it("reads Gemini's token from `name`, which is where that API puts it", async () => {
    const { impl } = fetchDouble({ name: "gemini-ephemeral" });
    const result = await mintGeminiLiveToken("k", { fetchImpl: impl });
    expect(result).toEqual({ token: "gemini-ephemeral", expiresInSeconds: 1800 });
  });

  it("marks a Gemini token single-use", async () => {
    const { impl, calls } = fetchDouble({ name: "t" });
    await mintGeminiLiveToken("k", { fetchImpl: impl });
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({ uses: 1 });
  });

  it("sends Gemini's window at seconds precision", async () => {
    // The desktop asserts on this exact string. A `.000Z` suffix is the same
    // instant and a different string, and the difference is invisible unless
    // something pins it.
    const { impl, calls } = fetchDouble({ name: "t" });
    await mintGeminiLiveToken("k", {
      fetchImpl: impl,
      now: () => Date.parse("2026-10-11T12:00:00Z"),
      // Below the 600s floor on purpose: the clamp is the behaviour under
      // test, so the assertion has to be about what comes out, not what went
      // in.
      ttlSeconds: 120,
      sessionLeadSeconds: 120,
    });
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
      expireTime: "2026-10-11T12:10:00Z",
      newSessionExpireTime: "2026-10-11T12:02:00Z",
    });
  });

  it("turns a rejected key into a sentence naming the provider", async () => {
    const { impl } = fetchDouble({}, { status: 401 });
    await expect(mintXaiRealtimeToken("bad", { fetchImpl: impl })).rejects.toThrow(/xAI rejected/);
  });

  it("refuses to mint with no key at all", async () => {
    await expect(mintStsToken("xai", "")).rejects.toThrow(/xAI API key/);
    await expect(mintStsToken("gemini", "   ")).rejects.toThrow(/Gemini API key/);
  });

  it("fails closed when the response carries no token", async () => {
    const { impl } = fetchDouble({});
    await expect(mintXaiRealtimeToken("k", { fetchImpl: impl })).rejects.toThrow(/invalid temporary token/);
  });

  it("uses the endpoint each provider documents", async () => {
    const { impl, calls } = fetchDouble({ name: "t", client_secret: { value: "t" } });
    await mintStsToken("xai", "k", { fetchImpl: impl });
    await mintStsToken("gemini", "k", { fetchImpl: impl });
    expect(calls.map((call) => call.url)).toEqual([XAI_TOKEN_ENDPOINT, GEMINI_TOKEN_ENDPOINT]);
  });
});

describe("provider validation", () => {
  it("accepts only the two providers it implements", () => {
    expect(isStsProvider("xai")).toBe(true);
    expect(isStsProvider("gemini")).toBe(true);
    // A name that reached the mint path would be handled as Gemini.
    expect(isStsProvider("openai")).toBe(false);
  });
});