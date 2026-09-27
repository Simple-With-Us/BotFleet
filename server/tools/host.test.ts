// The tool host is the harness side of a driver-owned turn, and after the
// registry landed it owns exactly three things: caller identity, the gate
// that decides which catalog entry a call may reach, and the promise that
// `execute` never throws.  The tool BODIES are tested in `agents.test.ts`
// and the two lanes' definitions in `registry.test.ts`; what is left here is
// the join.
//
// The pinned copy of the `/api/internal/agents` body that used to live in
// this file is gone.  It was a drift detector for a divergence that can no
// longer happen: the host now receives the endpoint function itself.
import { describe, expect, it, vi } from "vitest";

import type { RequestOutcome } from "../contracts.ts";
import { createTurnToolHost, type TurnToolHostDeps } from "./host.ts";
import { listAgentsResponse, type AgentBot, type AgentRequestResult } from "./agents.ts";

const bots: AgentBot[] = [
  { id: "bot-self", name: "self", section: "ops", modelSelection: { model: "m" }, title: "self title" },
  { id: "bot-peer", name: "peer", section: "ops", modelSelection: { model: "m" }, title: "peer title" },
  { id: "bot-busy", name: "busy", section: "ops", modelSelection: { model: "m" }, busy: true },
  { id: "bot-hidden", name: "hidden", section: "ops", modelSelection: { model: "m" }, hidden: true },
  { id: "bot-other", name: "other", section: "research", modelSelection: { model: "m" } },
];

function deps(over: Partial<TurnToolHostDeps> = {}): TurnToolHostDeps {
  return {
    // The real endpoint bodies, bound to a fixture roster — the same
    // functions `index.ts` exports and binds to the live store.
    executeListAgentsRequest: ({ selfId }) => listAgentsResponse(selfId, bots),
    executeAskBotRequest: vi.fn(
      async (): Promise<AgentRequestResult> => ({ status: 200, body: {} }),
    ),
    executeListRoutinesRequest: () => ({
      status: 200,
      body: { now: "2026-09-12T10:00:00.000Z", timeZone: "UTC", routines: [] },
    }),
    executeDelegateBotRequest: vi.fn(
      async (): Promise<AgentRequestResult> => ({ status: 200, body: { queued: true, message: "Delegation queued." } }),
    ),
    executeCreateBotRequest: vi.fn(
      async (): Promise<AgentRequestResult> => ({ status: 201, body: { id: "bot-new", name: "Pixel", section: "Work" } }),
    ),
    executeRequestCredentialRequest: vi.fn(
      async (): Promise<AgentRequestResult> => ({ status: 201, body: { messageId: "msg-1", label: "OpenCode API key" } }),
    ),
    executeRoutineRequestRequest: vi.fn(
      async (): Promise<AgentRequestResult> => ({ status: 201, body: { summary: "Weekdays at 09:00" } }),
    ),
    ...over,
  };
}

const hostFor = (
  over: Partial<TurnToolHostDeps> = {},
  ctx: { commsDepth?: number; chiefOfStaff?: boolean; localComputer?: boolean; workspace?: boolean; cwd?: string } = {},
) =>
  createTurnToolHost({
    botId: "bot-self",
    threadId: "thread-1",
    commsDepth: ctx.commsDepth ?? 0,
    chiefOfStaff: ctx.chiefOfStaff,
    localComputer: ctx.localComputer,
    workspace: ctx.workspace,
    cwd: ctx.cwd,
    deps: deps(over),
  });

/** The loop's runtime, with a broker that says yes.  The rows in "the host
 *  asks before a write tool runs" cover deny and no-broker explicitly; the
 *  rest of this file is about what happens once a call is allowed. */
const runtime = { signal: new AbortController().signal, requestApproval: async () => "allowed-once" as const };

/** A runtime that records what it was asked and answers with `verdict`. */
function askingRuntime(verdict: RequestOutcome) {
  const asks: Array<{ tool: string; summary: string; approvalScope?: "local-computer" }> = [];
  return {
    asks,
    runtime: {
      signal: new AbortController().signal,
      requestApproval: async (ask: { tool: string; summary: string; approvalScope?: "local-computer" }) => {
        asks.push(ask);
        return verdict;
      },
    },
  };
}

