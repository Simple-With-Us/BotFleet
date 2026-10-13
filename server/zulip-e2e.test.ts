// The Zulip source end to end: the real harness, the fake claude CLI, and a
// fake Zulip realm.  Binds a bot through PUT /api/config, @-mentions it from
// Jay's human client, and asserts the whole path the unit tests stub out:
// the session connects, the mention starts one unattended `zulip` turn in the
// bot's thread with the untrusted wrapper, the MCP lane is told to publish
// the Zulip tools, and the turn's final reply is posted back to the same
// topic as the bot, tagged.
//
// POSIX-gated like the other CLI e2es (the fakes are shebang scripts).
import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { FakeZulip } from "./testing/fake-zulip-server.ts";
import { harnessReady } from "./testing/harness-ready.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const JAY = 9;
const PLUMBER = 101;
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("Zulip source e2e", () => {
  let child: ChildProcess;
  let home: string;
  let dump: string;
  let stderr = "";
  let botId = "";
  const fake = new FakeZulip();

  const api = async (
    method: string,
    path: string,
    body?: Record<string, string | Record<string, string | Record<string, Record<string, string>>>>,
  ): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const waitFor = async (predicate: () => Promise<boolean> | boolean, what: string, ms = 60_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    fake.addUser({ user_id: JAY, full_name: "Jay Wedgeworth", is_bot: false, role: 100 });
    fake.addUser({ user_id: PLUMBER, full_name: "BF-Plumber", email: "bf-plumber-bot@zulip.test", key: "plumber-e2e-key" });
    await fake.start();
    home = mkdtempSync(join(tmpdir(), "omb-zulip-e2e-"));
    const rcDir = join(home, "zulip-keys");
    mkdirSync(rcDir, { recursive: true });
    const rc = join(rcDir, "BF-Plumber-zuliprc");
    writeFileSync(rc, `[api]\nemail=bf-plumber-bot@zulip.test\nkey=plumber-e2e-key\nsite=${fake.url}\n`);
    chmodSync(rc, 0o600);
    dump = join(home, "claude-dump.json");
    mkdirSync(join(home, ".botfleet"), { recursive: true });
    writeFileSync(
      join(home, ".botfleet", "config.json"),
      JSON.stringify({
        instances: {
          claude: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_REPLY: "Tunnel is up.", FAKE_CLAUDE_DUMP: dump },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
        },
        zulip: { enabled: true, realm: fake.url, ownerUserId: JAY, credentialDir: rcDir },
      }),
    );
    child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, USERPROFILE: home, OMB_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 90_000;
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
  }, 120_000);

  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    await fake.stop();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it(
    "a mention from Jay wakes the bound bot, and its reply lands in the same topic as the bot",
    async () => {
      expect((await api("GET", "/api/zulip/status")).body).toMatchObject({ enabled: true, bots: [] });
      const created = (await api("POST", "/api/bots")).body.bot;
      botId = created.id;
      await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "claude", model: "claude-fake" } });
      const saved = await api("PUT", "/api/config", { zulip: { bots: { [created.id]: { role: "BF-Plumber" } } } });
      expect(saved.status).toBe(200);
      await waitFor(async () => {
        const status = (await api("GET", "/api/zulip/status")).body;
        return status.bots.some((bot: any) => bot.botId === created.id && bot.state === "connected");
      }, "the Zulip session to connect");

      fake.postStream(JAY, "agent-sync", "BF e2e tunnel", "@**BF-Plumber** is the tunnel up?", "website");

      await waitFor(() => fake.postsBy(PLUMBER).length > 0, "the reply on Zulip");
      const post = fake.postsBy(PLUMBER)[0]!;
      expect(post.display_recipient).toBe("agent-sync");
      expect(post.subject).toBe("BF e2e tunnel");
      expect(post.content).toBe("[BF-PLUMBER] Tunnel is up.");

      const bot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === created.id);
      // The turn ran in a task of its own for this conversation, never in
      // the owner's active thread, and that task was not switched to.
      expect(bot.messages.some((m: any) => m.automationSource === "zulip")).toBe(false);
      const task = bot.tasks.find((t: any) => t.title === "Zulip #agent-sync > BF e2e tunnel");
      expect(task).toBeDefined();
      expect(task.threadId).not.toBe(bot.threadId);
      const thread = (await api("GET", `/api/threads/${task.threadId}/messages`)).body.messages;
      const starter = thread.find((m: any) => m.automationSource === "zulip");
      expect(starter.role).toBe("system");
      expect(starter.text).toMatch(/^\[ZULIP INBOUND\]/);
      expect(starter.text).toContain("BEGIN_UNTRUSTED_ZULIP");
      expect(starter.text).toContain("is the tunnel up?");

      await waitFor(() => existsSync(dump), "the fake CLI's dump");
      const seen = JSON.parse(readFileSync(dump, "utf8"));
      // the turn's own MCP lane was told to publish the Zulip tools
      expect(seen.mcpConfig?.mcpServers?.agents?.env?.OMB_ZULIP).toBe("1");
      // and the key never reached the CLI's environment
      expect(JSON.stringify(seen.env)).not.toContain("plumber-e2e-key");
      // The turn's comms token outlives the turn, but its Zulip mount does
      // not: replayed once the turn is over, the endpoint refuses it.
      const grant = seen.mcpConfig?.mcpServers?.agents?.env?.OMB_COMMS_TOKEN;
      expect(grant).toBeTruthy();
      const replayed = await fetch(`${BASE}/api/internal/zulip/post`, {
        method: "POST",
        headers: { authorization: ["Bearer", grant].join(" "), "content-type": "application/json" },
        body: JSON.stringify({ channel: "agent-sync", topic: "BF e2e replay", content: "late" }),
      });
      expect(replayed.status).toBe(403);
      expect(fake.postsBy(PLUMBER)).toHaveLength(1);
    },
    150_000,
  );

  it(
    "a new message in a topic the bot follows wakes it in that topic's own task, and nothing is posted for it",
    async () => {
      expect(botId).not.toBe("");
      // Followed from the Zulip app (the tool's call is covered in hub.test):
      // the session learns it from the user_topic event.
      fake.followTopic(PLUMBER, "agent-sync", "BF e2e watch");
      await waitFor(async () => {
        const status = (await api("GET", "/api/zulip/status")).body;
        return status.bots.some((bot: any) => bot.botId === botId && bot.following === 1);
      }, "the follow to reach the session");
      const before = fake.postsBy(PLUMBER).length;
      // no mention: only the follow makes this a wake
      fake.postStream(JAY, "agent-sync", "BF e2e watch", "deploy 4326 finished", "website");
      let threadId = "";
      await waitFor(async () => {
        const bot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === botId);
        const task = bot?.tasks.find((t: any) => t.title === "Zulip #agent-sync > BF e2e watch");
        if (!task) return false;
        threadId = task.threadId;
        const thread = (await api("GET", `/api/threads/${threadId}/messages`)).body.messages;
        return thread.some((m: any) => m.role === "bot" && m.kind === "text");
      }, "the followed topic's turn to finish in its own task");
      const thread = (await api("GET", `/api/threads/${threadId}/messages`)).body.messages;
      const starter = thread.find((m: any) => m.automationSource === "zulip");
      expect(starter.text).toContain("new messages in a channel topic you follow");
      expect(starter.text).toContain("deploy 4326 finished");
      // Several drain ticks later: a followed topic's wake is never auto-replied.
      await new Promise((r) => setTimeout(r, 3_000));
      expect(fake.postsBy(PLUMBER)).toHaveLength(before);
    },
    120_000,
  );
});
