// A queued send must survive a crash.  The steer queue lives in memory, so a
// send accepted while the bot is busy is journaled (steer-queue-journal.json)
// and put back at the next boot (BF-2442: queue is now the default busy mode).
import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { harnessReady } from "./testing/harness-ready.ts";
import { STEER_JOURNAL_FILE } from "./update-drain.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 29800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

describe("steer-queue crash journal e2e", () => {
  let child: ChildProcess | null = null;
  let home = "";
  let stderr = "";

  const api = async (method: string, path: string, body?: Record<string, unknown>): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const botById = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const until = async (probe: () => Promise<boolean>, what: string, timeoutMs = 40_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        if (await probe()) return;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`${what} never happened. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  const start = async () => {
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(PORT) };
    if (process.env.PATH) env.PATH = process.env.PATH;
    child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    await until(() => harnessReady(BASE), "the server to come up", 30_000);
  };

  afterAll(async () => {
    if (child && child.exitCode === null) await waitForExit(child, { signal: "SIGTERM" });
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it(
    "puts a queued send back after the server is killed before it drained",
    async () => {
      chmodSync(FAKE_CLI, 0o755);
      home = mkdtempSync(join(tmpdir(), "omb-steer-crash-"));
      mkdirSync(join(home, ".botfleet"), { recursive: true });
      mkdirSync(join(home, "gates"), { recursive: true });
      const gate = join(home, "gates", "drain.gate");
      writeFileSync(
        join(home, ".botfleet", "config.json"),
        JSON.stringify({
          instances: {
            steer: {
              driver: "grokAgent",
              environment: { FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: gate },
              config: { cli: FAKE_CLI, fullAuto: true },
            },
          },
        }),
      );
      await start();

      const bot = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${bot.id}`, { name: "Crashy", modelSelection: { instanceId: "steer", model: "fake-model" } });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "long job" })).status).toBe(202);
      expect((await botById(bot.id)).busy).toBe(true);
      const queued = await api("POST", `/api/bots/${bot.id}/messages`, { text: "survive the crash" });
      expect(queued.body).toMatchObject({ ok: true, queued: true });

      // accepted means journaled: the words are on disk before the 202 matters
      const journal = join(home, ".botfleet", STEER_JOURNAL_FILE);
      expect(existsSync(journal)).toBe(true);

      // kill -9: no shutdown hook, no update carrier
      const dying = child!;
      try {
        process.kill(-dying.pid!, "SIGKILL");
      } catch {
        dying.kill("SIGKILL");
      }
      await new Promise((r) => dying.once("exit", r));
      child = null;
      expect(existsSync(journal)).toBe(true);

      writeFileSync(gate, "open");
      await start();
      await until(async () => {
        const snapshot = await botById(bot.id);
        return Boolean(snapshot) && snapshot.messages.some((m: any) => m.role === "user" && m.text === "survive the crash");
      }, "the queued send to come back");
      await until(async () => {
        const snapshot = await botById(bot.id);
        return snapshot.messages.some((m: any) => m.role === "bot" && m.kind === "text" && String(m.text).includes("survive the crash"));
      }, "the restored send to run");

      // exactly one copy, and the journal has been emptied by the drain
      const final = await botById(bot.id);
      expect(final.messages.filter((m: any) => m.role === "user" && m.text === "survive the crash")).toHaveLength(1);
      await until(async () => !existsSync(journal), "the journal to empty");
    },
    120_000,
  );
});
