// Plugin-platform routing for Zulip wakes, against live fake sessions:
// qualifying messages divert to the dispatcher through a bounded plugin
// decision, with the legacy direct wake as the fallback.  Decisions are
// stubbed here (no sandboxes); the full plugin path runs in
// plugin-zulip-dispatch.test.ts.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeZulip } from "./testing/fake-zulip-server.ts";
import { ZulipHub, type ZulipHubDeps, type ZulipPluginDecision, type ZulipSession } from "./zulip/hub.ts";
import type { ZulipMessage, ZulipSettings } from "./zulip/types.ts";

const JAY = 9;
const PLUMBER = 101;
const DIRECTOR = 104;

let fake: FakeZulip;
let dataDir: string;
let rcDir: string;
let settings: ZulipSettings;
let hubs: ZulipHub[];
let turns: Array<{ botId: string; text: string; threadId: string }>;
let busy: Set<string>;
let starters: Map<string, string>;
let logs: string[];
let nextDecision: ZulipPluginDecision | null;
let decideCalls: number;

async function waitFor(predicate: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${logs.join("\n")}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function writeRc(role: string, email: string, key: string): void {
  const path = join(rcDir, `${role}-zuliprc`);
  writeFileSync(path, `[api]\nemail=${email}\nkey=${key}\nsite=${fake.url}\n`);
  chmodSync(path, 0o600);
}

function makeHub(over: Partial<ZulipHubDeps> = {}): ZulipHub {
  const hub = new ZulipHub({
    dataDir,
    settings: () => settings,
    botExists: (botId) => botId === "bot-plumber" || botId === "bot-director",
    isBusy: (botId) => busy.has(botId),
    busyThread: (botId) => (busy.has(botId) ? `thread-${botId}` : undefined),
    turnStarter: (threadId) => starters.get(threadId),
    startTurn: async (botId, text) => {
      const threadId = `thread-${botId}`;
      turns.push({ botId, text, threadId });
      busy.add(botId);
      const triggerMessageId = `trigger-${turns.length}`;
      starters.set(threadId, triggerMessageId);
      return { threadId, triggerMessageId };
    },
    log: (line) => logs.push(line),
    env: {},
    timings: {
      coalesceMs: 10,
      drainIntervalMs: 10,
      reconcileIntervalMs: 60_000,
      backoffMs: [10, 20],
      postSpacingMs: 0,
      retryBaseMs: 10,
      eventsTimeoutMs: 5_000,
    },
    pluginEvents: {
      isActive: () => true,
      decide: async () => {
        decideCalls += 1;
        return nextDecision;
      },
    },
    ...over,
  });
  hubs.push(hub);
  hub.start();
  return hub;
}

const sessionOf = (hub: ZulipHub, botId: string): ZulipSession => {
  const session = hub.sessionFor(botId);
  if (!session) throw new Error(`no session for ${botId}`);
  return session;
};

const connected = (hub: ZulipHub, botId: string): Promise<void> =>
  waitFor(() => hub.status().bots.find((b) => b.botId === botId)?.state === "connected", `${botId} connected`);

function mention(id: number): ZulipMessage {
  return {
    id,
    sender_id: JAY,
    sender_email: "jay@zulip.test",
    sender_full_name: "Jay Wedgeworth",
    client: "website",
    type: "stream",
    display_recipient: "builds",
    subject: "Routing",
    stream_id: 7,
    content: "@**BF-Plumber** please check this",
    timestamp: Math.floor(Date.now() / 1000),
    flags: ["mentioned"],
  } as ZulipMessage;
}

beforeEach(async () => {
  fake = new FakeZulip();
  fake.heartbeatMs = 50;
  fake.addUser({ user_id: JAY, full_name: "Jay Wedgeworth", is_bot: false, role: 100 });
  fake.addUser({ user_id: PLUMBER, full_name: "BF-Plumber", email: "bf-plumber-bot@zulip.test", key: "plumber-test-key" });
  fake.addUser({ user_id: DIRECTOR, full_name: "BF-Director", email: "bf-director-bot@zulip.test", key: "director-test-key" });
  await fake.start();
  dataDir = mkdtempSync(join(tmpdir(), "zulip-route-data-"));
  rcDir = mkdtempSync(join(tmpdir(), "zulip-route-rc-"));
  writeRc("BF-Plumber", "bf-plumber-bot@zulip.test", "plumber-test-key");
  writeRc("BF-Director", "bf-director-bot@zulip.test", "director-test-key");
  settings = {
    enabled: true,
    realm: fake.url,
    ownerUserId: JAY,
    credentialDir: rcDir,
    bots: { "bot-plumber": { role: "BF-Plumber" }, "bot-director": { role: "BF-Director" } },
    postChannels: ["builds"],
  };
  hubs = [];
  turns = [];
  busy = new Set();
  starters = new Map();
  logs = [];
  nextDecision = null;
  decideCalls = 0;
});

afterEach(async () => {
  for (const hub of hubs) await hub.stop();
  await fake.stop();
});

describe("plugin-routed Zulip wakes", () => {
  it("wakes the mentioned bot directly when no plugin hook is configured", async () => {
    const hub = makeHub({ pluginEvents: undefined });
    await connected(hub, "bot-plumber");
    hub.handleMessage(sessionOf(hub, "bot-plumber"), mention(901));
    await hub.drain();
    await waitFor(() => turns.length === 1, "one legacy turn");
    expect(turns[0]?.botId).toBe("bot-plumber");
    expect(decideCalls).toBe(0);
  });

  it("routes a mention to the dispatcher with the routing hint", async () => {
    const hub = makeHub();
    await connected(hub, "bot-plumber");
    await connected(hub, "bot-director");
    nextDecision = { targetBotId: "bot-director", rationale: "owner mention", hint: "reply in builds" };
    await hub.routeMessage(sessionOf(hub, "bot-plumber"), mention(902));
    await hub.drain();
    await waitFor(() => turns.length === 1, "one routed turn");
    expect(decideCalls).toBe(1);
    expect(turns[0]?.botId).toBe("bot-director");
    expect(turns[0]?.text).toContain("[PLUGIN ROUTE from BF-Plumber");
    expect(turns[0]?.text).toContain("reply in builds");
  });

  it("falls back to the legacy wake when the plugin declines", async () => {
    const hub = makeHub();
    await connected(hub, "bot-plumber");
    nextDecision = null;
    await hub.routeMessage(sessionOf(hub, "bot-plumber"), mention(903));
    await hub.drain();
    await waitFor(() => turns.length === 1, "one legacy turn");
    expect(turns[0]?.botId).toBe("bot-plumber");
  });

  it("falls back to legacy when the target is unknown", async () => {
    const hub = makeHub();
    await connected(hub, "bot-plumber");
    nextDecision = { targetBotId: "bot-ghost" };
    await hub.routeMessage(sessionOf(hub, "bot-plumber"), mention(904));
    await hub.drain();
    await waitFor(() => turns.length === 1, "one legacy turn");
    expect(turns[0]?.botId).toBe("bot-plumber");
    expect(logs.some((line) => line.includes("plugin target unknown"))).toBe(true);
  });

  it("wakes only once when two lanes deliver the same message", async () => {
    const hub = makeHub();
    await connected(hub, "bot-plumber");
    await connected(hub, "bot-director");
    nextDecision = { targetBotId: "bot-director" };
    const session = sessionOf(hub, "bot-plumber");
    await hub.routeMessage(session, mention(905));
    await hub.routeMessage(session, mention(905));
    hub.handleMessage(session, mention(905));
    await hub.drain();
    await waitFor(() => turns.length === 1, "one routed turn");
    expect(turns.filter((t) => t.botId === "bot-director")).toHaveLength(1);
    expect(turns).toHaveLength(1);
  });

  it("enforces dispatcher budgets on routed wakes", async () => {
    settings.budgets = { ownerWakesPerHour: 0 };
    const hub = makeHub();
    await connected(hub, "bot-plumber");
    await connected(hub, "bot-director");
    nextDecision = { targetBotId: "bot-director" };
    await hub.routeMessage(sessionOf(hub, "bot-plumber"), mention(906));
    await hub.drain();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(turns).toHaveLength(0);
    expect(logs.some((line) => line.includes("owner_budget"))).toBe(true);
  });
});
