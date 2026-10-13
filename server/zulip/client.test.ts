// The Zulip client's boundary: every success body is parsed with its schema
// before anything reads it.  A fake `fetch` answers with hand-made bodies, so
// each case is exactly one malformed (or merely odd) response.
import { describe, expect, it } from "vitest";

import { INVALID_RESPONSE, ZulipApiError, ZulipClient } from "./client.ts";

const REALM = "https://zulip.test";
const creds = { email: "bf-plumber-bot@zulip.test", key: "fake-test-key-not-real", site: REALM, source: "test" };

/** A client whose every call is answered with `body` (status 200 unless
 *  told), and the notes it was given about dropped elements. */
function clientAnswering<Body extends object>(body: Body, status = 200) {
  const dropped: string[] = [];
  const client = new ZulipClient(creds, REALM, {
    fetch: async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    sleep: async () => {},
    onInvalid: (what) => dropped.push(what),
  });
  return { client, dropped };
}

/** A message body as Zulip sends it; `over` swaps in a wrong-typed field. */
const message = (id: number, over: { content?: string | number; timestamp?: string | number } = {}) => ({
  id,
  sender_id: 9,
  sender_email: "jay@zulip.test",
  sender_full_name: "Jay",
  client: "website",
  type: "stream",
  display_recipient: "agent-sync",
  subject: "BF x",
  stream_id: 7,
  content: "hello",
  timestamp: 1_700_000_000,
  ...over,
});

async function failure(call: Promise<unknown>): Promise<ZulipApiError> {
  try {
    await call;
  } catch (e) {
    expect(e).toBeInstanceOf(ZulipApiError);
    // SAFETY: the line above asserted the instance type.
    return e as ZulipApiError;
  }
  throw new Error("expected the call to be refused");
}

describe("a malformed response is refused", () => {
  it("register without a queue id fails as invalid_response, naming the field and not the body", async () => {
    const { client } = clientAnswering({ result: "success", last_event_id: 3, msg: "hostile text 7f3a" });
    const error = await failure(client.register());
    expect(error.code).toBe(INVALID_RESPONSE);
    expect(error.message).toContain("queue_id");
    expect(error.message).not.toContain("hostile text");
  });

  it("a wrong-typed field is as bad as a missing one, and its value is never echoed", async () => {
    const { client } = clientAnswering({ result: "success", queue_id: ["leak-me"], last_event_id: 3 });
    const error = await failure(client.register());
    expect(error.code).toBe(INVALID_RESPONSE);
    expect(error.message).not.toContain("leak-me");
  });

  it("a success body with no result, or a result other than success, is refused for every call", async () => {
    for (const body of [{}, { queue_id: "q1", last_event_id: 1 }, { result: "weird" }]) {
      const { client } = clientAnswering(body);
      expect((await failure(client.register())).code).toBe(INVALID_RESPONSE);
      expect((await failure(client.deleteQueue("q1"))).code).toBe(INVALID_RESPONSE);
      expect((await failure(client.setTopicVisibility(7, "BF x", 3))).code).toBe(INVALID_RESPONSE);
    }
  });

  it("users/me without an email is refused", async () => {
    const { client } = clientAnswering({ result: "success", user_id: 101, role: 400 });
    expect((await failure(client.me())).code).toBe(INVALID_RESPONSE);
  });

  it("events that are not a list, or an event with no id, are refused as a whole", async () => {
    expect((await failure(clientAnswering({ result: "success", events: "none" }).client.events("q1", -1))).code).toBe(
      INVALID_RESPONSE,
    );
    // An event nobody can acknowledge would be re-sent at once, forever.
    const noId = clientAnswering({ result: "success", events: [{ type: "heartbeat" }] });
    expect((await failure(noId.client.events("q1", -1))).code).toBe(INVALID_RESPONSE);
  });

  it("a messages page whose element has no id is refused", async () => {
    const { client } = clientAnswering({ result: "success", messages: [{ content: "x" }] });
    expect((await failure(client.messages([], { anchor: 0 }))).code).toBe(INVALID_RESPONSE);
  });

  it("a server error still reads as the server's own error, not a shape error", async () => {
    const { client } = clientAnswering({ result: "error", msg: "Bad event queue ID", code: "BAD_EVENT_QUEUE_ID" }, 400);
    const error = await failure(client.events("q1", -1));
    expect(error.code).toBe("BAD_EVENT_QUEUE_ID");
  });
});

