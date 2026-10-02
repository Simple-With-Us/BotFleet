// The chat header's background-jobs pill, its dropdown, and the thread's
// "Job Finished" rows (jobs P1, docs/plans/2026-10-01-background-jobs-and-
// subagents-decision.md).
//
// The pill sits left of Stop and is hidden when the thread has no job worth
// showing.  Its dot pulses while anything runs (motion-safe only, so reduced
// motion gets a still dot) and turns red for a while after a failure; the
// pill's own name says the same in words.  When the header is narrow the
// pill folds to a terminal glyph with the dot and the count as badges.  The
// dropdown lists running jobs first, then finished ones newest first; each
// row has its command, an exit chip, a ticking duration, why it ended when
// that is not obvious, View Output and Stop.  View Output opens a sheet over
// the list: output is never on a frame, so it is fetched here, on demand,
// from `/api/jobs/:id/output`.
//
// Stop here is the owner's: the job gets SIGTERM, then SIGKILL after 5 s, and
// the bot is told on its next turn without being woken.  The chat's own Stop
// button ends the turn, never a job.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, RefreshCw, Square, SquareTerminal } from "lucide-react";

import { cn } from "@/lib/cn";
import { COMPACT_BUBBLE } from "@/lib/compact-chip";
import { api, useStore } from "@/state/store";
import { POPOVER_VIEWPORT_MARGIN } from "./ui/Popover";
import {
  formatJobDuration,
  isJobActive,
  jobElapsedMs,
  jobEndedBadly,
  jobExitChip,
  jobFailedRecently,
  sortJobsForDisplay,
  type JobRowData,
  type JobSnapshot,
} from "../../shared/jobs";

/** A sentence gap HTML keeps: a no-break space, then a space. */
const GAP = "  ";

/** The dropdown's footer.  True wherever this page runs: a job ends when
 *  the harness that started it stops or restarts (v1 restart rule) — which
 *  quitting the Mac app does only when the app started that harness, so the
 *  footer names the server, not the app. */
export const JOBS_FOOTER = `Jobs run on this computer.${GAP}They end when BotFleet's server stops or restarts, as it does for an update.`;

/** A finished job stays in the header this long; the thread's row keeps it. */
export const JOB_RECENT_MS = 30 * 60_000;

/** The pill's dot stays red this long after a failure (jobFailedRecently). */
export const JOB_FAILED_RED_MS = 5 * 60_000;

/** The most a browser timer may wait. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The jobs the pill counts and the dropdown lists: every running one, and
 *  those that ended within the last half hour. */
export function visibleJobs(jobs: readonly JobSnapshot[], now: number): JobSnapshot[] {
  return sortJobsForDisplay(jobs.filter((job) => isJobActive(job) || (job.endedAt !== null && now - job.endedAt <= JOB_RECENT_MS)));
}

/** What the pill counts: running jobs when any run, else the recent
 *  finished ones. */
export function jobsPillCount(jobs: readonly JobSnapshot[]): number {
  const running = jobs.filter(isJobActive).length;
  return running > 0 ? running : jobs.length;
}

/** "2 Jobs". */
export function jobsPillLabel(jobs: readonly JobSnapshot[]): string {
  const count = jobsPillCount(jobs);
  return `${count} ${count === 1 ? "Job" : "Jobs"}`;
}

/** What the pill's dot says, in words, for its accessible name and title:
 *  "2 running, 1 failed". */
export function jobsPillDescription(jobs: readonly JobSnapshot[], now: number): string {
  const running = jobs.filter(isJobActive).length;
  const failed = jobs.filter((job) => jobFailedRecently(job, now, JOB_FAILED_RED_MS)).length;
  const finished = jobs.length - running - failed;
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (finished > 0) parts.push(`${finished} finished`);
  return parts.join(", ");
}

export type JobsPillTone = "running" | "failed" | "idle";

export function jobsPillTone(jobs: readonly JobSnapshot[], now: number): JobsPillTone {
  if (jobs.some((job) => jobFailedRecently(job, now, JOB_FAILED_RED_MS))) return "failed";
  if (jobs.some(isJobActive)) return "running";
  return "idle";
}

/** The next moment the pill changes with no job running and no frame
 *  arriving: a finished job's red dot fades, or it leaves the header.  Null
 *  when nothing is ahead. */
export function nextJobsBoundary(jobs: readonly JobSnapshot[], now: number): number | null {
  let next: number | null = null;
  for (const job of jobs) {
    if (job.endedAt === null || isJobActive(job)) continue;
    for (const at of [job.endedAt + JOB_FAILED_RED_MS, job.endedAt + JOB_RECENT_MS]) {
      // the windows are inclusive: the change shows one millisecond after
      if (at + 1 > now && (next === null || at + 1 < next)) next = at + 1;
    }
  }
  return next;
}

