// The graceful stop, end to end.
//
// The module's own tests inject the clock, the wait and the counts, and
// server/graceful-shutdown-route.test.ts pins how the routes are wired to it.
// Neither can answer the questions a person actually has when they press
// Stop:  does the server go down, does it go down as soon as the bots are
// done rather than after the whole window, and does a stop that refuses leave
// the owner's messages where they were?
//
// So this drives the real route against a real harness on a throwaway home,
// with a provider fixture that holds its answer open for a moment.  The bot
// is still working when the stop arrives and it finishes a moment later:  the
// stop has to end when the bot is done.
//
// One harness per test, and a boot is minutes on a loaded machine, so each
// test buys what it needs from the one it starts.
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { harnessReady } from "./testing/harness-ready.ts";
import { HELD_SENDS_FILE } from "./update-drain.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");

/** A cold harness is a type-stripped module graph of a few hundred files, and
 *  this Mac runs several test lanes at once.  The budget is about the machine,
 *  not about the thing under test. */
const LAUNCH_BUDGET_MS = 300_000;

/** How long the provider holds its answer open.
 *
 *  Long enough that the bot is still working when the stop arrives, and
 *  short enough that the whole stop is far below the window it would wait
 *  out if it never noticed the bot was done. */
const PROVIDER_HOLD_MS = 2_000;

/** The window the stop would wait out if the work in flight never settled. */
const STOP_WINDOW_MS = 10_000;

/** The JSON this fixture sends:  a bot's creation, a message, an empty body. */
type JsonBody = {
  modelSelection?: { instanceId: string; model: string };
  text?: string;
};

const botSchema = z.object({
  id: z.string(),
  name: z.string(),
  threadId: z.string(),
  inflightThreadId: z.string().nullish(),
});

/** A harness, its provider and the throwaway home they run in. */
interface Harness {
  home: string;
  dataDir: string;
  base: string;
  /** The provider's answers, and everything the harness printed. */
  state: { requests: number; output: string };
  child: ChildProcess | null;
  provider: Server;
}

const harnesses: Harness[] = [];

async function startHarness(): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), "bf-graceful-stop-"));
  const dataDir = join(home, ".botfleet");
  mkdirSync(dataDir, { recursive: true });
  const state = { requests: 0, output: "" };
  const provider = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"data":[{"id":"fixture-model"}]}');
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    state.requests += 1;
    // The answer is held open, so the bot is still working when the stop
    // arrives and it finishes a moment later.
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n');
    }, PROVIDER_HOLD_MS);
  });
  const harness: Harness = {
    home,
    dataDir,
    base: "",
    state,
    child: null,
    provider,
  };
  // The provider gets a port of its own, probed free first:  two fixtures on
  // the same machine must not fight over one.
  const providerPort = await freePortBlock([0]);
  await new Promise<void>((resolve) => provider.listen(providerPort, "127.0.0.1", resolve));
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
  const port = await freePortBlock([0, 1]);
  harness.base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    OMB_PORT: String(port),
    OMB_WEBHOOK_PORT: String(port + 1),
    OMB_DISABLE_ANTIGRAVITY_QUOTA: "1",
  };
  if (process.env.PATH) env.PATH = process.env.PATH;
  harness.child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  harness.child.stdout?.on("data", (chunk) => { state.output += String(chunk); });
  harness.child.stderr?.on("data", (chunk) => { state.output += String(chunk); });
  harnesses.push(harness);
  await expect.poll(() => harnessReady(harness.base), { timeout: LAUNCH_BUDGET_MS, interval: 500 }).toBe(true);
  return harness;
}

async function stopHarness(harness: Harness): Promise<void> {
  if (harness.child) await waitForExit(harness.child, { signal: "SIGTERM" }).catch(() => {});
  harness.child = null;
  await new Promise<void>((resolve) => harness.provider.close(() => resolve()));
  await removeTempDir(harness.home);
}

afterAll(async () => {
  for (const harness of harnesses) await stopHarness(harness).catch(() => {});
});

const api = async (harness: Harness, method: string, path: string, body?: JsonBody): Promise<Response> => {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`${harness.base}${path}`, init);
};

/** The roster, as the harness reports it. */
const roster = async (harness: Harness) => {
  const res = await api(harness, "GET", "/api/bots?messages=0");
  return z.object({ bots: z.array(botSchema) }).parse(await res.json()).bots;
};

