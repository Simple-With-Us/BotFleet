// App settings → Resources: host readings from GET /api/host/resources
// with the saved admission thresholds against the applied values, plus
// write-through editing of the three unset-by-default headroom knobs via
// PUT /api/config (server/knob-map.ts).
import * as React from "react";
import { Check, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/cn";
import { Card } from "./SettingsPrimitives";
import {
  admissionRows,
  fetchHostResources,
  formatBytes,
  headroomEditInitial,
  parseHeadroomEdit,
  saveHeadroomThresholds,
  hostNoun,
  hostSubtitle,
  nextRefreshState,
  resourceRows,
  type HeadroomEditValues,
  type HostResourcesState,
} from "@/lib/host-resources";
import type { HostResourcesReport } from "../../shared/placement.ts";

const inputClass =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:cursor-not-allowed disabled:opacity-60";

function RefreshButton({ onRefresh, spinning }: { onRefresh: () => void; spinning: boolean }) {
  return (
    <button
      type="button"
      onClick={onRefresh}
      aria-label="Refresh host resources"
      className="flex items-center gap-1.5 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] font-medium text-ink hover:bg-control disabled:cursor-not-allowed disabled:opacity-50"
    >
      <RefreshCw size={13} className={cn(spinning && "animate-spin")} />
      {spinning ? "Refreshing…" : "Refresh"}
    </button>
  );
}

/** The pure report view: every state the tab can show, driven by props so
 *  tests render loading, error and mismatch output without a harness. */
export function ResourcesSectionView({
  state,
  onRefresh,
  highlightClass,
}: {
  state: HostResourcesState;
  onRefresh: () => void;
  highlightClass?: (domId: string) => string | undefined;
}) {
  if (state.status === "loading") {
    return (
      <div className="flex flex-col gap-4">
        <Card title="Host Resource Readings" subtitle="Detected capacity, current use and admission thresholds for this host.">
          <div className="flex items-center gap-2 text-[13px] text-ink-secondary" role="status">
            <Loader2 size={14} className="animate-spin" />
            Loading host resources…
          </div>
        </Card>
      </div>
    );
  }

  if (state.status === "refreshing") {
    return <ResourcesReportView report={state.report} onRefresh={onRefresh} refreshing highlightClass={highlightClass} />;
  }

  if (state.status === "error") {
    return (
      <div className="flex flex-col gap-4">
        <Card
          title="Host Resource Readings"
          subtitle="Detected capacity, current use and admission thresholds for this host."
          actions={<RefreshButton onRefresh={onRefresh} spinning={false} />}
        >
          <div role="alert" className="text-[13px] text-danger">
            Couldn’t load host resources.  {state.message}
          </div>
        </Card>
      </div>
    );
  }

  return <ResourcesReportView report={state.report} onRefresh={onRefresh} highlightClass={highlightClass} />;
}

function ResourcesReportView({
  report,
  onRefresh,
  refreshing,
  highlightClass,
}: {
  report: HostResourcesReport;
  onRefresh: () => void;
  refreshing?: boolean;
  highlightClass?: (domId: string) => string | undefined;
}) {
  const noun = hostNoun(report);
  const rows = resourceRows(report);
  const thresholds = admissionRows(report);
  const mismatches = thresholds.filter((row) => row.mismatch !== null);

  return (
    <div className="flex flex-col gap-4">
      <Card
        id="setting-resources-host"
        className={highlightClass?.("setting-resources-host")}
        title="Host Resource Readings"
        subtitle={`${noun === "this Mac" ? "This Mac" : "Server"} · ${report.hostId} · ${hostSubtitle(report)}`}
        actions={<RefreshButton onRefresh={onRefresh} spinning={refreshing ?? false} />}
      >
        <div className="flex flex-col gap-2 text-[13px]" role="table" aria-label="Host resource readings">
          <div className="grid grid-cols-[110px_1fr_1fr_1fr] gap-2 text-[11.5px] uppercase tracking-wide text-ink-secondary" role="row">
            <span>Resource</span>
            <span>Detected</span>
            <span>Current use</span>
            <span>Enforcement</span>
          </div>
          {rows.map((row) => (
            <div key={row.key}>
              <div className="grid grid-cols-[110px_1fr_1fr_1fr] gap-2 rounded-lg border border-hairline/20 bg-inset/20 p-2">
                <span className="font-medium text-ink">{row.label}</span>
                <span className="text-ink">{row.detected}</span>
                <span className="text-ink">{row.use}</span>
                <span className="text-ink-secondary">{row.enforcement}</span>
              </div>
              {row.alert && (
                <div role="alert" className="mt-1.5 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
                  {row.alert}
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card
        id="setting-resources-thresholds"
        className={highlightClass?.("setting-resources-thresholds")}
        title="Admission Thresholds (Saved vs Applied)"
        subtitle="Saved values from the owner’s config against what the runtime actually applies.  Jobs settings apply live, so the two agree unless a row below says otherwise."
      >
        <div className="flex flex-col gap-2 text-[13px]" role="table" aria-label="Saved versus applied admission thresholds">
          <div className="grid grid-cols-[150px_1fr_1fr] gap-2 text-[11.5px] uppercase tracking-wide text-ink-secondary" role="row">
            <span>Threshold</span>
            <span>Saved</span>
            <span>Applied</span>
          </div>
          {thresholds.map((row) => (
            <div key={row.key} className="rounded-lg border border-hairline/20 bg-inset/20 p-2">
              <div className="grid grid-cols-[150px_1fr_1fr] gap-2">
                <span className="font-medium text-ink">
                  {row.label}
                </span>
                <span className="text-ink">{row.saved}</span>
                <span className={cn(row.mismatch ? "font-medium text-warning" : "text-ink")}>{row.applied}</span>
              </div>
              {row.note && <div className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">{row.note}</div>}
              {row.mismatch && (
                <div role="status" className="mt-1 text-[12px] leading-relaxed text-warning">
                  Saved {row.saved} · {row.mismatch}
                </div>
              )}
            </div>
          ))}
        </div>
        {mismatches.length === 0 && (
          <div className="mt-2 text-[12px] leading-relaxed text-ink-secondary">
            Saved and applied agree on every threshold.
          </div>
        )}
        <div className="mt-2 text-[12px] leading-relaxed text-ink-secondary">
          A saved number the runtime has not applied keeps the previous applied value in force — a saved value is never shown as applied.
        </div>
        <details className="mt-2 text-[12px] text-ink-secondary">
          <summary className="cursor-pointer select-none font-medium text-ink-secondary">
            Environment variable names
          </summary>
          <ul className="mt-1.5 flex flex-col gap-1 pl-4 text-[11.5px]">
            {thresholds.map((row) => (
              <li key={row.key}>
                <span className="font-medium text-ink">{row.label}:</span>{" "}
                <span className="font-mono">{row.knob}</span> · <span className="font-mono">{row.source}</span>
              </li>
            ))}
          </ul>
        </details>
      </Card>

      <HeadroomCard report={report} highlightClass={highlightClass} onSaved={onRefresh} />

      {report.limitations.length > 0 && (
        <Card
          id="setting-resources-gaps"
          className={highlightClass?.("setting-resources-gaps")}
          title="Known Gaps"
          subtitle="What this report cannot see, in its own words."
        >
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[12.5px] leading-relaxed text-ink-secondary">
            {report.limitations.map((limitation, index) => (
              <li key={index}>{limitation}</li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** The three unset-by-default headroom knobs, editable with write-through.
 *  Empty means omit (no change); the PUT patch only carries fields with a
 *  number, so an untouched box never clears a saved knob.  Clearing back to
 *  unset is a file/vault edit. */
function HeadroomCard({
  report,
  highlightClass,
  onSaved,
}: {
  report: HostResourcesReport;
  highlightClass?: (domId: string) => string | undefined;
  onSaved?: () => void;
}) {
  const [values, setValues] = React.useState<HeadroomEditValues>(() => headroomEditInitial(report));
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [touched, setTouched] = React.useState(false);
  const [submitAttempted, setSubmitAttempted] = React.useState(false);

  React.useEffect(() => {
    setValues(headroomEditInitial(report));
    setTouched(false);
    setSubmitAttempted(false);
    setError(null);
  }, [report.hostId, report.admission.reservedCpuCores, report.admission.reservedRamBytes, report.admission.minMemoryAvailablePercent]);

  const parsed = parseHeadroomEdit(values);
  const showValidation = !parsed.ok && (touched || submitAttempted);
  const canSave = !saving && parsed.ok;

  const markTouched = (next: HeadroomEditValues) => {
    setValues(next);
    setTouched(true);
  };

  const save = () => {
    setSubmitAttempted(true);
    if (!parsed.ok || saving) {
      setError(!parsed.ok ? parsed.errors[0]?.message ?? "Enter a number." : null);
      return;
    }
    setSaving(true);
    setError(null);
    void (async () => {
      try {
        await saveHeadroomThresholds(values, report);
        onSaved?.();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setSaving(false);
      }
    })();
  };

  return (
    <Card
      id="setting-resources-headroom"
      className={highlightClass?.("setting-resources-headroom")}
      title="Owner-Set Headroom"
      subtitle="Reserved capacity for everything else on this host.  Absent means unset: no gate, exactly as before."
    >
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <label className="text-[12px] font-medium text-ink-secondary" htmlFor="resources-reserved-cpu">
            Reserved CPU cores
          </label>
          <input
            id="resources-reserved-cpu"
            type="number"
            value={values.reservedCpuCores}
            min={0}
            max={64}
            step={1}
            placeholder="Not set"
            onChange={(e) => markTouched({ ...values, reservedCpuCores: e.target.value })}
            aria-label="Reserved CPU cores"
            className={inputClass}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[12px] font-medium text-ink-secondary" htmlFor="resources-reserved-ram">
            Reserved RAM (MB)
          </label>
          <input
            id="resources-reserved-ram"
            type="number"
            value={values.reservedRamMb}
            min={0}
            step={1}
            placeholder="Not set"
            onChange={(e) => markTouched({ ...values, reservedRamMb: e.target.value })}
            aria-label="Reserved RAM in MB"
            className={inputClass}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[12px] font-medium text-ink-secondary" htmlFor="resources-min-memory-percent">
            Minimum available memory (%)
          </label>
          <input
            id="resources-min-memory-percent"
            type="number"
            value={values.minMemoryAvailablePercent}
            min={0}
            max={100}
            step={0.5}
            placeholder="Not set"
            onChange={(e) => markTouched({ ...values, minMemoryAvailablePercent: e.target.value })}
            aria-label="Minimum available memory percent"
            className={inputClass}
          />
        </div>
      </div>
      {showValidation && (
        <div role="alert" className="mt-2 text-[12px] leading-relaxed text-danger">
          {parsed.errors[0]?.message}
        </div>
      )}
      {error && (
        <div role="alert" className="mt-2 text-[12px] leading-relaxed text-danger">
          Couldn’t save headroom.  {error}
        </div>
      )}
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className="flex items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] font-medium text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
          {saving ? "Saving…" : "Save headroom"}
        </button>
        <span className="text-[12px] text-ink-secondary">Saves via PUT /api/config, then reloads the report.</span>
      </div>
      <div className="mt-2 text-[12px] leading-relaxed text-ink-secondary">
        Empty keeps the current value — the save sends the full admission object so unrelated gates are never erased.  Clearing back to unset is a file/vault edit. 
        {report.admission.reservedRamBytes !== undefined && (
          <>Reserved RAM in force: {formatBytes(report.admission.reservedRamBytes)}. </>
        )}
        {report.platform === "darwin" &&
          "On this Mac reserved CPU never refuses a job; it sizes the per-job CPU-time budget instead."}
      </div>
      <details className="mt-2 text-[12px] text-ink-secondary">
        <summary className="cursor-pointer select-none font-medium text-ink-secondary">
          Environment variable names
        </summary>
        <ul className="mt-1.5 flex flex-col gap-1 pl-4 font-mono text-[11px]">
          <li>BOTFLEET_JOBS_RESERVED_CPU_CORES</li>
          <li>BOTFLEET_JOBS_RESERVED_RAM_MB</li>
          <li>BOTFLEET_JOBS_MIN_MEMORY_AVAILABLE_PERCENT</li>
        </ul>
      </details>
    </Card>
  );
}

export function ResourcesSection({ highlightClass }: { highlightClass?: (domId: string) => string | undefined }) {
  const [state, setState] = React.useState<HostResourcesState>({ status: "loading" });
  // A second click while a fetch is in flight is ignored: overlapping
  // fetches race last-write-wins and can plant a stale report.
  const inflightRef = React.useRef(false);

  const refresh = React.useCallback(() => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    setState((prev) => nextRefreshState(prev));
    void (async () => {
      try {
        setState({ status: "ready", report: await fetchHostResources() });
      } catch (caught) {
        setState({ status: "error", message: caught instanceof Error ? caught.message : String(caught) });
      } finally {
        inflightRef.current = false;
      }
    })();
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  return <ResourcesSectionView state={state} onRefresh={() => void refresh()} highlightClass={highlightClass} />;
}
