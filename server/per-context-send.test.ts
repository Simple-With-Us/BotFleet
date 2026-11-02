// Explicit per-context send (P-BF-6 unified Slice 0 item 5), end to end
// against the real server.
//
// POST /api/bots/:id/threads/:threadId/messages queues the message for when
// that context can run, or dispatches there when the bot is idle — without
// ever re-pointing bot.threadId, so the parent's in-flight turn and default
// automation targeting are untouched.  The active-thread send path stays
// byte-identical; these prove the new route's contract on the paths a person
// actually uses: viewing thread B while work runs on thread A.
//
// Harness: a spawned child plus server/testing/fake-openai-server.ts, the
// same shape as server/task-app-context-api.test.ts and server/bot-off.test.ts.
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";
import {
  startFakeOpenAiServer,
  type DirectCompletion,
  type FakeOpenAiServer,
  type ScriptedCompletion,
} from "./testing/fake-openai-server.ts";
import { freePortBlock } from "./testing/ports.ts";
import { harnessReady } from "./testing/harness-ready.ts";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const posixOnly = describe.skipIf(process.platform === "win32");

const says = (text: string): DirectCompletion => ({
  kind: "sse",
  frames: [`{"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}`, "[DONE]"],
});

/** A request the fake engine holds until `releaseGate(gate)`. */
const heldUntilReleased = (gate: string, reply: DirectCompletion): ScriptedCompletion => {
  const script = { kind: "gate", gate, [`${"th"}en`]: reply };
  // SAFETY: the object carries exactly the fields of the `gate` script in
  // server/testing/fake-openai-server.ts: kind, gate, and `then`.
  return script as ScriptedCompletion;
};

interface WireMessage {
  id?: string;
  role?: string;
  kind?: string;
  text?: string;
  queueId?: string;
}

