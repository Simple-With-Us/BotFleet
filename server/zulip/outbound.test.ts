import { describe, expect, it } from "vitest";

import { ZULIP_MAX_CHUNKS, checkContent, dmRefusal, resolveTarget, secretRefusal, type DmDirectory } from "./outbound.ts";
import type { ZulipUser } from "./types.ts";

// An obviously fake value, shaped like the real thing (32 mixed-case letters
// and digits) so the scanner fires.  Built at runtime: no token-shaped literal
// sits in the source for a scanner or a reviewer to take for a live key.
const FAKE_ZULIP_KEY = ["FakeZulip", "Key", "0".repeat(16), "aB12"].join("");
const policy = { postChannels: ["builds"], names: ["BF-Plumber", "BF-Plumber"] };
const streamOrigin = { kind: "stream" as const, channel: "agent-sync", topic: "BF tunnel" };

describe("the outbound secret scan", () => {
  it("refuses a loaded key, a credential-shaped value and a Zulip-shaped token", () => {
    expect(secretRefusal(`key is ${FAKE_ZULIP_KEY}`, [FAKE_ZULIP_KEY])).toBe("a loaded Zulip credential");
    expect(secretRefusal("the db password: hunter2hunter2", [])).toBe("a credential-shaped value");
    expect(secretRefusal(`token ${FAKE_ZULIP_KEY}`, [])).toBe("a Zulip-shaped API key");
  });

  it("lets ordinary text through, hashes included", () => {
    expect(secretRefusal("Deploy #4326 done.  Commit 3f55a1c, digest d41d8cd98f00b204e9800998ecf8427e.", [])).toBeNull();
  });

  it("names the kind of match, never the text", () => {
    const result = checkContent(`here: ${FAKE_ZULIP_KEY}`, [FAKE_ZULIP_KEY]);
    expect("error" in result && result.error).toMatch(/loaded Zulip credential/);
    expect("error" in result && result.error).not.toContain(FAKE_ZULIP_KEY);
  });
});

