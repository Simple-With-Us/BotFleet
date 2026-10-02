// The auto-mode guards are only as good as their wiring: the Claude driver
// must carry a file-writing ask's raw path, index.ts must resolve it against
// the turn's folder and the bot's workspace, and the verdict must reach the
// card, the chip and the decision log.  The unit tests pin each piece; this
// runs the real server against the fake Claude CLI and plays the permission
// proxy over the broker socket, asserting what a person would see:
//
//   1. a Write inside the bot's folder is approved without a card
//   2. a Write outside it, through a symlink in it, or onto a shell startup
//      file gets a card that says why, and a decision row naming the guard
//   3. a command row (git clean, npm -g) gets a card even in auto mode, while
//      an ordinary command next to it is still approved
import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DecisionRow } from "./decision-log.ts";
import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { harnessReady } from "./testing/harness-ready.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

let child: ChildProcess;
let home: string;
let folder: string;
let elsewhere: string;
let stderr = "";

/** The few request bodies this test sends. */
interface BotPatch {
  name: string;
  autoApprove: boolean;
  computers: string[];
  cwd: string;
  modelSelection: { instanceId: string; model: string };
}
interface TextBody {
  text: string;
}
interface RespondBody {
  requestId: string;
  behavior: "allow" | "deny";
}

/** A card as the transcript shows it. */
interface CardView {
  held?: string;
  subtitle?: string;
  allowKey?: string;
}

/** What the broker socket sends back to the proxy. */
interface AnswerFrame {
  t: string;
  id: string;
  behavior: string;
}

const api = async (method: string, path: string, body?: BotPatch | TextBody | RespondBody): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The decision row for one request, or null when none shows up in time. */
async function waitForDecision(requestId: string, decision: string, ms = 30_000): Promise<DecisionRow | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const { body } = await api("GET", "/api/decisions");
    const rows: DecisionRow[] = body.decisions ?? [];
    const row = rows.find((r) => r.requestId === requestId && r.decision === decision);
    if (row) return row;
    if (Date.now() > deadline) return null;
    await sleep(250);
  }
}

/** The card for one request on a bot's transcript. */
async function waitForCard(botId: string, requestId: string, ms = 30_000): Promise<CardView | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { body } = await api("GET", "/api/bots");
    const bot = (body.bots ?? []).find((b: { id: string }) => b.id === botId);
    const card = bot?.messages?.find(
      (m: { kind: string; card?: { requestId?: string } }) => m.kind === "options" && m.card?.requestId === requestId,
    );
    if (card) return card.card;
    await sleep(250);
  }
  return null;
}

/** The broker socket the driver opens for a thread; the same name
 * `permissionSocketPath` in drivers/claude.ts derives, under this server's
 * data directory rather than the test process's own. */
function socketPathFor(threadId: string): string {
  const prefix = threadId.replace(/[^\w-]/g, "").slice(0, 4);
  const digest = createHash("sha256").update(threadId).digest("hex").slice(0, 4);
  return join(home, ".botfleet", `perm-${prefix}${digest}.sock`);
}

async function connectBroker(threadId: string, ms = 40_000): Promise<Socket> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const conn = connect(socketPathFor(threadId));
        conn.once("connect", () => resolve(conn));
        conn.once("error", reject);
      });
    } catch {
      if (Date.now() > deadline) throw new Error(`no broker socket for ${threadId}. stderr:\n${stderr}`);
      await sleep(250);
    }
  }
}

/** A bot in auto mode on the fake Claude CLI, working in `folder`, with its
 * turn running and a connection standing in for the permission proxy. */
async function startBot(name: string) {
  const created = await api("POST", "/api/bots");
  expect(created.status).toBe(201);
  const patched = await api("PATCH", `/api/bots/${created.body.bot.id}`, {
    name,
    autoApprove: true,
    computers: [],
    cwd: folder,
    modelSelection: { instanceId: "claude", model: "sonnet" },
  });
  expect(patched.status).toBe(200);
  const bot: { id: string; threadId: string } = patched.body.bot;
  const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: "go" });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  const conn = await connectBroker(bot.threadId);

  const answers = new Map<string, { behavior: string }>();
  let buffer = "";
  conn.on("data", (chunk) => {
    buffer += chunk;
    for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
      const message: AnswerFrame = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      if (message.t === "answer") answers.set(message.id, message);
    }
  });
  const ask = (id: string, tool: string, input: Record<string, string>) =>
    conn.write(JSON.stringify({ t: "ask", id, tool, input }) + "\n");
  const answered = async (id: string, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!answers.has(id)) {
      if (Date.now() > deadline) return null;
      await sleep(100);
    }
    return answers.get(id) ?? null;
  };
  /** Ask and expect a card: returns the card, the logged row, and denies it. */
  const expectCard = async (id: string, tool: string, input: Record<string, string>) => {
    ask(id, tool, input);
    const card = await waitForCard(bot.id, id);
    expect(card, `${tool} ${JSON.stringify(input)} never reached a card`).not.toBeNull();
    const row = await waitForDecision(id, "card-shown");
    expect(row, `${id} never reached the decision log`).not.toBeNull();
    expect((await api("POST", `/api/bots/${bot.id}/respond`, { requestId: id, behavior: "deny" })).status).toBe(200);
    return { card: card!, row: row! };
  };
  return { bot, conn, ask, answered, expectCard };
}

