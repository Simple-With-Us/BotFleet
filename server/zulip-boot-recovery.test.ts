// A restart with a Zulip wake waiting must not bury the turn it interrupted.
//
// The race this pins: the Zulip hub connects as soon as the harness is up,
// while boot recovery runs 2.5 s later.  A wake persisted behind a turn the
// restart interrupted used to start first, take the bot, and leave boot
// recovery skipping a busy bot, so the interrupted turn (one a "pause &
// install" promised to resume) was never resumed.  Now the hub holds every
// dispatch until boot recovery has finished, and a bot that still holds an
// interrupted turn's marker takes no Zulip work.
//
// Driven end to end: a real harness on a temp data folder, an HTTP provider
// fixture whose request log IS the order things ran in, and a fake Zulip
// realm.  The provider holds every Zulip prompt open, so a Zulip turn that
// started first would still own the bot when recovery looked.
import { createServer, type Server, type ServerResponse } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { FakeZulip } from "./testing/fake-zulip-server.ts";
import { freePortBlock } from "./testing/ports.ts";
import { harnessReady } from "./testing/harness-ready.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const LAUNCH_BUDGET_MS = 300_000;
const JAY = 9;
const PLUMBER = 101;
const OWNER_TEXT = "owner turn, keep working";

const home = mkdtempSync(join(tmpdir(), "bf-zulip-boot-"));
const dataDir = join(home, ".botfleet");
const rcDir = join(home, "zulip-keys");
/** Every chat request the provider saw, in arrival order. */
const requests: string[] = [];
const held: ServerResponse[] = [];
let providerMode: "hold" | "answer" = "hold";
let provider: Server;
const fake = new FakeZulip();
let child: ChildProcess | null = null;
let base = "";
let harnessPort = 0;
let output = "";

type JsonBody = Record<string, string | Record<string, string | Record<string, Record<string, string>>>>;

const api = async (method: string, path: string, body?: JsonBody) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

const bots = async (): Promise<Array<Record<string, any>>> => (await api("GET", "/api/bots?messages=0")).body.bots;
const zulipBot = async (botId: string) =>
  ((await api("GET", "/api/zulip/status")).body.bots as Array<Record<string, any>>).find((bot) => bot.botId === botId);

async function launch(): Promise<void> {
  child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(harnessPort),
      OMB_WEBHOOK_PORT: String(harnessPort + 1),
      OMB_DISABLE_ANTIGRAVITY_QUOTA: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => (output += String(chunk)));
  child.stderr?.on("data", (chunk) => (output += String(chunk)));
  await expect.poll(() => harnessReady(base), { timeout: LAUNCH_BUDGET_MS, interval: 500 }).toBe(true);
}

async function stop(signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  if (!child || child.exitCode !== null) return;
  await waitForExit(child, { signal });
  child = null;
}

const recordPath = () => join(dataDir, "interrupted-turns.json");
const isZulip = (body: string) => body.includes("[ZULIP INBOUND]");

afterAll(async () => {
  await stop("SIGTERM").catch(() => {});
  for (const res of held) res.destroy();
  provider?.closeAllConnections?.();
  await new Promise<void>((resolve) => (provider ? provider.close(() => resolve()) : resolve()));
  await fake.stop();
  await removeTempDir(home);
});

describe.skipIf(process.platform === "win32")("a restart with a Zulip wake waiting", () => {
  it("resumes the interrupted turn first, then starts the Zulip unit", async () => {
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(rcDir, { recursive: true });
    provider = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"data":[{"id":"fixture-model"}]}');
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push(body);
      // A Zulip prompt is never answered: a Zulip turn that got the bot first
      // would still own it when boot recovery looked.  The first boot's owner
      // turn is held too, so the restart interrupts it.
      if (providerMode === "hold" || isZulip(body)) {
        held.push(res);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"resumed"}}]}\n\ndata: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const providerPort = (provider.address() as { port: number }).port;

    fake.addUser({ user_id: JAY, full_name: "Jay Wedgeworth", is_bot: false, role: 100 });
    fake.addUser({ user_id: PLUMBER, full_name: "BF-Plumber", email: "bf-plumber-bot@zulip.test", key: "plumber-boot-key" });
    await fake.start();
    const rc = join(rcDir, "BF-Plumber-zuliprc");
    writeFileSync(rc, `[api]\nemail=bf-plumber-bot@zulip.test\nkey=plumber-boot-key\nsite=${fake.url}\n`);
    chmodSync(rc, 0o600);

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
        zulip: { enabled: true, realm: fake.url, ownerUserId: JAY, credentialDir: rcDir },
      }),
    );
    harnessPort = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${harnessPort}`;

    // ── Boot 1: an owner turn in flight, and a Zulip wake queued behind it.
    await launch();
    const created = await api("POST", "/api/bots", { modelSelection: { instanceId: "fixture", model: "fixture-model" } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    expect((await api("PUT", "/api/config", { zulip: { bots: { [bot.id]: { role: "BF-Plumber" } } } })).status).toBe(200);
    await expect.poll(async () => (await zulipBot(bot.id))?.state, { timeout: 60_000, interval: 250 }).toBe("connected");

    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: OWNER_TEXT })).status).toBe(202);
    await expect.poll(() => requests.length, { timeout: 90_000, interval: 250 }).toBe(1);
    await expect
      .poll(async () => (await bots()).find((b) => b.id === bot.id)?.inflightThreadId, { timeout: 30_000, interval: 250 })
      .toBe(bot.threadId);

    fake.postStream(JAY, "agent-sync", "BF boot", "@**BF-Plumber** check after the restart", "website");
    await expect.poll(async () => (await zulipBot(bot.id))?.pending, { timeout: 30_000, interval: 250 }).toBe(1);

    await stop("SIGTERM");
    expect(existsSync(join(dataDir, "zulip", `${bot.id}.json`))).toBe(true);
    // The one shape boot recovery replays: a stop that proved the provider
    // never accepted the prompt (as server/boot-resume.test.ts stages it).
    writeFileSync(
      recordPath(),
      JSON.stringify({
        version: 1,
        recordedAt: Date.now(),
        turns: [{ botId: bot.id, threadId: bot.threadId, at: Date.now(), reason: "shutdown", classification: "before-accept" }],
        failures: [],
      }),
    );

    // ── Boot 2: the interrupted turn goes out first, the Zulip unit after.
    const before = requests.length;
    providerMode = "answer";
    await launch();
    await expect.poll(() => requests.length - before, { timeout: 150_000, interval: 250 }).toBeGreaterThanOrEqual(2);
    const after = requests.slice(before);
    expect(isZulip(after[0]!), output).toBe(false);
    expect(after[0]).toContain(OWNER_TEXT);
    expect(after.slice(1).some(isZulip), output).toBe(true);
    expect(output).toContain("boot recovery: resuming 1 of 1 interrupted thread(s)");
    // and the record is consumed: the boot after this resumes nothing
    const left = existsSync(recordPath()) ? JSON.parse(readFileSync(recordPath(), "utf8")).turns : undefined;
    expect(left ?? []).toEqual([]);
  }, 900_000);
});
