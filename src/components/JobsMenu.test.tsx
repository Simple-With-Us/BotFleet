// SSR tests for the background-jobs pill, its dropdown, the output sheet
// and the thread's "Job Finished" row (jobs P1).  Rendered with
// react-dom/server, so the clock is fixed and the open states are passed in.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { initialState, reducer } from "@/state/store";
import type { JobSnapshot } from "../../shared/jobs";
import { JOBS_FOOTER, JobFinishedRow, JobsMenuView, jobsPillLabel, jobsPillTone, visibleJobs } from "./JobsMenu";

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
    expect(html).toContain('aria-label="Background Jobs: 2 Jobs"');
  });

  it("turns red after a recent failure", () => {
    expect(jobsPillTone([running, failed], NOW)).toBe("failed");
    expect(render({ threadId: "thread-1", jobs: [failed], now: NOW })).toContain('data-tone="failed"');
    expect(jobsPillTone([running], NOW)).toBe("running");
    expect(jobsPillLabel([failed])).toBe("1 Job");
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

  it("offers View Output on every row, Stop on running ones, and Stop All", () => {
    expect(html.match(/>View Output</g)).toHaveLength(4);
    expect(html.match(/<\/svg>Stop</g)).toHaveLength(1);
    expect(html).toContain(">Stop All<");
    expect(html).toContain("Background Jobs");
  });

  it("says that quitting the Mac app ends running jobs, with a real sentence gap", () => {
    expect(JOBS_FOOTER).toBe("Jobs run on this computer.  Quitting the BotFleet app ends any job still running.");
    expect(html).toContain("Jobs run on this computer.  Quitting");
    expect(html).not.toContain("&amp;nbsp;");
    expect(html).not.toContain("&nbsp;");
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
