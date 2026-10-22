// Canonical harness contracts — ported from upstream
// (apps/server/src/provider/ProviderDriver.ts, Services/ProviderAdapter.ts,
// packages/contracts/src/{provider,providerInstance,providerRuntime}.ts),
// de-Effect-ed: Promises instead of Effect, listener callbacks instead of
// Stream. The shapes and names are kept so the two codebases stay mutually
// readable.

import type { ComputerMount } from "./computer-grants.ts";
import type { ToolKind } from "../shared/tool-activity.ts";

export type DriverKind = string;
export type InstanceId = string;
export type ThreadId = string;
export type TurnId = string;
export type CloudBackend = "box" | "vps";

export type ProviderErrorCode =
  | "missing_cli"
  | "invalid_credentials"
  | "inactive_subscription"
  | "quota_or_region_restriction"
  | "upstream_outage"
  | "model_catalog_outage";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderError";
    this.code = code;
  }
}

/** Reasoning-effort levels, ascending. A union of everything any engine
 * accepts; each driver declares the subset its CLI will take. */
export const EFFORT_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Narrow untrusted API/config input before it becomes a model selection. */
export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

// ── model selection ────────────────────────────────────────────────────
// "Which model" is a data value carried on the request, never a service
// binding (upstream ModelSelectionWire). instanceId is the routing key.
export interface ModelSelection {
  instanceId: InstanceId;
  model: string;
  /** Optional: no effort means no flag, and the CLI keeps its own default. */
  effort?: EffortLevel;
  /** Optional: engines to try if this one fails (e.g. quota/rate limit) */
  fallbacks?: ModelSelection[];
}

// ── instance configuration envelope ────────────────────────────────────
// `driver` is any slug — NOT validated against known drivers; unknown
// drivers round-trip and surface as unavailable shadow snapshots so a
// config from a newer build downgrades safely.
export interface InstanceConfig {
  driver: DriverKind;
  displayName?: string;
  accentColor?: string;
  environment?: Record<string, string>;
  enabled?: boolean;
  config?: { fullAuto?: boolean; cli?: string; [key: string]: unknown } | unknown;
}

export type InstanceConfigMap = Record<InstanceId, InstanceConfig>;

// ── canonical runtime events ───────────────────────────────────────────
// Subset of upstream's 49-member ProviderRuntimeEvent union — the ~12 types
// the recipe says to start with, sharing one base. `raw` carries the
// native protocol message when a consumer needs to see behind the
// normalization.
export interface RuntimeEventBase {
  eventId: string;
  provider: DriverKind;
  providerInstanceId?: InstanceId;
  threadId: ThreadId;
  createdAt: string;
  turnId?: TurnId;
  itemId?: string;
  requestId?: string;
  raw?: { source: string; payload: unknown };
}

export type TurnBillingMode = "actual" | "estimated";