describe("the host runs what the catalog advertised", () => {
  it("serves the registry's three agents tools", async () => {
    const host = hostFor();
    for (const name of ["list_bots", "ask_bot", "list_routines"]) {
      const outcome = await host.execute({ id: "1", name, arguments: { bot_id: "bot-peer", task: "x" } }, runtime);
      expect(outcome.content, name).not.toContain("is not available to this bot");
    }
  });

  it("matches the /api/internal/agents rows the MCP lane serves", async () => {
    const outcome = await hostFor().execute({ id: "1", name: "list_bots", arguments: {} }, runtime);
    expect(outcome.kind).toBe("result");
    expect(JSON.parse(outcome.content).bots).toEqual(listAgentsResponse("bot-self", bots).body.bots);
  });

  it("serves `section` alongside the rows, as it did before the registry", async () => {
    // The host is the lane that regressed: `host.ts` used to build
    // `{ section, bots }` inline.  Pinned here as well as in
    // `agents.test.ts` so neither side can drop it alone.
    const outcome = await hostFor().execute({ id: "1", name: "list_bots", arguments: {} }, runtime);
    const payload = JSON.parse(outcome.content);
    expect(payload.section).toBe("ops");
    expect(payload.section).toBe(listAgentsResponse("bot-self", bots).body.section);
  });

  it("excludes the caller and reports busy — the two facts that save a round", async () => {
    const outcome = await hostFor().execute({ id: "1", name: "list_bots", arguments: {} }, runtime);
    const rows: Array<{ id: string; busy: boolean }> = JSON.parse(outcome.content).bots;
    expect(rows.map((b) => b.id)).not.toContain("bot-self");
    expect(rows.find((b) => b.id === "bot-busy")?.busy).toBe(true);
  });

  it("hides other sections and hidden bots", async () => {
    const outcome = await hostFor().execute({ id: "1", name: "list_bots", arguments: {} }, runtime);
    const ids = JSON.parse(outcome.content).bots.map((b: { id: string }) => b.id);
    expect(ids).not.toContain("bot-other");
    expect(ids).not.toContain("bot-hidden");
  });

  it("fails clearly when the caller no longer exists", async () => {
    const host = createTurnToolHost({
      botId: "gone",
      threadId: "thread-1",
      commsDepth: 0,
      deps: deps(),
    });
    const outcome = await host.execute({ id: "1", name: "list_bots", arguments: {} }, runtime);
    expect(outcome.kind).toBe("error");
  });
});

describe("caller identity is the turn's, never the model's", () => {
  it("bakes botId, threadId and depth into ask_bot at dispatch", async () => {
    const executeAskBotRequest = vi.fn(
      async (): Promise<AgentRequestResult> => ({
        status: 200,
        body: { botName: "peer", text: "here you go" },
      }),
    );
    const host = createTurnToolHost({
      botId: "bot-self",
      threadId: "thread-1",
      commsDepth: 1,
      deps: deps({ executeAskBotRequest }),
    });
    const outcome = await host.execute(
      { id: "1", name: "ask_bot", arguments: { bot_id: "@peer", task: "summarize", fromBotId: "bot-other" } },
      runtime,
    );
    expect(executeAskBotRequest).toHaveBeenCalledWith({
      fromBotId: "bot-self",
      toBotId: "bot-peer",
      message: "summarize",
      depth: 1,
      fromThreadId: "thread-1",
    });
    expect(outcome).toMatchObject({ kind: "result", content: "peer replied:\nhere you go" });
  });

  it("ignores a thread the model names for list_routines", async () => {
    const executeListRoutinesRequest = vi.fn(() => ({ status: 200, body: { routines: [] } }));
    await hostFor({ executeListRoutinesRequest }).execute(
      { id: "1", name: "list_routines", arguments: { fromThreadId: "thread-9" } },
      runtime,
    );
    expect(executeListRoutinesRequest).toHaveBeenCalledWith({
      fromBotId: "bot-self",
      fromThreadId: "thread-1",
    });
  });
});

