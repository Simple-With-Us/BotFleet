// STS ephemeral tokens, shared by the harness and the desktop app.
//
// Both vendors' permanent credentials stay where they already live --
// Electron's encrypted main-process store, or the harness's secret table --
// and the caller receives only a short-lived token scoped to a single
// realtime session.  No client, renderer or phone ever holds a permanent key,
// and nothing here logs a token.
//
// This mirrors the AssemblyAI minting rule (see electron/assemblyai.mjs).
// It lives in `shared/` because there is now a second caller: a paired phone
// asks the harness for its token over HTTP, and the harness already holds
// both keys.  One implementation, so the two cannot drift on a TTL or on the
// shape of a response.
//
// One transport quirk is load-bearing.  A browser WebSocket cannot set an
// `Authorization` header -- the WebSocket API exposes only the subprotocol
// header to page code.  xAI therefore documents browser auth as a
// `sec-websocket-protocol` entry prefixed `xai-client-secret.`, while its
// Node examples use the Authorization header.  A caller that copies the Node
// example connects, sends audio, and silently receives nothing back.

export const XAI_TOKEN_ENDPOINT = "https://api.x.ai/v1/realtime/client_secrets";
export const GEMINI_TOKEN_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";

export const XAI_REALTIME_MODEL = "grok-voice-latest";
export const GEMINI_LIVE_MODEL = "gemini-3.8-live";

const DEFAULT_XAI_TTL_SECONDS = 300;
// Gemini's newSessionExpireTime defaults to only 60s if unset, which is short
// enough that a slow client start fails the handshake.  Give it a real
// window while staying well inside the 20-hour ceiling.
const GEMINI_SESSION_LEAD_SECONDS = 120;
const GEMINI_TTL_SECONDS = 1800;

export type StsProvider = "xai" | "gemini";
export const STS_PROVIDERS: readonly StsProvider[] = ["xai", "gemini"];

/** What every caller receives.  Deliberately uniform across providers: the
 *  desktop renderer and the phone get the same shape, so neither has to know
 *  which vendor is underneath. */
export interface StsSessionToken {
  token: string;
  expiresInSeconds: number;
}

/** Which providers this Mac has a key for.  Booleans only -- reading that a
 *  provider is set up is not reading its key. */
export interface StsKeyStatus {
  xai: boolean;
  gemini: boolean;
}

export function isStsProvider(value: unknown): value is StsProvider {
  return value === "xai" || value === "gemini";
}

/** xAI permits a narrow range; stay inside it rather than trusting the caller. */
function clampTtl(seconds: unknown, { min, max, fallback }: { min: number; max: number; fallback: number }): number {
  const value = Math.round(Number(seconds));
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

export function xaiCredential(credentials: { xaiApiKey?: string } | undefined, env: Record<string, string | undefined> = process.env): string {
  const stored = String(credentials?.xaiApiKey ?? "").trim();
  if (stored) return stored;
  return String(env.XAI_API_KEY ?? "").trim();
}

export function geminiCredential(credentials: { geminiApiKey?: string } | undefined, env: Record<string, string | undefined> = process.env): string {
  const stored = String(credentials?.geminiApiKey ?? "").trim();
  if (stored) return stored;
  return String(env.GEMINI_API_KEY ?? "").trim();
}

/**
 * Pull the token out of the mint response.
 *
 * xAI's docs return the body verbatim without documenting its shape, so accept
 * the layouts this API family is known to use rather than betting on one and
 * failing closed on a valid token.  A missing token is still an error -- we never
 * fall back to handing back anything else.
 */
function readXaiToken(body: unknown): string {
  const record = body as Record<string, unknown> | null | undefined;
  const candidates = [record?.client_secret, record?.clientSecret, record];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const value = String((candidate as Record<string, unknown>).value ?? (candidate as Record<string, unknown>).token ?? "").trim();
    if (value) return value;
  }
  return "";
}

