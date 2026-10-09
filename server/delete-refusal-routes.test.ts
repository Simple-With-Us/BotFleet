// Route level: DELETE /api/bots/:id and DELETE /api/groups/:id over a real server whose roster
// files cannot be written.  store-quarantine.test.ts pins the same refusal one layer down, on
// Store.deleteBot and Store.deleteGroup; this file pins what the HTTP route does with it.
//
// "Cannot be written" is set up by making bots.json and groups.json directories before boot.  That
// fails the same way on every platform and for every user, so the test never has to ask the
// filesystem whether a permission bit was honored.
//
// What a refused delete has to leave alone: the record, the workspace, and the transcript logs.  A
// refusal that still removed them would bring the bot or room back on the next boot pointing at
// data that is gone.
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");

let home: string;
let data: string;
let child: ChildProcess;
let stdout = "";
let stderr = "";
let portBase = 0;

/** Request bodies used in this file. */
interface ApiBody {
  name?: string;
  memberIds?: string[];
  prompt?: string;
  botId?: string;
  runOn?: string;
  enabled?: boolean;
  schedule?: { type: string; time: string; weekdays: number[] };
}

const base = () => `http://127.0.0.1:${portBase}`;
const api = async (method: string, path: string, body?: ApiBody): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const serverReady = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${base()}/api/health`);
    const health = z.object({ ready: z.boolean().optional() }).strict().safeParse(await res.json());
    return res.ok && (!health.success || health.data.ready !== false);
  } catch {
    return false;
  }
};
const botIds = async () => (await api("GET", "/api/bots?messages=0")).body.bots.map((bot: { id: string }) => bot.id);
const groupIds = async () => (await api("GET", "/api/bots?messages=0")).body.groups.map((group: { id: string }) => group.id);
/** Every transcript log a thread can have, in the three log directories. */
const logFiles = (threadId: string) =>
  ["events", "native", "item-io"].map((dir) => join(data, dir, `${threadId}.ndjson`));
const seedLogs = (threadId: string) => {
  for (const file of logFiles(threadId)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{}\n");
  }
};

describe("DELETE routes when the roster cannot be saved", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-delete-refusal-"));
    data = join(home, ".botfleet");
    const staticDir = join(home, "static");
    mkdirSync(join(data, "bots.json"), { recursive: true });
    mkdirSync(join(data, "groups.json"), { recursive: true });
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>BotFleet</title>");
    writeFileSync(
      join(data, "config.json"),
      JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } } }),
    );
    portBase = await freePortBlock([0, 1]);
    const emptyBin = join(home, "empty-bin");
    mkdirSync(emptyBin, { recursive: true });
    child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: ROOT,
      env: {
        PATH: emptyBin,
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(portBase),
        OMB_WEBHOOK_PORT: String(portBase + 1),
        OMB_STATIC_DIR: staticDir,
        OMB_DISABLE_ANTIGRAVITY_QUOTA: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    child.stdout!.on("data", (chunk) => (stdout += chunk));
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (await serverReady()) break;
      if (Date.now() > deadline) throw new Error(`server never came up. stdout:\n${stdout}\nstderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stdout:\n${stdout}\nstderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }, 180_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  }, 30_000);

  it("answers 409 for a bot and keeps its record, workspace and transcripts", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const workspace = join(data, "workspaces", bot.id);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "MEMORY.md"), "knows things");
    seedLogs(bot.threadId);

    const refused = await api("DELETE", `/api/bots/${bot.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/roster could not be saved/);

    expect(await botIds()).toContain(bot.id);
    expect(existsSync(join(workspace, "MEMORY.md"))).toBe(true);
    expect(logFiles(bot.threadId).filter((file) => !existsSync(file))).toEqual([]);
  }, 30_000);

  it("answers 409 for a room and keeps its record and transcripts", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Held room", memberIds: [bot.id] })).body.group;
    seedLogs(room.threadId);

    const refused = await api("DELETE", `/api/groups/${room.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/roster could not be saved/);

    expect(await groupIds()).toContain(room.id);
    expect(logFiles(room.threadId).filter((file) => !existsSync(file))).toEqual([]);
  }, 30_000);

  it("answers 404 for a bot that does not exist, not the roster refusal", async () => {
    expect((await api("DELETE", "/api/bots/no-such-bot")).status).toBe(404);
    expect((await api("DELETE", "/api/groups/no-such-room")).status).toBe(404);
  }, 30_000);

  // Documents today's ordering, so that changing it is a decision and not an accident.  The bot
  // route runs its soft cleanup (routines, webhooks, triggers off; any running turn interrupted)
  // BEFORE store.deleteBot is asked whether the roster can be saved.  A refused delete therefore
  // answers 409 and keeps the bot, but leaves it with its routines disabled.  Whether the refusal
  // should come first is the open question; moving it would make this assertion fail on purpose.
  it("currently disables a bot's routines even when the delete is then refused", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const created = await api("POST", "/api/routines", {
      name: "Nightly",
      prompt: "Check in.",
      botId: bot.id,
      runOn: "bot",
      enabled: true,
      schedule: { type: "daily", time: "03:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
    });
    expect(created.status).toBe(201);
    expect(created.body.routine.enabled).toBe(true);

    expect((await api("DELETE", `/api/bots/${bot.id}`)).status).toBe(409);

    expect(await botIds()).toContain(bot.id);
    const after = (await api("GET", "/api/routines")).body.routines.find(
      (routine: { id: string }) => routine.id === created.body.routine.id,
    );
    expect(after.enabled).toBe(false);
  }, 30_000);
});