export type RuntimeEvent = RuntimeEventBase &
  (
    | { type: "session.started"; sessionId: string | null; model?: string | null; rebuilt?: boolean }
    | { type: "session.exited"; reason?: string }
    | { type: "turn.started" }
    | {
        type: "turn.retrying";
        /** 1-based: the retry about to be launched (1 = first relaunch). */
        attempt: number;
        delayMs: number;
        /** Why this failure was judged retry-worthy (classifyError's reason). */
        reason: string;
        /** Total attempts THIS failure is worth, the first one included.
         *  Optional: a driver that has one fixed ceiling omits it and the
         *  renderer falls back to RETRY_MAX_ATTEMPTS.  The chat-completions
         *  loop sends it because its ceiling is per-status — a 429 with no
         *  `Retry-After` is worth two attempts, and a chip reading
         *  "attempt 2/3" right before the turn fails after attempt 2
         *  promises a try that is never coming. */
        maxAttempts?: number;
      }
    | {
        type: "turn.completed";
        ok: boolean;
        stopReason?: string | null;
        cost?: number | null;
        /** Whether `cost` is a charge or a provider-reported equivalent. */
        billingMode?: TurnBillingMode;
        denials?: string[];
        /** THIS turn's token total, as the provider reports it at the end.
         * The one figure the harness accumulates — thread.token-usage.updated
         * is a live indicator whose meaning differs per driver (a per-call
         * delta, a thread total, a per-step figure) and must never be summed.
         * Invariant: when `cachedInput` is present it is ALREADY INCLUDED in
         * `input` (claude.ts sums cache reads into input; codex reports it
         * that way natively).  Usage Monitor telemetry subtracts it back out
         * to bill cache reads at their own rate, so a driver that reports
         * input EXCLUDING cache must fold the cache figure in first.
         * `output` is optional: DSH's ACP server reports only a combined
         * context-occupancy figure (session/update `usage_update`), never a
         * real input/output split, so a driver that only knows one side
         * omits the other rather than reporting a fabricated 0. */
        usage?: { input: number; output?: number; cachedInput?: number };
      }
    | {
        type: "item.started";
        itemType: "tool" | "reasoning";
        title?: string;
        /** What the step acted on — a path, a command, a pattern, a URL.
         * Drivers get this for free (every harness sends the tool payload)
         * and dropping it is what made a transcript of seven `read_file`
         * chips unreadable.  Already clipped and home-shortened by
         * `shared/tool-activity.ts`; never the whole payload. */
        target?: string;
        /** Coarse class of work, when the engine knows it better than the
         * tool name does (ACP reports one). */
        toolKind?: ToolKind;
        /** Full JSON-encoded arguments the model passed to the tool, in
         * OpenAI function-calling shape.  HTTP drivers emit this so the
         * HTTP tool executor can replay the call on the harness side
         * (the model gave the executor nothing; only the wire stream
         * knew what arguments were passed).  CLI drivers omit it — they
         * run the tool call themselves, the executor never sees the
         * event for a CLI driver that stopped on tool calls. */
        arguments?: string;
      }
    | { type: "item.updated"; itemType: "tool" | "reasoning"; tokens?: number | null }
    | {
        type: "item.completed";
        itemType: "tool";
        ok: boolean;
        /** One line of what came back — rows read, the failure's message.
         * A failure's detail is the whole reason the row is worth reading. */
        detail?: string;
        /** Settled JSON-encoded arguments.  Streamed `item.started` may
         * only have held the first fragment; the executor reads this. */
        arguments?: string;
      }
    | { type: "item.completed"; itemType: "assistant_text"; text: string }
    | { type: "content.delta"; streamKind: "assistant_text" | "reasoning_text"; delta: string }
    | {
        type: "request.opened";
        requestType: "permission" | "question";
        tool: string;
        summary: string;
        choices?: string[];
        approvalScope?: "local-computer";
      }
    | {
        type: "request.resolved";
        behavior: "allow" | "deny" | "answer";
        /** who decided: a person, auto mode, the ask's own timeout, the
         * harness (turn ended / settings changed), or nobody — the answerer
         * was already gone and the action never ran */
        source: "user" | "auto" | "timeout" | "system" | "unavailable" | "peer";
        approvalScope?: "local-computer";
      }
    // Same invariant as turn.completed.usage: `cachedInput` is a subset of
    // `input`, and `output` is optional for the same reason (see there).
    | { type: "thread.token-usage.updated"; input: number; output?: number; cachedInput?: number }
    // `setup: true` marks a failure the user fixes by installing or
    // configuring something, not by retrying — the UI offers setup instead.
    | { type: "runtime.error"; message: string; setup?: boolean }
  );

export type RuntimeEventListener = (event: RuntimeEvent) => void;

/** What became of an answer to an ask. `allowed-once` grants only the
 * asked-about action — broadening ("always allow") stays a separate,
 * explicit step. `unavailable` is the fail-closed default: no answerer,
 * no action. */
export type RequestOutcome = "allowed-once" | "rejected" | "answered" | "unavailable";

