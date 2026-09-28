/**
 * Sentry client observability for BotFleet.
 *
 * `initSentryFromRuntime()` asks the harness for the saved switch before it
 * starts either a runtime client or the VITE_SENTRY_DSN packaged default.
 * `refreshSentryFromRuntime()` reapplies that choice after Settings >
 * Observability changes.  A failed boot read leaves the window inert, while
 * a failed refresh leaves the current client alone.
 * Completely inert in dev/CI when neither path finds a DSN.
 *
 * Replay stays 100% on error / 10% session with mask-all privacy.
 * User Feedback is the consumer widget.  Agent traces live on the
 * Node harness (`server/sentry.ts`), not this browser bundle.
 */

import { lazy } from "react";
import type * as SentryTypes from "@sentry/react";
import { redactSecretsInText } from "../../shared/redact";

/** The real SDK's shape, used only to type the dynamic loader below.
 * `import type` and `typeof import()` are both erased at build time, so
 * neither this alias nor `SentryTypes` puts `@sentry/react` in the chunk
 * that ships whether or not a DSN is configured — that was UI3. Exported so
 * a test can type a stand-in module for `setSentryModuleLoaderForTests`. */
export type SentryModule = typeof import("@sentry/react");

/** Everything that decides what a client this module starts will do.  The
 * rest of the browser SDK's configuration is fixed here, so a stand-in
 * installed by a test does not have to reproduce any of it. */
export interface SentryClientOptions {
  dsn: string;
  environment: string;
  tracesSampleRate: number;
  replayEnabled: boolean;
  replaysSessionSampleRate: number;
  replaysOnErrorSampleRate: number;
}

/** The three things this module does to the browser SDK.  Behind a port so
 * a test can install a stand-in and drive the real control flow, the way
 * `setSentryLoaderForTests` does for the harness in `server/sentry.ts`. */
export interface SentryBrowserPort {
  init(options: SentryClientOptions): void;
  close(): PromiseLike<boolean>;
  getClient(): { close(): PromiseLike<boolean> } | undefined;
}

/** What `GET /api/observability` answers with, narrowed to the four fields
 * the renderer needs.  The harness owns the full status view; anything else
 * on the response is deliberately ignored here. */
export interface RuntimeObservability {
  enabled?: boolean;
  requestedEnabled?: boolean;
  dsn?: string | null;
  environment?: string;
  tracesSampleRate?: number;
  uiTracesSampleRate?: number;
}

/** How the renderer asks the harness what it resolved. */
export type ObservabilityReader = () => Promise<RuntimeObservability | null>;

/** How this module reaches the real SDK — swappable so a test can control
 * exactly when "the import resolved" happens without ever loading the real
 * `@sentry/react` package, the same reason `setSentryPortForTests` exists. */
type SentryModuleLoader = () => Promise<SentryModule>;
const realSentryModuleLoader: SentryModuleLoader = () => import("@sentry/react");
let sentryModuleLoader: SentryModuleLoader = realSentryModuleLoader;

/** Memoized load — one fetch/parse no matter how many things below ask for
 * the module (init, close, a capture made while it is still loading, and
 * the lazy ErrorBoundary all share this promise). */
let sentryModulePromise: Promise<SentryModule> | null = null;
function loadSentryModule(): Promise<SentryModule> {
  sentryModulePromise ??= sentryModuleLoader();
  return sentryModulePromise;
}

/** The module once its dynamic import has actually resolved, or null before
 * that and after close(). Distinct from `initialized` below, which flips
 * true the instant init() is called so callers see "a client is coming"
 * right away — isSentryFeedbackAvailable() and the capture functions need
 * to know the SDK is actually running, not merely requested. */
let loadedSentry: SentryModule | null = null;
/** Bumped on every init() and close() so an import that resolves after a
 * newer init() or a close() request knows not to (re)start a client nobody
 * wants anymore — the async gap a dynamic import adds that a synchronous
 * `Sentry.init()` call never had. */
let pendingInitGeneration = 0;

