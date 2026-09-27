// App settings → Observability: whether Sentry is watching this bot fleet,
// and the honest reason when it isn't (server/observability.ts).  The kill
// switch is explicit — a DSN with `enabled: false` reads "Turned off", never
// "Not configured"; those are different states an operator needs to tell
// apart.
import * as React from "react";
import { Check, CheckCircle, Loader2, RefreshCw, XCircle } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { Card } from "./SettingsPrimitives";
import { fetchObservabilityStatus, sendObservabilityTestEvent } from "@/lib/observability-client";
import { buildObservabilityConfigPatch, initialSendDiagnostics } from "@/lib/observability-config";
import { observabilityBadge, observabilityHost, type ObservabilityStatusView } from "@/lib/observability-status";
import { refreshSentryFromRuntime } from "@/lib/sentry";
import { productErrorHeadline } from "@/lib/product-error";

const observabilityInputClass =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:cursor-not-allowed disabled:opacity-60";

const cnSwitch = (on: boolean) =>
  `relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 ${on ? "bg-accent" : "bg-control"}`;
const cnKnob = (on: boolean) =>
  `absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all ${on ? "left-[21px]" : "left-[3px]"}`;

function sourceLabel(source: "env" | "config" | "none" | "infisical" | undefined): string {
  if (source === "env") return "Environment";
  if (source === "config") return "Settings";
  if (source === "infisical") return "Infisical";
  return "None";
}

