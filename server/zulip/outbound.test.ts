import { describe, expect, it } from "vitest";

import { ZULIP_MAX_CHUNKS, checkContent, resolveTarget, secretRefusal } from "./outbound.ts";

// Obviously fake values, shaped like the real thing so the scanner fires.
// gitleaks runs on every PR, so nothing here may look like a live key.
const FAKE_ZULIP_KEY = "FakeZulipKey0000000000000000aB12";
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

  it("lets a DM go only to the sender of the DM that started the turn", () => {
    const dmOrigin = { kind: "dm" as const, userId: 9 };
    expect(resolveTarget("post", { dm_user_id: 9 }, dmOrigin, policy)).toEqual({
      target: { kind: "dm", userIds: [9] },
      toOrigin: true,
    });
    expect(resolveTarget("post", { dm_user_id: 50 }, dmOrigin, policy)).toMatchObject({ error: expect.stringMatching(/only to the person/) });
    expect(resolveTarget("post", { dm_user_id: 9 }, streamOrigin, policy)).toMatchObject({ error: expect.stringMatching(/only to the person/) });
    expect(resolveTarget("post", { dm_user_id: 9 }, undefined, policy)).toMatchObject({ error: expect.any(String) });
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
