import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { startFakeOpenAiServer, type FakeOpenAiServer } from "./testing/fake-openai-server.ts";
import { freePortBlock } from "./testing/ports.ts";
import { harnessReady } from "./testing/harness-ready.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const posixOnly = describe.skipIf(process.platform === "win32");
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const says = (text: string) => ({
  kind: "sse" as const,
  frames: [`{"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}`, "[DONE]"],
});

posixOnly("App-bound private task API", () => {
  let child: ChildProcess;
  let engine: FakeOpenAiServer;
  let home: string;
  let base: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: Record<string, JsonValue>, headers: Record<string, string> = {}) => {
    const requestHeaders = { ...headers };
    if (body !== undefined) requestHeaders["content-type"] = "application/json";
    const response = await fetch(`${base}${path}`, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  const makeBot = async (instanceId = "minimax") => {
    const created = await api("POST", "/api/bots");
    expect(created.status).toBe(201);
    const patched = await api("PATCH", `/api/bots/${created.body.bot.id}`, {
      modelSelection: { instanceId, model: instanceId === "grok" ? "grok-4-fast" : "MiniMax-M3" },
    });
    expect(patched.status).toBe(200);
    return patched.body.bot;
  };

  const makeGroup = async (memberIds: string[], cwd?: string) => {
    const created = await api("POST", "/api/groups", {
      name: "App home",
      memberIds,
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: memberIds[0] } },
    });
    expect(created.status).toBe(201);
    if (cwd !== undefined) {
      const patched = await api("PATCH", `/api/groups/${created.body.group.id}`, { cwd });
      expect(patched.status).toBe(200);
      return patched.body.group;
    }
    return created.body.group;
  };

  beforeAll(async () => {
    engine = await startFakeOpenAiServer();
    home = mkdtempSync(join(tmpdir(), "botfleet-app-context-"));
    mkdirSync(join(home, ".botfleet"), { recursive: true });
    writeFileSync(join(home, ".botfleet", "config.json"), JSON.stringify({
      conversationMode: "projects",
      instances: {
        minimax: {
          driver: "minimax",
          config: { url: engine.url },
          environment: { MINIMAX_API_KEY: "fake-key-for-tests" },
        },
        grok: {
          driver: "grok",
          config: { url: engine.url },
          environment: { XAI_API_KEY: "fake-key-for-tests" },
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
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    const deadline = Date.now() + 45_000;
    for (;;) {
      if (await harnessReady(base)) break;
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }, 60_000);

  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    await engine?.close();
    await removeTempDir(home);
  });

  it("captures only an explicit App ref, ignores caller snapshots, and preserves mixed threads on refused merge", async () => {
    const bot = await makeBot();
    const appRoot = join(home, "app-repo");
    const nested = join(appRoot, "packages", "api");
    const changedRoot = join(home, "replacement-repo");
    mkdirSync(nested, { recursive: true });
    mkdirSync(changedRoot, { recursive: true });
    const group = await makeGroup([bot.id], nested);

    engine.queueCompletion(says("saved transcript"));
    const captured = await api("POST", `/api/bots/${bot.id}/tasks`, {
      title: "App task",
      appRef: { kind: "group", id: group.id },
      cwd: join(home, "attacker-folder"),
      workspaceContext: { kind: "local", appRef: { kind: "group", id: "spoofed" }, cwd: "/tmp" },
    });
    expect(captured.status).toBe(201);
    const context = captured.body.task.workspaceContext;
    expect(context).toMatchObject({ kind: "local", appRef: { kind: "group", id: group.id }, cwd: realpathSync(nested) });
    expect(context.capturedAt).toEqual(expect.any(Number));
    expect(context.cwd).not.toBe(realpathSync(changedRoot));
    // SAFETY: HTTP 201 guarantees `task` is the created wire task, whose threadId is a string.
    const appThreadId = captured.body.task.threadId as string;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "keep this transcript" })).status).toBe(202);
    const transcriptDeadline = Date.now() + 10_000;
    let transcript = await api("GET", `/api/threads/${appThreadId}/messages`);
    while (!transcript.body.messages.some((message: { role?: string; text?: string }) =>
      message.role === "bot" && message.text === "saved transcript")) {
      if (Date.now() > transcriptDeadline) throw new Error(`task transcript did not arrive. stderr: ${stderr.slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      transcript = await api("GET", `/api/threads/${appThreadId}/messages`);
    }

    const unassigned = await api("POST", `/api/bots/${bot.id}/tasks`, {
      title: "Unassigned task",
      cwd: changedRoot,
      workspaceContext: { kind: "local", appRef: { kind: "group", id: group.id }, cwd: changedRoot },
    });
    expect(unassigned.status).toBe(201);
    expect(unassigned.body.task.workspaceContext).toBeUndefined();

    expect((await api("PATCH", `/api/groups/${group.id}`, { name: "Renamed App", cwd: changedRoot })).status).toBe(200);
    const tasks = (await api("GET", "/api/bots")).body.bots.find((entry: { id: string }) => entry.id === bot.id).tasks;
    const stillBound = tasks.find((task: { threadId: string }) => task.threadId === appThreadId);
    expect(stillBound.workspaceContext).toEqual(context);
    expect(stillBound.cwd).toBe(realpathSync(nested));
    expect(tasks.find((task: { threadId: string }) => task.threadId === unassigned.body.task.threadId).workspaceContext).toBeUndefined();
    expect(transcript.body.messages.some((message: { text?: string }) => message.text === "keep this transcript")).toBe(true);

    const simple = await api("PATCH", "/api/conversation-mode", { conversationMode: "simple", mergeThreads: true });
    expect(simple.status).toBe(409);
    expect((await api("GET", "/api/config")).body.conversationMode).toBe("projects");
    const after = await api("GET", "/api/bots");
    const afterTasks = after.body.bots.find((entry: { id: string }) => entry.id === bot.id).tasks;
    expect(afterTasks.map((task: { threadId: string }) => task.threadId)).toContain(appThreadId);
    expect((await api("GET", `/api/threads/${appThreadId}/messages`)).body.messages).toHaveLength(transcript.body.messages.length);
  });

  it("rejects invalid, missing, unassigned, and phone-protected App folders", async () => {
    const bot = await makeBot();
    const other = await makeBot();
    const cwd = join(home, "refusal-folder");
    mkdirSync(cwd, { recursive: true });
    const memberApp = await makeGroup([bot.id], cwd);
    const nonmemberApp = await makeGroup([other.id], cwd);
    const noFolderApp = await makeGroup([bot.id]);

    expect((await api("POST", `/api/bots/${bot.id}/tasks`, { appRef: { kind: "section", id: memberApp.id } })).status).toBe(400);
    expect((await api("POST", `/api/bots/${bot.id}/tasks`, { appRef: { kind: "group", id: "missing-app" } })).status).toBe(404);
    expect((await api("POST", `/api/bots/${bot.id}/tasks`, { appRef: { kind: "group", id: nonmemberApp.id } })).status).toBe(400);
    expect((await api("POST", `/api/bots/${bot.id}/tasks`, { appRef: { kind: "group", id: noFolderApp.id } })).status).toBe(400);

    const protectedHome = join(home, ".ssh");
    const link = join(home, "phone-app-link");
    mkdirSync(protectedHome, { recursive: true });
    symlinkSync(protectedHome, link);
    const protectedApp = await makeGroup([bot.id], link);
    const phone = await api("POST", `/api/bots/${bot.id}/tasks`, { appRef: { kind: "group", id: protectedApp.id } }, { "x-botfleet-companion": "1" });
    expect(phone.status).toBe(403);
  });

  it("refuses a Grok-bound private task before provider dispatch, including after a group round-trip", async () => {
    const bot = await makeBot("grok");
    const cwd = join(home, "unsupported-driver-folder");
    mkdirSync(cwd, { recursive: true });
    const group = await makeGroup([bot.id], cwd);
    const created = await api("POST", `/api/bots/${bot.id}/tasks`, { appRef: { kind: "group", id: group.id } });
    expect(created.status).toBe(201);

    const sendAndAssertRefused = async (threadId: string) => {
      const before = engine.requests.filter((request) => request.url.includes("/chat/completions")).length;
      const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: "must stay local", threadId });
      expect(sent.status).toBe(409);
      expect(engine.requests.filter((request) => request.url.includes("/chat/completions"))).toHaveLength(before);
    };

    await sendAndAssertRefused(created.body.task.threadId);
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${created.body.task.threadId}`, { groupId: group.id })).status).toBe(200);
    expect((await api("POST", `/api/groups/${group.id}/tasks/${created.body.task.threadId}`)).status).toBe(200);
    const beforeRoomTurn = engine.requests.filter((request) => request.url.includes("/chat/completions")).length;
    const roomSend = await api("POST", `/api/groups/${group.id}/messages`, {
      text: "room App folder must stay local",
      threadId: created.body.task.threadId,
    });
    expect(roomSend.status, JSON.stringify(roomSend.body)).toBe(202);
    const roomDeadline = Date.now() + 10_000;
    let roomMessages = await api("GET", `/api/threads/${created.body.task.threadId}/messages`);
    while (!roomMessages.body.messages.some((message: { kind?: string; tool?: { name?: string } }) =>
      message.kind === "activity" && message.tool?.name?.includes("local App folder"))) {
      if (Date.now() > roomDeadline) throw new Error(`room App refusal activity did not arrive. stderr: ${stderr.slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      roomMessages = await api("GET", `/api/threads/${created.body.task.threadId}/messages`);
    }
    expect(engine.requests.filter((request) => request.url.includes("/chat/completions"))).toHaveLength(beforeRoomTurn);
    const roomAfterRefusal = (await api("GET", "/api/bots")).body.groups.find((entry: { id: string }) => entry.id === group.id);
    expect(roomAfterRefusal.working).not.toBe(true);
    expect((await api("GET", "/api/bots")).body.bots.find((entry: { id: string }) => entry.id === bot.id).busy).not.toBe(true);
    expect((await api("PATCH", `/api/groups/${group.id}/tasks/${created.body.task.threadId}`, { botId: bot.id })).status).toBe(200);
    expect((await api("POST", `/api/bots/${bot.id}/tasks/${created.body.task.threadId}`)).status).toBe(200);
    await sendAndAssertRefused(created.body.task.threadId);
    expect((await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Busy-state probe" })).status).toBe(201);
  });

  it("does not fall back when an App folder disappears after task creation", async () => {
    const bot = await makeBot();
    const cwd = join(home, "disappearing-app-folder");
    mkdirSync(cwd, { recursive: true });
    const group = await makeGroup([bot.id], cwd);
    const created = await api("POST", `/api/bots/${bot.id}/tasks`, { appRef: { kind: "group", id: group.id } });
    expect(created.status).toBe(201);
    const before = engine.requests.filter((request) => request.url.includes("/chat/completions")).length;
    await removeTempDir(cwd);

    const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: "do not use another folder" });
    expect(sent.status).toBe(409);
    expect((await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Busy-state probe" })).status).toBe(201);
    expect(engine.requests.filter((request) => request.url.includes("/chat/completions"))).toHaveLength(before);
  });
});
