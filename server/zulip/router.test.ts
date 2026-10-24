import { describe, expect, it } from "vitest";

import { followKey } from "./format.ts";
import { DEFAULT_OWNER_CLIENTS, classify, wakeVerdict, type RouterContext } from "./router.ts";
import type { ZulipMessage, ZulipUser } from "./types.ts";

const NOW = 1_790_000_000_000;
const me = { userId: 101, fullName: "BF-Plumber", email: "bf-plumber-bot@zulip.test" };
const users = new Map<number, ZulipUser>([
  [9, { user_id: 9, full_name: "Jay Wedgeworth", is_bot: false }],
  [50, { user_id: 50, full_name: "Claude", is_bot: true, bot_type: 1 }],
  [60, { user_id: 60, full_name: "Sentry", is_bot: true, bot_type: 2 }],
  [101, { user_id: 101, full_name: "BF-Plumber", is_bot: true, bot_type: 1 }],
]);
const ctx: RouterContext = {
  me,
  ownerUserId: 9,
  ownerClients: new Set(DEFAULT_OWNER_CLIENTS),
  users,
  nowMs: NOW,
  staleMs: 30 * 60_000,
};

function stream(over: Partial<ZulipMessage>): ZulipMessage {
  return {
    id: 1,
    sender_id: 50,
    client: "ZulipPython",
    type: "stream",
    display_recipient: "agent-sync",
    subject: "BF tunnel",
    content: "@**BF-Plumber** look",
    timestamp: NOW / 1000,
    flags: ["mentioned"],
    ...over,
  };
}

function dm(sender: number, others: number[], over: Partial<ZulipMessage> = {}): ZulipMessage {
  return stream({
    type: "private",
    display_recipient: [sender, ...others].map((id) => ({ id })),
    subject: "",
    sender_id: sender,
    content: "hello",
    flags: [],
    ...over,
  });
}

const verdict = (message: ZulipMessage) => wakeVerdict(classify(message, ctx));

describe("who wakes a BF bot", () => {
  it("drops the bot's own posts", () => {
    expect(verdict(stream({ sender_id: 101 }))).toEqual({ wake: null, reason: "own" });
  });

  it("wakes on Jay from a human app, and only then calls it the owner", () => {
    expect(verdict(stream({ sender_id: 9, client: "website" }))).toEqual({ wake: "owner", via: "mention" });
    expect(verdict(stream({ sender_id: 9, client: "ZulipMobile" }))).toEqual({ wake: "owner", via: "mention" });
    // Jay's id from an API client is a peer, flagged, and never wakes
    const c = classify(stream({ sender_id: 9, client: "ZulipPython" }), ctx);
    expect(c.owner).toBe(false);
    expect(c.ownerViaApi).toBe(true);
    expect(wakeVerdict(c)).toEqual({ wake: null, reason: "owner_via_api" });
  });

  it("wakes a peer bot's direct mention, but not a stale one", () => {
    expect(verdict(stream({}))).toEqual({ wake: "peer", via: "mention" });
    expect(verdict(stream({ timestamp: NOW / 1000 - 3600 }))).toEqual({ wake: null, reason: "stale" });
    // the owner is exempt from the stale cutoff
    expect(verdict(stream({ sender_id: 9, client: "website", timestamp: NOW / 1000 - 3600 }))).toEqual({ wake: "owner", via: "mention" });
  });

  it("does not wake on a mention inside code or without the flag, or on a wildcard", () => {
    expect(verdict(stream({ content: "`@**BF-Plumber**`" }))).toEqual({ wake: null, reason: "not_a_mention" });
    expect(verdict(stream({ flags: [] }))).toEqual({ wake: null, reason: "not_a_mention" });
    expect(verdict(stream({ content: "@**all** heads up", flags: ["stream_wildcard_mentioned"] }))).toEqual({
      wake: null,
      reason: "wildcard",
    });
  });

  it("treats an incoming-webhook bot as data", () => {
    expect(verdict(stream({ sender_id: 60 }))).toEqual({ wake: null, reason: "webhook_sender" });
  });

  it("wakes on Jay's 1:1 DM, never on a group DM, and on a peer bot's 1:1 DM as a peer", () => {
    expect(verdict(dm(9, [101], { client: "website" }))).toEqual({ wake: "owner", via: "dm" });
    expect(classify(dm(9, [101], { client: "website" }), ctx).origin).toEqual({ kind: "dm", userId: 9 });
    expect(verdict(dm(9, [101, 50], { client: "website" }))).toEqual({ wake: null, reason: "group_dm" });
    // Peer requests are screened, not refused: no allowlist gates the wake.
    expect(verdict(dm(50, [101]))).toEqual({ wake: "peer", via: "dm" });
    expect(verdict(dm(50, [101], { timestamp: NOW / 1000 - 3600 }))).toEqual({ wake: null, reason: "stale" });
    // An incoming-webhook bot never wakes, by DM or otherwise.
    expect(verdict(dm(60, [101]))).toEqual({ wake: null, reason: "webhook_sender" });
  });

  it("counts an unknown sender as a bot", () => {
    expect(classify(stream({ sender_id: 777 }), ctx).senderIsBot).toBe(true);
    expect(verdict(dm(777, [101]))).toEqual({ wake: "peer", via: "dm" });
  });
});

