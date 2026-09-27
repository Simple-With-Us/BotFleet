// Part 1: bot.maxToolRounds → createTurnToolHost.maxRounds → loop exit.
// Unset keeps DEFAULT_TURN_LOOP_BUDGET.maxRounds (12). Invalid/empty ignored.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseBotProfilePatch, resolveMaxToolRounds } from "./bot-profile.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import {
  DEFAULT_TURN_LOOP_BUDGET,
  runTurnLoop,
  type ChatMessage,
  type ChatToolCall,
  type TurnRoundResult,
} from "./drivers/chat-completions/loop.ts";
import { Store } from "./store.ts";
import { createTurnToolHost, type TurnToolHostDeps } from "./tools/host.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

const call = (id: string): ChatToolCall => ({
  id,
  type: "function",
  function: { name: "noop", arguments: "{}" },
});

const wantsTools = (id: string): TurnRoundResult => ({
  text: "",
  toolCalls: [call(id)],
  usage: null,
});

function stubDeps(): TurnToolHostDeps {
  return {
    executeListAgentsRequest: () => ({ status: 200, body: { bots: [] } }),
    executeAskBotRequest: vi.fn(async () => ({ status: 200, body: {} })),
    executeListRoutinesRequest: () => ({
      status: 200,
      body: { now: "2026-09-12T10:00:00.000Z", timeZone: "UTC", routines: [] },
    }),
    executeDelegateBotRequest: vi.fn(
      async () => ({ status: 200, body: { queued: true, message: "Delegation queued." } }),
    ),
    executeCreateBotRequest: vi.fn(
      async () => ({ status: 201, body: { id: "bot-new", name: "Pixel", section: "Work" } }),
    ),
    executeRequestCredentialRequest: vi.fn(
      async () => ({ status: 201, body: { messageId: "msg-1", label: "key" } }),
    ),
    executeRoutineRequestRequest: vi.fn(
      async () => ({ status: 201, body: { summary: "Weekdays at 09:00" } }),
    ),
  };
}

async function exitAtRounds(maxRounds: number | undefined) {
  let rounds = 0;
  let seq = 0;
  const messages: ChatMessage[] = [{ role: "user", content: "go" }];
  const exit = await runTurnLoop({
    base: () => ({
      eventId: `e-${++seq}`,
      provider: "fake",
      threadId: "t1",
      turnId: "turn-1",
      createdAt: new Date().toISOString(),
    }),
    emit: () => {},
    messages,
    signal: new AbortController().signal,
    tools: [{ name: "noop" }],
    toolHost: {
      maxRounds,
      execute: async () => ({ kind: "result", content: "[]" }),
    },
    runRound: async () => {
      rounds += 1;
      return wantsTools(`c${rounds}`);
    },
  });
  return { exit, rounds };
}

describe("DEFAULT_TURN_LOOP_BUDGET", () => {
  it("ships maxRounds === 12 as the single SoT for unset bots", () => {
    expect(DEFAULT_TURN_LOOP_BUDGET.maxRounds).toBe(12);
  });
});

describe("maxToolRounds → host → exit", () => {
  it("unset still exits at 12", async () => {
    const { exit, rounds } = await exitAtRounds(resolveMaxToolRounds(undefined));
    expect(exit).toBe("tool_round_limit");
    expect(rounds).toBe(12);
  });

  it("set to 2 exits at 2", async () => {
    const { exit, rounds } = await exitAtRounds(resolveMaxToolRounds(2));
    expect(exit).toBe("tool_round_limit");
    expect(rounds).toBe(2);
  });

  it("invalid/empty ignored — still exits at 12", async () => {
    for (const bad of [null, "", 0, -1, 201, 1.5, "2", NaN]) {
      expect(resolveMaxToolRounds(bad), String(bad)).toBeUndefined();
    }
    const { exit, rounds } = await exitAtRounds(resolveMaxToolRounds(0));
    expect(exit).toBe("tool_round_limit");
    expect(rounds).toBe(12);
  });
});

describe("createTurnToolHost forwards maxRounds", () => {
  it("passes a resolved ceiling onto the host the loop reads", () => {
    const host = createTurnToolHost({
      botId: "bot-1",
      threadId: "thread-1",
      commsDepth: 0,
      maxRounds: resolveMaxToolRounds(5),
      deps: stubDeps(),
    });
    expect(host.maxRounds).toBe(5);
  });

  it("omits maxRounds when the bot field is unset or invalid", () => {
    const host = createTurnToolHost({
      botId: "bot-1",
      threadId: "thread-1",
      commsDepth: 0,
      maxRounds: resolveMaxToolRounds(undefined),
      deps: stubDeps(),
    });
    expect(host.maxRounds).toBeUndefined();
  });
});

describe("store → resolveMaxToolRounds", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("PATCH persists a ceiling and null clears it", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Rounder" }, { seedMessages: false });
    const set = parseBotProfilePatch({ maxToolRounds: 3 }, true);
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const updated = store.patchBot(bot.id, set.patch);
    expect(updated?.maxToolRounds).toBe(3);
    expect(resolveMaxToolRounds(updated?.maxToolRounds)).toBe(3);

    const clear = parseBotProfilePatch({ maxToolRounds: null }, true);
    expect(clear.ok).toBe(true);
    if (!clear.ok) return;
    const after = store.patchBot(bot.id, clear.patch);
    expect(after?.maxToolRounds).toBeUndefined();
    expect(resolveMaxToolRounds(after?.maxToolRounds)).toBeUndefined();
  });
});
