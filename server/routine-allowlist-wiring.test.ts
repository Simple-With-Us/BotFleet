// A routine's command allowlist, end to end against the real server:  the
// routine API stores it, Run Now dispatches it, the harness hands it to the
// engine, and an engine that cannot be held never gets the turn.
//
// Engines are the scripted fake in server/testing/fake-acp-allowlist-cli.ts,
// which behaves as Grok Build was observed to (a blocking pre-tool hook, the
// client terminal and file calls).  The MiniMax Code instance points at the
// same fake, so a refusal is proved by the fake never starting.
import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { harnessReady } from "./testing/harness-ready.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE = join(SERVER_DIR, "testing", "fake-acp-allowlist-cli.ts");
const PORT = 28800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

let child: ChildProcess;
let home: string;
let tool: string;
let stderr = "";

/** The request bodies this file sends. */
interface ApiBody {
  name?: string;
  prompt?: string;
  botId?: string;
  computers?: never[];
  modelSelection?: { instanceId: string; model: string };
  schedule?: { type: "once"; at: number };
  toolPolicy?: ReturnType<typeof policy> | { mode: string; commands: Array<{ argv0: string }> };
}

const api = async (method: string, path: string, body?: ApiBody): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

async function waitFor<T>(probe: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 30_000): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function makeBot(name: string, instanceId: string) {
  const created = await api("POST", "/api/bots");
  expect(created.status).toBe(201);
  const patched = await api("PATCH", `/api/bots/${created.body.bot.id}`, {
    computers: [],
    name,
    modelSelection: { instanceId, model: "fake-model" },
  });
  expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  const bot: { id: string; threadId: string } = patched.body.bot;
  return bot;
}

function policy() {
  return {
    mode: "allowlist",
    commands: [{ argv0: tool, sub: ["whoami"], flags: { "--json": { value: "none" } } }],
    writePaths: [join(home, "state", "line.md")],
  };
}

async function runOf(routineId: string) {
  return waitFor(async () => {
    const listed = await api("GET", "/api/routines");
    const runs: Array<{ routineId: string; status: string; error?: string; denials?: string[] }> = listed.body.runs;
    const run = runs.find((r) => r.routineId === routineId);
    return run && ["completed", "failed", "cancelled"].includes(run.status) ? run : null;
  });
}

posixOnly("a routine with a command allowlist", () => {
  beforeAll(async () => {
    chmodSync(FAKE, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-routine-allowlist-e2e-"));
    tool = join(home, "fake-agent-sync");
    writeFileSync(tool, `#!/bin/sh\necho "ran:$*:seat=$AGENT_LAUNCH_SEAT"\ntouch "${join(home, "TOOL-RAN")}"\n`);
    chmodSync(tool, 0o755);
    const grokHome = join(home, "grok-home");
    mkdirSync(grokHome, { recursive: true });
    writeFileSync(join(grokHome, "auth.json"), "{}");
    const steps = [
      { type: "shell", command: `${tool} whoami --json` },
      { type: "shell", command: `${tool} whoami --json; touch ${join(home, "PWNED")}` },
      { type: "shell", command: "touch PWNED" },
      { type: "mcp", name: "COMPOSIO_SEARCH_TOOLS" },
    ];
    mkdirSync(join(home, ".botfleet"), { recursive: true });
    writeFileSync(
      join(home, ".botfleet", "config.json"),
      JSON.stringify({
        instances: {
          grokal: {
            driver: "grokAgent",
            environment: { FAKE_AL_DUMP: join(home, "grok.json"), FAKE_AL_STEPS: JSON.stringify(steps), GROK_HOME: grokHome },
            config: { cli: FAKE, fullAuto: true },
          },
          mcal: {
            driver: "mcodeAgent",
            environment: { FAKE_AL_DUMP: join(home, "mcode.json"), FAKE_AL_STEPS: JSON.stringify(steps) },
            config: { cli: FAKE, fullAuto: true },
          },
        },
      }),
    );
    child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { HOME: home, USERPROFILE: home, OMB_PORT: String(PORT), PATH: process.env.PATH ?? "", BOTFLEET_FLEET_SEAT_PROMPTS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if (await harnessReady(BASE)) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("refuses an invalid allowlist at the API", async () => {
    const bot = await makeBot("Builder", "grokal");
    const bad = await api("POST", "/api/routines", {
      name: "Bad",
      prompt: "x",
      botId: bot.id,
      schedule: { type: "once", at: Date.now() + 86_400_000 },
      toolPolicy: { mode: "allowlist", commands: [{ argv0: "touch" }] },
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(bad.body)).toMatch(/Command allowlist/);
  }, 60_000);

  it("runs on Grok held to the allowlist:  the listed command runs as the bot's seat, the rest are refused", async () => {
    const bot = await makeBot("Housekeeper", "grokal");
    const created = await api("POST", "/api/routines", {
      name: "Whoami",
      prompt: "Run the whoami check.",
      botId: bot.id,
      schedule: { type: "once", at: Date.now() + 86_400_000 },
      toolPolicy: policy(),
    });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const routine = created.body.routine ?? created.body;
    expect(routine.toolPolicy?.mode).toBe("allowlist");
    expect((await api("POST", `/api/routines/${routine.id}/run`)).status).toBe(201);
    const run = await runOf(routine.id);
    if (!run) throw new Error(`no settled run. stderr:\n${stderr.slice(-2000)}`);
    const seen = JSON.parse(readFileSync(join(home, "grok.json"), "utf8"));
    expect(seen.argv).not.toContain("bypassPermissions");
    expect(seen.argv).toContain("--no-leader");
    expect(seen.clientCapabilities?.terminal).toBe(true);
    expect(seen.mcpServers).toEqual([]);
    expect(seen.results.map((r: any) => r.hook)).toEqual(["allow", "deny", "deny", "deny"]);
    expect(seen.results[0].output).toBe("ran:whoami --json:seat=BF-HOUSEKEEPER\n");
    expect(existsSync(join(home, "PWNED"))).toBe(false);
    expect(run.denials).toEqual(["allowlist: fake-agent-sync", "allowlist: touch", "allowlist: COMPOSIO_SEARCH_TOOLS"]);
  }, 90_000);

  it("is refused on MiniMax Code, which cannot be held, and the engine never starts", async () => {
    const bot = await makeBot("Plumber", "mcal");
    const created = await api("POST", "/api/routines", {
      name: "Whoami on mcode",
      prompt: "Run the whoami check.",
      botId: bot.id,
      schedule: { type: "once", at: Date.now() + 86_400_000 },
      toolPolicy: policy(),
    });
    const routine = created.body.routine ?? created.body;
    expect((await api("POST", `/api/routines/${routine.id}/run`)).status).toBe(201);
    const run = await runOf(routine.id);
    if (!run) throw new Error(`no settled run. stderr:\n${stderr.slice(-2000)}`);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/cannot be held/);
    // The fake writes its dump on any start, a `--version` probe included, so
    // "never started a turn" is:  no ACP handshake and no step run.
    const seen = existsSync(join(home, "mcode.json")) ? JSON.parse(readFileSync(join(home, "mcode.json"), "utf8")) : { results: [] };
    expect(seen.clientCapabilities).toBeUndefined();
    expect(seen.results).toEqual([]);
    expect(existsSync(join(home, "TOOL-RAN-MCODE"))).toBe(false);
  }, 90_000);
});
