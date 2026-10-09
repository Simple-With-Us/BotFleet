// Auto-review on an engine that cannot review itself, end to end.
//
// Before this change only Claude could be reviewed: the gate was "does the
// engine that raised the request implement reviewPermission", and nothing
// else did.  This runs the real server against the fake ACP CLI (an engine
// with no reviewer of its own) and a stub OpenAI-compatible endpoint chosen
// as the fleet's fallback reviewer, and asserts what a person would see:
//
//   1. On + the reviewer allows      → the card is answered for them
//   2. On + the reviewer refuses     → the card stays open, saying why
//   3. Watch                         → a record, and the card stays open
//   4. Bypass + On                   → the reviewer screens the bypass
//   5. Bypass + Watch                → bypass approves, the review audits
//   6. On, full-auto instance        → the turn is held in asking mode
//   7. Watch, full-auto instance     → each step is watched after the fact
//   8. On, an engine that never asks → a refused step stops the turn (pi)
//   9. An HTTP lane reviews its own asks: the same stub, as the bot's engine
//
// and, from the review of that change:
//
//  10. Automatic picks the fallback reviewer: nobody chose one in config
//  11. On, held full-auto turn: a step that never asks is still watched, and
//      a refusal stops the turn; a step that asked is left to its card
//  12. Auto (not Bypass) + On: the reviewer screens an Auto grant too
//  13. Bypass + On: a reviewer answer outside the contract holds the ask
//  14. A held card offers "always" only for what an ordinary card would
//  15. An HTTP lane's own action is reviewed first by a different engine
//  16. A held turn's asked step is judged once, at the card, not twice
//  17. A message to another bot (ask_bot) is watched like any other step
//  18. On, held turn: a person's always-allow is reviewed too, so On never
//      reviews less than Watch
import type { ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { approvalKey, offerableApprovalKey } from "./auto-approve.ts";
import type { DecisionRow } from "./decision-log.ts";
import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { harnessReady } from "./testing/harness-ready.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const FAKE_PI_CLI = join(SERVER_DIR, "testing", "fake-pi-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

let child: ChildProcess;
let home: string;
let stderr = "";
let reviewer: Server;

interface Verdict {
  allow: boolean;
  reason: string;
}

/** The slice of a chat-completions request the stub reads. */
interface ChatRequest {
  stream?: boolean;
  tools?: Array<{ function?: { name?: string } }>;
  messages?: Array<{ role?: string; content?: unknown }>;
}

/** What the stub reviewer answers next. */
let verdict: Verdict = { allow: true, reason: "routine" };
/** Per-action answers that win over `verdict`, keyed by the reviewed action. */
const actionVerdicts = new Map<string, Verdict>();
/** Answer every review with prose instead of the strict JSON contract. */
let malformed = false;
/** Every prompt the stub reviewer was sent, all its messages joined. */
const reviewPrompts: string[] = [];
/** The role of each message in the last review the stub was sent. */
let lastReviewRoles: string[] = [];

/** The action under review, read back out of the delimited user message. */
function reviewedAction(body: ChatRequest): string | null {
  const data = String(body.messages?.find((message) => message.role === "user")?.content ?? "");
  const match = data.match(/"action":"((?:[^"\\]|\\.)*)"/);
  return match ? (JSON.parse(`"${match[1]}"`) as string) : null;
}
/** The tools the stub was last offered as a bot's engine. */
let offeredTools: string[] = [];

/** The stub as a bot's own engine: ask for one tool that needs approval,
 *  then, once the tool's result comes back, finish with a line of text. */
