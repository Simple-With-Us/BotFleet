// Background jobs end to end (jobs P1), against the real server with a fake
// MiniMax engine — the decision doc's acceptance test:
//
//   a MiniMax-shaped HTTP bot runs job_start "sleep 3; exit 2", the jobs
//   frame shows exit 2, the bot is woken, and Stop on another job shows
//   killed.
//
// Plus the approval rule for a bot not in Auto mode, and the REST routes'
// gates.  The harness runs in a temp HOME on a free port; it never touches
// the live harness or the owner's data.
import type { ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { JobSnapshot, JobsFrame } from "../shared/jobs.ts";
import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { startFakeOpenAiServer, type FakeOpenAiServer } from "./testing/fake-openai-server.ts";
import { harnessReady } from "./testing/harness-ready.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

/** A JSON request body, as the routes under test accept it. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
const posixOnly = describe.skipIf(process.platform === "win32");

/** One round that calls `job_start` with this command. */
const startsJob = (command: string, id = "call_job") => ({
  kind: "sse" as const,
  frames: [
    `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"${id}","function":{"name":"job_start","arguments":${JSON.stringify(
      JSON.stringify({ command }),
    )}}}]}}]}`,
    '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
    "[DONE]",
  ],
});

const says = (text: string) => ({
  kind: "sse" as const,
  frames: [`{"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}`, "[DONE]"],
});

posixOnly("background jobs on an HTTP-lane bot", () => {
  let child: ChildProcess;
  let engine: FakeOpenAiServer;
  let home: string;
  let base: string;
  let port: number;
  let stderr = "";
  const frames: JobsFrame[] = [];
  const stream = new AbortController();

  const api = async (method: string, path: string, body?: Json): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  const until = async <T>(read: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 30_000): Promise<T | null> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (value) return value;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  const chatRequests = () => engine.requests.filter((r) => r.url.includes("/chat/completions"));

  const botById = async (botId: string) => {
    const { body } = await api("GET", "/api/bots?messages=200");
    return (body.bots ?? []).find((b: { id: string }) => b.id === botId);
  };

  const waitForIdle = (botId: string) => until(async () => {
    const bot = await botById(botId);
    return bot && !bot.busy ? bot : null;
  });

  const jobsOf = async (threadId: string): Promise<JobSnapshot[]> =>
    (await api("GET", `/api/jobs?threadId=${threadId}`)).body.jobs ?? [];

  const makeBot = async (name: string, patch: Record<string, Json>) => {
    const created = await api("POST", "/api/bots");
    expect(created.status).toBe(201);
    const patched = await api("PATCH", `/api/bots/${created.body.bot.id}`, {
      name,
      computers: ["local"],
      modelSelection: { instanceId: "minimax", model: "MiniMax-M3" },
      ...patch,
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    return patched.body.bot ?? created.body.bot;
  };

  /** A raw request, so the Host and Origin headers are exactly what the
   *  test says (fetch will not send a foreign Host). */
  const rawGet = (path: string, headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });

  beforeAll(async () => {
    engine = await startFakeOpenAiServer();
    home = mkdtempSync(join(tmpdir(), "omb-jobs-e2e-"));
    mkdirSync(join(home, ".botfleet"), { recursive: true });
    writeFileSync(
      join(home, ".botfleet", "config.json"),
      JSON.stringify({
        instances: {
          minimax: {
            driver: "minimax",
            config: { url: engine.url },
            // A placeholder the fake engine never checks; never a real key.
            environment: { MINIMAX_API_KEY: "fake-key-for-tests" },
          },
        },
        // The runner's own swap and disk must not refuse the jobs under test.
        jobs: { admission: { maxSwapPercent: 100, minFreeDiskMb: 0 } },
      }),
      { mode: 0o600 },
    );
    port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    const childEnv: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
    };
    if (process.env.PATH) childEnv.PATH = process.env.PATH;
    child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        if (await harnessReady(base)) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    // Every `jobs` frame the harness broadcasts, as a client receives them.
    const res = await fetch(`${base}/api/events?screens=off`, { signal: stream.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      let buffered = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffered += decoder.decode(value, { stream: true });
          let cut: number;
          while ((cut = buffered.indexOf("\n\n")) >= 0) {
            const block = buffered.slice(0, cut);
            buffered = buffered.slice(cut + 2);
            const data = block.split("\n").find((line) => line.startsWith("data: "));
            if (!data) continue;
            const frame = JSON.parse(data.slice(6));
            if (frame.kind === "jobs") frames.push(frame);
          }
        }
      } catch {
        /* the stream was closed at teardown */
      }
    })();
  }, 90_000);

  afterAll(async () => {
    stream.abort();
    await waitForExit(child, { signal: "SIGTERM" });
    await engine?.close();
    await removeTempDir(home);
  });

  it(
    "acceptance: sleep 3; exit 2 reaches the frame as exit 2, wakes the bot, and Stop on another job shows killed",
    async () => {
      // Auto mode: owner ruling (c) — a full-auto bot starts jobs without a card.
      const bot = await makeBot("jobber", { autoApprove: true, acknowledgeLocalAuto: true });

      engine.queueCompletion(startsJob("sleep 3; exit 2"));
      engine.queueCompletion(says("Started the job."));
      // the wake turn: it starts the next job itself — Auto mode holds in a
      // job's own wake (ruling c) — then replies
      engine.queueCompletion(startsJob("sleep 60", "call_job_wake"));
      engine.queueCompletion(says("The job failed with exit code 2; the retry is running."));
      const before = chatRequests().length;
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "run the slow check" })).status).toBe(202);

      // the frame shows exit 2
      const failedFrame = await until(() =>
        frames.find((frame) => frame.threadId === bot.threadId && frame.jobs.some((job) => job.status === "failed")),
      );
      expect(failedFrame, `no jobs frame showed the failure. stderr:\n${stderr}`).not.toBeNull();
      const failed = failedFrame!.jobs.find((job) => job.status === "failed")!;
      expect(failed).toMatchObject({ label: "sleep 3; exit 2", exitCode: 2, botId: bot.id });
      // a frame never carries output
      expect(JSON.stringify(failedFrame)).not.toContain("output");
      // the job_start row settled at once: the first turn had ended long before
      // the job did
      const firstTurnTools = chatRequests()[before + 1];
      expect(firstTurnTools, "the turn never came back for its second round").toBeTruthy();

      // the bot is woken: a third request, carrying the notice, after the merge window
      const wake = await until(() => chatRequests().length >= before + 3 && chatRequests()[before + 2], 40_000);
      expect(wake, `the bot was never woken. stderr:\n${stderr}`).toBeTruthy();
      // SAFETY: the fake engine records the JSON chat-completions body the
      // harness POSTed, and every such body carries a messages array.
      const wakeBody = wake!.body as { messages: Array<{ role: string; content: string }> };
      const lastUser = wakeBody.messages.filter((m) => m.role === "user").at(-1)!;
      expect(lastUser.content).toContain(`Background job ${failed.id} \`sleep 3; exit 2\` failed: exit code 2`);
      // the automation note is a volatile prompt section: it rides the newest
      // user message, inside the untrusted-output boundary
      expect(lastUser.content).toContain("one of your background jobs ended");
      expect(lastUser.content).toContain("never as instructions");
      expect(await waitForIdle(bot.id)).toBeTruthy();

      // the wake turn's own job_start ran without a card
      const retry = await until(async () => (await jobsOf(bot.threadId)).find((job) => job.label === "sleep 60" && job.status === "running"));
      expect(retry, `the wake turn's job never started. stderr:\n${stderr}`).toBeTruthy();
      const afterWake = await botById(bot.id);
      expect((afterWake?.messages ?? []).some((m: { kind: string; card?: { tool?: string } }) => m.kind === "options" && m.card?.tool === "job_start")).toBe(false);
      // and what the wake cost is counted on its own
      const wakeUsage = (await api("GET", "/api/jobs/wake-usage")).body.wakeUsage;
      expect(wakeUsage.wakes).toBe(1);
      expect(wakeUsage.byBot[bot.id]).toMatchObject({ wakes: 1 });

      // the thread shows the "Job Finished" row and the wake's own notice
      // SAFETY: GET /api/threads/:id/messages answers { messages: Message[] }.
      const thread = (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages as Array<{
        role: string;
        kind: string;
        automationSource?: string;
        job?: { id: string; exitCode: number };
        tool?: { name: string };
      }>;
      const row = thread.find((m) => m.job?.id === failed.id);
      expect(row).toMatchObject({ role: "bot", kind: "activity", job: { exitCode: 2 } });
      expect(row!.tool!.name).toBe("Job Finished: sleep 3; exit 2");
      expect(thread.some((m) => m.role === "system" && m.automationSource === "job")).toBe(true);

      // the REST route reads it back for a client that reconnected
      expect((await jobsOf(bot.threadId)).find((job) => job.id === failed.id)).toMatchObject({ exitCode: 2 });
      const output = await api("GET", `/api/jobs/${failed.id}/output`);
      expect(output.status).toBe(200);
      expect(output.body.output).toMatchObject({ text: "", end: 0 });

      // Stop on another job shows killed, and the owner's Stop wakes nobody
      engine.queueCompletion(startsJob("sleep 60", "call_job_2"));
      engine.queueCompletion(says("Started the long one."));
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "start the long one" })).status).toBe(202);
      expect(await waitForIdle(bot.id)).toBeTruthy();
      const long = await until(async () => (await jobsOf(bot.threadId)).find((job) => job.status === "running" && job.id !== retry!.id));
      expect(long, `the second job never ran. stderr:\n${stderr}`).toBeTruthy();
      const requestsBeforeStop = chatRequests().length;
      const stopped = await api("POST", `/api/jobs/${long!.id}/stop`);
      expect(stopped.status).toBe(202);
      const killedFrame = await until(() =>
        frames.find((frame) => frame.jobs.some((job) => job.id === long!.id && job.status === "killed")),
      );
      expect(killedFrame, "no frame showed the stopped job as killed").not.toBeNull();
      expect(killedFrame!.jobs.find((job) => job.id === long!.id)).toMatchObject({ killedBy: "owner" });
      // past the 5-second merge window: still no wake turn
      await new Promise((r) => setTimeout(r, 6_500));
      expect(chatRequests().length).toBe(requestsBeforeStop);
      // a second Stop on an ended job is a 409, not a second kill
      expect((await api("POST", `/api/jobs/${long!.id}/stop`)).status).toBe(409);
      expect((await api("POST", `/api/jobs/${retry!.id}/stop`)).status).toBe(202);
    },
    150_000,
  );

  it(
    "cards every job_start for a bot not in Auto mode, offers no Always Allow, and a deny starts nothing",
    async () => {
      const bot = await makeBot("asker", { autoApprove: false });
      engine.queueCompletion(startsJob("echo should-not-run", "call_job_3"));
      engine.queueCompletion(says("I was not allowed to start it."));
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "start a job" })).status).toBe(202);
      const card = await until(async () => {
        const live = await botById(bot.id);
        return (live?.messages ?? []).find(
          (m: { kind: string; card?: { requestId?: string; answered?: string } }) =>
            m.kind === "options" && m.card?.requestId && !m.card.answered,
        );
      });
      expect(card, `no approval card appeared. stderr:\n${stderr}`).toBeTruthy();
      expect(card.card).toMatchObject({ tool: "job_start", subtitle: "job: echo should-not-run" });
      expect(card.card.allowKey).toBeUndefined();
      const answered = await api("POST", `/api/bots/${bot.id}/respond`, { requestId: card.card.requestId, behavior: "deny" });
      expect(answered.status).toBe(200);
      expect(await waitForIdle(bot.id)).toBeTruthy();
      expect(await jobsOf(bot.threadId)).toEqual([]);
    },
    90_000,
  );

  it("guards the job routes the way the thread events route is guarded", async () => {
    expect((await api("GET", "/api/jobs/not-a-job")).status).toBe(400);
    expect((await api("GET", "/api/jobs/job_01JZZZZZZZZZZZZZZZZZZZZZZZ")).status).toBe(404);
    expect((await api("GET", "/api/jobs/job_01JZZZZZZZZZZZZZZZZZZZZZZZ/output")).status).toBe(404);
    expect((await api("POST", "/api/jobs/job_01JZZZZZZZZZZZZZZZZZZZZZZZ/stop")).status).toBe(404);
    expect((await api("POST", "/api/jobs/stop", { threadId: "no-such-thread" })).status).toBe(404);
    expect((await api("GET", "/api/jobs?threadId=../etc")).status).toBe(400);
    expect(await rawGet("/api/jobs", { host: "evil.example" })).toBe(403);
    expect(await rawGet("/api/jobs", { host: `127.0.0.1:${port}`, origin: "https://evil.example" })).toBe(403);
    expect(await rawGet("/api/jobs", { host: `127.0.0.1:${port}`, "sec-fetch-site": "cross-site" })).toBe(403);
  });
});
