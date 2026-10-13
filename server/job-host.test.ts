// The host in front of the job runtime: handoffs are durable before they
// run, Stop cancels what has not started, and the old queue is imported
// once.  Peer approval, Off bots and the one-hop cap stay in front.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { createJobHost, isOutwardActivity, type JobHost, type JobHostDeps } from "./job-host.ts";
import { closeMessageDb } from "./message-db.ts";
import { resolvePeerComms, type ApprovalBus } from "./peer-approval.ts";
import { Store } from "./store.ts";

const selection = { instanceId: "claude", model: "claude-sonnet-5" };

describe("isOutwardActivity", () => {
  it("treats a push, a send and a payment as outward, and leaves a local read alone", () => {
    expect(isOutwardActivity("github_push")).toBe(true);
    expect(isOutwardActivity("Bash", "git push origin main")).toBe(true);
    expect(isOutwardActivity("Bash", "git commit -m notes")).toBe(true);
    expect(isOutwardActivity("gmail_send")).toBe(true);
    expect(isOutwardActivity("stripe", "charge the card")).toBe(true);
    expect(isOutwardActivity("Bash", "git status")).toBe(false);
    expect(isOutwardActivity("Read", "src/app.ts")).toBe(false);
    expect(isOutwardActivity("Handed to @Helper")).toBe(false);
  });
});

