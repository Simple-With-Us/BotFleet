// The harness's one tool registry.
//
// Before this file a tool existed three times: once as an MCP `inputSchema`
// in `drivers/agents-proxy.ts`, once as a chat-completions `parameters`
// block in `turn-tools.ts`, and once as an endpoint body in `index.ts`.
// Nothing held the three together, so they drifted — `list_bots` offered a
// bot its own row on one lane and not the other, and hid `busy` on one lane
// and not the other, within a single PR.  A record here is the single
// description of a tool, and each lane RENDERS it rather than restating it.
//
// This module is deliberately dependency-free: it imports nothing from
// `server/index.ts` and nothing that reaches it.  `agents-proxy.ts` is
// spawned as a separate process inside a bot's agent, so anything it can
// see has to be importable without starting a harness.  `registry.test.ts`
// asserts the ban rather than trusting it.
//
// A record carries:
//   - `schema`      the ONE JSON Schema for the tool's arguments
//   - `surfaces`    which lanes may offer it (MCP, HTTP, or both)
//   - `gate`        a pure predicate over one turn's context
//   - `sideEffect`  "read" or "write" — what a permission broker needs
//   - `settles`     whether the tool returns inline or ends the turn on a card
//   - `promptFragment`  the sentence the system prompt may use for it, so
//                   prompt copy cannot outlive the tool (consumed in PR 5)
//   - `approval`    optional ask policy (consumed when the broker lands)

/** A JSON Schema object, in the subset both lanes accept.  No `oneOf` /
 *  `anyOf` / `allOf` / `const`: several agent CLIs flatten or drop
 *  composition keywords when converting an MCP tool into their provider's
 *  function-call format, and a model that never saw the branches guesses
 *  shapes forever. */
export interface JsonSchemaObject {
  type: "object";
  additionalProperties?: boolean;
  description?: string;
  properties?: Record<string, unknown>;
  required?: string[];
}

/** The two lanes a tool can be offered on.  "mcp" is a CLI engine reaching
 *  the harness through `agents-proxy` over the loopback + COMMS_TOKEN hop;
 *  "http" is a chat-completions driver whose loop calls the turn tool host
 *  in-process. */
export type ToolSurface = "mcp" | "http";

/** What running the tool does to the world.  A read tool can never need an
 *  approval card; a write tool is the reason the broker exists. */
export type ToolSideEffect = "read" | "write";

/** How the tool finishes.  "immediate" feeds a result back to the model and
 *  the loop continues; "suspend" put a card in front of a person, so the
 *  turn has to end and the existing resume drain dispatches a fresh one. */
export type ToolSettles = "immediate" | "suspend";

/** Everything the gate predicates are allowed to see.  Pure data, so a gate
 *  can be evaluated in a test without a harness. */
export interface ToolGateContext {
  /** The bot's peer-comms integration is mounted for this turn. */
  agents: boolean;
  /** How many peer hops deep this turn already is. */
  commsDepth: number;
  /** The harness's recursion ceiling (`MAX_COMMS_DEPTH`). */
  maxCommsDepth: number;
  /** This bot is its section's Chief of Staff. */
  chiefOfStaff: boolean;
  /** The bot has access to host computer tools (bash, files) for this turn. */
  localComputer?: boolean;
  /** The bot is working in an assigned workspace directory. */
  workspace?: boolean;
  /** Fleet recall (Bot RAG) is configured: a Service URL or the local
   *  `recall` CLI is reachable.  Independent of `agents` — recall is host
   *  logic, not a peer-comms permission. */
  recall?: boolean;
  /** A first-party physical Android phone (USB) is mounted for this turn. */
  phone?: boolean;
  /** The bot may use the github_* tools this turn.  A distinct field from
   *  `localComputer` on purpose — every caller sets it equal to
   *  `localComputer` today (see registry.ts's own `githubEnabled` note),
   *  but that is a value a caller chooses, not a constraint this type
   *  enforces, so a future grant that separates "run shell commands" from
   *  "act on a git repo" only has to change what callers pass in, not this
   *  interface or the registry records. */
  github?: boolean;
}

/** How a tool asks a person before it runs.  Consumed by the permission
 *  broker; recorded here so the policy lives beside the tool rather than in
 *  a switch somewhere downstream. */
export interface ToolApproval {
  policy: "never" | "ask";
  /** One line for the card, built from the model's arguments. */
  summary(args: Record<string, unknown>): string;
}

/** A wire shape one lane is pinned to and the other is not.
 *
 *  Every deviation is a debt, so it has to be declared here with a reason
 *  rather than appearing as two hand-written definitions.  `registry.test.ts`
 *  asserts that a lane's rendered schema is the canonical one unless the
 *  record declares a deviation, which is what makes silent drift impossible. */
export interface ToolWireDeviation {
  /** Why the lanes cannot share one shape yet.  Required. */
  reason: string;
  description?: string;
  schema?: JsonSchemaObject;
}