const browserPort: SentryBrowserPort = {
  init(options: SentryClientOptions): void {
    const generation = ++pendingInitGeneration;
    void loadSentryModule()
      .then((Sentry) => {
        if (generation !== pendingInitGeneration) return; // superseded or closed
        Sentry.init({
          dsn: options.dsn,
          environment: options.environment,
          tracesSampleRate: options.tracesSampleRate,
          enableLogs: true,
          sendDefaultPii: false,
          dataCollection: {
            userInfo: false,
            cookies: false,
            httpHeaders: { request: false, response: false },
            queryParams: false,
            genAI: { inputs: false, outputs: false },
          },
          replaysSessionSampleRate: options.replaysSessionSampleRate,
          replaysOnErrorSampleRate: options.replaysOnErrorSampleRate,
          integrations: [
            Sentry.browserTracingIntegration(),
            Sentry.feedbackIntegration({
              colorScheme: "light",
              autoInject: false,
              showBranding: false,
              buttonLabel: "Report a problem",
              submitButtonLabel: "Send",
              formTitle: "Report a problem",
            }),
            ...(options.replayEnabled
              ? [
                  Sentry.replayIntegration({
                    maskAllText: true,
                    blockAllMedia: true,
                  }),
                ]
              : []),
          ],
        });
        loadedSentry = Sentry;
      })
      .catch(() => {
        /* @sentry/react failed to load (offline first launch, a blocked
         * request, …) — the renderer stays exactly as inert as it is today
         * with no DSN configured */
      });
  },
  close: () => {
    pendingInitGeneration++; // cancel an init() still in flight
    if (!loadedSentry) return Promise.resolve(true);
    const client = loadedSentry;
    loadedSentry = null;
    return client.close();
  },
  getClient: () => loadedSentry?.getClient(),
};

const harnessReader: ObservabilityReader = async () => {
  // The same helper the settings store uses, so an attached webview and a
  // plain dev-server tab resolve the harness identically (retries once on
  // the 502 a harness restart briefly returns).
  const { api } = await import("@/state/store");
  const data: RuntimeObservability | null = await api("/api/observability");
  return data;
};

let sentryPort: SentryBrowserPort = browserPort;
let readObservability: ObservabilityReader = harnessReader;

/** A client is running, whichever path started it. */
let initialized = false;
/** The current client is using the packaged default configuration. */
let buildTimeClientActive = false;
/** The packaged default stays available if an explicit opt-out is reversed. */
let buildTimeOptions: SentryClientOptions | null = null;
/** Monotonic read fence so a slow boot response cannot undo a newer Save. */
let observabilityReadGeneration = 0;
/**
 * DSN, environment and trace rate of the client this module started, or null
 * when it has none running.  Compared on every refresh so an
 * unchanged answer from the harness leaves the client alone instead of
 * tearing one down and rebuilding it on every save.  Renderer-local and
 * never logged; it lives in the process that already holds the DSN.
 */
let runtimeIdentity: string | null = null;

/** Vite types every `import.meta.env` entry loosely, so read one through a
 * string-shaped door instead of asserting at each call site.  An entry that
 * was never inlined reads as undefined and the caller falls back. */
