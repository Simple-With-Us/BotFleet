// Messages an update held, carried across its restart, and read at boot.
//
// The update drain (server/update-drain.ts) holds a person's message to an idle
// bot, commits it to its thread when the fence goes up, and carries it in
// update-held-sends.json.  The next boot used to start every carried send at
// once, before the jobs registry had settled, so a second send for the same bot
// ended as "already working" and never ran (review finding 3; also 8 and 9).
// Now they go back through the bot's steer queue after boot recovery, and run
// one at a time, in the order they were held.
//
// Driven end to end against a real harness on a temp data directory, two boots,
// with an HTTP provider fixture whose request count IS the number of turns run.
// The carrier is produced by the real routes, the way an update produces it: a
// forced attempt that rolled back (its held message stays carried), then a later
// fence that carried a second message for the same bot.
import { createServer, request, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { harnessReady } from "./testing/harness-ready.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");

/** A cold harness boot on a loaded machine; the budget is about the machine. */
const LAUNCH_BUDGET_MS = 300_000;
const SLOW = { timeout: 150_000, interval: 250 };

const home = mkdtempSync(join(tmpdir(), "bf-update-held-boot-"));
const dataDir = join(home, ".botfleet");
const carrierPath = join(dataDir, "update-held-sends.json");
/** The last user line of every chat request the provider received, in order. */
const asked: string[] = [];
let provider: Server;
let child: ChildProcess | null = null;
let base = "";
let harnessPort = 0;
let output = "";

/** What these tests read back from the harness: loosely, as the wire has it. */
interface WireAnswer {
  bot?: { id: string; threadId: string };
  messages?: Array<{ role: string; text?: string; tool?: { name?: string } }>;
  queued?: boolean;
  quiescing?: boolean;
  draining?: boolean;
  safeToRestart?: boolean;
  drain?: { inFlight: number } | null;
}

interface CarriedFile {
  sends: Array<{ botId: string; prompt: string }>;
}

/** The request bodies these tests send. */
interface ApiBody {
  text?: string;
  modelSelection?: { instanceId: string; model: string };
}

const api = async (method: string, path: string, body?: ApiBody) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  // SAFETY: the harness's own JSON answer, read back by its test; the assertions below check it.
  const answer = (await res.json().catch(() => ({}))) as WireAnswer;
  return { status: res.status, body: answer };
};

const authorization = () => {
  const owner: { nonce: string } = JSON.parse(readFileSync(join(dataDir, "harness-owner.json"), "utf8"));
  return { Authorization: `Bearer ${owner.nonce}` };
};

const quiesce = async (method: "POST" | "DELETE", query = "") => {
  const res = await fetch(`${base}/api/runtime/quiesce${query}`, { method, headers: authorization() });
  // SAFETY: the harness's own JSON answer, read back by its test; the assertions below check it.
  const answer = (await res.json()) as WireAnswer;
  return { status: res.status, body: answer };
};

const carriedFile = (): CarriedFile => JSON.parse(readFileSync(carrierPath, "utf8"));

async function launch(): Promise<void> {
  child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(harnessPort),
      OMB_WEBHOOK_PORT: String(harnessPort + 1),
      OMB_DISABLE_ANTIGRAVITY_QUOTA: "1",
      DOCKER_HOST: process.env.DOCKER_HOST ?? "unix:///nonexistent.sock",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => (output += String(chunk)));
  child.stderr?.on("data", (chunk) => (output += String(chunk)));
  await expect.poll(() => harnessReady(base), { timeout: LAUNCH_BUDGET_MS, interval: 500 }).toBe(true);
}

async function stop(): Promise<void> {
  if (!child || child.exitCode !== null) return;
  await waitForExit(child, { signal: "SIGTERM" });
  child = null;
}

afterAll(async () => {
  await stop().catch(() => {});
  await new Promise<void>((resolve) => provider?.close(() => resolve()));
  await removeTempDir(home);
});