export interface HarnessTool {
  name: string;
  /** The canonical description.  A lane renders this unless it declares a
   *  deviation. */
  description: string;
  /** The canonical argument schema.  Same rule. */
  schema: JsonSchemaObject;
  surfaces: Record<ToolSurface, boolean>;
  gate(ctx: ToolGateContext): boolean;
  sideEffect: ToolSideEffect;
  settles: ToolSettles;
  /** The sentence the system prompt may use to introduce this tool.  It is a
   *  FIELD ON THE TOOL so prompt copy cannot outlive the tool it describes. */
  promptFragment?: string;
  approval?: ToolApproval;
  wire?: Partial<Record<ToolSurface, ToolWireDeviation>>;
}

/** What `agents-proxy` publishes on `tools/list`. */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
}

/** What an HTTP driver puts in `SendTurnInput.tools`; the drivers translate
 *  it into OpenAI function-calling format at call time. */
export interface HttpToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}

const peerComms = (ctx: ToolGateContext) => ctx.agents && ctx.commsDepth < ctx.maxCommsDepth;

const LIST_BOTS: HarnessTool = {
  name: "list_bots",
  // Pinned by the MCP golden test: this is the string shipped CLI engines
  // already see.  The HTTP lane used to say something different and less
  // true (it did not mention `busy`, which it now reports).
  description:
    "List the other bots (agents) in your BotFleet section you can message, with their model and whether they're busy. Call this before ask_bot to discover who's available.",
  schema: { type: "object", properties: {} },
  surfaces: { mcp: true, http: true },
  gate: peerComms,
  sideEffect: "read",
  settles: "immediate",
  promptFragment:
    "Use list_bots to see the other bots in your section, with their model and whether they are busy.",
};

const ASK_BOT: HarnessTool = {
  name: "ask_bot",
  description:
    "Send a message to another bot in your section and wait for its reply. Use it to delegate a subtask to a specialist bot or ask a peer a question. The other bot runs a full turn under its own model and permissions; the reply is returned to you as text. Returns promptly with a note if that bot is busy.",
  schema: {
    type: "object",
    properties: {
      bot_id: { type: "string", description: "The target bot's id (from list_bots)." },
      message: { type: "string", description: "What to say / ask the bot." },
    },
    required: ["bot_id", "message"],
  },
  surfaces: { mcp: true, http: true },
  gate: peerComms,
  sideEffect: "write",
  settles: "immediate",
  promptFragment:
    "Use ask_bot to send a peer a task and wait for its reply; pass the bot's id or @name from list_bots.",
  // Starting a peer's turn spends that bot's tokens under its own model and
  // permissions, so it is the one registry tool a person may want to see
  // first.  The verdict itself is NOT decided here: the ask goes through
  // the same fold a CLI engine's does, so this bot's existing auto-approve,
  // always-allow and unattended settings decide it — no per-tool switch.
  approval: {
    policy: "ask",
    summary: (args) => {
      const target = typeof args.bot_id === "string" ? args.bot_id : "another bot";
      const raw = typeof args.task === "string" ? args.task : typeof args.message === "string" ? args.message : "";
      const text = raw.replace(/\s+/g, " ").trim();
      return text ? `ask ${target}: ${text.slice(0, 160)}` : `ask ${target}`;
    },
  },
  wire: {
    http: {
      reason:
        "The HTTP lane shipped this argument as `task`, and renaming it on the wire would break in-flight MiniMax and OpenRouter turns whose transcripts already contain the old spelling.  The executor accepts both names, so the two lanes run one body; only the advertised name differs.",
      description:
        "Send a message to another bot in your section and wait for its reply.  The other bot runs a full turn under its own model and permissions; the reply is returned to you as text.  Pass either the bot's id or `@name` from list_bots.",
      schema: {
        type: "object",
        properties: {
          bot_id: { type: "string", description: "The target bot's id (from list_bots) or `@name`." },
          task: { type: "string", description: "What to say / ask the bot." },
        },
        required: ["bot_id", "task"],
      },
    },
  },
};

/** Only a chief may build a team, and it is still a peer-comms-shaped
 *  permission — a bot whose depth or driver never mounted the agents
 *  integration must not see it either.  Not the peer-hop ceiling, though:
 *  building a team is not a hop, so `commsDepth` plays no part, the same
 *  reasoning `list_routines` uses for the recursion cap. */
const chiefOnly = (ctx: ToolGateContext) => ctx.agents && ctx.chiefOfStaff;

/** Not a peer hop either, and not chief-gated: any bot with the agents
 *  integration mounted may ask for a credential or manage its own
 *  routines. */
const anyAgentsBot = (ctx: ToolGateContext) => ctx.agents;

const DELEGATE_BOT: HarnessTool = {
  name: "delegate_bot",
  description:
    "Hand a task to another bot ASYNCHRONOUSLY: returns immediately and the peer runs after your current turn finishes. Use this when you want to keep working or hand off a long-running subtask without waiting. The user sees the peer's reply as its own turn; you do NOT receive the reply inline.",
  schema: {
    type: "object",
    properties: {
      bot_id: { type: "string", description: "The target bot's id (from list_bots)." },
      message: { type: "string", description: "What the peer should do / answer." },
      reason: {
        type: "string",
        description: "Optional one-line reason for the delegation (shown to the user as a chip).",
      },
    },
    required: ["bot_id", "message"],
  },
  surfaces: { mcp: true, http: true },
  gate: peerComms,
  sideEffect: "write",
  settles: "immediate",
  promptFragment:
    "Use delegate_bot to hand a task to a peer asynchronously when you do not need its reply inline; the user sees the peer's reply as its own turn.",
  // Starting a peer's turn spends its tokens, same as ask_bot — and unlike
  // ask_bot, this one runs after the current turn ends, so a denied
  // delegation must never have been queued in the first place.
  approval: {
    policy: "ask",
    summary: (args) => {
      const target = typeof args.bot_id === "string" ? args.bot_id : "another bot";
      const raw = typeof args.message === "string" ? args.message : "";
      const text = raw.replace(/\s+/g, " ").trim();
      return text ? `delegate to ${target}: ${text.slice(0, 120)}` : `delegate to ${target}`;
    },
  },
};