/** How far right of flush-right the panel moves so its left edge stays in
 *  the viewport: the pill sits mid-header, so in a narrow chat column a
 *  panel anchored to its right edge can hang off the left.  Never past the
 *  viewport's right edge either.  0 when it fits as it is. */
export function jobsMenuOffset(anchorRight: number, panelWidth: number, viewportWidth: number, margin = POPOVER_VIEWPORT_MARGIN): number {
  const left = anchorRight - panelWidth;
  if (left >= margin) return 0;
  const room = viewportWidth - margin - anchorRight;
  return Math.max(0, Math.min(margin - left, room));
}

/** "It ran past its 60-minute limit": a job's reason as a line of its own. */
function reasonLine(reason: string): string {
  return reason.charAt(0).toUpperCase() + reason.slice(1);
}

/** Why a finished job's chip is worth a second line: the status alone does
 *  not say it (a system stop, a limit, a restart, a CPU cap). */
function shownReason(job: Pick<JobSnapshot, "status" | "reason" | "killedBy">): string | undefined {
  if (!job.reason || isJobActive(job) || job.status === "completed") return undefined;
  // "Killed by you" needs no explanation
  if (job.status === "killed" && (job.killedBy === "owner" || job.killedBy === "model")) return undefined;
  return reasonLine(job.reason);
}

function statusDotClass(job: Pick<JobSnapshot, "status" | "killedBy">): string {
  if (isJobActive(job)) return "bg-accent motion-safe:animate-pulse";
  if (job.status === "completed") return "bg-success";
  return jobEndedBadly(job) ? "bg-danger" : "bg-ink-secondary/60";
}

function toneClass(tone: JobsPillTone): string {
  return tone === "failed" ? "bg-danger" : tone === "running" ? "bg-accent motion-safe:animate-pulse" : "bg-ink-secondary/50";
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** A clock for the pill and the durations.  It ticks once a second while
 *  `live` (a job runs, or the menu is open).  Otherwise it does not tick,
 *  but it still moves at the next boundary — a red dot fading, a finished
 *  job leaving the header — and catches up when a frame arrives. */
function useNow(jobs: readonly JobSnapshot[], live: boolean, fixed?: number): number {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined) return;
    if (live) {
      setNow(Date.now());
      const timer = window.setInterval(() => setNow(Date.now()), 1000);
      return () => window.clearInterval(timer);
    }
    const current = Date.now();
    // stopped when the last job did: catch up once, then wait for the
    // next boundary
    const next = nextJobsBoundary(jobs, current);
    const wait = now < current - 1000 ? 0 : next === null ? null : next - current;
    if (wait === null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(Math.max(0, wait), MAX_TIMER_MS));
    return () => window.clearTimeout(timer);
  }, [jobs, live, fixed, now]);
  return fixed ?? now;
}

export function JobsMenu({ threadId, room = false }: { threadId: string; room?: boolean }) {
  const { state } = useStore();
  const botNames: Record<string, string> = {};
  if (room) for (const bot of state.bots) botNames[bot.id] = bot.name;
  return <JobsMenuView threadId={threadId} jobs={state.jobsByThread[threadId] ?? []} botNames={room ? botNames : undefined} />;
}

interface OutputState {
  jobId: string;
  text: string;
  loading: boolean;
  error?: string;
  /** The sheet shows the newest bytes only: earlier output exists. */
  truncated?: boolean;
}

export interface JobsMenuViewProps {
  threadId: string;
  jobs: readonly JobSnapshot[];
  /** In a room, each row names the member whose job it is. */
  botNames?: Record<string, string>;
  /** Tests: a fixed clock, a dropdown already open, an output sheet shown. */
  now?: number;
  defaultOpen?: boolean;
  initialOutput?: OutputState;
  initialStopError?: string;
}

/** How much of the log View Output shows: the route's default. */
const OUTPUT_LIMIT_LABEL = "64 KB";