export async function mintXaiRealtimeToken(
  apiKey: string,
  { fetchImpl = fetch, expiresInSeconds = DEFAULT_XAI_TTL_SECONDS }: { fetchImpl?: typeof fetch; expiresInSeconds?: number } = {},
): Promise<StsSessionToken> {
  const secret = String(apiKey ?? "").trim();
  if (!secret) throw new Error("Add an xAI API key before starting a voice call.");
  const ttl = clampTtl(expiresInSeconds, { min: 30, max: 3600, fallback: DEFAULT_XAI_TTL_SECONDS });
  const response = await fetchImpl(XAI_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ expires_after: { seconds: ttl } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("xAI rejected this API key. Replace it in Voice settings.");
  }
  if (!response.ok) throw new Error(`xAI would not issue a call token (HTTP ${response.status}).`);
  const token = readXaiToken(await response.json());
  if (!token) throw new Error("xAI returned an invalid temporary token.");
  return { token, expiresInSeconds: ttl };
}

export async function mintGeminiLiveToken(
  apiKey: string,
  {
    fetchImpl = fetch,
    sessionLeadSeconds = GEMINI_SESSION_LEAD_SECONDS,
    ttlSeconds = GEMINI_TTL_SECONDS,
    now = () => Date.now(),
  }: { fetchImpl?: typeof fetch; sessionLeadSeconds?: number; ttlSeconds?: number; now?: () => number } = {},
): Promise<StsSessionToken> {
  const secret = String(apiKey ?? "").trim();
  if (!secret) throw new Error("Add a Gemini API key before starting a voice call.");
  const lead = clampTtl(sessionLeadSeconds, { min: 120, max: 3600, fallback: GEMINI_SESSION_LEAD_SECONDS });
  const ttl = clampTtl(ttlSeconds, { min: 600, max: 3600, fallback: GEMINI_TTL_SECONDS });
  // Seconds precision, no milliseconds: this is the string the desktop's
  // existing tests assert on, and a `.000Z` suffix is a gratuitous format
  // change to ship alongside a refactor.
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
  const response = await fetchImpl(GEMINI_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "x-goog-api-key": secret, "content-type": "application/json" },
    body: JSON.stringify({
      // Single use: one token opens one session.
      uses: 1,
      expireTime: iso(now() + ttl * 1000),
      newSessionExpireTime: iso(now() + lead * 1000),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("Gemini rejected this API key. Replace it in Voice settings.");
  }
  if (!response.ok) throw new Error(`Gemini would not issue a call token (HTTP ${response.status}).`);
  const body = (await response.json()) as { name?: string } | null;
  const token = String(body?.name ?? "").trim();
  if (!token) throw new Error("Gemini returned an invalid temporary token.");
  return { token, expiresInSeconds: ttl };
}

/** Mint for one provider.  The single entry point both callers use, so a
 *  provider added here reaches the desktop and the phone together. */
export function mintStsToken(provider: StsProvider, apiKey: string, options?: Parameters<typeof mintXaiRealtimeToken>[1]): Promise<StsSessionToken> {
  return provider === "xai" ? mintXaiRealtimeToken(apiKey, options) : mintGeminiLiveToken(apiKey, options);
}

/**
 * The provider to use, given which keys exist and what was asked for.
 *
 * Mirrors `pickStsProvider` on the desktop so a phone and the web client
 * degrade the same way: a preference pinned to a provider with no key falls
 * back to auto rather than failing, and "no key anywhere" is a distinct,
 * reportable reason rather than a silent null.
 */
export function pickStsProvider(
  keys: StsKeyStatus,
  preference: StsProvider | null = null,
): { provider: StsProvider | null; reason: "user-preference" | "auto-preference" | "auto-only-key" | "no-provider" } {
  if (preference && keys[preference]) return { provider: preference, reason: "user-preference" };
  for (const provider of STS_PROVIDERS) {
    if (keys[provider]) return { provider, reason: preference ? "auto-preference" : "auto-only-key" };
  }
  return { provider: null, reason: "no-provider" };
}

/** Why a provider cannot be used, in a sentence a person can act on.  `null`
 *  means it can.  Never says "unavailable" without saying which key. */
export function stsKeyNotice(provider: StsProvider, keys: StsKeyStatus | null): string | null {
  if (!keys) return null; // unknown -- must not read as "no key"
  if (keys[provider]) return "Key configured.";
  return provider === "xai"
    ? "No xAI API key.  Calls stay on Auto until you add one."
    : "No Google Gemini API key.  Calls stay on Auto until you add one.";
}