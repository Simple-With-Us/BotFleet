// The agents tools' one implementation.
//
// `createAgentTools(deps)` takes EVERY dependency explicitly.  That is not
// style: `server/tools/*` must never import `server/index.ts`, because
// `index.ts` imports the tool modules and the cycle that made was how the
// old `tool-executor.ts` ended up with its own private copy of the
// `list_bots` filter — one that offered a bot its own row and hid `busy`.
// With the dependencies injected there is nowhere for a second copy to
// live: the host and the `/api/internal/` endpoints call the same
// functions, and `registry.test.ts` asserts no file here reaches `index.ts`.
//
// Caller identity arrives in `AgentToolCallContext`, which only the turn
// tool host constructs.  The HTTP lane bypasses the loopback + COMMS_TOKEN
// hop the MCP lane uses, so a `fromBotId` in the model's arguments is
// ignored everywhere below — the turn's own identity is the only one that
// reaches an endpoint function.

import type { TurnToolCall, TurnToolOutcome, TurnToolRuntime } from "../contracts.ts";
import { sectionKey } from "../store.ts";
import { MAX_CREATED_BOTS_PER_TURN } from "./registry.ts";
import { routineFields } from "./schedule.ts";

/** The slice of a bot record the agents tools read.  Structural on purpose,
 *  so this module never has to know what a full bot is. */
export interface AgentBot {
  id: string;
  name: string;
  section?: string | null;
  hidden?: boolean;
  busy?: boolean;
  title?: string | null;
  description?: string | null;
  modelSelection: { model: string };
}

/** One row of the peer roster, as both lanes see it. */
export interface AgentPeerRow {
  id: string;
  name: string;
  model: string;
  busy: boolean;
  title?: string;
  description?: string;
}

/** What an `/api/internal/` endpoint body returns.  The same shape the HTTP
 *  response carries, so one function serves the endpoint and the host. */
export interface AgentRequestResult {
  status: number;
  body: Record<string, unknown>;
}

/** THE peer filter.  Same section, not hidden, and never the caller itself,
 *  with each peer's `busy` flag — the two facts that stop a model spending a
 *  round asking itself or a peer that cannot answer.  Returns `null` when
 *  the sender is unknown.
 *
 *  Every lane reaches this through `listAgentsResponse`; there is no second
 *  filter anywhere, which is the point of the PR that introduced it. */
export function selectPeerBots(selfId: string, all: readonly AgentBot[]): AgentPeerRow[] | null {
  const sender = all.find((bot) => bot.id === selfId);
  if (!sender) return null;
  return all
    .filter(
      (bot) =>
        bot.id !== selfId && !bot.hidden && sectionKey(bot.section) === sectionKey(sender.section),
    )
    .map((bot) => ({
      id: bot.id,
      name: bot.name,
      model: bot.modelSelection.model,
      busy: !!bot.busy,
      // title/description so a Chief-of-Staff-style bot can judge the team:
      // who does what, and who has no job description yet.
      title: bot.title || undefined,
      description: bot.description || undefined,
    }));
}

/** The `GET /api/internal/agents` body.  `index.ts` exports a one-line
 *  wrapper that binds this to the live store; the host receives that wrapper
 *  as a dependency, so both lanes run this code and not a copy of it. */
export function listAgentsResponse(selfId: string, all: readonly AgentBot[]): AgentRequestResult {
  const bots = selectPeerBots(selfId, all);
  if (!bots) return { status: 403, body: { error: "unknown sender" } };
  // `section` rides along because the pre-registry `list_bots` payload
  // carried it and in-flight conversations quote it back.  It is the
  // CALLER's own section — every row in `bots` is in it by construction —
  // so restoring it here, not in the tool, keeps the one-implementation
  // rule: the `/api/internal/agents` body and the host see the same field.
  const section = all.find((bot) => bot.id === selfId)?.section ?? "";
  return { status: 200, body: { section, bots } };
}

export interface AskBotRequestInput {
  fromBotId: string;
  toBotId: string;
  message: string;
  depth: number;
  fromThreadId?: string;
}

export interface ListRoutinesRequestInput {
  fromBotId: string;
  fromThreadId?: string;
  routineId?: string;
}

export interface DelegateBotRequestInput {
  fromBotId: string;
  toBotId: string;
  message: string;
  depth: number;
  fromThreadId?: string;
  reason?: string;
}

