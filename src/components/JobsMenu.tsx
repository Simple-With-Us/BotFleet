// The chat header's background-jobs pill, its dropdown, and the thread's
// "Job Finished" rows (jobs P1, docs/plans/2026-10-01-background-jobs-and-
// subagents-decision.md).
//
// The pill sits left of Stop and is hidden when the thread has no job worth
// showing.  Its dot pulses while anything runs (motion-safe only, so reduced
// motion gets a still dot) and turns red for a while after a failure.  The
// dropdown lists running jobs first, then finished ones newest first; each
// row has its command, an exit chip, a ticking duration, View Output and
// Stop.  View Output opens a sheet over the list: output is never on a
// frame, so it is fetched here, on demand, from `/api/jobs/:id/output`.
//
// Stop here is the owner's: the job gets SIGTERM, then SIGKILL after 5 s, and
// the bot is told on its next turn without being woken.  The chat's own Stop
// button ends the turn, never a job.
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, RefreshCw, Square } from "lucide-react";

import { cn } from "@/lib/cn";
import { COMPACT_BUBBLE } from "@/lib/compact-chip";
import { api, useStore } from "@/state/store";
import {
  formatJobDuration,
  isJobActive,
  jobElapsedMs,
  jobExitChip,
  jobFailedRecently,
  sortJobsForDisplay,
  type JobRowData,
  type JobSnapshot,
} from "../../shared/jobs";

/** Two spaces' worth between sentences, kept by the renderer. */
const GAP = "  ";

/** The dropdown's footer: on a Mac the live harness is usually the app's
 *  own child process, so quitting the app ends its jobs (v1 restart rule). */
export const JOBS_FOOTER = `Jobs run on this computer.${GAP}Quitting the BotFleet app ends any job still running.`;

/** A finished job stays in the header this long; the thread's row keeps it. */
export const JOB_RECENT_MS = 30 * 60_000;

/** The jobs the pill counts and the dropdown lists: every running one, and
 *  those that ended within the last half hour. */
export function visibleJobs(jobs: readonly JobSnapshot[], now: number): JobSnapshot[] {
  return sortJobsForDisplay(jobs.filter((job) => isJobActive(job) || (job.endedAt !== null && now - job.endedAt <= JOB_RECENT_MS)));
}

/** "2 Jobs" — running ones when any run, else the recent finished ones. */
export function jobsPillLabel(jobs: readonly JobSnapshot[]): string {
  const running = jobs.filter(isJobActive).length;
  const count = running > 0 ? running : jobs.length;
  return `${count} ${count === 1 ? "Job" : "Jobs"}`;
}

export type JobsPillTone = "running" | "failed" | "idle";

export function jobsPillTone(jobs: readonly JobSnapshot[], now: number): JobsPillTone {
  if (jobs.some((job) => jobFailedRecently(job, now))) return "failed";
  if (jobs.some(isJobActive)) return "running";
  return "idle";
}

function statusDotClass(job: Pick<JobSnapshot, "status" | "killedBy">): string {
  if (isJobActive(job)) return "bg-accent motion-safe:animate-pulse";
  if (job.status === "completed") return "bg-success";
  if (job.status === "killed" && job.killedBy !== "timeout") return "bg-ink-secondary/60";
  return "bg-danger";
}

/** A clock that ticks once a second while `live`, for running durations. */
function useNow(live: boolean, fixed?: number): number {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined || !live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live, fixed]);
  return fixed ?? now;
}

export function JobsMenu({ threadId }: { threadId: string }) {
  const { state } = useStore();
  return <JobsMenuView threadId={threadId} jobs={state.jobsByThread[threadId] ?? []} />;
}

interface OutputState {
  jobId: string;
  text: string;
  loading: boolean;
  error?: string;
}

export interface JobsMenuViewProps {
  threadId: string;
  jobs: readonly JobSnapshot[];
  /** Tests: a fixed clock, a dropdown already open, an output sheet shown. */
  now?: number;
  defaultOpen?: boolean;
  initialOutput?: OutputState;
}

