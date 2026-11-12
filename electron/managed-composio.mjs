const TOKEN = /^[0-9a-f]{64}$/;

/** The identity a real BotFleet connected-apps broker reports from GET /health. */
export const MANAGED_COMPOSIO_SERVICE = "botfleet-composio";
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 5_000;

export function normalizeManagedComposioBrokerUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return "";
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return "";
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return "";
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

export function managedComposioAccess(brokerUrl, credentials) {
  const url = normalizeManagedComposioBrokerUrl(brokerUrl);
  const token = credentials?.composioBrokerToken;
  if (!url || !TOKEN.test(token ?? "")) return null;
  return { url, token };
}

export function managedComposioChildEnvironment(brokerUrl, credentials, environment) {
  const next = { ...environment };
  delete next.OMB_COMPOSIO_BROKER_URL;
  delete next.OMB_COMPOSIO_BROKER_TOKEN;
  const access = managedComposioAccess(brokerUrl, credentials);
  if (access) {
    next.OMB_COMPOSIO_BROKER_URL = access.url;
    next.OMB_COMPOSIO_BROKER_TOKEN = access.token;
  }
  return next;
}

/** A short identity check before any installation credential leaves this
 * machine. The broker must answer GET /health with JSON naming itself as the
 * BotFleet connected-apps service; a wrong host, a renamed Worker, or a
 * Cloudflare 404 page must never be mistaken for a working broker. Never
 * throws: the caller decides what to do with a failed preflight. */
export async function preflightManagedComposioBroker({
  brokerUrl,
  fetchImpl = globalThis.fetch,
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  timeoutMs = DEFAULT_PREFLIGHT_TIMEOUT_MS,
} = {}) {
  const url = normalizeManagedComposioBrokerUrl(brokerUrl);
  if (!url) return { ok: false, reason: "no connected-apps service is configured" };
  let response;
  try {
    response = await fetchImpl(`${url}/health`, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: timeoutSignal(timeoutMs),
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return {
      ok: false,
      reason: timedOut
        ? "the connected-apps service did not answer in time"
        : "the connected-apps service could not be reached",
    };
  }
  if (!response.ok) {
    return { ok: false, reason: `the connected-apps service answered HTTP ${response.status}` };
  }
  const body = await response.json().catch(() => null);
  if (body?.service !== MANAGED_COMPOSIO_SERVICE) {
    return { ok: false, reason: "that address is not a BotFleet connected-apps service" };
  }
  if (body.ready !== true) {
    return { ok: false, reason: "the connected-apps service is not ready yet" };
  }
  return { ok: true, reason: "" };
}

export async function ensureManagedComposioCredentials({
  brokerUrl,
  credentials,
  fetchImpl = globalThis.fetch,
  saveCredentials,
  log = () => {},
  // Receives { status: "ready" | "failed", message } so the desktop can show
  // a visible Connected Apps notice instead of burying the outcome in a log.
  report = () => {},
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  preflightTimeoutMs = DEFAULT_PREFLIGHT_TIMEOUT_MS,
  existingCredentialTimeoutMs = 8_000,
  registrationTimeoutMs = 15_000,
}) {
  const url = normalizeManagedComposioBrokerUrl(brokerUrl);
  if (!url) {
    if (brokerUrl) {
      log("connected-apps broker URL rejected: HTTPS or a loopback HTTP URL is required");
      report({
        status: "failed",
        message: "The connected-apps service address must be HTTPS or a loopback HTTP URL.",
      });
    }
    return credentials;
  }
  const preflight = await preflightManagedComposioBroker({
    brokerUrl: url,
    fetchImpl,
    timeoutSignal,
    timeoutMs: preflightTimeoutMs,
  });
  if (!preflight.ok) {
    // A failed preflight keeps any existing identity: a broker outage must
    // not strand already-authorized accounts under a new installation.
    log(`connected-apps registration skipped: ${preflight.reason}`);
    report({ status: "failed", message: `Connected apps could not be set up: ${preflight.reason}.` });
    return credentials;
  }
  if (TOKEN.test(credentials.composioBrokerToken ?? "")) {
    try {
      const check = await fetchImpl(`${url}/v1/me`, {
        headers: { authorization: `Bearer ${credentials.composioBrokerToken}` },
        redirect: "error",
        signal: timeoutSignal(existingCredentialTimeoutMs),
      });
      if (check.ok) {
        report({ status: "ready" });
        return credentials;
      }
      // Only a definitive auth failure rotates the credential. A transient
      // outage keeps the existing identity so reconnecting cannot strand the
      // user's already-authorized accounts under a new installation.
      if (check.status !== 401) {
        report({ status: "failed", message: `Connected apps could not be verified: the service answered HTTP ${check.status}.` });
        return credentials;
      }
      delete credentials.composioBrokerToken;
      delete credentials.composioInstallationId;
    } catch {
      report({ status: "failed", message: "Connected apps could not be verified: the service could not be reached." });
      return credentials;
    }
  }
  try {
    const response = await fetchImpl(`${url}/v1/installations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      redirect: "error",
      signal: timeoutSignal(registrationTimeoutMs),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
    if (!TOKEN.test(body?.token ?? "") || typeof body?.installationId !== "string") {
      throw new Error("the connected-apps service returned invalid credentials");
    }
    credentials.composioBrokerToken = body.token;
    credentials.composioInstallationId = body.installationId;
    await saveCredentials(credentials);
    log("connected-apps installation registered");
    report({ status: "ready" });
  } catch (error) {
    // This operation always settles locally. The caller runs it after first
    // paint, so an optional hosted integration cannot delay desktop readiness.
    const detail = error?.message ?? String(error);
    log(`connected-apps registration failed: ${detail}`);
    report({ status: "failed", message: `Connected apps could not be set up: ${detail}.` });
  }
  return credentials;
}
