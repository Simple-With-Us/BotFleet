// One implementation, two lanes.
//
// A CLI bot reaches `list_bots` over the loopback + COMMS_TOKEN hop into
// `GET /api/internal/agents`; a MiniMax bot reaches it in-process through
// the turn tool host.  Both must run the SAME code, because the moment they
// do not, they drift — and they did: the old executor filtered on section
// and `!hidden` only, so it offered a bot its own row and never told it a
// peer was busy, which cost a wasted round every time.
//
// These tests pin the join.  `listAgentsResponse` is the endpoint body that
// `index.ts` exports as `executeListAgentsRequest`; the host receives that
// same function as a dependency, so asserting the host's rows equal
// `listAgentsResponse`'s rows is asserting there is one implementation.
import { describe, expect, it, vi } from "vitest";

import {
  createAgentTools,
  listAgentsResponse,
  selectPeerBots,
  type AgentBot,
  type AgentRequestResult,
  type AgentToolCallContext,
  type AgentToolDeps,
  type AskBotRequestInput,
  type CreateBotRequestInput,
  type DelegateBotRequestInput,
  type RequestCredentialRequestInput,
  type RoutineRequestInput,
} from "./agents.ts";

const bots: AgentBot[] = [
  { id: "bot-self", name: "self", section: "ops", modelSelection: { model: "m" }, title: "self title" },
  { id: "bot-peer", name: "peer", section: "ops", modelSelection: { model: "m" }, title: "peer title" },
  { id: "bot-busy", name: "busy", section: "ops", modelSelection: { model: "m" }, busy: true },
  { id: "bot-hidden", name: "hidden", section: "ops", modelSelection: { model: "m" }, hidden: true },
  { id: "bot-other", name: "other", section: "research", modelSelection: { model: "m" } },
];

const routinesBody = {
  now: "2026-09-12T10:00:00.000Z",
  timeZone: "America/Chicago",
  routines: [{ id: "routine-1", name: "Morning brief" }],
};

const deps = (over: Partial<AgentToolDeps> = {}): AgentToolDeps => ({
  // The real endpoint body, bound to a fixed roster instead of the live
  // store — the same function `index.ts` binds to `store.bots`.
  executeListAgentsRequest: ({ selfId }) => listAgentsResponse(selfId, bots),
  executeAskBotRequest: vi.fn(
    async (_input: AskBotRequestInput): Promise<AgentRequestResult> => ({
      status: 200,
      body: { botName: "peer", text: "hi" },
    }),
  ),
  executeListRoutinesRequest: () => ({ status: 200, body: { ...routinesBody } }),
  executeDelegateBotRequest: vi.fn(
    async (_input: DelegateBotRequestInput): Promise<AgentRequestResult> => ({
      status: 200,
      body: { queued: true, message: "Delegation queued." },
    }),
  ),
  executeCreateBotRequest: vi.fn(
    async (_input: CreateBotRequestInput): Promise<AgentRequestResult> => ({
      status: 201,
      body: { id: "bot-new", name: "Pixel", section: "Work" },
    }),
  ),
  executeRequestCredentialRequest: vi.fn(
    async (_input: RequestCredentialRequestInput): Promise<AgentRequestResult> => ({
      status: 201,
      body: { messageId: "msg-1", label: "OpenCode API key" },
    }),
  ),
  executeRoutineRequestRequest: vi.fn(
    async (_input: RoutineRequestInput): Promise<AgentRequestResult> => ({
      status: 201,
      body: { requestId: "req-1", summary: "Weekdays at 09:00" },
    }),
  ),
  ...over,
});

const ctx = (over: Partial<AgentToolCallContext> = {}): AgentToolCallContext => ({
  botId: "bot-self",
  threadId: "thread-1",
  commsDepth: 0,
  ...over,
});

const runtime = {
  signal: new AbortController().signal,
  requestApproval: async () => "unavailable" as const,
};

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: "1", name, arguments: args });

describe("selectPeerBots is the only peer filter", () => {
  it("excludes the caller, hidden bots and other sections, and reports busy", () => {
    const rows = selectPeerBots("bot-self", bots)!;
    expect(rows.map((r) => r.id)).toEqual(["bot-peer", "bot-busy"]);
    expect(rows.find((r) => r.id === "bot-busy")?.busy).toBe(true);
    expect(rows.find((r) => r.id === "bot-peer")?.busy).toBe(false);
    expect(rows.find((r) => r.id === "bot-peer")?.title).toBe("peer title");
  });

  it("refuses an unknown sender rather than leaking the whole roster", () => {
    expect(selectPeerBots("gone", bots)).toBeNull();
    expect(listAgentsResponse("gone", bots)).toEqual({ status: 403, body: { error: "unknown sender" } });
  });
});

