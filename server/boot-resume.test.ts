// What a restart actually re-sends.
//
// On the owner's Mac the harness booted or was attached 29 times in two days,
// and every one that caught a bot mid-turn re-dispatched it: a clean SIGTERM
// left exactly the same `inflightThreadId` a crash leaves, and 2.5 s after
// boot every eligible bot went out at once with no stagger and no cap (audit
// HS18).  A second path could take the same thread on top of that (HS20).
//
// Driven end to end against a real harness on a temp data directory, with an
// HTTP provider fixture rather than a CLI: the provider's request count IS the
// token spend, and counting it is the only honest way to assert that a restart
// did not pay for the same turn twice.  One test, two boots — a harness boot
// on a loaded machine is minutes, and the coverage this buys per boot is what
// decides the shape of the file.
import { createServer, type Server } from "node:http";
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

/** A cold harness is a type-stripped module graph of a few hundred files, and
 * this Mac runs several test lanes at once.  The budget is about the machine,
 * not about the thing under test. */
const LAUNCH_BUDGET_MS = 300_000;

const home = mkdtempSync(join(tmpdir(), "bf-boot-resume-"));
const dataDir = join(home, ".botfleet");
const prompts: number[] = [];
let providerMode: "hold" | "answer" = "hold";
let provider: Server;
let child: ChildProcess | null = null;
let base = "";
let harnessPort = 0;
let output = "";

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

const bots = async (): Promise<Array<Record<string, any>>> => (await api("GET", "/api/bots?messages=0")).body.bots;

async function launch(): Promise<void> {
  child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
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

/** A bot whose turn is in flight: busy, with the durable crash marker set,
 * and its request sitting open on the provider. */
async function startHeldTurn(text: string): Promise<{ botId: string; threadId: string }> {
  const created = await api("POST", "/api/bots", {
    modelSelection: { instanceId: "fixture", model: "fixture-model" },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { text })).status).toBe(202);
  await expect
    .poll(async () => (await bots()).find((b) => b.id === bot.id)?.inflightThreadId, {
      timeout: 90_000,
      interval: 250,
    })
    .toBe(bot.threadId);
  return { botId: bot.id, threadId: bot.threadId };
}

const recordPath = () => join(dataDir, "interrupted-turns.json");
const record = () => (existsSync(recordPath()) ? JSON.parse(readFileSync(recordPath(), "utf8")) : null);

afterAll(async () => {
  await stop("SIGTERM").catch(() => {});
  await new Promise<void>((resolve) => provider?.close(() => resolve()));
  await removeTempDir(home);
});

// Windows has no POSIX signals: `child.kill("SIGTERM")` is TerminateProcess,
// so the harness's SIGINT/SIGTERM handler never runs and no stop record can
// be written.  The shutdown path under test only exists where signals do.
describe.skipIf(process.platform === "win32")("a graceful stop, and the boot after it", () => {
  it("records what it interrupted, then replays it once each, staggered and capped", async () => {
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
      prompts.push(Date.now());
      // "hold" leaves the request open, so the bot stays busy with its durable
      // marker set — the exact state a restart has to reason about.
      if (providerMode === "hold") return;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"resumed"}}]}\n\ndata: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const providerPort = (provider.address() as { port: number }).port;
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

    await launch();
    const first = await startHeldTurn("first bot, keep working");
    const second = await startHeldTurn("second bot, keep working");
    await expect.poll(() => prompts.length, { timeout: 60_000, interval: 250 }).toBe(2);

    await stop("SIGTERM");

    // (a) The stop is written down — the whole difference between a clean
    // shutdown and a crash on the next boot.  Before this they were
    // indistinguishable, and every restart re-dispatched blind.
    const saved = record();
    expect(saved?.turns, output).toHaveLength(2);
    expect((saved.turns as Array<{ botId: string }>).map((turn) => turn.botId).sort()).toEqual(
      [first.botId, second.botId].sort(),
    );
    for (const turn of saved.turns as Array<Record<string, unknown>>) {
      expect(turn.reason).toBe("shutdown");
      expect(typeof turn.at).toBe("number");
      expect(turn.threadId).toBeTruthy();
      // This driver announces no session id, so the harness cannot prove the
      // provider never saw the prompt.  An unproven guess is not a licence to
      // repeat side effects, so the recorded class is the conservative one.
      expect(turn.classification).toBe("unknown");
    }

    // (b) Stand up the one shape that IS replayable — a stop that classified
    // both turns as `before-accept`, i.e. the provider demonstrably never saw
    // the prompt — and have a post-update snapshot claim one of the same two
    // threads.  Before the coordinator, the snapshot dispatched at module init
    // and the 2.5 s timer dispatched again the moment the first one unwound
    // `busy`, so that thread went out twice (HS20).
    writeFileSync(
      recordPath(),
      JSON.stringify({
        version: 1,
        recordedAt: Date.now(),
        turns: [first, second].map((bot) => ({ ...bot, at: Date.now(), reason: "shutdown", classification: "before-accept" })),
        failures: [],
      }),
    );
    writeFileSync(
      join(dataDir, "pending-update-resume.json"),
      JSON.stringify({
        timestamp: Date.now(),
        interruptedRuns: [],
        interruptedBots: [{ botId: first.botId, threadId: first.threadId, promptText: "first bot, keep working" }],
      }),
    );

    providerMode = "answer";
    await launch();
    await expect.poll(() => prompts.length, { timeout: 150_000, interval: 250 }).toBe(4);
    // Give the other path every chance to fire late.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    expect(prompts, output).toHaveLength(4);

    // (c) One at a time rather than as a burst, and the caps are in the log a
    // person reading harness.log can check against what actually happened.
    expect(prompts[3]! - prompts[2]!).toBeGreaterThan(1_000);
    expect(output).toContain("boot recovery: resuming 2 of 2 interrupted thread(s)");
    expect(output).toMatch(/cap \d+, \d+ at a time, one every \d+s/);

    // (d) The record is consumed, so the boot after this one resumes nothing.
    expect(record()?.turns ?? []).toEqual([]);
  }, 900_000);
});