function viteEnvText(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function packagedClientOptions(): SentryClientOptions | null {
  const dsn = viteEnvText(import.meta.env.VITE_SENTRY_DSN);
  if (!dsn) return null;

  const env = viteEnvText(import.meta.env.VITE_SENTRY_ENV) || viteEnvText(import.meta.env.MODE) || "production";

  const tracesSampleRate = Number(viteEnvText(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE) ?? "0.2");
  const replayRaw = viteEnvText(import.meta.env.VITE_SENTRY_REPLAY_ENABLED);
  const replayDisabled = replayRaw ? /^(false|0|off|no)$/i.test(replayRaw) : false;
  const replaysSessionSampleRate = Number(viteEnvText(import.meta.env.VITE_SENTRY_REPLAY_SESSION_SAMPLE_RATE) ?? "0.1");
  const replaysOnErrorSampleRate = Number(viteEnvText(import.meta.env.VITE_SENTRY_REPLAY_ERROR_SAMPLE_RATE) ?? "1.0");

  return {
    dsn,
    environment: env,
    tracesSampleRate: Number.isFinite(tracesSampleRate) ? Math.min(Math.max(tracesSampleRate, 0), 1) : 0.2,
    replayEnabled: !replayDisabled,
    replaysSessionSampleRate: !replayDisabled && Number.isFinite(replaysSessionSampleRate) ? replaysSessionSampleRate : 0,
    replaysOnErrorSampleRate: !replayDisabled && Number.isFinite(replaysOnErrorSampleRate) ? replaysOnErrorSampleRate : 0,
  };
}

export function initSentry(): void {
  if (initialized || !globalThis.window) return;
  const options = packagedClientOptions();
  if (!options) return;
  sentryPort.init(options);

  initialized = true;
  runtimeIdentity = runtimeIdentityOf(options.dsn, options.environment, options.tracesSampleRate);
  buildTimeOptions = options;
  buildTimeClientActive = true;
}

/** Sentry's ErrorBoundary, code-split with the rest of the SDK (UI3). No
 * call site mounts this today; wrap it in <Suspense> when one does — until
 * the chunk resolves it renders nothing, same as any other React.lazy. */
export const SentryErrorBoundary = lazy(() =>
  loadSentryModule().then((Sentry) => ({ default: Sentry.ErrorBoundary })),
);

/**
 * Send an exception to Sentry if the client has already loaded. If init()
 * was called and the import is still resolving, queue it and flush once the
 * client starts; if nothing is loading — init() was never called, or the
 * pending one was superseded or closed — the capture is dropped, matching
 * what the real SDK does with no client attached to report to.
 */
export function captureException(
  exception: unknown,
  hint?: Parameters<SentryModule["captureException"]>[1],
): string | undefined {
  if (loadedSentry) return loadedSentry.captureException(exception, hint);
  if (!sentryModulePromise) return undefined;
  // Not the resolved module itself — loadedSentry (set by init()'s own
  // .then(), queued ahead of this one on the same promise) is what says
  // whether the client actually started.
  void sentryModulePromise
    .then(() => {
      if (loadedSentry) loadedSentry.captureException(exception, hint);
    })
    .catch(() => {});
  return undefined;
}

/** Same gate-and-queue as {@link captureException}, for a plain message. */
export function captureMessage(
  message: string,
  captureContext?: Parameters<SentryModule["captureMessage"]>[1],
): string | undefined {
  if (loadedSentry) return loadedSentry.captureMessage(message, captureContext);
  if (!sentryModulePromise) return undefined;
  void sentryModulePromise
    .then(() => {
      if (loadedSentry) loadedSentry.captureMessage(message, captureContext);
    })
    .catch(() => {});
  return undefined;
}

export interface OpenFeedbackOptions {
  formTitle?: string;
  defaultMessage?: string;
  defaultEmail?: string;
  defaultName?: string;
  /** The bot driver the failure came from, when the caller knows it.  Goes
   * into the synthetic diagnostics block, never into the message. */
  engine?: string;
}

interface SentryFeedbackDialog {
  appendToDom(): void;
  open(): void;
  close(): void;
  removeFromDom(): void;
}

let activeFeedbackDialog: SentryFeedbackDialog | null = null;
let isCreatingFeedback = false;
let activeFeedbackDetails: string | null = null;
let feedbackProcessorInstalled = false;

export function attachFeedbackEventDetails<T extends SentryTypes.Event>(event: T): T {
  if (event.type === "feedback" && activeFeedbackDetails) {
    return {
      ...event,
      contexts: {
        ...event.contexts,
        reported_problem: {
          error_details: activeFeedbackDetails,
        },
      },
    };
  }
  return event;
}

export function setActiveFeedbackDetailsForTests(details: string | null): void {
  activeFeedbackDetails = details;
}

function ensureFeedbackEventProcessor(): void {
  if (feedbackProcessorInstalled || !loadedSentry) return;
  feedbackProcessorInstalled = true;
  loadedSentry.addEventProcessor((event) => attachFeedbackEventDetails(event));
}

function toWellFormedString(val: string): string {
  if (typeof (val as { toWellFormed?: () => string }).toWellFormed === "function") {
    return (val as unknown as { toWellFormed: () => string }).toWellFormed();
  }
  let result = "";
  for (let i = 0; i < val.length; i++) {
    const code = val.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 < val.length) {
        const next = val.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          result += val[i] + val[i + 1];
          i++;
          continue;
        }
      }
      result += "\uFFFD";
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += "\uFFFD";
    } else {
      result += val[i];
    }
  }
  return result;
}

