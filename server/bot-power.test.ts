import { afterEach, describe, expect, it } from "vitest";

import {
  BOT_OFF_CODE,
  BOT_OFF_COMPOSER_NOTICE,
  BOT_OFF_REFUSAL,
  BOT_OFF_SKIPPED,
  BOT_OFF_TURN_ON_LABEL,
  botIsOff,
  botOffQueuedNotSent,
  botOffRoomNotice,
} from "../shared/bot-power.ts";
import { routineFailurePhase, ROUTINE_ATTENTION_STATUSES, ROUTINE_OUTCOME_LABELS } from "../shared/routine-outcomes.ts";
import { parseBotProfilePatch } from "./bot-profile.ts";
import { botOffError, botStopRefusalMessage, decideBotStop, isBotStoppedError } from "./bot-stop-policy.ts";
import { _queuedRoomCount, _resetRoomQueue, queueRoomRound } from "./room-queue.ts";
import {
  dropQueuedForOffBot,
  drainSteeredMessages,
  queueSteeredMessage,
  queuedMessageCount,
  _queuedCount,
  type SteerStore,
} from "./steer-queue.ts";
import { mentionedBots, roomResponders, type BotRecord, type Message } from "./store.ts";
import { selectPeerBots, type AgentBot } from "./tools/agents.ts";

// The bot On/Off switch's pure pieces: the predicate, the words, the refusal,
// and the queues that must never run work for a bot that will not run it.
// The wiring into the running harness is in bot-off.test.ts and
// bot-off-wiring.test.ts.

describe("botIsOff", () => {
  it("is true only for an explicit true, so an old bot with no field is On", () => {
    expect(botIsOff({ off: true })).toBe(true);
    expect(botIsOff({ off: false })).toBe(false);
    expect(botIsOff({})).toBe(false);
    expect(botIsOff(null)).toBe(false);
    expect(botIsOff(undefined)).toBe(false);
  });
});

describe("Off copy", () => {
  it("keeps the two-space gap as a real non-breaking space plus a space, never the entity", () => {
    for (const text of [BOT_OFF_REFUSAL, BOT_OFF_COMPOSER_NOTICE, botOffQueuedNotSent(1), botOffQueuedNotSent(3), botOffRoomNotice("Scout")]) {
      expect(text).toContain("  ");
      expect(text).not.toContain("&nbsp;");
      expect(text).not.toMatch(/\bagent\b/i);
    }
  });

  it("says what the composer and the refusal say, in the owner's words", () => {
    expect(BOT_OFF_REFUSAL.replace("  ", "  ")).toBe("This bot is off.  Turn it on to chat.");
    expect(BOT_OFF_COMPOSER_NOTICE).toBe(BOT_OFF_REFUSAL);
    // A button is Title Case.
    expect(BOT_OFF_TURN_ON_LABEL).toBe("Turn On");
    // Status text is sentence case: no leading "Skipped:" capital after the colon.
    expect(BOT_OFF_SKIPPED).toBe("Skipped: this bot is off");
  });

  it("counts the dropped queued messages", () => {
    expect(botOffQueuedNotSent(1)).toContain("queued message was dropped");
    expect(botOffQueuedNotSent(2)).toContain("2 queued messages were dropped");
  });
});

describe("the Off refusal", () => {
  it("is a 409 with its own code, distinct from a stop", () => {
    const error = botOffError();
    expect(error.status).toBe(409);
    expect(error.code).toBe(BOT_OFF_CODE);
    expect(error.code).not.toBe("bot_stopped");
    expect(error.message).toBe(BOT_OFF_REFUSAL);
  });

  it("is a quiet refusal everywhere a stop is: boot recovery, card continuations and update resumes", () => {
    // Those callers drop a stop as "a decision, not a fault"; an Off bot is
    // the same decision, so retrying or remembering a failure would be wrong.
    expect(isBotStoppedError(botOffError())).toBe(true);
    expect(isBotStoppedError(Object.assign(new Error("stopped"), { code: "bot_stopped" }))).toBe(true);
    expect(isBotStoppedError(new Error("the provider is out of credit"))).toBe(false);
  });

  it("says which it is in the error's own message: turn it on, or start it again", () => {
    // The card-continuation resumes surface error.message, so the wording has to live there.
    expect(botOffError().message).toBe(BOT_OFF_REFUSAL);
    expect(botOffError().message).not.toBe(botStopRefusalMessage());
    expect(botOffError().message).toMatch(/turn it on/i);
    expect(botStopRefusalMessage()).toMatch(/start it again/i);
  });

  it("is not something a person's own message can override, unlike a stop", () => {
    // decideBotStop lets a person wake a stopped bot.  Off is refused before
    // that policy runs (startTurn), so the policy must still say what it said.
    expect(decideBotStop({ stopped: true, personInitiated: true })).toEqual({ action: "allow", clearsStop: true });
  });
});