export function ObservabilitySection() {
  const { state, dispatch } = useStore();
  const observabilityConfig = state.config?.observability;

  const [status, setStatus] = React.useState<ObservabilityStatusView | null>(null);
  const [statusFetchError, setStatusFetchError] = React.useState<string | null>(null);

  const [dsn, setDsn] = React.useState("");
  const [environment, setEnvironment] = React.useState(observabilityConfig?.environment ?? "");
  const [tracesSampleRate, setTracesSampleRate] = React.useState(observabilityConfig?.tracesSampleRate ?? 0.2);
  const [aiTracesSampleRate, setAiTracesSampleRate] = React.useState(observabilityConfig?.aiTracesSampleRate ?? 1.0);
  const [httpTracesSampleRate, setHttpTracesSampleRate] = React.useState(observabilityConfig?.httpTracesSampleRate ?? 0.1);
  const [uiTracesSampleRate, setUiTracesSampleRate] = React.useState(observabilityConfig?.uiTracesSampleRate ?? 0.1);
  const [enabled, setEnabled] = React.useState(initialSendDiagnostics(observabilityConfig));
  const [logsEnabled, setLogsEnabled] = React.useState(observabilityConfig?.logsEnabled ?? true);

  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saveOk, setSaveOk] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<{ ok: boolean; error: string | null; eventId?: string | null } | null>(null);
  const [removing, setRemoving] = React.useState(false);
  const [confirmingRemove, setConfirmingRemove] = React.useState(false);
  const confirmResetTimer = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (observabilityConfig?.environment !== undefined) setEnvironment(observabilityConfig.environment);
  }, [observabilityConfig?.environment]);
  React.useEffect(() => {
    if (observabilityConfig?.tracesSampleRate !== undefined) setTracesSampleRate(observabilityConfig.tracesSampleRate);
  }, [observabilityConfig?.tracesSampleRate]);
  React.useEffect(() => {
    if (observabilityConfig?.aiTracesSampleRate !== undefined) setAiTracesSampleRate(observabilityConfig.aiTracesSampleRate);
  }, [observabilityConfig?.aiTracesSampleRate]);
  React.useEffect(() => {
    if (observabilityConfig?.httpTracesSampleRate !== undefined) setHttpTracesSampleRate(observabilityConfig.httpTracesSampleRate);
  }, [observabilityConfig?.httpTracesSampleRate]);
  React.useEffect(() => {
    if (observabilityConfig?.uiTracesSampleRate !== undefined) setUiTracesSampleRate(observabilityConfig.uiTracesSampleRate);
  }, [observabilityConfig?.uiTracesSampleRate]);
  React.useEffect(() => {
    setEnabled(initialSendDiagnostics(observabilityConfig));
  }, [observabilityConfig?.configured, observabilityConfig?.enabled, observabilityConfig?.requestedEnabled]);
  React.useEffect(() => {
    if (observabilityConfig?.logsEnabled !== undefined) setLogsEnabled(observabilityConfig.logsEnabled);
  }, [observabilityConfig?.logsEnabled]);

  React.useEffect(
    () => () => {
      if (confirmResetTimer.current !== null) window.clearTimeout(confirmResetTimer.current);
    },
    [],
  );

  const refreshStatus = React.useCallback(async () => {
    try {
      setStatus(await fetchObservabilityStatus());
      setStatusFetchError(null);
    } catch (caught) {
      // A route that answered 404 or 403 is a state the operator has to see.
      // Discarding it here is what leaves the pill on "Waiting" for good.
      setStatusFetchError(caught instanceof Error ? caught.message : "Failed to fetch diagnostics status");
    }
  }, []);

  React.useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const badge = observabilityBadge(status, statusFetchError);
  // Whatever Sentry project host the operator (or the environment) pointed
  // this at — never the DSN itself.
  const host = observabilityHost(status);

  const hasDsn = Boolean(status?.configured ?? observabilityConfig?.hasDsn);
  const source = status?.source ?? observabilityConfig?.source ?? "none";
  const dsnLocked = source === "env";
  const viewEnvironment = status?.environment ?? observabilityConfig?.environment ?? "production";
  const viewTraces = status?.tracesSampleRate ?? observabilityConfig?.tracesSampleRate ?? 0.2;
  const viewAiTraces = status?.aiTracesSampleRate ?? observabilityConfig?.aiTracesSampleRate ?? 1.0;
  const viewHttpTraces = status?.httpTracesSampleRate ?? observabilityConfig?.httpTracesSampleRate ?? 0.1;
  const viewUiTraces = status?.uiTracesSampleRate ?? observabilityConfig?.uiTracesSampleRate ?? 0.1;
  const viewLogsEnabled = status?.logsEnabled ?? observabilityConfig?.logsEnabled ?? true;

  const save = async (): Promise<boolean> => {
    const built = buildObservabilityConfigPatch({
      sentryDsn: dsn,
      enabled,
      environment,
      tracesSampleRate,
      aiTracesSampleRate,
      httpTracesSampleRate,
      uiTracesSampleRate,
      logsEnabled,
    });
    if (!built.ok) {
      setSaveError(built.error);
      setSaveOk(false);
      return false;
    }
    setSaving(true);
    setSaveError(null);
    setSaveOk(false);
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ observability: built.patch }),
      });
      dispatch({ type: "configStatus", config });
      if (built.patch.sentryDsn) setDsn("");
      await refreshStatus();
      // The harness reconfigured itself on the PATCH; this window has its own
      // Sentry client and would otherwise keep reporting to the old DSN — or
      // keep reporting at all after the kill switch went off — until reload.
      await refreshSentryFromRuntime();
      setSaveOk(true);
      return true;
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const saved = await save();
      if (!saved) {
        setTestResult({ ok: false, error: "Fix the settings above before sending a test event." });
        return;
      }
      setTestResult(await sendObservabilityTestEvent());
      await refreshStatus();
    } catch (caught) {
      setTestResult({ ok: false, error: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setTesting(false);
    }
  };

  const removeDsn = async () => {
    if (!confirmingRemove) {
      setConfirmingRemove(true);
      if (confirmResetTimer.current !== null) window.clearTimeout(confirmResetTimer.current);
      confirmResetTimer.current = window.setTimeout(() => setConfirmingRemove(false), 4000);
      return;
    }
    if (confirmResetTimer.current !== null) window.clearTimeout(confirmResetTimer.current);
    setConfirmingRemove(false);
    setRemoving(true);
    setSaveError(null);
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ observability: { sentryDsn: "" } }),
      });
      dispatch({ type: "configStatus", config });
      setDsn("");
      await refreshStatus();
      // Stop using the removed runtime key.  A packaged build returns to its
      // baked default while the switch stays on; an explicit opt-out closes
      // that client too.
      await refreshSentryFromRuntime();
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Diagnostics & Error Reporting"
        subtitle={"An optional Sentry stream that reports failed bot turns, console warnings and errors, and performance traces so problems surface without you tailing a log.\u00A0 Prompts, transcripts, and tool arguments are never sent."}
      >
        <div className="flex flex-col gap-3 text-[13px]">
          <div className="flex items-center justify-between rounded-xl border border-hairline/30 bg-inset/40 px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <span
                className={`flex size-2 rounded-full ${
                  badge.tone === "error"
                    ? "bg-danger shadow-[0_0_8px_rgba(239,68,68,0.6)]"
                    : badge.tone === "active"
                      ? "bg-success shadow-[0_0_8px_rgba(34,197,94,0.6)] animate-pulse"
                      : badge.tone === "waiting"
                        ? "bg-warning"
                        : "bg-ink-secondary/40"
                }`}
              />
              <span className="font-medium text-ink">Sentry</span>
              <span className="text-[11.5px] text-ink-secondary font-mono">{host ?? "Not configured"}</span>
            </div>
            <span
              className={`rounded px-2 py-0.5 text-[11px] font-medium ${
                badge.tone === "error"
                  ? "bg-danger/15 text-danger"
                  : badge.tone === "active"
                    ? "bg-success/15 text-success"
                    : "bg-inset text-ink-secondary"
              }`}
              title={statusFetchError || status?.lastError || undefined}
            >
              {badge.label}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 text-[12px] sm:grid-cols-4">
            <div className="flex flex-col rounded-lg border border-hairline/20 bg-inset/20 p-2">
              <span className="text-ink-secondary">Environment</span>
              <span className="font-medium text-ink">{viewEnvironment}</span>
            </div>
            <div className="flex flex-col rounded-lg border border-hairline/20 bg-inset/20 p-2">
              <span className="text-ink-secondary">Source</span>
              <span className="font-medium text-ink">{sourceLabel(source)}</span>
            </div>
            <div className="flex flex-col rounded-lg border border-hairline/20 bg-inset/20 p-2">
              <span className="text-ink-secondary">Traces</span>
              <span
                className="font-medium text-ink"
                title={`AI: ${Math.round(viewAiTraces * 100)}%  ·  HTTP: ${Math.round(viewHttpTraces * 100)}%  ·  UI: ${Math.round(viewUiTraces * 100)}%`}
              >
                {viewAiTraces > 0 || viewHttpTraces > 0 || viewUiTraces > 0
                  ? `AI ${Math.round(viewAiTraces * 100)}%  ·  HTTP ${Math.round(viewHttpTraces * 100)}%  ·  UI ${Math.round(viewUiTraces * 100)}%`
                  : viewTraces > 0
                    ? `${Math.round(viewTraces * 100)}%`
                    : "Off"}
              </span>
            </div>
            <div className="flex flex-col rounded-lg border border-hairline/20 bg-inset/20 p-2">
              <span className="text-ink-secondary">Logs</span>
              <span className="font-medium text-ink">{viewLogsEnabled ? "Warnings and errors" : "Off"}</span>
            </div>
          </div>

          <div className="flex flex-col gap-3 rounded-xl border border-hairline/30 bg-inset/20 p-3">
            <div className="flex flex-col gap-1">
              <label className="text-[12px] font-medium text-ink-secondary" htmlFor="observability-dsn">
                Sentry DSN
              </label>
              <input
                id="observability-dsn"
                type="password"
                value={dsn}
                onChange={(e) => {
                  setDsn(e.target.value);
                  setSaveOk(false);
                }}
                onKeyDown={(e) => e.key === "Enter" && void save()}
                placeholder={dsnLocked ? "Set by the environment" : hasDsn ? "••••••••  (paste to replace)" : "https://<key>@<host>/<project>"}
                autoComplete="off"
                disabled={dsnLocked}
                className={observabilityInputClass}
              />
              {dsnLocked && (
                <div className="text-[11.5px] text-ink-secondary">Set by the environment on this computer.</div>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[12px] font-medium text-ink-secondary" htmlFor="observability-environment">
                Environment
              </label>
              <input
                id="observability-environment"
                type="text"
                value={environment}
                onChange={(e) => {
                  setEnvironment(e.target.value);
                  setSaveOk(false);
                }}
                onKeyDown={(e) => e.key === "Enter" && void save()}
                placeholder="production"
                autoComplete="off"
                className={observabilityInputClass}
              />
            </div>
            <div className="flex flex-col gap-2 border-t border-hairline/30 pt-3">
              <div>
                <div className="text-[13px] font-medium text-ink">Trace Sampling Rates</div>
                <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
                  Capture performance traces across AI reasoning, network calls, and user interactions to diagnose latency and bottlenecks.
                </div>
              </div>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                <div className="flex flex-col gap-1">
                  <label className="text-[12px] font-medium text-ink-secondary" htmlFor="observability-ai-traces">
                    AI Operations &amp; Tools
                  </label>
                  <input
                    id="observability-ai-traces"
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={aiTracesSampleRate}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setAiTracesSampleRate(Number.isFinite(next) ? next : 0);
                      setSaveOk(false);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && void save()}
                    className={observabilityInputClass}
                  />
                  <span className="text-[11px] text-ink-secondary">
                    Chat turns, bot handoffs, and tool runs.
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[12px] font-medium text-ink-secondary" htmlFor="observability-http-traces">
                    Server HTTP Requests
                  </label>
                  <input
                    id="observability-http-traces"
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={httpTracesSampleRate}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      const rate = Number.isFinite(next) ? next : 0;
                      setHttpTracesSampleRate(rate);
                      setSaveOk(false);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && void save()}
                    className={observabilityInputClass}
                  />
                  <span className="text-[11px] text-ink-secondary">
                    API calls, status checks, and background polls.
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[12px] font-medium text-ink-secondary" htmlFor="observability-ui-traces">
                    Desktop &amp; Web UI
                  </label>
                  <input
                    id="observability-ui-traces"
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={uiTracesSampleRate}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setUiTracesSampleRate(Number.isFinite(next) ? next : 0);
                      setSaveOk(false);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && void save()}
                    className={observabilityInputClass}
                  />
                  <span className="text-[11px] text-ink-secondary">
                    Page views and screen loads.
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-4 border-t border-hairline/30 pt-3">
              <div className="min-w-0">
                <div className="text-[13px] text-ink">Send diagnostics</div>
                <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
                  The kill switch.  Turning this off stops reporting straight away.
                </div>
              </div>
              <button
                role="switch"
                aria-checked={enabled}
                aria-label="Send diagnostics"
                onClick={() => {
                  setEnabled((v) => !v);
                  setSaveOk(false);
                }}
                className={cnSwitch(enabled)}
              >
                <span className={cnKnob(enabled)} />
              </button>
            </div>

            <div className="flex items-center justify-between gap-4 border-t border-hairline/30 pt-3">
              <div className="min-w-0">
                <div className="text-[13px] text-ink">Forward warnings and errors</div>
                <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
                  Send console warn and error lines to Sentry as Logs.
                </div>
              </div>
              <button
                role="switch"
                aria-checked={logsEnabled}
                aria-label="Forward warnings and errors"
                onClick={() => {
                  setLogsEnabled((v) => !v);
                  setSaveOk(false);
                }}
                className={cnSwitch(logsEnabled)}
              >
                <span className={cnKnob(logsEnabled)} />
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="flex items-center justify-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                Save
              </button>
              <button
                type="button"
                onClick={() => void sendTest()}
                disabled={saving || testing || !(dsn.trim() || hasDsn)}
                className="flex items-center gap-1.5 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] font-medium text-ink hover:bg-control disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw size={13} className={cn(testing && "animate-spin")} />
                {testing ? "Sending..." : "Send Test Event"}
              </button>
              {hasDsn && !dsnLocked && (
                <button
                  type="button"
                  onClick={() => void removeDsn()}
                  disabled={removing}
                  className={cn(
                    "text-[12px] underline decoration-dotted underline-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
                    confirmingRemove ? "text-danger" : "text-ink-secondary hover:text-ink",
                  )}
                >
                  {removing ? "Removing..." : confirmingRemove ? "Click again to remove" : "Remove Diagnostics Key"}
                </button>
              )}
              {saveOk && !saveError && (
                <span className="flex items-center gap-1 text-[12.5px] text-success">
                  <CheckCircle size={14} />
                  Saved
                </span>
              )}
              {testResult && (
                <span className={cn("flex items-center gap-1.5 text-[12.5px]", testResult.ok ? "text-success" : "text-danger")}>
                  {testResult.ok ? <CheckCircle size={14} /> : <XCircle size={14} />}
                  <span
                    className="max-w-[320px] truncate"
                    title={
                      testResult.ok
                        ? `Sentry accepted the test event${testResult.eventId ? ` (${testResult.eventId})` : ""}`
                        : testResult.error || "Not reachable"
                    }
                  >
                    {testResult.ok
                      ? `Sentry accepted the test event${testResult.eventId ? ` (${testResult.eventId})` : ""}`
                      : testResult.error || "Not reachable"}
                  </span>
                </span>
              )}
            </div>
            {saveError && (
              <div role="alert" className="text-[12px] text-danger" title={saveError}>
                {productErrorHeadline(saveError)}
              </div>
            )}
            <div className="text-[12px] leading-relaxed text-ink-secondary">
              Save stores the DSN on this computer and takes effect immediately.{'\u00A0'} Send Test Event captures one real event so you can confirm it arrives in your Sentry project.{'\u00A0'} Leave the DSN field blank to keep the stored value.{'\u00A0'} Prompts, transcripts, and tool arguments are never sent.{'\u00A0'} Turning diagnostics off stops reporting straight away.
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
