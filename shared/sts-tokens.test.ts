// The token policy both the desktop renderer and a paired phone depend on.
// The rule these protect: a client never holds a permanent provider key, and
// an unavailable provider says which key is missing rather than failing
// silently.
import { describe, expect, it } from "vitest";
import {
  isStsProvider,
  mintGeminiLiveToken,
  mintStsToken,
  mintXaiRealtimeToken,
  pickStsProvider,
  stsKeyNotice,
  XAI_TOKEN_ENDPOINT,
  GEMINI_TOKEN_ENDPOINT,
  type StsKeyStatus,
} from "./sts-tokens.ts";

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
    expect(stsKeyNotice("xai", noKeys)).toContain("xAI API key");
    expect(stsKeyNotice("gemini", noKeys)).toContain("Gemini API key");
  });

  it("never reads as 'no key' when the status is merely unknown", () => {
    // A failed probe is not a missing key, and saying so would send someone
    // to Settings to add a key they already have.
    expect(stsKeyNotice("xai", null)).toBeNull();
  });

  it("confirms a configured provider", () => {
    expect(stsKeyNotice("gemini", bothKeys)).toBe("Key configured.");
  });
});

describe("minting", () => {
  it("sends the permanent key only in the request, and returns only the token", async () => {
    let auth: string | undefined;
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      auth = new Headers(init?.headers).get("authorization") ?? undefined;
      return new Response(JSON.stringify({ client_secret: { value: "ephemeral-token" } }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await mintXaiRealtimeToken("xai-permanent-key", { fetchImpl: fakeFetch });

    expect(result).toEqual({ token: "ephemeral-token", expiresInSeconds: 300 });
    expect(auth).toBe("Bearer xai-permanent-key");
    // The permanent key is never part of what the caller gets back.
    expect(JSON.stringify(result)).not.toContain("xai-permanent-key");
  });

  it("names the endpoint it used", async () => {
    let seen = "";
    const fakeFetch = (async (url: string | URL | Request) => {
      seen = String(url);
      return new Response(JSON.stringify({ client_secret: { value: "t" } }), { status: 200 });
    }) as unknown as typeof fetch;

    await mintXaiRealtimeToken("k", { fetchImpl: fakeFetch });
    expect(seen).toBe(XAI_TOKEN_ENDPOINT);
  });

  it("clamps an out-of-range TTL instead of trusting the caller", async () => {
    let body: { expires_after: { seconds: number } } | undefined;
    const fakeFetch = (async (_u: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ client_secret: { value: "t" } }), { status: 200 });
    }) as unknown as typeof fetch;

    await mintXaiRealtimeToken("k", { fetchImpl: fakeFetch, expiresInSeconds: 99_999 });
    expect(body?.expires_after.seconds).toBe(3600);
  });

  it("reads Gemini's token from `name`, which is where that API puts it", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ name: "gemini-ephemeral" }), { status: 200 })) as unknown as typeof fetch;
    const result = await mintGeminiLiveToken("k", { fetchImpl: fakeFetch });
    expect(result.token).toBe("gemini-ephemeral");
    expect(result.expiresInSeconds).toBe(1800);
  });

  it("marks a Gemini token single-use", async () => {
    let body: { uses: number } | undefined;
    const fakeFetch = (async (_u: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ name: "t" }), { status: 200 });
    }) as unknown as typeof fetch;

    await mintGeminiLiveToken("k", { fetchImpl: fakeFetch });
    expect(body?.uses).toBe(1);
  });

  it("turns a rejected key into a sentence naming the provider", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(mintXaiRealtimeToken("bad", { fetchImpl: fakeFetch })).rejects.toThrow(/xAI rejected/);
  });

  it("refuses to mint with no key at all", async () => {
    await expect(mintStsToken("xai", "")).rejects.toThrow(/xAI API key/);
    await expect(mintStsToken("gemini", "   ")).rejects.toThrow(/Gemini API key/);
  });

  it("fails closed when the response carries no token", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    await expect(mintXaiRealtimeToken("k", { fetchImpl: fakeFetch })).rejects.toThrow(/invalid temporary token/);
  });
});

describe("provider validation", () => {
  it("accepts only the two providers it implements", () => {
    expect(isStsProvider("xai")).toBe(true);
    expect(isStsProvider("gemini")).toBe(true);
    // A name that reaches here would fall through to Gemini's mint path.
    expect(isStsProvider("openai")).toBe(false);
    expect(isStsProvider(null)).toBe(false);
  });

  it("uses the endpoint each provider documents", async () => {
    const urls: string[] = [];
    const fakeFetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ name: "t", client_secret: { value: "t" } }), { status: 200 });
    }) as unknown as typeof fetch;

    await mintStsToken("xai", "k", { fetchImpl: fakeFetch });
    await mintStsToken("gemini", "k", { fetchImpl: fakeFetch });
    expect(urls).toEqual([XAI_TOKEN_ENDPOINT, GEMINI_TOKEN_ENDPOINT]);
  });
});