describe("list_bots is the same implementation on both lanes", () => {
  it("returns exactly the rows the /api/internal/agents body returns", async () => {
    const tools = createAgentTools(deps());
    const outcome = await tools.list_bots(call("list_bots"), ctx(), runtime);
    expect(outcome.kind).toBe("result");
    // The MCP lane serves `body.bots` verbatim over the hop; the host
    // serialises the same array.  Equality here IS the parity assertion.
    expect(JSON.parse(outcome.content).bots).toEqual(listAgentsResponse("bot-self", bots).body.bots);
  });

  it("still carries `section`, which the pre-registry payload had", async () => {
    // Regression: the refactor out of `host.ts` dropped `section` from the
    // payload.  It is wire-visible — in-flight conversations quote it back —
    // so `{ section, bots }` is the shape, not `{ bots }`.
    const tools = createAgentTools(deps());
    const outcome = await tools.list_bots(call("list_bots"), ctx(), runtime);
    const payload = JSON.parse(outcome.content);
    expect(payload.section).toBe("ops");
    expect(payload.section).toBe(listAgentsResponse("bot-self", bots).body.section);
    expect(Object.keys(payload)).toEqual(["section", "bots"]);
  });

  it("excludes the caller — a bot asking itself for help is a wasted round", async () => {
    const tools = createAgentTools(deps());
    const outcome = await tools.list_bots(call("list_bots"), ctx(), runtime);
    const ids = JSON.parse(outcome.content).bots.map((b: { id: string }) => b.id);
    expect(ids).not.toContain("bot-self");
    expect(ids).toContain("bot-peer");
  });

  it("reports busy identically, so the model does not ask a peer that cannot answer", async () => {
    const tools = createAgentTools(deps());
    const outcome = await tools.list_bots(call("list_bots"), ctx(), runtime);
    const rows: Array<{ id: string; busy: boolean }> = JSON.parse(outcome.content).bots;
    expect(rows.find((b) => b.id === "bot-busy")?.busy).toBe(true);
    expect(rows.find((b) => b.id === "bot-peer")?.busy).toBe(false);
  });

  it("surfaces the endpoint's own refusal when the caller no longer exists", async () => {
    const tools = createAgentTools(deps());
    const outcome = await tools.list_bots(call("list_bots"), ctx({ botId: "gone" }), runtime);
    expect(outcome.kind).toBe("error");
    expect(JSON.parse(outcome.content).error).toBe("unknown sender");
  });
});