const CREATE_BOT: HarnessTool = {
  name: "create_bot",
  description:
    "Create a specialist bot in your section. Only a section's Chief of Staff may use this. The new bot inherits the Chief's engine, starts with connected apps and automatic approvals disabled, and can then receive work through delegate_bot. Create only the smallest useful team (maximum four per turn).",
  schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Short, unique display name for the specialist." },
      role: { type: "string", description: "The specialist's job title or role." },
      instructions: {
        type: "string",
        description: "What this specialist is responsible for and how it should work.",
      },
    },
    required: ["name", "role", "instructions"],
  },
  surfaces: { mcp: true, http: true },
  gate: chiefOnly,
  sideEffect: "write",
  settles: "immediate",
  promptFragment:
    "If you are the Chief of Staff, use create_bot to add a specialist to your team (up to four per turn), then delegate_bot to assign it work.",
};

/** Mirrors `CREDENTIAL_TARGETS` in `shared/credential-request.ts`.
 *  Duplicated rather than imported: this file has to stay import-free
 *  (`registry.test.ts` asserts it, because `agents-proxy.ts` loads it inside
 *  a bare child process before the harness exists), so the one place that
 *  needs the real allowlist as DATA cannot reach it.  `registry.test.ts`
 *  also diffs this list against the real one so the two id sets cannot
 *  drift silently. */
export const CREDENTIAL_TARGET_IDS = [
  "xaiApiKey",
  "deepseekApiKey",
  "boxToken",
  "opencodeGoApiKey",
  "ttsKey",
  "openaiImageApiKey",
] as const;

const REQUEST_CREDENTIAL: HarnessTool = {
  name: "request_credential",
  description:
    "Ask the user for a supported API key through BotFleet's secure credential card. Use this instead of asking them to paste a secret into chat. The secret is saved by the desktop app and is never returned to you. After calling this tool, end the turn; BotFleet resumes the task after the user saves or declines.",
  schema: {
    type: "object",
    properties: {
      credential_id: {
        type: "string",
        enum: [...CREDENTIAL_TARGET_IDS],
        description: "The credential the current task requires.",
      },
      reason: {
        type: "string",
        description: "Optional short, non-sensitive explanation of why the task needs it.",
      },
    },
    required: ["credential_id"],
  },
  surfaces: { mcp: true, http: true },
  gate: anyAgentsBot,
  sideEffect: "write",
  settles: "suspend",
  promptFragment:
    "If a supported API key is missing, use request_credential to show the secure in-app card. Never ask the user to paste credentials into chat.",
};

const WEEKDAYS_ENUM = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

// One flat object, deliberately free of oneOf/const/format: several agent
// CLIs flatten or drop JSON-Schema composition keywords when converting MCP
// tools into their provider's function-call format, and a model that never
// saw the branches guesses shapes forever.  The per-type rules live in
// descriptions and are enforced with guiding errors by
// `schedule.ts#normalizeScheduleInput`, which this schema describes but
// (being import-free) cannot reference directly.
const ROUTINE_SCHEDULE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  description:
    'Either {"type":"once","at":RFC3339} for one future run, {"type":"weekly","time":"HH:MM","weekdays":[...]} for chosen days, or {"type":"daily","time":"HH:MM"} to run every day. Sub-day intervals (every N minutes/hours) are not supported.',
  properties: {
    type: {
      type: "string",
      enum: ["once", "weekly", "daily"],
      description: "once = a single future run; weekly = chosen weekdays; daily = every day of the week.",
    },
    at: {
      type: "string",
      description:
        "Only for type once: future RFC3339 date-time with an explicit timezone offset, for example 2026-09-01T09:00:00+05:30 or 2026-09-01T03:30:00Z.",
    },
    time: {
      type: "string",
      description:
        "For type weekly or daily: 24-hour HH:MM, interpreted in schedule.timeZone when supplied and otherwise in the computer timezone, for example 09:00.",
    },
    timeZone: {
      type: "string",
      description:
        "Optional IANA timezone for a weekly or daily schedule, for example America/Chicago.  When supplied, it overrides the zone used to interpret both time and weekdays.  On create, omit it to use the computer timezone returned by list_routines.  On update, omit it to preserve the routine's existing timezone; send a different IANA timezone to change it.",
    },
    weekdays: {
      type: "array",
      items: { type: "string", enum: WEEKDAYS_ENUM },
      description:
        "Only for type weekly: which days the routine runs, interpreted in schedule.timeZone when supplied and otherwise in the computer timezone.",
    },
  },
  required: ["type"],
} as const;

