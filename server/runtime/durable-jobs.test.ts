// Durable delegated jobs, isolated from the harness.
//
// A file-backed runtime.db is closed and opened again the way a process
// restart does.  A cut turn with no outward action is queued to run once.
// The same turn, still marked for that rerun, is not resumed a second time.
// A turn that already pushed or sent is not run again at all.  Stop drops
// work that has not started.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CUT_TWICE,
  INTERRUPTED_OUTWARD,
  Runtime,
  openRuntimeStore,
  type RuntimeStore,
  type TurnRunner,
} from "./index.ts";

const limits = { depth: 1, requests: 4, turnStallMs: Number.POSITIVE_INFINITY };

function runner(outward: string[] = []): TurnRunner {
  return {
    validate: () => undefined,
    canStart: () => true,
    run: async () => ({ kind: "completed", text: "done" }),
    park: () => {},
    report: () => {},
    changed: () => {},
    names: () => ({ requester: "Asker", assignee: "Helper", person: "the person" }),
    outward: () => outward,
  };
}

function personRoot(botId: string, threadId: string, brief: string) {
  return {
    origin: { kind: "person" as const, source: "chat" as const, ref: threadId, quote: brief },
    requester: { kind: "bot_turn" as const, botId, threadId },
    assignee: { botId, destination: { kind: "standing_thread" as const, threadId } },
    brief,
    level: "ask" as const,
  };
}

describe("durable delegated jobs", () => {
  let dir = "";
  const stores: RuntimeStore[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  function open(outward: string[] = []): { store: RuntimeStore; runtime: Runtime } {
    dir = dir || mkdtempSync(join(tmpdir(), "bf-runtime-"));
    // One connection at a time, so the next open reads what the last one committed.
    for (const previous of stores) previous.close();
    stores.length = 0;
    const store = openRuntimeStore(join(dir, "runtime.db"));
    stores.push(store);
    return { store, runtime: new Runtime(store, runner(outward), { limits, log: () => {} }) };
  }

  it("queues a cut turn once, and does not resume it after a second restart", () => {
    const first = open();
    const root = first.runtime.begin(personRoot("asker", "thread-a", "finish the notes"));
    first.runtime.close();

    const second = open();
    second.runtime.open();
    const rerun = second.store.get(root.id);
    expect(rerun?.status).toBe("queued");
    expect(rerun?.restart).toBe("rerun");
    expect(rerun?.restarts).toBe(1);

    // Opening again while it is only queued does not treat it as cut twice.
    const third = open();
    third.runtime.open();
    expect(third.store.get(root.id)?.status).toBe("queued");

    const running = third.store.get(root.id)!;
    running.status = "running";
    third.store.update(running);
    const fourth = open();
    fourth.runtime.open();
    const cut = fourth.store.get(root.id);
    expect(cut?.status).toBe("failed");
    expect(cut?.outcome).toBe("interrupted");
    expect(cut?.outcomeDetail).toBe(CUT_TWICE);
    expect(cut?.outcomeDetail).toContain("not resumed again");
  });

  it("does not rerun a turn that already acted outward", () => {
    const first = open(["git push origin"]);
    const root = first.runtime.begin(personRoot("asker", "thread-a", "ship it"));
    first.runtime.close();

    const second = open(["git push origin"]);
    second.runtime.open();
    const settled = second.store.get(root.id);
    expect(settled?.status).toBe("failed");
    expect(settled?.outcome).toBe("interrupted");
    expect(settled?.outcomeDetail?.startsWith(INTERRUPTED_OUTWARD)).toBe(true);
    expect(settled?.outcomeDetail).toContain("git push origin");
  });

  it("cancels queued work that Stop reaches before it starts", () => {
    const { runtime, store } = open();
    const root = runtime.begin(personRoot("asker", "thread-a", "hand this off"));
    const child = runtime.enqueue({
      parentId: root.id,
      origin: root.origin,
      requester: root.requester,
      assignee: { botId: "helper", destination: { kind: "standing_thread", threadId: "thread-b" } },
      brief: "draft the reply",
      levels: { own: "ask" },
    });
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    expect(child.assignment.status).toBe("queued");

    const left = runtime.stopRequester({ botId: "asker", threadId: "thread-a" }, "Stopped by user");
    expect(left).toEqual([]);
    expect(store.get(child.assignment.id)?.status).toBe("cancelled");
    expect(store.get(root.id)?.status).toBe("cancelled");
    expect(store.get(root.id)?.outcome).toBe("stopped");
  });

  it("records one assignment for the same brief, and refuses a second hop", () => {
    const { runtime, store } = open();
    const root = runtime.begin(personRoot("asker", "thread-a", "coordinate"));
    const first = runtime.enqueue({
      parentId: root.id,
      origin: root.origin,
      requester: root.requester,
      assignee: { botId: "helper", destination: { kind: "standing_thread", threadId: "thread-b" } },
      brief: "same words",
      levels: { own: "ask" },
    });
    const again = runtime.enqueue({
      parentId: root.id,
      origin: root.origin,
      requester: root.requester,
      assignee: { botId: "helper", destination: { kind: "standing_thread", threadId: "thread-b" } },
      brief: "same words",
      levels: { own: "ask" },
    });
    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again.duplicate).toBe(true);
    expect(again.assignment.id).toBe(first.assignment.id);

    const child = store.get(first.assignment.id)!;
    child.status = "running";
    store.update(child);
    const grand = runtime.enqueue({
      parentId: child.id,
      origin: root.origin,
      requester: { kind: "bot_turn", botId: "helper", threadId: "thread-b" },
      assignee: { botId: "other", destination: { kind: "standing_thread", threadId: "thread-c" } },
      brief: "and again",
      levels: { own: "ask" },
    });
    expect(grand.ok).toBe(false);
    if (grand.ok) return;
    expect(grand.reason).toContain("depth");
  });
});