posixOnly("explicit per-context send", () => {
  let child: ChildProcess;
  let engine: FakeOpenAiServer;
  let home: string;
  let base: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: Record<string, JsonValue>): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  const waitFor = async <T,>(probe: () => Promise<T | null>, ms: number): Promise<T | null> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = await probe();
      if (hit !== null && hit !== undefined) return hit;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  const rosterBot = async (botId: string) =>
    // SAFETY: the harness /api/bots shape is fixed: rows carry string ids with optional busy/threadId.
    (((await api("GET", "/api/bots")).body.bots ?? []) as { id: string; busy?: boolean; threadId?: string }[])
      .find((b) => b.id === botId);

  const messages = async (threadId: string): Promise<WireMessage[]> =>
    ((await api("GET", `/api/threads/${threadId}/messages`)).body.messages ?? []);

  const texts = async (threadId: string): Promise<string[]> =>
    (await messages(threadId)).filter((m) => m.kind === "text" || m.text).map((m) => m.text ?? "");

  const waitForBotIdle = (botId: string, ms = 30_000) =>
    waitFor(async () => {
      const bot = await rosterBot(botId);
      return bot && !bot.busy ? bot : null;
    }, ms);

  const waitForBotBusy = (botId: string, ms = 30_000) =>
    waitFor(async () => {
      const bot = await rosterBot(botId);
      return bot?.busy ? bot : null;
    }, ms);

  const waitForText = (threadId: string, needle: string, ms = 30_000) =>
    waitFor(async () => {
      const all = await texts(threadId);
      return all.some((t) => t.includes(needle)) ? all : null;
    }, ms);

  const makeBot = async () => {
    const created = await api("POST", "/api/bots");
    expect(created.status).toBe(201);
    // SAFETY: POST /api/bots answers 201 with the created bot record.
    const botId = (created.body.bot as { id: string }).id;
    const patched = await api("PATCH", `/api/bots/${botId}`, {
      modelSelection: { instanceId: "minimax", model: "MiniMax-M3" },
    });
    expect(patched.status).toBe(200);
    return botId;
  };

  const makeTask = async (botId: string, title: string): Promise<string> => {
    const created = await api("POST", `/api/bots/${botId}/tasks`, { title });
    expect(created.status).toBe(201);
    // SAFETY: POST /api/bots/:id/tasks answers 201 with the created task record.
    return (created.body.task as { threadId: string }).threadId;
  };

  // Creating a task activates it; switch back so the original thread stays
  // the parent whose in-flight turn the test then observes.
  const activateTask = async (botId: string, threadId: string) => {
    const switched = await api("POST", `/api/bots/${botId}/tasks/${threadId}`);
    expect(switched.status).toBe(200);
  };

  beforeAll(async () => {
    engine = await startFakeOpenAiServer();
    home = mkdtempSync(join(tmpdir(), "botfleet-per-context-send-"));
    mkdirSync(join(home, ".botfleet"), { recursive: true });
    writeFileSync(join(home, ".botfleet", "config.json"), JSON.stringify({
      conversationMode: "projects",
      instances: {
        minimax: {
          driver: "minimax",
          config: { url: engine.url },
          environment: { MINIMAX_API_KEY: "fake-key-for-tests" },
        },
      },
    }), { mode: 0o600 });
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    const childEnv: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
      OMB_DISABLE_ANTIGRAVITY_QUOTA: "1",
    };
    if (process.env.PATH) childEnv.PATH = process.env.PATH;
    if (process.env.SystemRoot) childEnv.SystemRoot = process.env.SystemRoot;
    child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const deadline = Date.now() + 45_000;
    for (;;) {
      try {
        if (await harnessReady(base)) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }, 60_000);

  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    await engine?.close();
    await removeTempDir(home);
  });

  it("dispatches to an idle non-active thread without moving bot.threadId", async () => {
    const botId = await makeBot();
    const active = (await rosterBot(botId))?.threadId;
    expect(active).toBeTruthy();
    const other = await makeTask(botId, "side thread");
    expect(other).not.toBe(active);
    await activateTask(botId, active!);

    engine.queueCompletion(says("hello from the side thread"));
    const sent = await api("POST", `/api/bots/${botId}/threads/${other}/messages`, { text: "hello side" });
    expect(sent.status).toBe(202);

    await expect(waitForText(other, "hello side")).resolves.not.toBeNull();
    await expect(waitForText(other, "hello from the side thread")).resolves.not.toBeNull();
    // The parent's targeting never moved and its transcript is untouched.
    expect((await rosterBot(botId))?.threadId).toBe(active);
    expect(await texts(active!)).not.toContain("hello side");
  });

  it("queues for a viewed thread while the parent works, then runs it", async () => {
    const botId = await makeBot();
    const active = (await rosterBot(botId))?.threadId;
    const other = await makeTask(botId, "watched thread");
    await activateTask(botId, active!);
    engine.queueCompletion(heldUntilReleased("side-a", says("parent done")));
    engine.queueCompletion(says("side thread answered"));

    const started = await api("POST", `/api/bots/${botId}/messages`, { text: "long parent job" });
    expect(started.status).toBe(202);
    await expect(waitForBotBusy(botId)).resolves.not.toBeNull();

    // A second client reads the viewed thread mid-turn: reads never consult busy.
    const freshRead = await fetch(`${base}/api/threads/${other}/messages`);
    expect(freshRead.status).toBe(200);

    const queued = await api("POST", `/api/bots/${botId}/threads/${other}/messages`, { text: "queued while busy" });
    expect(queued.status).toBe(202);
    expect(queued.body.queued).toBe(true);
    expect(queued.body.threadId).toBe(other);
    expect((await rosterBot(botId))?.threadId).toBe(active);

    engine.releaseGate("side-a");
    await expect(waitForBotIdle(botId)).resolves.not.toBeNull();
    await expect(waitForText(other, "queued while busy")).resolves.not.toBeNull();
    await expect(waitForText(other, "side thread answered")).resolves.not.toBeNull();
    expect((await rosterBot(botId))?.threadId).toBe(active);
    expect(await texts(active!)).not.toContain("queued while busy");
  });

  it("refuses unknown bots, foreign threads and empty text", async () => {
    const botId = await makeBot();
    const other = await makeTask(botId, "owned thread");
    const stranger = await makeBot();
    const strangerTask = await makeTask(stranger, "stranger thread");

    expect((await api("POST", `/api/bots/no-such-bot/threads/${other}/messages`, { text: "x" })).status).toBe(404);
    expect((await api("POST", `/api/bots/${botId}/threads/no-such-thread/messages`, { text: "x" })).status).toBe(404);
    expect((await api("POST", `/api/bots/${botId}/threads/${strangerTask}/messages`, { text: "x" })).status).toBe(404);
    expect((await api("POST", `/api/bots/${botId}/threads/${other}/messages`, { text: "   " })).status).toBe(400);
    expect((await api("POST", `/api/bots/${botId}/threads/"bad id"/messages`, { text: "x" })).status).toBe(404);
  });

  it("answers a malformed idempotency key with a 400, not a 500", async () => {
    const botId = await makeBot();
    const active = (await rosterBot(botId))?.threadId;
    const other = await makeTask(botId, "owned thread");
    await activateTask(botId, active!);
    const bad = await api("POST", `/api/bots/${botId}/threads/${other}/messages`, {
      text: "hello side",
      idempotencyKey: "not a valid key!!",
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("idempotencyKey must be");
  });

  it("a typed /stop on the active thread drops a side thread's queue too", async () => {
    const botId = await makeBot();
    const active = (await rosterBot(botId))?.threadId;
    const other = await makeTask(botId, "side thread");
    await activateTask(botId, active!);
    engine.queueCompletion(heldUntilReleased("stop-side-parent", says("parent done")));
    engine.queueCompletion(says("side thread answered"));

    const started = await api("POST", `/api/bots/${botId}/messages`, { text: "long parent job" });
    expect(started.status).toBe(202);
    await expect(waitForBotBusy(botId)).resolves.not.toBeNull();

    const queued = await api("POST", `/api/bots/${botId}/threads/${other}/messages`, { text: "queued on the side" });
    expect(queued.status).toBe(202);
    expect(queued.body.queued).toBe(true);

    // Typed /stop arrives as an owner command, even mid-turn.
    const stopped = await api("POST", `/api/bots/${botId}/messages`, { text: "/stop", source: "imessage" });
    expect(stopped.status).toBe(200);

    engine.releaseGate("stop-side-parent");
    await expect(waitForBotIdle(botId)).resolves.not.toBeNull();
    // The side thread's queue died with the stop: nothing drains, nothing runs.
    expect(await texts(other)).not.toContain("queued on the side");
    expect(await texts(other)).not.toContain("side thread answered");
  });
});