const ROUTINE_FIELDS_SCHEMA = {
  name: { type: "string", minLength: 1, maxLength: 80, description: "Short name shown in Routines." },
  instructions: {
    type: "string",
    minLength: 1,
    maxLength: 20_000,
    description: "The complete instructions the bot should follow each time the routine runs.",
  },
  schedule: ROUTINE_SCHEDULE_SCHEMA,
  run_on: {
    type: "string",
    enum: ["maus", "cloud"],
    description: "Where the routine runs. Defaults to maus (this BotFleet setup).",
  },
  duration_minutes: {
    type: "integer",
    minimum: 15,
    maximum: 240,
    description: "Maximum run duration in minutes. Defaults to 30.",
  },
} as const;

const PROPOSE_ROUTINE: HarnessTool = {
  name: "propose_routine",
  description:
    "Prepare a new routine after the user explicitly asks to schedule recurring or future work. Call list_routines first for relative dates or times so you use its authoritative current time and timezone. This only creates a durable confirmation card; it does NOT enable the routine. Resolve ambiguous dates, times, timezone, destination, or instructions with the user first, and always give one-time schedules an explicit RFC3339 offset. After calling it, end the turn and do not claim the routine exists until the user confirms the card.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: ROUTINE_FIELDS_SCHEMA,
    required: ["name", "instructions", "schedule"],
  },
  surfaces: { mcp: true, http: true },
  gate: anyAgentsBot,
  sideEffect: "write",
  settles: "suspend",
  promptFragment:
    "If the user explicitly asks to schedule, run, or change routines, use list_routines and propose_routine or propose_routine_action. A proposal is not applied until the user confirms its in-app card, so never claim the action completed before that confirmation.",
};

const PROPOSE_ROUTINE_ACTION: HarnessTool = {
  name: "propose_routine_action",
  description:
    "Prepare a user-requested change to one of this bot's existing routines. This only creates a durable confirmation card; it does NOT apply the change. Use list_routines first to get the routine id. After calling it, end the turn and do not claim the action completed until the user confirms the card.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      routine_id: { type: "string", minLength: 1, description: "Routine id from list_routines." },
      action: {
        type: "string",
        enum: ["update", "pause", "resume", "run_now", "delete"],
        description: "The requested action. Supply changes only for update.",
      },
      changes: {
        type: "object",
        additionalProperties: false,
        properties: ROUTINE_FIELDS_SCHEMA,
        description: "Fields to change when action is update. Omit for every other action.",
      },
    },
    required: ["routine_id", "action"],
  },
  surfaces: { mcp: true, http: true },
  gate: anyAgentsBot,
  sideEffect: "write",
  settles: "suspend",
  promptFragment:
    "Use propose_routine_action (after list_routines) to pause, resume, run now, update, or delete an existing routine. It only shows a confirmation card; the change applies when the user confirms it.",
};

const LIST_ROUTINES: HarnessTool = {
  name: "list_routines",
  description:
    "List routines owned by this bot with ids, schedules, status, next run, and short instruction previews.  The result includes the computer's authoritative current time and timezone; use those when interpreting relative dates.  To retrieve full instructions for one routine, call list_routines with its routine_id from the list.  Only call this when the user asks about routines or wants to change one.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      routine_id: {
        type: "string",
        minLength: 1,
        description: "Optional routine id from the list; returns full instructions for only that routine.",
      },
    },
  },
  surfaces: { mcp: true, http: true },
  // Not a peer hop, so the recursion ceiling does not apply: a bot four
  // hops deep can still be asked what it has scheduled.  It rides the
  // agents integration because that is the surface the tools are mounted on.
  gate: anyAgentsBot,
  sideEffect: "read",
  settles: "immediate",
  promptFragment:
    "Use list_routines to read this bot's scheduled work, and treat the current time it returns as authoritative for relative dates.  The list contains short instruction previews; pass a routine_id from the list to retrieve that routine's full instructions.",
};

/** The `create_bot` per-turn cap, shared so the two lanes cannot drift on
 *  the number even though they enforce it in two different places:
 *  `agents-proxy.ts` keeps its own per-process counter (it is a bare child
 *  process — it cannot share a JS closure with the harness), and
 *  `agents.ts#createAgentTools` closes over a fresh counter every time it is
 *  built, which is once per HTTP turn.  That is what makes the HTTP lane's
 *  cap turn-scoped rather than process-scoped: a new turn gets a new host,
 *  gets a new call to `createAgentTools`, gets a new counter. */
export const MAX_CREATED_BOTS_PER_TURN = 4;

const hostComputer = (ctx: ToolGateContext) => Boolean(ctx.localComputer);
const workspaceOrHostComputer = (ctx: ToolGateContext) => Boolean(ctx.localComputer || ctx.workspace);
const recallEnabled = (ctx: ToolGateContext) => Boolean(ctx.recall);
const phoneEnabled = (ctx: ToolGateContext) => Boolean(ctx.phone);
// github rides the SAME "This Computer" grant bash already requires: the
// tool is a narrower, auditable alternative to running `gh`/`git` through
// `bash` (argv-only exec, a fixed action per record, real-path confinement
// to the bot's workspace), not a capability beyond what that grant already
// implies — a bot with `bash` can already reach `gh`/`git` unscoped.  Its
// own `ToolGateContext.github` field, not a bare alias of `hostComputer`,
// so a future caller can grant one without the other by changing what it
// passes in, without touching this predicate or these records.
const githubEnabled = (ctx: ToolGateContext) => Boolean(ctx.github);

