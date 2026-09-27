// Approvals on the HTTP lane, end to end against the real server.
//
// Every other test in this change tests a part: the broker's own contract
// (`tools/approvals.test.ts`), the host's ask-before-run policy
// (`tools/host.test.ts`), the loop's paused clock
// (`drivers/chat-completions/loop.test.ts`).  This file is the only one
// that proves the WHOLE chain, because the whole point of the design is
// that the broker reaches machinery it does not own:
//
//   model asks for a write tool
//     -> host sees the registry's `approval` record and asks
//       -> broker publishes a real `request.opened` on the bus
//         -> the index.ts fold applies auto mode, the guards, the
//            unattended block, and writes the decision-log row
//           -> a card reaches a person (or auto mode answers it)
//             -> the verdict comes back through deliverDecision
//               -> the tool runs, or is refused in words the model reads
//
// Before this, nothing on this lane ever asked for permission: a MiniMax
// bot ran whatever the model called.  A mock could not show that changed.
//
// The engine is `server/testing/fake-openai-server.ts` — a real HTTP server
// the spawned harness talks to over the loopback, scripted round by round.
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DecisionRow } from "./decision-log.ts";
import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { startFakeOpenAiServer, type FakeOpenAiServer } from "./testing/fake-openai-server.ts";
import { freePortBlock } from "./testing/ports.ts";
import { harnessReady } from "./testing/harness-ready.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const posixOnly = describe.skipIf(process.platform === "win32");

/** One round that asks for `ask_bot` — the registry's only write tool with
 *  an `approval` record before PR 7 added a second one. */
const asksToDelegate = (task: string) => ({
  kind: "sse" as const,
  frames: [
    `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"ask_bot","arguments":${JSON.stringify(
      JSON.stringify({ bot_id: "@peer", task }),
    )}}}]}}]}`,
    '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
    "[DONE]",
  ],
});

/** PR 7's second approval-gated write tool: same shape as `asksToDelegate`,
 *  a different tool name and argument (`message`, not `task` — delegate_bot
 *  has no declared wire deviation). */
const asksToDelegateBot = (message: string, reason?: string) => ({
  kind: "sse" as const,
  frames: [
    `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_delegate","function":{"name":"delegate_bot","arguments":${JSON.stringify(
      JSON.stringify({ bot_id: "@peer", message, ...(reason ? { reason } : {}) }),
    )}}}]}}]}`,
    '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
    "[DONE]",
  ],
});

/** PR 7's suspend-class tool: no approval card, but the turn still has to
 *  end here — `request_credential`'s outcome is `{ kind: "suspend" }`. */
const asksForCredential = (credentialId: string, reason?: string) => ({
  kind: "sse" as const,
  frames: [
    `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_credential","function":{"name":"request_credential","arguments":${JSON.stringify(
      JSON.stringify({ credential_id: credentialId, ...(reason ? { reason } : {}) }),
    )}}}]}}]}`,
    '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
    "[DONE]",
  ],
});

const says = (text: string) => ({
  kind: "sse" as const,
  frames: [`{"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}`, "[DONE]"],
});