describe("the host's contract", () => {
  it("never throws — a thrown dependency comes back as an error outcome", async () => {
    const outcome = await hostFor({
      executeAskBotRequest: async () => {
        throw new Error("comms bus is down");
      },
    }).execute({ id: "1", name: "ask_bot", arguments: { bot_id: "@peer", task: "x" } }, runtime);
    expect(outcome.kind).toBe("error");
    expect(JSON.parse(outcome.content).error).toBe("comms bus is down");
  });

  it("tells the model plainly about a tool it does not have", async () => {
    const outcome = await hostFor().execute({ id: "1", name: "delete_everything", arguments: {} }, runtime);
    expect(outcome.kind).toBe("error");
    expect(outcome.content).toContain("delete_everything");
  });

  it("carries the harness's broker so the driver's loop can pause its clock around it", () => {
    const requestApproval = async () => "allowed-once" as const;
    const host = createTurnToolHost({
      botId: "bot-self",
      threadId: "thread-1",
      commsDepth: 0,
      deps: deps(),
      requestApproval,
    });
    expect(host.requestApproval).toBe(requestApproval);
    // absent when no broker was mounted, so the loop can tell
    expect(hostFor().requestApproval).toBeUndefined();
  });

  it("refuses a tool that exists but was never in this turn's catalog", async () => {
    // create_bot's executor exists now, but its registry gate requires
    // chiefOfStaff, and this turn's default context does not carry it — a
    // non-chief bot must not find an executor waiting for a tool it was
    // never offered.
    const outcome = await hostFor().execute({ id: "1", name: "create_bot", arguments: {} }, runtime);
    expect(outcome.kind).toBe("error");
    expect(outcome.content).toContain("is not available to this bot");
  });

  it("still refuses a genuinely unknown name outright", async () => {
    const outcome = await hostFor().execute({ id: "1", name: "delete_everything", arguments: {} }, runtime);
    expect(outcome.kind).toBe("error");
    expect(outcome.content).toContain("delete_everything");
  });
});