const BASH: HarnessTool = {
  name: "bash",
  description:
    "Execute a shell command on the host computer. Use this for running tests, git operations, builds, or inspecting workspace files and system state. Do not run interactive commands or background daemons.",
  schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute.",
      },
    },
    required: ["command"],
  },
  surfaces: { mcp: false, http: true },
  gate: hostComputer,
  sideEffect: "write",
  settles: "immediate",
  promptFragment:
    "Use bash to run shell commands, git operations, tests, and builds on this computer.",
  approval: {
    policy: "ask",
    summary: (args) => {
      const raw = typeof args.command === "string" ? args.command : "";
      const text = raw.replace(/\s+/g, " ").trim();
      return text ? `bash: ${text.slice(0, 160)}` : "bash";
    },
  },
};

const READ_FILE: HarnessTool = {
  name: "read_file",
  description:
    "Read the text content of a file on the host computer. Optionally specify offset (1-based line number) and limit (number of lines to read) for large files.",
  schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to read (absolute or relative to current working directory).",
      },
      offset: {
        type: "integer",
        minimum: 1,
        description: "Optional 1-based line number to start reading from.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        description: "Optional maximum number of lines to read.",
      },
    },
    required: ["path"],
  },
  surfaces: { mcp: false, http: true },
  gate: workspaceOrHostComputer,
  sideEffect: "read",
  settles: "immediate",
  promptFragment: "Use read_file to inspect files in the workspace.",
};

const WRITE_FILE: HarnessTool = {
  name: "write_file",
  description:
    "Write full text content to a file on the host computer, creating any missing parent directories.",
  schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to write (absolute or relative to current working directory).",
      },
      content: {
        type: "string",
        description: "The complete text content to write to the file.",
      },
    },
    required: ["path", "content"],
  },
  surfaces: { mcp: false, http: true },
  gate: workspaceOrHostComputer,
  sideEffect: "write",
  settles: "immediate",
  promptFragment: "Use write_file to create or overwrite a file in the workspace.",
  approval: {
    policy: "ask",
    summary: (args) => {
      const p = typeof args.path === "string" ? args.path : "file";
      return `write file ${p}`;
    },
  },
};

const EDIT_FILE: HarnessTool = {
  name: "edit_file",
  description:
    "Replace a target block of text in an existing file on the host computer. The old_string must appear exactly once in the file.",
  schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to edit (absolute or relative to current working directory).",
      },
      old_string: {
        type: "string",
        description: "The exact text block in the file to replace.",
      },
      new_string: {
        type: "string",
        description: "The new text to replace old_string with.",
      },
    },
    required: ["path", "old_string", "new_string"],
  },
  surfaces: { mcp: false, http: true },
  gate: workspaceOrHostComputer,
  sideEffect: "write",
  settles: "immediate",
  promptFragment:
    "Use edit_file to modify an existing file by replacing a unique snippet of text.",
  approval: {
    policy: "ask",
    summary: (args) => {
      const p = typeof args.path === "string" ? args.path : "file";
      return `edit file ${p}`;
    },
  },
};

const RECALL_SEARCH: HarnessTool = {
  name: "recall_search",
  description:
    "Search the configured shared knowledge corpus (lessons, preferences, infrastructure facts, decisions, runbooks, and notes). Hybrid dense + keyword search with cross-encoder reranking.",
  schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural-language question, topic, or search keywords" },
      limit: { type: "number", description: "Maximum number of relevant results to return (default: 5, max: 20)" },
      category: {
        type: "string",
        enum: ["lesson", "preference", "infrastructure", "decision", "runbook", "note", "finding", "doc"],
        description: "Restrict results to one category",
      },
      app: { type: "string", description: "Filter by lowercase app slug (e.g. botfleet, docs, research)" },
      source: {
        type: "string",
        enum: ["board", "effort-log", "apple-note", "doc", "skill", "memory", "agent-contribution"],
        description: "Filter by document source",
      },
      seat: { type: "string", description: "Filter by author seat tag (the bot or agent that wrote it)" },
      since_days: { type: "number", description: "Only return content created in the last N days" },
      per_doc: { type: "number", description: "Best N chunks to return per document (default: 1)" },
    },
    required: ["query"],
  },
  surfaces: { mcp: false, http: true },
  gate: recallEnabled,
  sideEffect: "read",
  settles: "immediate",
  promptFragment:
    "Use recall_search to check the shared knowledge corpus (lessons, preferences, infrastructure facts, decisions, runbooks) before re-deriving something another bot or seat may already have solved.",
};

