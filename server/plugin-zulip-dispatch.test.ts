// End to end: a real Zulip mention through the real plugin sandbox to a
// dispatcher wake.  Fake realm, fake turns, real child process running
// docs/plugins/zulip-plugin.  No live credentials, no user data.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetForTests,
  decidePluginWake,
  disablePlugin,
  emitPluginTestEvent,
  enablePlugin,
  getPluginHealth,
  getPluginSettings,
  initPluginChats,
  initPluginDecisionHandler,
  initPluginRuntime,
  installPlugin,
  pluginEventSubscribers,
  setPluginSettings,
} from "./plugins.ts";
import { pluginEventEnvelopeSchema } from "../shared/plugin-events.ts";
import { FakeZulip } from "./testing/fake-zulip-server.ts";
import { ZulipHub, type ZulipHubDeps } from "./zulip/hub.ts";
import type { ZulipMessage, ZulipSettings } from "./zulip/types.ts";

const ZULIP_PLUGIN = join(process.cwd(), "docs", "plugins", "zulip-plugin");
const JAY = 9;
const PLUMBER = 101;
const DIRECTOR = 104;

let fake: FakeZulip;
let dataDir: string;
let rcDir: string;
let pluginDir: string;
let settings: ZulipSettings;
let hubs: ZulipHub[];
let turns: Array<{ botId: string; text: string; threadId: string }>;
let busy: Set<string>;
let starters: Map<string, string>;
let logs: string[];