// ── adapter contract (upstream ProviderAdapterShape, promise-flavored) ──
// The conversation runtime every provider is flattened into. streamEvents
// becomes onEvent(listener) → unsubscribe; sessions start implicitly on
// the first turn (the agentcal per-turn-process model) with resumeCursor
// carrying the provider-native continuation (e.g. a claude session id).
export interface SendTurnInput {
  threadId: ThreadId;
  text: string;
  model?: string;
  effort?: EffortLevel;
  resumeCursor?: unknown;
  /** The turn with the conversation so far replayed inline, attached only
   * alongside resumeCursor. A cursor-resuming driver sends it once, on a
   * fresh session, when the provider refuses the cursor before reading the
   * prompt (server/resume-recovery.ts) — so a session the provider lost
   * does not brick the thread, and the new session is not blank. */
  recoveryText?: string;
  /** recoveryText is the replay this turn would have been sent without a
   * resume cursor (it carries an update from outside the session). A driver
   * that rebuilds only some lost sessions may also rebuild this one. */
  recoveryIsReplay?: boolean;
  /** Prior turns for transcript-replay providers (API-backed drivers).
   *  Each entry may carry tool call and result metadata so the executor
   *  can replay a multi-step turn that has already been settled: the
   *  assistant entry's `toolCalls` re-hands the model the same calls it
   *  made before, and the user entry's `toolResults` (with role "tool"
   *  on the wire) is the result the harness produced.  A flat user/role
   *  entry is still the dominant shape for plain text. */
  transcript?: Array<{
    role: "user" | "assistant";
    text: string;
    toolCalls?: Array<{
      id: string;
      name: string;
      /** JSON-encoded arguments the model passed to the tool. */
      arguments: string;
    }>;
    toolResults?: Array<{
      id: string;
      result: string;
    }>;
  }>;
  /** Bot persona (name/title/description) as a system prompt.  Always the
   *  whole prompt, every section in order, so a driver that has not adopted
   *  the split below keeps sending exactly what it sent before. */
  system?: string;
  /** `system` split at the sections that legitimately change
   *  mid-conversation (memory, mentions; upstream also outstanding teammate
   *  work and recent work): `systemStable` is everything else, `systemVolatile`
   *  is those sections' text.  A driver that keeps one CLI process per thread
   *  keys that process on the stable half, so a memory edit no longer
   *  respawns the session and makes the provider re-cache the entire prompt;
   *  the changed half is delivered inside the next turn instead.  Drivers
   *  that rebuild their request every turn keep only the stable half in
   *  their system message and carry the volatile half inside the newest user
   *  message, so the resent prefix stays byte-identical.  Both are present
   *  or neither is (see drivers/prompt-split.ts promptHalves). */
  systemStable?: string;
  systemVolatile?: string;
  /** sha256 hex of `systemVolatile`, computed once by the server so a driver
   *  comparing halves against a receipt need not hash the text itself. */
  volatileDigest?: string;
  /** True when this turn's user message tags teammates: the mentions part
   *  of systemVolatile describes this turn even when its text is unchanged
   *  from the previous turn, so digest-based delivery must not suppress the
   *  note. */
  mentionTurn?: boolean;
  /** Tool definitions the agent may call this turn, in OpenAI function-calling
   * shape.  An HTTP driver (MiniMax, OpenAI-compatible) hands these to the
   * model verbatim; a CLI driver that mounts MCP servers is free to ignore
   * the field and discover tools from the running server instead.  The
   * transcript-replay layer threads tool results back in via the
   * `toolResults` field on the prior assistant turn. */
  tools?: Array<{
    name: string;
    description?: string;
    /** JSON Schema for the tool's arguments, in the form the OpenAI Chat
     * Completions API expects.  Default is an empty object schema. */
    parameters?: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
  }>;
  /** Per-bot integrations the driver may hand to the agent as tools. */
  integrations?: {
    /** A local stdio bridge owns the remote Composio transport. Keeping the
     * bridge harness-controlled lets it turn connection requests into trusted
     * chat cards consistently across provider CLIs. */
    composio?: { command: string; args: string[]; env: Record<string, string> };
    /** Cloud computer, reached through BotFleet's REST-to-MCP adapter.
     * `control` is the harness's loopback who-is-driving endpoint: the
     * adapter consults it so a person who takes the wheel in the panel
     * pauses the bot's hands mid-turn instead of typing over them. */
    computer?: {
      kind?: "box";
      boxId: string;
      token: string;
      control?: { url: string; token: string };
    };
    /** Direct stdio connection to a Cua Driver MCP server (host, sandbox, or
     * VPS). `scope` is set only for the user's host desktop; isolated and
     * remote computers intentionally omit it so host-only approval rules
     * cannot change their semantics. */
    localComputer?: {
      command: string;
      args: string[];
      env: Record<string, string>;
      platform?: "darwin" | "linux" | "win32";
      generation?: string;
      scope?: "local-computer";
    };
    /** Peer-agent comms: an MCP proxy (list_bots / ask_bot) that routes back
     * through the harness so this bot can message other bots. The harness
     * owns turns, permissions, and recursion limits; the proxy only forwards. */
    agents?: { command: string; args: string[]; env: Record<string, string> };
    /** Physical Android phone tools over authorized USB debugging. */
    phone?: { command: string; args: string[]; env: Record<string, string> };
    /** dweb network daemon: an MCP proxy exposing dweb status, repo, and
     * opencode model access as tools. url is the dweb HTTP base. */
    dweb?: { url: string };
    /** Shared Qdrant Agent RAG vector memory integration. */
    qdrant?: { command: string; args: string[]; env: Record<string, string> };
    /** Every computer this bot was granted for this turn, in the order the
     * person granted them. A grant is a capability, not a preference: each
     * entry is mounted as its own MCP server so the agent chooses per task.
     * `computer` and `localComputer` above stay populated with the first
     * mount of each shape, so a consumer that still expects exactly one
     * computer keeps working. */
    computers?: ComputerMount[];
  };
  /** The harness's tool executor for THIS turn, handed only to a driver that
   *  declares `capabilities.toolLoop`.  Everything else on this contract is
   *  plain data; this one field is a service the harness lends the driver for
   *  the life of the turn, which is safe because `SendTurnInput` is never
   *  serialized or persisted (only `RuntimeEvent` reaches the NDJSON tee).
   *  A CLI driver never receives it. */
  toolHost?: TurnToolHost;
  cwd?: string;
  /** True when the bot has autoApprove enabled by the user. */
  autoApprove?: boolean;
  /** True when this turn began from an outside event (webhook, resource
   *  threshold) or was inherited from an already-unattended bot.  Auto Mode
   *  is something a person switched on for turns they are present for, so a
   *  driver that converts autoApprove into a permission bypass must treat an
   *  unattended turn as a hard stop (see auto-approve.ts). */
  unattended?: boolean;
}