const RECALL_CONTRIBUTE: HarnessTool = {
  name: "recall_contribute",
  description:
    "Store a reusable piece of knowledge, lesson learned, preference, infrastructure fact, or runbook into the configured shared memory corpus so other bots and seats can retrieve it.",
  schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The content or lesson to contribute (40 to 4000 characters)" },
      category: {
        type: "string",
        enum: ["lesson", "preference", "infrastructure", "decision", "runbook"],
        description: "The knowledge category",
      },
      app: { type: "string", description: "Target app slug (default: botfleet)" },
      seat: { type: "string", description: "Author seat or bot identifier (defaults to this bot's name)" },
      title: { type: "string", description: "Optional title or concise summary" },
      url: { type: "string", description: "Optional source link (PR, board item, commit, or doc URL)" },
      force: { type: "boolean", description: "Store even if a near-duplicate contribution already exists" },
    },
    required: ["text", "category"],
  },
  surfaces: { mcp: false, http: true },
  gate: recallEnabled,
  sideEffect: "write",
  settles: "immediate",
  promptFragment: "Use recall_contribute to save a reusable lesson to the shared corpus after you learn something worth keeping.",
  approval: {
    policy: "ask",
    summary: (args) => {
      const text = typeof args.text === "string" ? args.text.replace(/\s+/g, " ").trim() : "";
      return text ? `recall_contribute: ${text.slice(0, 120)}` : "recall_contribute";
    },
  },
};

const RECALL_STATS: HarnessTool = {
  name: "recall_stats",
  description: "Check the health, status, and point counts of the configured shared memory corpus.",
  schema: { type: "object", properties: {} },
  surfaces: { mcp: false, http: true },
  gate: recallEnabled,
  sideEffect: "read",
  settles: "immediate",
  promptFragment: "Use recall_stats to check whether the shared knowledge corpus is configured and healthy.",
};

const PHONE_STATUS: HarnessTool = {
  name: "phone_status",
  description: "Check physical USB Android devices and USB-debugging authorization before any Android phone task.",
  schema: { type: "object", properties: {} },
  surfaces: { mcp: false, http: true },
  gate: phoneEnabled,
  sideEffect: "read",
  settles: "immediate",
};

const PHONE_READ_SCREEN: HarnessTool = {
  name: "phone_read_screen",
  description:
    "Read visible text, accessibility labels, resource ids, and pixel bounds from the connected Android screen. Use after every action to verify the result.",
  schema: { type: "object", properties: { serial: { type: "string" } } },
  surfaces: { mcp: false, http: true },
  gate: phoneEnabled,
  sideEffect: "read",
  settles: "immediate",
};

const PHONE_LIST_APPS: HarnessTool = {
  name: "phone_list_apps",
  description:
    "List installed launchable Android package names, optionally filtered by a human app name. Prefer phone_open_app first.",
  schema: { type: "object", properties: { query: { type: "string" }, serial: { type: "string" } } },
  surfaces: { mcp: false, http: true },
  gate: phoneEnabled,
  sideEffect: "read",
  settles: "immediate",
};

const PHONE_OPEN_APP: HarnessTool = {
  name: "phone_open_app",
  description: "Open an installed Android app directly by its human name, such as Uber or Skyscanner. Do not scan the app drawer first.",
  schema: {
    type: "object",
    properties: { name: { type: "string" }, serial: { type: "string" } },
    required: ["name"],
  },
  surfaces: { mcp: false, http: true },
  gate: phoneEnabled,
  sideEffect: "write",
  settles: "immediate",
  approval: { policy: "ask", summary: (args) => `phone: open ${typeof args.name === "string" ? args.name : "app"}` },
};

const PHONE_TAP_TEXT: HarnessTool = {
  name: "phone_tap_text",
  description: "Tap visible Android text or an accessibility label, then use phone_read_screen to verify.",
  schema: {
    type: "object",
    properties: {
      text: { type: "string" },
      exact: { type: "boolean" },
      index: { type: "integer", minimum: 0 },
      serial: { type: "string" },
    },
    required: ["text"],
  },
  surfaces: { mcp: false, http: true },
  gate: phoneEnabled,
  sideEffect: "write",
  settles: "immediate",
  approval: { policy: "ask", summary: (args) => `phone: tap "${typeof args.text === "string" ? args.text : ""}"` },
};

const PHONE_TAP: HarnessTool = {
  name: "phone_tap",
  description: "Tap Android screen pixel coordinates obtained from phone_read_screen.",
  schema: {
    type: "object",
    properties: { x: { type: "number" }, y: { type: "number" }, serial: { type: "string" } },
    required: ["x", "y"],
  },
  surfaces: { mcp: false, http: true },
  gate: phoneEnabled,
  sideEffect: "write",
  settles: "immediate",
  approval: { policy: "ask", summary: (args) => `phone: tap ${args.x ?? "?"},${args.y ?? "?"}` },
};

const PHONE_SWIPE: HarnessTool = {
  name: "phone_swipe",
  description: "Swipe the Android screen in a direction, then use phone_read_screen to verify.",
  schema: {
    type: "object",
    properties: { direction: { type: "string", enum: ["up", "down", "left", "right"] }, serial: { type: "string" } },
    required: ["direction"],
  },
  surfaces: { mcp: false, http: true },
  gate: phoneEnabled,
  sideEffect: "write",
  settles: "immediate",
  approval: { policy: "ask", summary: (args) => `phone: swipe ${typeof args.direction === "string" ? args.direction : ""}` },
};

const PHONE_TYPE_TEXT: HarnessTool = {
  name: "phone_type_text",
  description: "Type basic ASCII text into the focused Android field. Never enter passwords, payment details, or one-time codes.",
  schema: {
    type: "object",
    properties: { text: { type: "string", maxLength: 256 }, serial: { type: "string" } },
    required: ["text"],
  },
  surfaces: { mcp: false, http: true },
  gate: phoneEnabled,
  sideEffect: "write",
  settles: "immediate",
  approval: { policy: "ask", summary: () => "phone: type text" },
};

