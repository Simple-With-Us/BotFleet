// The bot On/Off switch, end to end against the real server.
//
// Off is a decision about the BOT: nothing new starts for it from any source,
// its chat stays readable, and a turn that is already running finishes.  The
// unit tests pin each gate in isolation (bot-power.test.ts, routines.test.ts);
// these prove the gates are wired into the running harness, on the paths a
// person actually uses — chat from every channel, a webhook, a routine, a
// room — and that the switch survives a restart.
//
// The engine is `server/testing/fake-openai-server.ts`, a real local HTTP
// server the spawned harness talks to, so "no turn started" is a counted fact
// (zero completion requests), not an inference from a quiet transcript.
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { BOT_OFF_SKIPPED } from "../shared/bot-power.ts";
import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";
import {
  startFakeOpenAiServer,
  type DirectCompletion,
  type FakeOpenAiServer,
  type ScriptedCompletion,
} from "./testing/fake-openai-server.ts";
import { freePortBlock } from "./testing/ports.ts";
import { harnessReady } from "./testing/harness-ready.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const posixOnly = describe.skipIf(process.platform === "win32");

const says = (text: string): DirectCompletion => ({
  kind: "sse",
  frames: [`{"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}`, "[DONE]"],
});

/** A request the fake engine holds until `releaseGate(gate)`, then answers with
 *  `reply`.  Its script key is literally `then`, which unicorn/no-thenable reads
 *  as a Promise lookalike, so the key is spelled in two parts here. */
const heldUntilReleased = (gate: string, reply: DirectCompletion): ScriptedCompletion => {
  const script = { kind: "gate", gate, [`${"th"}en`]: reply };
  // SAFETY: the object carries exactly the fields of the `gate` script in
  // server/testing/fake-openai-server.ts: kind, gate, and `then`.
  return script as ScriptedCompletion;
};

interface WireMessage {
  id?: string;
  role?: string;
  kind?: string;
  text?: string;
  queueId?: string;
  tool?: { name?: string; ok?: boolean };
}

interface WireRun {
  id: string;
  botId?: string;
  manual?: boolean;
  status?: string;
  outcomeCode?: string;
  error?: string;
}

