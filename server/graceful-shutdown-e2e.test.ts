// The graceful stop, end to end.
//
// The module's own tests inject the clock, the wait and the counts, and
// server/graceful-stop-route.test.ts pins how the routes are wired to it.
// Neither can answer the question a person actually has when they press Stop:
// does the server go down, and does it go down as soon as the bots are done
// rather than after the whole window?
//
// So this drives the real route against a real harness on a throwaway home,
// with a provider fixture that holds its answer open for a moment.  The bot
// is still working when the stop arrives and it finishes a moment later:  the
// stop has to end when the bot is done.
//
// One harness, one boot.  A harness boot on a loaded machine is minutes, and
// this buys the most from the first one.
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

const home = mkdtempSync(join(tmpdir(), "bf-graceful-stop-"));
const dataDir = join(home, ".botfleet");
let provider: Server;
let child: ChildProcess | null = null;
let base = "";
let harnessPort = 0;
let output = "";
/** When the stop finished, in the harness's own log. */
let stoppedAt = 0;

const api = async (method: string, path: string, body?: JsonBody): Promise<Response> => {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`${base}${path}`, init);
};

/** The roster, as the harness reports it. */
const roster = async () => {
  const res = await api("GET", "/api/bots?messages=0");
  return z.object({ bots: z.array(botSchema) }).parse(await res.json()).bots;
};

async function launch(): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    OMB_PORT: String(harnessPort),
    OMB_WEBHOOK_PORT: String(harnessPort + 1),
    OMB_DISABLE_ANTIGRAVITY_QUOTA: "1",
  };
  if (process.env.PATH) env.PATH = process.env.PATH;
  child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  await expect.poll(() => harnessReady(base), { timeout: LAUNCH_BUDGET_MS, interval: 500 }).toBe(true);
}

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" }).catch(() => {});
  child = null;
  await new Promise<void>((resolve) => provider?.close(() => resolve()));
  await removeTempDir(home);
});

// Windows has no POSIX signals:  `process.kill(pid, "SIGTERM")` there is
// TerminateProcess, so the harness's own signal handler never runs and the
// drain that follows the stop never happens.  The shutdown path under test
// only exists where signals do.
describe.skipIf(process.platform === "win32")("the graceful stop, through the route", () => {
  it("stops the working bot and shuts the server down as soon as the bot is done", async () => {
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
      // The answer is held open, so the bot is still working when the stop
      // arrives and it finishes a moment later.
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end('data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n');
      }, PROVIDER_HOLD_MS);
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    // SAFETY: the fixture provider is listening on the loopback address above, so its address is a bound socket.
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

    const created = await api("POST", "/api/bots", {
      modelSelection: { instanceId: "fixture", model: "fixture-model" },
    });
    expect(created.status, output).toBe(201);
    const bot = z.object({ bot: botSchema }).parse(await created.json()).bot;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "keep working" })).status).toBe(202);
    // The bot is working:  its turn is in flight and the provider is holding
    // the answer open.
    await expect
      .poll(async () => (await roster()).find((entry) => entry.id === bot.id)?.inflightThreadId, {
        timeout: 90_000,
        interval: 100,
      })
      .toBe(bot.threadId);

    // The stop.  The server goes down while it answers, so the reply may never
    // arrive:  what matters is what the harness logged and when.
    const startedAt = Date.now();
    void api("POST", "/api/system/control/stop", {}).catch(() => {});
    await expect
      .poll(() => {
        if (!stoppedAt && output.includes("[graceful-shutdown]")) stoppedAt = Date.now();
        return stoppedAt > 0;
      }, { timeout: 60_000, interval: 50 })
      .toBe(true);
    const elapsed = stoppedAt - startedAt;

    // (a) The stop ends when the bot is done, not when the window closes.
    //     The stop's own control lock used to be counted as work in flight,
    //     so the count the wait watched could never reach zero and every
    //     stop waited out the whole window.
    console.log(`[graceful-stop-e2e] the stop took ${elapsed}ms, the window is ${STOP_WINDOW_MS}ms`);
    expect(elapsed, output).toBeLessThan(STOP_WINDOW_MS - 2_000);

    // (b) The report names the bot, and it does not name the stop's own
    //     control lock as work left running:  that lock is the stop's own
    //     reservation, and counting it is what made every stop wait out the
    //     whole window.
    const stopLine = output.split("\n").find((line) => line.includes("[graceful-shutdown]")) ?? "";
    expect(stopLine, output).toMatch(/1 bot had already finished|1 bot was stopped/);
    expect(stopLine, output).not.toContain("Local VM change");

    // (c) The server really went down:  the route's shutdown reaches the
    //     harness's own signal handler, and the process exits.
    await waitForExit(child ?? undefined, { graceMs: 30_000 });
    expect(child?.exitCode ?? child?.signalCode, output).not.toBeNull();
  }, 600_000);
});
