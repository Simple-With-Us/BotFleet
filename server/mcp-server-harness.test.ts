// The MCP fleet tools against a real scratch harness: node server/index.ts on
// a throwaway home directory, the way index.test.ts exercises the HTTP
// surface.  A stranded approval card is found and answered, a retried send
// replays instead of running twice, and routines, webhooks, and the decision
// log round-trip through the bounded tool projections.
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { handleToolCall, request } from "../scripts/mcp-server.ts";
import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { harnessReady } from "./testing/harness-ready.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE_CLI = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 28800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const WEBHOOK_PORT = 39000 + Math.floor(Math.random() * 10_000);

let child: ChildProcess;
let home: string;
let stderr = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

const fetcher = (path: string, options?: RequestInit) => request(path, options, BASE);
const call = (name: string, args: Record<string, unknown> = {}): Promise<any> => handleToolCall(name, args, fetcher);

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "botfleet-mcp-harness-"));
  const dataDir = join(home, ".botfleet");
  mkdirSync(dataDir, { recursive: true });
  // one unknown driver plus the fixture Claude CLI that hangs mid-turn, so a
  // send starts a real turn without any network or installed agent
  writeFileSync(
    join(dataDir, "config.json"),
    JSON.stringify({
      instances: {
        ghost: { driver: "not-a-real-driver", displayName: "Ghost" },
        claude: { driver: "claudeAgent", displayName: "Fixture Claude", config: { cli: FAKE_CLAUDE_CLI } },
      },
    }),
  );
  writeFileSync(
    join(dataDir, "groups.json"),
    JSON.stringify([{
      id: "mcp-stranded-room",
      threadId: "mcp-stranded-thread",
      name: "Stranded room",
      memberIds: ["mcp-bot-a"],
      defaultResponder: { kind: "member", botId: "mcp-bot-a" },
      bulletin: "",
      unread: false,
      createdAt: 3,
    }]),
  );
  // an approval that outlived its turn: durable on the thread, nobody listening
  writeFileSync(
    join(dataDir, "messages-mcp-stranded-thread.json"),
    JSON.stringify({
      activeLeafId: "stranded-card",
      messages: [{
        id: "stranded-card",
        at: 3,
        parentId: null,
        role: "bot",
        kind: "options",
        card: {
          title: "Approval needed",
          subtitle: "rm -rf /tmp/scratch",
          options: ["Allow", "Deny"],
          requestId: "stranded-request",
          tool: "Bash",
          allowKey: "Bash:rm",
        },
        from: { botId: "mcp-bot-a", name: "Bot A", color: "purple" },
      }],
    }),
  );
  // two decision rows for two bots, so the bot filter has something to drop
  writeFileSync(
    join(dataDir, "decisions.ndjson"),
    [
      JSON.stringify({ at: "2026-09-02T10:00:00.000Z", threadId: "thread-x", requestId: "r1", botId: "bot-x", botName: "X", tool: "Bash", summary: "git status", decision: "auto-approved", source: "grant", rule: "Bash:git" }),
      JSON.stringify({ at: "2026-09-02T10:01:00.000Z", threadId: "thread-y", requestId: "r2", botId: "bot-y", botName: "Y", tool: "Bash", summary: "rm -rf", decision: "card-shown", source: "no-grant" }),
      "",
    ].join("\n"),
  );

  child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      OMB_WEBHOOK_PORT: String(WEBHOOK_PORT),
      FAKE_CLAUDE_MODE: "hang",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  child.stdout!.on("data", () => {});

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if (await harnessReady(BASE)) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}, 30_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

