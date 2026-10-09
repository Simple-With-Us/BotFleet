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
import type { ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
/** What the stub reviewer answers next. */
let verdict: { allow: boolean; reason: string } = { allow: true, reason: "routine" };
/** Every prompt the stub reviewer was sent. */
const reviewPrompts: string[] = [];

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
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

type Card = { id: string; kind: string; card?: { requestId?: string; answered?: string; held?: string } };

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
  return patched.body.bot as { id: string; threadId: string };
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
        res.setHeader("content-type", "application/json");
        if (req.method === "GET" && req.url?.endsWith("/models")) {
          res.end(JSON.stringify({ data: [{ id: "stub-reviewer" }] }));
          return;
        }
        const body = JSON.parse(raw || "{}") as { messages?: Array<{ content?: string }>; tools?: unknown };
        // a review request is tool-free by contract
        if (body.tools) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "a review must not carry tools" }));
          return;
        }
        reviewPrompts.push(String(body.messages?.[0]?.content ?? ""));
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }] }));
      });
    });
    await new Promise<void>((resolve) => reviewer.listen(0, "127.0.0.1", resolve));
    const reviewerUrl = `http://127.0.0.1:${(reviewer.address() as AddressInfo).port}/v1`;

    chmodSync(FAKE_CLI, 0o755);
    chmodSync(FAKE_PI_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-auto-review-e2e-"));
    mkdirSync(join(home, ".botfleet"), { recursive: true });
    writeFileSync(
      join(home, ".botfleet", "config.json"),
      JSON.stringify({
        autoReview: { fallbackReviewer: "reviewer" },
        instances: {
          acp: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "permission" }, config: { cli: FAKE_CLI, fullAuto: false } },
          acpAuto: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "permission" }, config: { cli: FAKE_CLI, fullAuto: true } },
          acpSteps: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "quiet-tool-call", FAKE_ACP_QUIET_MS: "1500" },
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
        },
      }),
    );
    child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(PORT),
      },
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

  it("ships the hook and the fallback reviewer the Bot Profile reads", async () => {
    const config = (await api("GET", "/api/config")).body;
    expect(config.autoReview).toEqual({ fallbackReviewer: "reviewer" });
    const instances = (await api("GET", "/api/instances")).body.instances as Array<{
      instanceId: string;
      capabilities: Record<string, unknown>;
    }>;
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
    const bot = await makeBot("acpAuto", { name: "Held", autoReview: "enforce" });
    await send(bot);
    // a full-auto instance would have answered this itself; held, it asks
    const row = await decision((r) => r.botId === bot.id && r.decision === "card-shown" && r.source === "auto-review");
    expect(row).toMatchObject({ rule: "held and refused", tool: "shell" });
    const open = await card(bot.threadId);
    expect(open?.card?.answered).toBeUndefined();
    await release(bot, open!.card!.requestId!);
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
        (m) => (m as { tool?: { name?: string } }).tool?.name?.startsWith("review stopped the turn after bash (Stub Reviewer)"),
      ),
    );
    expect(chip).toBeTruthy();
    // and the turn really ended: the bot is no longer busy, well before the
    // step's own 60 seconds were up
    const idle = await waitFor(async () => {
      const bots = (await api("GET", "/api/bots")).body.bots as Array<{ id: string; busy?: boolean }>;
      return bots.find((candidate) => candidate.id === bot.id && !candidate.busy);
    }, 20_000);
    expect(idle).toBeTruthy();
  }, 120_000);
});