describe("one bad element costs that element, not the response", () => {
  it("keeps a bare event for an unparseable payload, so the queue still advances", async () => {
    const { client, dropped } = clientAnswering({
      result: "success",
      events: [
        { id: 4, type: "message", flags: ["mentioned"], message: message(2001) },
        { id: 5, type: "message", flags: [], message: message(2002, { content: 12 }) },
        { id: 6, type: "heartbeat" },
        { id: 7, type: "heartbeat", stream_id: "not a number" },
      ],
    });
    const events = await client.events("q1", 3);
    expect(events.map((event) => event.id)).toEqual([4, 5, 6, 7]);
    expect(events[0]?.message?.id).toBe(2001);
    expect(events[1]).toEqual({ id: 5, type: "message" });
    // only a type the hub acts on is worth a note
    expect(dropped).toEqual(["1 malformed event payload(s) from events"]);
  });

  it("drops a message that does not parse from a page, and pages by what Zulip sent", async () => {
    const { client, dropped } = clientAnswering({
      result: "success",
      messages: [message(10), message(12, { timestamp: "yesterday" }), message(11)],
    });
    const page = await client.messages([{ operator: "is", operand: "dm" }], { anchor: 0, numAfter: 3 });
    expect(page.messages.map((m) => m.id)).toEqual([10, 11]);
    expect(page.received).toBe(3);
    // the dropped message is the newest: the next page must still start after it
    expect(page.newestId).toBe(12);
    expect(dropped).toEqual(["1 malformed message(s) from messages"]);
  });

  it("leaves a bad realm member or topic row out of register's lists", async () => {
    const { client, dropped } = clientAnswering({
      result: "success",
      queue_id: "q1",
      last_event_id: -1,
      max_message_id: 40,
      realm_users: [{ user_id: 9, full_name: "Jay" }, { user_id: "9" }, "nobody", { user_id: 101, bot_type: null }],
      user_topics: [{ stream_id: 7, topic_name: "BF x", visibility_policy: 3 }, { stream_id: "7" }],
    });
    const registered = await client.register();
    expect(registered.queue_id).toBe("q1");
    expect(registered.max_message_id).toBe(40);
    expect(registered.realm_users.map((user) => user.user_id)).toEqual([9, 101]);
    expect(registered.user_topics).toEqual([{ stream_id: 7, topic_name: "BF x", visibility_policy: 3 }]);
    expect(dropped).toEqual(["3 malformed member or topic row(s) from register"]);
  });

  it("reads no newest message id when register omits it, rather than inventing one", async () => {
    const { client } = clientAnswering({ result: "success", queue_id: "q1", last_event_id: -1 });
    const registered = await client.register();
    expect(registered.max_message_id).toBeUndefined();
    expect(registered.realm_users).toEqual([]);
  });

  it("leaves a malformed subscription out", async () => {
    const { client, dropped } = clientAnswering({
      result: "success",
      subscriptions: [{ stream_id: 7, name: "builds" }, { stream_id: 8 }, { name: "x" }],
    });
    expect(await client.subscriptions()).toEqual([{ stream_id: 7, name: "builds" }]);
    expect(dropped).toEqual(["2 malformed subscription(s) from users/me/subscriptions"]);
  });
});

describe("a post that already happened is never failed over its answer", () => {
  it("returns the new message's id, or -1 when the answer carries none that parses", async () => {
    const target = { kind: "stream" as const, channel: "builds", topic: "BF x" };
    expect(await clientAnswering({ result: "success", id: 4321 }).client.send(target, "hi")).toBe(4321);
    expect(await clientAnswering({ result: "success", id: "4321" }).client.send(target, "hi")).toBe(-1);
    expect(await clientAnswering({ result: "success" }).client.send(target, "hi")).toBe(-1);
  });
});