/** One tool call the model asked for, decoded.  `arguments` is always an
 *  object — every entry on the catalog is declared as a JSON-shape tool. */
export interface TurnToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** What the host made of a tool call.  The three variants are the only
 *  three things that can happen, and each one has a defined effect on the
 *  driver's loop, so a host cannot leave a turn in an undefined state. */
export type TurnToolOutcome =
  /** Feed `content` back to the model as a tool result and keep looping. */
  | { kind: "result"; content: string; detail?: string }
  /** Same, but the transcript chip renders red.  Never ends the turn — a
   *  failing tool is information the model gets to act on. */
  | { kind: "error"; content: string; detail?: string }
  /** The tool put a card in front of a person.  The turn MUST end here; the
   *  existing secret/connector resume drains a fresh turn when the card is
   *  answered, exactly as a CLI agent's end-of-turn does. */
  | { kind: "suspend"; content: string; detail?: string; stopReason: string };

/** Harness services lent to a tool for the life of one call. */
export interface TurnToolRuntime {
  /** Aborted when the turn is interrupted, swept, or torn down.  A tool that
   *  makes a network call must pass this through so Stop reaches it. */
  signal: AbortSignal;
  /** Ask a person.  Resolves `"allowed-once"` only when somebody actually
   *  allowed it; `"unavailable"` — no broker mounted, or the turn ended
   *  under an open card — is fail-closed and the caller treats it as a
   *  deny.  The driver's loop supplies this: it pauses the per-tool clock
   *  for as long as the card is open, then delegates to the harness's
   *  permission broker (`TurnToolHost.requestApproval`). */
  requestApproval(ask: { tool: string; summary: string }): Promise<RequestOutcome>;
}