describe("where a post may go", () => {
  it("sends zulip_reply to the origin and nowhere else", () => {
    expect(resolveTarget("reply", { channel: "elsewhere", topic: "x" }, streamOrigin, policy)).toEqual({
      target: { kind: "stream", channel: "agent-sync", topic: "BF tunnel" },
      toOrigin: true,
    });
    expect(resolveTarget("reply", {}, undefined, policy)).toMatchObject({ error: expect.stringMatching(/not started from Zulip/) });
  });

  it("lets a DM go only to the origin's sender when no member directory is known", () => {
    const dmOrigin = { kind: "dm" as const, userId: 9 };
    expect(resolveTarget("post", { dm_user_id: 9 }, dmOrigin, policy)).toEqual({
      target: { kind: "dm", userIds: [9] },
      toOrigin: true,
    });
    expect(resolveTarget("post", { dm_user_id: 50 }, dmOrigin, policy)).toMatchObject({ error: expect.stringMatching(/only to the person/) });
    expect(resolveTarget("post", { dm_user_id: 9 }, streamOrigin, policy)).toMatchObject({ error: expect.stringMatching(/only to the person/) });
    expect(resolveTarget("post", { dm_user_id: 9 }, undefined, policy)).toMatchObject({ error: expect.any(String) });
  });

  it("lets a DM go out to the owner or any active bot, and nobody else", () => {
    const users = new Map<number, ZulipUser>([
      [9, { user_id: 9, full_name: "Jay Wedgeworth", is_bot: false }],
      [50, { user_id: 50, full_name: "Claude", is_bot: true, bot_type: 1 }],
      [60, { user_id: 60, full_name: "Sentry", is_bot: true, bot_type: 2 }],
      [70, { user_id: 70, full_name: "A Person", is_bot: false }],
      [80, { user_id: 80, full_name: "Gone Bot", is_bot: true, bot_type: 1, is_active: false }],
      [101, { user_id: 101, full_name: "BF-Plumber", is_bot: true, bot_type: 1 }],
    ]);
    const directory: DmDirectory = { me: 101, ownerUserId: 9, users };
    const withDir = { ...policy, directory };
    // from a peer-started channel turn: the owner and a peer bot are allowed
    expect(resolveTarget("post", { dm_user_id: 9 }, streamOrigin, withDir)).toEqual({ target: { kind: "dm", userIds: [9] }, toOrigin: false });
    expect(resolveTarget("post", { dm_user_id: "50" }, undefined, withDir)).toEqual({ target: { kind: "dm", userIds: [50] }, toOrigin: false });
    // the origin's own sender is still a reply
    expect(resolveTarget("post", { dm_user_id: 70 }, { kind: "dm", userId: 70 }, withDir)).toEqual({
      target: { kind: "dm", userIds: [70] },
      toOrigin: true,
    });
    const refused = (userId: number) => {
      const result = resolveTarget("post", { dm_user_id: userId }, streamOrigin, withDir);
      return "error" in result ? result.error : "allowed";
    };
    expect(refused(101)).toMatch(/cannot DM itself/);
    expect(refused(60)).toMatch(/incoming-webhook/);
    expect(refused(70)).toMatch(/not the owner/);
    expect(refused(80)).toMatch(/not an active member/);
    expect(refused(999)).toMatch(/not an active member/);
    // without an owner id, Jay is just a person who is not the owner
    expect(dmRefusal(9, { me: 101, users })).toMatch(/not the owner/);
  });

  it("needs a topic, refuses a self-named one, and allows only the origin or a listed channel", () => {
    expect(resolveTarget("post", { channel: "builds" }, undefined, policy)).toMatchObject({ error: expect.stringMatching(/topic is required/) });
    expect(resolveTarget("post", { channel: "builds", topic: "BF-Plumber" }, undefined, policy)).toMatchObject({
      error: expect.stringMatching(/after yourself/),
    });
    expect(resolveTarget("post", { channel: "#builds", topic: "BotFleet deploy" }, undefined, policy)).toEqual({
      target: { kind: "stream", channel: "builds", topic: "BotFleet deploy" },
      toOrigin: false,
    });
    expect(resolveTarget("post", { channel: "random", topic: "hi" }, undefined, policy)).toMatchObject({
      error: expect.stringMatching(/nor one of this workspace's post channels/),
    });
    // the origin topic is always allowed, under its own spelling
    expect(resolveTarget("post", { channel: "agent-sync", topic: "bf tunnel" }, streamOrigin, policy)).toEqual({
      target: { kind: "stream", channel: "agent-sync", topic: "BF tunnel" },
      toOrigin: true,
    });
  });

  it("allows a new topic in the channel that woke the turn, even when no post channel is listed", () => {
    const none = { postChannels: [], names: policy.names };
    expect(resolveTarget("post", { channel: "Agent-Sync", topic: "BF new unit" }, streamOrigin, none)).toEqual({
      target: { kind: "stream", channel: "Agent-Sync", topic: "BF new unit" },
      toOrigin: false,
    });
    // a new topic there still passes the topic rules
    expect(resolveTarget("post", { channel: "agent-sync", topic: "BF-Plumber notes" }, streamOrigin, none)).toMatchObject({
      error: expect.stringMatching(/after yourself/),
    });
    // another channel is still refused, and a DM origin opens no channel
    expect(resolveTarget("post", { channel: "random", topic: "BF x" }, streamOrigin, none)).toMatchObject({
      error: expect.stringMatching(/neither the channel that woke this turn/),
    });
    expect(resolveTarget("post", { channel: "agent-sync", topic: "BF x" }, { kind: "dm", userId: 9 }, none)).toMatchObject({
      error: expect.any(String),
    });
  });
});

describe("content", () => {
  it("is required and capped", () => {
    expect(checkContent("   ", [])).toMatchObject({ error: expect.stringMatching(/empty/) });
    const huge = Array.from({ length: ZULIP_MAX_CHUNKS + 1 }, () => "a".repeat(9000)).join("\n\n");
    expect(checkContent(huge, [])).toMatchObject({ error: expect.stringMatching(/longer than/) });
    expect(checkContent("fine", [])).toEqual({ chunks: ["fine"] });
  });
});
