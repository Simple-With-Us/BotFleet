import { describe, expect, it } from "vitest";

import { followKey } from "./format.ts";
import { DEFAULT_OWNER_CLIENTS, classify, seatTagForEmail, wakeVerdict, type RouterContext } from "./router.ts";
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

/** The reason a message did not wake the bot, or null when it did. */
const refusal = (message: ZulipMessage): string | null => {
  const v = verdict(message);
  return v.wake === null ? v.reason : null;
};

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
    // @everyone is inbox-only:  it never wakes, and it keeps the wildcard reason
    expect(verdict(stream({ content: "@**everyone** heads up", flags: ["wildcard_mentioned"] }))).toEqual({
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

describe("the no-wake marker", () => {
  const followed = new Set([followKey(7, "BF watch")]);
  const fctx: RouterContext = { ...ctx, followed };
  const watch = (over: Partial<ZulipMessage>) =>
    stream({ stream_id: 7, subject: "BF watch", content: "deploy finished", flags: [], ...over });

  it("wakes nobody when the message starts with the eyes marker", () => {
    // Jay's DM
    expect(verdict(dm(9, [101], { client: "website", content: ":eyes: hi" }))).toEqual({ wake: null, reason: "no_wake" });
    // Jay's mention
    expect(verdict(stream({ sender_id: 9, client: "website", content: ":eyes: @**BF-Plumber** look" }))).toEqual({
      wake: null,
      reason: "no_wake",
    });
    // a followed topic
    expect(wakeVerdict(classify(watch({ content: ":eyes: hi" }), fctx))).toEqual({ wake: null, reason: "no_wake" });
    // a peer's mention
    expect(verdict(stream({ content: ":eyes: @**BF-Plumber** look" }))).toEqual({ wake: null, reason: "no_wake" });
  });

  it("takes the literal emoji as well as the shortcode", () => {
    expect(verdict(stream({ content: "\u{1F440} hi" }))).toEqual({ wake: null, reason: "no_wake" });
    expect(verdict(stream({ sender_id: 9, client: "website", content: "\u{1F440} @**BF-Plumber** look" }))).toEqual({
      wake: null,
      reason: "no_wake",
    });
  });

  it("ignores leading whitespace", () => {
    expect(verdict(stream({ content: "\n  :eyes: hi" }))).toEqual({ wake: null, reason: "no_wake" });
  });

  it("takes the marker after the sender's own seat tag", () => {
    expect(
      verdict(stream({ sender_email: "bf-plumber-bot@zulip.test", content: "[BF-PLUMBER] :eyes: hi" })),
    ).toEqual({ wake: null, reason: "no_wake" });
  });

  it("takes the marker after a tag that carries a session", () => {
    expect(verdict(stream({ sender_email: "other-bot@zulip.test", content: "[BF-PLUMBER\u00b7abc123] :eyes: hi" }))).toEqual({
      wake: null,
      reason: "no_wake",
    });
  });

  it("does not take the marker after another seat's tag", () => {
    expect(refusal(stream({ sender_email: "bf-plumber-bot@zulip.test", content: "[TODO] :eyes: hi" }))).not.toBe("no_wake");
    // a tag for another seat with no session is not the sender's own
    expect(
      refusal(stream({ sender_email: "compiler-grok-bot@zulip.test", content: "[BF-PLUMBER] :eyes: hi" })),
    ).not.toBe("no_wake");
  });

  it("does not take a marker mid-sentence, in a quote, or in code", () => {
    expect(refusal(stream({ content: "heads up :eyes: hi" }))).not.toBe("no_wake");
    expect(refusal(stream({ content: "> :eyes: hi" }))).not.toBe("no_wake");
    expect(refusal(stream({ content: "`:eyes:` hi" }))).not.toBe("no_wake");
  });

  it("maps a bot email to its seat tag", () => {
    expect(seatTagForEmail("bf-plumber-bot@zulip.test")).toBe("BF-PLUMBER");
    expect(seatTagForEmail("compiler-grok-bot@zulip.test")).toBe("GB-COMPILER");
    expect(seatTagForEmail("mm-bot@zulip.test")).toBe("MM");
    expect(seatTagForEmail("")).toBeNull();
  });
});

describe("@all broadcasts", () => {
  const owner = { sender_id: 9, client: "website" };

  it("wakes the bot when Jay broadcasts in a channel", () => {
    expect(verdict(stream({ ...owner, content: "@**all** heads up", flags: ["stream_wildcard_mentioned"] }))).toEqual({
      wake: "owner",
      via: "broadcast",
    });
    expect(verdict(stream({ ...owner, content: "@**channel** heads up", flags: ["stream_wildcard_mentioned"] }))).toEqual({
      wake: "owner",
      via: "broadcast",
    });
    expect(verdict(stream({ ...owner, content: "@**stream** heads up", flags: ["stream_wildcard_mentioned"] }))).toEqual({
      wake: "owner",
      via: "broadcast",
    });
    // the bare forms count too
    expect(verdict(stream({ ...owner, content: "@all heads up", flags: [] }))).toEqual({ wake: "owner", via: "broadcast" });
  });

  it("wakes a peer bot's broadcast as a peer, and not a stale one", () => {
    expect(verdict(stream({ content: "@**all** heads up", flags: ["stream_wildcard_mentioned"] }))).toEqual({
      wake: "peer",
      via: "broadcast",
    });
    expect(verdict(stream({ content: "@**all** heads up", timestamp: NOW / 1000 - 3600 }))).toEqual({
      wake: null,
      reason: "stale",
    });
  });

  it("does not wake on @everyone or @topic", () => {
    expect(verdict(stream({ ...owner, content: "@**everyone** heads up", flags: ["wildcard_mentioned"] }))).toEqual({
      wake: null,
      reason: "wildcard",
    });
    expect(verdict(stream({ ...owner, content: "@**topic** heads up", flags: ["topic_wildcard_mentioned"] }))).toEqual({
      wake: null,
      reason: "wildcard",
    });
  });

  it("does not wake on a silent mention, a webhook bot, or Jay's account from an API client", () => {
    expect(verdict(stream({ ...owner, content: "@_**all** heads up", flags: [] }))).toEqual({
      wake: null,
      reason: "not_a_mention",
    });
    expect(verdict(stream({ sender_id: 60, content: "@**all** heads up" }))).toEqual({
      wake: null,
      reason: "webhook_sender",
    });
    expect(verdict(stream({ sender_id: 9, client: "ZulipPython", content: "@**all** heads up" }))).toEqual({
      wake: null,
      reason: "owner_via_api",
    });
  });

  it("does not wake on a broadcast inside code", () => {
    expect(verdict(stream({ ...owner, content: "`@**all**`", flags: [] }))).toEqual({
      wake: null,
      reason: "not_a_mention",
    });
    expect(verdict(stream({ ...owner, content: "```\n@**all**\n```", flags: [] }))).toEqual({
      wake: null,
      reason: "not_a_mention",
    });
  });
});
