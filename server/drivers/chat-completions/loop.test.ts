// The invariant this file exists to hold: ONE `turn.completed` per user
// turn, on EVERY exit.  The table below is parameterised over the closed
// `TurnLoopExit` union, so a new exit cannot be added to loop.ts without a
// row here saying what the user sees when it fires — which is the whole
// reason the union is closed and both lookup tables are `Record<…>`.
import { describe, expect, it, vi } from "vitest";

import type {
  RequestOutcome,
  RuntimeEvent,
  RuntimeEventBase,
  TurnToolHost,
  TurnToolOutcome,
} from "../../contracts.ts";
import { ProviderError } from "../../contracts.ts";
import { RETRY_AFTER_CAP_MS, httpErrorFor } from "./errors.ts";
import {
  DEFAULT_TURN_LOOP_BUDGET,
  STOP_REASON,
  TERMINAL_OK,
  runTurnLoop,
  type ChatMessage,
  type ChatToolCall,
  type TurnLoopBudget,
  type TurnLoopExit,
  type TurnRoundResult,
} from "./loop.ts";

type TerminalEvent = RuntimeEventBase & {
  type: "turn.completed";
  ok: boolean;
  stopReason?: string | null;
  cost?: number | null;
  usage?: { input: number; output: number; cachedInput?: number };
};

// SAFETY: the filter keeps only `turn.completed` members of the RuntimeEvent
// union, which is exactly the shape TerminalEvent describes.
const terminals = (events: RuntimeEvent[]): TerminalEvent[] =>
  events.filter((e) => e.type === "turn.completed") as unknown as TerminalEvent[];

const call = (id: string, name = "list_bots", args = "{}"): ChatToolCall => ({
  id,
  type: "function",
  function: { name, arguments: args },
});

const answer = (text: string, usage: TurnRoundResult["usage"] = null): TurnRoundResult => ({
  text,
  usage,
});

const wantsTools = (calls: ChatToolCall[], usage: TurnRoundResult["usage"] = null): TurnRoundResult => ({
  text: "",
  toolCalls: calls,
  usage,
});

/** A host that answers every call the same way. */
const hostReturning = (outcome: TurnToolOutcome | ((name: string) => Promise<TurnToolOutcome>)): TurnToolHost => ({
  execute: async (c) => (typeof outcome === "function" ? outcome(c.name) : outcome),
});

interface Harness {
  events: RuntimeEvent[];
  abort: AbortController;
  messages: ChatMessage[];
  roundsSeen: ChatMessage[][];
  /** One entry per REQUEST the loop actually issued, retries included. */
  attempts: Array<{ round: number; attempt: number }>;
  run: (over?: {
    toolHost?: TurnToolHost;
    budget?: Partial<TurnLoopBudget>;
    now?: () => number;
    retryDelayScale?: number;
    emit?: (event: RuntimeEvent) => void;
    computeCost?: (usage: { input: number; output: number; cachedInput?: number }) => number | null;
    tools?: ReadonlyArray<{ name: string; timeoutMs?: number }>;
    requestApproval?: (ask: {
      tool: string;
      summary: string;
      signal?: AbortSignal;
    }) => Promise<RequestOutcome>;
  }) => Promise<TurnLoopExit>;
}

type ScriptedRound =
  | TurnRoundResult
  | ((opts: {
      signal: AbortSignal;
      round: number;
      attempt: number;
      onPublished?: () => void;
      onChunk?: () => void;
      onUsage?: (usage: { input: number; output: number; cachedInput?: number }) => void;
    }) => Promise<TurnRoundResult>);

/** A model request that reports a raw chunk every `everyMs` and answers
 *  after `totalMs` — a slow-but-live stream.  Rejects if aborted first. */