posixOnly("auto mode guards are wired from the Claude driver to the card", () => {
  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    // short, so the broker socket's path stays under the 104-byte limit
    home = realpathSync(mkdtempSync(join(tmpdir(), "omb-g-")));
    mkdirSync(join(home, ".botfleet"), { recursive: true });
    folder = join(home, "work");
    elsewhere = join(home, "other");
    mkdirSync(join(folder, "src"), { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    // a link inside the bot's folder that leads out of it
    symlinkSync(elsewhere, join(folder, "escape"));
    writeFileSync(
      join(home, ".botfleet", "config.json"),
      JSON.stringify({
        instances: {
          claude: {
            driver: "claudeAgent",
            displayName: "Fixture Claude",
            environment: { FAKE_CLAUDE_MODE: "hang" },
            config: { cli: FAKE_CLI, permissionMode: "acceptEdits" },
          },
        },
      }),
    );
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(PORT), FAKE_CLAUDE_MODE: "hang" };
    if (process.env.PATH) env.PATH = process.env.PATH;
    child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
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
      await sleep(150);
    }
  }, 110_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it(
    "approves a Write inside the bot's folder, and cards one that leaves it, whichever way it leaves",
    async () => {
      const { bot, ask, answered, expectCard } = await startBot("Writer");

      ask("w-inside", "Write", { file_path: join(folder, "src", "notes.txt"), content: "x" });
      expect(await answered("w-inside")).toMatchObject({ behavior: "allow" });
      const approved = await waitForDecision("w-inside", "auto-approved");
      expect(approved).toMatchObject({ source: "auto-mode", botId: bot.id, tool: "Write" });

      // plainly outside the folder
      const plain = await expectCard("w-outside", "Write", { file_path: join(elsewhere, "x.txt"), content: "x" });
      expect(plain.row).toMatchObject({ source: "system-guard", rule: "file-write:outside-roots" });
      expect(plain.card.held).toContain("outside the bot's folders");
      expect(plain.card.allowKey).toBeUndefined();

      // through a symlink that sits inside the folder
      const linked = await expectCard("w-link", "Edit", {
        file_path: join(folder, "escape", "x.txt"),
        old_string: "a",
        new_string: "b",
      });
      expect(linked.row).toMatchObject({ source: "system-guard", rule: "file-write:outside-roots" });

      // `..` after the symlink: the string reads as inside, the OS walks out
      const dotdot = await expectCard("w-dotdot", "Write", { file_path: `${folder}/escape/../x.txt`, content: "x" });
      expect(dotdot.row).toMatchObject({ source: "system-guard" });

      // a relative path and a `~` spelling mean nothing to this check
      const relative = await expectCard("w-relative", "Write", { file_path: "src/notes.txt", content: "x" });
      expect(relative.row).toMatchObject({ source: "system-guard", rule: "file-write:relative-path" });

      // a shell startup file, even inside the folder
      const rc = await expectCard("w-rc", "Write", { file_path: join(folder, ".zshrc"), content: "x" });
      expect(rc.row).toMatchObject({ source: "sensitive-guard" });
      expect(rc.card.held).toContain("sensitive");
    },
    180_000,
  );

  it(
    "cards a command row in auto mode and still approves the ordinary command beside it",
    async () => {
      const { ask, answered, expectCard } = await startBot("Runner");

      ask("c-status", "Bash", { command: "git status" });
      expect(await answered("c-status")).toMatchObject({ behavior: "allow" });
      ask("c-checkout", "Bash", { command: "git checkout -b feature/x" });
      expect(await answered("c-checkout")).toMatchObject({ behavior: "allow" });
      ask("c-install", "Bash", { command: "npm install lodash" });
      expect(await answered("c-install")).toMatchObject({ behavior: "allow" });

      const clean = await expectCard("c-clean", "Bash", { command: "git clean -fd" });
      expect(clean.row).toMatchObject({ source: "destructive-guard", rule: "git-clean" });
      expect(clean.card.held).toContain("destructive");
      expect(clean.card.allowKey).toBeUndefined();

      const global = await expectCard("c-global", "Bash", { command: "npm install -g typescript" });
      expect(global.row).toMatchObject({ source: "system-guard", rule: "global-install" });
      expect(global.card.held).toContain("changes the computer");
      expect(global.card.allowKey).toBeUndefined();

      const kill = await expectCard("c-kill", "Bash", { command: "pkill node" });
      expect(kill.row).toMatchObject({ source: "destructive-guard", rule: "pkill" });
    },
    180_000,
  );
});