export function JobsMenuView({ threadId, jobs, botNames, now: fixedNow, defaultOpen = false, initialOutput, initialStopError }: JobsMenuViewProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [output, setOutput] = useState<OutputState | null>(initialOutput ?? null);
  /** Stops asked for that no frame has confirmed yet. */
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  /** A job id (or "all") whose Stop request failed. */
  const [stopError, setStopError] = useState<string | null>(initialStopError ?? null);
  const ref = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  /** Where focus goes when the sheet closes: that row's View Output. */
  const returnTo = useRef<string | null>(null);
  /** Only the newest output request may fill the sheet. */
  const outputRequest = useRef(0);
  const [offset, setOffset] = useState(0);
  const now = useNow(jobs, open || jobs.some(isJobActive), fixedNow);
  const shown = visibleJobs(jobs, now);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setOutput(null);
    outputRequest.current += 1;
    if (refocus) pillRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      // SAFETY: a mousedown's target is always a DOM node.
      if (!ref.current?.contains(event.target as Node)) close(false);
    };
    const onKey = (event: KeyboardEvent) => {
      // back to the pill, unless focus was somewhere else entirely
      if (event.key === "Escape") close(ref.current?.contains(document.activeElement) ?? false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  // Keep the panel inside the viewport (the pill sits mid-header).
  useIsoLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = ref.current?.getBoundingClientRect();
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      setOffset(jobsMenuOffset(anchor.right, panel.offsetWidth, window.innerWidth));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  // Focus follows the sheet: onto Back when it opens, back to the row's
  // View Output when it closes — never dropped on the page.
  const viewing = output?.jobId ?? null;
  useEffect(() => {
    if (!open) return;
    if (viewing) {
      backRef.current?.focus();
      return;
    }
    const id = returnTo.current;
    returnTo.current = null;
    if (id) panelRef.current?.querySelector<HTMLButtonElement>(`[data-view-output="${id}"]`)?.focus();
  }, [open, viewing]);

  // A focused Stop disappears with the job it stopped: keep focus in the
  // menu rather than letting it fall to the page.
  useEffect(() => {
    if (open && document.activeElement === document.body) panelRef.current?.focus();
  });

  // A stop the frames have answered needs no local "Stopping" any more.
  useEffect(() => {
    setStopping((current) => {
      const live = [...current].filter((id) => jobs.some((job) => job.id === id && job.status === "running"));
      return live.length === current.size ? current : new Set(live);
    });
  }, [jobs]);

  const loadOutput = useCallback(async (jobId: string) => {
    const request = ++outputRequest.current;
    setOutput({ jobId, text: "", loading: true });
    try {
      const body: { output?: { text?: string; from?: number; dropped?: number } } | null = await api(`/api/jobs/${encodeURIComponent(jobId)}/output`);
      if (request !== outputRequest.current) return; // a newer request, or Back
      const from = Number(body?.output?.from ?? 0);
      const dropped = Number(body?.output?.dropped ?? 0);
      setOutput({ jobId, text: String(body?.output?.text ?? ""), loading: false, truncated: from > 0 || dropped > 0 });
    } catch (error) {
      if (request !== outputRequest.current) return;
      setOutput({ jobId, text: "", loading: false, error: error instanceof Error ? error.message : "Could not read the output." });
    }
  }, []);

  const back = useCallback(() => {
    returnTo.current = output?.jobId ?? null;
    outputRequest.current += 1;
    setOutput(null);
  }, [output]);

  const stop = useCallback(async (jobId: string) => {
    setStopError(null);
    setStopping((current) => new Set(current).add(jobId));
    try {
      await api(`/api/jobs/${encodeURIComponent(jobId)}/stop`, { method: "POST" });
    } catch {
      // Nothing was stopped and no frame will say otherwise: say so here,
      // and let the owner try again.
      setStopping((current) => {
        const next = new Set(current);
        next.delete(jobId);
        return next;
      });
      setStopError(jobId);
    }
  }, []);

  const stopAll = useCallback(async () => {
    const ids = shown.filter((job) => job.status === "running").map((job) => job.id);
    setStopError(null);
    setStopping((current) => new Set([...current, ...ids]));
    try {
      await api("/api/jobs/stop", { method: "POST", body: JSON.stringify({ threadId }) });
    } catch {
      setStopping((current) => new Set([...current].filter((id) => !ids.includes(id))));
      setStopError("all");
    }
  }, [shown, threadId]);

  if (shown.length === 0) return null;
  const tone = jobsPillTone(shown, now);
  const label = jobsPillLabel(shown);
  const description = jobsPillDescription(shown, now);
  const count = jobsPillCount(shown);
  const anyRunning = shown.some((job) => job.status === "running");
  const viewed = output ? (shown.find((job) => job.id === output.jobId) ?? jobs.find((job) => job.id === output.jobId)) : undefined;
  const isStopping = (job: JobSnapshot) => job.status === "stopping" || (job.status === "running" && stopping.has(job.id));

  return (
    <div className="relative" ref={ref}>
      <button
        ref={pillRef}
        type="button"
        onClick={() => (open ? close(false) : setOpen(true))}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Background Jobs: ${description}`}
        title={`Background Jobs: ${description}`}
        data-testid="jobs-pill"
        className={cn(
          "relative flex items-center gap-1.5 rounded-full border border-hairline/40 bg-raised/60 px-2.5 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink",
          open && "bg-raised text-ink",
          COMPACT_BUBBLE,
        )}
      >
        <span aria-hidden data-tone={tone} className={cn("size-2 shrink-0 rounded-full @max-4xl/chathead:hidden", toneClass(tone))} />
        <span className="@max-4xl/chathead:hidden">{label}</span>
        {/* Narrow header: a glyph, with the dot and the count as badges, so
            the folded pill still says what it is and how many. */}
        <span aria-hidden data-testid="jobs-pill-compact" className="relative hidden @max-4xl/chathead:block">
          <SquareTerminal size={15} />
          <span className={cn("absolute -right-1 -top-1 size-2 rounded-full", toneClass(tone))} />
          {count > 1 && (
            <span className="absolute -bottom-1.5 -right-2 rounded-full bg-raised px-1 text-[9px] font-semibold leading-3 tabular-nums text-ink">
              {count}
            </span>
          )}
        </span>
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Background Jobs"
          tabIndex={-1}
          data-testid="jobs-menu"
          style={offset ? { right: -offset } : undefined}
          className="absolute right-0 top-full z-40 mt-1 w-[22rem] max-w-[calc(100vw-1rem)] rounded-xl border border-hairline/50 bg-card p-1.5 text-ink shadow-2xl shadow-black/30 outline-none"
        >
          {output && viewed ? (
            <div className="flex flex-col gap-1.5 p-1">
              <div className="flex items-center gap-1.5">
                <button
                  ref={backRef}
                  type="button"
                  onClick={back}
                  className="flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"
                >
                  <ChevronLeft size={14} aria-hidden />
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
                  <RefreshCw size={13} aria-hidden />
                </button>
              </div>
              <div className="flex items-center gap-2 px-1 text-[11.5px] text-ink-secondary" data-testid="job-output-status">
                <span className={cn("size-2 shrink-0 rounded-full", statusDotClass(viewed))} aria-hidden />
                <span title={viewed.reason}>{isStopping(viewed) ? "Stopping" : jobExitChip(viewed)}</span>
                <span className="tabular-nums">{formatJobDuration(jobElapsedMs(viewed, now))}</span>
              </div>
              {output.truncated && !output.loading && !output.error && (
                <p className="px-1 text-[11px] text-ink-secondary">{`Showing the newest ${OUTPUT_LIMIT_LABEL}.${GAP}Earlier output is not shown.`}</p>
              )}
              <pre
                data-testid="job-output"
                tabIndex={0}
                aria-label={`Output of ${viewed.label}`}
                className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset p-2 font-mono text-[11.5px] leading-snug text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
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
              {stopError === "all" && (
                <p role="alert" className="px-2 pb-1 text-[11.5px] text-danger">{`Could not stop them.${GAP}Try again.`}</p>
              )}
              <ul className="flex max-h-80 flex-col overflow-auto">
                {shown.map((job) => {
                  const reason = shownReason(job);
                  const member = botNames?.[job.botId];
                  return (
                    <li key={job.id} data-job-id={job.id} className="flex flex-col gap-1 rounded-lg px-2 py-1.5 hover:bg-raised/50">
                      <div className="flex min-w-0 items-center gap-2">
                        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", statusDotClass(job))} />
                        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink" title={job.label}>
                          {job.label}
                        </code>
                      </div>
                      <div className="flex items-center gap-2 pl-4 text-[11.5px] text-ink-secondary">
                        <span
                          title={job.reason}
                          className={cn(
                            "rounded-full px-1.5 py-px",
                            job.status === "completed" ? "bg-success/12 text-success" : jobEndedBadly(job) ? "bg-danger/10 text-danger" : "bg-raised",
                          )}
                        >
                          {isStopping(job) ? "Stopping" : jobExitChip(job)}
                        </span>
                        <span className="tabular-nums">{formatJobDuration(jobElapsedMs(job, now))}</span>
                        {member && <span className="min-w-0 truncate" data-testid="job-member">{member}</span>}
                        <span className="flex-1" />
                        <button
                          type="button"
                          data-view-output={job.id}
                          onClick={() => void loadOutput(job.id)}
                          aria-label={`View output of ${job.label}`}
                          className="shrink-0 rounded-md px-1.5 py-0.5 hover:bg-raised hover:text-ink"
                        >
                          View Output
                        </button>
                        {isJobActive(job) && (
                          <button
                            type="button"
                            onClick={() => void stop(job.id)}
                            disabled={isStopping(job)}
                            aria-label={`Stop ${job.label}`}
                            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-danger hover:bg-danger/10 disabled:opacity-50"
                          >
                            <Square size={10} className="fill-current" aria-hidden />
                            Stop
                          </button>
                        )}
                      </div>
                      {reason && <p className="pl-4 text-[11px] leading-snug text-ink-secondary" data-testid="job-reason">{reason}</p>}
                      {stopError === job.id && (
                        <p role="alert" className="pl-4 text-[11px] text-danger">{`Could not stop it.${GAP}Try again.`}</p>
                      )}
                    </li>
                  );
                })}
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