const trickles = (everyMs: number, totalMs: number, text = "slow answer") =>
  async (opts: { signal: AbortSignal; onChunk?: () => void }): Promise<TurnRoundResult> =>
    new Promise<TurnRoundResult>((resolve, reject) => {
      const ticker = setInterval(() => opts.onChunk?.(), everyMs);
      const done = setTimeout(() => {
        clearInterval(ticker);
        resolve({ text, usage: null });
      }, totalMs);
      opts.signal.addEventListener(
        "abort",
        () => {
          clearInterval(ticker);
          clearTimeout(done);
          reject(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
    });

/** A model request that only ends when something aborts it — the shape a
 *  hung or very slow provider has, and the only shape that exercises the
 *  request and wall-clock ceilings honestly. */
const hangs = () => async (opts: { signal: AbortSignal }): Promise<TurnRoundResult> =>
  new Promise<TurnRoundResult>((_resolve, reject) => {
    opts.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
      once: true,
    });
  });

function harness(rounds: ScriptedRound[]): Harness {
  const events: RuntimeEvent[] = [];
  const abort = new AbortController();
  const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
  const roundsSeen: ChatMessage[][] = [];
  const attempts: Array<{ round: number; attempt: number }> = [];
  let seq = 0;
  const base = (): RuntimeEventBase => ({
    eventId: `ev-${++seq}`,
    provider: "fake",
    threadId: "thread-1",
    turnId: "turn-1",
    createdAt: new Date().toISOString(),
  });
  return {
    events,
    abort,
    messages,
    roundsSeen,
    attempts,
    run: (over) =>
      runTurnLoop({
        base,
        emit: over?.emit ?? ((event) => events.push(event)),
        messages,
        signal: abort.signal,
        toolHost: over?.toolHost,
        requestApproval: over?.requestApproval,
        budget: over?.budget,
        now: over?.now,
        retryDelayScale: over?.retryDelayScale,
        computeCost: over?.computeCost,
        tools: over?.tools,
        runRound: async (roundMessages, opts) => {
          roundsSeen.push(roundMessages.map((m) => ({ ...m })));
          attempts.push({ round: opts.round, attempt: opts.attempt });
          const scripted = rounds[Math.min(opts.round - 1, rounds.length - 1)];
          if (typeof scripted === "function") return scripted(opts);
          return scripted;
        },
      }),
  };
}

describe("runTurnLoop — exactly one terminal event on every exit", () => {
  // One row per member of TurnLoopExit.  Adding a member to the union
  // without adding a row here fails the exhaustiveness assertion below.
  const rows: Array<{
    exit: TurnLoopExit;
    build: () => Promise<{ events: RuntimeEvent[]; exit: TurnLoopExit }>;
  }> = [
    {
      exit: "settled",
      build: async () => {
        const h = harness([answer("done")]);
        return { exit: await h.run(), events: h.events };
      },
    },
    {
      exit: "suspended",
      build: async () => {
        const h = harness([wantsTools([call("c1", "request_credential")])]);
        const exit = await h.run({
          toolHost: hostReturning({
            kind: "suspend",
            content: "card shown",
            stopReason: "awaiting_human",
          }),
        });
        return { exit, events: h.events };
      },
    },
    {
      exit: "tool_round_limit",
      build: async () => {
        const h = harness([wantsTools([call("c1")])]);
        const exit = await h.run({
          budget: { maxRounds: 2 },
          toolHost: hostReturning({ kind: "result", content: "[]" }),
        });
        return { exit, events: h.events };
      },
    },
    {
      exit: "wall_clock",
      build: async () => {
        // the whole-turn budget is spent inside round 1, so round 2 never starts
        let clock = 0;
        const h = harness([
          async () => {
            clock += 5_000;
            return wantsTools([call("c1")]);
          },
        ]);
        const exit = await h.run({
          budget: { wallClockMs: 1_000 },
          now: () => clock,
          toolHost: hostReturning({ kind: "result", content: "[]" }),
        });
        return { exit, events: h.events };
      },
    },
    {
      exit: "request_timeout",
      build: async () => {
        vi.useFakeTimers();
        try {
          const h = harness([hangs()]);
          const running = h.run({ budget: { requestTimeoutMs: 5_000 } });
          await vi.advanceTimersByTimeAsync(6_000);
          const exit = await running;
          return { exit, events: h.events };
        } finally {
          vi.useRealTimers();
        }
      },
    },
    {
      exit: "provider_error",
      build: async () => {
        const h = harness([
          async () => {
            throw new Error("MiniMax HTTP 502: bad gateway");
          },
        ]);
        return { exit: await h.run(), events: h.events };
      },
    },
    {
      exit: "interrupted",
      build: async () => {
        const h = harness([wantsTools([call("c1")]), answer("late")]);
        // Stop lands while the tool is running — the window that used to be
        // a silent no-op
        const exit = await h.run({
          toolHost: {
            execute: async () => {
              h.abort.abort();
              return new Promise<TurnToolOutcome>(() => undefined);
            },
          },
        });
        return { exit, events: h.events };
      },
    },
    {
      exit: "internal_error",
      build: async () => {
        const h = harness([answer("boom")]);
        const events: RuntimeEvent[] = [];
        const exit = await h.run({
          emit: (event) => {
            // an unexpected throw from deep inside the round body: the kind
            // of bug that used to strand a turn with no terminal event
            if (event.type === "item.completed" && event.itemType === "assistant_text") {
              throw new Error("a consumer blew up");
            }
            events.push(event);
          },
        });
        return { exit, events };
      },
    },
  ];

  it("covers every member of the closed exit union", () => {
    const covered = new Set(rows.map((r) => r.exit));
    expect([...covered].sort()).toEqual(Object.keys(STOP_REASON).sort());
    expect(Object.keys(TERMINAL_OK).sort()).toEqual(Object.keys(STOP_REASON).sort());
  });

  for (const row of rows) {
    it(`${row.exit}: emits exactly one turn.completed, with its stop reason`, async () => {
      const { events, exit } = await row.build();
      expect(exit).toBe(row.exit);
      const settled = terminals(events);
      expect(settled).toHaveLength(1);
      expect(settled[0].ok).toBe(TERMINAL_OK[row.exit]);
      expect(settled[0].stopReason).toBe(STOP_REASON[row.exit]);
      // cost is priced in a later PR; a hard-coded 0 would read as "free"
      expect(settled[0].cost).toBeNull();
    });
  }
});

describe("runTurnLoop — the turn is settled by exactly one place", () => {
  it("drops the driver's active entry BEFORE the terminal event, so a synchronous drain can redispatch", async () => {
    const order: string[] = [];
    const h = harness([answer("done")]);
    await runTurnLoop({
      base: () => ({
        eventId: "e",
        provider: "fake",
        threadId: "thread-1",
        turnId: "turn-1",
        createdAt: new Date().toISOString(),
      }),
      emit: (event) => {
        if (event.type === "turn.completed") order.push("terminal");
      },
      messages: h.messages,
      signal: h.abort.signal,
      onSettled: () => order.push("released"),
      runRound: async () => answer("done"),
    });
    expect(order).toEqual(["released", "terminal"]);
  });

  it("reports an error chip for every non-ok exit except an interrupt", async () => {
    const failing = harness([
      async () => {
        throw new Error("MiniMax HTTP 500");
      },
    ]);
    await failing.run();
    expect(failing.events.filter((e) => e.type === "runtime.error")).toHaveLength(1);
    expect(failing.events.find((e) => e.type === "runtime.error")).toMatchObject({
      message: "MiniMax HTTP 500",
    });

    const stopped = harness([wantsTools([call("c1")])]);
    await stopped.run({
      toolHost: {
        execute: async () => {
          stopped.abort.abort();
          return new Promise<TurnToolOutcome>(() => undefined);
        },
      },
    });
    // an interrupt is a decision, not a failure — no red chip
    expect(stopped.events.filter((e) => e.type === "runtime.error")).toHaveLength(0);
  });

  it("settles as interrupted when Stop lands BETWEEN rounds", async () => {
    const h = harness([wantsTools([call("c1")]), answer("never reached")]);
    const exit = await h.run({
      toolHost: {
        execute: async () => {
          // the tool finishes, then Stop arrives before the next request
          h.abort.abort();
          return { kind: "result", content: "[]" } as TurnToolOutcome;
        },
      },
    });
    expect(exit).toBe("interrupted");
    expect(terminals(h.events)).toHaveLength(1);
    expect(h.roundsSeen).toHaveLength(1);
  });

  it("settles as interrupted when the turn is already aborted at dispatch", async () => {
    const h = harness([answer("should not run")]);
    h.abort.abort();
    const exit = await h.run();
    expect(exit).toBe("interrupted");
    expect(h.roundsSeen).toHaveLength(0);
    expect(terminals(h.events)).toHaveLength(1);
  });
});

describe("runTurnLoop — usage", () => {
  it("sums usage across rounds and carries the total on the terminal event", async () => {
    const h = harness([
      wantsTools([call("c1")], { input: 10, output: 5 }),
      answer("done", { input: 7, output: 3 }),
    ]);
    await h.run({ toolHost: hostReturning({ kind: "result", content: "[]" }) });
    expect(terminals(h.events)[0].usage).toEqual({ input: 17, output: 8 });
  });

  it("reports the usage it already streamed even when the turn fails", async () => {
    const h = harness([
      wantsTools([call("c1")], { input: 40, output: 2 }),
      async () => {
        throw new Error("MiniMax HTTP 503");
      },
    ]);
    await h.run({ toolHost: hostReturning({ kind: "result", content: "[]" }) });
    const settled = terminals(h.events)[0];
    expect(settled.ok).toBe(false);
    // a turn that streamed a large prompt and then 5xx'd is no longer billed at zero
    expect(settled.usage).toEqual({ input: 40, output: 2 });
  });

  it("omits usage entirely when no round reported any", async () => {
    const h = harness([answer("done")]);
    await h.run();
    expect(terminals(h.events)[0].usage).toBeUndefined();
  });

  it("prices the terminal event by SUMMING each round's OWN cost, on the success path", async () => {
    const h = harness([
      wantsTools([call("c1")], { input: 10, output: 5 }),
      answer("done", { input: 7, output: 3 }),
    ]);
    const seen: unknown[] = [];
    await h.run({
      toolHost: hostReturning({ kind: "result", content: "[]" }),
      computeCost: (usage) => {
        seen.push(usage);
        return usage.input + usage.output;
      },
    });
    const settled = terminals(h.events)[0];
    expect(settled.ok).toBe(true);
    expect(settled.usage).toEqual({ input: 17, output: 8 });
    // (10+5) + (7+3) = 25, from TWO calls — never one call against the
    // cumulative {input:17, output:8}
    expect(settled.cost).toBe(25);
    expect(seen).toEqual([
      { input: 10, output: 5 },
      { input: 7, output: 3 },
    ]);
  });

  it("prices a size-tiered model from EACH round's own size, never the turn's cumulative size", async () => {
    // Regression: MiniMax-M3 doubles its rate past 512K input tokens PER
    // REQUEST.  Two 300K-input rounds are each under that threshold and
    // must each price at the base rate — pricing them against the
    // cumulative 600K would apply the doubled rate to the whole turn,
    // roughly doubling the bill for a turn no single request of which
    // MiniMax itself billed at the higher tier.
    const tieredCost = (usage: { input: number; output: number }) =>
      usage.input > 512_000 ? usage.input * 2 : usage.input;
    const h = harness([
      wantsTools([call("c1")], { input: 300_000, output: 0 }),
      answer("done", { input: 300_000, output: 0 }),
    ]);
    await h.run({
      toolHost: hostReturning({ kind: "result", content: "[]" }),
      computeCost: tieredCost,
    });
    const settled = terminals(h.events)[0];
    expect(settled.usage).toEqual({ input: 600_000, output: 0 });
    // base rate both times: 300,000 + 300,000 — NOT the doubled rate
    // 600,000 * 2 a cumulative-totals bug would produce
    expect(settled.cost).toBe(600_000);
  });

  it("prices the terminal event on the error path too, from whatever usage streamed before the failure", async () => {
    const h = harness([
      wantsTools([call("c1")], { input: 40, output: 2 }),
      async () => {
        throw new Error("MiniMax HTTP 503");
      },
    ]);
    const exit = await h.run({
      toolHost: hostReturning({ kind: "result", content: "[]" }),
      computeCost: (usage) => usage.input * 2 + usage.output,
    });
    expect(exit).toBe("provider_error");
    const settled = terminals(h.events)[0];
    expect(settled.ok).toBe(false);
    expect(settled.cost).toBe(82);
  });

  it("prices a round that streamed its usage and THEN failed, instead of reporting that turn as free", async () => {
    // Regression: MiniMax reports usage on its own SSE frame, so a request
    // that dies mid-stream — a provider 5xx, a request timeout — can have
    // reported real, billed tokens through `onUsage` before it rejected.
    // The catch folds those into `totals` and sets `sawUsage`, so the
    // terminal event carries them as usage; pricing only the rounds that
    // RESOLVED left `cost` at 0 for a first-round failure, which reads as
    // "this turn was free" rather than as an honest figure.
    const h = harness([
      async (opts) => {
        opts.onUsage?.({ input: 20, output: 9 });
        throw new Error("MiniMax HTTP 503");
      },
    ]);
    const exit = await h.run({ computeCost: (usage) => usage.input * 2 + usage.output });

    expect(exit).toBe("provider_error");
    const settled = terminals(h.events)[0];
    expect(settled.ok).toBe(false);
    expect(settled.usage).toEqual({ input: 20, output: 9 });
    expect(settled.cost).toBe(49);
  });

  it("adds a failed round's own cost to the rounds that already succeeded, once each", async () => {
    const h = harness([
      wantsTools([call("c1")], { input: 40, output: 2 }),
      async (opts) => {
        opts.onUsage?.({ input: 10, output: 1 });
        throw new Error("MiniMax HTTP 503");
      },
    ]);
    await h.run({
      toolHost: hostReturning({ kind: "result", content: "[]" }),
      computeCost: (usage) => usage.input * 2 + usage.output,
    });

    const settled = terminals(h.events)[0];
    expect(settled.usage).toEqual({ input: 50, output: 3 });
    // (40*2 + 2) + (10*2 + 1) = 82 + 21 — the failed round counted ONCE,
    // and priced from its own usage rather than from the {50, 3} total
    expect(settled.cost).toBe(103);
  });

  it("reports an unknown cost — not a partial sum — when the round that failed is the unpriced one", async () => {
    const h = harness([
      wantsTools([call("c1")], { input: 40, output: 2 }),
      async (opts) => {
        opts.onUsage?.({ input: 10, output: 1 });
        throw new Error("MiniMax HTTP 503");
      },
    ]);
    await h.run({
      toolHost: hostReturning({ kind: "result", content: "[]" }),
      computeCost: (usage) => (usage.input === 10 ? null : usage.input),
    });

    expect(terminals(h.events)[0].cost).toBeNull();
  });

  it("never calls computeCost, and never invents a cost, when no round reported usage", async () => {
    const h = harness([answer("done")]);
    const computeCost = vi.fn(() => 99);
    await h.run({ computeCost });
    expect(computeCost).not.toHaveBeenCalled();
    expect(terminals(h.events)[0].cost).toBeNull();
  });

  it("stays null — never 0 — when the driver has no computeCost wired up at all", async () => {
    const h = harness([answer("done", { input: 1, output: 1 })]);
    await h.run();
    expect(terminals(h.events)[0].cost).toBeNull();
  });

  it("makes the WHOLE turn's cost null — never a partial sum — when any round's cost is unknown", async () => {
    // A price table missing a row for whatever model this round ran
    // against returns null for THAT round; the rounds already priced must
    // not be reported as if they were the turn's whole cost.
    let round = 0;
    const h = harness([
      wantsTools([call("c1")], { input: 10, output: 5 }),
      answer("done", { input: 7, output: 3 }),
    ]);
    await h.run({
      toolHost: hostReturning({ kind: "result", content: "[]" }),
      computeCost: () => {
        round += 1;
        return round === 1 ? 5 : null;
      },
    });
    const settled = terminals(h.events)[0];
    expect(settled.usage).toEqual({ input: 17, output: 8 });
    expect(settled.cost).toBeNull();
  });

  it("keeps the live indicator cumulative, never per-round", async () => {
    const h = harness([
      wantsTools([call("c1")], { input: 10, output: 5 }),
      answer("done", { input: 7, output: 3 }),
    ]);
    await h.run({ toolHost: hostReturning({ kind: "result", content: "[]" }) });
    const live = h.events.filter((e) => e.type === "thread.token-usage.updated");
    expect(live.map((e) => (e as { input: number }).input)).toEqual([10, 17]);
  });
});

describe("runTurnLoop — tool results are real", () => {
  it("emits item.completed AFTER the host returns, with the real ok and detail", async () => {
    const h = harness([wantsTools([call("c1", "ask_bot")]), answer("done")]);
    await h.run({
      toolHost: hostReturning({ kind: "error", content: "peer busy", detail: "peer busy" }),
    });
    const completed = h.events.filter((e) => e.type === "item.completed" && e.itemType === "tool");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ ok: false, detail: "peer busy", itemId: "c1" });
  });

  it("a failing tool is information, not an exit — the loop feeds it back and keeps going", async () => {
    const h = harness([wantsTools([call("c1")]), answer("recovered")]);
    const exit = await h.run({ toolHost: hostReturning({ kind: "error", content: "no such bot" }) });
    expect(exit).toBe("settled");
    expect(h.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "c1", content: "no such bot" });
  });

  it("a host that throws cannot leave the turn open", async () => {
    const h = harness([wantsTools([call("c1")]), answer("recovered")]);
    const exit = await h.run({
      toolHost: {
        execute: async () => {
          throw new Error("host exploded");
        },
      },
    });
    expect(exit).toBe("settled");
    expect(terminals(h.events)).toHaveLength(1);
    expect(String(h.messages.at(-1)?.content)).toContain("host exploded");
  });

  it("tells the model plainly when no tool host was attached", async () => {
    const h = harness([wantsTools([call("c1")]), answer("ok then")]);
    const exit = await h.run();
    expect(exit).toBe("settled");
    expect(String(h.messages.at(-1)?.content)).toContain("no tool host");
  });

  it("announces a tool the stream never announced, and never announces one twice", async () => {
    const h = harness([wantsTools([call("c1"), call("c2")]), answer("done")]);
    await runTurnLoop({
      base: () => ({
        eventId: "e",
        provider: "fake",
        threadId: "thread-1",
        turnId: "turn-1",
        createdAt: new Date().toISOString(),
      }),
      emit: (event) => h.events.push(event),
      messages: h.messages,
      signal: h.abort.signal,
      // the streaming reader already opened a row for c1
      startedToolIds: new Set(["c1"]),
      toolHost: hostReturning({ kind: "result", content: "[]" }),
      runRound: async (_m, opts) =>
        opts.round === 1 ? wantsTools([call("c1"), call("c2")]) : answer("done"),
    });
    const started = h.events.filter((e) => e.type === "item.started");
    expect(started.map((e) => e.itemId)).toEqual(["c2"]);
  });

  it("closes the chips of tools that never finished when the turn is stopped", async () => {
    const h = harness([wantsTools([call("c1"), call("c2")])]);
    await h.run({
      toolHost: {
        execute: async (c) => {
          if (c.id === "c1") {
            h.abort.abort();
            return new Promise<TurnToolOutcome>(() => undefined);
          }
          return new Promise<TurnToolOutcome>(() => undefined);
        },
      },
    });
    const completed = h.events.filter((e) => e.type === "item.completed" && e.itemType === "tool");
    expect(completed).toHaveLength(2);
    expect(completed.every((e) => (e as { ok: boolean }).ok === false)).toBe(true);
  });
});

