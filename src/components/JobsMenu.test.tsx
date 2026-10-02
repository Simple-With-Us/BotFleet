// SSR tests for the background-jobs pill, its dropdown, the output sheet
// and the thread's "Job Finished" row (jobs P1).  Rendered with
// react-dom/server, so the clock is fixed and the open states are passed in.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { initialState, reducer } from "@/state/store";
import { jobEndedBadly, jobExitChip, jobWakeSubtitle, type JobSnapshot } from "../../shared/jobs";
import {
  JOB_FAILED_RED_MS,
  JOB_RECENT_MS,
  JOBS_FOOTER,
  JobFinishedRow,
  JobsMenuView,
  jobsMenuOffset,
  jobsPillDescription,
  jobsPillLabel,
  jobsPillTone,
  nextJobsBoundary,
  visibleJobs,
} from "./JobsMenu";

const NOW = Date.parse("2026-10-01T22:00:00.000Z");

function job(over: Partial<JobSnapshot> & { id: string }): JobSnapshot {
  return {
    botId: "bot-1",
    threadId: "thread-1",
    origin: "botfleet",
    kind: "shell",
    label: "pnpm test",
    cwd: "/Users/me/project",
    status: "running",
    exitCode: null,
    signal: null,
    startedAt: NOW - 252_000,
    endedAt: null,
    timeoutMs: 3_600_000,
    onComplete: "wake",
    notice: "none",
    ...over,
  };
}

const running = job({ id: "job_01JRUNNING0000000000000000", label: "pnpm test" });
const failed = job({
  id: "job_01JFAILED00000000000000000",
  label: "sleep 3; exit 2",
  status: "failed",
  exitCode: 2,
  startedAt: NOW - 63_000,
  endedAt: NOW - 60_000,
});
const killed = job({
  id: "job_01JKILLED00000000000000000",
  label: "pnpm dev",
  status: "killed",
  killedBy: "owner",
  signal: "SIGTERM",
  startedAt: NOW - 600_000,
  endedAt: NOW - 120_000,
});
const lost = job({
  id: "job_01JLOST0000000000000000000",
  label: "make all",
  status: "lost",
  startedAt: NOW - 900_000,
  endedAt: NOW - 300_000,
});

const render = (props: Parameters<typeof JobsMenuView>[0]) => renderToStaticMarkup(createElement(JobsMenuView, props));

