import { describe, expect, it, vi } from "vitest";
import {
  geminiCredential,
  geminiRealtimeUrl,
  mintGeminiLiveToken,
  mintXaiRealtimeToken,
  xaiCredential,
  xaiRealtimeSubprotocol,
} from "./sts-tokens.mjs";

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body,
});

describe("credentials", () => {
  it("prefers the stored credential and falls back to env", () => {
    expect(xaiCredential({ xaiApiKey: "stored" }, { XAI_API_KEY: "env" })).toBe("stored");
    expect(xaiCredential({}, { XAI_API_KEY: "env" })).toBe("env");
    expect(geminiCredential({ geminiApiKey: "stored" }, {})).toBe("stored");
    expect(geminiCredential({}, { GEMINI_API_KEY: "env" })).toBe("env");
  });

  it("treats blank values as absent", () => {
    expect(xaiCredential({ xaiApiKey: "   " }, { XAI_API_KEY: "env" })).toBe("env");
  });
});

describe("mintXaiRealtimeToken", () => {
  it("posts a bearer-authenticated client_secrets request", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: "ek_abc" }));
    const out = await mintXaiRealtimeToken("xai-key", { fetchImpl });
    expect(out.token).toBe("ek_abc");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.x.ai/v1/realtime/client_secrets");
    expect(init.headers.authorization).toBe("Bearer xai-key");
    expect(JSON.parse(init.body)).toEqual({ expires_after: { seconds: 300 } });
  });

  it("accepts the nested client_secret shape the API family also uses", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ client_secret: { value: "ek_nested" } }));
    await expect(mintXaiRealtimeToken("k", { fetchImpl })).resolves.toMatchObject({
      token: "ek_nested",
    });
  });

  it("refuses without a key and never sends the request", async () => {
    const fetchImpl = vi.fn();
    await expect(mintXaiRealtimeToken("  ", { fetchImpl })).rejects.toThrow(/xAI API key/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a rejected key to an actionable message", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, { ok: false, status: 401 }));
    await expect(mintXaiRealtimeToken("k", { fetchImpl })).rejects.toThrow(/rejected this API key/i);
  });

  it("fails loudly when the body carries no token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ nothing: "here" }));
    await expect(mintXaiRealtimeToken("k", { fetchImpl })).rejects.toThrow(/invalid temporary token/i);
  });

  it("clamps the requested ttl into the documented range", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: "t" }));
    await mintXaiRealtimeToken("k", { fetchImpl, expiresInSeconds: 99_999 });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).expires_after.seconds).toBe(3600);
  });
});

describe("mintGeminiLiveToken", () => {
  const fixedNow = () => Date.parse("2026-10-11T12:00:00.000Z");

  it("posts to auth_tokens with x-goog-api-key and reads the token from name", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ name: "gem_tok" }));
    const out = await mintGeminiLiveToken("g-key", { fetchImpl, now: fixedNow });
    expect(out.token).toBe("gem_tok");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/auth_tokens");
    expect(init.headers["x-goog-api-key"]).toBe("g-key");
    const body = JSON.parse(init.body);
    expect(body.uses).toBe(1);
    expect(body.newSessionExpireTime).toBe("2026-10-11T12:02:00Z");
  });

  it("never sends the api key anywhere but the auth header", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ name: "t" }));
    await mintGeminiLiveToken("super-secret", { fetchImpl, now: fixedNow });
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.stringify(init.body)).not.toContain("super-secret");
    expect(init.url).toBeUndefined();
  });

  it("gives the renderer a real window to open the session", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ name: "t" }));
    await mintGeminiLiveToken("k", { fetchImpl, now: fixedNow, sessionLeadSeconds: 5 });
    // Clamped up: a 5s lead is not enough for a renderer to finish starting.
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).newSessionExpireTime).toBe(
      "2026-10-11T12:02:00Z",
    );
  });
});

describe("renderer transport helpers", () => {
  it("carries the xAI token as a subprotocol, not a header", () => {
    // A browser WebSocket cannot set Authorization; using the Node example
    // verbatim connects and then silently receives nothing.
    expect(xaiRealtimeSubprotocol("ek_abc")).toBe("xai-client-secret.ek_abc");
  });

  it("builds the constrained Gemini URL with an encoded access token", () => {
    const url = geminiRealtimeUrl("a b&c");
    expect(url).toContain("BidiGenerateContentConstrained");
    expect(url).toContain("access_token=a%20b%26c");
  });

  it("refuses to build a transport without a token", () => {
    expect(() => xaiRealtimeSubprotocol("")).toThrow(/session token/i);
    expect(() => geminiRealtimeUrl("  ")).toThrow(/session token/i);
  });
});