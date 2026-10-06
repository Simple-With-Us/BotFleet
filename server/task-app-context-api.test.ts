import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TaskWorkspaceContext } from "../shared/task-workspace-context.ts";
import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { startFakeOpenAiServer, type FakeOpenAiServer } from "./testing/fake-openai-server.ts";
import { freePortBlock } from "./testing/ports.ts";
import { harnessReady } from "./testing/harness-ready.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const posixOnly = describe.skipIf(process.platform === "win32");
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type WireTask = { threadId: string; cwd?: string; workspaceContext?: TaskWorkspaceContext };
type WireBot = { id: string; busy?: boolean; tasks?: WireTask[] };
type WireGroup = { id: string; working?: boolean };
type WireMessage = { role?: string; kind?: string; text?: string; tool?: { name?: string } };
type ApiResponseBody = {
  bot?: WireBot;
  group?: WireGroup;
  task?: WireTask;
  bots?: WireBot[];
  groups?: WireGroup[];
  messages?: WireMessage[];
  conversationMode?: string;
  error?: string;
};
type ApiResult = { status: number; body: ApiResponseBody };

function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new Error(`API fixture response omitted ${field}`);
  return value;
}

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

  const api = async (method: string, path: string, body?: Record<string, JsonValue>, headers: Record<string, string> = {}): Promise<ApiResult> => {
    const requestHeaders = { ...headers };
    if (body !== undefined) requestHeaders["content-type"] = "application/json";
    const response = await fetch(`${base}${path}`, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // SAFETY: This test talks only to the local fixture server; its route responses match the concrete fields in ApiResponseBody, and required() checks fields before use.
    const responseBody = await response.json() as ApiResponseBody;
    return { status: response.status, body: responseBody };
  };

  const makeBot = async (instanceId = "minimax") => {
    const created = await api("POST", "/api/bots");
    expect(created.status).toBe(201);
    const patched = await api("PATCH", `/api/bots/${required(created.body.bot, "bot").id}`, {
      modelSelection: { instanceId, model: instanceId === "grok" ? "grok-4-fast" : "MiniMax-M3" },
    });
    expect(patched.status).toBe(200);
    return required(patched.body.bot, "bot");
  };

  const makeGroup = async (memberIds: string[], cwd?: string) => {
    const created = await api("POST", "/api/groups", {
      name: "App home",
      memberIds,
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: memberIds[0] } },
    });
    expect(created.status).toBe(201);
    if (cwd !== undefined) {
      const createdGroup = required(created.body.group, "group");
      const patched = await api("PATCH", `/api/groups/${createdGroup.id}`, { cwd });
      expect(patched.status).toBe(200);
      return required(patched.body.group, "group");
    }
    return required(created.body.group, "group");
  };

  const taskFrom = (response: ApiResult) => required(response.body.task, "task");
  const messagesFrom = (response: ApiResult) => required(response.body.messages, "messages");
  const botsFrom = (response: ApiResult) => required(response.body.bots, "bots");
  const groupsFrom = (response: ApiResult) => required(response.body.groups, "groups");

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
    const capturedTask = taskFrom(captured);
    const context = required(capturedTask.workspaceContext, "task.workspaceContext");
    expect(context).toMatchObject({ kind: "local", appRef: { kind: "group", id: group.id }, cwd: realpathSync(nested) });
    expect(context.capturedAt).toEqual(expect.any(Number));
    expect(context.cwd).not.toBe(realpathSync(changedRoot));
    const appThreadId = capturedTask.threadId;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "keep this transcript" })).status).toBe(202);
    const transcriptDeadline = Date.now() + 10_000;
    let transcript = await api("GET", `/api/threads/${appThreadId}/messages`);
    while (!messagesFrom(transcript).some((message) =>
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
    const unassignedTask = taskFrom(unassigned);
    expect(unassignedTask.workspaceContext).toBeUndefined();

    expect((await api("PATCH", `/api/groups/${group.id}`, { name: "Renamed App", cwd: changedRoot })).status).toBe(200);
    const tasks = required(botsFrom(await api("GET", "/api/bots")).find((entry) => entry.id === bot.id)?.tasks, "bot.tasks");
    const stillBound = required(tasks.find((task) => task.threadId === appThreadId), "bound task");
    expect(stillBound.workspaceContext).toEqual(context);
    expect(stillBound.cwd).toBe(realpathSync(nested));
    expect(tasks.find((task) => task.threadId === unassignedTask.threadId)?.workspaceContext).toBeUndefined();
    expect(messagesFrom(transcript).some((message) => message.text === "keep this transcript")).toBe(true);

    const simple = await api("PATCH", "/api/conversation-mode", { conversationMode: "simple", mergeThreads: true });
    expect(simple.status).toBe(409);
    expect(required((await api("GET", "/api/config")).body.conversationMode, "conversationMode")).toBe("projects");
    const after = await api("GET", "/api/bots");
    const afterTasks = required(botsFrom(after).find((entry) => entry.id === bot.id)?.tasks, "bot.tasks");
    expect(afterTasks.map((task) => task.threadId)).toContain(appThreadId);
    expect(messagesFrom(await api("GET", `/api/threads/${appThreadId}/messages`))).toHaveLength(messagesFrom(transcript).length);
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
    const createdTask = taskFrom(created);

    const sendAndAssertRefused = async (threadId: string) => {
      const before = engine.requests.filter((request) => request.url.includes("/chat/completions")).length;
      const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: "must stay local", threadId });
      expect(sent.status).toBe(409);
      expect(engine.requests.filter((request) => request.url.includes("/chat/completions"))).toHaveLength(before);
    };

    await sendAndAssertRefused(createdTask.threadId);
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${createdTask.threadId}`, { groupId: group.id })).status).toBe(200);
    expect((await api("POST", `/api/groups/${group.id}/tasks/${createdTask.threadId}`)).status).toBe(200);
    const beforeRoomTurn = engine.requests.filter((request) => request.url.includes("/chat/completions")).length;
    const roomSend = await api("POST", `/api/groups/${group.id}/messages`, {
      text: "room App folder must stay local",
      threadId: createdTask.threadId,
    });
    expect(roomSend.status, JSON.stringify(roomSend.body)).toBe(202);
    const roomDeadline = Date.now() + 10_000;
    let roomMessages = await api("GET", `/api/threads/${createdTask.threadId}/messages`);
    while (!messagesFrom(roomMessages).some((message) =>
      message.kind === "activity" && message.tool?.name?.includes("local App folder"))) {
      if (Date.now() > roomDeadline) throw new Error(`room App refusal activity did not arrive. stderr: ${stderr.slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      roomMessages = await api("GET", `/api/threads/${createdTask.threadId}/messages`);
    }
    expect(engine.requests.filter((request) => request.url.includes("/chat/completions"))).toHaveLength(beforeRoomTurn);
    const botsAfterRoom = await api("GET", "/api/bots");
    const roomAfterRefusal = required(groupsFrom(botsAfterRoom).find((entry) => entry.id === group.id), "App group");
    expect(roomAfterRefusal.working).not.toBe(true);
    expect(required(botsFrom(botsAfterRoom).find((entry) => entry.id === bot.id), "bot").busy).not.toBe(true);
    expect((await api("PATCH", `/api/groups/${group.id}/tasks/${createdTask.threadId}`, { botId: bot.id })).status).toBe(200);
    expect((await api("POST", `/api/bots/${bot.id}/tasks/${createdTask.threadId}`)).status).toBe(200);
    await sendAndAssertRefused(createdTask.threadId);
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