describe("the jobs pill", () => {
  it("is hidden when the thread has no jobs, or only ones that ended long ago", () => {
    expect(render({ threadId: "thread-1", jobs: [], now: NOW })).toBe("");
    const stale = job({ id: "job_01JSTALE000000000000000000", status: "completed", exitCode: 0, endedAt: NOW - 3 * 3600_000 });
    expect(render({ threadId: "thread-1", jobs: [stale], now: NOW })).toBe("");
  });

  it("counts running jobs, with a dot that pulses only for motion-safe users", () => {
    const html = render({ threadId: "thread-1", jobs: [running, job({ id: "job_01JRUNNING0000000000000001" })], now: NOW });
    expect(html).toContain('data-testid="jobs-pill"');
    expect(html).toContain("2 Jobs");
    expect(html).toContain('data-tone="running"');
    expect(html).toContain("motion-safe:animate-pulse");
    expect(html).not.toMatch(/[^:]animate-pulse/);
    expect(html).toContain('aria-label="Background Jobs: 2 running"');
  });

  it("turns red after a recent failure, and says so in words too", () => {
    expect(jobsPillTone([running, failed], NOW)).toBe("failed");
    const html = render({ threadId: "thread-1", jobs: [failed], now: NOW });
    expect(html).toContain('data-tone="failed"');
    expect(html).toContain('aria-label="Background Jobs: 1 failed"');
    expect(jobsPillTone([running], NOW)).toBe("running");
    expect(jobsPillLabel([failed])).toBe("1 Job");
    expect(jobsPillDescription([running, failed, killed], NOW)).toBe("1 running, 1 failed, 1 finished");
  });

  it("folds to a glyph with the dot and the count as badges in a narrow header", () => {
    const html = render({ threadId: "thread-1", jobs: [running, job({ id: "job_01JRUNNING0000000000000001" })], now: NOW });
    const compact = html.slice(html.indexOf('data-testid="jobs-pill-compact"'));
    expect(compact).toContain("hidden @max-4xl/chathead:block");
    expect(compact).toContain("<svg");
    expect(compact).toMatch(/tabular-nums[^"]*">2</);
  });

  it("moves again with no job running: the red dot fades, then the job leaves the header", () => {
    // failed a minute ago: the dot turns grey at 5 minutes, the pill goes at 30
    expect(nextJobsBoundary([failed], NOW)).toBe(failed.endedAt! + JOB_FAILED_RED_MS + 1);
    const later = failed.endedAt! + JOB_FAILED_RED_MS + 1;
    expect(jobsPillTone([failed], later)).toBe("idle");
    expect(nextJobsBoundary([failed], later)).toBe(failed.endedAt! + JOB_RECENT_MS + 1);
    const gone = failed.endedAt! + JOB_RECENT_MS + 1;
    expect(visibleJobs([failed], gone)).toEqual([]);
    expect(render({ threadId: "thread-1", jobs: [failed], now: gone })).toBe("");
    expect(nextJobsBoundary([failed], gone)).toBeNull();
    expect(nextJobsBoundary([running], NOW)).toBeNull();
  });
});

describe("where the dropdown opens", () => {
  it("stays flush right when it fits, and moves right just enough when it would hang off the left", () => {
    expect(jobsMenuOffset(900, 352, 1200)).toBe(0);
    // a narrow chat column: the pill's right edge 340 px from the left
    expect(jobsMenuOffset(340, 352, 1200)).toBe(20);
    // never past the viewport's right edge
    expect(jobsMenuOffset(340, 352, 352)).toBe(4);
  });
});

describe("the jobs dropdown", () => {
  const html = render({ threadId: "thread-1", jobs: [lost, failed, running, killed], now: NOW, defaultOpen: true });

  it("lists running jobs first, then finished ones newest first", () => {
    const order = [...html.matchAll(/data-job-id="(job_\w+)"/g)].map((match) => match[1]);
    expect(order).toEqual([running.id, failed.id, killed.id, lost.id]);
    expect(visibleJobs([lost, failed, running, killed], NOW).map((j) => j.id)).toEqual(order);
  });

  it("shows each command in monospace with its exit chip and duration", () => {
    expect(html).toContain('<code class="min-w-0 flex-1 truncate font-mono');
    expect(html).toContain(">sleep 3; exit 2</code>");
    expect(html).toContain("Exited 2");
    expect(html).toContain("Killed by you");
    expect(html).toContain("Lost after restart");
    expect(html).toContain("4m 12s");
    expect(html).toContain("Running");
  });

  it("offers View Output on every row, Stop on running ones, and Stop All, each named for its job", () => {
    expect(html.match(/>View Output</g)).toHaveLength(4);
    expect(html.match(/<\/svg>Stop</g)).toHaveLength(1);
    expect(html).toContain(">Stop All<");
    expect(html).toContain("Background Jobs");
    expect(html).toContain('aria-label="View output of sleep 3; exit 2"');
    expect(html).toContain('aria-label="Stop pnpm test"');
  });

  it("says jobs end with BotFleet's server, true in every mode, with a real sentence gap", () => {
    expect(JOBS_FOOTER).toBe("Jobs run on this computer.\u00a0 They end when BotFleet's server stops or restarts, as it does for an update.");
    expect(html).toContain("Jobs run on this computer.\u00a0 They end");
    expect(html).not.toContain("Quitting the BotFleet app");
    expect(html).not.toContain("&amp;nbsp;");
    expect(html).not.toContain("&nbsp;");
  });

  it("says why a job ended when its chip cannot", () => {
    const system = job({
      id: "job_01JSYSTEM00000000000000000",
      label: "pnpm dev",
      status: "killed",
      killedBy: "system",
      reason: "the bot no longer has This Computer",
      startedAt: NOW - 200_000,
      endedAt: NOW - 100_000,
    });
    const cpu = job({
      id: "job_01JCPU000000000000000000000",
      label: "node spin.js",
      status: "failed",
      exitCode: 152,
      signal: "SIGXCPU",
      reason: "CPU limit reached",
      startedAt: NOW - 200_000,
      endedAt: NOW - 90_000,
    });
    const reasons = render({ threadId: "thread-1", jobs: [system, cpu, killed], now: NOW, defaultOpen: true });
    expect(reasons).toContain("The bot no longer has This Computer");
    expect(reasons).toContain("CPU limit reached");
    expect(reasons).not.toContain("Exited 152");
    expect(jobExitChip(cpu)).toBe("CPU limit reached");
    // an owner's own Stop needs no explanation
    expect(reasons.match(/data-testid="job-reason"/g)).toHaveLength(2);
  });

  it("names each member's job in a room", () => {
    const theirs = job({ id: "job_01JTHEIRS00000000000000000", botId: "bot-2", label: "pnpm dev" });
    const room = render({ threadId: "room-1", jobs: [running, theirs], now: NOW, defaultOpen: true, botNames: { "bot-1": "Mia", "bot-2": "Otto" } });
    expect(room).toContain(">Mia<");
    expect(room).toContain(">Otto<");
    expect(render({ threadId: "thread-1", jobs: [running], now: NOW, defaultOpen: true })).not.toContain('data-testid="job-member"');
  });

  it("says a Stop that failed, and lets the owner try again", () => {
    const failedStop = render({ threadId: "thread-1", jobs: [running], now: NOW, defaultOpen: true, initialStopError: running.id });
    expect(failedStop).toContain("Could not stop it.\u00a0 Try again.");
    expect(failedStop).toContain('role="alert"');
    // the button is live, and the chip says what the job is really doing
    expect(failedStop).not.toMatch(/disabled=""[^>]*aria-label="Stop pnpm test"/);
    expect(failedStop).toContain(">Running<");
    // "Stopping" comes from the job itself
    const stoppingJob = job({ id: running.id, status: "stopping" });
    expect(render({ threadId: "thread-1", jobs: [stoppingJob], now: NOW, defaultOpen: true })).toContain(">Stopping<");
  });

  it("drops Stop All when nothing runs", () => {
    const quiet = render({ threadId: "thread-1", jobs: [failed], now: NOW, defaultOpen: true });
    expect(quiet).not.toContain("Stop All");
  });

  it("shows a job's output in a sheet over the list, as text", () => {
    const sheet = render({
      threadId: "thread-1",
      jobs: [failed],
      now: NOW,
      defaultOpen: true,
      initialOutput: { jobId: failed.id, text: "FAIL src/a.test.ts\n<b>not markup</b>", loading: false },
    });
    expect(sheet).toContain('data-testid="job-output"');
    expect(sheet).toContain("FAIL src/a.test.ts");
    expect(sheet).toContain("&lt;b&gt;not markup&lt;/b&gt;");
    expect(sheet).toContain("Back");
    expect(sheet).not.toContain("View Output");
    // the output scrolls from the keyboard, and is named for its job
    expect(sheet).toMatch(/<pre[^>]*tabindex="0"[^>]*aria-label="Output of sleep 3; exit 2"/);
    // how the job ended rides the sheet's header
    expect(sheet.slice(sheet.indexOf('data-testid="job-output-status"'))).toContain("Exited 2");
    expect(sheet).not.toContain("Earlier output is not shown");
  });

  it("says when the sheet shows only the newest output", () => {
    const sheet = render({
      threadId: "thread-1",
      jobs: [failed],
      now: NOW,
      defaultOpen: true,
      initialOutput: { jobId: failed.id, text: "tail", loading: false, truncated: true },
    });
    expect(sheet).toContain("Showing the newest 64 KB.\u00a0 Earlier output is not shown.");
  });
});

describe("the Job Finished row", () => {
  it("names the job, how it ended and how long it ran", () => {
    const html = renderToStaticMarkup(
      createElement(JobFinishedRow, {
        job: { id: failed.id, label: failed.label, status: "failed", exitCode: 2, signal: null, startedAt: failed.startedAt, endedAt: failed.endedAt },
      }),
    );
    expect(html).toContain("Job Finished");
    expect(html).toContain(">sleep 3; exit 2</code>");
    expect(html).toContain("Exited 2");
    expect(html).toContain("3s");
    expect(html).toContain("bg-danger");
  });

  it("is not drawn as a failure when someone stopped the job", () => {
    const html = renderToStaticMarkup(
      createElement(JobFinishedRow, {
        job: { id: killed.id, label: killed.label, status: "killed", killedBy: "owner", exitCode: null, signal: "SIGTERM", startedAt: killed.startedAt, endedAt: killed.endedAt },
      }),
    );
    expect(html).toContain("Killed by you");
    expect(html).not.toContain("bg-danger");
    expect(jobEndedBadly({ status: "killed", killedBy: "owner" })).toBe(false);
    expect(jobEndedBadly({ status: "killed", killedBy: "timeout" })).toBe(true);
    expect(jobEndedBadly({ status: "killed", killedBy: "limit" })).toBe(true);
  });
});

describe("a job's wake in the thread", () => {
  it("says how the job ended, without its id or the words meant for the bot", () => {
    const prompt = [
      "Background job job_01JFAILED00000000000000000 `pnpm test --filter api` failed: exit code 2 after 3s.  Read its output with job_output.",
      "",
      "Your background job ended while you were idle.  Read its output with job_output if you need it.",
    ].join("\n");
    expect(jobWakeSubtitle(prompt)).toBe("pnpm test --filter api failed: exit code 2 after 3s");
    const two = `${prompt.split("\n")[0]}\nBackground job job_01JOTHER000000000000000000 \`make\` finished: exit code 0 after 1m 2s.  Read its output with job_output.`;
    expect(jobWakeSubtitle(two)).toBe("2 jobs ended");
    const long = `Background job job_01JLONG00000000000000000000 \`${"word ".repeat(30).trim()}\` failed: exit code 1 after 2s.`;
    const clipped = jobWakeSubtitle(long)!;
    expect(clipped.length).toBeLessThanOrEqual(80);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipped).not.toMatch(/wor…$/);
    expect(jobWakeSubtitle("Something else entirely")).toBeUndefined();
  });
});

describe("the jobs state", () => {
  it("keeps the latest full set per thread, from a hydrate or a frame", () => {
    let state = reducer(initialState, { type: "jobsHydrated", jobs: [running, job({ id: "job_01JOTHER000000000000000000", threadId: "thread-2" })] });
    expect(state.jobsByThread["thread-1"]?.map((j) => j.id)).toEqual([running.id]);
    expect(state.jobsByThread["thread-2"]).toHaveLength(1);
    state = reducer(state, { type: "jobsFrame", threadId: "thread-1", jobs: [failed] });
    expect(state.jobsByThread["thread-1"]?.map((j) => j.id)).toEqual([failed.id]);
    expect(state.jobsByThread["thread-2"]).toHaveLength(1);
  });
});