describe("ask_bot still goes through executeAskBotRequest", () => {
  it("passes the turn's own identity, never the model's", async () => {
    const executeAskBotRequest = vi.fn(
      async (): Promise<AgentRequestResult> => ({
        status: 200,
        body: { botName: "peer", text: "here you go" },
      }),
    );
    const tools = createAgentTools(deps({ executeAskBotRequest }));
    const outcome = await tools.ask_bot(
      // the model also passes a fromBotId; it must be ignored
      call("ask_bot", { bot_id: "@peer", task: "summarize", fromBotId: "bot-other" }),
      ctx({ commsDepth: 1 }),
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

  it("accepts both advertised argument names — the lanes' declared deviation", async () => {
    const executeAskBotRequest = vi.fn(
      async (_input: AskBotRequestInput): Promise<AgentRequestResult> => ({
        status: 200,
        body: { botName: "peer", text: "ok" },
      }),
    );
    const tools = createAgentTools(deps({ executeAskBotRequest }));
    // `message` is what the MCP lane advertises, `task` what the HTTP lane
    // advertises.  One body has to answer to both.
    await tools.ask_bot(call("ask_bot", { bot_id: "bot-peer", message: "x" }), ctx(), runtime);
    await tools.ask_bot(call("ask_bot", { bot_id: "bot-peer", task: "y" }), ctx(), runtime);
    expect(executeAskBotRequest.mock.calls.map(([input]) => input.message)).toEqual(["x", "y"]);
  });

  it("resolves a target only against the roster the model was shown", async () => {
    const executeAskBotRequest = vi.fn(
      async (): Promise<AgentRequestResult> => ({ status: 200, body: { text: "ok" } }),
    );
    const tools = createAgentTools(deps({ executeAskBotRequest }));
    for (const target of ["bot-hidden", "bot-other", "bot-self"]) {
      const outcome = await tools.ask_bot(call("ask_bot", { bot_id: target, task: "x" }), ctx(), runtime);
      expect(outcome.kind, target).toBe("error");
      expect(JSON.parse(outcome.content).error).toMatch(/no bot matches/);
    }
    expect(executeAskBotRequest).not.toHaveBeenCalled();
  });

  it("requires both arguments", async () => {
    const tools = createAgentTools(deps());
    const outcome = await tools.ask_bot(call("ask_bot", { bot_id: "@peer" }), ctx(), runtime);
    expect(outcome.kind).toBe("error");
    expect(JSON.parse(outcome.content).error).toMatch(/requires both/);
  });

  it("turns a busy peer into something the model can act on", async () => {
    const tools = createAgentTools(
      deps({ executeAskBotRequest: async () => ({ status: 200, body: { busy: true } }) }),
    );
    const outcome = await tools.ask_bot(call("ask_bot", { bot_id: "@peer", task: "x" }), ctx(), runtime);
    expect(outcome.kind).toBe("error");
    expect(JSON.parse(outcome.content).error).toMatch(/busy/);
  });

  it("passes the peer path's own refusal straight through", async () => {
    const tools = createAgentTools(
      deps({ executeAskBotRequest: async () => ({ status: 200, body: { error: "denied by user" } }) }),
    );
    const outcome = await tools.ask_bot(call("ask_bot", { bot_id: "@peer", task: "x" }), ctx(), runtime);
    expect(JSON.parse(outcome.content).error).toBe("denied by user");
  });
});

describe("list_routines", () => {
  it("reports the endpoint's routines with its authoritative clock", async () => {
    const tools = createAgentTools(deps());
    const outcome = await tools.list_routines(call("list_routines"), ctx(), runtime);
    expect(outcome.kind).toBe("result");
    expect(JSON.parse(outcome.content)).toEqual(routinesBody);
    expect(outcome.detail).toBe("1 routine");
  });

  it("passes the turn's own thread, which the endpoint checks ownership of", async () => {
    const executeListRoutinesRequest = vi.fn(() => ({ status: 200, body: { routines: [] } }));
    const tools = createAgentTools(deps({ executeListRoutinesRequest }));
    await tools.list_routines(
      call("list_routines", { fromBotId: "bot-other", fromThreadId: "thread-9", routine_id: "routine-7" }),
      ctx(),
      runtime,
    );
    expect(executeListRoutinesRequest).toHaveBeenCalledWith({
      fromBotId: "bot-self",
      fromThreadId: "thread-1",
      routineId: "routine-7",
    });
  });

  it("hands the endpoint's refusal to the model rather than an empty list", async () => {
    const tools = createAgentTools(
      deps({
        executeListRoutinesRequest: () => ({
          status: 403,
          body: { error: "source conversation does not belong to sender" },
        }),
      }),
    );
    const outcome = await tools.list_routines(call("list_routines"), ctx(), runtime);
    expect(outcome.kind).toBe("error");
    expect(JSON.parse(outcome.content).error).toMatch(/does not belong to sender/);
  });
});

describe("delegate_bot", () => {
  it("queues the handoff with the turn's own identity, never the model's", async () => {
    const executeDelegateBotRequest = vi.fn(
      async (): Promise<AgentRequestResult> => ({ status: 200, body: { queued: true, message: "Delegation queued." } }),
    );
    const tools = createAgentTools(deps({ executeDelegateBotRequest }));
    const outcome = await tools.delegate_bot(
      call("delegate_bot", { bot_id: "bot-peer", message: "take this", reason: "follow-up", fromBotId: "bot-other" }),
      ctx({ commsDepth: 1 }),
      runtime,
    );
    expect(executeDelegateBotRequest).toHaveBeenCalledWith({
      fromBotId: "bot-self",
      toBotId: "bot-peer",
      message: "take this",
      depth: 1,
      fromThreadId: "thread-1",
      reason: "follow-up",
    });
    expect(outcome).toMatchObject({ kind: "result", content: "Delegation queued." });
  });

  it("requires both bot_id and message", async () => {
    const tools = createAgentTools(deps());
    const outcome = await tools.delegate_bot(call("delegate_bot", { bot_id: "bot-peer" }), ctx(), runtime);
    expect(outcome.kind).toBe("error");
    expect(JSON.parse(outcome.content).error).toMatch(/requires both/);
  });

  it("surfaces a queue refusal as an error the model can act on", async () => {
    const tools = createAgentTools(
      deps({
        executeDelegateBotRequest: async () => ({
          status: 200,
          body: { error: "delegation chains are limited to one hop — do this one yourself" },
        }),
      }),
    );
    const outcome = await tools.delegate_bot(call("delegate_bot", { bot_id: "bot-peer", message: "x" }), ctx(), runtime);
    expect(outcome.kind).toBe("error");
    expect(JSON.parse(outcome.content).error).toMatch(/one hop/);
  });
});

describe("create_bot enforces its per-turn cap in this closure", () => {
  it("creates a bot and reports its section", async () => {
    const tools = createAgentTools(deps());
    const outcome = await tools.create_bot(
      call("create_bot", { name: "Pixel", role: "Designer", instructions: "Do design work." }),
      ctx(),
      runtime,
    );
    expect(outcome).toMatchObject({ kind: "result" });
    expect(outcome.content).toContain("Created @Pixel in Work");
  });

  it("requires name, role and instructions", async () => {
    const tools = createAgentTools(deps());
    const outcome = await tools.create_bot(call("create_bot", { name: "Pixel" }), ctx(), runtime);
    expect(outcome.kind).toBe("error");
    expect(JSON.parse(outcome.content).error).toMatch(/needs name, role/);
  });

  it("stops at MAX_CREATED_BOTS_PER_TURN within one createAgentTools call", async () => {
    let created = 0;
    const executeCreateBotRequest = vi.fn(async (): Promise<AgentRequestResult> => {
      created += 1;
      return { status: 201, body: { id: `bot-${created}`, name: `Bot${created}`, section: "Work" } };
    });
    const tools = createAgentTools(deps({ executeCreateBotRequest }));
    const args = { name: "N", role: "R", instructions: "I" };
    for (let i = 0; i < 4; i++) {
      const outcome = await tools.create_bot(call("create_bot", args), ctx(), runtime);
      expect(outcome.kind, `create #${i + 1}`).toBe("result");
    }
    const fifth = await tools.create_bot(call("create_bot", args), ctx(), runtime);
    expect(fifth.kind).toBe("error");
    expect(JSON.parse(fifth.content).error).toMatch(/at most 4 bots/);
    // The cap ran BEFORE the fifth network call, not after a rejection from it.
    expect(executeCreateBotRequest).toHaveBeenCalledTimes(4);
  });

  it("gives a fresh cap to a new createAgentTools call — a new turn's host", async () => {
    const executeCreateBotRequest = vi.fn(
      async (): Promise<AgentRequestResult> => ({ status: 201, body: { id: "bot-x", name: "X", section: "Work" } }),
    );
    const args = { name: "N", role: "R", instructions: "I" };
    const firstTurnTools = createAgentTools(deps({ executeCreateBotRequest }));
    for (let i = 0; i < 4; i++) {
      await firstTurnTools.create_bot(call("create_bot", args), ctx(), runtime);
    }
    expect((await firstTurnTools.create_bot(call("create_bot", args), ctx(), runtime)).kind).toBe("error");

    // A second `createAgentTools` call — what a second HTTP turn's host
    // does — must not remember the first turn's count.
    const secondTurnTools = createAgentTools(deps({ executeCreateBotRequest }));
    const outcome = await secondTurnTools.create_bot(call("create_bot", args), ctx(), runtime);
    expect(outcome.kind).toBe("result");
  });

  it("does not increment the cap on a failed create", async () => {
    const executeCreateBotRequest = vi.fn(
      async (): Promise<AgentRequestResult> => ({ status: 403, body: { error: "only a section's Chief of Staff can create operator bots" } }),
    );
    const tools = createAgentTools(deps({ executeCreateBotRequest }));
    const args = { name: "N", role: "R", instructions: "I" };
    for (let i = 0; i < 5; i++) {
      const outcome = await tools.create_bot(call("create_bot", args), ctx(), runtime);
      expect(outcome.kind).toBe("error");
      expect(JSON.parse(outcome.content).error).toMatch(/Chief of Staff/);
    }
    // Every one of the five reached the endpoint — none were cap-refused,
    // because none of them ever succeeded.
    expect(executeCreateBotRequest).toHaveBeenCalledTimes(5);
  });
});

describe("request_credential", () => {
  it("shows a secure card and suspends the turn", async () => {
    const tools = createAgentTools(deps());
    const outcome = await tools.request_credential(
      call("request_credential", { credential_id: "opencodeGoApiKey", reason: "needed" }),
      ctx(),
      runtime,
    );
    expect(outcome.kind).toBe("suspend");
    expect(outcome).toMatchObject({ stopReason: "awaiting_human" });
    expect(outcome.content).toContain("OpenCode API key");
    expect(outcome.content).toContain("End this turn");
  });

  it("continues the turn instead of suspending when already configured", async () => {
    const tools = createAgentTools(
      deps({
        executeRequestCredentialRequest: async () => ({
          status: 200,
          body: { alreadyConfigured: true, label: "OpenCode API key" },
        }),
      }),
    );
    const outcome = await tools.request_credential(
      call("request_credential", { credential_id: "opencodeGoApiKey" }),
      ctx(),
      runtime,
    );
    expect(outcome.kind).toBe("result");
    expect(outcome.content).toContain("already configured");
  });

  it("requires a credential_id", async () => {
    const tools = createAgentTools(deps());
    const outcome = await tools.request_credential(call("request_credential", {}), ctx(), runtime);
    expect(outcome.kind).toBe("error");
  });

  it("surfaces the endpoint's allowlist refusal", async () => {
    const tools = createAgentTools(
      deps({
        executeRequestCredentialRequest: async () => ({ status: 400, body: { error: "unsupported credential id" } }),
      }),
    );
    const outcome = await tools.request_credential(
      call("request_credential", { credential_id: "not-a-real-one" }),
      ctx(),
      runtime,
    );
    expect(outcome.kind).toBe("error");
    expect(JSON.parse(outcome.content).error).toBe("unsupported credential id");
  });
});

describe("propose_routine and propose_routine_action settle suspend", () => {
  it("normalises the schedule and suspends with a confirmation card", async () => {
    const executeRoutineRequestRequest = vi.fn(
      async (): Promise<AgentRequestResult> => ({ status: 201, body: { summary: "Weekdays at 09:00" } }),
    );
    const tools = createAgentTools(deps({ executeRoutineRequestRequest }));
    const outcome = await tools.propose_routine(
      call("propose_routine", {
        name: "Morning brief",
        instructions: "Summarize priorities.",
        schedule: { type: "daily", time: "09:00" },
      }),
      ctx(),
      runtime,
    );
    expect(outcome.kind).toBe("suspend");
    expect(outcome).toMatchObject({ stopReason: "awaiting_human" });
    expect(outcome.content).toContain("has not been applied");
    expect(executeRoutineRequestRequest).toHaveBeenCalledWith({
      fromBotId: "bot-self",
      fromThreadId: "thread-1",
      action: "create",
      routine: {
        name: "Morning brief",
        instructions: "Summarize priorities.",
        schedule: { type: "weekly", time: "09:00", weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] },
      },
    });
  });

  it("rejects an unsupported schedule before calling the endpoint", async () => {
    const executeRoutineRequestRequest = vi.fn();
    const tools = createAgentTools(deps({ executeRoutineRequestRequest }));
    const outcome = await tools.propose_routine(
      call("propose_routine", { name: "N", instructions: "I", schedule: { type: "hourly" } }),
      ctx(),
      runtime,
    );
    expect(outcome.kind).toBe("error");
    expect(JSON.parse(outcome.content).error).toMatch(/sub-day intervals/);
    expect(executeRoutineRequestRequest).not.toHaveBeenCalled();
  });

  it("propose_routine_action forwards the action and routine id", async () => {
    const executeRoutineRequestRequest = vi.fn(
      async (): Promise<AgentRequestResult> => ({ status: 201, body: {} }),
    );
    const tools = createAgentTools(deps({ executeRoutineRequestRequest }));
    const outcome = await tools.propose_routine_action(
      call("propose_routine_action", { routine_id: "routine-1", action: "pause" }),
      ctx(),
      runtime,
    );
    expect(outcome.kind).toBe("suspend");
    expect(executeRoutineRequestRequest).toHaveBeenCalledWith({
      fromBotId: "bot-self",
      fromThreadId: "thread-1",
      action: "pause",
      routineId: "routine-1",
    });
  });

  it("requires at least one field in changes for an update", async () => {
    const tools = createAgentTools(deps());
    const outcome = await tools.propose_routine_action(
      call("propose_routine_action", { routine_id: "routine-1", action: "update", changes: {} }),
      ctx(),
      runtime,
    );
    expect(outcome.kind).toBe("error");
  });

  it("surfaces the endpoint's refusal", async () => {
    const tools = createAgentTools(
      deps({
        executeRoutineRequestRequest: async () => ({
          status: 409,
          body: { error: "confirm or cancel an existing routine proposal first" },
        }),
      }),
    );
    const outcome = await tools.propose_routine(
      call("propose_routine", { name: "N", instructions: "I", schedule: { type: "once", at: "2026-09-01T09:00:00Z" } }),
      ctx(),
      runtime,
    );
    expect(outcome.kind).toBe("error");
    expect(JSON.parse(outcome.content).error).toMatch(/confirm or cancel/);
  });
});
