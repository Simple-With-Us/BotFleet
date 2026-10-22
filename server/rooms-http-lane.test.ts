// Room turns on the HTTP lane, end to end against the real server.
//
// A room used to be the one place a driver-loop bot was dispatched BARE:
// `runGroupMemberTurn` called `adapter.sendTurn` with no catalog and no
// host, while the room prompt it assembled from the same registry went on
// naming `list_bots` and `ask_bot`.  The bot was told about tools that had
// no executor behind them, and every round it spent reaching for one was
// spent for nothing.
//
// Rooms land last in this series because they are the one place a new hang
// could hide: a room turn carries its own busy gate, round queue,
// `RoomTurnDeadline`, stall registration and speaker state, and the waiter
// finishes on the FIRST `turn.completed` it sees.  That is exactly why the
// driver-owned loop had to come first — inner rounds are no longer terminal
// events, so the waiter needs no new guard at all.  These tests are the
// proof of that claim, so most of them are counting assertions: how many
// provider rounds ran, how many replies were folded, how many times the
// speaker was released.
//
// The engine is `server/testing/fake-openai-server.ts` — a real HTTP server
// the spawned harness talks to over the loopback, scripted round by round.
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { startFakeOpenAiServer, type FakeOpenAiServer } from "./testing/fake-openai-server.ts";
import { freePortBlock } from "./testing/ports.ts";
import { harnessReady } from "./testing/harness-ready.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const posixOnly = describe.skipIf(process.platform === "win32");

/** The configured room ceiling for this harness, in minutes.  One is the
 *  schema's floor, and the timeout test has to outlive it. */
const ROOM_TIMEOUT_MINUTES = 1;
const ROOM_TIMEOUT_MS = ROOM_TIMEOUT_MINUTES * 60_000;

/** One round that calls a read tool — no approval record, so it runs
 *  without a card and the turn continues into the next round. */
const calls = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  kind: "sse" as const,
  frames: [
    `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":${JSON.stringify(id)},"function":{"name":${JSON.stringify(
      name,
    )},"arguments":${JSON.stringify(JSON.stringify(args))}}}]}}]}`,
    '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
    "[DONE]",
  ],
});

/** One round that asks for `ask_bot` — the registry's only write tool
 *  today, and so the only one carrying an `approval` record. */
const asksToDelegate = (task: string) => ({
  kind: "sse" as const,
  frames: [
    `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_ask","function":{"name":"ask_bot","arguments":${JSON.stringify(
      JSON.stringify({ bot_id: "@scout", task }),
    )}}}]}}]}`,
    "[DONE]",
  ],
});

const says = (text: string) => ({
  kind: "sse" as const,
  frames: [`{"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}`, "[DONE]"],
});

interface WireMessage {
  role?: string;
  kind?: string;
  text?: string;
  card?: { requestId?: string; tool?: string; answered?: string };
  tool?: { name?: string; ok?: boolean };
}

