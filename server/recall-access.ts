// Cloudflare Access service tokens for the Agent RAG (recall) HTTP path.
//
// A recall service published through Cloudflare Access does not answer an
// unauthenticated request with 401.  It answers with a redirect to a login
// page, and it ignores a bearer credential entirely — the bearer header
// never reaches the origin, so the API-key field in Settings cannot make
// that host work no matter what is typed into it.  Access wants a header
// PAIR instead: CF-Access-Client-Id and CF-Access-Client-Secret, minted as
// a service token.
//
// Two consequences this module exists to handle:
//
//   1. Send the pair alongside the bearer (never instead of it) — some
//      deployments gate at the edge, some at the origin, some at both.
//   2. Name the redirect.  "Failed to fetch" for a service that is up and
//      healthy is the single most expensive symptom here: it reads as an
//      outage when it is really a gateway asking who you are.

/** Header names Cloudflare Access reads for a service token. */
export const ACCESS_CLIENT_ID_HEADER = "CF-Access-Client-Id";
export const ACCESS_CLIENT_SECRET_HEADER = "CF-Access-Client-Secret";

/** Hostname fragments and paths that mean "an identity gateway answered". */
const ACCESS_HOST_MARKERS = ["cloudflareaccess.com", "cloudflareaccess.net"];
const ACCESS_PATH_MARKER = "/cdn-cgi/access/";

/** What a configured service token contributes to a request's headers —
 * both fields or neither, never one. */
export type AccessTokenHeaders = {
  [ACCESS_CLIENT_ID_HEADER]?: string;
  [ACCESS_CLIENT_SECRET_HEADER]?: string;
};

/** The service-token pair, or nothing at all.  Both halves are required:
 * one alone is not a credential, and sending a lone id would only make the
 * gateway's rejection harder to read. */
export function accessHeaders(
  clientId?: string | null,
  clientSecret?: string | null,
): AccessTokenHeaders {
  const id = (clientId ?? "").trim();
  const secret = (clientSecret ?? "").trim();
  if (!id || !secret) return {};
  return { [ACCESS_CLIENT_ID_HEADER]: id, [ACCESS_CLIENT_SECRET_HEADER]: secret };
}

/** True when both halves are present — the "configured" flag the UI shows,
 * derived here so the panel and the probe agree on what counts. */
export function hasAccessServiceToken(clientId?: string | null, clientSecret?: string | null): boolean {
  return Object.keys(accessHeaders(clientId, clientSecret)).length > 0;
}

/** Which of the four situations the service token is in.  `hasAccessServiceToken`
 * answers yes-or-no, which cannot tell "no token" apart from "half a token" —
 * and half a token is silent: `accessHeaders` sends nothing, so a service
 * behind Access answers a login page and the panel reports what reads like an
 * outage.  Naming the half-configured state is what lets the UI say which
 * field is missing. */
export type AccessTokenState = "none" | "complete" | "missing-id" | "missing-secret";

export function accessTokenState(clientId?: string | null, clientSecret?: string | null): AccessTokenState {
  const id = (clientId ?? "").trim();
  const secret = (clientSecret ?? "").trim();
  if (id && secret) return "complete";
  if (!id && !secret) return "none";
  return id ? "missing-secret" : "missing-id";
}

/** Just the host of a URL, or "" — the only part of a login URL that is safe
 * to echo.  An Access login URL carries the original request in its query
 * string, so the query never travels into a message. */
function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

/** The shape both `fetch` responses and hand-rolled test doubles satisfy. */
export interface ProbedResponse {
  status: number;
  redirected?: boolean;
  url?: string;
  headers?: { get(name: string): string | null };
}

/**
 * A human-readable reason when a recall response is really a login page, or
 * null when the response is the service's own answer.
 *
 * Three tells, because a caller may or may not follow redirects:
 *   - a 3xx with a Location (the caller asked for `redirect: "manual"`),
 *   - a followed redirect that landed on an Access host,
 *   - a 2xx of HTML where a JSON API was asked for.
 *
 * Recall requests follow only same-origin redirects (and same-host HTTPS
 * upgrades) before this check.  A redirect to an external origin or an Access
 * login path stays manual so custom service-token headers cannot leak.
 */
export function accessLoginHint(res: ProbedResponse): string | null {
  const location = res.headers?.get("location") ?? "";
  const finalUrl = res.url ?? "";
  const isRedirect = res.status >= 300 && res.status < 400;

  if (isRedirect && location) return hint(hostOf(location) || "a login page", looksLikeAccess(location));
  if (res.redirected && finalUrl && looksLikeAccess(finalUrl)) return hint(hostOf(finalUrl), true);

  const contentType = res.headers?.get("content-type") ?? "";
  if (res.status >= 200 && res.status < 300 && contentType.toLowerCase().includes("text/html")) {
    return hint(hostOf(finalUrl) || "a login page", looksLikeAccess(finalUrl));
  }
  return null;
}

function looksLikeAccess(value: string): boolean {
  const host = hostOf(value).toLowerCase();
  if (ACCESS_HOST_MARKERS.some((marker) => host === marker || host.endsWith(`.${marker}`))) return true;
  return value.toLowerCase().includes(ACCESS_PATH_MARKER);
}

function hint(where: string, certain: boolean): string {
  const gateway = certain ? "Cloudflare Access" : "an identity gateway such as Cloudflare Access";
  return `the service redirected to a login page at ${where}, which means it is behind ${gateway} — an API key or bearer token is ignored there, so add an Access service token (Client Id and Client Secret) in Settings`;
}