export interface CreateBotRequestInput {
  fromBotId: string;
  fromThreadId?: string;
  name: string;
  role: string;
  instructions: string;
}

export interface RequestCredentialRequestInput {
  fromBotId: string;
  fromThreadId?: string;
  credentialId: string;
  reason?: string;
}

/** One shape for both `propose_routine` (action `create`) and
 *  `propose_routine_action` (every other action) — the same envelope
 *  `POST /api/internal/routine-requests` has always accepted, so the two
 *  tools stay one body with two callers. */
export interface RoutineRequestInput {
  fromBotId: string;
  // Required, unlike the other endpoints here: `propose_routine` and
  // `propose_routine_action` have never defaulted this to the bot's own
  // thread — the source envelope schema in index.ts has always required it
  // outright, and this keeps that rule visible at the type.
  fromThreadId: string;
  action: "create" | "update" | "pause" | "resume" | "run_now" | "delete";
  routine?: Record<string, unknown>;
  routineId?: string;
  changes?: Record<string, unknown>;
}

/** Every dependency the agents tools have, named.  Each one is an
 *  `/api/internal/` endpoint body exported from `index.ts`, so the tool a
 *  MiniMax bot runs in-process and the tool a Claude bot runs over the
 *  loopback hop are the same function with the same guards. */
export interface AgentToolDeps {
  executeListAgentsRequest(input: { selfId: string }): AgentRequestResult | Promise<AgentRequestResult>;
  executeAskBotRequest(input: AskBotRequestInput): Promise<AgentRequestResult>;
  executeListRoutinesRequest(
    input: ListRoutinesRequestInput,
  ): AgentRequestResult | Promise<AgentRequestResult>;
  executeDelegateBotRequest(
    input: DelegateBotRequestInput,
  ): AgentRequestResult | Promise<AgentRequestResult>;
  executeCreateBotRequest(input: CreateBotRequestInput): AgentRequestResult | Promise<AgentRequestResult>;
  executeRequestCredentialRequest(
    input: RequestCredentialRequestInput,
  ): AgentRequestResult | Promise<AgentRequestResult>;
  executeRoutineRequestRequest(input: RoutineRequestInput): AgentRequestResult | Promise<AgentRequestResult>;
}

/** Who is calling.  Constructible only inside the turn tool host: this is
 *  the identity the endpoints trust, and it must never be assembled from a
 *  model's arguments. */
export interface AgentToolCallContext {
  readonly botId: string;
  readonly threadId: string;
  readonly commsDepth: number;
}

export type AgentToolExecutor = (
  call: TurnToolCall,
  ctx: AgentToolCallContext,
  runtime: TurnToolRuntime,
) => Promise<TurnToolOutcome>;

/** The names this module implements.  They are the registry's names, and
 *  `registry.test.ts` is what keeps the two lists in step. */
export type AgentToolName =
  | "list_bots"
  | "ask_bot"
  | "delegate_bot"
  | "create_bot"
  | "request_credential"
  | "list_routines"
  | "propose_routine"
  | "propose_routine_action";

/** One executor per name — a named contract rather than an open dictionary,
 *  so adding a tool to the registry without implementing it is a type error
 *  rather than an "unknown tool" string a user discovers at runtime. */
export type AgentTools = Record<AgentToolName, AgentToolExecutor>;

/** The peer roster as the tools read it: the caller's own section plus the
 *  rows in it.  One record so `list_bots` can re-emit `section` without a
 *  second trip to the endpoint. */
interface Roster {
  section: string;
  rows: AgentPeerRow[];
}

const ok = (content: string, detail?: string): TurnToolOutcome =>
  detail ? { kind: "result", content, detail } : { kind: "result", content };

const failed = (content: string, detail?: string): TurnToolOutcome =>
  detail ? { kind: "error", content, detail } : { kind: "error", content };

const errorText = (body: Record<string, unknown>, fallback: string): string =>
  typeof body.error === "string" && body.error ? body.error : fallback;

function jsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type RoutineAction = "update" | "pause" | "resume" | "run_now" | "delete";

function routineAction(value: unknown): RoutineAction | null {
  return value === "update" || value === "pause" || value === "resume" || value === "run_now" || value === "delete"
    ? value
    : null;
}