/** The five diagnostic facts that belong on a bug report, and nothing else.
 *
 * Every field is synthetic: a version string, a commit id, an OS name, a CPU
 * architecture, and a driver label.  None of them is derived from what the
 * user typed, and none of them identifies a person or a machine. */
export interface ReportDiagnostics {
  appVersion?: string;
  build?: string;
  os?: string;
  architecture?: string;
  /** The bot driver the failing turn ran on, when the renderer knows it. */
  engine?: string;
}

/** The labels every Report a Problem issue carries.
 *
 * `bug` is the repo's existing bug label.  `user-report` is the one that
 * keeps a filed-from-the-app report out of the ordinary maintainer triage
 * pile; GitHub silently drops a label that does not exist, so the owner has
 * to create it once (lowercase kebab, matching `effort-in-progress`). */
export const REPORT_ISSUE_LABELS = ["bug", "user-report"] as const;

const UNKNOWN = "unknown";

/** Installed version + build commit, cached for the life of the window.
 *
 * `buildFallbackIssueUrl` is synchronous, so the one round trip that can
 * answer this has to land before it is called, not inside it. */
interface ReportBuildIdentity {
  appVersion?: string;
  build?: string;
}

let reportBuildIdentity: ReportBuildIdentity = {};
let reportBuildIdentityRequest: Promise<void> | null = null;

/** Short form of a commit id — the full 40 characters cost issue-body
 * budget without telling a reader anything the short form does not.
 *
 * `raw` is a field of a JSON body the harness answered, so it is untrusted by
 * contract and no narrower named type would be honest here.  The guard below
 * is the decode, and everything after it branches on the decoded string. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function shortCommit(raw: unknown): string | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return /^[0-9a-f]{7,40}$/i.test(trimmed) ? trimmed.slice(0, 12) : trimmed.slice(0, 64);
}

/**
 * Ask the harness what build is running, once, and remember it.
 *
 * `GET /api/update/status` is the one loopback route that already reports
 * the installed version and its source commit, so this needs no new
 * endpoint and no new preload surface.  It is best effort: a timeout, an
 * offline harness, or a non-OK status leaves the fields `unknown` and the
 * report still files.
 */
