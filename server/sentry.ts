// Node Sentry for the BotFleet harness.  The DSN arrives as an input, not
// out of the environment: the observability manager resolves env then
// ~/.botfleet/config.json and hands the answer here, so a DSN saved in
// Settings takes effect without a restart.  The SDK is loaded only once a
// DSN is present, so importing this module in vitest does not pay the Node
// SDK tax.  Browser Replay/Feedback live in src/lib/sentry.ts.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

type SentryNode = typeof import("@sentry/node");
type SentryIntegration = Parameters<SentryNode["addIntegration"]>[0];

/** How the harness got its DSN.  `env` means a CI runner or the LaunchAgent
 * pinned one, which is why Settings shows the DSN field disabled. */
export type SentrySource = "env" | "config" | "none";

export interface SentryRuntimeInput {
  dsn: string | null;
  enabled: boolean;
  environment: string;
  tracesSampleRate: number;
  logsEnabled: boolean;
  source: SentrySource;
}

export interface SentryRuntimeState {
  active: boolean;
  source: SentrySource;
  /** Ingest host and project id — the halves of a DSN that are safe to log
   * and to broadcast.  The public key never appears in this object. */
  host: string | null;
  projectId: string | null;
  environment: string;
  tracesSampleRate: number;
  logsEnabled: boolean;
  profilingAvailable: boolean;
  lastError: string | null;
}

const DORMANT: SentryRuntimeState = {
  active: false,
  source: "none",
  host: null,
  projectId: null,
  environment: "production",
  tracesSampleRate: 0,
  logsEnabled: false,
  profilingAvailable: false,
  lastError: null,
};

let initialized = false;
let sentrySdk: SentryNode | null = null;
/** Turned off on purpose, as opposed to never configured.  Kept apart so
 * the boot line and the Settings card can tell the operator which it is. */
let killed = false;
/** The option set the running client was initialised with, as a comparison
 * key: host, project id, the knobs, and a one-way digest of the whole DSN.
 * The digest is what makes a rotated key on the same host and project count
 * as a different client; it is module-local, never reaches a status field,
 * a log line or an error, and cannot be turned back into the DSN. */
let activeFingerprint: string | null = null;
let profilingWarned = false;
let runtimeState: SentryRuntimeState = { ...DORMANT };
let loaderForTests: (() => SentryNode | null | Promise<SentryNode | null>) | null = null;
/** Serializes `applySentryConfig`.  `await loadSdk()` yields, so two callers
 * could otherwise both pass the fingerprint check, both `shutdown()`, and
 * both `init()` with no `close()` in between. */
let applyQueue: Promise<void> = Promise.resolve();

function isTestEnv(): boolean {
  return process.env.VITEST === "true" || process.env.NODE_ENV === "test";
}

/** The thrown value from a `catch`, rendered for a status field or a log
 * line.  Named `cause` because that is exactly what it is: the error-cause
 * value a boundary caught, not a parsed domain type. */
function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** @sentry/core's own DSN grammar, transcribed.  The SDK is the only
 * opinion that counts here, and it is stricter than `new URL`: `DSN_REGEX`
 * in `@sentry/core@10.73.0`'s `utils/dsn.js` wants a word-character public
 * key (no hyphen, no dot), a word/dot/hyphen host or a bracketed IPv6
 * literal, and `validateDsn` wants an all-digit project id.
 *
 * Being looser than the SDK is not a cosmetic mismatch, it is a credential
 * leak.  When a string fails `DSN_REGEX`, `dsnFromString` prints
 * `Invalid Sentry Dsn: <the whole DSN>` through `console.error` — public key
 * and all, not gated on a debug build — and then returns nothing, so the
 * client is built with no DSN and quietly captures nothing while this module
 * would report it running.  A DSN this file waves through therefore ends up
 * in the harness log on every boot.  Intercepting that `console.error` is
 * not an option either: it goes through `consoleSandbox`, which swaps in the
 * console methods captured when `@sentry/core` was first loaded and so walks
 * straight past any wrapper installed later.  Rejecting at the door is the
 * whole defence. */
const DSN_PUBLIC_KEY = /^\w+$/;
const DSN_PASSWORD = /^\w*$/;
const DSN_HOST = /^(?:\[[:.%\w]+\]|[\w.-]+)$/;
const DSN_PROJECT_ID = /^\d+$/;

/** What the harness says about a value that is stored but is not a DSN.  One
 * constant so the runtime state, the status view, and the boot line cannot
 * describe the same condition three different ways. */
export const MALFORMED_DSN_MESSAGE = "The stored DSN is not a Sentry https:// DSN.";

/** What the harness says when the SDK itself refused a DSN this module had
 * already accepted — only reachable if a future SDK tightens its grammar
 * past ours.  Reported instead of `active: true` so the failure is visible
 * rather than a client that looks alive and sends nothing. */
export const SDK_REJECTED_DSN_MESSAGE =
  "Sentry refused this DSN, so nothing is being reported.  Check it in Settings > Observability.";