// Windows has no POSIX signals:  `process.kill(pid, "SIGTERM")` there is
// TerminateProcess, so the harness's own signal handler never runs and the
// drain that follows the stop never happens.  The shutdown path under test
// only exists where signals do.
describe.skipIf(process.platform === "win32")("the graceful stop, through the route", () => {
  it("stops the working bot and shuts the server down as soon as the bot is done", async () => {
    const harness = await startHarness();
    const created = await api(harness, "POST", "/api/bots", {
      modelSelection: { instanceId: "fixture", model: "fixture-model" },
    });
    expect(created.status, harness.state.output).toBe(201);
    const bot = z.object({ bot: botSchema }).parse(await created.json()).bot;
    expect((await api(harness, "POST", `/api/bots/${bot.id}/messages`, { text: "keep working" })).status).toBe(202);
    // The bot is working:  its turn is in flight and the provider is holding
    // the answer open.
    await expect
      .poll(async () => (await roster(harness)).find((entry) => entry.id === bot.id)?.inflightThreadId, {
        timeout: 90_000,
        interval: 100,
      })
      .toBe(bot.threadId);

    // The stop.  The server goes down while it answers, so the reply may never
    // arrive:  what matters is what the harness logged and when.
    const startedAt = Date.now();
    void api(harness, "POST", "/api/system/control/stop", {}).catch(() => {});
    let stoppedAt = 0;
    await expect
      .poll(() => {
        if (!stoppedAt && harness.state.output.includes("[graceful-shutdown]")) stoppedAt = Date.now();
        return stoppedAt > 0;
      }, { timeout: 60_000, interval: 50 })
      .toBe(true);
    const elapsed = stoppedAt - startedAt;

    // (a) The stop ends when the bot is done, not when the window closes.
    //     The stop's own control lock used to be counted as work in flight,
    //     so the count the wait watched could never reach zero and every
    //     stop waited out the whole window.
    console.log(`[graceful-stop-e2e] the stop took ${elapsed}ms, the window is ${STOP_WINDOW_MS}ms`);
    expect(elapsed, harness.state.output).toBeLessThan(STOP_WINDOW_MS - 2_000);

    // (b) The report names the bot, and it does not name the stop's own
    //     control lock as work left running:  that lock is the stop's own
    //     reservation, and counting it is what made every stop wait out the
    //     whole window.
    const stopLine = harness.state.output.split("\n").find((line) => line.includes("[graceful-shutdown]")) ?? "";
    expect(stopLine, harness.state.output).toMatch(/1 bot had already finished|1 bot was stopped/);
    expect(stopLine, harness.state.output).not.toContain("Local VM change");

    // (c) The server really went down:  the route's shutdown reaches the
    //     harness's own signal handler, and the process exits.
    await waitForExit(harness.child ?? undefined, { graceMs: 30_000 });
    expect(harness.child?.exitCode ?? harness.child?.signalCode, harness.state.output).not.toBeNull();
  }, 600_000);

  it("keeps the queued messages when the stop refuses, and runs them", async () => {
    // The park could not save the work:  the carrier is a file, and a
    // directory in its place makes every write of it fail.  The queues were
    // drained before that write, so the work that could not be saved is
    // neither on disk nor in memory unless it is put back.  A stop that
    // refuses has to leave the server doing what it was doing.
    const harness = await startHarness();
    const created = await api(harness, "POST", "/api/bots", {
      modelSelection: { instanceId: "fixture", model: "fixture-model" },
    });
    expect(created.status, harness.state.output).toBe(201);
    const bot = z.object({ bot: botSchema }).parse(await created.json()).bot;
    expect((await api(harness, "POST", `/api/bots/${bot.id}/messages`, { text: "first" })).status).toBe(202);
    await expect
      .poll(async () => (await roster(harness)).find((entry) => entry.id === bot.id)?.inflightThreadId, {
        timeout: 90_000,
        interval: 100,
      })
      .toBe(bot.threadId);
    // A second message waits behind the busy bot, so the stop has work to
    // carry across the restart.
    expect((await api(harness, "POST", `/api/bots/${bot.id}/messages`, { text: "second" })).status).toBe(202);

    // The carrier cannot be written:  a directory where the file belongs
    // makes the rename that publishes it fail.
    mkdirSync(join(harness.dataDir, HELD_SENDS_FILE), { recursive: true });

    const refused = await api(harness, "POST", "/api/system/control/stop", {});
    expect(refused.status, harness.state.output).toBe(409);
    const body = z.object({ ok: z.boolean(), error: z.string() }).parse(await refused.json());
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/could not be saved/);

    // The server stays up and keeps serving.
    expect((await api(harness, "GET", "/api/health")).status).toBe(200);

    // The message that was waiting behind the bot runs:  the provider is
    // asked twice, once for the first turn and once for the message the
    // refusal put back.
    await expect.poll(() => harness.state.requests, { timeout: 60_000, interval: 250 }).toBe(2);
  }, 600_000);
});