export async function primeReportBuildIdentity(options?: {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<void> {
  if (Object.keys(reportBuildIdentity).length > 0) return;
  reportBuildIdentityRequest ??= (async () => {
    // Reading the global off `globalThis` keeps the "no fetch in this runtime"
    // case on the same `!doFetch` path below instead of a second check.
    const doFetch = options?.fetchImpl ?? globalThis.fetch;
    if (!doFetch) return;
    try {
      const response = await doFetch("/api/update/status", {
        signal: AbortSignal.timeout(options?.timeoutMs ?? 1_500),
      });
      if (!response.ok) return;
      // SAFETY: this is the harness's own `/api/update/status` answer, whose
      // `installed` block carries a version string and a commit id; both are
      // read as `unknown` and re-checked before anything is reported.
      const body = (await response.json()) as { installed?: { version?: unknown; sourceCommit?: unknown } };
      const installed = body?.installed;
      if (!installed) return;
      // A version that is not a string is the one field the harness may be
      // mid-write on, so it reads as "no version" and the commit still stands.
      // oxlint-disable-next-line anti-slop/no-runtime-typeof
      const appVersion = typeof installed.version === "string" ? installed.version.trim().slice(0, 64) : "";
      const build = shortCommit(installed.sourceCommit) ?? "";
      if (appVersion || build) reportBuildIdentity = { appVersion, build };
    } catch {
      /* an unreadable build identity is not a reason to lose the report */
    }
  })();
  try {
    await reportBuildIdentityRequest;
  } finally {
    // A failed attempt must not be cached, or one dead harness would keep
    // every later report in this window version-less.
    if (reportBuildIdentityRequest && Object.keys(reportBuildIdentity).length === 0) {
      reportBuildIdentityRequest = null;
    }
  }
}

/** Reset the cached build identity.  Test-only. */
export function resetReportBuildIdentityForTests(): void {
  reportBuildIdentity = {};
  reportBuildIdentityRequest = null;
}

/** Override the cached build identity.  Test-only. */
export function setReportBuildIdentityForTests(identity: { appVersion?: string; build?: string }): void {
  reportBuildIdentity = { ...identity };
  reportBuildIdentityRequest = null;
}

interface NavigatorHints {
  platform?: string;
  platformVersion?: string;
  architecture?: string;
  bitness?: string;
}

/** Chromium's UA client hints, which the packaged desktop app always has. */
function userAgentHints(): NavigatorHints {
  // SAFETY: `userAgentData` is Chromium's own client-hints object; the DOM lib
  // types do not declare it, so this widens the navigator by exactly that one
  // key and every field it hands back is read as `string | undefined`.
  const hints = (globalThis.navigator as { userAgentData?: NavigatorHints } | undefined)?.userAgentData;
  return hints ?? {};
}

/** OS and CPU, read from what this window can already see. */
interface HostFacts {
  os: string;
  architecture: string;
}

function hostFacts(): HostFacts {
  const hints = userAgentHints();
  // SAFETY: `ogb` is this app's own preload bridge, absent in a plain browser
  // tab; the assertion widens the window by exactly that one optional key.
  const ogbPlatform = (globalThis.window as { ogb?: { platform?: string } } | undefined)?.ogb?.platform;
  const osParts = [hints.platform ?? ogbPlatform, hints.platformVersion].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  const arch = [hints.architecture ?? "", hints.bitness === undefined ? "" : `${hints.bitness}-bit`]
    .filter((part) => part.length > 0)
    .join(" ");
  return {
    os: osParts.length > 0 ? osParts.join(" ") : UNKNOWN,
    architecture: arch || UNKNOWN,
  };
}

/** The diagnostics a report carries: whatever the caller stated, filled in
 * from the cached build identity and the window's own host facts. */
export function readReportDiagnostics(overrides: ReportDiagnostics = {}): ReportDiagnostics {
  const host = hostFacts();
  return {
    appVersion: overrides.appVersion || reportBuildIdentity.appVersion || UNKNOWN,
    build: overrides.build || reportBuildIdentity.build || UNKNOWN,
    os: overrides.os || host.os,
    architecture: overrides.architecture || host.architecture,
    engine: overrides.engine,
  };
}

/** One field of the context block.  Values are sentence case and clipped, so
 * a hostile value cannot reformat the block or blow the body budget. */
function diagnosticLine(label: string, value: string | undefined): string {
  const flat = (value ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  return `- ${label}: ${flat || UNKNOWN}`;
}

function diagnosticsBlock(diagnostics: ReportDiagnostics): string {
  return [
    "**Diagnostics (synthetic — generated by the app, not user data):**",
    diagnosticLine("App version", diagnostics.appVersion),
    diagnosticLine("Build", diagnostics.build),
    diagnosticLine("OS", diagnostics.os),
    diagnosticLine("Architecture", diagnostics.architecture),
    diagnosticLine("Engine", diagnostics.engine),
  ].join("\n");
}

const ISSUE_LABEL_SUFFIX = `&labels=${encodeURIComponent(REPORT_ISSUE_LABELS.join(","))}`;

export function buildFallbackIssueUrl(
  rawTitle: string,
  rawMessage?: string,
  maxTotalLength = 2000,
  diagnostics: ReportDiagnostics = {},
): string {
  const wellFormedTitle = toWellFormedString(rawTitle || "Bug Report");
  const points = Array.from(wellFormedTitle);
  const safeTitle = (points.length > 80 ? points.slice(0, 80).join("") + "…" : points.join(""));
  const encodedTitle = encodeURIComponent(safeTitle);
  const base = `https://github.com/jaywedgeworth22/BotFleet/issues/new?title=${encodedTitle}&body=`;
  const budget = maxTotalLength - base.length - ISSUE_LABEL_SUFFIX.length;
  if (budget <= 0) return base + ISSUE_LABEL_SUFFIX;

  const context = diagnosticsBlock(readReportDiagnostics(diagnostics));
  if (!rawMessage) {
    const defaultBody =
      "<!-- Describe the problem and reproduction steps here -->\n\n" +
      `${context}\n\n` +
      "*(Submitted via BotFleet)*";
    const encoded = encodeURIComponent(defaultBody);
    // A caller who passed a body budget too small for the context block
    // still gets a report; the description placeholder is what gets cut.
    if (encoded.length > budget) return base + encodeURIComponent("<!-- Describe the problem and reproduction steps here -->") + ISSUE_LABEL_SUFFIX;
    return base + encoded + ISSUE_LABEL_SUFFIX;
  }

  // Redact before anything is measured or encoded.  The issue body lands in
  // a public repository, so a token that rode in on an error string must
  // never reach the URL.
  const wellFormedMsg = toWellFormedString(redactSecretsInText(toWellFormedString(rawMessage)));
  const header = "**Reported Problem:**\n";
  const footer = `\n\n${context}\n\n*(Submitted via BotFleet)*`;
  const msgPoints = Array.from(wellFormedMsg);
  let low = 0;
  let high = Math.min(msgPoints.length, budget);
  let best = "";

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidateSlice = msgPoints.slice(0, mid).join("") + (mid < msgPoints.length ? "…" : "");
    const candidateText = `${header}${candidateSlice}${footer}`;
    try {
      const candidateEncoded = encodeURIComponent(candidateText);
      if (candidateEncoded.length <= budget) {
        best = candidateEncoded;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    } catch {
      high = mid - 1;
    }
  }

  return base + best + ISSUE_LABEL_SUFFIX;
}

export function isSentryFeedbackAvailable(): boolean {
  if (!globalThis.window || !initialized || !loadedSentry) return false;
  return Boolean(loadedSentry.getFeedback());
}

export async function openSentryFeedback(options?: OpenFeedbackOptions): Promise<void> {
  if (!globalThis.window) return;
  try {
    if (!isSentryFeedbackAvailable()) {
      // One loopback round trip so the report can name the build it came
      // from.  Bounded and swallowed, so a dead harness costs a moment and
      // never a report.
      await primeReportBuildIdentity();
      const url = buildFallbackIssueUrl(
        options?.formTitle ?? "Report a Problem",
        options?.defaultMessage,
        2000,
        { engine: options?.engine },
      );
      if (typeof window !== "undefined") {
        if (window.ogb?.openExternal) {
          await window.ogb.openExternal(url);
        } else {
          window.open(url, "_blank", "noopener,noreferrer");
        }
      }
      return;
    }

    const feedback = loadedSentry?.getFeedback();
    if (!feedback || isCreatingFeedback) return;
    isCreatingFeedback = true;
    ensureFeedbackEventProcessor();

    let formOpened = false;
    try {
      if (activeFeedbackDialog) {
        try {
          activeFeedbackDialog.close();
          activeFeedbackDialog.removeFromDom();
        } catch {
          /* ignore cleanup failure */
        }
        activeFeedbackDialog = null;
      }

      activeFeedbackDetails = options?.defaultMessage ?? null;

      const cleanup = () => {
        dialog?.removeFromDom();
        activeFeedbackDialog = null;
        activeFeedbackDetails = null;
      };

      const dialog = (await feedback.createForm({
        formTitle: options?.formTitle ?? "Report a Problem",
        messagePlaceholder: options?.defaultMessage ? `Details: ${options.defaultMessage}` : "What went wrong?",
        tags: options?.defaultMessage ? { reportedError: options.defaultMessage.slice(0, 200) } : undefined,
        onFormSubmitted: cleanup,
        onFormClose: cleanup,
      })) as unknown as (SentryFeedbackDialog & { el?: unknown }) | undefined;

      if (dialog) {
        activeFeedbackDialog = dialog;
        dialog.appendToDom();
        dialog.open();
        formOpened = true;
        if (options?.defaultMessage) {
          try {
            const shadow = (dialog.el as { shadowRoot?: ShadowRoot | null } | undefined)?.shadowRoot;
            const textarea = shadow?.querySelector("textarea");
            if (textarea) {
              textarea.value = options.defaultMessage;
              textarea.dispatchEvent(new Event("input", { bubbles: true }));
            }
          } catch {
            /* ignore DOM inspection failures */
          }
        }
      }
    } finally {
      isCreatingFeedback = false;
      if (!formOpened) {
        activeFeedbackDetails = null;
      }
    }
  } catch {
    /* If the feedback dialog cannot be opened, swallow to protect the renderer */
  }
}


/** The option set that decides whether the running client is still the right
 * one.  Anything that changes where events go, or how many of them go,
 * belongs here — a rotated key on the same host has to count as different. */
function runtimeIdentityOf(dsn: string, environment: string, tracesSampleRate: number): string {
  return `${dsn}|${environment}|${tracesSampleRate}`;
}

/**
 * Stop the client this module started, so nothing more leaves this
 * window.  The close is deliberately not awaited: this runs on a Settings
 * click, and a hung flush must not hold the card open.  State drops first,
 * so a follow-up refresh sees "nothing running" whether the flush lands
 * or not.
 */
function closeClient(): void {
  runtimeIdentity = null;
  initialized = false;
  try {
    // `Sentry.close()` closes the client bound to the current scope; asking
    // the client directly is the same call without the global lookup, and a
    // window that somehow has no client still has to end up closed.
    const client = sentryPort.getClient();
    void Promise.resolve(client ? client.close() : sentryPort.close()).catch(() => {});
  } catch {
    /* a client that cannot close must not take the renderer down with it */
  }
}

/** Start the browser SDK against a DSN the harness resolved. */
function startRuntimeClient(dsn: string, environment: string, tracesSampleRate: number): void {
  const replayRaw = viteEnvText(import.meta.env.VITE_SENTRY_REPLAY_ENABLED);
  const replayDisabled = replayRaw ? /^(false|0|off|no)$/i.test(replayRaw) : false;
  const replaysSessionSampleRate = Number(viteEnvText(import.meta.env.VITE_SENTRY_REPLAY_SESSION_SAMPLE_RATE) ?? "0.1");
  const replaysOnErrorSampleRate = Number(viteEnvText(import.meta.env.VITE_SENTRY_REPLAY_ERROR_SAMPLE_RATE) ?? "1.0");
  const replayEnabled = buildTimeOptions?.replayEnabled ?? !replayDisabled;

  sentryPort.init({
    dsn,
    environment,
    tracesSampleRate,
    replayEnabled,
    replaysSessionSampleRate: replayEnabled
      ? buildTimeOptions?.replaysSessionSampleRate ?? (Number.isFinite(replaysSessionSampleRate) ? replaysSessionSampleRate : 0)
      : 0,
    replaysOnErrorSampleRate: replayEnabled
      ? buildTimeOptions?.replaysOnErrorSampleRate ?? (Number.isFinite(replaysOnErrorSampleRate) ? replaysOnErrorSampleRate : 0)
      : 0,
  });

  runtimeIdentity = runtimeIdentityOf(dsn, environment, tracesSampleRate);
  initialized = true;
}

/**
 * Bring the renderer's client in line with one `GET /api/observability`
 * answer.  An explicit opt-out closes every client; a usable runtime DSN
 * starts or replaces one; an unconfigured harness keeps or restores the
 * packaged default; and an unchanged answer does nothing.
 */
function applyRuntimeObservability(data: RuntimeObservability | null): void {
  // A missing/malformed answer is not an opt-out.  Keep the current client
  // until the harness returns an explicit status.
  if (!data) return;
  if (data.requestedEnabled === false) {
    buildTimeClientActive = false;
    if (runtimeIdentity) closeClient();
    return;
  }

  const dsn = data.dsn?.trim();
  if (!data.enabled || !dsn) {
    // An unconfigured harness has no DSN of its own, but that is not an
    // operator opt-out.  Keep a packaged build's client until the explicit
    // switch above says false.
    if (buildTimeClientActive) return;
    if (data.requestedEnabled === true && buildTimeOptions) {
      const identity = runtimeIdentityOf(
        buildTimeOptions.dsn,
        buildTimeOptions.environment,
        buildTimeOptions.tracesSampleRate,
      );
      if (runtimeIdentity === identity) {
        buildTimeClientActive = true;
        return;
      }
      if (runtimeIdentity) closeClient();
      sentryPort.init(buildTimeOptions);
      runtimeIdentity = identity;
      initialized = true;
      buildTimeClientActive = true;
      return;
    }
    if (runtimeIdentity) closeClient();
    return;
  }
  buildTimeClientActive = false;

  const environment = data.environment?.trim() || "production";
  const reportedRate = data.uiTracesSampleRate ?? data.tracesSampleRate;
  const resolvedRate = reportedRate !== undefined && Number.isFinite(reportedRate) ? reportedRate : 0.2;
  const tracesSampleRate = Math.min(Math.max(resolvedRate, 0), 1);

  if (runtimeIdentity === runtimeIdentityOf(dsn, environment, tracesSampleRate)) return;
  if (runtimeIdentity) closeClient();
  startRuntimeClient(dsn, environment, tracesSampleRate);
}

/**
 * Resolve the harness's live settings over `GET /api/observability`.  A
 * build-time client keeps reporting while that read is unavailable, but a
 * successful answer can disable or reconfigure it.  Without a build-time
 * client, the same answer starts the browser SDK from the runtime DSN.
 */
export async function initSentryFromRuntime(): Promise<void> {
  if (!globalThis.window || (initialized && !buildTimeClientActive)) return;
  // Prepare the fallback without starting it.  `applyRuntimeObservability`
  // may start it only after the harness has answered that diagnostics were
  // not explicitly disabled.
  buildTimeOptions ??= packagedClientOptions();
  const generation = ++observabilityReadGeneration;

  try {
    const data = await readObservability();
    if (generation !== observabilityReadGeneration) return;
    if (initialized && !buildTimeClientActive) return;
    applyRuntimeObservability(data);
  } catch {
    /* the harness may be unreachable (dev, or Settings > Observability
     * mid-restart) — the renderer stays exactly as inert as it is today */
  }
}

/**
 * Re-resolve after Settings > Observability changed something.  Without
 * this, a renderer that started reporting at boot keeps sending to the old
 * DSN — or keeps sending at all after the kill switch is off — until the
 * window is reloaded, and a DSN added after boot does nothing until the
 * next launch.  The Observability card calls it after a successful Save and
 * after Remove Diagnostics Key.
 *
 * Swallows every failure for the same reason `initSentryFromRuntime()` does.
 */
export async function refreshSentryFromRuntime(): Promise<void> {
  if (!globalThis.window) return;
  const generation = ++observabilityReadGeneration;

  try {
    const data = await readObservability();
    if (generation !== observabilityReadGeneration) return;
    applyRuntimeObservability(data);
  } catch {
    /* a harness that will not answer leaves the client exactly as it is */
  }
}

/** Install a stand-in for the browser SDK so a test can exercise the init,
 * close and re-init path without a real client.  Pass null to restore the
 * real one. */
export function setSentryPortForTests(port: SentryBrowserPort | null): void {
  sentryPort = port ?? browserPort;
}

/** Install a stand-in for the dynamic `import("@sentry/react")` itself, so a
 * test can drive the real `browserPort` (init/close race, capture gate and
 * queue) without ever loading the real SDK.  Pass null to restore the real
 * dynamic import. */
export function setSentryModuleLoaderForTests(loader: SentryModuleLoader | null): void {
  sentryModuleLoader = loader ?? realSentryModuleLoader;
}

/** Script what the harness answers, so a test needs no fetch and no store. */
export function setObservabilityReaderForTests(reader: ObservabilityReader | null): void {
  readObservability = reader ?? harnessReader;
}

export function resetSentryForTests(): void {
  initialized = false;
  buildTimeClientActive = false;
  buildTimeOptions = null;
  observabilityReadGeneration = 0;
  runtimeIdentity = null;
  sentryPort = browserPort;
  readObservability = harnessReader;
  activeFeedbackDetails = null;
  activeFeedbackDialog = null;
  isCreatingFeedback = false;
  sentryModulePromise = null;
  loadedSentry = null;
  pendingInitGeneration = 0;
  sentryModuleLoader = realSentryModuleLoader;
}