describe("job host", () => {
  let store: Store;
  let host: JobHost;
  let approval: ApprovalBus;
  const starts: Array<{ botId: string; text: string }> = [];
  let listener: ((event: { type: string; threadId?: string; text?: string; ok?: boolean; itemType?: string }) => void) | undefined;

  afterEach(() => {
    host?.close();
    store?.flushBotsNow();
    // Windows will not remove a directory that still holds an open database.
    // The runtime handle closes with the host.  The message database is a
    // process-wide handle and has to close before this directory goes.
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    starts.length = 0;
    listener = undefined;
  });

  function setup(startTurn?: JobHostDeps["startTurn"]) {
    host?.close();
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    store = new Store(() => selection);
    const from = store.createBot({ name: "Asker" }, { seedMessages: false });
    const target = store.createBot({ name: "Helper" }, { seedMessages: false });
    approval = { store, broadcast: () => {} };
    host = createJobHost({
      store,
      commsBus: { store, broadcast: () => {} },
      approvalBus: approval,
      startTurn: startTurn ?? (async (botId, text, opts) => {
        starts.push({ botId, text });
        const threadId = opts.threadId ?? botId;
        queueMicrotask(() => {
          listener?.({ type: "item.completed", threadId, itemType: "assistant_text", text: "hello from peer", ok: true });
          listener?.({ type: "turn.completed", threadId, ok: true });
        });
      }),
      subscribe: (fn) => {
        listener = fn;
        return () => {
          if (listener === fn) listener = undefined;
        };
      },
      snoozed: () => false,
      unattended: () => false,
    });
    return { from, target };
  }

  it("records the handoff before the peer turn, and Stop cancels it", () => {
    const { from, target } = setup();
    const handed = host.coordinate({
      fromBotId: from.id,
      fromThreadId: from.threadId,
      botIds: [target.id],
      message: "draft the reply",
      reason: "followup",
      depth: 0,
    });
    expect(handed.status).toBe(200);
    const rows = handed.body.assignments ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("queued");
    expect(starts).toEqual([]);
    expect(store.messagesFor(from.threadId).some((message) => message.tool?.name === "Handed to @Helper: followup")).toBe(true);

    host.stopThread(from.id, from.threadId);
    host.onTurnSettled(from.threadId, true, "stopped");
    expect(starts).toEqual([]);
    const view = host.status(from.id, from.threadId, rows[0]?.id);
    expect(view.body.assignment).toMatchObject({ status: "cancelled", outcome: "stopped" });
  });

  it("starts the peer only after the requesting turn settles", async () => {
    const { from, target } = setup();
    host.coordinate({
      fromBotId: from.id,
      fromThreadId: from.threadId,
      botIds: ["@Helper"],
      message: "ping from the test",
      depth: 0,
    });
    expect(starts).toEqual([]);
    host.onTurnSettled(from.threadId, true, "asking now");
    await viWait(() => starts.length > 0);
    expect(starts[0]?.botId).toBe(target.id);
    expect(starts[0]?.text).toContain("[BotFleet assignment");
    expect(starts[0]?.text).toContain("ping from the test");
    await viWait(() => starts.some((start) => start.botId === from.id && start.text.includes("hello from peer")));
    expect(starts.filter((start) => start.botId === target.id)).toHaveLength(1);
    expect(store.groups.some((group) => group.dm && group.memberIds.includes(from.id) && group.memberIds.includes(target.id))).toBe(true);
    expect(store.groups.some((group) => group.dm && group.memberIds.every((id) => id === from.id))).toBe(false);
  });

  it("fails the handoff when dispatch reports an error after startTurn returns", async () => {
    let calls = 0;
    const { from, target } = setup(async (botId, text, opts) => {
      calls += 1;
      if (calls === 1) {
        setTimeout(() => opts?.onDispatchError?.("provider refused"), 30);
        return;
      }
      starts.push({ botId, text });
      const threadId = opts.threadId ?? botId;
      queueMicrotask(() => listener?.({ type: "turn.completed", threadId, ok: true }));
    });
    const handed = host.coordinate({
      fromBotId: from.id,
      fromThreadId: from.threadId,
      botIds: [target.id],
      message: "this dispatch will fail",
      depth: 0,
    });
    const childId = handed.body.assignments?.[0]?.id;
    host.onTurnSettled(from.threadId, true, "asking now");
    await viWait(() => host.status(from.id, from.threadId, childId).body.assignment?.status === "failed");
    expect(host.status(from.id, from.threadId, childId).body.assignment).toMatchObject({
      status: "failed",
      outcome: "provider_error",
    });
    expect(store.messagesFor(from.threadId).some((message) => message.tool?.name === "Delegated turn could not start")).toBe(true);
    await viWait(() => starts.some((start) => start.botId === from.id));
    expect(starts.find((start) => start.botId === from.id)?.text).toContain("provider refused");
  });

  it("records one assignment when the same peer is named more than once", () => {
    const { from, target } = setup();
    const handed = host.coordinate({
      fromBotId: from.id,
      fromThreadId: from.threadId,
      botIds: ["@Helper", "Helper", target.id],
      message: "once",
      depth: 0,
    });
    expect(handed.body.assignments).toHaveLength(1);
    expect(handed.body.assignments?.[0]?.botId).toBe(target.id);
  });

  it("admits queued work when a turn stops", async () => {
    const { from, target } = setup();
    const other = store.createBot({ name: "Other" }, { seedMessages: false });
    store.patchBot(target.id, { busy: true });
    host.coordinate({
      fromBotId: from.id,
      fromThreadId: from.threadId,
      botIds: [target.id],
      message: "wait until the peer is free",
      depth: 0,
    });
    host.onTurnSettled(from.threadId, true, "queued behind a busy peer");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(starts).toEqual([]);
    store.patchBot(target.id, { busy: false });
    host.onTurnSettled(other.threadId, false, "");
    await viWait(() => starts.some((start) => start.botId === target.id));
  });

  it("refuses a second hop and an Off bot before anything is recorded", () => {
    const { from, target } = setup();
    store.patchBot(target.id, { off: true });
    const off = host.coordinate({
      fromBotId: from.id,
      fromThreadId: from.threadId,
      botIds: [target.id],
      message: "still going?",
      depth: 0,
    });
    expect(off.body.error).toBe("that bot is switched off");
    expect(starts).toEqual([]);

    store.patchBot(target.id, { off: false });
    const hop = host.coordinate({
      fromBotId: from.id,
      fromThreadId: from.threadId,
      botIds: [target.id],
      message: "and again",
      depth: 1,
    });
    expect(String(hop.body.error)).toContain("one hop");
    expect(starts).toEqual([]);
  });

  it("honors a legacy ask_bot grant for coordinate_bots", async () => {
    const { from, target } = setup();
    store.patchBot(from.id, { approvePeerComms: true, alwaysAllow: [`ask_bot:${target.id}`] });
    host.coordinate({
      fromBotId: from.id,
      fromThreadId: from.threadId,
      botIds: [target.id],
      message: "the grant still covers this",
      depth: 0,
    });
    host.onTurnSettled(from.threadId, true, "go");
    await viWait(() => starts.length > 0);
    expect(store.messagesFor(from.threadId).some((message) => message.card?.tool === "coordinate_bots")).toBe(false);
    expect(starts[0]?.botId).toBe(target.id);
  });

  it("asks before the first dispatch when peer approval is on", async () => {
    const { from, target } = setup();
    store.patchBot(from.id, { approvePeerComms: true });
    host.coordinate({
      fromBotId: from.id,
      fromThreadId: from.threadId,
      botIds: [target.id],
      message: "needs a card",
      depth: 0,
    });
    host.onTurnSettled(from.threadId, true, "go");
    await viWait(() => store.messagesFor(from.threadId).some((message) => message.card?.tool === "coordinate_bots"));
    expect(starts).toEqual([]);
    const card = store.messagesFor(from.threadId).find((message) => message.card?.tool === "coordinate_bots");
    expect(card?.card?.allowKey).toBe(`coordinate_bots:${target.id}`);
    expect(resolvePeerComms(approval, card!.card!.requestId!, "allow", from.threadId)).toBe(true);
    await viWait(() => starts.some((start) => start.botId === target.id));
  });

  it("imports the legacy queue once, as work that does not wake the old requester", async () => {
    const { from, target } = setup();
    mkdirSync(DATA_DIR, { recursive: true });
    const file = join(DATA_DIR, "delegations.json");
    writeFileSync(file, JSON.stringify({
      [from.threadId]: [{ toBotId: target.id, message: "carry this", reason: "because", depth: 0 }],
    }));
    host.boot();
    await viWait(() => starts.length > 0);
    expect(existsSync(`${file}.migrated`)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(starts[0]?.botId).toBe(target.id);
    expect(starts[0]?.text).toContain("carry this");
    expect(starts[0]?.text).toContain("[Reason: because]");
    host.boot();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(starts).toHaveLength(1);
  });
});

async function viWait(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the job host");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