posixOnly("approvals reach an HTTP-lane bot", () => {
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

  /** A live, unanswered permission card on a bot's own conversation. */
  const waitForCard = async (botId: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const { body } = await api("GET", "/api/bots");
      const bot = (body.bots ?? []).find((b: { id: string }) => b.id === botId);
      const card = (bot?.messages ?? []).find(
        (m: { kind: string; card?: { requestId?: string; answered?: string } }) =>
          m.kind === "options" && m.card?.requestId && !m.card.answered,
      );
      if (card) return card;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  /** A live permission card on a THREAD — a webhook turn runs in its own
   *  detached task, so its card never appears on the bot's conversation. */
  const waitForThreadCard = async (threadId: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const { body } = await api("GET", `/api/threads/${threadId}/messages`);
      const card = (body.messages ?? []).find(
        (m: { kind: string; card?: { requestId?: string } }) => m.kind === "options" && m.card?.requestId,
      );
      if (card) return card;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  const waitForRunThread = async (runId: string, ms = 20_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const { body } = await api("GET", "/api/routines");
      const run = (body.runs ?? []).find((r: { id: string }) => r.id === runId);
      if (run?.threadId) return run.threadId as string;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  const waitForDecision = async (pred: (r: DecisionRow) => boolean, ms = 30_000): Promise<DecisionRow | null> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const { body } = await api("GET", "/api/decisions");
      const row: DecisionRow | undefined = (body.decisions ?? []).filter(pred).at(-1);
      if (row) return row;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  const waitForIdle = async (botId: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const { body } = await api("GET", "/api/bots");
      const bot = (body.bots ?? []).find((b: { id: string }) => b.id === botId);
      if (bot && !bot.busy) return bot;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  /** The bot under test, and a peer so `ask_bot`'s gate has somewhere to
   *  point.  Both sit on the fake MiniMax instance. */
  const makeBot = async (patch: Record<string, unknown> = {}) => {
    const created = await api("POST", "/api/bots");
    expect(created.status).toBe(201);
    const patched = await api("PATCH", `/api/bots/${created.body.bot.id}`, {
      ...patch,
      modelSelection: { instanceId: "minimax", model: "MiniMax-M3" },
    });
    expect(patched.status).toBe(200);
    return patched.body.bot ?? created.body.bot;
  };

  beforeAll(async () => {
    engine = await startFakeOpenAiServer();
    home = mkdtempSync(join(tmpdir(), "omb-http-lane-e2e-"));
    mkdirSync(join(home, ".botfleet"), { recursive: true });
    writeFileSync(
      join(home, ".botfleet", "config.json"),
      JSON.stringify({
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
        },
      }),
      { mode: 0o600 },
    );
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
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

  it(
    "cards a write tool, and a deny stops it with words the model reads",
    async () => {
      const peer = await makeBot({ name: "peer" });
      const bot = await makeBot({ name: "asker", autoApprove: false });
      expect(peer.id).not.toBe(bot.id);

      engine.queueCompletion(asksToDelegate("summarise the deploy log"));
      engine.queueCompletion(says("I was not allowed to delegate that."));
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "delegate this" })).status).toBe(202);

      const card = await waitForCard(bot.id);
      expect(card, `no approval card appeared. stderr:\n${stderr}`).not.toBeNull();
      expect(card.card.tool).toBe("ask_bot");
      // the registry's own summary, not a tool name on its own
      expect(card.card.subtitle).toContain("summarise the deploy log");

      const answered = await api("POST", `/api/bots/${bot.id}/respond`, {
        requestId: card.card.requestId,
        behavior: "deny",
      });
      expect(answered.status).toBe(200);
      // the broker owned this request, so the answer never reached an
      // adapter that would have said "unavailable"
      expect(answered.body.outcome).toBe("rejected");

      const row = await waitForDecision((r) => r.tool === "ask_bot" && r.decision === "user-denied");
      expect(row, "the decision log never recorded the deny").not.toBeNull();
      expect(row!.source).toBe("user");

      // and the refusal is what the model saw next: the turn continued
      expect(await waitForIdle(bot.id)).toBeTruthy();
      const round2 = engine.requests.filter((r) => r.url.includes("/chat/completions")).at(-1);
      const toolMessage = (round2?.body as { messages?: Array<{ role: string; content: string }> })?.messages?.find(
        (m) => m.role === "tool",
      );
      expect(String(toolMessage?.content)).toContain("was not approved");
    },
    90_000,
  );

  it(
    "auto mode answers it for the bot, and says so in the decision log",
    async () => {
      await makeBot({ name: "peer2" });
      const bot = await makeBot({ name: "auto-asker", autoApprove: true, computers: [] });

      // A peer id nothing resolves to: the point of this row is that the
      // VERDICT reached the tool, and a real delegation would spend a
      // second bot's turn to prove the same thing.
      engine.queueCompletion({
        kind: "sse",
        frames: [
          '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"ask_bot","arguments":"{\\"bot_id\\":\\"bot-nobody\\",\\"task\\":\\"check the queue\\"}"}}]}}]}',
          "[DONE]",
        ],
      });
      engine.queueCompletion(says("That bot does not exist."));
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "go" })).status).toBe(202);

      const row = await waitForDecision(
        (r) => r.tool === "ask_bot" && r.decision === "auto-approved" && r.botId === bot.id,
      );
      expect(row, `auto mode never answered the ask. stderr:\n${stderr}`).not.toBeNull();
      expect(row!.source).toBe("auto-mode");

      // no card was ever left open for a person
      expect(await waitForIdle(bot.id)).toBeTruthy();
      const { body } = await api("GET", "/api/bots");
      const live = (body.bots ?? []).find((b: { id: string }) => b.id === bot.id);
      const open = (live?.messages ?? []).filter(
        (m: { kind: string; card?: { requestId?: string; answered?: string } }) =>
          m.kind === "options" && m.card?.requestId && !m.card.answered,
      );
      expect(open).toHaveLength(0);
    },
    90_000,
  );

  // PR 7: delegate_bot is the second registry tool to carry an `approval`
  // record.  Its summary has to name the target and the first 120 chars —
  // that is what a person approving it actually reads — and a deny must
  // leave the async handoff genuinely unqueued, not merely refused.
  it(
    "cards delegate_bot with the target and the first 120 chars, and a deny queues nothing",
    async () => {
      const peer = await makeBot({ name: "delegate-peer" });
      const bot = await makeBot({ name: "delegator", autoApprove: false });
      expect(peer.id).not.toBe(bot.id);

      const longTask = "Please rotate the nightly build credentials and confirm the new expiry date. ".repeat(3);
      engine.queueCompletion(asksToDelegateBot(longTask, "rotation"));
      engine.queueCompletion(says("I was not allowed to delegate that."));
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "delegate this" })).status).toBe(202);

      const card = await waitForCard(bot.id);
      expect(card, `no approval card appeared. stderr:\n${stderr}`).not.toBeNull();
      expect(card.card.tool).toBe("delegate_bot");
      expect(card.card.subtitle).toContain("@peer");
      expect(card.card.subtitle).toContain(longTask.slice(0, 100).trim());
      // The full 200-char task must not have been copied verbatim onto the
      // card — that is the "first 120 chars" contract, not "the whole task".
      expect(card.card.subtitle.length).toBeLessThan(longTask.length);

      const answered = await api("POST", `/api/bots/${bot.id}/respond`, {
        requestId: card.card.requestId,
        behavior: "deny",
      });
      expect(answered.status).toBe(200);
      expect(answered.body.outcome).toBe("rejected");

      const row = await waitForDecision((r) => r.tool === "delegate_bot" && r.decision === "user-denied");
      expect(row, "the decision log never recorded the deny").not.toBeNull();

      // The side effect never ran: nothing was queued for the peer to pick up.
      const teamMap = await api("GET", "/api/team-map");
      const queuedForPeer = (teamMap.body.queued ?? []).filter(
        (q: { sourceBotId: string; targetBotId: string }) => q.sourceBotId === bot.id && q.targetBotId === peer.id,
      );
      expect(queuedForPeer).toHaveLength(0);

      expect(await waitForIdle(bot.id)).toBeTruthy();
      const round2 = engine.requests.filter((r) => r.url.includes("/chat/completions")).at(-1);
      const toolMessage = (round2?.body as { messages?: Array<{ role: string; content: string }> })?.messages?.find(
        (m) => m.role === "tool",
      );
      expect(String(toolMessage?.content)).toContain("was not approved");
    },
    90_000,
  );

  // PR 7: request_credential is the first registry tool that SETTLES the
  // turn rather than feeding a result back — `{ kind: "suspend" }` all the
  // way through the loop.  Dismissing the card is enough to prove the whole
  // chain: the turn ends with exactly one settle, the bot goes idle, and the
  // existing secret-resume drain dispatches a genuinely fresh turn once the
  // card is answered — no new state machine, per PR 6/7's design.
  it(
    "request_credential suspends the turn and the existing resume drain answers it",
    async () => {
      const bot = await makeBot({ name: "credential-asker" });
      // A baseline, not an absolute count: `engine.requests` accumulates
      // across every test in this file, so only the DELTA this test causes
      // is meaningful.
      const chatRequests = () => engine.requests.filter((r) => r.url.includes("/chat/completions")).length;
      const before = chatRequests();

      engine.queueCompletion(asksForCredential("opencodeGoApiKey", "needed for the task"));
      engine.queueCompletion(says("Continuing without it."));
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "do the task" })).status).toBe(202);

      // Suspends: the bot goes idle with a secret card visible, and the
      // fake engine was called exactly once for this turn so far.
      expect(await waitForIdle(bot.id)).toBeTruthy();
      const afterSuspend = await api("GET", "/api/bots");
      const suspendedBot = (afterSuspend.body.bots ?? []).find((b: { id: string }) => b.id === bot.id);
      const card = (suspendedBot?.messages ?? []).find(
        (m: { kind: string; secret?: { target?: string } }) => m.kind === "secret" && m.secret?.target === "opencodeGoApiKey",
      );
      expect(card, `no secret card appeared. stderr:\n${stderr}`).toBeTruthy();
      expect(chatRequests() - before, "more than one round ran before the card was even shown").toBe(1);

      const dismissed = await api("POST", `/api/bots/${bot.id}/secret-cards/${card.id}/dismiss`, {
        threadId: bot.threadId,
      });
      expect(dismissed.status).toBe(200);

      // Resumes: a fresh turn ran against the fake engine and settled.
      const deadline = Date.now() + 30_000;
      for (;;) {
        if (chatRequests() - before >= 2) break;
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(chatRequests() - before, "the secret-resume drain never re-dispatched a turn").toBe(2);
      expect(await waitForIdle(bot.id)).toBeTruthy();
    },
    90_000,
  );

  it(
    "the unattended gate still stops a webhook turn, auto mode or not",
    async () => {
      await makeBot({ name: "peer3" });
      const bot = await makeBot({ name: "webhook-asker", autoApprove: true, computers: [] });

      engine.queueCompletion(asksToDelegate("rotate the nightly build"));
      engine.queueCompletion(says("Waiting on a person."));

      const hook = await api("POST", "/api/webhooks", {
        name: "Nightly build",
        prompt: "Handle the incoming build event",
        botId: bot.id,
        runOn: "bot",
      });
      expect(hook.status).toBe(201);
      const delivered = await fetch(hook.body.credential.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "failed" }),
      });
      expect(delivered.status).toBe(202);
      const { runId } = (await delivered.json()) as { runId: string };

      const threadId = await waitForRunThread(runId);
      expect(threadId, "the webhook never started a task").toBeTruthy();

      // Auto mode is a decision someone made for turns they were present
      // for.  Nobody started this one, so it must still reach a human —
      // the same rule the CLI lane has always had.
      const card = await waitForThreadCard(threadId!);
      expect(card, `a webhook turn auto-approved on the HTTP lane. stderr:\n${stderr}`).not.toBeNull();
      expect(card.card.tool).toBe("ask_bot");

      const row = await waitForDecision((r) => r.tool === "ask_bot" && r.source === "unattended-block");
      expect(row, "the unattended block wrote no audit row").not.toBeNull();
      expect(row!.decision).toBe("card-shown");
      expect(row!.unattended).toBe(true);
    },
    90_000,
  );

});