describe("the Off field on the profile boundary", () => {
  it("is accepted from the desktop and from a paired device, as a boolean only", () => {
    expect(parseBotProfilePatch({ off: true })).toEqual({ ok: true, patch: { off: true } });
    expect(parseBotProfilePatch({ off: false }, true)).toEqual({ ok: true, patch: { off: false } });
    // Parsed from JSON, the way it arrives over the wire: a string is not a boolean.
    const wire = JSON.parse('{"off":"yes"}');
    for (const strict of [false, true]) {
      expect(parseBotProfilePatch(wire, strict)).toEqual({ ok: false, error: "off must be true or false" });
    }
  });

  it("leaves the field out entirely when the request does not name it", () => {
    // patchBot only touches keys present on the patch, so an unrelated edit
    // can never flip the switch.
    expect(parseBotProfilePatch({ name: "Scout" })).toEqual({ ok: true, patch: { name: "Scout" } });
  });
});

describe("routine outcome for a skipped receipt", () => {
  it("is a lifecycle outcome with a label, and never an attention status", () => {
    expect(routineFailurePhase("bot_off")).toBe("lifecycle");
    expect(ROUTINE_OUTCOME_LABELS.bot_off).toBe("Bot off");
    // `cancelled` is the receipt status; `missed` and `failed` would light the badge.
    const attention: readonly string[] = ROUTINE_ATTENTION_STATUSES;
    expect(attention.includes("cancelled")).toBe(false);
  });
});

describe("rooms skip an Off member like an archived one", () => {
  const members = [
    { id: "a", name: "Scout", off: true },
    { id: "b", name: "Pixel" },
    { id: "c", name: "Rook", hidden: true },
  ];

  it("never resolves an @mention of an Off member", () => {
    expect(mentionedBots("hey @Scout and @Pixel", members).map((m) => m.id)).toEqual(["b"]);
  });

  it("leaves an Off member out of @everyone, the default lead and the mention-only policy", () => {
    expect(roomResponders("@everyone status", members, { kind: "mentions" }).map((m) => m.id)).toEqual(["b"]);
    expect(roomResponders("status", members, { kind: "everyone" }).map((m) => m.id)).toEqual(["b"]);
    expect(roomResponders("status", members, { kind: "member", botId: "a" })).toEqual([]);
    expect(roomResponders("status", members, { kind: "member", botId: "b" }).map((m) => m.id)).toEqual(["b"]);
  });

  it("changes nothing for a room with no Off members", () => {
    const plain = [{ id: "a", name: "Scout" }, { id: "b", name: "Pixel" }];
    expect(roomResponders("@Scout hi", plain, { kind: "mentions" }).map((m) => m.id)).toEqual(["a"]);
  });
});

describe("the peer roster (list_bots)", () => {
  const bot = (id: string, extra: Partial<AgentBot> = {}): AgentBot => ({
    id,
    name: id,
    section: "",
    modelSelection: { model: "m" },
    ...extra,
  });

  it("flags an Off peer so a model does not spend a round on it, and adds nothing for a bot that is On", () => {
    const rows = selectPeerBots("self", [bot("self"), bot("sleepy", { off: true }), bot("awake")])!;
    expect(rows.find((row) => row.id === "sleepy")).toMatchObject({ off: true });
    const awake = rows.find((row) => row.id === "awake")!;
    expect(awake.off).toBeUndefined();
    // and nothing about it reaches the wire
    expect(JSON.stringify(awake)).not.toContain("off");
  });
});

// ── queues: nothing waits for a bot that will not run it ───────────────────
function fakeBot(id: string, threadId: string, extra: Partial<BotRecord> = {}): BotRecord {
  return {
    id,
    threadId,
    name: id,
    title: "",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "fake", model: "fake-model" },
    resumeCursors: {},
    createdAt: 0,
    ...extra,
  };
}