const PHONE_PRESS: HarnessTool = {
  name: "phone_press",
  description: "Press an Android navigation or keyboard key.",
  schema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        enum: ["back", "delete", "down", "enter", "escape", "home", "left", "recent", "return", "right", "space", "tab", "up"],
      },
      serial: { type: "string" },
    },
    required: ["key"],
  },
  surfaces: { mcp: false, http: true },
  gate: phoneEnabled,
  sideEffect: "write",
  settles: "immediate",
  approval: { policy: "ask", summary: (args) => `phone: press ${typeof args.key === "string" ? args.key : ""}` },
};

const GITHUB_CLONE: HarnessTool = {
  name: "github_clone",
  description: "Clone a GitHub repository into this bot's own workspace directory, so its file and git tools can act on it.",
  schema: {
    type: "object",
    properties: {
      repo: { type: "string", description: '"owner/repo" or a https://github.com/owner/repo(.git) URL' },
      dir: { type: "string", description: "Folder name inside this bot's workspace (default: derived from repo)." },
    },
    required: ["repo"],
  },
  surfaces: { mcp: false, http: true },
  gate: githubEnabled,
  sideEffect: "write",
  settles: "immediate",
  approval: { policy: "ask", summary: (args) => `github: clone ${typeof args.repo === "string" ? args.repo : ""}` },
};

const GITHUB_STATUS: HarnessTool = {
  name: "github_status",
  description: "Show the GitHub repo's default branch plus this clone's git status for a repo already cloned with github_clone.",
  schema: {
    type: "object",
    properties: { dir: { type: "string", description: "The folder name passed to github_clone." } },
    required: ["dir"],
  },
  surfaces: { mcp: false, http: true },
  gate: githubEnabled,
  sideEffect: "read",
  settles: "immediate",
};

const GITHUB_COMMIT: HarnessTool = {
  name: "github_commit",
  description: "Stage and commit changes in a repo already cloned with github_clone.",
  schema: {
    type: "object",
    properties: {
      dir: { type: "string", description: "The folder name passed to github_clone." },
      message: { type: "string", description: "The commit message." },
      files: { type: "array", items: { type: "string" }, description: "Paths (relative to the repo) to stage. Omit to stage all changes." },
    },
    required: ["dir", "message"],
  },
  surfaces: { mcp: false, http: true },
  gate: githubEnabled,
  sideEffect: "write",
  settles: "immediate",
  approval: { policy: "ask", summary: (args) => `github: commit "${typeof args.message === "string" ? args.message.slice(0, 100) : ""}"` },
};

const GITHUB_PUSH: HarnessTool = {
  name: "github_push",
  description: "Push commits from a repo already cloned with github_clone.",
  schema: {
    type: "object",
    properties: {
      dir: { type: "string", description: "The folder name passed to github_clone." },
      branch: { type: "string", description: "Branch to push and set upstream for. Omit to push the current branch's existing upstream." },
    },
    required: ["dir"],
  },
  surfaces: { mcp: false, http: true },
  gate: githubEnabled,
  sideEffect: "write",
  settles: "immediate",
  approval: { policy: "ask", summary: (args) => `github: push ${typeof args.branch === "string" ? args.branch : "(current branch)"}` },
};

const GITHUB_PR_CREATE: HarnessTool = {
  name: "github_pr_create",
  description: "Open a pull request from the current branch of a repo already cloned with github_clone.",
  schema: {
    type: "object",
    properties: {
      dir: { type: "string", description: "The folder name passed to github_clone." },
      title: { type: "string" },
      body: { type: "string" },
      base: { type: "string", description: "Base branch (defaults to the repo's default branch)." },
      branch: { type: "string", description: "Head branch (defaults to the current branch)." },
    },
    required: ["dir", "title"],
  },
  surfaces: { mcp: false, http: true },
  gate: githubEnabled,
  sideEffect: "write",
  settles: "immediate",
  approval: { policy: "ask", summary: (args) => `github: open PR "${typeof args.title === "string" ? args.title.slice(0, 100) : ""}"` },
};

const GITHUB_PR_VIEW: HarnessTool = {
  name: "github_pr_view",
  description: "View a pull request's status (including CI checks) in a repo already cloned with github_clone.",
  schema: {
    type: "object",
    properties: {
      dir: { type: "string", description: "The folder name passed to github_clone." },
      number: { type: "integer", description: "PR number. Omit to view the current branch's PR." },
    },
    required: ["dir"],
  },
  surfaces: { mcp: false, http: true },
  gate: githubEnabled,
  sideEffect: "read",
  settles: "immediate",
};

const GITHUB_PR_LIST: HarnessTool = {
  name: "github_pr_list",
  description: "List open pull requests in a repo already cloned with github_clone.",
  schema: {
    type: "object",
    properties: { dir: { type: "string", description: "The folder name passed to github_clone." } },
    required: ["dir"],
  },
  surfaces: { mcp: false, http: true },
  gate: githubEnabled,
  sideEffect: "read",
  settles: "immediate",
};