describe("MCP fleet tools against a scratch harness", () => {
  it("connects to the scratch harness", async () => {
    expect(await call("get_system_health")).toMatchObject({ status: "connected", app: "botfleet" });
  });

  it("finds a stranded approval with the ids needed to answer it, then answers it once", async () => {
    const pending = await call("list_pending_approvals");
    const card = pending.approvals.find((approval: any) => approval.requestId === "stranded-request");
    expect(card).toMatchObject({
      taskId: "mcp-stranded-thread",
      channelId: "mcp-stranded-room",
      channelName: "Stranded room",
      kind: "permission",
      tool: "Bash",
      botId: "mcp-bot-a",
      botName: "Bot A",
      summary: "rm -rf /tmp/scratch",
      options: ["Allow", "Deny"],
    });
    expect(JSON.stringify(pending)).not.toContain("Bash:rm");

    const scoped = await call("list_pending_approvals", { channel_id: "mcp-stranded-room" });
    expect(scoped.tasksInspected).toBe(1);
    expect(scoped.approvals).toHaveLength(1);

    // nothing is listening for this card any more: the harness closes it and says so
    const answered = await call("answer_approval", {
      task_id: "mcp-stranded-thread", request_id: "stranded-request", behavior: "deny", message: "Not from a script.",
    });
    expect(answered).toMatchObject({ outcome: "unavailable", delivered: false, behavior: "deny" });
    const after = await call("list_pending_approvals", { channel_id: "mcp-stranded-room" });
    expect(after.approvals).toEqual([]);
    const room = (await api("GET", "/api/bots")).body.groups.find((group: { id: string }) => group.id === "mcp-stranded-room");
    expect(room.messages.find((message: { id: string }) => message.id === "stranded-card").card).toMatchObject({
      dismissed: true, answered: "unavailable",
    });

    // the harness's own validation still stands behind this surface
    await expect(call("answer_approval", {
      task_id: "mcp-stranded-thread", request_id: "never-existed", behavior: "allow",
    })).rejects.toThrow("404");
  });

  it("replays a retried send instead of running the instruction twice", async () => {
    const created = await call("create_bot", { name: "Pipe" });
    const botId: string = created.bot.id;
    try {
      const instances = (await api("GET", "/api/instances")).body.instances;
      const claude = instances.find((instance: { instanceId: string }) => instance.instanceId === "claude");
      expect(claude.snapshot.state).toBe("available");
      expect((await api("PATCH", `/api/bots/${botId}`, {
        modelSelection: { instanceId: "claude", model: claude.models.default },
      })).status).toBe(200);

      const first = await call("send_bot_message", { bot_id: botId, text: "keep running", idempotency_key: "pipe:turn-1" });
      expect(first).toMatchObject({ success: true, outcome: "started", replayed: false, idempotencyKey: "pipe:turn-1" });
      const retry = await call("send_bot_message", { bot_id: botId, text: "keep running", idempotency_key: "pipe:turn-1" });
      expect(retry).toMatchObject({ outcome: "started", replayed: true });
      const transcript = await call("get_bot_messages", { bot_id: botId, limit: 50 });
      expect(transcript.messages.filter((message: any) => message.role === "user" && message.text === "keep running")).toHaveLength(1);

      // a different key while the turn is live reaches the live turn or its
      // queue, never a second turn
      await expect.poll(async () => (await call("list_bots")).bots.find((bot: any) => bot.id === botId)?.busy, { timeout: 5_000 }).toBe(true);
      const second = await call("send_bot_message", { bot_id: botId, text: "and this", idempotency_key: "pipe:turn-2" });
      expect(["steered", "queued"]).toContain(second.outcome);
      expect(second.replayed).toBe(false);

      // the route validates the key the same way the tool does
      const invalid = await api("POST", `/api/bots/${botId}/messages`, { text: "x", idempotencyKey: "has spaces" });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toContain("idempotencyKey");
    } finally {
      await api("DELETE", `/api/bots/${botId}`);
    }
  });

  it("lists, runs, and bounds routines and webhooks without leaking credentials", async () => {
    const created = await call("create_bot", { name: "Routine host" });
    const botId: string = created.bot.id;
    const routine = (await api("POST", "/api/routines", {
      name: "Nightly tidy",
      prompt: "x".repeat(1_200),
      botId,
      schedule: { type: "once", at: Date.now() + 3_600_000 },
    })).body.routine;
    let runId: string | undefined;
    let webhookId: string | undefined;
    try {
      const listed = await call("list_routines", { bot_id: botId });
      const mine = listed.routines.find((candidate: any) => candidate.id === routine.id);
      expect(mine).toMatchObject({ name: "Nightly tidy", botId, promptTruncated: true, enabled: true });
      expect(mine.prompt).toHaveLength(1_000);

      const ran = await call("run_routine", { routine_id: routine.id });
      runId = ran.run.id;
      expect(ran.run).toMatchObject({ routineId: routine.id, botId, manual: true });
      const withRuns = await call("list_routines", { bot_id: botId, run_limit: 5 });
      expect(withRuns.runs.map((run: any) => run.id)).toContain(runId);
      await expect(call("run_routine", { routine_id: "no-such-routine" })).rejects.toThrow("404");

      const hook = (await api("POST", "/api/webhooks", { name: "Deploy done", prompt: "Check the deploy", botId })).body;
      webhookId = hook.webhook.id;
      const secrets = JSON.stringify(hook.credential).match(/whsec_[A-Za-z0-9_-]+/g) ?? [];
      expect(secrets.length).toBeGreaterThan(0);
      const hooks = await call("list_webhooks");
      expect(hooks.webhooks.find((candidate: any) => candidate.id === webhookId)).toMatchObject({ name: "Deploy done", botId, enabled: true });
      expect(hooks.ingress).toHaveProperty("available");
      const serialized = JSON.stringify(hooks);
      for (const secret of secrets) expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(hook.webhook.endpointId);
      expect(serialized).not.toContain("secretHash");
    } finally {
      if (runId) await api("POST", `/api/routine-runs/${runId}/cancel`);
      if (webhookId) await api("DELETE", `/api/webhooks/${webhookId}`);
      await api("DELETE", `/api/routines/${routine.id}`);
      await api("DELETE", `/api/bots/${botId}`);
    }
  });

  it("reads the decision log with the server-side filters", async () => {
    const all = await call("read_decision_log", { limit: 10 });
    expect(all.decisions.map((row: any) => row.requestId)).toEqual(expect.arrayContaining(["r1", "r2"]));
    const mine = await call("read_decision_log", { bot_id: "bot-x" });
    expect(mine.decisions).toEqual([expect.objectContaining({
      requestId: "r1", taskId: "thread-x", decision: "auto-approved", rule: "Bash:git", unattended: false,
    })]);
    const byTask = await call("read_decision_log", { task_id: "thread-y", limit: 1 });
    expect(byTask.decisions.map((row: any) => row.requestId)).toEqual(["r2"]);
    expect((await api("GET", "/api/decisions?botId=not%20an%20id")).status).toBe(400);
  });
});