describe("followed topics", () => {
  const followed = new Set([followKey(7, "BF watch")]);
  const fctx: RouterContext = { ...ctx, followed };
  const watch = (over: Partial<ZulipMessage>) =>
    stream({ stream_id: 7, subject: "BF watch", content: "deploy finished", flags: [], ...over });
  const fverdict = (message: ZulipMessage) => wakeVerdict(classify(message, fctx));

  it("wakes on any new message in a followed topic, mention or not", () => {
    expect(fverdict(watch({}))).toEqual({ wake: "peer", via: "followed" });
    expect(fverdict(watch({ sender_id: 9, client: "website" }))).toEqual({ wake: "owner", via: "followed" });
    // the topic is matched the way Zulip matches it: case folded
    expect(fverdict(watch({ subject: "bf WATCH" }))).toEqual({ wake: "peer", via: "followed" });
    // a resolved topic is another name to Zulip; its follow arrives as its own event
    expect(fverdict(watch({ subject: "✔ BF watch" }))).toEqual({ wake: null, reason: "not_a_mention" });
    // a mention there is still a mention
    expect(fverdict(watch({ content: "@**BF-Plumber** look", flags: ["mentioned"] }))).toEqual({ wake: "peer", via: "mention" });
  });

  it("never wakes on its own post, an incoming-webhook bot, Jay's account from an API client, or a stale peer there", () => {
    expect(fverdict(watch({ sender_id: 101 }))).toEqual({ wake: null, reason: "own" });
    expect(fverdict(watch({ sender_id: 60 }))).toEqual({ wake: null, reason: "webhook_sender" });
    expect(fverdict(watch({ sender_id: 9, client: "ZulipPython" }))).toEqual({ wake: null, reason: "owner_via_api" });
    expect(fverdict(watch({ timestamp: NOW / 1000 - 3600 }))).toEqual({ wake: null, reason: "stale" });
  });

  it("does not wake on another topic, another channel with the same topic, or a message with no channel id", () => {
    expect(fverdict(watch({ subject: "BF other" }))).toEqual({ wake: null, reason: "not_a_mention" });
    expect(fverdict(watch({ stream_id: 8 }))).toEqual({ wake: null, reason: "not_a_mention" });
    expect(fverdict(watch({ stream_id: undefined }))).toEqual({ wake: null, reason: "not_a_mention" });
    // and nothing is followed without the set
    expect(verdict(watch({}))).toEqual({ wake: null, reason: "not_a_mention" });
  });
});