const GITHUB_PR_CHECKOUT: HarnessTool = {
  name: "github_pr_checkout",
  description: "Check out an existing pull request's branch in a repo already cloned with github_clone.",
  schema: {
    type: "object",
    properties: {
      dir: { type: "string", description: "The folder name passed to github_clone." },
      number: { type: "integer" },
    },
    required: ["dir", "number"],
  },
  surfaces: { mcp: false, http: true },
  gate: githubEnabled,
  sideEffect: "write",
  settles: "immediate",
  approval: { policy: "ask", summary: (args) => `github: checkout PR #${args.number ?? "?"}` },
};

const GITHUB_ISSUE_CREATE: HarnessTool = {
  name: "github_issue_create",
  description: "Open an issue in a repo already cloned with github_clone.",
  schema: {
    type: "object",
    properties: {
      dir: { type: "string", description: "The folder name passed to github_clone." },
      title: { type: "string" },
      body: { type: "string" },
    },
    required: ["dir", "title"],
  },
  surfaces: { mcp: false, http: true },
  gate: githubEnabled,
  sideEffect: "write",
  settles: "immediate",
  approval: { policy: "ask", summary: (args) => `github: open issue "${typeof args.title === "string" ? args.title.slice(0, 100) : ""}"` },
};

const GITHUB_ISSUE_VIEW: HarnessTool = {
  name: "github_issue_view",
  description: "View an issue in a repo already cloned with github_clone.",
  schema: {
    type: "object",
    properties: {
      dir: { type: "string", description: "The folder name passed to github_clone." },
      number: { type: "integer" },
    },
    required: ["dir", "number"],
  },
  surfaces: { mcp: false, http: true },
  gate: githubEnabled,
  sideEffect: "read",
  settles: "immediate",
};

const GITHUB_ISSUE_LIST: HarnessTool = {
  name: "github_issue_list",
  description: "List open issues in a repo already cloned with github_clone.",
  schema: {
    type: "object",
    properties: { dir: { type: "string", description: "The folder name passed to github_clone." } },
    required: ["dir"],
  },
  surfaces: { mcp: false, http: true },
  gate: githubEnabled,
  sideEffect: "read",
  settles: "immediate",
};

/** Every tool the registry owns, in the order the MCP lane publishes them —
 *  spelled out here, not derived, so reordering this array is a deliberate
 *  edit rather than something that silently reorders the MCP wire list. */
export const HARNESS_TOOLS: readonly HarnessTool[] = [
  LIST_BOTS,
  ASK_BOT,
  DELEGATE_BOT,
  CREATE_BOT,
  REQUEST_CREDENTIAL,
  LIST_ROUTINES,
  PROPOSE_ROUTINE,
  PROPOSE_ROUTINE_ACTION,
  BASH,
  READ_FILE,
  WRITE_FILE,
  EDIT_FILE,
  RECALL_SEARCH,
  RECALL_CONTRIBUTE,
  RECALL_STATS,
  PHONE_STATUS,
  PHONE_READ_SCREEN,
  PHONE_LIST_APPS,
  PHONE_OPEN_APP,
  PHONE_TAP_TEXT,
  PHONE_TAP,
  PHONE_SWIPE,
  PHONE_TYPE_TEXT,
  PHONE_PRESS,
  GITHUB_CLONE,
  GITHUB_STATUS,
  GITHUB_COMMIT,
  GITHUB_PUSH,
  GITHUB_PR_CREATE,
  GITHUB_PR_VIEW,
  GITHUB_PR_LIST,
  GITHUB_PR_CHECKOUT,
  GITHUB_ISSUE_CREATE,
  GITHUB_ISSUE_VIEW,
  GITHUB_ISSUE_LIST,
];

const BY_NAME = new Map(HARNESS_TOOLS.map((tool) => [tool.name, tool]));

export function harnessTool(name: string): HarnessTool | undefined {
  return BY_NAME.get(name);
}

/** The tools this surface may offer for this turn.  One predicate, two
 *  lanes — which is the whole point. */
export function toolsFor(surface: ToolSurface, ctx: ToolGateContext): HarnessTool[] {
  return HARNESS_TOOLS.filter((tool) => tool.surfaces[surface] && tool.gate(ctx));
}

/** The description this lane advertises: the canonical one unless the
 *  record declares a deviation. */
export function descriptionFor(tool: HarnessTool, surface: ToolSurface): string {
  return tool.wire?.[surface]?.description ?? tool.description;
}

/** The argument schema this lane advertises.  Same rule. */
export function schemaFor(tool: HarnessTool, surface: ToolSurface): JsonSchemaObject {
  return tool.wire?.[surface]?.schema ?? tool.schema;
}

export function mcpToolDefinitions(ctx: ToolGateContext): McpToolDefinition[] {
  return toolsFor("mcp", ctx).map((tool) => ({
    name: tool.name,
    description: descriptionFor(tool, "mcp"),
    inputSchema: schemaFor(tool, "mcp"),
  }));
}

export function httpToolDefinitions(ctx: ToolGateContext): HttpToolDefinition[] {
  return toolsFor("http", ctx).map((tool) => ({
    name: tool.name,
    description: descriptionFor(tool, "http"),
    parameters: schemaFor(tool, "http"),
  }));
}
