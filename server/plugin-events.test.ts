import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PluginEventEnvelope, PluginEventSubscription } from "../shared/plugin-events.ts";
import { PluginEventBus, type PluginEventTransport } from "./plugin-events.ts";
import type { PluginSandboxResult } from "./plugin-loader.ts";

function envelope(id = "zulip:BF-Plumber:42"): PluginEventEnvelope {
  return {
    eventId: id,
    type: "zulip.message",
    source: { platform: "zulip", accountId: "BF-Plumber" },
    occurredAt: "2026-10-15T12:00:00.000Z",
    receivedAt: "2026-10-15T12:00:01.000Z",
    refs: { messageId: 42, conversationKey: "dm:7" },
    mentions: [],
    content: { text: "hello", format: "text" },
    context: { botId: "bot-plumber", wakeReason: "dm", senderKind: "owner" },
  };
}

const SUB: PluginEventSubscription = {
  id: "inbox", source: "zulip", kinds: ["message"], includeContent: true, includeChats: false, maxChats: 10,
};

interface Stub {
  transport: PluginEventTransport;
  decisions: Array<{ plugin: string; decision: unknown }>;
  results: Map<string, PluginSandboxResult[]>;
  caps: Map<string, string[]>;
  subs: Map<string, PluginEventSubscription[]>;
}

function stub(): Stub {
  const s: Stub = {
    decisions: [],
    results: new Map(),
    caps: new Map([["demo", ["events.subscribe", "dispatch.wake", "chat.read"]]]),
    subs: new Map([["demo", [SUB]]]),
    transport: null as unknown as PluginEventTransport,
  };
  s.transport = {
    subscribers: (_event) => {
      // Return every known plugin; the bus owns matching and the
      // capability gate so tests can observe refused/noSubscription.
      void _event;
      return [...new Set([...s.subs.keys(), ...s.caps.keys()])];
    },
    capabilities: (name) => s.caps.get(name) ?? null,
    subscriptions: (name) => s.subs.get(name) ?? [],
    scope: (_name, _sub, event) => event,
    deliver: async (name) => s.results.get(name)?.shift() ?? {
      ok: true,
      value: { action: "none", rationale: "nothing to do" },
    },
    onDecision: (plugin, _event, decision) => {
      s.decisions.push({ plugin, decision });
    },
  };
  return s;
}