describe("the six tools PR 7 added", () => {
  it("offers create_bot to an actual Chief of Staff and runs it", async () => {
    const executeCreateBotRequest = vi.fn(
      async (): Promise<AgentRequestResult> => ({ status: 201, body: { id: "bot-new", name: "Pixel", section: "Work" } }),
    );
    const host = hostFor({ executeCreateBotRequest }, { chiefOfStaff: true });
    const outcome = await host.execute(
      { id: "1", name: "create_bot", arguments: { name: "Pixel", role: "Designer", instructions: "Design." } },
      runtime,
    );
    expect(outcome.kind).toBe("result");
    expect(executeCreateBotRequest).toHaveBeenCalledTimes(1);
  });

  it("gives create_bot's per-turn cap a fresh count on a second turn's host", async () => {
    let created = 0;
    const executeCreateBotRequest = vi.fn(async (): Promise<AgentRequestResult> => {
      created += 1;
      return { status: 201, body: { id: `bot-${created}`, name: `Bot${created}`, section: "Work" } };
    });
    const args = { name: "N", role: "R", instructions: "I" };
    const firstTurnHost = hostFor({ executeCreateBotRequest }, { chiefOfStaff: true });
    for (let i = 0; i < 4; i++) {
      const outcome = await firstTurnHost.execute({ id: String(i), name: "create_bot", arguments: args }, runtime);
      expect(outcome.kind, `create #${i + 1}`).toBe("result");
    }
    const capped = await firstTurnHost.execute({ id: "5", name: "create_bot", arguments: args }, runtime);
    expect(capped.kind).toBe("error");
    expect(capped.content).toMatch(/at most 4 bots/);

    // A brand-new `createTurnToolHost` call — what dispatching a SECOND
    // turn does — must not remember the first turn's count.
    const secondTurnHost = hostFor({ executeCreateBotRequest }, { chiefOfStaff: true });
    const fresh = await secondTurnHost.execute({ id: "6", name: "create_bot", arguments: args }, runtime);
    expect(fresh.kind).toBe("result");
  });

  it("delegate_bot asks before it runs, carrying the target and the first 120 chars", async () => {
    const executeDelegateBotRequest = vi.fn(
      async (): Promise<AgentRequestResult> => ({ status: 200, body: { queued: true, message: "Delegation queued." } }),
    );
    const asking = askingRuntime("allowed-once");
    const longTask = "x".repeat(200);
    const outcome = await hostFor({ executeDelegateBotRequest }).execute(
      { id: "1", name: "delegate_bot", arguments: { bot_id: "bot-peer", message: longTask } },
      asking.runtime,
    );
    expect(asking.asks).toHaveLength(1);
    expect(asking.asks[0].tool).toBe("delegate_bot");
    expect(asking.asks[0].summary).toContain("bot-peer");
    expect(asking.asks[0].summary.length).toBeLessThan(longTask.length);
    expect(outcome.kind).toBe("result");
    expect(executeDelegateBotRequest).toHaveBeenCalledTimes(1);
  });

  it("a denied delegate_bot never reaches the endpoint — nothing is queued", async () => {
    const executeDelegateBotRequest = vi.fn(async (): Promise<AgentRequestResult> => ({ status: 200, body: {} }));
    const asking = askingRuntime("rejected");
    const outcome = await hostFor({ executeDelegateBotRequest }).execute(
      { id: "1", name: "delegate_bot", arguments: { bot_id: "bot-peer", message: "do it" } },
      asking.runtime,
    );
    expect(executeDelegateBotRequest).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: "error", detail: "denied" });
  });

  it("request_credential's suspend outcome passes through the host untouched", async () => {
    const outcome = await hostFor().execute(
      { id: "1", name: "request_credential", arguments: { credential_id: "opencodeGoApiKey" } },
      runtime,
    );
    expect(outcome).toMatchObject({ kind: "suspend", stopReason: "awaiting_human" });
  });

  it("propose_routine's suspend outcome passes through the host untouched", async () => {
    const outcome = await hostFor().execute(
      {
        id: "1",
        name: "propose_routine",
        arguments: { name: "Brief", instructions: "x", schedule: { type: "daily", time: "09:00" } },
      },
      runtime,
    );
    expect(outcome).toMatchObject({ kind: "suspend", stopReason: "awaiting_human" });
  });
});

// Before PR 6 nothing on this lane ever asked for permission: an HTTP bot
// ran whatever the model called.  The host is where that changed, and the
// policy is a FIELD ON THE TOOL — not a switch here — so a read tool
// cannot start carding by accident and a write tool cannot stop.
describe("the host asks before a write tool runs", () => {
  it("opens an ask carrying the registry's own summary, and only then runs the tool", async () => {
    const executeAskBotRequest = vi.fn(async () => ({ status: 200, body: { botName: "peer", text: "ok" } }));
    const asking = askingRuntime("allowed-once");
    const outcome = await hostFor({ executeAskBotRequest }).execute(
      { id: "1", name: "ask_bot", arguments: { bot_id: "@peer", task: "summarise  the   log" } },
      asking.runtime,
    );

    expect(asking.asks).toEqual([{ tool: "ask_bot", summary: "ask @peer: summarise the log" }]);
    expect(executeAskBotRequest).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("result");
  });

  it("a deny never reaches the executor, and the model is told why", async () => {
    const executeAskBotRequest = vi.fn(async () => ({ status: 200, body: {} }));
    const asking = askingRuntime("rejected");
    const outcome = await hostFor({ executeAskBotRequest }).execute(
      { id: "1", name: "ask_bot", arguments: { bot_id: "@peer", task: "spend the budget" } },
      asking.runtime,
    );

    // the side effect never happened — an approval that arrives after the
    // fact is a receipt, not a decision
    expect(executeAskBotRequest).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: "error", detail: "denied" });
    expect(outcome.content).toContain("was not approved");
  });

  it("no broker mounted is fail-closed — nobody asked is not nobody objected", async () => {
    const executeAskBotRequest = vi.fn(async () => ({ status: 200, body: {} }));
    const asking = askingRuntime("unavailable");
    const outcome = await hostFor({ executeAskBotRequest }).execute(
      { id: "1", name: "ask_bot", arguments: { bot_id: "@peer", task: "x" } },
      asking.runtime,
    );

    expect(executeAskBotRequest).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: "error", detail: "approval unavailable" });
  });

  it("a tool with no approval record never asks", async () => {
    const asking = askingRuntime("rejected");
    for (const name of ["list_bots", "list_routines"]) {
      const outcome = await hostFor().execute({ id: "1", name, arguments: {} }, asking.runtime);
      expect(outcome.kind, name).toBe("result");
    }
    // a denying broker proves it: these ran anyway, because they never
    // reached it
    expect(asking.asks).toEqual([]);
  });

  it("asks even when the summary cannot be built", async () => {
    // A card nobody can read is bad; running a write tool unasked is worse.
    const executeAskBotRequest = vi.fn(async () => ({ status: 200, body: {} }));
    const asking = askingRuntime("rejected");
    await hostFor({ executeAskBotRequest }).execute(
      { id: "1", name: "ask_bot", arguments: { bot_id: { nested: "object" }, task: 42 } },
      asking.runtime,
    );
    expect(asking.asks).toHaveLength(1);
    expect(executeAskBotRequest).not.toHaveBeenCalled();
  });
});