/** The harness side of a driver-owned tool loop.  A driver that declares
 *  `capabilities.toolLoop` runs model-to-tool rounds inside `sendTurn` and
 *  calls this for each tool the model asks for.
 *
 *  `execute` NEVER throws: a thrown error is normalised to
 *  `{ kind: "error" }` by the host itself, so the driver's loop has exactly
 *  one shape to handle.  The host owns approval cards, per-turn counters and
 *  caller identity; the driver knows none of that. */
export interface TurnToolHost {
  execute(call: TurnToolCall, runtime: TurnToolRuntime): Promise<TurnToolOutcome>;
  /** Hard ceiling on model-to-tool rounds for this turn.  Absent = the
   *  driver's own default. */
  maxRounds?: number;
  /** The harness's permission broker for THIS turn, bound at dispatch to
   *  the turn's own bot — the same closure that owns caller identity, for
   *  the same reason.  A driver that runs its own tool loop hands this to
   *  the loop, which pauses its per-tool clock around the ask and passes it
   *  back in as `TurnToolRuntime.requestApproval`.  Absent means no broker
   *  is mounted and every ask is fail-closed `"unavailable"`. */
  requestApproval?(ask: {
    tool: string;
    summary: string;
    /** The tool call's own signal, so an interrupted turn settles the ask
     *  instead of leaving a card nobody can answer. */
    signal?: AbortSignal;
  }): Promise<RequestOutcome>;
}

export interface TurnStartResult {
  turnId: TurnId;
  /** False when the driver emitted a terminal event before provider launch.
   * Callers must preserve that event while skipping successful-dispatch
   * bookkeeping such as cursor freshness.  Omitted means dispatched. */
  dispatched?: boolean;
}

export interface ProviderAdapter {
  readonly provider: DriverKind;
  readonly capabilities: {
    sessionModelSwitch: "in-session" | "unsupported";
    /** True when the driver mounts turn.integrations.agents as MCP tools —
     * the harness only offers agents tooling (and prompts about it) to
     * drivers that can actually hand it to the agent. */
    agentsMcp?: boolean;
    /** True when the driver mounts turn.integrations.computer (the box's
     * screenshot/click tools). Same rule as agentsMcp: a bot must never be
     * told it has a computer whose tools its driver cannot mount — it
     * burns turns hunting for tools that aren't there. */
    computerMcp?: boolean;
    /** True when the driver mounts turn.integrations.composio (the user's
     * connected apps). Same rule again: a key in the config says the user
     * HAS those connections, not that this driver can reach them. */
    composioMcp?: boolean;
    /** True when the driver can mount the first-party physical-phone MCP. */
    phoneMcp?: boolean;
    /** True when the driver mounts turn.integrations.qdrant (Agent RAG). */
    qdrantMcp?: boolean;
    /** True when this engine accepts images in the prompt — gates image
     * paste in the composer. Same rule as computerMcp: never offer an
     * attachment an engine cannot open (a bot told it has an image it
     * cannot read burns the turn). */
    images?: boolean;
    /** Effort levels this driver can pass to its CLI, ascending. Absent =
     * the driver cannot set effort, so the app never offers the control —
     * same rule as computerMcp: never show a knob the driver cannot turn. */
    effortLevels?: readonly EffortLevel[];
    /** True when the driver keeps a live session across turns and can take
     * a user message MID-TURN (delivered before the model's next call —
     * "steer"). The composer stays open during a turn on such an engine;
     * others keep the queue-one-and-wait behaviour. Same rule as the other
     * flags: never show a control the driver cannot honour. */
    queueing?: boolean;
    /** True only when host-control asks can reach the harness permission
     * broker. A full-auto/bypass instance may advertise it only because it
     * runs a host-control turn in its asking mode (see the ACP core, Claude,
     * and pi drivers); an engine with no approval channel at all must leave
     * this false. */
    localComputerMcp?: boolean;
    /** True when the driver runs the harness tool loop INSIDE sendTurn and
     * emits exactly one turn.started / turn.completed pair per user turn,
     * the way every CLI driver already does.  The harness hands
     * `SendTurnInput.toolHost` only to such a driver, and dispatches it on
     * the same one-line path it uses for a CLI engine. */
    toolLoop?: boolean;
    /** True when the driver builds its own message history from
     * `SendTurnInput.transcript` every turn — every chat-completions driver
     * does this, the way a CLI driver replays its own native session.  A
     * driver that lacks this flag gets the transcript INLINED into the
     * turn text as well, which is correct only because such a driver never
     * also expands `transcript` itself.  Absent = inline (today's CLI
     * default); a driver that sets this and also inlines the transcript
     * would send it twice. */
    replaysTranscript?: boolean;
  };
  sendTurn(input: SendTurnInput): Promise<TurnStartResult>;
  interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void>;
  /** Answer a pending ask. Resolves with what actually happened — never
   * throws for an ask that is no longer there: `unavailable` means nobody
   * could take the answer (the turn ended, the broker died, the driver
   * has no asks), and the caller treats it as a deny. Callers branch on the
   * outcome, not on prose. */
  respondToRequest(
    threadId: ThreadId,
    requestId: string,
    decision: { behavior: "allow" | "deny" | "answer"; message?: string },
  ): Promise<RequestOutcome>;
  /** Deliver a user message into the RUNNING turn on this thread. Resolves
   * false when there is no live turn to steer (the caller then sends it as
   * a normal turn). Only drivers with `capabilities.queueing` implement it. */
  steer?(threadId: ThreadId, text: string): Promise<boolean>;
  hasSession(threadId: ThreadId): boolean;
  stopAll(): Promise<void>;
  /** Force-settle any turn whose loop has outlived `olderThanMs`, and report
   * which threads were settled.  Insurance only: a driver whose loop emits
   * its terminal event from a single `finally` can never strand a turn, so a
   * correct implementation always returns `[]` — a non-empty return is a bug
   * report, which is exactly why it is worth the six lines. */
  sweepStuckTurns?(olderThanMs: number): Promise<ThreadId[]>;
  onEvent(listener: RuntimeEventListener): () => void;
}