let baseDir = "";

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "bf-plugin-bus-"));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe("PluginEventBus", () => {
  it("delivers to subscribers and forwards valid decisions", async () => {
    const s = stub();
    const bus = new PluginEventBus(s.transport, { baseDir, manualRetries: true });
    const outcomes = await bus.emit(envelope());
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.result).toBe("delivered");
    expect(s.decisions).toHaveLength(1);
  });

  it("deduplicates repeated deliveries", async () => {
    const s = stub();
    const bus = new PluginEventBus(s.transport, { baseDir, manualRetries: true });
    await bus.emit(envelope());
    const second = await bus.emit(envelope());
    expect(second[0]?.result).toBe("duplicate");
    expect(s.decisions).toHaveLength(1);
  });

  it("refuses plugins without events.subscribe", async () => {
    const s = stub();
    s.caps.set("demo", ["read.bots"]);
    const bus = new PluginEventBus(s.transport, { baseDir, manualRetries: true });
    const outcomes = await bus.emit(envelope());
    expect(outcomes[0]?.result).toBe("refused");
    expect(s.decisions).toHaveLength(0);
  });

  it("records noSubscription when nothing matches", async () => {
    const s = stub();
    s.subs.set("demo", []);
    const bus = new PluginEventBus(s.transport, { baseDir, manualRetries: true });
    const outcomes = await bus.emit(envelope());
    expect(outcomes[0]?.result).toBe("noSubscription");
  });

  it("drops invalid envelopes silently", async () => {
    const s = stub();
    const bus = new PluginEventBus(s.transport, { baseDir, manualRetries: true });
    expect(await bus.emit({ nope: true })).toEqual([]);
    expect(s.decisions).toHaveLength(0);
  });

  it("retries transient failures then dead-letters", async () => {
    const s = stub();
    s.results.set("demo", [
      { ok: false, reason: "timeout" },
      { ok: false, reason: "timeout" },
      { ok: false, reason: "timeout" },
      { ok: false, reason: "timeout" },
      { ok: false, reason: "timeout" },
    ]);
    let now = 1_000_000;
    const bus = new PluginEventBus(s.transport, { baseDir, manualRetries: true, now: () => now, retryBaseMs: 1 });
    const first = await bus.emit(envelope());
    expect(first[0]?.result).toBe("retry");
    const seen: string[] = [first[0]?.result ?? ""];
    for (let i = 0; i < 5; i += 1) {
      now += 100_000;
      for (const o of await bus.drainPending("demo")) seen.push(o.result);
    }
    expect(seen).toContain("deadLetter");
    expect(bus.health("demo").deadLetter).toBe(1);
    expect(s.decisions).toHaveLength(0);
  });

  it("recovers on retry and forwards the late decision", async () => {
    const s = stub();
    s.results.set("demo", [
      { ok: false, reason: "sandbox_exited" },
      { ok: true, value: { action: "requestWake", targetBotId: "bot-director" } },
    ]);
    let now = 1_000_000;
    const bus = new PluginEventBus(s.transport, { baseDir, manualRetries: true, now: () => now, retryBaseMs: 1 });
    expect((await bus.emit(envelope()))[0]?.result).toBe("retry");
    now += 100_000;
    const drained = await bus.drainPending("demo");
    expect(drained[0]?.result).toBe("delivered");
    expect(s.decisions).toHaveLength(1);
  });

  it("fails permanently on not_implemented and invalid decisions", async () => {
    const s = stub();
    s.results.set("demo", [{ ok: false, reason: "not_implemented" }]);
    const bus = new PluginEventBus(s.transport, { baseDir, manualRetries: true });
    expect((await bus.emit(envelope("zulip:BF-Plumber:1")))[0]?.result).toBe("failed");
    s.results.set("demo", [{ ok: true, value: { action: "explode" } }]);
    expect((await bus.emit(envelope("zulip:BF-Plumber:2")))[0]?.result).toBe("failed");
    expect(s.decisions).toHaveLength(0);
  });

  it("refuses wake requests without dispatch.wake", async () => {
    const s = stub();
    s.caps.set("demo", ["events.subscribe"]);
    s.results.set("demo", [{ ok: true, value: { action: "requestWake", targetBotId: "b" } }]);
    const bus = new PluginEventBus(s.transport, { baseDir, manualRetries: true });
    expect((await bus.emit(envelope()))[0]?.result).toBe("refused");
    expect(s.decisions).toHaveLength(0);
  });

  it("isolates transport crashes per delivery", async () => {
    const s = stub();
    s.transport.deliver = async () => {
      throw new Error("boom");
    };
    const bus = new PluginEventBus(s.transport, { baseDir, manualRetries: true });
    const outcomes = await bus.emit(envelope());
    expect(["retry", "deadLetter"]).toContain(outcomes[0]?.result);
  });

  it("persists dedup and health across instances", async () => {
    const s = stub();
    const bus = new PluginEventBus(s.transport, { baseDir, manualRetries: true });
    await bus.emit(envelope());
    const bus2 = new PluginEventBus(s.transport, { baseDir, manualRetries: true });
    expect((await bus2.emit(envelope()))[0]?.result).toBe("duplicate");
    expect(bus2.health("demo").recent[0]?.result).toBe("duplicate");
  });

  it("health exposes no event text", async () => {
    const s = stub();
    const bus = new PluginEventBus(s.transport, { baseDir, manualRetries: true });
    await bus.emit(envelope());
    const text = JSON.stringify(bus.health("demo"));
    expect(text.includes("hello")).toBe(false);
  });
});