describe("host computer tools on HTTP lane", () => {
  it("rejects computer tools when localComputer is not granted", async () => {
    const outcome = await hostFor({}, { localComputer: false }).execute(
      { id: "1", name: "bash", arguments: { command: "echo hi" } },
      runtime,
    );
    expect(outcome).toMatchObject({ kind: "error", detail: "unknown tool" });
  });

  it("executes read_file without asking for approval", async () => {
    const asking = askingRuntime("rejected");
    const outcome = await hostFor({}, { localComputer: true }).execute(
      { id: "1", name: "read_file", arguments: { path: "package.json", limit: 5 } },
      asking.runtime,
    );
    expect(outcome.kind).toBe("result");
    expect(outcome.content).toContain("1: {");
    expect(asking.asks).toEqual([]);
  });

  it("asks for approval before running bash, executes on allow", async () => {
    const asking = askingRuntime("allowed-once");
    const outcome = await hostFor({}, { localComputer: true }).execute(
      { id: "1", name: "bash", arguments: { command: "echo 'hello host'" } },
      asking.runtime,
    );
    expect(asking.asks).toHaveLength(1);
    expect(asking.asks[0]).toMatchObject({ tool: "bash", summary: "bash: echo 'hello host'", approvalScope: "local-computer" });
    expect(outcome.kind).toBe("result");
    expect(outcome.content).toContain("hello host");
  });

  it("asks for approval before running bash, fails on deny", async () => {
    const asking = askingRuntime("rejected");
    const outcome = await hostFor({}, { localComputer: true }).execute(
      { id: "1", name: "bash", arguments: { command: "echo 'should not run'" } },
      asking.runtime,
    );
    expect(asking.asks).toHaveLength(1);
    expect(outcome).toMatchObject({ kind: "error", detail: "denied" });
    expect(outcome.content).toContain("was not approved");
  });

  it("allows read_file when workspace is set, but rejects bash without localComputer", async () => {
    const outcome = await hostFor({}, { workspace: true, localComputer: false }).execute(
      { id: "1", name: "read_file", arguments: { path: "package.json", limit: 3 } },
      runtime,
    );
    expect(outcome.kind).toBe("result");
    expect(outcome.content).toContain("1: {");

    const bashOutcome = await hostFor({}, { workspace: true, localComputer: false }).execute(
      { id: "2", name: "bash", arguments: { command: "echo hi" } },
      runtime,
    );
    expect(bashOutcome).toMatchObject({ kind: "error", detail: "unknown tool" });
  });
});
