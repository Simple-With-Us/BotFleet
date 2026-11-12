// The words a bot reads about its jobs (jobs P1): the live run limits in the
// system prompt, and a notice an engine without job tools can follow.
import { describe, expect, it } from "vitest";

import type { JobSnapshot } from "../../shared/jobs.ts";
import { jobsPrompt, noticeWithoutJobTools } from "./prompt.ts";
import { noticeLine, resolveJobsSettings } from "./registry.ts";

describe("the jobs section of the system prompt", () => {
  it("states the run limits the owner's settings give, not fixed ones", () => {
    const owner = resolveJobsSettings({ defaultMinutes: 20, maxMinutes: 30 });
    const text = jobsPrompt(true, owner);
    expect(text).toContain("A job is stopped after 20 minutes unless you pass timeout_minutes, and none may run longer than 30.");
    const raised = resolveJobsSettings({ maxMinutes: 360 });
    expect(jobsPrompt(true, raised)).toContain("after 60 minutes");
    expect(jobsPrompt(true, raised)).toContain("longer than 360.");
  });

  it("promises a wake only when wakes are on, and always says not to poll", () => {
    const limits = resolveJobsSettings(undefined);
    expect(jobsPrompt(true, limits)).toContain("by waking you if you are idle");
    expect(jobsPrompt(false, limits)).toContain("on your next turn here");
    expect(jobsPrompt(false, limits)).not.toContain("waking you");
    expect(jobsPrompt(false, limits)).toContain("Never poll a job");
  });
});

describe("a notice for an engine without job tools", () => {
  const job: JobSnapshot = {
    id: "job_01JABCDEFGHJKMNPQRSTVWXYZ0",
    botId: "b",
    threadId: "t",
    origin: "botfleet",
    kind: "shell",
    label: "pnpm test",
    cwd: "/tmp",
    status: "failed",
    exitCode: 1,
    signal: null,
    startedAt: 0,
    endedAt: 252_000,
    timeoutMs: 3_600_000,
    onComplete: "wake",
    notice: "pending",
  };

  it("keeps what happened and drops the sentence that sends the bot to a tool it lacks", () => {
    expect(noticeLine(job)).toContain("Read its output with job_output.");
    const plain = noticeWithoutJobTools(noticeLine(job));
    expect(plain).toBe("Background job job_01JABCDEFGHJKMNPQRSTVWXYZ0 `pnpm test` failed: exit code 1 after 4m 12s.");
    expect(plain).not.toContain("job_output");
  });

  it("leaves a notice that never named the tool as it is", () => {
    const stoppedByBot = noticeLine({ ...job, status: "killed", exitCode: null, killedBy: "model" });
    expect(noticeWithoutJobTools(stoppedByBot)).toBe(stoppedByBot);
  });
});