function fakeStore(bots: BotRecord[]): SteerStore & { messages: Message[] } {
  const messages: Message[] = [];
  let nextId = 0;
  return {
    messages,
    bot: (id) => bots.find((b) => b.id === id) ?? null,
    appendMessage: (_threadId, message) => {
      const full: Message = { id: `m${(nextId += 1)}`, at: 0, ...message };
      messages.push(full);
      return full;
    },
    patchMessage: () => null,
  };
}

describe("steer queue and an Off bot", () => {
  afterEach(() => {
    // drain everything this file queued so a failure cannot leak into a sibling test
    drainSteeredMessages(fakeStore([]), () => {});
  });

  it("drops the sends queued behind a turn when it settles Off, tells the person, and runs nothing", () => {
    const bot = fakeBot("steer-off-1", "thread-steer-off-1", { off: true });
    const store = fakeStore([bot]);
    queueSteeredMessage(bot, "first");
    queueSteeredMessage(bot, "second");
    expect(_queuedCount(bot.threadId)).toBe(2);
    const ran: string[] = [];
    drainSteeredMessages(store, (_botId, _threadId, prompt) => {
      ran.push(prompt);
    });
    expect(ran).toEqual([]);
    expect(_queuedCount(bot.threadId)).toBe(0);
    // The words were never appended as if sent; one line says they were dropped.
    expect(store.messages.map((m) => m.text)).toEqual([undefined]);
    expect(store.messages[0]?.tool?.name).toBe(botOffQueuedNotSent(2));
    expect(store.messages[0]?.tool?.ok).toBe(false);
  });

  it("still waits while the bot is busy, even if it is Off: the running turn finishes first", () => {
    const bot = fakeBot("steer-off-2", "thread-steer-off-2", { off: true, busy: true });
    const store = fakeStore([bot]);
    queueSteeredMessage(bot, "later");
    drainSteeredMessages(store, () => {});
    expect(_queuedCount(bot.threadId)).toBe(1);
    expect(store.messages).toHaveLength(0);
    // ...and settles the moment it goes idle.
    bot.busy = false;
    drainSteeredMessages(store, () => {});
    expect(_queuedCount(bot.threadId)).toBe(0);
    expect(store.messages[0]?.tool?.name).toBe(botOffQueuedNotSent(1));
  });

  it("an On bot drains exactly as before", () => {
    const bot = fakeBot("steer-on-1", "thread-steer-on-1");
    const store = fakeStore([bot]);
    queueSteeredMessage(bot, "go");
    const ran: string[] = [];
    drainSteeredMessages(store, (_botId, _threadId, prompt) => {
      ran.push(prompt);
    });
    expect(ran).toEqual(["go"]);
    expect(store.messages.map((m) => m.text)).toEqual(["go"]);
  });

  it("dropQueuedForOffBot settles every queue that bot owns and no one else's", () => {
    const mine = fakeBot("steer-off-3", "thread-steer-off-3", { off: true });
    const other = fakeBot("steer-on-2", "thread-steer-on-2");
    const store = fakeStore([mine, other]);
    queueSteeredMessage(mine, "a");
    queueSteeredMessage(other, "b");
    expect(dropQueuedForOffBot(store, mine.id)).toBe(1);
    expect(_queuedCount(mine.threadId)).toBe(0);
    expect(_queuedCount(other.threadId)).toBe(1);
    expect(store.messages).toHaveLength(1);
  });

  it("queuedMessageCount can leave out the bots that will never drain their queue", () => {
    const off = fakeBot("steer-off-4", "thread-steer-off-4", { off: true, busy: true });
    const on = fakeBot("steer-on-3", "thread-steer-on-3", { busy: true });
    queueSteeredMessage(off, "x");
    queueSteeredMessage(on, "y");
    const everything = queuedMessageCount();
    expect(queuedMessageCount((botId) => botId === off.id)).toBe(everything - 1);
  });
});

describe("room queue and an Off bot", () => {
  afterEach(() => _resetRoomQueue());

  it("can leave an Off bot's waiting rounds out of the count that holds an update", () => {
    queueRoomRound({ groupId: "g", threadId: "t", botId: "off-bot", hop: 0 }, Date.now());
    queueRoomRound({ groupId: "g", threadId: "t", botId: "on-bot", hop: 0 }, Date.now());
    expect(_queuedRoomCount()).toBe(2);
    expect(_queuedRoomCount((botId) => botId === "off-bot")).toBe(1);
  });
});
