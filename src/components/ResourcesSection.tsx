// App settings → Resources: host readings from GET /api/host/resources
// with the saved admission thresholds against the applied values.
//
// Display side only (P-BF-6 B7 UI half).  Read-write editing of the three
// unset-by-default knobs is out of scope — numbers are owner-gated, so the
// headroom card renders disabled inputs with an "owner sets these" note and
// this file never builds a PUT/PATCH body.
import * as React from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/cn";
import { Card } from "./SettingsPrimitives";
import {
  admissionRows,
  fetchHostResources,
  formatBytes,
  hostNoun,
  hostSubtitle,
  resourceRows,
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
        <Card title="Host resources" subtitle="Detected capacity, current use and admission thresholds for this host.">
          <div className="flex items-center gap-2 text-[13px] text-ink-secondary" role="status">
            <Loader2 size={14} className="animate-spin" />
            Loading host resources…
          </div>
        </Card>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex flex-col gap-4">
        <Card
          title="Host resources"
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
  highlightClass,
}: {
  report: HostResourcesReport;
  onRefresh: () => void;
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
        title={noun === "this Mac" ? "This Mac’s resources" : "Server resources"}
        subtitle={`${report.hostId} · ${hostSubtitle(report)}`}
        actions={<RefreshButton onRefresh={onRefresh} spinning={false} />}
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
        title="Admission thresholds"
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
                <span className="font-medium text-ink" title={`${row.knob} · ${row.source}`}>
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
      </Card>

      <HeadroomCard report={report} highlightClass={highlightClass} />

      {report.limitations.length > 0 && (
        <Card
          id="setting-resources-gaps"
          className={highlightClass?.("setting-resources-gaps")}
          title="Known gaps"
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

/** The three unset-by-default headroom knobs, shown read-only.  The inputs
 *  mirror the numeric-knob tab pattern but stay disabled: choosing numbers
 *  is the owner's call, so this tab names the values and where they come
 *  from (config knob + Infisical name) without letting anyone type here. */
function HeadroomCard({
  report,
  highlightClass,
}: {
  report: HostResourcesReport;
  highlightClass?: (domId: string) => string | undefined;
}) {
  const reservedRamMb =
    report.admission.reservedRamBytes === undefined
      ? ""
      : String(Math.round(report.admission.reservedRamBytes / 1024 / 1024));
  return (
    <Card
      id="setting-resources-headroom"
      className={highlightClass?.("setting-resources-headroom")}
      title="Owner-set headroom"
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
            value={report.admission.reservedCpuCores ?? ""}
            placeholder="Not set"
            disabled
            aria-label="Reserved CPU cores (set by the owner)"
            title="Set by the owner — editing is disabled on this tab"
            className={inputClass}
          />
          <span className="font-mono text-[11px] text-ink-secondary">BOTFLEET_JOBS_RESERVED_CPU_CORES</span>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[12px] font-medium text-ink-secondary" htmlFor="resources-reserved-ram">
            Reserved RAM (MB)
          </label>
          <input
            id="resources-reserved-ram"
            type="number"
            value={reservedRamMb}
            placeholder="Not set"
            disabled
            aria-label="Reserved RAM in MB (set by the owner)"
            title="Set by the owner — editing is disabled on this tab"
            className={inputClass}
          />
          <span className="font-mono text-[11px] text-ink-secondary">BOTFLEET_JOBS_RESERVED_RAM_MB</span>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[12px] font-medium text-ink-secondary" htmlFor="resources-min-memory-percent">
            Minimum available memory (%)
          </label>
          <input
            id="resources-min-memory-percent"
            type="number"
            value={report.admission.minMemoryAvailablePercent ?? ""}
            placeholder="Not set"
            disabled
            aria-label="Minimum available memory percent (set by the owner)"
            title="Set by the owner — editing is disabled on this tab"
            className={inputClass}
          />
          <span className="font-mono text-[11px] text-ink-secondary">BOTFLEET_JOBS_MIN_MEMORY_AVAILABLE_PERCENT</span>
        </div>
      </div>
      <div className="mt-2 text-[12px] leading-relaxed text-ink-secondary">
        The owner sets these numbers — this tab shows them read-only and editing is disabled here. 
        {report.admission.reservedRamBytes !== undefined && (
          <>Reserved RAM in force: {formatBytes(report.admission.reservedRamBytes)}. </>
        )}
        {report.platform === "darwin" &&
          "On this Mac reserved CPU never refuses a job; it sizes the per-job CPU-time budget instead."}
      </div>
    </Card>
  );
}

export function ResourcesSection({ highlightClass }: { highlightClass?: (domId: string) => string | undefined }) {
  const [state, setState] = React.useState<HostResourcesState>({ status: "loading" });

  const refresh = React.useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", report: await fetchHostResources() });
    } catch (caught) {
      setState({ status: "error", message: caught instanceof Error ? caught.message : String(caught) });
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  return <ResourcesSectionView state={state} onRefresh={() => void refresh()} highlightClass={highlightClass} />;
}
