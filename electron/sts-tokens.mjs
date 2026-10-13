// STS ephemeral tokens for the desktop main process.
//
// The minting itself now lives in `shared/sts-tokens.ts`, because a paired
// phone asks the harness for the same token over HTTP (see server/sts-access.ts)
// and two copies of a TTL would eventually disagree.  This module keeps the
// Electron-facing surface: the credential lookup against the encrypted store,
// and the two transport helpers that turn a token into something a socket can
// actually authenticate with.
//
// Both vendors' permanent credentials stay in Electron's encrypted
// main-process store; the renderer receives only a short-lived token scoped to
// a single realtime session.
//
// One transport quirk is load-bearing.  A browser WebSocket cannot set an
// `Authorization` header — the WebSocket API exposes only the subprotocol
// header to page code.  xAI therefore documents browser auth as a
// `sec-websocket-protocol` entry prefixed `xai-client-secret.`, while its Node
// examples use the Authorization header.  A renderer that copies the Node
// example connects, sends audio, and silently receives nothing back.  The
// caller must build the subprotocol, not a header.

import {
  GEMINI_LIVE_MODEL,
  mintGeminiLiveToken,
  mintXaiRealtimeToken,
  XAI_REALTIME_MODEL,
} from "../shared/sts-tokens.ts";

export {
  GEMINI_LIVE_MODEL,
  mintGeminiLiveToken,
  mintXaiRealtimeToken,
  XAI_REALTIME_MODEL,
};

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
 * The xAI subprotocol a browser socket must send.  There is no header on the
 * browser WebSocket API, so this string *is* the credential on the wire.
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
export function geminiRealtimeUrl(token, _model = "gemini-3.8-live") {
  const value = String(token ?? "").trim();
  if (!value) throw new Error("Missing Gemini session token.");
  const endpoint =
    "wss://generativelanguage.googleapis.com/ws/" +
    "google.ai.generativelanguage.v1beta.GenerativeService." +
    "BidiGenerateContentConstrained";
  return `${endpoint}?access_token=${encodeURIComponent(value)}`;
}