/** Split a DSN into the two halves that are safe to show.  Returns null for
 * anything that is not a DSN, which is how a malformed stored value becomes
 * a visible `lastError` instead of a silently inert SDK. */
export function describeDsn(dsn: string): { host: string; projectId: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(dsn.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (!DSN_PUBLIC_KEY.test(parsed.username)) return null;
  if (!DSN_PASSWORD.test(parsed.password)) return null;
  if (!DSN_HOST.test(parsed.hostname)) return null;
  const projectId = parsed.pathname.split("/").filter(Boolean).pop();
  if (!projectId || !DSN_PROJECT_ID.test(projectId)) return null;
  return { host: parsed.host, projectId };
}

/** A one-way digest of the complete DSN, public key included.  Host and
 * project id alone cannot tell a rotated credential from the one it
 * replaced, so a routine key rotation would leave the old — possibly
 * revoked — client installed while the status view reported the new
 * configuration as active.  Hashing keeps that distinction without ever
 * holding the credential anywhere it could be printed: the digest is
 * compared against the previous digest and discarded, and sha256 gives no
 * way back to the DSN it was made from. */
function dsnDigest(dsn: string): string {
  return createHash("sha256").update(dsn.trim()).digest("hex");
}

export function sentryDsnFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = (env.SENTRY_DSN || env.BOTFLEET_SENTRY_DSN || "").trim();
  return raw || undefined;
}

interface SentrySdkLoad {
  sdk: SentryNode | null;
  error: string | null;
}

/** Load the SDK.  Under vitest this returns nothing at all: the suite uses
 * sentinel DSNs, and a real client would build a real transport pointed at
 * them.  Tests that need the wiring exercised install a fake through
 * `setSentryLoaderForTests`. */
async function loadSdk(): Promise<SentrySdkLoad> {
  if (loaderForTests) {
    try {
      return { sdk: await loaderForTests(), error: null };
    } catch (err) {
      return { sdk: null, error: errorText(err) };
    }
  }
  if (isTestEnv()) return { sdk: null, error: null };
  try {
    
    // SAFETY: lazy-load so vitest importing the harness does not boot the Node SDK.
    return { sdk: (await import("@sentry/node")) as unknown as SentryNode, error: null };
  } catch (err) {
    return { sdk: null, error: `Sentry SDK failed to load: ${errorText(err)}` };
  }
}

/** Stop the running client.  The close is deliberately not awaited: this
 * runs on the PATCH /api/config path, and a hung flush must not hold a
 * request open.  `initialized` drops first, so `isSentryActive()` gates
 * captures off the instant the switch flips, flush or no flush. */
function shutdown(): void {
  const sdk = sentrySdk;
  sentrySdk = null;
  initialized = false;
  activeFingerprint = null;
  if (!sdk) return;
  try {
    void Promise.resolve(sdk.close(2000)).catch(() => {});
  } catch {
    /* an SDK that cannot close must not take the harness down with it */
  }
}

/** @sentry/profiling-node is in neither package.json nor the lockfile, so
 * this require has always thrown into an empty catch.  Try anyway — an
 * operator who installs it gets the profiler — but say so once when it is
 * missing rather than pretending profiling is on. */
function attachProfiling(sdk: SentryNode): boolean {
  try {
    
    // SAFETY: the only export this needs is the integration factory, and a
    // package that does not have it throws straight into the catch below.
    const require = createRequire(import.meta.url);
    const { nodeProfilingIntegration } = require("@sentry/profiling-node") as {
      nodeProfilingIntegration: () => SentryIntegration;
    };
    sdk.addIntegration(nodeProfilingIntegration());
    return true;
  } catch {
    if (!profilingWarned) {
      profilingWarned = true;
      console.warn("[sentry] profiling disabled: @sentry/profiling-node is not installed");
    }
    return false;
  }
}

/** Did the SDK keep the DSN it was just handed?  `Sentry.init` never throws
 * on a DSN its own parser refuses — it builds a client with none — so the
 * only way to tell a live client from an inert one is to ask it. */
function acceptedDsn(sdk: SentryNode): "ok" | "rejected" | "unknown" {
  try {
    // Optional calls, not defensive typing: a stand-in SDK installed by a
    // test carries only the members the runtime reaches for, and "cannot
    // tell" is the right answer for one that has no client to ask.
    const client = sdk.getClient?.();
    if (!client) return "unknown";
    return client.getDsn?.() ? "ok" : "rejected";
  } catch {
    return "unknown";
  }
}

/** Bring the running client in line with `input`, and report what actually
 * happened.  Called at boot and again after every settings change, so it
 * has to be idempotent: an unchanged option set leaves the client alone. */