/** `propose_routine` and `propose_routine_action` both end the same way: the
 *  proposal endpoint made a card, the turn has to end here, and the model
 *  must not claim the change already happened.  One function so the two
 *  tools cannot say it differently. */
function routineSuspendOutcome(body: Record<string, unknown>, fallback: string): TurnToolOutcome {
  const summary = typeof body.summary === "string" && body.summary.trim() ? `\n\n${body.summary.trim()}` : "";
  return {
    kind: "suspend",
    content: `A confirmation card is now visible to the user for ${fallback}.${summary}\n\nThis change has not been applied yet. End this turn and wait for the user to confirm or deny the card; do not claim the routine was created or changed before confirmation.`,
    stopReason: "awaiting_human",
  };
}

/** Build the agents tools' executors.  Keyed by the registry name, so the
 *  host can look up exactly what the catalog advertised and nothing else. */
export function createAgentTools(deps: AgentToolDeps): AgentTools {
  // `create_bot`'s per-turn cap.  A closure variable, not module state: this
  // function runs once per `createTurnToolHost` call, which is once per HTTP
  // turn, so a fresh call gets a fresh counter — the turn-scoping the MCP
  // lane gets for free from being a fresh child process, and the HTTP lane
  // never had until now.  See `MAX_CREATED_BOTS_PER_TURN`'s own comment in
  // `registry.ts` for why the MCP lane keeps a separate counter instead of
  // sharing this one.
  let createdThisTurn = 0;

  async function roster(ctx: AgentToolCallContext): Promise<Roster | string> {
    const result = await deps.executeListAgentsRequest({ selfId: ctx.botId });
    if (result.status !== 200 || !Array.isArray(result.body.bots)) {
      return errorText(result.body, "the peer roster is unavailable");
    }
    // SAFETY: `executeListAgentsRequest` is `listAgentsResponse`, whose only
    // 200 body is `{ section, bots: AgentPeerRow[] }` built by
    // `selectPeerBots`.  The `Array.isArray` guard above rules out the 403
    // shape.
    return {
      section: typeof result.body.section === "string" ? result.body.section : "",
      rows: result.body.bots as AgentPeerRow[],
    };
  }

  return {
    async list_bots(_call, ctx): Promise<TurnToolOutcome> {
      const list = await roster(ctx);
      if (typeof list === "string") {
        return failed(JSON.stringify({ error: list }), list);
      }
      const { section, rows } = list;
      return ok(
        JSON.stringify({ section, bots: rows }),
        rows.length === 1 ? "1 peer" : `${rows.length} peers`,
      );
    },

    async ask_bot(call, ctx): Promise<TurnToolOutcome> {
      // Both spellings: the MCP lane advertises `message`, the HTTP lane
      // advertises `task` (see the declared wire deviation in registry.ts).
      // One body, two advertised names, so neither lane can drift.
      const target = String(call.arguments.bot_id ?? call.arguments.bot ?? "").trim();
      const text = String(call.arguments.message ?? call.arguments.task ?? "").trim();
      if (!target || !text) {
        return failed(
          JSON.stringify({ error: "ask_bot requires both `bot_id` and `task`" }),
          "bad arguments",
        );
      }
      const list = await roster(ctx);
      if (typeof list === "string") return failed(JSON.stringify({ error: list }), list);
      // Resolved against the roster the model was actually shown, so a bot
      // it cannot see is a bot it cannot reach.
      const peer = list.rows.find((row) => row.id === target || `@${row.name}` === target);
      if (!peer) return failed(JSON.stringify({ error: `no bot matches ${target}` }), "no such bot");
      // Every guard that matters — depth cap, section, thread ownership,
      // approvePeerComms, mirroring — lives in executeAskBotRequest, which
      // is why this calls it rather than reimplementing the hop.
      const result = await deps.executeAskBotRequest({
        fromBotId: ctx.botId,
        toBotId: peer.id,
        message: text,
        depth: ctx.commsDepth,
        fromThreadId: ctx.threadId,
      });
      if (result.body.busy) {
        return failed(
          JSON.stringify({ error: "That bot is busy right now — try again after it finishes." }),
          "peer busy",
        );
      }
      if (result.body.error) {
        const message = String(result.body.error);
        return failed(JSON.stringify({ error: message }), message);
      }
      const reply = typeof result.body.text === "string" ? result.body.text : "";
      const name = typeof result.body.botName === "string" ? result.body.botName : peer.name;
      if (!reply) return failed(JSON.stringify({ error: "no reply" }), "no reply");
      return ok(`${name} replied:\n${reply}`, `@${name} replied`);
    },

    async delegate_bot(call, ctx): Promise<TurnToolOutcome> {
      const target = String(call.arguments.bot_id ?? "").trim();
      const message = String(call.arguments.message ?? "").trim();
      const reason = typeof call.arguments.reason === "string" ? call.arguments.reason.trim() : "";
      if (!target || !message) {
        return failed(
          JSON.stringify({ error: "delegate_bot requires both `bot_id` and `message`" }),
          "bad arguments",
        );
      }
      // Async handoff: the harness queues it and returns immediately. Every
      // guard that matters — section, thread ownership, depth, the queue
      // cap — lives in executeDelegateBotRequest, same as ask_bot's hop.
      const result = await deps.executeDelegateBotRequest({
        fromBotId: ctx.botId,
        toBotId: target,
        message,
        depth: ctx.commsDepth,
        fromThreadId: ctx.threadId,
        ...(reason ? { reason } : {}),
      });
      if (result.body.error) {
        const errorMessage = String(result.body.error);
        return failed(JSON.stringify({ error: errorMessage }), errorMessage);
      }
      const text = typeof result.body.message === "string" ? result.body.message : "Delegation queued.";
      return ok(text);
    },

    async create_bot(call, ctx): Promise<TurnToolOutcome> {
      const name = String(call.arguments.name ?? "").trim();
      const role = String(call.arguments.role ?? "").trim();
      const instructions = String(call.arguments.instructions ?? "").trim();
      if (!name || !role || !instructions) {
        return failed(
          JSON.stringify({ error: "create_bot needs name, role, and instructions" }),
          "bad arguments",
        );
      }
      // The cap this closure owns — see its declaration above and
      // `MAX_CREATED_BOTS_PER_TURN`'s comment in registry.ts.  Checked
      // before the call, incremented only after it actually created a bot,
      // matching the pre-registry behaviour in agents-proxy.ts exactly.
      if (createdThisTurn >= MAX_CREATED_BOTS_PER_TURN) {
        const message = `You can create at most ${MAX_CREATED_BOTS_PER_TURN} bots in one turn. Use the team you have before adding more.`;
        return failed(JSON.stringify({ error: message }), "per-turn cap reached");
      }
      const result = await deps.executeCreateBotRequest({
        fromBotId: ctx.botId,
        fromThreadId: ctx.threadId,
        name,
        role,
        instructions,
      });
      if (result.status !== 201) {
        const message = errorText(result.body, "that bot could not be created");
        return failed(JSON.stringify({ error: message }), message);
      }
      createdThisTurn += 1;
      const createdName = typeof result.body.name === "string" ? result.body.name : name;
      const section = typeof result.body.section === "string" ? result.body.section : "General";
      return ok(`Created @${createdName} in ${section} [id: ${result.body.id}]. Assign work with delegate_bot.`);
    },

    async request_credential(call, ctx): Promise<TurnToolOutcome> {
      const credentialId = call.arguments.credential_id;
      if (typeof credentialId !== "string" || !credentialId) {
        return failed(
          JSON.stringify({ error: "request_credential needs a supported credential_id" }),
          "bad arguments",
        );
      }
      const reason =
        typeof call.arguments.reason === "string" ? call.arguments.reason.trim().slice(0, 240) : "";
      // The allowlist itself is enforced by executeRequestCredentialRequest
      // — the one place both lanes reach it — so this stays free of the
      // credential target list.
      const result = await deps.executeRequestCredentialRequest({
        fromBotId: ctx.botId,
        fromThreadId: ctx.threadId,
        credentialId,
        ...(reason ? { reason } : {}),
      });
      if (result.status >= 400) {
        const message = errorText(result.body, "that credential is not supported");
        return failed(JSON.stringify({ error: message }), message);
      }
      const label = typeof result.body.label === "string" ? result.body.label : "That credential";
      if (result.body.alreadyConfigured) {
        // Nothing to show, nothing to wait for — the loop keeps going.
        return ok(`${label} is already configured. Continue the task.`);
      }
      // The turn ends here: a card is now visible, and the existing secret
      // resume drain dispatches a fresh turn once the user saves or
      // declines — the CLI lane's "end this turn" contract, now enforced by
      // the loop rather than trusted from the model's own text.
      return {
        kind: "suspend",
        content: `A secure ${label} card is now visible to the user. End this turn; BotFleet will resume the task after they save or decline. Never ask them to paste the key into chat.`,
        stopReason: "awaiting_human",
      };
    },

    async list_routines(call, ctx): Promise<TurnToolOutcome> {
      const routineId = typeof call.arguments.routine_id === "string"
        ? call.arguments.routine_id.trim()
        : "";
      const result = await deps.executeListRoutinesRequest({
        fromBotId: ctx.botId,
        fromThreadId: ctx.threadId,
        ...(routineId ? { routineId } : {}),
      });
      if (result.status !== 200) {
        const message = errorText(result.body, "routines are unavailable");
        return failed(JSON.stringify({ error: message }), message);
      }
      const routines = Array.isArray(result.body.routines) ? result.body.routines : [];
      const routine = result.body.routine;
      // A budget-trimmed list must say so, or it reads as complete.
      const omitted = typeof result.body.routinesOmitted === "number" && result.body.routinesOmitted > 0
        ? result.body.routinesOmitted
        : 0;
      const listed = routines.length === 1 ? "1 routine" : `${routines.length} routines`;
      return ok(
        JSON.stringify({
          now: result.body.now,
          timeZone: result.body.timeZone,
          ...(routine ? { routine } : { routines, ...(omitted ? { routinesOmitted: omitted } : {}) }),
        }),
        routine ? "routine instructions" : omitted ? `${listed} (+${omitted} omitted)` : listed,
      );
    },

    async propose_routine(call, ctx): Promise<TurnToolOutcome> {
      const { fields: routine, error: scheduleError } = routineFields(call.arguments);
      if (scheduleError) return failed(JSON.stringify({ error: scheduleError }), scheduleError);
      if (!routine.name || !routine.instructions || !routine.schedule) {
        return failed(
          JSON.stringify({ error: "propose_routine needs name, instructions, and schedule" }),
          "bad arguments",
        );
      }
      const result = await deps.executeRoutineRequestRequest({
        fromBotId: ctx.botId,
        fromThreadId: ctx.threadId,
        action: "create",
        routine,
      });
      if (result.status >= 400) {
        const message = errorText(result.body, "that routine could not be prepared");
        return failed(JSON.stringify({ error: message }), message);
      }
      return routineSuspendOutcome(result.body, `the new routine "${String(routine.name)}"`);
    },

    async propose_routine_action(call, ctx): Promise<TurnToolOutcome> {
      const routineId = String(call.arguments.routine_id ?? "").trim();
      const action = routineAction(call.arguments.action);
      if (!routineId || !action) {
        return failed(
          JSON.stringify({ error: "propose_routine_action needs a routine_id and supported action" }),
          "bad arguments",
        );
      }
      let changes: Record<string, unknown> | undefined;
      if (action === "update") {
        if (!jsonRecord(call.arguments.changes)) {
          return failed(
            JSON.stringify({ error: "The update action needs at least one field in changes" }),
            "bad arguments",
          );
        }
        const { fields, error: scheduleError } = routineFields(call.arguments.changes);
        if (scheduleError) return failed(JSON.stringify({ error: scheduleError }), scheduleError);
        if (!Object.keys(fields).length) {
          return failed(
            JSON.stringify({ error: "The update action needs at least one supported field in changes" }),
            "bad arguments",
          );
        }
        changes = fields;
      } else if (call.arguments.changes !== undefined) {
        return failed(JSON.stringify({ error: `The ${action} action does not accept changes` }), "bad arguments");
      }
      const result = await deps.executeRoutineRequestRequest({
        fromBotId: ctx.botId,
        fromThreadId: ctx.threadId,
        action,
        routineId,
        ...(changes ? { changes } : {}),
      });
      if (result.status >= 400) {
        const message = errorText(result.body, "that change could not be prepared");
        return failed(JSON.stringify({ error: message }), message);
      }
      return routineSuspendOutcome(result.body, `${action.replace("_", " ")} on routine ${routineId}`);
    },
  };
}