// ── provider snapshot (upstream ServerProviderShape, reduced) ────────────
export interface ProviderSnapshot {
  state: "available" | "unavailable";
  reason?: string;
  authenticated?: boolean;
  version?: string | null;
  /** How this instance is paid for, when the driver can tell: a reported
   * cost on a subscription is notional and the UI labels it as such. */
  billing?: "metered" | "subscription";
  quota?: {
    capped: boolean;
    resetsAt?: number | null;
    error?: string;
    windowsLabel?: string;
    /** Per-model remaining from antigravity-usage or quota windows.  Instance `capped` is a
     *  wildcard cap, not "any one model is exhausted". */
    models?: Record<string, {
      capped: boolean;
      remainingPercent?: number | null;
      secondaryRemainingPercent?: number | null;
      resetsAt?: number | null;
      error?: string;
      windowsLabel?: string;
    }>;
    /** MiniMax's own balance/quota summary (server/minimax-balance.ts),
     *  computed per INSTANCE in server/harness/registry.ts — each MiniMax
     *  row reads its own account here rather than one shared value, so a
     *  second connection with its own key never shows the reserved
     *  instance's numbers. Present only on a `minimax`-driverKind instance. */
    minimax?: {
      source: "account-balance" | "token-plan" | "unavailable";
      capExists: boolean;
      status: "ok" | "near_cap" | "capped" | "unknown";
      balanceUsd: number | null;
      remainingPercent: number | null;
      secondaryRemainingPercent: number | null;
      resetsAt: number | null;
      weeklyResetsAt: number | null;
      error: string | null;
    };
  };
}

