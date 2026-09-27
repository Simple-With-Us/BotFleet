// The permission broker's own contract, in isolation from the harness.
//
// What the broker must get right is narrow and load-bearing:
//
//   - it publishes a REAL `request.opened`, carrying every field the
//     `index.ts` fold reads, because the whole design is "reach the
//     existing approval machinery rather than reimplement it";
//   - it BLOCKS until somebody answers, so a tool cannot run before the
//     verdict;
//   - `respond()` returns null for a request it does not own, which is the
//     single indirection that leaves every CLI engine's approval path
//     untouched;
//   - and a pending ask settles EXACTLY ONCE, as `unavailable`, from each
//     of the three ways a turn can die under an open card.  A row per abort
//     source, because a missed one is a hung turn and a card nobody can
//     ever answer.
//
// The behaviour that hangs off the published events — auto mode, the
// unattended block, the decision-log rows, the human card — belongs to the
// fold, and is proven against the real server in `http-lane-e2e.test.ts`.
// Asserting it twice here would only prove a mock.
import { describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { createPermissionBroker, type PermissionBroker } from "./approvals.ts";

function harness() {
  const events: RuntimeEvent[] = [];
  let n = 0;
  const broker: PermissionBroker = createPermissionBroker({
    publish: (event) => events.push(event),
    newRequestId: () => `req-${++n}`,
    newEventId: () => `evt-${events.length + 1}`,
  });
  const ask = (over: Partial<Parameters<PermissionBroker["request"]>[0]> = {}) =>
    broker.request({
      threadId: "thread-1",
      botId: "bot-1",
      provider: "minimax",
      providerInstanceId: "minimax",
      tool: "ask_bot",
      summary: "ask bot-2: summarise the log",
      ...over,
    });
  const opened = () => events.filter((e) => e.type === "request.opened");
  const resolved = () => events.filter((e) => e.type === "request.resolved");
  return { broker, events, ask, opened, resolved };
}

/** Let a synchronously-settled promise deliver before asserting on it. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("permission broker", () => {
  it("publishes a request.opened carrying every field the fold reads", async () => {
    const h = harness();
    const pending = h.ask();

    expect(h.opened()).toHaveLength(1);
    const event = h.opened()[0];
    expect(event).toMatchObject({
      type: "request.opened",
      requestType: "permission",
      tool: "ask_bot",
      summary: "ask bot-2: summarise the log",
      threadId: "thread-1",
      requestId: "req-1",
      provider: "minimax",
      providerInstanceId: "minimax",
    });
    expect(typeof event.eventId).toBe("string");
    expect(typeof event.createdAt).toBe("string");
    // still open: nothing may run before the verdict
    expect(h.broker.pending()).toBe(1);
    expect(h.broker.isOpen("thread-1", "req-1")).toBe(true);

    h.broker.respond("thread-1", "req-1", { behavior: "allow" });
    await expect(pending).resolves.toBe("allowed-once");
  });

  it("carries host scope through the opened event and keeps other asks unscoped", async () => {
    const h = harness();
    const host = h.ask({ tool: "bash", summary: "bash: bash -c echo", approvalScope: "local-computer" });
    expect(h.opened()[0]).toMatchObject({ tool: "bash", approvalScope: "local-computer" });
    h.broker.respond("thread-1", "req-1", { behavior: "deny" });
    await host;
    const peer = h.ask();
    expect(h.opened()[1]).not.toHaveProperty("approvalScope", "local-computer");
    h.broker.respond("thread-1", "req-2", { behavior: "deny" });
    await peer;
  });

  it("blocks until answered", async () => {
    const h = harness();
    let settled = false;
    const pending = h.ask().then((outcome) => {
      settled = true;
      return outcome;
    });

    await tick();
    expect(settled).toBe(false);

    h.broker.respond("thread-1", "req-1", { behavior: "allow" });
    await expect(pending).resolves.toBe("allowed-once");
    expect(settled).toBe(true);
  });

  it("approve resolves allowed-once and publishes request.resolved as the user", async () => {
    const h = harness();
    const pending = h.ask();
    expect(h.broker.respond("thread-1", "req-1", { behavior: "allow" })).toBe("allowed-once");
    await expect(pending).resolves.toBe("allowed-once");

    expect(h.resolved()).toHaveLength(1);
    expect(h.resolved()[0]).toMatchObject({
      type: "request.resolved",
      behavior: "allow",
      source: "user",
      requestId: "req-1",
      threadId: "thread-1",
    });
    expect(h.broker.pending()).toBe(0);
  });

  it("deny resolves rejected, which the host reads as a refusal", async () => {
    const h = harness();
    const pending = h.ask();
    expect(h.broker.respond("thread-1", "req-1", { behavior: "deny" })).toBe("rejected");
    await expect(pending).resolves.toBe("rejected");
    expect(h.resolved()[0]).toMatchObject({ behavior: "deny", source: "user" });
  });

  it("an auto-mode answer is labelled auto, so the card is not shown as a person's click", async () => {
    const h = harness();
    const pending = h.ask();
    h.broker.respond("thread-1", "req-1", { behavior: "allow", source: "auto" });
    await expect(pending).resolves.toBe("allowed-once");
    // the fold dismisses rather than marks-answered for any source but
    // "user" — an auto-approval labelled "user" would put a click in a
    // person's mouth
    expect(h.resolved()[0]).toMatchObject({ behavior: "allow", source: "auto" });
  });

  it("answering a permission ask is not an approval", async () => {
    const h = harness();
    const pending = h.ask();
    expect(h.broker.respond("thread-1", "req-1", { behavior: "answer", message: "maybe" })).toBe("answered");
    // the host only ever treats "allowed-once" as a grant
    await expect(pending).resolves.toBe("answered");
  });

  it("respond returns null for a request it does not own, so the adapter path runs", async () => {
    const h = harness();
    const pending = h.ask();

    // a CLI engine's requestId — every one of them lands here
    expect(h.broker.respond("thread-1", "acp-request-9", { behavior: "allow" })).toBeNull();
    // right id, wrong thread
    expect(h.broker.respond("thread-2", "req-1", { behavior: "allow" })).toBeNull();
    // nothing was published for either, and the real ask is still open
    expect(h.resolved()).toHaveLength(0);
    expect(h.broker.pending()).toBe(1);

    h.broker.respond("thread-1", "req-1", { behavior: "allow" });
    await pending;
    // and once settled it stops being ours: a late duplicate answer falls
    // through instead of resolving a promise twice
    expect(h.broker.respond("thread-1", "req-1", { behavior: "deny" })).toBeNull();
    expect(h.resolved()).toHaveLength(1);
  });

  it("an ask whose turn is already over never opens a card", async () => {
    const h = harness();
    const aborted = AbortSignal.abort();
    await expect(h.ask({ signal: aborted })).resolves.toBe("unavailable");
    expect(h.events).toHaveLength(0);
    expect(h.broker.pending()).toBe(0);
  });

  // ── one row per abort source ────────────────────────────────────────
  // The risk this covers by name: "every pending ask must resolve
  // 'unavailable' on interrupt, on turn teardown and on dispose, or a
  // stopped turn leaves a card that can never be answered and a promise
  // that never settles."

  it("interrupt: the tool call's own signal settles the ask as unavailable", async () => {
    const h = harness();
    const abort = new AbortController();
    const pending = h.ask({ signal: abort.signal });
    expect(h.broker.pending()).toBe(1);

    abort.abort();

    await expect(pending).resolves.toBe("unavailable");
    expect(h.resolved()[0]).toMatchObject({ behavior: "deny", source: "unavailable" });
    expect(h.broker.pending()).toBe(0);
  });

  it("interrupt: closeOpenApprovals' thread sweep settles the ask as unavailable", async () => {
    const h = harness();
    const pending = h.ask();
    // the sweep Stop runs — no signal involved, because a card can outlive
    // the abort that never reached it
    expect(h.broker.abandonThread("thread-1", "interrupted")).toBe(1);
    await expect(pending).resolves.toBe("unavailable");
    expect(h.resolved()[0]).toMatchObject({ behavior: "deny", source: "unavailable" });
    expect(h.broker.pending()).toBe(0);
  });

  it("teardown: a turn that settled leaves no ask behind", async () => {
    const h = harness();
    const pending = h.ask();
    // what the turn.completed subscriber does
    expect(h.broker.abandonThread("thread-1", "teardown")).toBe(1);
    await expect(pending).resolves.toBe("unavailable");
    expect(h.broker.pending()).toBe(0);
  });

  it("dispose: every thread's asks settle when the fleet goes away", async () => {
    const h = harness();
    const one = h.ask();
    const two = h.ask({ threadId: "thread-2" });
    expect(h.broker.pending()).toBe(2);

    expect(h.broker.abandonAll("disposed")).toBe(2);

    await expect(one).resolves.toBe("unavailable");
    await expect(two).resolves.toBe("unavailable");
    expect(h.resolved()).toHaveLength(2);
    expect(h.broker.pending()).toBe(0);
  });

  it("abandoning touches only the named thread", async () => {
    const h = harness();
    const mine = h.ask();
    const other = h.ask({ threadId: "thread-2" });

    expect(h.broker.abandonThread("thread-1", "interrupted")).toBe(1);
    await expect(mine).resolves.toBe("unavailable");
    expect(h.broker.pending()).toBe(1);

    h.broker.respond("thread-2", "req-2", { behavior: "allow" });
    await expect(other).resolves.toBe("allowed-once");
  });

  it("settles exactly once however many ways the turn dies", async () => {
    const h = harness();
    const abort = new AbortController();
    const pending = h.ask({ signal: abort.signal });

    h.broker.respond("thread-1", "req-1", { behavior: "allow" });
    abort.abort();
    h.broker.abandonThread("thread-1", "teardown");
    h.broker.abandonAll("disposed");

    await expect(pending).resolves.toBe("allowed-once");
    // one opened, one resolved: no exit published a second terminal answer
    expect(h.opened()).toHaveLength(1);
    expect(h.resolved()).toHaveLength(1);
    expect(h.resolved()[0]).toMatchObject({ behavior: "allow", source: "user" });
  });

  it("an answer delivered synchronously from the fold is not lost", async () => {
    // Auto mode answers inside the very publish() call that opened the
    // card.  The ask is registered before the event goes out precisely so
    // this cannot hand the verdict to nobody.
    const events: RuntimeEvent[] = [];
    let broker: PermissionBroker;
    broker = createPermissionBroker({
      publish: (event) => {
        events.push(event);
        if (event.type === "request.opened" && event.requestId) {
          broker.respond(event.threadId, event.requestId, { behavior: "allow", source: "auto" });
        }
      },
    });

    await expect(
      broker.request({
        threadId: "thread-1",
        botId: "bot-1",
        provider: "minimax",
        tool: "ask_bot",
        summary: "ask bot-2: ship it",
      }),
    ).resolves.toBe("allowed-once");
    expect(broker.pending()).toBe(0);
    expect(events.map((e) => e.type)).toEqual(["request.opened", "request.resolved"]);
  });

  it("names the abandoned asks in the log rather than dropping them silently", async () => {
    const h = harness();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const pending = h.ask();
      h.broker.abandonThread("thread-1", "interrupted");
      await pending;
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toContain("interrupted");
      expect(String(error.mock.calls[0][0])).toContain("ask_bot");
      // nothing to say when nothing was open
      error.mockClear();
      h.broker.abandonThread("thread-1", "teardown");
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