async function waitFor(predicate: () => boolean, what: string, ms = 8_000): Promise<void> {
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

function makeHub(): ZulipHub {
  const deps: ZulipHubDeps = {
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
    timings: { coalesceMs: 10, drainIntervalMs: 10, reconcileIntervalMs: 60_000, backoffMs: [10], postSpacingMs: 0, retryBaseMs: 10 },
    pluginEvents: {
      isActive: () => pluginEventSubscribers("zulip", pluginDir).length > 0,
      decide: async (input) => {
        const stamp = new Date().toISOString();
        const parsed = pluginEventEnvelopeSchema.safeParse({
          eventId: `zulip:${input.accountId}:${input.messageId}`,
          type: "zulip.message",
          source: { platform: "zulip", accountId: input.accountId },
          occurredAt: stamp,
          receivedAt: stamp,
          refs: {
            messageId: input.messageId,
            conversationKey: input.conversationKey,
            channel: input.channel,
            topic: input.topic,
          },
          mentions: input.mentions,
          content: { text: input.contentText.slice(0, 8192), format: "text" },
          context: { botId: input.botId, wakeReason: input.wakeReason, senderKind: input.senderKind },
        });
        if (!parsed.success) return null;
        const won = await decidePluginWake(parsed.data, pluginDir);
        if (!won) return null;
        return {
          targetBotId: won.decision.targetBotId,
          continueThreadId: won.decision.continueThreadId,
          rationale: won.decision.rationale,
          hint: won.decision.replyHint,
        };
      },
    },
  };
  const hub = new ZulipHub(deps);
  hubs.push(hub);
  hub.start();
  return hub;
}

const sessionOf = (hub: ZulipHub) => {
  const session = hub.sessionFor("bot-plumber");
  if (!session) throw new Error("no session for bot-plumber");
  return session;
};

function mention(id: number): ZulipMessage {
  return {
    id,
    sender_id: JAY,
    sender_email: "jay@zulip.test",
    sender_full_name: "Jay Wedgeworth",
    client: "website",
    type: "stream",
    display_recipient: "builds",
    subject: "Wake",
    stream_id: 7,
    content: "@**BF-Plumber** deploy is stuck, please look",
    timestamp: Math.floor(Date.now() / 1000),
    flags: ["mentioned"],
  };
}

beforeEach(async () => {
  fake = new FakeZulip();
  fake.heartbeatMs = 50;
  fake.addUser({ user_id: JAY, full_name: "Jay Wedgeworth", is_bot: false, role: 100 });
  fake.addUser({ user_id: PLUMBER, full_name: "BF-Plumber", email: "bf-plumber-bot@zulip.test", key: "plumber-test-key" });
  fake.addUser({ user_id: DIRECTOR, full_name: "BF-Director", email: "bf-director-bot@zulip.test", key: "director-test-key" });
  await fake.start();
  dataDir = mkdtempSync(join(tmpdir(), "zulip-e2e-data-"));
  rcDir = mkdtempSync(join(tmpdir(), "zulip-e2e-rc-"));
  pluginDir = mkdtempSync(join(tmpdir(), "zulip-e2e-plugins-"));
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

  initPluginRuntime({
    listBots: () => [
      { id: "bot-plumber", name: "Plumber", status: "stopped", driver: "test" },
      { id: "bot-director", name: "Director", status: "stopped", driver: "test" },
    ],
    listConfigKeys: () => [],
    readConfig: () => undefined,
    logger: () => {},
  });
  initPluginChats({ listChatSummaries: () => [] });
  initPluginDecisionHandler(() => {});

  const installed = await installPlugin(ZULIP_PLUGIN, pluginDir);
  if ("error" in installed) throw new Error(installed.error);
  const configured = await setPluginSettings("zulip-wake", {
    dispatcherBotId: "bot-director",
    allowPeerWakes: true,
    routeFollowedTopics: true,
  }, pluginDir);
  if ("error" in configured) throw new Error(configured.error);
  const enabled = await enablePlugin("zulip-wake", pluginDir);
  if ("error" in enabled) throw new Error(enabled.error);
});

afterEach(async () => {
  for (const hub of hubs) await hub.stop();
  await fake.stop();
  await _resetForTests();
});

describe("zulip-wake plugin end to end", () => {
  it("installs, configures, and routes a mention to the dispatcher", async () => {
    expect(pluginEventSubscribers("zulip", pluginDir)).toEqual(["zulip-wake"]);
    const hub = makeHub();
    await waitFor(() => hub.status().bots.find((b) => b.botId === "bot-plumber")?.state === "connected", "plumber connected");
    await waitFor(() => hub.status().bots.find((b) => b.botId === "bot-director")?.state === "connected", "director connected");
    const session = sessionOf(hub);
    await hub.routeMessage(session, mention(701));
    await hub.drain();
    await waitFor(() => turns.length === 1, "one dispatcher turn");
    expect(turns[0]?.botId).toBe("bot-director");
    expect(turns[0]?.text).toContain("[PLUGIN ROUTE from BF-Plumber");
    expect(turns[0]?.text).toContain("deploy is stuck");
    expect(turns[0]?.text).toContain("builds");
  });

  it("falls back to legacy when the plugin is disabled", async () => {
    const disabled = await disablePlugin("zulip-wake", pluginDir);
    if ("error" in disabled) throw new Error(disabled.error);
    expect(pluginEventSubscribers("zulip", pluginDir)).toEqual([]);
    const hub = makeHub();
    await waitFor(() => hub.status().bots.find((b) => b.botId === "bot-plumber")?.state === "connected", "plumber connected");
    const session = sessionOf(hub);
    await hub.routeMessage(session, mention(702));
    await hub.drain();
    await waitFor(() => turns.length === 1, "one legacy turn");
    expect(turns[0]?.botId).toBe("bot-plumber");
  });

  it("serves settings, health, and test events", async () => {
    expect(getPluginSettings("zulip-wake", pluginDir)).toMatchObject({
      values: { dispatcherBotId: "bot-director" },
    });
    const health = await getPluginHealth("zulip-wake", pluginDir);
    if ("error" in health) throw new Error(health.error);
    expect(health.plugin.status).toBe("ok");
    const outcomes = await emitPluginTestEvent("zulip-wake", pluginDir);
    if ("error" in outcomes) throw new Error(outcomes.error);
    expect(outcomes.some((o) => o.result === "delivered")).toBe(true);
  });
});
