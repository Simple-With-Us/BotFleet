// The launcher contract, end to end against the real server.
//
// The unit tests pin each driver's spawn (server/drivers/*.test.ts) and the
// helper (launch-identity.test.ts).  This proves the harness hands the
// identity to every lane that starts an engine child: a 1:1 chat and a room
// turn, for a bot named for a role, a bot named for none, and two bots that
// share one engine instance.  The server is started from a shell that holds
// a seat, a Claude Code session and a Zulip login, and none of them may
// reach the child.
//
// The engine is the fake ACP CLI, which writes its environment to
// FAKE_ACP_DUMP when it starts.
import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { harnessReady } from "./testing/harness-ready.ts";
import { expectLaunchedAs, INHERITED_IDENTITY_ENV, readEngineDump } from "./testing/launch-identity.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 28800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

let child: ChildProcess;
let home: string;
let dump: string;
let stderr = "";

/** The request bodies this file sends. */
interface ApiBody {
  name?: string;
  computers?: never[];
  modelSelection?: { instanceId: string; model: string };
  memberIds?: string[];
  setup?: { bulletin: string; defaultResponder: { kind: "everyone" } };
  text?: string;
}

const api = async (method: string, path: string, body?: ApiBody): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

async function waitFor<T>(probe: () => T | null | undefined | false, ms = 30_000): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function makeBot(patch: { name: string }) {
  const created = await api("POST", "/api/bots");
  expect(created.status).toBe(201);
  const patched = await api("PATCH", `/api/bots/${created.body.bot.id}`, {
    computers: [],
    ...patch,
    modelSelection: { instanceId: "acp", model: "fake-model" },
  });
  expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  const bot: { id: string; threadId: string } = patched.body.bot;
  return bot;
}

/** The environment the engine child had, once it started for `session`. */
const childEnvFor = (session: string) =>
  waitFor(() => {
    if (!existsSync(dump)) return null;
    try {
      const { env } = readEngineDump(dump);
      return env.AGENT_SESSION === session ? env : null;
    } catch {
      return null; // caught mid-write
    }
  });

posixOnly("engine children carry the identity BotFleet gives their bot", () => {
  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-launch-identity-e2e-"));
    dump = join(home, "engine-env.json");
    mkdirSync(join(home, ".botfleet"), { recursive: true });
    writeFileSync(
      join(home, ".botfleet", "config.json"),
      JSON.stringify({
        instances: {
          // one instance for every bot: the seat cannot come from the instance
          acp: { driver: "grokAgent", environment: { FAKE_ACP_DUMP: dump }, config: { cli: FAKE_CLI, fullAuto: false } },
        },
      }),
    );
    const env = {
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      PATH: process.env.PATH ?? "",
      // the operator fleet is on, so role bots get their seats
      BOTFLEET_FLEET_SEAT_PROMPTS: "1",
      // what a harness started from a seat's shell would hold
      ...INHERITED_IDENTITY_ENV,
    };
    child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
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

  it("a 1:1 chat with a bot named for a role runs its engine as that role's seat", async () => {
    const plumber = await makeBot({ name: "Plumber" });
    expect((await api("POST", `/api/bots/${plumber.id}/messages`, { text: "go" })).status).toBe(202);
    const env = await childEnvFor(plumber.threadId);
    expect(env, `no engine child. stderr:\n${stderr.slice(-2000)}`).not.toBeNull();
    expectLaunchedAs(env!, { seat: "BF-PLUMBER", session: plumber.threadId });
  }, 60_000);

  it("another bot on the same engine instance gets its own seat, not the first bot's", async () => {
    const oracle = await makeBot({ name: "BF-Oracle" });
    expect((await api("POST", `/api/bots/${oracle.id}/messages`, { text: "go" })).status).toBe(202);
    const env = await childEnvFor(oracle.threadId);
    expect(env).not.toBeNull();
    expectLaunchedAs(env!, { seat: "BF-ORACLE", session: oracle.threadId });
  }, 60_000);

  it("a bot named for no role is marked as launched and has no seat", async () => {
    const kiwi = await makeBot({ name: "Kiwi" });
    expect((await api("POST", `/api/bots/${kiwi.id}/messages`, { text: "go" })).status).toBe(202);
    const env = await childEnvFor(kiwi.threadId);
    expect(env).not.toBeNull();
    expectLaunchedAs(env!, { seat: null, session: kiwi.threadId });
  }, 60_000);

  it("a room turn runs the member's engine as the member's seat", async () => {
    const fixer = await makeBot({ name: "Fixer" });
    const created = await api("POST", "/api/groups", {
      name: "Seat room",
      memberIds: [fixer.id],
      setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
    });
    expect(created.status).toBe(201);
    const room: { id: string; threadId: string } = created.body.group;
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "go @everyone" })).status).toBe(202);
    const env = await childEnvFor(room.threadId);
    expect(env, `no engine child. stderr:\n${stderr.slice(-2000)}`).not.toBeNull();
    expectLaunchedAs(env!, { seat: "BF-FIXER", session: room.threadId });
  }, 60_000);
});