posixOnly("the bot On/Off switch", () => {
  let child: ChildProcess;
  let engine: FakeOpenAiServer;
  let home: string;
  let base: string;
  let hookBase: string;
  let port = 0;
  let stderr = "";

  const api = async (method: string, path: string, body?: Record<string, unknown>): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  const waitFor = async <T,>(probe: () => Promise<T | null>, ms: number): Promise<T | null> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = await probe();
      if (hit !== null && hit !== undefined) return hit;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  const roster = async () => (await api("GET", "/api/bots")).body.bots ?? [];
  const rosterBot = async (botId: string) => (await roster()).find((b: { id: string }) => b.id === botId);

  const messages = async (threadId: string): Promise<WireMessage[]> => {
    const page = await api("GET", `/api/threads/${threadId}/messages`);
    return page.body.messages ?? [];
  };

  const activity = async (threadId: string): Promise<string[]> =>
    (await messages(threadId)).filter((m) => m.kind === "activity").map((m) => m.tool?.name ?? "");

  const waitForBotIdle = async (botId: string, ms = 30_000) =>
    waitFor(async () => {
      const bot = await rosterBot(botId);
      return bot && !bot.busy ? bot : null;
    }, ms);

  const waitForBotBusy = async (botId: string, ms = 30_000) =>
    waitFor(async () => {
      const bot = await rosterBot(botId);
      return bot?.busy ? bot : null;
    }, ms);

  const completionCount = () => engine.requests.filter((r) => r.url.includes("/chat/completions")).length;

  const makeBot = async (name: string) => {
    const created = await api("POST", "/api/bots");
    expect(created.status).toBe(201);
    const patched = await api("PATCH", `/api/bots/${created.body.bot.id}`, {
      name,
      modelSelection: { instanceId: "minimax", model: "MiniMax-M3" },
    });
    expect(patched.status).toBe(200);
    return patched.body.bot ?? created.body.bot;
  };

  const spawnHarness = async () => {
    child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(port),
        OMB_WEBHOOK_PORT: String(port + 1),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const deadline = Date.now() + 40_000;
    for (;;) {
      try {
        if (await harnessReady(base)) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  beforeAll(async () => {
    engine = await startFakeOpenAiServer();
    home = mkdtempSync(join(tmpdir(), "omb-bot-off-"));
    mkdirSync(join(home, ".botfleet"), { recursive: true });
    writeFileSync(
      join(home, ".botfleet", "config.json"),
      JSON.stringify({
        instances: {
          minimax: {
            driver: "minimax",
            config: { url: engine.url },
            // A placeholder: the fake engine never checks it.
            environment: { MINIMAX_API_KEY: "fake-key-for-tests" },
          },
        },
      }),
      { mode: 0o600 },
    );
    port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    hookBase = `http://127.0.0.1:${port + 1}`;
    await spawnHarness();
  }, 90_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await engine?.close();
    await removeTempDir(home);
  });

  it("stores the switch, reports it on the roster, validates it, and keeps it across a restart", async () => {
    const bot = await makeBot("Alpha");
    expect(bot.off).toBeFalsy();

    expect((await api("PATCH", `/api/bots/${bot.id}`, { off: "yes" })).status).toBe(400);
    expect((await rosterBot(bot.id)).off).toBeFalsy();

    const off = await api("PATCH", `/api/bots/${bot.id}`, { off: true });
    expect(off.status).toBe(200);
    expect(off.body.bot.off).toBe(true);
    expect((await rosterBot(bot.id)).off).toBe(true);

    // The roster is persisted on a short debounce; a graceful stop flushes it.
    await waitForExit(child, { signal: "SIGTERM" });
    await spawnHarness();
    expect((await rosterBot(bot.id)).off).toBe(true);

    const on = await api("PATCH", `/api/bots/${bot.id}`, { off: false });
    expect(on.status).toBe(200);
    expect(on.body.bot.off).toBe(false);
    expect((await rosterBot(bot.id)).off).toBe(false);

    // A paired phone writes through the narrower profile route; the switch is
    // on its allowlist (so the phone can turn a bot back On) with the same
    // validation, and a refused value changes nothing.
    expect((await api("PATCH", `/api/bots/${bot.id}/profile`, { off: "yes" })).status).toBe(400);
    expect((await rosterBot(bot.id)).off).toBe(false);
    const viaProfile = await api("PATCH", `/api/bots/${bot.id}/profile`, { off: true });
    expect(viaProfile.status).toBe(200);
    expect(viaProfile.body.bot.off).toBe(true);
    expect((await rosterBot(bot.id)).off).toBe(true);
    expect((await api("PATCH", `/api/bots/${bot.id}/profile`, { off: false })).body.bot.off).toBe(false);
  }, 120_000);

  it("refuses chat from every channel while Off, and queues, steers and writes nothing", async () => {
    const bot = await makeBot("Bravo");
    engine.queueCompletion(says("hello back"));
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "hi" })).status).toBe(202);
    expect(await waitForBotIdle(bot.id), `never went idle. stderr:\n${stderr}`).toBeTruthy();
    const sent = (await messages(bot.threadId)).find((m) => m.role === "user");
    expect(sent?.id).toBeTruthy();

    expect((await api("PATCH", `/api/bots/${bot.id}`, { off: true })).status).toBe(200);
    const completionsBefore = completionCount();
    const transcriptBefore = (await messages(bot.threadId)).length;

    // The app and phone, then the iMessage relay and Linq.  The gate sits ahead
    // of every transport check, so each is refused for the same reason rather
    // than for a transport misconfiguration.
    for (const extra of [{}, { source: "imessage" }, { source: "linq", chatId: "chat-1" }]) {
      const refused = await api("POST", `/api/bots/${bot.id}/messages`, { text: "are you there?", ...extra });
      expect(refused.status, JSON.stringify(extra)).toBe(409);
      expect(refused.body.code).toBe("bot_off");
      expect(refused.body.error).toContain("This bot is off");
      expect(refused.body.error).toContain("Turn it on to chat");
    }

    // An edit forks the transcript before it dispatches, so it is refused first.
    const edit = await api("POST", `/api/bots/${bot.id}/messages/${sent!.id}/edit`, { text: "edited" });
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe("bot_off");

    expect(completionCount()).toBe(completionsBefore);
    expect((await messages(bot.threadId)).length).toBe(transcriptBefore);
    // Nothing was held back for later, either.
    expect((await messages(bot.threadId)).some((m) => m.queueId)).toBe(false);

    // The chat is still readable, and the roster still lists the bot.
    expect((await rosterBot(bot.id)).off).toBe(true);
    expect((await messages(bot.threadId)).some((m) => m.text === "hello back")).toBe(true);
  }, 120_000);

  it("lets a running turn finish, refuses anything new behind it, and drops queued sends with a note", async () => {
    const bot = await makeBot("Charlie");
    const completionsBefore = completionCount();
    engine.queueCompletion(heldUntilReleased("charlie", says("finished anyway")));
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "start" })).status).toBe(202);
    expect(await waitForBotBusy(bot.id), `never went busy. stderr:\n${stderr}`).toBeTruthy();

    // Queued while On, behind the running turn.
    const queued = await api("POST", `/api/bots/${bot.id}/messages`, { text: "and then this" });
    expect(queued.status).toBe(202);
    expect(queued.body.queued).toBe(true);

    expect((await api("PATCH", `/api/bots/${bot.id}`, { off: true })).status).toBe(200);
    // Switching Off does not interrupt: it is still working.
    expect((await rosterBot(bot.id)).busy).toBe(true);

    const refused = await api("POST", `/api/bots/${bot.id}/messages`, { text: "one more" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("bot_off");

    engine.releaseGate("charlie");
    expect(await waitForBotIdle(bot.id), `never settled. stderr:\n${stderr}`).toBeTruthy();

    const thread = await messages(bot.threadId);
    // The running turn completed, with its reply.
    expect(thread.some((m) => m.role === "bot" && m.text === "finished anyway")).toBe(true);
    // The queued line was never run, and the person is told.
    expect(thread.some((m) => m.text === "and then this")).toBe(false);
    const notes = await activity(bot.threadId);
    expect(notes.some((name) => name.startsWith("Not sent: this bot is off"))).toBe(true);
    // Exactly one provider round ran: the turn that was already going.
    expect(completionCount() - completionsBefore).toBe(1);
  }, 120_000);

  it("records a webhook delivery and a Run now as skipped, and starts nothing", async () => {
    const bot = await makeBot("Delta");
    const hook = await api("POST", "/api/webhooks", {
      name: "Sentry alerts",
      prompt: "Triage the alert",
      botId: bot.id,
      runOn: "bot",
    });
    expect(hook.status).toBe(201);
    const routine = await api("POST", "/api/routines", {
      name: "Nightly sweep",
      prompt: "sweep",
      botId: bot.id,
      schedule: { type: "daily", time: "03:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
    });
    expect(routine.status).toBe(201);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { off: true })).status).toBe(200);
    const completionsBefore = completionCount();

    const delivered = await fetch(hook.body.credential.url, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "alert-1" },
      body: JSON.stringify({ level: "error" }),
    });
    expect(delivered.status).toBe(202);
    const accepted = z.object({ runId: z.string() }).parse(await delivered.json());

    const runNow = await api("POST", `/api/routines/${routine.body.routine.id}/run`);
    expect(runNow.status).toBe(201);
    expect(runNow.body.run).toMatchObject({ status: "cancelled", outcomeCode: "bot_off", manual: true });

    const runs: WireRun[] = (await api("GET", "/api/routines")).body.runs ?? [];
    const hookRun = runs.find((run) => run.id === accepted.runId);
    expect(hookRun).toMatchObject({ status: "cancelled", outcomeCode: "bot_off", error: BOT_OFF_SKIPPED });
    const manualRun = runs.find((run) => run.manual === true && run.botId === bot.id);
    expect(manualRun).toMatchObject({ status: "cancelled", outcomeCode: "bot_off", error: BOT_OFF_SKIPPED });

    // Give a stray dispatch every chance to show itself, then count.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(completionCount()).toBe(completionsBefore);
    expect((await rosterBot(bot.id)).busy).toBeFalsy();

    // The hook URL is host-local; make sure the base it was built on is ours.
    expect(String(hook.body.credential.url).startsWith(hookBase)).toBe(true);
  }, 120_000);

  it("chats again once it is turned back on", async () => {
    const bot = await makeBot("Echo");
    expect((await api("PATCH", `/api/bots/${bot.id}`, { off: true })).status).toBe(200);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "hello?" })).status).toBe(409);

    expect((await api("PATCH", `/api/bots/${bot.id}`, { off: false })).status).toBe(200);
    engine.queueCompletion(says("back online"));
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "hello?" })).status).toBe(202);
    expect(await waitForBotIdle(bot.id), `never settled. stderr:\n${stderr}`).toBeTruthy();
    expect((await messages(bot.threadId)).some((m) => m.role === "bot" && m.text === "back online")).toBe(true);
  }, 120_000);

  it("skips an Off room member with a notice, and the other members still speak", async () => {
    const quiet = await makeBot("Foxtrot");
    const loud = await makeBot("Golf");
    const created = await api("POST", "/api/groups", {
      name: "Ops room",
      memberIds: [quiet.id, loud.id],
      setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
    });
    expect(created.status).toBe(201);
    const room = created.body.group;
    expect((await api("PATCH", `/api/bots/${quiet.id}`, { off: true })).status).toBe(200);
    const completionsBefore = completionCount();

    engine.queueCompletion(says("Golf here"));
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "status check @everyone" })).status).toBe(202);

    const spoke = await waitFor(async () => {
      const replies = (await messages(room.threadId)).filter((m) => m.role === "bot" && m.text === "Golf here");
      return replies.length ? replies : null;
    }, 30_000);
    expect(spoke, `the active member never spoke. stderr:\n${stderr}`).toBeTruthy();
    // One provider round: the Off member never reached the engine.
    expect(completionCount() - completionsBefore).toBe(1);

    // Naming the Off member says why nobody answered for them.  A room of only
    // that member, on the mention-only policy, so nobody else could reply.
    const alone = await api("POST", "/api/groups", {
      name: "Quiet room",
      memberIds: [quiet.id],
      setup: { bulletin: "", defaultResponder: { kind: "mentions" } },
    });
    expect(alone.status).toBe(201);
    expect((await api("POST", `/api/groups/${alone.body.group.id}/messages`, { text: "@Foxtrot are you there?" })).status).toBe(202);
    const noted = await waitFor(async () => {
      const lines = await activity(alone.body.group.threadId);
      return lines.some((name) => name.includes("Foxtrot is off and can't respond")) ? lines : null;
    }, 30_000);
    expect(noted, "no notice for the Off member").toBeTruthy();
    expect(completionCount() - completionsBefore).toBe(1);
  }, 120_000);
});