export function JobsMenuView({ threadId, jobs, now: fixedNow, defaultOpen = false, initialOutput }: JobsMenuViewProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [output, setOutput] = useState<OutputState | null>(initialOutput ?? null);
  const [stopping, setStopping] = useState<Set<string>>(() => new Set());
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow(open || jobs.some(isJobActive), fixedNow);
  const shown = visibleJobs(jobs, now);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      // SAFETY: a mousedown's target is always a DOM node.
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const loadOutput = useCallback(async (jobId: string) => {
    setOutput({ jobId, text: "", loading: true });
    try {
      const body = await api(`/api/jobs/${encodeURIComponent(jobId)}/output`);
      setOutput({ jobId, text: String(body?.output?.text ?? ""), loading: false });
    } catch (error) {
      setOutput({ jobId, text: "", loading: false, error: error instanceof Error ? error.message : "Could not read the output." });
    }
  }, []);

  const stop = useCallback(async (jobId: string) => {
    setStopping((current) => new Set(current).add(jobId));
    try {
      await api(`/api/jobs/${encodeURIComponent(jobId)}/stop`, { method: "POST" });
    } catch {
      /* the next frame says what really happened */
    }
  }, []);

  const stopAll = useCallback(async () => {
    setStopping(new Set(shown.filter(isJobActive).map((job) => job.id)));
    try {
      await api("/api/jobs/stop", { method: "POST", body: JSON.stringify({ threadId }) });
    } catch {
      /* the next frame says what really happened */
    }
  }, [shown, threadId]);

  if (shown.length === 0) return null;
  const tone = jobsPillTone(shown, now);
  const label = jobsPillLabel(shown);
  const anyRunning = shown.some(isJobActive);
  const viewed = output ? shown.find((job) => job.id === output.jobId) ?? jobs.find((job) => job.id === output.jobId) : undefined;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Background Jobs: ${label}`}
        title="Background Jobs"
        data-testid="jobs-pill"
        className={cn(
          "flex items-center gap-1.5 rounded-full border border-hairline/40 bg-raised/60 px-2.5 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink",
          open && "bg-raised text-ink",
          COMPACT_BUBBLE,
        )}
      >
        <span
          aria-hidden
          data-tone={tone}
          className={cn(
            "size-2 shrink-0 rounded-full",
            tone === "failed" ? "bg-danger" : tone === "running" ? "bg-accent motion-safe:animate-pulse" : "bg-ink-secondary/50",
          )}
        />
        <span className="@max-4xl/chathead:hidden">{label}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Background Jobs"
          data-testid="jobs-menu"
          className="absolute right-0 top-full z-40 mt-1 w-[22rem] max-w-[calc(100vw-1rem)] rounded-xl border border-hairline/50 bg-card p-1.5 text-ink shadow-2xl shadow-black/30"
        >
          {output && viewed ? (
            <div className="flex flex-col gap-1.5 p-1">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setOutput(null)}
                  className="flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"
                >
                  <ChevronLeft size={14} />
                  Back
                </button>
                <code className="min-w-0 flex-1 truncate font-mono text-[12px]" title={viewed.label}>
                  {viewed.label}
                </code>
                <button
                  type="button"
                  onClick={() => void loadOutput(viewed.id)}
                  aria-label="Refresh Output"
                  title="Refresh Output"
                  className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
                >
                  <RefreshCw size={13} />
                </button>
              </div>
              <pre
                data-testid="job-output"
                className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset p-2 font-mono text-[11.5px] leading-snug text-ink"
              >
                {output.loading ? "Loading…" : output.error ? output.error : output.text || "No output yet."}
              </pre>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2 px-2 pb-1 pt-0.5">
                <h3 className="text-[12.5px] font-semibold text-ink">Background Jobs</h3>
                {anyRunning && (
                  <button
                    type="button"
                    onClick={() => void stopAll()}
                    className="rounded-md px-2 py-0.5 text-[12px] text-danger hover:bg-danger/10"
                  >
                    Stop All
                  </button>
                )}
              </div>
              <ul className="flex max-h-80 flex-col overflow-auto">
                {shown.map((job) => (
                  <li key={job.id} data-job-id={job.id} className="flex flex-col gap-1 rounded-lg px-2 py-1.5 hover:bg-raised/50">
                    <div className="flex min-w-0 items-center gap-2">
                      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", statusDotClass(job))} />
                      <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink" title={job.label}>
                        {job.label}
                      </code>
                    </div>
                    <div className="flex items-center gap-2 pl-4 text-[11.5px] text-ink-secondary">
                      <span
                        className={cn(
                          "rounded-full px-1.5 py-px",
                          job.status === "completed" ? "bg-success/12 text-success" : job.status === "failed" || job.status === "lost" ? "bg-danger/10 text-danger" : "bg-raised",
                        )}
                      >
                        {stopping.has(job.id) && isJobActive(job) ? "Stopping" : jobExitChip(job)}
                      </span>
                      <span className="tabular-nums">{formatJobDuration(jobElapsedMs(job, now))}</span>
                      <span className="flex-1" />
                      <button
                        type="button"
                        onClick={() => void loadOutput(job.id)}
                        className="rounded-md px-1.5 py-0.5 hover:bg-raised hover:text-ink"
                      >
                        View Output
                      </button>
                      {isJobActive(job) && (
                        <button
                          type="button"
                          onClick={() => void stop(job.id)}
                          disabled={stopping.has(job.id) || job.status === "stopping"}
                          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-danger hover:bg-danger/10 disabled:opacity-50"
                        >
                          <Square size={10} className="fill-current" />
                          Stop
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="mt-1 border-t border-hairline/40 px-2 pb-0.5 pt-1.5 text-[11px] leading-snug text-ink-secondary">{JOBS_FOOTER}</p>
        </div>
      )}
    </div>
  );
}

/** The thread's notice that a job ended.  Always shown, whatever the tool
 *  call setting: it is news, not a step. */
export function JobFinishedRow({ job }: { job: JobRowData }) {
  const dot = statusDotClass(job);
  const took = formatJobDuration(jobElapsedMs(job, job.endedAt ?? job.startedAt));
  return (
    <div data-testid="job-finished-row" data-job-id={job.id} className="flex min-w-0 items-center gap-2 py-1 text-[12.5px] text-ink-secondary">
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", dot)} />
      <span className="shrink-0 font-medium text-ink">Job Finished</span>
      <code className="min-w-0 truncate font-mono text-[12px]" title={job.label}>
        {job.label}
      </code>
      <span className="shrink-0">{jobExitChip(job)}</span>
      <span className="shrink-0 tabular-nums">{took}</span>
    </div>
  );
}