describe("runTurnLoop — rounds", () => {
  it("runs a round's calls concurrently and appends the results in CALL order", async () => {
    let inFlight = 0;
    let peak = 0;
    const h = harness([wantsTools([call("slow", "ask_bot"), call("fast", "ask_bot")]), answer("done")]);
    await h.run({
      toolHost: {
        execute: async (c) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          // the second call finishes first; the transcript must not reorder
          await new Promise((r) => setTimeout(r, c.id === "slow" ? 30 : 1));
          inFlight -= 1;
          return { kind: "result", content: `${c.id} result` };
        },
      },
    });
    expect(peak).toBe(2);
    const toolMessages = h.messages.filter((m) => m.role === "tool");
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(["slow", "fast"]);
    expect(toolMessages.map((m) => m.content)).toEqual(["slow result", "fast result"]);
  });

  it("only ever APPENDS to the messages array, so each round re-sends a byte-identical prefix", async () => {
    const h = harness([
      wantsTools([call("c1")], { input: 1, output: 1 }),
      wantsTools([call("c2")], { input: 1, output: 1 }),
      answer("done"),
    ]);
    await h.run({ toolHost: hostReturning({ kind: "result", content: "[]" }) });
    expect(h.roundsSeen).toHaveLength(3);
    for (let i = 1; i < h.roundsSeen.length; i++) {
      const previous = h.roundsSeen[i - 1];
      expect(h.roundsSeen[i].slice(0, previous.length)).toEqual(previous);
      expect(h.roundsSeen[i].length).toBeGreaterThan(previous.length);
    }
  });

  it("never starts a tool batch on the round it cannot report back on", async () => {
    let executed = 0;
    const h = harness([wantsTools([call("c1")])]);
    const exit = await h.run({
      budget: { maxRounds: 1 },
      toolHost: {
        execute: async () => {
          executed += 1;
          return { kind: "result", content: "[]" };
        },
      },
    });
    expect(exit).toBe("tool_round_limit");
    expect(executed).toBe(0);
    // the row still settles rather than spinning forever
    const completed = h.events.filter((e) => e.type === "item.completed" && e.itemType === "tool");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ ok: false });
  });

  it("lets the host lower the round ceiling", async () => {
    const h = harness([wantsTools([call("c1")])]);
    const exit = await h.run({
      toolHost: { maxRounds: 3, execute: async () => ({ kind: "result", content: "[]" }) },
    });
    expect(exit).toBe("tool_round_limit");
    expect(h.roundsSeen).toHaveLength(3);
  });

  it("a tool that overruns its own budget fails without ending the turn", async () => {
    vi.useFakeTimers();
    try {
      const h = harness([wantsTools([call("c1")]), answer("moving on")]);
      const running = h.run({
        budget: { toolTimeoutMs: 5_000 },
        toolHost: { execute: async () => new Promise<TurnToolOutcome>(() => undefined) },
      });
      await vi.advanceTimersByTimeAsync(6_000);
      const exit = await running;
      expect(exit).toBe("settled");
      expect(String(h.messages.find((m) => m.role === "tool")?.content)).toContain("did not finish");
    } finally {
      vi.useRealTimers();
    }
  });

  // DR9.  One uniform 90s clock is right for a shell command and wrong for a
  // tool whose job is to wait on a peer's entire turn; `ask_bot` was being cut
  // off at 90s, well under the three minutes the fleet documents for a peer
  // reply, and reported as a timeout for a bot that was still working.
  it("honours a per-tool timeout override from the turn's catalog", async () => {
    vi.useFakeTimers();
    try {
      const h = harness([wantsTools([call("c1", "ask_bot")]), answer("moving on")]);
      const running = h.run({
        budget: { toolTimeoutMs: 5_000 },
        tools: [{ name: "ask_bot", timeoutMs: 60_000 }],
        toolHost: { execute: async () => new Promise<TurnToolOutcome>(() => undefined) },
      });

      // long past the uniform ceiling, and the tool is still allowed to run
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.messages.some((m) => m.role === "tool")).toBe(false);

      await vi.advanceTimersByTimeAsync(31_000);
      const exit = await running;
      expect(exit).toBe("settled");
      const reported = String(h.messages.find((m) => m.role === "tool")?.content);
      expect(reported).toContain("did not finish");
      // and the message names the tool's OWN ceiling, not the loop's
      expect(reported).toContain("60s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a tool with no override on the loop's uniform ceiling", async () => {
    vi.useFakeTimers();
    try {
      const h = harness([wantsTools([call("c1", "bash")]), answer("moving on")]);
      const running = h.run({
        budget: { toolTimeoutMs: 5_000 },
        tools: [{ name: "ask_bot", timeoutMs: 60_000 }],
        toolHost: { execute: async () => new Promise<TurnToolOutcome>(() => undefined) },
      });
      await vi.advanceTimersByTimeAsync(6_000);
      const exit = await running;
      expect(exit).toBe("settled");
      expect(String(h.messages.find((m) => m.role === "tool")?.content)).toContain("did not finish within 5s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the whole-turn budget cuts off a request that is still streaming", async () => {
    vi.useFakeTimers();
    try {
      const h = harness([hangs()]);
      const running = h.run({ budget: { wallClockMs: 4_000, requestTimeoutMs: 900_000 } });
      await vi.advanceTimersByTimeAsync(5_000);
      const exit = await running;
      expect(exit).toBe("wall_clock");
      expect(terminals(h.events)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the shipped budget", () => {
  it("is the one the design signed off on", () => {
    expect(DEFAULT_TURN_LOOP_BUDGET).toEqual({
      maxRounds: 12,
      requestTimeoutMs: 600_000,
      requestIdleMs: 120_000,
      toolTimeoutMs: 90_000,
      wallClockMs: 900_000,
      toolConcurrency: 4,
      maxRequestAttempts: 3,
    });
  });
});

describe("runTurnLoop — the round's idle clock and hard ceiling", () => {
  const errors = (events: RuntimeEvent[]) =>
    events.filter((e): e is Extract<RuntimeEvent, { type: "runtime.error" }> => e.type === "runtime.error");

  it("lets a stream that keeps delivering bytes run well past the idle window", async () => {
    vi.useFakeTimers();
    try {
      // 300s of work, a chunk every 30s: never 120s of silence, and inside
      // the 600s hard ceiling — this is the slow reasoning round the old
      // single 180s number cut off.
      const h = harness([trickles(30_000, 300_000)]);
      const running = h.run();
      await vi.advanceTimersByTimeAsync(301_000);
      expect(await running).toBe("settled");
      expect(h.attempts).toHaveLength(1);
      expect(terminals(h.events)[0]).toMatchObject({ ok: true, stopReason: "end_turn" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts published output as progress too", async () => {
    vi.useFakeTimers();
    try {
      const h = harness([
        async (opts) =>
          new Promise<TurnRoundResult>((resolve) => {
            const ticker = setInterval(() => opts.onPublished?.(), 60_000);
            setTimeout(() => {
              clearInterval(ticker);
              resolve(answer("done"));
            }, 250_000);
          }),
      ]);
      const running = h.run();
      await vi.advanceTimersByTimeAsync(251_000);
      expect(await running).toBe("settled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends a silent request at the idle deadline as request_timeout, without a retry", async () => {
    vi.useFakeTimers();
    try {
      const h = harness([hangs()]);
      const running = h.run();
      await vi.advanceTimersByTimeAsync(119_000);
      expect(terminals(h.events)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await running).toBe("request_timeout");
      expect(h.attempts).toHaveLength(1);
      expect(h.events.filter((e) => e.type === "turn.retrying")).toHaveLength(0);
      expect(terminals(h.events)[0]).toMatchObject({ ok: false, stopReason: "timeout" });
      // the prefix sentry-ai.ts treats as an expected timeout, not a crash
      expect(errors(h.events)[0].message).toBe("the model did not answer within 120s — the stream went silent");
    } finally {
      vi.useRealTimers();
    }
  });

  it("measures silence from the LAST chunk, not from the start of the request", async () => {
    vi.useFakeTimers();
    try {
      const h = harness([
        async (opts) =>
          new Promise<TurnRoundResult>((_resolve, reject) => {
            // live for 100s, then silent forever
            const ticker = setInterval(() => opts.onChunk?.(), 10_000);
            setTimeout(() => clearInterval(ticker), 100_000);
            opts.signal.addEventListener("abort", () => {
              clearInterval(ticker);
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      ]);
      const running = h.run();
      // last chunk at 100s: still alive at 215s, gone by 225s
      await vi.advanceTimersByTimeAsync(215_000);
      expect(terminals(h.events)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await running).toBe("request_timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still enforces the hard ceiling on a stream that never goes quiet", async () => {
    vi.useFakeTimers();
    try {
      const h = harness([trickles(10_000, 10_000_000)]);
      const running = h.run({ budget: { requestTimeoutMs: 200_000 } });
      await vi.advanceTimersByTimeAsync(201_000);
      expect(await running).toBe("request_timeout");
      expect(errors(h.events)[0].message).toBe("the model did not answer within 200s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("requestIdleMs: 0 turns the idle clock off for a driver with its own stall guard", async () => {
    vi.useFakeTimers();
    try {
      const h = harness([hangs()]);
      const running = h.run({ budget: { requestIdleMs: 0, requestTimeoutMs: 400_000 } });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(terminals(h.events)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(101_000);
      expect(await running).toBe("request_timeout");
      expect(errors(h.events)[0].message).toBe("the model did not answer within 400s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not count the backoff between attempts as model silence", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const h = harness([
        async (opts) => {
          calls += 1;
          if (calls === 1) throw httpErrorFor(503, "busy");
          return trickles(30_000, 60_000)(opts);
        },
      ]);
      // The ~1s first backoff scaled x60 is longer than the 40s idle
      // window, so a clock left running through the wait would abort the
      // round before the retry ever started.
      const running = h.run({ budget: { requestIdleMs: 40_000 }, retryDelayScale: 60 });
      await vi.advanceTimersByTimeAsync(200_000);
      expect(await running).toBe("settled");
      expect(h.attempts.map((a) => a.attempt)).toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runTurnLoop — typed provider errors (chat-completions/errors.ts)", () => {
  it("a ProviderError('invalid_credentials', …) becomes stopReason error:invalid_credentials and setup:true on the chip", async () => {
    const h = harness([
      async () => {
        throw new ProviderError("invalid_credentials", "HTTP 401: invalid api key");
      },
    ]);
    const exit = await h.run();

    expect(exit).toBe("provider_error");
    const settled = terminals(h.events);
    expect(settled).toHaveLength(1);
    expect(settled[0].ok).toBe(false);
    expect(settled[0].stopReason).toBe("error:invalid_credentials");
    const errorEvent = h.events.find((e) => e.type === "runtime.error");
    expect(errorEvent).toMatchObject({ message: "HTTP 401: invalid api key", setup: true });
  });

  it("a ProviderError('upstream_outage', …) becomes stopReason error:upstream_outage with no setup flag", async () => {
    const h = harness([
      async () => {
        throw new ProviderError("upstream_outage", "HTTP 502: bad gateway");
      },
    ]);
    await h.run();

    const settled = terminals(h.events);
    expect(settled[0].stopReason).toBe("error:upstream_outage");
    const errorEvent = h.events.find((e) => e.type === "runtime.error");
    expect(errorEvent).toMatchObject({ message: "HTTP 502: bad gateway" });
    expect((errorEvent as { setup?: boolean } | undefined)?.setup).toBeUndefined();
  });

  it("a ProviderError('quota_or_region_restriction', …) becomes stopReason error:quota_or_region_restriction", async () => {
    const h = harness([
      async () => {
        throw new ProviderError("quota_or_region_restriction", "HTTP 429: rate limited");
      },
    ]);
    await h.run();

    expect(terminals(h.events)[0].stopReason).toBe("error:quota_or_region_restriction");
  });

  it("an unclassified plain Error keeps today's bare 'error' stopReason and no setup flag", async () => {
    const h = harness([
      async () => {
        throw new Error("HTTP 422: bad request");
      },
    ]);
    await h.run();

    expect(terminals(h.events)[0].stopReason).toBe("error");
    const errorEvent = h.events.find((e) => e.type === "runtime.error");
    expect((errorEvent as { setup?: boolean } | undefined)?.setup).toBeUndefined();
  });
});

// A card in front of a person is not a hung tool.  The 90s per-tool ceiling
// exists to catch a call that will never come back; killing a tool because
// somebody took two minutes to read an approval would make approvals
// unusable on this lane, and — worse — would run the turn's cleanup while a
// card was still answerable.  So the clock STOPS while the card is open.
describe("the per-tool clock pauses under an open card", () => {
  /** A broker that holds its answer until the test releases it, and settles
   *  `unavailable` if the turn is interrupted first — the real one's shape. */
  function heldBroker() {
    const asks: Array<{ tool: string; summary: string }> = [];
    let release: ((outcome: RequestOutcome) => void) | null = null;
    return {
      asks,
      answer: (outcome: RequestOutcome) => release?.(outcome),
      requestApproval: (ask: { tool: string; summary: string; signal?: AbortSignal }) => {
        asks.push({ tool: ask.tool, summary: ask.summary });
        return new Promise<RequestOutcome>((resolve) => {
          release = resolve;
          ask.signal?.addEventListener("abort", () => resolve("unavailable"), { once: true });
        });
      },
    };
  }

  it("does not fire while the card is open, and the tool still finishes", async () => {
    vi.useFakeTimers();
    try {
      const broker = heldBroker();
      const h = harness([wantsTools([call("c1", "ask_bot")]), answer("done")]);
      const running = h.run({
        budget: { toolTimeoutMs: 5_000 },
        requestApproval: broker.requestApproval,
        toolHost: {
          execute: async (_c, runtime) => {
            const verdict = await runtime.requestApproval({ tool: "ask_bot", summary: "ask peer: go" });
            return { kind: "result", content: verdict === "allowed-once" ? "peer replied" : "refused" };
          },
        },
      });

      // far past the per-tool ceiling, with the card still open
      await vi.advanceTimersByTimeAsync(60_000);
      expect(broker.asks).toEqual([{ tool: "ask_bot", summary: "ask peer: go" }]);

      broker.answer("allowed-once");
      await vi.advanceTimersByTimeAsync(10);
      const exit = await running;

      expect(exit).toBe("settled");
      expect(h.messages.find((m) => m.role === "tool")?.content).toBe("peer replied");
      expect(terminals(h.events)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes with the time it had left, not a fresh budget", async () => {
    vi.useFakeTimers();
    try {
      const broker = heldBroker();
      const h = harness([wantsTools([call("c1", "ask_bot")]), answer("moving on")]);
      const running = h.run({
        budget: { toolTimeoutMs: 5_000 },
        requestApproval: broker.requestApproval,
        toolHost: {
          execute: async (_c, runtime) => {
            // 4s of real work, then the ask, then work that never ends
            await new Promise((resolve) => setTimeout(resolve, 4_000));
            await runtime.requestApproval({ tool: "ask_bot", summary: "ask peer: go" });
            return new Promise<TurnToolOutcome>(() => undefined);
          },
        },
      });

      await vi.advanceTimersByTimeAsync(4_000);
      await vi.advanceTimersByTimeAsync(60_000); // the human reads the card
      expect(broker.asks).toHaveLength(1);
      broker.answer("allowed-once");
      // only 1s of the tool's own budget is left
      await vi.advanceTimersByTimeAsync(2_000);

      const exit = await running;
      expect(exit).toBe("settled");
      expect(String(h.messages.find((m) => m.role === "tool")?.content)).toContain("did not finish");
    } finally {
      vi.useRealTimers();
    }
  });

  it("no broker mounted is fail-closed, and the clock never stopped", async () => {
    const h = harness([wantsTools([call("c1", "ask_bot")]), answer("done")]);
    const seen: RequestOutcome[] = [];
    const exit = await h.run({
      toolHost: {
        execute: async (_c, runtime) => {
          seen.push(await runtime.requestApproval({ tool: "ask_bot", summary: "ask peer: go" }));
          return { kind: "result", content: "refused" };
        },
      },
    });
    expect(seen).toEqual(["unavailable"]);
    expect(exit).toBe("settled");
  });

  it("an interrupt under an open card settles the ask and still emits ONE terminal event", async () => {
    const broker = heldBroker();
    const h = harness([wantsTools([call("c1", "ask_bot")])]);
    const verdicts: RequestOutcome[] = [];
    const running = h.run({
      requestApproval: broker.requestApproval,
      toolHost: {
        execute: async (_c, runtime) => {
          verdicts.push(await runtime.requestApproval({ tool: "ask_bot", summary: "ask peer: go" }));
          return { kind: "result", content: "never reached" };
        },
      },
    });

    // let the round reach the tool, then Stop
    await new Promise((resolve) => setTimeout(resolve, 5));
    h.abort.abort();
    const exit = await running;

    expect(exit).toBe("interrupted");
    // the ask settled rather than hanging forever on a card nobody can answer
    expect(verdicts).toEqual(["unavailable"]);
    const completed = terminals(h.events);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ ok: false, stopReason: "interrupted" });
  });
});

// ── bounded retry with backoff ─────────────────────────────────────────
// The rule the rest of this file already enforces holds through every one
// of these: a retried round is still ONE turn with ONE terminal event.
// What is new is what happens between the attempts — which failures earn
// one, which never do, and what stops one from starting.
describe("runTurnLoop — bounded retry with backoff", () => {
  const retries = (events: RuntimeEvent[]) =>
    events.filter((e): e is Extract<RuntimeEvent, { type: "turn.retrying" }> => e.type === "turn.retrying");

  /** A response whose only header is a `Retry-After`, in the read-only
   *  shape `httpErrorFor` asks for. */
  const retryAfter = (value: string) => ({ get: (name: string) => (name === "retry-after" ? value : null) });

  /** Fails the first `failures` attempts with `error`, then answers. */
  const failsThenAnswers = (failures: number, error: () => Error, reply: TurnRoundResult) => {
    let seen = 0;
    return async (): Promise<TurnRoundResult> => {
      if (seen++ < failures) throw error();
      return reply;
    };
  };

  it("rides out a 502 and reports the turn that eventually worked, once", async () => {
    const h = harness([
      failsThenAnswers(1, () => httpErrorFor(502, "bad gateway"), answer("here you go", { input: 7, output: 3 })),
    ]);
    const exit = await h.run({ retryDelayScale: 0.001 });

    expect(exit).toBe("settled");
    expect(h.attempts).toEqual([
      { round: 1, attempt: 1 },
      { round: 1, attempt: 2 },
    ]);
    const retried = retries(h.events);
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({ attempt: 1, reason: "server_error" });
    expect(retried[0].delayMs).toBeGreaterThan(0);
    // nothing chat-visible about the hiccup, and exactly one answer
    expect(h.events.filter((e) => e.type === "runtime.error")).toHaveLength(0);
    expect(h.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text")).toHaveLength(1);
    const completed = terminals(h.events);
    expect(completed).toHaveLength(1);
    // the failed attempt contributed nothing; only the one that answered
    expect(completed[0]).toMatchObject({ ok: true, stopReason: "end_turn", usage: { input: 7, output: 3 } });
  });

  it("honours a 429's Retry-After instead of its own schedule", async () => {
    const h = harness([
      failsThenAnswers(1, () => httpErrorFor(429, "slow down", retryAfter("2")), answer("ok")),
    ]);
    const exit = await h.run({ retryDelayScale: 0.001 });

    expect(exit).toBe("settled");
    // 2000 is the header's own number; the schedule's first step is
    // 1000 ± 25%, so this can only have come from Retry-After
    expect(retries(h.events).map((e) => ({ delayMs: e.delayMs, reason: e.reason }))).toEqual([
      { delayMs: 2_000, reason: "rate_limited" },
    ]);
    expect(h.attempts).toHaveLength(2);
  });

  it("caps a Retry-After a provider set past the ceiling", async () => {
    const h = harness([
      failsThenAnswers(1, () => httpErrorFor(429, "slow down", retryAfter("600")), answer("ok")),
    ]);
    await h.run({ retryDelayScale: 0.001 });

    expect(retries(h.events)[0].delayMs).toBe(RETRY_AFTER_CAP_MS);
  });

  it("spends exactly one polite retry on a 429 that named no cool-down, then reads as quota", async () => {
    const h = harness([
      async () => {
        throw httpErrorFor(429, "rate limit exceeded");
      },
    ]);
    const exit = await h.run({ retryDelayScale: 0.001 });

    expect(exit).toBe("provider_error");
    expect(h.attempts).toHaveLength(2);
    // the fallback ladder reads this code — a real quota wall has to reach
    // it rather than disappearing into a backoff nobody's balance outlasts
    const completed = terminals(h.events);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ ok: false, stopReason: "error:quota_or_region_restriction" });
  });

  it("gives up after three attempts and still ends as upstream_outage, once", async () => {
    const h = harness([
      async () => {
        throw httpErrorFor(502, "bad gateway");
      },
    ]);
    const exit = await h.run({ retryDelayScale: 0.001 });

    expect(exit).toBe("provider_error");
    expect(h.attempts).toEqual([
      { round: 1, attempt: 1 },
      { round: 1, attempt: 2 },
      { round: 1, attempt: 3 },
    ]);
    expect(retries(h.events).map((e) => e.attempt)).toEqual([1, 2]);
    const completed = terminals(h.events);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ ok: false, stopReason: "error:upstream_outage" });
    expect(h.events.filter((e) => e.type === "runtime.error")).toHaveLength(1);
  });

  it("honours a cool-down a 503 named, instead of its own schedule", async () => {
    const h = harness([
      failsThenAnswers(1, () => httpErrorFor(503, "back soon", retryAfter("2")), answer("ok")),
    ]);
    await h.run({ retryDelayScale: 0.001 });

    expect(retries(h.events).map((e) => e.delayMs)).toEqual([2_000]);
  });

  it("carries THIS failure's own attempt ceiling, so the chip never promises a try that is not coming", async () => {
    const h = harness([
      async () => {
        throw httpErrorFor(429, "rate limit exceeded");
      },
    ]);
    await h.run({ retryDelayScale: 0.001 });

    // a 429 with no cool-down is worth two attempts, not the global three
    expect(retries(h.events).map((e) => e.maxAttempts)).toEqual([2]);

    const outage = harness([
      async () => {
        throw httpErrorFor(502, "bad gateway");
      },
    ]);
    await outage.run({ retryDelayScale: 0.001 });
    expect(retries(outage.events).map((e) => e.maxAttempts)).toEqual([3, 3]);
  });

  it("rides out a 529 — the overloaded status the plan's criterion names", async () => {
    // docs/plans/agent-harness-upgrades-v2.md §3.4 is done only when a
    // simulated 529 produces a VISIBLE retry and a COMPLETED turn.  Both
    // halves are asserted here, on the same path a 502 takes.
    const h = harness([
      failsThenAnswers(1, () => httpErrorFor(529, "overloaded"), answer("recovered", { input: 5, output: 2 })),
    ]);
    const exit = await h.run({ retryDelayScale: 0.001 });

    expect(exit).toBe("settled");
    expect(h.attempts).toHaveLength(2);
    expect(retries(h.events).map((e) => ({ reason: e.reason, maxAttempts: e.maxAttempts }))).toEqual([
      { reason: "server_error", maxAttempts: 3 },
    ]);
    expect(terminals(h.events)[0]).toMatchObject({ ok: true, stopReason: "end_turn", usage: { input: 5, output: 2 } });
  });

  it("retries a stream that died before its first delta", async () => {
    // Node's fetch reports an abrupt close of an already-200 response as
    // `TypeError: terminated` — a shape with no status and no wording the
    // text classifier matches, so it used to read as terminal.  Nothing
    // was published, so replaying it shows the person nothing twice.
    const prematureClose = () => {
      const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
      cause.name = "SocketError";
      return Object.assign(new TypeError("terminated"), { cause });
    };
    const h = harness([failsThenAnswers(1, prematureClose, answer("recovered"))]);
    const exit = await h.run({ retryDelayScale: 0.001 });

    expect(exit).toBe("settled");
    expect(h.attempts).toHaveLength(2);
    expect(retries(h.events).map((e) => ({ reason: e.reason, maxAttempts: e.maxAttempts }))).toEqual([
      { reason: "connection_reset", maxAttempts: 3 },
    ]);
    // one answer, one terminal event, nothing chat-visible about the drop
    expect(h.events.filter((e) => e.type === "runtime.error")).toHaveLength(0);
    expect(h.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text")).toHaveLength(1);
    expect(terminals(h.events)).toHaveLength(1);
  });

  it("gives a 429 that reached it as bare text the same one polite retry", async () => {
    // a driver still throwing `new Error("HTTP 429")` instead of going
    // through httpErrorFor must not get a MORE generous policy than one
    // that reports its status properly
    const h = harness([
      async () => {
        throw new Error("HTTP 429: rate limit exceeded");
      },
    ]);
    await h.run({ retryDelayScale: 0.001 });

    expect(h.attempts).toHaveLength(2);
    expect(retries(h.events).map((e) => ({ reason: e.reason, maxAttempts: e.maxAttempts }))).toEqual([
      { reason: "rate_limited", maxAttempts: 2 },
    ]);
  });

  it("lowers the named ceiling to the budget's, never above it", async () => {
    const h = harness([
      async () => {
        throw httpErrorFor(502, "bad gateway");
      },
    ]);
    await h.run({ budget: { maxRequestAttempts: 2 }, retryDelayScale: 0.001 });

    expect(h.attempts).toHaveLength(2);
    expect(retries(h.events).map((e) => e.maxAttempts)).toEqual([2]);
  });

  it("retries a bare network failure through the same classifier the CLI drivers use", async () => {
    const h = harness([failsThenAnswers(1, () => new TypeError("fetch failed"), answer("ok"))]);
    const exit = await h.run({ retryDelayScale: 0.001 });

    expect(exit).toBe("settled");
    expect(retries(h.events).map((e) => e.reason)).toEqual(["connection_reset"]);
  });

  it("never retries a bad key — a 401 is not a hiccup, and the setup chip has to arrive", async () => {
    const h = harness([
      async () => {
        throw httpErrorFor(401, "invalid api key");
      },
    ]);
    const exit = await h.run({ retryDelayScale: 0.001 });

    expect(exit).toBe("provider_error");
    expect(h.attempts).toHaveLength(1);
    expect(retries(h.events)).toHaveLength(0);
    expect(h.events.find((e) => e.type === "runtime.error")).toMatchObject({ setup: true });
    expect(terminals(h.events)).toHaveLength(1);
    expect(terminals(h.events)[0]).toMatchObject({ ok: false, stopReason: "error:invalid_credentials" });
  });

  it("never retries 400, 404, 413 or 422 either", async () => {
    for (const status of [400, 404, 413, 422]) {
      const h = harness([
        async () => {
          throw httpErrorFor(status, "no");
        },
      ]);
      await h.run({ retryDelayScale: 0.001 });
      expect(h.attempts, `status ${status}`).toHaveLength(1);
      expect(terminals(h.events), `status ${status}`).toHaveLength(1);
    }
  });

  it("never retries a round that already put a delta on the bus", async () => {
    // the duplicate-output hazard: replaying this round would show the
    // person the half-answer they have already read a second time
    const h = harness([
      async (opts) => {
        opts.onPublished?.();
        throw httpErrorFor(502, "died mid-stream");
      },
    ]);
    const exit = await h.run({ retryDelayScale: 0.001 });

    expect(exit).toBe("provider_error");
    expect(h.attempts).toHaveLength(1);
    expect(retries(h.events)).toHaveLength(0);
    const completed = terminals(h.events);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ ok: false, stopReason: "error:upstream_outage" });
  });

  it("never retries an attempt that already reported usage, and still bills it", async () => {
    const h = harness([
      async (opts) => {
        opts.onUsage?.({ input: 20, output: 9 });
        throw httpErrorFor(503, "gone");
      },
    ]);
    await h.run({ retryDelayScale: 0.001 });

    expect(h.attempts).toHaveLength(1);
    expect(retries(h.events)).toHaveLength(0);
    // an attempt real enough to be billed is settled and accounted for,
    // never silently redone
    expect(terminals(h.events)[0]).toMatchObject({ ok: false, usage: { input: 20, output: 9 } });
  });

  it("a Stop during the backoff settles the turn at once, with no further request", async () => {
    const h = harness([
      async () => {
        // lands well inside the ~1s first backoff, which this row runs at
        // full length on purpose
        setTimeout(() => h.abort.abort(), 5);
        throw httpErrorFor(503, "service unavailable");
      },
    ]);
    const exit = await h.run();

    expect(exit).toBe("interrupted");
    expect(h.attempts).toHaveLength(1);
    expect(retries(h.events)).toHaveLength(1);
    // an interrupt is not an error — no chip, one terminal event
    expect(h.events.filter((e) => e.type === "runtime.error")).toHaveLength(0);
    const completed = terminals(h.events);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ ok: false, stopReason: "interrupted" });
  });

  it("declines a retry it could not finish inside the round's own ceiling", async () => {
    const h = harness([
      async () => {
        throw httpErrorFor(502, "bad gateway");
      },
    ]);
    // 5s left on the request ceiling against a ~1s backoff plus the 20s of
    // headroom an attempt needs to be worth starting
    const exit = await h.run({ budget: { requestTimeoutMs: 5_000 }, retryDelayScale: 0.001 });

    expect(exit).toBe("provider_error");
    expect(h.attempts).toHaveLength(1);
    expect(retries(h.events)).toHaveLength(0);
    // the provider's real error, not a timeout it was slept into
    expect(terminals(h.events)[0]).toMatchObject({ ok: false, stopReason: "error:upstream_outage" });
  });

  it("declines a retry the whole-turn wall clock could not finish either", async () => {
    const h = harness([
      async () => {
        throw httpErrorFor(502, "bad gateway");
      },
    ]);
    const exit = await h.run({ budget: { wallClockMs: 5_000 }, retryDelayScale: 0.001 });

    expect(exit).toBe("provider_error");
    expect(h.attempts).toHaveLength(1);
    expect(retries(h.events)).toHaveLength(0);
  });

  it("retries each ROUND on its own budget, so a long turn is not starved by an early hiccup", async () => {
    const h = harness([
      failsThenAnswers(1, () => httpErrorFor(502, "x"), wantsTools([call("c1")])),
      failsThenAnswers(1, () => httpErrorFor(502, "x"), answer("done")),
    ]);
    const exit = await h.run({
      retryDelayScale: 0.001,
      toolHost: hostReturning({ kind: "result", content: "[]" }),
    });

    expect(exit).toBe("settled");
    expect(h.attempts).toEqual([
      { round: 1, attempt: 1 },
      { round: 1, attempt: 2 },
      { round: 2, attempt: 1 },
      { round: 2, attempt: 2 },
    ]);
    expect(terminals(h.events)).toHaveLength(1);
  });

  it("can be switched off entirely by the budget", async () => {
    const h = harness([
      async () => {
        throw httpErrorFor(502, "bad gateway");
      },
    ]);
    await h.run({ budget: { maxRequestAttempts: 1 }, retryDelayScale: 0.001 });

    expect(h.attempts).toHaveLength(1);
    expect(retries(h.events)).toHaveLength(0);
  });
});