describe.skipIf(process.platform === "win32")("messages an update carried across its restart", () => {
  it("runs two carried sends for one bot at boot, each once, in order, and leaves no error", async () => {
    mkdirSync(dataDir, { recursive: true });
    provider = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"data":[{"id":"fixture-model"}]}');
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      let raw = "";
      req.on("data", (chunk) => (raw += String(chunk)));
      req.on("end", () => {
        const request: { messages?: Array<{ role: string; content: string | object }> } = JSON.parse(raw);
        const messages = request.messages ?? [];
        const lastUser = [...messages].reverse().find((message) => message.role === "user");
        asked.push(typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? ""));
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end('data: {"choices":[{"delta":{"content":"answered"}}]}\n\ndata: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    const providerPort = typeof address === "object" && address ? address.port : 0;
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({
        instances: {
          fixture: {
            driver: "openai-compat",
            displayName: "Fixture Provider",
            config: { url: `http://127.0.0.1:${providerPort}/v1`, models: ["fixture-model"] },
          },
        },
      }),
    );
    harnessPort = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${harnessPort}`;

    // ── first boot: an update holds two messages for one idle bot ─────────
    await launch();
    const created = await api("POST", "/api/bots", { modelSelection: { instanceId: "fixture", model: "fixture-model" } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const bot = created.body.bot;
    if (!bot) throw new Error(`no bot created: ${JSON.stringify(created.body)}`);

    expect((await quiesce("POST", "?drain=1&timeoutMs=600000")).body).toMatchObject({ draining: true });
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "first held message" })).body)
      .toMatchObject({ queued: true });

    // A forced attempt that cannot finish: a request still reading its body is
    // work it will not interrupt, so after its 15-second settle it rolls back.
    // The message it carried stays carried; the hold stays up.
    const heldMutation = request({
      hostname: "127.0.0.1", port: harnessPort, path: "/api/config", method: "PUT",
      headers: { "content-type": "application/json", "content-length": "2" },
    });
    heldMutation.on("error", () => {});
    heldMutation.write("{");
    await expect.poll(async () => (await quiesce("POST", "?drain=1&timeoutMs=600000")).body.drain?.inFlight, SLOW).toBe(1);
    const rolledBack = await quiesce("POST", "?force=true");
    expect(rolledBack.status).toBe(409);
    expect(rolledBack.body).toMatchObject({ quiescing: false, draining: true });
    const afterRollback = carriedFile();
    expect(afterRollback.sends.map((send) => send.prompt)).toEqual(["first held message"]);

    // A second message for the same bot, then the later fence carries it too.
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "second held message" })).body)
      .toMatchObject({ queued: true });
    heldMutation.destroy();
    await expect.poll(async () => (await quiesce("POST", "?drain=1&timeoutMs=600000")).body.drain?.inFlight, SLOW).toBe(0);
    const fenced = await quiesce("POST");
    expect(fenced.status).toBe(200);
    expect(fenced.body).toMatchObject({ quiescing: true, safeToRestart: true });
    const carried = carriedFile();
    expect(carried.sends.map((send) => [send.botId, send.prompt])).toEqual([
      [bot.id, "first held message"],
      [bot.id, "second held message"],
    ]);
    // Committed to the thread, not run.
    expect(asked).toEqual([]);

    // The restart.
    await stop();

    // ── second boot: the carrier is read, and both run, one after the other ─
    await launch();
    await expect.poll(() => asked.length, SLOW).toBe(2);
    expect(asked[0], output).toContain("first held message");
    expect(asked[1], output).toContain("second held message");
    // Give a duplicate every chance to show up.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(asked).toHaveLength(2);
    expect(existsSync(carrierPath)).toBe(false);

    const messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body.messages ?? [];
    const said = (text: string) => messages.filter((message) => message.role === "user" && message.text === text).length;
    expect(said("first held message")).toBe(1);
    expect(said("second held message")).toBe(1);
    expect(messages.filter((message) => message.tool?.name?.startsWith("error:")), output).toEqual([]);
  }, 900_000);
});