export async function applySentryConfig(input: SentryRuntimeInput): Promise<SentryRuntimeState> {
  const run = applyQueue.then(() => applySentryConfigLocked(input));
  applyQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function applySentryConfigLocked(input: SentryRuntimeInput): Promise<SentryRuntimeState> {
  const parsed = input.dsn ? describeDsn(input.dsn) : null;
  const base: Omit<SentryRuntimeState, "active"> = {
    source: input.source,
    host: parsed?.host ?? null,
    projectId: parsed?.projectId ?? null,
    environment: input.environment,
    tracesSampleRate: input.tracesSampleRate,
    logsEnabled: input.logsEnabled,
    profilingAvailable: false,
    lastError: null,
  };

  if (!input.enabled || !input.dsn || !parsed) {
    shutdown();
    killed = !input.enabled;
    runtimeState = {
      ...base,
      active: false,
      lastError: input.enabled && input.dsn && !parsed ? MALFORMED_DSN_MESSAGE : null,
    };
    return runtimeState;
  }

  killed = false;
  // Every option that changes what the client does belongs in the
  // fingerprint, not just the destination: a sample-rate change made in
  // Settings has to reach the SDK, and comparing only host and project id
  // would leave the old rate running until the next restart.  The DSN
  // digest is in here for the same reason — a rotated key keeps the host
  // and the project id, so without it the old credential would stay
  // installed while Settings reported the new one as active.
  const fingerprint = [
    parsed.host,
    parsed.projectId,
    dsnDigest(input.dsn),
    input.environment,
    String(input.tracesSampleRate),
    input.logsEnabled ? "logs" : "nologs",
  ].join("|");
  if (initialized && activeFingerprint === fingerprint) {
    runtimeState = { ...base, active: true, profilingAvailable: runtimeState.profilingAvailable };
    return runtimeState;
  }

  shutdown();
  const { sdk, error } = await loadSdk();
  if (!sdk) {
    runtimeState = { ...base, active: false, lastError: error };
    return runtimeState;
  }

  const profileSessionSampleRate = Number(process.env.SENTRY_PROFILE_SESSION_SAMPLE_RATE ?? "1");
  try {
    sdk.init({
      dsn: input.dsn,
      environment: input.environment,
      tracesSampleRate: input.tracesSampleRate,
      enableLogs: true,
      // enableLogs alone only produces breadcrumbs; the console integration
      // is what turns a warn or an error into a Sentry log.
      integrations: input.logsEnabled
        ? [sdk.consoleLoggingIntegration({ levels: ["warn", "error"] })]
        : [],
      sendDefaultPii: false,
      profileSessionSampleRate: Number.isFinite(profileSessionSampleRate)
        ? Math.min(Math.max(profileSessionSampleRate, 0), 1)
        : 1,
      profileLifecycle: "trace",
    });
  } catch (err) {
    runtimeState = { ...base, active: false, lastError: errorText(err) };
    return runtimeState;
  }

  // Belt and braces against an SDK grammar stricter than `describeDsn`: ask
  // the client which DSN it actually kept.  A client that kept none captures
  // nothing, and reporting that as `active: true` is the exact failure this
  // module exists to prevent.  A stand-in SDK without `getClient` answers
  // "unknown" and is left alone.
  if (acceptedDsn(sdk) === "rejected") {
    shutdown();
    runtimeState = { ...base, active: false, lastError: SDK_REJECTED_DSN_MESSAGE };
    return runtimeState;
  }

  const profilingAvailable = attachProfiling(sdk);
  sentrySdk = sdk;
  initialized = true;
  activeFingerprint = fingerprint;
  runtimeState = { ...base, active: true, profilingAvailable };
  return runtimeState;
}

/** True only while a client is running and nobody has turned it off.  Every
 * capture site gates on this, not on `isSentryInitialized`, so flipping the
 * switch stops reporting immediately instead of at the next restart. */
export function isSentryActive(): boolean {
  return initialized && !killed;
}

export function sentryRuntimeState(): SentryRuntimeState {
  return { ...runtimeState };
}

/** Env-only entry point, kept for callers that boot before app config is
 * loaded.  The observability manager is the richer path. */
export async function initSentry(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (initialized) return true;
  if (env.VITEST === "true" || env.NODE_ENV === "test") return false;
  const dsn = sentryDsnFromEnv(env);
  const tracesSampleRate = Number(env.SENTRY_TRACES_SAMPLE_RATE ?? "0.2");
  return (await applySentryConfig({
    dsn: dsn ?? null,
    enabled: true,
    environment: (env.SENTRY_ENV || env.NODE_ENV || "production").trim() || "production",
    tracesSampleRate: Number.isFinite(tracesSampleRate)
      ? Math.min(Math.max(tracesSampleRate, 0), 1)
      : 0.2,
    logsEnabled: true,
    source: dsn ? "env" : "none",
  })).active;
}

export function isSentryInitialized(): boolean {
  return initialized;
}

export function getSentry(): SentryNode | null {
  return sentrySdk;
}

/** Install a stand-in for @sentry/node so a test can exercise the init,
 * close and re-init path without a network client.  Pass null to restore
 * the real loader. */
export function setSentryLoaderForTests(
  loader: (() => SentryNode | null | Promise<SentryNode | null>) | null,
): void {
  loaderForTests = loader;
}

export function resetSentryForTests(): void {
  initialized = false;
  sentrySdk = null;
  killed = false;
  activeFingerprint = null;
  profilingWarned = false;
  loaderForTests = null;
  applyQueue = Promise.resolve();
  runtimeState = { ...DORMANT };
}