function answerTurn(res: ServerResponse, body: ChatRequest): void {
  offeredTools = (body.tools ?? []).map((tool) => tool.function?.name ?? "");
  const tool = offeredTools.includes("write_file") ? "write_file" : offeredTools.includes("ask_bot") ? "ask_bot" : null;
  const args = tool === "write_file" ? { path: "review-notes.txt", content: "hi" } : { bot_id: "nobody", message: "hi" };
  const finished = body.messages?.at(-1)?.role === "tool" || tool === null;
  const toolCall = { index: 0, id: "call_review", type: "function", function: { name: tool, arguments: JSON.stringify(args) } };
  if (!body.stream) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: finished ? { content: "done" } : { content: "", tool_calls: [toolCall] } }] }));
    return;
  }
  const frames = finished
    ? [
        { choices: [{ index: 0, delta: { content: "done" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]
    : [
        { choices: [{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ];
  res.setHeader("content-type", "text/event-stream");
  for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
  res.end("data: [DONE]\n\n");
}

const api = async <Body extends object>(method: string, path: string, body?: Body): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

async function waitFor<T>(probe: () => Promise<T | null | undefined>, ms = 30_000): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

const decision = (pred: (row: DecisionRow) => boolean, ms?: number) =>
  waitFor(async () => {
    const rows: DecisionRow[] = (await api("GET", "/api/decisions")).body.decisions ?? [];
    return rows.filter(pred).at(-1);
  }, ms);

interface Card {
  id: string;
  kind: string;
  card?: { requestId?: string; answered?: string; held?: string; allowKey?: string };
  tool?: { name?: string };
}

const threadMessages = async (threadId: string): Promise<Card[]> =>
  (await api("GET", `/api/threads/${threadId}/messages`)).body.messages ?? [];

/** The newest permission card on a thread, answered or not. */
const card = (threadId: string, ms?: number) =>
  waitFor(async () => (await threadMessages(threadId)).filter((m) => m.kind === "options" && m.card?.requestId).at(-1), ms);

async function makeBot(instanceId: string, patch: Record<string, unknown>, model = "fake-model") {
  const created = await api("POST", "/api/bots");
  expect(created.status).toBe(201);
  const patched = await api("PATCH", `/api/bots/${created.body.bot.id}`, {
    computers: [],
    ...patch,
    modelSelection: { instanceId, model },
  });
  expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  const bot: { id: string; threadId: string } = patched.body.bot;
  return bot;
}

async function send(bot: { id: string }) {
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "run it" })).status).toBe(202);
}

/** Answer a card so its turn ends and the next test starts clean. */
async function release(bot: { id: string }, requestId: string) {
  await api("POST", `/api/bots/${bot.id}/respond`, { requestId, behavior: "deny" });
}

posixOnly("auto-review on an engine without a reviewer of its own", () => {
  beforeAll(async () => {
    reviewer = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        if (req.method === "GET" && req.url?.endsWith("/models")) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ data: [{ id: "stub-reviewer" }] }));
          return;
        }
        // SAFETY: only the harness posts here, and only chat-completions bodies; ChatRequest's fields are all optional.
        const body = JSON.parse(raw || "{}") as ChatRequest;
        // A request with tools is a bot's turn on this engine.  A review is
        // tool-free by contract, so a request without tools is a review.
        if (body.tools) {
          answerTurn(res, body);
          return;
        }
        reviewPrompts.push((body.messages ?? []).map((message) => String(message.content ?? "")).join("\n"));
        lastReviewRoles = (body.messages ?? []).map((message) => String(message.role));
        const action = reviewedAction(body);
        const answer = (action !== null && actionVerdicts.get(action)) || verdict;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            choices: [{ message: { content: malformed ? "Sure, that looks fine to me!" : JSON.stringify(answer) } }],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => reviewer.listen(0, "127.0.0.1", resolve));
    const address = z.object({ port: z.number().int().min(1).max(65_535) }).parse(reviewer.address());
    const reviewerUrl = `http://127.0.0.1:${address.port}/v1`;

    chmodSync(FAKE_CLI, 0o755);
    chmodSync(FAKE_PI_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-auto-review-e2e-"));
    mkdirSync(join(home, ".botfleet"), { recursive: true });
    writeFileSync(
      join(home, ".botfleet", "config.json"),
      JSON.stringify({
        // No fallback reviewer chosen: Automatic picks one (the stub, the only
        // engine here that can review).
        instances: {
          acp: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "permission" }, config: { cli: FAKE_CLI, fullAuto: false } },
          acpRm: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_COMMAND: "rm -rf build" },
            config: { cli: FAKE_CLI, fullAuto: false },
          },
          acpAuto: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "permission" }, config: { cli: FAKE_CLI, fullAuto: true } },
          acpAutoAsk: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_CALL_ID: "tc-ask" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          acpHeld: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "quiet-tool-call", FAKE_ACP_QUIET_MS: "15000" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          acpSteps: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "quiet-tool-call", FAKE_ACP_QUIET_MS: "1500" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          // a full-auto engine that messages another bot without asking
          acpAskBot: {
            driver: "grokAgent",
            environment: {
              FAKE_ACP_MODE: "quiet-tool-call",
              FAKE_ACP_QUIET_MS: "1500",
              FAKE_ACP_QUIET_TITLE: "mcp__agents__ask_bot",
            },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          pi: {
            driver: "piAgent",
            environment: { FAKE_PI_MODE: "slow-tool", FAKE_PI_TOOL_MS: "60000" },
            config: { cli: FAKE_PI_CLI },
          },
          reviewer: {
            driver: "openai-compat",
            displayName: "Stub Reviewer",
            config: { url: reviewerUrl, models: ["stub-reviewer"], key: "test-key" },
          },
          // a second API engine, listed after the first, as a bot's own engine
          lane: {
            driver: "openai-compat",
            displayName: "Second Lane",
            config: { url: reviewerUrl, models: ["stub-reviewer"], key: "test-key" },
          },
        },
      }),
    );
    // posix only (see `posixOnly`), so no SystemRoot to carry
    const env = { HOME: home, USERPROFILE: home, OMB_PORT: String(PORT), PATH: process.env.PATH ?? "" };
    child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if (await harnessReady(BASE)) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
    await new Promise<void>((resolve) => reviewer.close(() => resolve()));
  });

  it("ships the hook, the automatic fallback reviewer and the review limit the Bot Profile reads", async () => {
    const instances: Array<{ instanceId: string; capabilities: Record<string, unknown> }> =
      (await api("GET", "/api/instances")).body.instances;
    const config = (await api("GET", "/api/config")).body;
    // nobody chose a reviewer, and review still has one
    expect(config.autoReview).toEqual({ fallbackReviewer: null, automaticReviewer: "reviewer", maxReviewsPerTurn: 50 });
    const caps = (id: string) => instances.find((instance) => instance.instanceId === id)?.capabilities;
    expect(caps("acp")).toMatchObject({ reviewHook: "before", approvalReview: false });
    expect(caps("acpAuto")).toMatchObject({ reviewHook: "after", asksWhenHeld: true });
    expect(caps("reviewer")).toMatchObject({ reviewHook: "before", approvalReview: true });
  }, 60_000);

  it("On: the fallback reviewer answers the card for them when it allows", async () => {
    verdict = { allow: true, reason: "a harmless echo" };
    const bot = await makeBot("acp", { name: "Allowed", autoReview: "enforce" });
    await send(bot);
    const row = await decision((r) => r.botId === bot.id && r.decision === "auto-approved");
    expect(row, `no review approval. stderr:\n${stderr.slice(-2000)}`).not.toBeNull();
    expect(row).toMatchObject({ source: "auto-review", rule: "a harmless echo", reviewer: "reviewer", tool: "shell" });
    expect(reviewPrompts.at(-1)).toContain("echo hi");
    const answered = await waitFor(async () => (await card(bot.threadId))?.card?.answered);
    expect(answered).toBe("allow");
  }, 90_000);

  it("On: a refusal leaves the card open and says who refused and why", async () => {
    verdict = { allow: false, reason: "not what the owner asked for" };
    const bot = await makeBot("acp", { name: "Refused", autoReview: "enforce" });
    await send(bot);
    const row = await decision((r) => r.botId === bot.id && r.decision === "card-shown" && r.source === "auto-review");
    expect(row).toMatchObject({ rule: "not what the owner asked for", reviewer: "reviewer" });
    const open = await card(bot.threadId);
    expect(open?.card?.answered).toBeUndefined();
    expect(open?.card?.held).toBe("The reviewer (Stub Reviewer) did not approve this: not what the owner asked for");
    // nothing was approved for them
    const rows: DecisionRow[] = (await api("GET", "/api/decisions")).body.decisions;
    expect(rows.some((r) => r.botId === bot.id && r.decision === "auto-approved")).toBe(false);
    await release(bot, open!.card!.requestId!);
  }, 90_000);

  it("Watch: records what the reviewer would do and leaves the card with the person", async () => {
    verdict = { allow: true, reason: "looks routine" };
    const bot = await makeBot("acp", { name: "Watched", autoReview: "shadow" });
    await send(bot);
    const row = await decision((r) => r.botId === bot.id && r.decision === "review-would-approve");
    expect(row).toMatchObject({ source: "auto-review-shadow", reviewer: "reviewer" });
    const open = await card(bot.threadId);
    expect(open?.card?.answered).toBeUndefined();
    await release(bot, open!.card!.requestId!);
  }, 90_000);

  it("Bypass + On: the reviewer still screens each bypass approval", async () => {
    verdict = { allow: false, reason: "too risky for bypass" };
    const refused = await makeBot("acp", { name: "Bypass Refused", bypassPermissions: true, autoReview: "enforce" });
    await send(refused);
    const held = await card(refused.threadId);
    expect(held?.card?.held).toBe("Bypass is on, but the reviewer (Stub Reviewer) did not approve this: too risky for bypass");
    expect(held?.card?.answered).toBeUndefined();
    await release(refused, held!.card!.requestId!);

    verdict = { allow: true, reason: "fine under bypass" };
    const allowed = await makeBot("acp", { name: "Bypass Allowed", bypassPermissions: true, autoReview: "enforce" });
    await send(allowed);
    const row = await decision((r) => r.botId === allowed.id && r.decision === "auto-approved");
    expect(row).toMatchObject({ source: "auto-review", rule: "fine under bypass", reviewer: "reviewer" });
  }, 120_000);

  it("Bypass + Watch: bypass approves at once and the review is an audit afterwards", async () => {
    verdict = { allow: false, reason: "would have asked" };
    const bot = await makeBot("acp", { name: "Bypass Watched", bypassPermissions: true, autoReview: "shadow" });
    await send(bot);
    const approved = await decision((r) => r.botId === bot.id && r.decision === "auto-approved");
    expect(approved).toMatchObject({ source: "auto-mode", rule: "permission-bypass" });
    const audit = await decision((r) => r.botId === bot.id && r.decision === "review-would-deny");
    expect(audit).toMatchObject({ source: "auto-review-shadow", rule: "would have asked", reviewer: "reviewer" });
  }, 90_000);

  it("On, full-auto instance: the attended turn is held in asking mode so the reviewer sees the ask", async () => {
    verdict = { allow: false, reason: "held and refused" };
    // the fake's own unasked "run" step is fine; only the ask is refused
    actionVerdicts.set("run", { allow: true, reason: "a harmless step" });
    try {
      const bot = await makeBot("acpAuto", { name: "Held", autoReview: "enforce" });
      await send(bot);
      // a full-auto instance would have answered this itself; held, it asks
      const row = await decision((r) => r.botId === bot.id && r.decision === "card-shown" && r.source === "auto-review");
      expect(row).toMatchObject({ rule: "held and refused", tool: "shell" });
      const open = await card(bot.threadId);
      expect(open?.card?.answered).toBeUndefined();
      await release(bot, open!.card!.requestId!);
    } finally {
      actionVerdicts.clear();
    }
  }, 90_000);

  it("On, held turn: a step that asked is left to its card, never stopped by the step watch", async () => {
    // The fake announces the call as a step, then asks about that same call
    // by id.  The step watch sees the step first; the ask's id tells it the
    // card has it, so a refusal holds the card for the person instead of
    // stopping a turn they may be about to allow.
    verdict = { allow: false, reason: "asked and refused" };
    actionVerdicts.set("run", { allow: true, reason: "a harmless step" });
    const promptsBefore = reviewPrompts.length;
    try {
      const bot = await makeBot("acpAutoAsk", { name: "Held Asker", autoReview: "enforce" });
      await send(bot);
      const row = await decision((r) => r.botId === bot.id && r.decision === "card-shown" && r.source === "auto-review");
      expect(row).toMatchObject({ rule: "asked and refused", tool: "shell" });
      const open = await card(bot.threadId);
      expect(open?.card?.answered).toBeUndefined();
      // give a late watch review time to land, then prove it stopped nothing
      await new Promise((r) => setTimeout(r, 1_500));
      const rows: DecisionRow[] = (await api("GET", "/api/decisions")).body.decisions;
      expect(rows.some((r) => r.botId === bot.id && r.decision === "review-stopped-turn")).toBe(false);
      expect((await card(bot.threadId))?.card?.answered).toBeUndefined();
      // and the asked step was judged once, at the card, not again as a step
      // the engine "took on its own": that second review spent the turn's
      // review limit at double the rate
      const sent = reviewPrompts.slice(promptsBefore).filter((prompt) => prompt.includes("echo hi"));
      expect(sent.filter((prompt) => prompt.includes("has just started on its own"))).toEqual([]);
      expect(sent).toHaveLength(1);
      await release(bot, open!.card!.requestId!);
    } finally {
      actionVerdicts.clear();
    }
  }, 90_000);

  // Finding 1 of the follow-up review.  A held turn hands each ask to the card,
  // and the step watch drops the step once it asks.  An always-allow answered
  // at the card with no review, so On reviewed less than Watch did for the very
  // actions a person had pre-approved.
  it("On, held turn: a person's always-allow is reviewed, and a refusal hands the ask to them as a card", async () => {
    verdict = { allow: false, reason: "not what the owner asked for" };
    actionVerdicts.set("run", { allow: true, reason: "a harmless step" });
    try {
      const bot = await makeBot("acpAutoAsk", {
        name: "Held Always",
        autoReview: "enforce",
        alwaysAllow: [approvalKey("shell", "echo hi")],
      });
      await send(bot);
      const row = await decision((r) => r.botId === bot.id && r.decision === "card-shown" && r.source === "auto-review");
      expect(row, `the always-allow ask was never reviewed. stderr:\n${stderr.slice(-2000)}`).toMatchObject({
        rule: "not what the owner asked for",
        reviewer: "reviewer",
        tool: "shell",
      });
      const open = await card(bot.threadId);
      expect(open?.card?.answered).toBeUndefined();
      expect(open?.card?.held).toBe(
        "You set this to always allow, but the reviewer (Stub Reviewer) did not approve this: not what the owner asked for",
      );
      // the grant did not answer it behind the reviewer's back
      const rows: DecisionRow[] = (await api("GET", "/api/decisions")).body.decisions;
      expect(rows.some((r) => r.botId === bot.id && r.decision === "auto-approved")).toBe(false);
      await release(bot, open!.card!.requestId!);
    } finally {
      actionVerdicts.clear();
    }
  }, 90_000);

  it("On, held turn: an always-allow the reviewer approves is answered, and the log says the reviewer approved it", async () => {
    verdict = { allow: true, reason: "a harmless echo" };
    const bot = await makeBot("acpAutoAsk", {
      name: "Held Always Allowed",
      autoReview: "enforce",
      alwaysAllow: [approvalKey("shell", "echo hi")],
    });
    await send(bot);
    const row = await decision((r) => r.botId === bot.id && r.decision === "auto-approved");
    expect(row, `no review approval. stderr:\n${stderr.slice(-2000)}`).toMatchObject({
      source: "auto-review",
      rule: "a harmless echo",
      reviewer: "reviewer",
    });
    const chip = await waitFor(async () =>
      (await threadMessages(bot.threadId)).find((m) => m.tool?.name?.includes("review approved (Stub Reviewer)")),
    );
    expect(chip?.tool?.name).toContain("(always allowed), review approved (Stub Reviewer): echo hi");
  }, 90_000);

  it("On, a turn that is not held: an always-allow stays the person's own decision", async () => {
    // `acp` asks natively and is not held (it is not a full-auto instance), so
    // On changes nothing about an action the person already allowed
    verdict = { allow: false, reason: "would refuse anything" };
    const before = reviewPrompts.length;
    const bot = await makeBot("acp", {
      name: "Unheld Always",
      autoReview: "enforce",
      alwaysAllow: [approvalKey("shell", "echo hi")],
    });
    await send(bot);
    const row = await decision((r) => r.botId === bot.id && r.decision === "auto-approved");
    expect(row).toMatchObject({ source: "always-allow", rule: approvalKey("shell", "echo hi") });
    expect(reviewPrompts.slice(before).filter((prompt) => prompt.includes("echo hi"))).toEqual([]);
  }, 90_000);

  it("On, held turn: a step the engine takes without asking is still watched, and a refusal stops the turn", async () => {
    // Held in asking mode, the engine still runs this step unasked.  Before
    // the fix a held turn skipped the step watch entirely, so On reviewed
    // less than Watch.
    verdict = { allow: false, reason: "a build was not requested" };
    const bot = await makeBot("acpHeld", { name: "Held Stepper", autoReview: "enforce" });
    await send(bot);
    const stopped = await decision((r) => r.botId === bot.id && r.decision === "review-stopped-turn", 45_000);
    expect(stopped, `the unasked step was never reviewed. stderr:\n${stderr.slice(-2000)}`).not.toBeNull();
    expect(stopped).toMatchObject({ source: "auto-review", rule: "a build was not requested", summary: "pnpm build", reviewer: "reviewer" });
    // and the turn really ended, well before the step's own 15 seconds
    const idle = await waitFor(async () => {
      const bots: Array<{ id: string; busy?: boolean }> = (await api("GET", "/api/bots")).body.bots;
      return bots.find((candidate) => candidate.id === bot.id && !candidate.busy);
    }, 12_000);
    expect(idle).toBeTruthy();
  }, 90_000);

  it("Auto + On: the reviewer screens an Auto grant, not only a Bypass one", async () => {
    verdict = { allow: false, reason: "not routine enough" };
    const refused = await makeBot("acp", { name: "Auto Refused", autoApprove: true, autoReview: "enforce" });
    await send(refused);
    const held = await card(refused.threadId);
    expect(held?.card?.held).toBe("Auto mode is on, but the reviewer (Stub Reviewer) did not approve this: not routine enough");
    expect(held?.card?.answered).toBeUndefined();
    const rows: DecisionRow[] = (await api("GET", "/api/decisions")).body.decisions;
    expect(rows.some((r) => r.botId === refused.id && r.decision === "auto-approved")).toBe(false);
    await release(refused, held!.card!.requestId!);

    verdict = { allow: true, reason: "a harmless echo" };
    const allowed = await makeBot("acp", { name: "Auto Allowed", autoApprove: true, autoReview: "enforce" });
    await send(allowed);
    const row = await decision((r) => r.botId === allowed.id && r.decision === "auto-approved");
    expect(row).toMatchObject({ source: "auto-review", rule: "a harmless echo", reviewer: "reviewer" });
  }, 120_000);

  it("Bypass + On: a reviewer answer outside the contract never lets the ask through", async () => {
    malformed = true;
    try {
      const bot = await makeBot("acp", { name: "Bypass Garbled", bypassPermissions: true, autoReview: "enforce" });
      await send(bot);
      const held = await card(bot.threadId);
      expect(held?.card?.held).toBe("Bypass is on, but no reviewer could check this one, so it waits for you.");
      expect(held?.card?.answered).toBeUndefined();
      const row = await decision((r) => r.botId === bot.id && r.decision === "card-shown" && r.source === "auto-review");
      expect(row).toMatchObject({ rule: "no reviewer answered" });
      await release(bot, held!.card!.requestId!);
    } finally {
      malformed = false;
    }
  }, 90_000);

  it("a held card offers \"always\" only for what an ordinary card would", async () => {
    verdict = { allow: false, reason: "deletes the build" };
    const bot = await makeBot("acpRm", { name: "Bypass Remover", bypassPermissions: true, autoReview: "enforce" });
    await send(bot);
    const held = await card(bot.threadId);
    expect(held?.card?.held).toBe("Bypass is on, but the reviewer (Stub Reviewer) did not approve this: deletes the build");
    // the old held card offered the raw key, a standing grant for a
    // destructive command; the ordinary card never does
    expect(approvalKey("shell", "rm -rf build")).toBeTruthy();
    expect(offerableApprovalKey("shell", "rm -rf build")).toBeUndefined();
    expect(held?.card?.allowKey).toBeUndefined();
    await release(bot, held!.card!.requestId!);
  }, 90_000);

  it("Watch, full-auto instance: the turn is not held, and each step is reviewed after the fact", async () => {
    verdict = { allow: false, reason: "a build was not requested" };
    const bot = await makeBot("acpSteps", { name: "Stepper", autoReview: "shadow" });
    await send(bot);
    const row = await decision((r) => r.botId === bot.id && r.decision === "review-would-deny");
    expect(row).toMatchObject({ source: "auto-review-watch", summary: "pnpm build", reviewer: "reviewer" });
    expect(reviewPrompts.at(-1)).toContain("has just started on its own");
    // Watch never stops anything
    const rows: DecisionRow[] = (await api("GET", "/api/decisions")).body.decisions;
    expect(rows.some((r) => r.botId === bot.id && r.decision === "review-stopped-turn")).toBe(false);
  }, 90_000);

  it("Watch: a message to another bot is a step like any other, reviewed after the fact", async () => {
    // ask_bot has no transcript row of its own, and its handler used to leave
    // before the step watch, so the one tool that messages another bot was
    // never reviewed on an engine that runs it without asking.
    verdict = { allow: false, reason: "messaging a peer was not requested" };
    const bot = await makeBot("acpAskBot", { name: "Messenger", autoReview: "shadow" });
    await send(bot);
    const row = await decision((r) => r.botId === bot.id && r.decision === "review-would-deny");
    expect(row, `the ask_bot step was never reviewed. stderr:\n${stderr.slice(-2000)}`).toMatchObject({
      source: "auto-review-watch",
      tool: "mcp__agents__ask_bot",
      reviewer: "reviewer",
    });
  }, 90_000);

  it("On, an engine that never asks: a refused step stops the turn instead of claiming to hold it", async () => {
    // pi runs its own bash without a card in every mode, so nothing can be
    // held; the step watch reviews the step while it runs and stops the turn.
    verdict = { allow: false, reason: "a deploy was not requested" };
    const bot = await makeBot("pi", { name: "Deployer", autoReview: "enforce" }, "ollama-cloud/glm-5.2");
    await send(bot);

    const stopped = await decision((r) => r.botId === bot.id && r.decision === "review-stopped-turn", 45_000);
    if (!stopped) {
      const rows: DecisionRow[] = (await api("GET", "/api/decisions")).body.decisions;
      throw new Error(
        `the refused step never stopped the turn.\nrows: ${JSON.stringify(rows.filter((r) => r.botId === bot.id))}\nmessages: ${JSON.stringify(await threadMessages(bot.threadId)).slice(0, 3000)}\nstderr:\n${stderr.slice(-2000)}`,
      );
    }
    expect(stopped).toMatchObject({
      source: "auto-review",
      rule: "a deploy was not requested",
      reviewer: "reviewer",
      tool: "bash",
      summary: "make deploy",
    });
    const chip = await waitFor(async () =>
      (await threadMessages(bot.threadId)).find(
        (m) => m.tool?.name?.startsWith("review stopped the turn after bash (Stub Reviewer)"),
      ),
    );
    expect(chip).toBeTruthy();
    // and the turn really ended: the bot is no longer busy, well before the
    // step's own 60 seconds were up
    const idle = await waitFor(async () => {
      const bots: Array<{ id: string; busy?: boolean }> = (await api("GET", "/api/bots")).body.bots;
      return bots.find((candidate) => candidate.id === bot.id && !candidate.busy);
    }, 20_000);
    expect(idle).toBeTruthy();
  }, 120_000);

  // The HTTP lanes (MiniMax, Grok on the xAI API, OpenAI-compatible) used to
  // be greyed out too.  Their tool calls go through the in-process broker
  // into the same fold, and they now review their own asks with a tool-free
  // call to the same endpoint.
  it("HTTP lane, On: the engine reviews its own ask, and a refusal keeps the card open", async () => {
    verdict = { allow: false, reason: "not a file the owner wants" };
    const before = reviewPrompts.length;
    const bot = await makeBot("reviewer", { name: "Compat Refused", autoReview: "enforce" }, "stub-reviewer");
    await send(bot);
    const row = await decision((r) => r.botId === bot.id && r.decision === "card-shown" && r.source === "auto-review");
    if (!row) {
      throw new Error(`no reviewed card.  offered tools: ${offeredTools.join(", ")}\nstderr:\n${stderr.slice(-2000)}`);
    }
    // the bot's own engine reviewed it: no fallback was needed
    expect(row).toMatchObject({ rule: "not a file the owner wants", reviewer: "reviewer" });
    expect(reviewPrompts.length).toBeGreaterThan(before);
    const open = await card(bot.threadId);
    expect(open?.card?.answered).toBeUndefined();
    expect(open?.card?.held).toBe("The reviewer (Stub Reviewer) did not approve this: not a file the owner wants");
    const rows: DecisionRow[] = (await api("GET", "/api/decisions")).body.decisions;
    expect(rows.some((r) => r.botId === bot.id && r.decision === "auto-approved")).toBe(false);
    await release(bot, open!.card!.requestId!);
  }, 90_000);

  it("HTTP lane, On: a different engine reviews the lane's own action first, so a model is not its own first judge", async () => {
    verdict = { allow: false, reason: "not this file" };
    const bot = await makeBot("lane", { name: "Second Lane Bot", autoReview: "enforce" }, "stub-reviewer");
    await send(bot);
    const row = await decision((r) => r.botId === bot.id && r.decision === "card-shown" && r.source === "auto-review");
    if (!row) throw new Error(`no reviewed card.  stderr:\n${stderr.slice(-2000)}`);
    // Automatic's pick, not the lane itself, answered
    expect(row).toMatchObject({ rule: "not this file", reviewer: "reviewer" });
    // the brief went in the system role, the action in the user turn
    expect(lastReviewRoles).toEqual(["system", "user"]);
    const open = await card(bot.threadId);
    await release(bot, open!.card!.requestId!);
  }, 90_000);

  it("HTTP lane, Watch: the engine records its own review and the card stays with the person", async () => {
    verdict = { allow: true, reason: "a scratch note" };
    const bot = await makeBot("reviewer", { name: "Compat Watched", autoReview: "shadow" }, "stub-reviewer");
    await send(bot);
    const row = await decision((r) => r.botId === bot.id && r.decision === "review-would-approve");
    expect(row).toMatchObject({ source: "auto-review-shadow", reviewer: "reviewer" });
    const open = await card(bot.threadId);
    expect(open?.card?.answered).toBeUndefined();
    await release(bot, open!.card!.requestId!);
  }, 90_000);
});
