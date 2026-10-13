// STS ephemeral tokens.  Both vendors' permanent credentials stay in Electron's
// encrypted main-process store; the renderer receives only a short-lived token
// scoped to a single realtime session.
//
// This mirrors the AssemblyAI minting rule exactly (see assemblyai.mjs): the
// renderer must never hold a permanent key, and neither module may log a token.
//
// One transport quirk is load-bearing.  A browser WebSocket cannot set an
// `Authorization` header — the WebSocket API exposes only the subprotocol
// header to page code.  xAI therefore documents browser auth as a
// `sec-websocket-protocol` entry prefixed `xai-client-secret.`, while its Node
// examples use the Authorization header.  A renderer that copies the Node
// example connects, sends audio, and silently receives nothing back.  The
// caller must build the subprotocol, not a header.

const XAI_TOKEN_ENDPOINT = "https://api.x.ai/v1/realtime/client_secrets";
const GEMINI_TOKEN_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";

const DEFAULT_XAI_TTL_SECONDS = 300;
// Gemini's newSessionExpireTime defaults to only 60s if unset, which is short
// enough that a slow renderer start fails the handshake.  Give it a real
// window while staying well inside the 20-hour ceiling.
const GEMINI_SESSION_LEAD_SECONDS = 120;
const GEMINI_TTL_SECONDS = 1800;

/** xAI permits a narrow range; stay inside it rather than trusting the caller. */
function clampTtl(seconds, { min, max, fallback }) {
  const value = Math.round(Number(seconds));
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

export function xaiCredential(credentials, env = process.env) {
  const stored = String(credentials?.xaiApiKey ?? "").trim();
  if (stored) return stored;
  return String(env.XAI_API_KEY ?? "").trim();
}

export function geminiCredential(credentials, env = process.env) {
  const stored = String(credentials?.geminiApiKey ?? "").trim();
  if (stored) return stored;
  return String(env.GEMINI_API_KEY ?? "").trim();
}

/**
 * Pull the token out of the mint response.
 *
 * xAI's docs return the body verbatim without documenting its shape, so accept
 * the layouts this API family is known to use rather than betting on one and
 * failing closed on a valid token.  A missing token is still an error — we never
 * fall back to handing back anything else.
 */
function readXaiToken(body) {
  const candidates = [body?.client_secret, body?.clientSecret, body];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const value = String(candidate.value ?? candidate.token ?? "").trim();
    if (value) return value;
  }
  return "";
}

export async function mintXaiRealtimeToken(
  apiKey,
  { fetchImpl = fetch, expiresInSeconds = DEFAULT_XAI_TTL_SECONDS } = {},
) {
  const secret = String(apiKey ?? "").trim();
  if (!secret) throw new Error("Add an xAI API key before starting a voice call.");
  const ttl = clampTtl(expiresInSeconds, { min: 30, max: 3600, fallback: DEFAULT_XAI_TTL_SECONDS });

  let response;
  try {
    response = await fetchImpl(XAI_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ expires_after: { seconds: ttl } }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Could not reach xAI. Check your connection and try again.");
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("xAI rejected this API key. Replace it in Voice settings.");
    }
    throw new Error(`Could not start a voice session (HTTP ${response.status}).`);
  }
  const token = readXaiToken(body);
  if (!token) throw new Error("xAI returned an invalid temporary token.");
  return { token, expiresInSeconds: ttl };
}

export async function mintGeminiLiveToken(
  apiKey,
  {
    fetchImpl = fetch,
    sessionLeadSeconds = GEMINI_SESSION_LEAD_SECONDS,
    ttlSeconds = GEMINI_TTL_SECONDS,
    now = () => Date.now(),
  } = {},
) {
  const secret = String(apiKey ?? "").trim();
  if (!secret) throw new Error("Add a Google Gemini API key before starting a voice call.");
  const base = now();
  const iso = (offsetSeconds) =>
    new Date(base + offsetSeconds * 1000).toISOString().replace(/\.\d+Z$/, "Z");

  let response;
  try {
    response = await fetchImpl(GEMINI_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": secret, "content-type": "application/json" },
      body: JSON.stringify({
        // Single-use: one token opens one session, so a leaked token cannot be
        // replayed against a second call.
        uses: 1,
        expireTime: iso(ttlSeconds),
        newSessionExpireTime: iso(
          // A floor, not a preference: the vendor default is 60s and a caller
          // must not be able to shrink the window below the safe lead.
          Math.max(GEMINI_SESSION_LEAD_SECONDS, sessionLeadSeconds),
        ),
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Could not reach Google. Check your connection and try again.");
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("Google rejected this API key. Replace it in Voice settings.");
    }
    throw new Error(`Could not start a voice session (HTTP ${response.status}).`);
  }
  // Gemini returns the token itself in `name`, unlike most endpoints.
  const token = String(body?.name ?? "").trim();
  if (!token) throw new Error("Google returned an invalid temporary token.");
  return { token, expiresInSeconds: ttlSeconds };
}

/**
 * WebSocket constructor argument for xAI from the renderer.  The browser cannot
 * send an Authorization header, so the ephemeral token travels as the
 * subprotocol with the documented prefix.
 */
export function xaiRealtimeSubprotocol(token) {
  const value = String(token ?? "").trim();
  if (!value) throw new Error("Missing xAI session token.");
  return `xai-client-secret.${value}`;
}

/**
 * Gemini accepts the ephemeral token as an `access_token` query parameter on
 * the constrained v1beta endpoint.  It is single-use and short-lived, which is
 * why putting it in the URL is acceptable here.
 */
export function geminiRealtimeUrl(token, model = "gemini-3.8-live") {
  const value = String(token ?? "").trim();
  if (!value) throw new Error("Missing Gemini session token.");
  const endpoint =
    "wss://generativelanguage.googleapis.com/ws/" +
    "google.ai.generativelanguage.v1beta.GenerativeService." +
    "BidiGenerateContentConstrained";
  return `${endpoint}?access_token=${encodeURIComponent(value)}`;
}

/** Model ids used by the session layer. */
export const XAI_REALTIME_MODEL = "grok-voice-latest";
export const GEMINI_LIVE_MODEL = "gemini-3.8-live";