// ── engine install descriptor ───────────────────────────────────────────
// How a user gets this engine onto their machine. Declared by the driver so
// that adding a provider stays "one file in drivers/ plus a registration":
// onboarding, the model picker, and settings all render from this instead of
// hardcoding per-engine copy in the UI.
//
// Installing is rarely the whole job — most CLIs then need an interactive
// sign-in, which is why signInCommand exists and why the UI sends people to a
// terminal rather than trying to shell out silently.
export interface EngineInstall {
  /** One-liner per platform. Omit a platform that has no such command —
   * the UI falls back to docsUrl rather than offering something that
   * cannot work there (a curl|bash line is not a Windows command). */
  command?: Partial<Record<"darwin" | "win32" | "linux", string>>;
  /** Docs or download page. The only route for GUI-installed engines. */
  docsUrl?: string;
  /** Interactive sign-in run after installing, when install isn't enough. */
  signInCommand?: string;
  /** `command` needs npm on PATH, so the UI can say so when Node is absent. */
  needsNode?: boolean;
  /** This driver has no CLI and no interactive login — it authenticates with
   * a bare credential (an API key), so `command` is guidance text ("get a
   * key, then set this env var or config file"), not a shell one-liner.
   * The setup UI reads this to say "add a key" instead of "install" or
   * "sign in," and skips offering to paste the guidance into a terminal. */
  apiKeyOnly?: boolean;
}

// ── driver SPI (upstream ProviderDriver — a plain record, not a service) ─
// `create` owns ALL per-instance state; two create calls share nothing.
// Failures must reject, never throw synchronously — the registry downgrades
// a rejection to an unavailable shadow snapshot.
export interface ModelCatalog {
  default: string;
  options: Array<{
    id: string;
    label: string;
    custom?: boolean;
    loaded?: boolean;
    /** total context window in tokens, when the driver knows it — sizes
     * the model-facing rebuild (server/context-rebuild.ts). Unknown falls
     * back to a pattern table over the model id, then a conservative default. */
    contextWindow?: number;
    /** Effort levels this specific model supports, if any.
     * When defined, only models with non-empty effortLevels support effort. */
    effortLevels?: readonly EffortLevel[];
    supportsEffort?: boolean;
  }>;
}

export interface DriverCreateInput<Config> {
  instanceId: InstanceId;
  displayName: string | undefined;
  environment: Record<string, string>;
  enabled: boolean;
  config: Config;
}

export interface ProviderInstance {
  readonly instanceId: InstanceId;
  readonly driverKind: DriverKind;
  readonly displayName: string | undefined;
  readonly enabled: boolean;
  readonly iconUrl?: string;
  readonly models: ModelCatalog;
  /** Refresh a live catalog without recreating the provider instance. */
  readonly refreshModels?: () => Promise<void>;
  readonly adapter: ProviderAdapter;
  snapshot(): Promise<ProviderSnapshot>;
  /** Cheap one-shot text call (upstream TextGeneration) — titles, summaries. */
  generateText?(prompt: string): Promise<string>;
  /** Isolated, tool-free permission review on this same provider. Kept
   * separate from generateText so the UI never infers a security capability
   * from a generic helper that may expose prompts in argv or lack approvals. */
  reviewPermission?(prompt: string, signal?: AbortSignal): Promise<string>;
  dispose(): Promise<void>;
}

/** How an engine is presented in the picker rail.
 *  `subscription` — first-party cloud catalog; Custom is extra.
 *  `custom` — no subscription catalog; Custom is the product. */
export type EngineAccess = "subscription" | "custom";

export interface ProviderDriver<Config = unknown> {
  readonly driverKind: DriverKind;
  readonly metadata: {
    displayName: string;
    supportsMultipleInstances?: boolean;
    access?: EngineAccess;
  };
  /** How to get this engine installed. Omit for engines that need no local
   * binary (API-key drivers), which is what makes it optional. */
  readonly install?: EngineInstall;
  /** Decode the opaque config envelope; throw on invalid (→ shadow). */
  decodeConfig(raw: unknown): Config;
  defaultConfig(): Config;
  readonly models: ModelCatalog;
  create(input: DriverCreateInput<Config>): Promise<ProviderInstance>;
}

export type AnyProviderDriver = ProviderDriver<any>;

let eventCounter = 0;
export const newEventId = () => `ev-${Date.now().toString(36)}-${(eventCounter++).toString(36)}`;
export const newId = () => crypto.randomUUID();