posixOnly("room turns run on the HTTP lane", () => {
  let child: ChildProcess;
  let engine: FakeOpenAiServer;
  let home: string;
  let base: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
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

  const messages = async (threadId: string): Promise<WireMessage[]> =>
    ((await api("GET", `/api/threads/${threadId}/messages`)).body.messages ?? []) as WireMessage[];

  /** Bot replies only: the folded assistant text, not the tool and error
   *  rows the same thread carries. */
  const replies = async (threadId: string): Promise<string[]> =>
    (await messages(threadId))
      .filter((m) => m.role === "bot" && m.kind !== "activity" && typeof m.text === "string" && m.text.trim())
      .map((m) => m.text!.trim());

  const activity = async (threadId: string): Promise<string[]> =>
    (await messages(threadId)).filter((m) => m.kind === "activity").map((m) => m.tool?.name ?? "");

  const groupState = async (groupId: string): Promise<any> =>
    ((await api("GET", "/api/bots")).body.groups ?? []).find((g: { id: string }) => g.id === groupId);

  /** The room has no speaker and nothing in flight — the state every exit
   *  is supposed to land in, however it exited. */
  const waitForRoomIdle = async (groupId: string, ms = 30_000) =>
    waitFor(async () => {
      const group = await groupState(groupId);
      return group && !group.busyBotId && !group.working ? group : null;
    }, ms);

  const waitForBotIdle = async (botId: string, ms = 30_000) =>
    waitFor(async () => {
      const bot = ((await api("GET", "/api/bots")).body.bots ?? []).find((b: { id: string }) => b.id === botId);
      return bot && !bot.busy ? bot : null;
    }, ms);

  const completionCount = () => engine.requests.filter((r) => r.url.includes("/chat/completions")).length;

  const makeBot = async (name: string, patch: Record<string, unknown> = {}, instanceId = "minimax") => {
    const created = await api("POST", "/api/bots");
    expect(created.status).toBe(201);
    const patched = await api("PATCH", `/api/bots/${created.body.bot.id}`, {
      name,
      ...patch,
      modelSelection: { instanceId, model: "MiniMax-M3" },
    });
    expect(patched.status).toBe(200);
    return patched.body.bot ?? created.body.bot;
  };

  const makeRoom = async (name: string, memberIds: string[], responder: Record<string, unknown>) => {
    const created = await api("POST", "/api/groups", {
      name,
      memberIds,
      setup: { bulletin: "", defaultResponder: responder },
    });
    expect(created.status).toBe(201);
    return created.body.group;
  };

  /** Read the harness's own event stream and keep every `group` frame for
   *  one room.  `busyBotId` rides along on each frame, so the claim and the
   *  release are directly countable rather than inferred from a final
   *  state that a double-release would look identical in. */
  const watchRoom = async (groupId: string) => {
    const controller = new AbortController();
    const busy: Array<string | null> = [];
    const res = await fetch(`${base}/api/events`, { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let split = buffer.indexOf("\n\n");
          while (split !== -1) {
            const chunk = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            for (const line of chunk.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              try {
                const payload = JSON.parse(line.slice(6));
                if (payload.kind === "group" && payload.group?.id === groupId) {
                  busy.push(payload.group.busyBotId ?? null);
                }
              } catch {
                // a keepalive or a frame we do not care about
              }
            }
            split = buffer.indexOf("\n\n");
          }
        }
      } catch {
        // the abort below is the normal way this ends
      }
    })();
    return {
      /** How many times the room went from THIS speaker back to nobody. */
      releases: (botId: string) => {
        let last: string | null = null;
        let count = 0;
        for (const value of busy) {
          if (last === botId && value === null) count += 1;
          last = value;
        }
        return count;
      },
      claims: (botId: string) => {
        let last: string | null = null;
        let count = 0;
        for (const value of busy) {
          if (last !== botId && value === botId) count += 1;
          last = value;
        }
        return count;
      },
      stop: () => controller.abort(),
    };
  };

  beforeAll(async () => {
    engine = await startFakeOpenAiServer();
    home = mkdtempSync(join(tmpdir(), "omb-rooms-http-lane-"));
    mkdirSync(join(home, ".botfleet"), { recursive: true });
    writeFileSync(
      join(home, ".botfleet", "config.json"),
      JSON.stringify({
        // The schema's floor.  A room turn that has to outlive its own
        // ceiling still costs a minute of wall clock, so the two slow tests
        // below are the price of proving the deadline is real.
        rooms: { turnTimeoutMinutes: ROOM_TIMEOUT_MINUTES },
        instances: {
          minimax: {
            driver: "minimax",
            // `config.url` wins over MINIMAX_BASE_URL, and the fake server's
            // url already carries the /v1 the driver would append.
            config: { url: engine.url },
            // A placeholder: the fake engine never checks it, and this must
            // never be a real credential.
            environment: { MINIMAX_API_KEY: "fake-key-for-tests" },
          },
          // No key at all: `sendTurn` throws synchronously, which is the
          // only way to reach the room's `dispatch_failed` branch without
          // reaching the provider first.
          "minimax-nokey": {
            driver: "minimax",
            config: { url: engine.url },
          },
          "openai-compat": {
            driver: "openai-compat",
            config: { url: engine.url },
            environment: { OPENAI_COMPAT_API_KEY: "fake-key-for-tests" },
          },

        },
      }),
      { mode: 0o600 },
    );
    const port = await freePortBlock([0]);
    base = `http://127.0.0.1:${port}`;
    child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if (await harnessReady(base)) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 60_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await engine?.close();
    await removeTempDir(home);
  });

  it.each(["minimax", "openai-compat"])(
    "%s hands a room member the same catalog a 1:1 turn gets, and settles once with the reply folded in",
    async (instanceId) => {
      await makeBot("scout");
      const member = await makeBot(`pixel-${instanceId}`, {}, instanceId);
      const room = await makeRoom("Ops", [member.id], { kind: "member", botId: member.id });
      const before = completionCount();

      engine.queueCompletion(calls("call_list", "list_bots"));
      engine.queueCompletion(says("Scout is free right now."));
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "who is around?" })).status).toBe(202);

      expect(await waitForBotIdle(member.id), `the member never went idle. stderr:\n${stderr}`).toBeTruthy();
      expect(await waitForRoomIdle(room.id), "the room kept its speaker").toBeTruthy();

      // Two provider rounds: the tool call, then the answer.  A bare
      // dispatch could only ever have produced one.
      expect(completionCount() - before).toBe(2);
      const rounds = engine.requests.filter((r) => r.url.includes("/chat/completions")).slice(before);
      const offered = ((rounds[0].body as { tools?: Array<{ function?: { name?: string } }> }).tools ?? []).map(
        (t) => t.function?.name,
      );
      // The catalog the room prompt already named — the whole point of the
      // change.  It is the SAME `buildTurnTools(integrations)` the 1:1 path
      // builds, so the two surfaces cannot drift apart again.
      expect(offered).toContain("list_bots");
      expect(offered).toContain("ask_bot");

      // and the host actually ran it: the peer roster came back into round 2
      const fed = (rounds[1].body as { messages?: Array<{ role: string; content: string }> }).messages?.find(
        (m) => m.role === "tool",
      );
      expect(String(fed?.content)).toContain("scout");

      // one reply, folded once
      expect(await replies(room.threadId)).toEqual(["Scout is free right now."]);
    },
    120_000,
  );

  it(
    "does not settle a two-round room tool turn early",
    async () => {
      await makeBot("relay");
      const member = await makeBot("atlas");
      const room = await makeRoom("Planning", [member.id], { kind: "member", botId: member.id });
      const before = completionCount();

      engine.queueCompletion(calls("call_a", "list_bots"));
      engine.queueCompletion(calls("call_b", "list_routines"));
      engine.queueCompletion(says("Nothing scheduled, and Relay is free."));
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "status?" })).status).toBe(202);

      expect(await waitForBotIdle(member.id), `the member never went idle. stderr:\n${stderr}`).toBeTruthy();
      expect(await waitForRoomIdle(room.id)).toBeTruthy();

      // Three rounds under ONE room turn.  Before the driver-owned loop the
      // waiter would have finished on round one's terminal event and this
      // reply would never have been folded at all.
      expect(completionCount() - before).toBe(3);
      expect(await replies(room.threadId)).toEqual(["Nothing scheduled, and Relay is free."]);
    },
    120_000,
  );

  it(
    "releases the speaker and clears busyBotId exactly once",
    async () => {
      await makeBot("ember");
      const member = await makeBot("quill");
      const room = await makeRoom("Design", [member.id], { kind: "member", botId: member.id });
      const watcher = await watchRoom(room.id);
      try {
        engine.queueCompletion(calls("call_once", "list_bots"));
        engine.queueCompletion(says("Ember is around."));
        expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "hello" })).status).toBe(202);

        expect(await waitForBotIdle(member.id), `the member never went idle. stderr:\n${stderr}`).toBeTruthy();
        expect(await waitForRoomIdle(room.id)).toBeTruthy();
        // Let any duplicate frame the fallback cleanup would emit arrive
        // before counting — a second release is the failure this guards.
        await new Promise((r) => setTimeout(r, 750));

        expect(watcher.claims(member.id)).toBe(1);
        expect(watcher.releases(member.id)).toBe(1);
      } finally {
        watcher.stop();
      }
    },
    120_000,
  );

  it(
    "keeps the room usable when a dispatch is rejected outright",
    async () => {
      // No key, so `sendTurn` throws before a provider round exists: the
      // room's `dispatch_failed` branch, where drainQueuedSends /
      // drainRoomQueue / drainConnectorResumes / drainSecretResumes are the
      // only thing that stops the next member being stranded behind it.
      const broken = await makeBot("cinder", {}, "minimax-nokey");
      const healthy = await makeBot("basil");
      const room = await makeRoom("Recovery", [broken.id, healthy.id], { kind: "everyone" });
      const before = completionCount();

      engine.queueCompletion(says("I am here."));
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "status?" })).status).toBe(202);

      expect(await waitForBotIdle(healthy.id), `the healthy member never ran. stderr:\n${stderr}`).toBeTruthy();
      expect(await waitForRoomIdle(room.id), "the room stayed busy after a rejected dispatch").toBeTruthy();

      expect((await activity(room.threadId)).join("\n")).toContain("no MiniMax key");
      // the rejection did not eat the room: the other member still ran
      expect(completionCount() - before).toBe(1);
      expect(await replies(room.threadId)).toEqual(["I am here."]);
      expect(await waitForBotIdle(broken.id)).toBeTruthy();
    },
    120_000,
  );

  it(
    "still interrupts a room turn that outlives its deadline, and takes the stalled branch",
    async () => {
      const member = await makeBot("nomad");
      const room = await makeRoom("Stalled", [member.id], { kind: "member", botId: member.id });
      const before = completionCount();

      // The provider accepts the round and never answers.  Only the room
      // deadline's interrupt can end this turn.
      engine.queueCompletion({ kind: "hang" });
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "think about it" })).status).toBe(202);

      const timedOut = await waitFor(
        async () => ((await activity(room.threadId)).some((name) => name.includes("exceeded")) ? true : null),
        ROOM_TIMEOUT_MS + 60_000,
      );
      expect(timedOut, `the room deadline never fired. stderr:\n${stderr}`).toBe(true);

      // The interrupt produces the turn's ONE terminal event, and that is
      // what clears the speaker — the waiter deliberately does not, because
      // a timed-out provider still owns the thread until it settles.
      expect(await waitForRoomIdle(room.id, 60_000), "the room never released its speaker").toBeTruthy();
      expect(await waitForBotIdle(member.id, 60_000)).toBeTruthy();

      // one round asked for, one round hung, nothing retried underneath
      expect(completionCount() - before).toBe(1);
      const stamps = (await activity(room.threadId)).filter((name) => name.includes("exceeded"));
      expect(stamps).toHaveLength(1);
      expect(await replies(room.threadId)).toEqual([]);
    },
    240_000,
  );

  it(
    "holds the room deadline while an approval card opened inside the turn is unanswered",
    async () => {
      // No peer is needed: the host asks BEFORE the executor runs, so the
      // card is what an unresolvable `@scout` proves, not the delegation.
      const member = await makeBot("harbor", { autoApprove: false });
      const room = await makeRoom("Approvals", [member.id], { kind: "member", botId: member.id });
      const before = completionCount();

      engine.queueCompletion(asksToDelegate("summarise the deploy log"));
      engine.queueCompletion(says("I was not allowed to delegate that."));
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "delegate this" })).status).toBe(202);

      const card = await waitFor(async () => {
        const open = (await messages(room.threadId)).find(
          (m) => m.kind === "options" && m.card?.requestId && !m.card.answered,
        );
        return open ?? null;
      }, 30_000);
      expect(card, `no approval card opened on the room thread. stderr:\n${stderr}`).toBeTruthy();
      expect(card!.card!.tool).toBe("ask_bot");

      // Sit on it for longer than the whole room budget.  Waiting on a
      // person is not turn work: the deadline holds, so a slow decision
      // must not manufacture the stranded-approval state the harness would
      // then have to repair.
      await new Promise((r) => setTimeout(r, ROOM_TIMEOUT_MS + 10_000));
      expect((await activity(room.threadId)).filter((name) => name.includes("exceeded"))).toEqual([]);
      expect((await groupState(room.id))?.busyBotId).toBe(member.id);

      const answered = await api("POST", `/api/threads/${room.threadId}/respond`, {
        requestId: card!.card!.requestId,
        behavior: "deny",
      });
      expect(answered.status).toBe(200);
      expect(answered.body.outcome).toBe("rejected");

      // and the budget resumes where it left off rather than restarting or
      // firing late: the second round runs and the turn settles normally.
      expect(await waitForBotIdle(member.id), `the turn never resumed. stderr:\n${stderr}`).toBeTruthy();
      expect(await waitForRoomIdle(room.id)).toBeTruthy();
      expect(completionCount() - before).toBe(2);
      expect(await replies(room.threadId)).toEqual(["I was not allowed to delegate that."]);
      expect((await activity(room.threadId)).filter((name) => name.includes("exceeded"))).toEqual([]);
    },
    240_000,
  );

  it(
    "keeps the HTTP lane's host tools exactly as they were when the CLI lane gained its computers",
    async () => {
      // Rooms used to mount no computer for any CLI or ACP engine while THIS
      // lane kept host tools, so the weaker lane was the better-equipped one.
      // That is fixed by raising the CLI lane, never by lowering this one —
      // so this pins what an HTTP room member is offered, unchanged.
      //
      // A driver-loop engine has no MCP client, so "This Computer" is not a
      // mount for it: `hasHostComputer` is `wantsLocal && localComputerMcp`
      // and the harness executor supplies the tools.  It must therefore stay
      // true whether or not Cua Driver is running, and must not produce the
      // "local computer not mounted" chip a mounting engine would get.
      const member = await makeBot("quay", { computers: ["local"] });
      const room = await makeRoom("Hostage", [member.id], { kind: "member", botId: member.id });
      const before = completionCount();

      engine.queueCompletion(says("Standing by."));
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "what can you run?" })).status).toBe(202);
      expect(await waitForBotIdle(member.id), `the member never went idle. stderr:\n${stderr}`).toBeTruthy();
      expect(await waitForRoomIdle(room.id)).toBeTruthy();

      expect(completionCount() - before).toBe(1);
      const round = engine.requests.filter((r) => r.url.includes("/chat/completions")).slice(before)[0];
      // SAFETY: the fake engine records the JSON body the harness POSTed, and
      // the round count was asserted immediately above.
      const offered = ((round.body as { tools?: Array<{ function?: { name?: string } }> }).tools ?? []).map(
        (t) => t.function?.name,
      );
      expect(offered).toContain("bash");
      expect(offered).toContain("read_file");
      expect(offered).toContain("write_file");
      expect(offered).toContain("edit_file");
      expect(offered.some((name) => name?.startsWith("mcp__computer"))).toBe(false);
      expect((await activity(room.threadId)).filter((name) => name.includes("local computer not mounted"))).toEqual([]);
    },
    120_000,
  );
});
