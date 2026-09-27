// The driver-owned tool loop for chat-completions engines.
//
// WHY THIS FILE EXISTS.  A CLI engine runs its own model-to-tool rounds
// inside one turn and emits exactly one `turn.started` / `turn.completed`
// pair per user turn.  Every one of the harness's `turn.completed`
// consumers — the watchdog, the Sentry span closer, the routine receipt,
// the repeat detector, the room waiter, the queue drains, the SSE
// broadcast, the usage fold — was written against that shape.  The HTTP
// lane used to break it: each inner round was its own `turn.completed`
// carrying a `"tool_calls: "` prefix, five consumers guarded on the
// prefix and six did not, and every exit that was not "the model finally
// answered" — the round cap, the round timer, a rejected dispatch —
// emitted no terminal event at all, so the bot stayed busy until the
// twenty-minute stall watchdog fired.
//
// Moving the loop in here makes an HTTP turn indistinguishable from a CLI
// turn at the harness boundary, and it does it structurally rather than by
// adding guards:
//
//   1. ONE terminal event, from ONE `finally`.  Nothing else in this file
//      emits `turn.completed`.  No exit — round cap, wall clock, request
//      timeout, provider error, abort, suspend, a host that throws, an
//      unexpected throw — can leave a turn unsettled.  The exit union
//      below is CLOSED and both lookup tables are `Record<TurnLoopExit, …>`,
//      so a new exit cannot be added without a stop reason, an ok flag,
//      and (in loop.test.ts) a test row.
//   2. The messages array lives here and is only appended to, so the
//      prefix the provider already saw stays byte-identical across rounds.
//   3. Usage sums across rounds and is carried on the terminal event, on
//      the error path as well as the success path.
//   4. `item.completed` for a tool carries the REAL outcome, emitted after
//      the host returns — never `ok: true` for work the driver did not do.
//   5. The turn's abort signal is checked between rounds and raced inside
//      every tool call, so Stop terminates from any point in the loop.
//   6. A round's request is RETRIED, in here, for the transient failures a
//      CLI engine already rides out silently — a 502, a reset socket, a
//      429 that named its own cool-down.  The retry is INSIDE one round,
//      so it changes nothing about invariant 1: the attempt loop's every
//      exit still falls through to the same single `finally`.  Two rules
//      keep it honest.  It never retries a request that already PUBLISHED
//      anything (a text delta, a reasoning delta, a tool call announced
//      off the stream) — replaying that round would duplicate output a
//      person already read, which is worse than the failure.  And it never
//      starts an attempt it cannot finish: the round's own ceiling
//      and the turn's 900s wall clock both have to have real headroom
//      left, and the sleep between attempts aborts with the turn, so Stop
//      during a backoff settles immediately instead of after the wait.

import type {
  RequestOutcome,
  RuntimeEvent,
  RuntimeEventBase,
  TurnToolCall,
  TurnToolHost,
  TurnToolOutcome,
} from "../../contracts.ts";
import { ProviderError } from "../../contracts.ts";
import { parseToolArguments, toolFields } from "../../tool-fields.ts";
import { RETRY_MAX_ATTEMPTS, classifyError, computeBackoff, interruptibleDelay } from "../retry.ts";
import { UNHINTED_RATE_LIMIT_ATTEMPTS, httpFailureOf, httpRetryPolicy, isPrematureCloseError } from "./errors.ts";

/** Every way a turn can end.  Closed on purpose: `STOP_REASON` and
 *  `TERMINAL_OK` are `Record<TurnLoopExit, …>`, so adding a member without
 *  deciding what the user sees is a type error, not a silent hang. */
export type TurnLoopExit =
  /** The model returned text with no tool calls. */
  | "settled"
  /** A tool put a card in front of a person; the resume drains a new turn. */
  | "suspended"
  /** `maxRounds` model requests were spent and the model still wanted tools. */
  | "tool_round_limit"
  /** The whole-turn budget ran out. */
  | "wall_clock"
  /** One model request exceeded `requestTimeoutMs`, or went silent for
   *  `requestIdleMs`. */
  | "request_timeout"
  /** An HTTP or stream failure from the provider. */
  | "provider_error"
  /** Stop, a sweep, or teardown. */
  | "interrupted"
  /** Anything else — never silently swallowed. */
  | "internal_error";

export const STOP_REASON: Record<TurnLoopExit, string> = {
  settled: "end_turn",
  suspended: "awaiting_human",
  tool_round_limit: "tool_round_limit",
  wall_clock: "timeout",
  request_timeout: "timeout",
  provider_error: "error",
  interrupted: "interrupted",
  internal_error: "error",
};

export const TERMINAL_OK: Record<TurnLoopExit, boolean> = {
  settled: true,
  suspended: true,
  tool_round_limit: false,
  wall_clock: false,
  request_timeout: false,
  provider_error: false,
  interrupted: false,
  internal_error: false,
};

export interface TurnLoopBudget {
  /** Model requests this turn may spend.  The LAST request is never allowed
   *  to start a tool batch, because its results could never be reported back
   *  — running side effects nobody reads is worse than stopping one round
   *  earlier. */
  maxRounds: number;
  /** HARD ceiling on one model round, however live its stream is, enforced
   *  by an abort the request itself carries.  A harness-side timer that
   *  fires while the request keeps streaming is what manufactured orphaned
   *  late completions before.  Shared by every attempt at the round. */
  requestTimeoutMs: number;
  /** IDLE ceiling on one model request: how long it may go without the
   *  driver reporting progress (`onChunk` for any raw bytes off the socket,
   *  `onPublished` for anything put on the bus) before it is aborted as a
   *  `request_timeout`.  Re-armed at the start of every attempt and on
   *  every progress report, so a slow reasoning round that keeps streaming
   *  runs until the hard ceiling while a dead connection is caught in this
   *  long.  `0` turns it off, for a driver that owns its own stall guard. */
  requestIdleMs: number;
  /** Ceiling on one tool call. */
  toolTimeoutMs: number;
  /** Ceiling on the whole turn, rounds and tools together. */
  wallClockMs: number;
  /** Tool calls from one round that may run at once. */
  toolConcurrency: number;
  /** Attempts ONE round's model request may spend, the first one included:
   *  3 is one request plus two retries.  A status can ask for fewer (a 429
   *  with no `Retry-After` is worth exactly one polite retry, see
   *  errors.ts's httpRetryPolicy) but never for more.  Set to 1 to turn
   *  retrying off entirely. */
  maxRequestAttempts: number;
}

export const DEFAULT_TURN_LOOP_BUDGET: TurnLoopBudget = {
  maxRounds: 12,
  requestTimeoutMs: 600_000,
  requestIdleMs: 120_000,
  toolTimeoutMs: 90_000,
  wallClockMs: 900_000,
  toolConcurrency: 4,
  maxRequestAttempts: RETRY_MAX_ATTEMPTS,
};

/** An attempt that cannot plausibly finish is not worth starting, so a
 *  retry is declined unless this much budget survives the backoff — on
 *  BOTH the round's own request ceiling and the turn's wall clock.
 *  Without it the last retry of a slow round reliably burns its sleep and
 *  then dies to the very deadline that was already visible when it was
 *  scheduled, turning one honest provider error into a timeout the person
 *  waited an extra few seconds for. */
export const RETRY_HEADROOM_MS = 20_000;

/** One OpenAI chat message.  The loop owns the array; the driver only turns
 *  it into a request body. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
}

export interface ChatToolCall {
  id: string;
  type?: "function";
  function: { name: string; arguments: string };
}

export interface TurnUsage {
  input: number;
  output: number;
  cachedInput?: number;
}

/** What one model request produced. */
export interface TurnRoundResult {
  text: string;
  toolCalls?: ChatToolCall[];
  usage: TurnUsage | null;
}

export interface TurnLoopDeps {
  /** Event envelope for this turn — eventId, provider, threadId, turnId. */
  base: () => RuntimeEventBase;
  emit: (event: RuntimeEvent) => void;
  /** One model request.  MUST honour `signal` and MUST reject on an HTTP or
   *  stream failure; the loop classifies the rejection.
   *
   *  `onUsage`, if the driver's request shape can report it, is a LIVE
   *  channel separate from the resolved `TurnRoundResult.usage`: it fires as
   *  soon as the provider's response names a usage figure, even if the
   *  round goes on to reject (a request timeout or a provider error after
   *  several streamed chunks).  The loop folds whichever arrived last into
   *  the terminal usage total on that failure path, so a turn that spent
   *  real tokens before failing is never billed as zero. */
  runRound: (
    messages: ChatMessage[],
    opts: {
      signal: AbortSignal;
      round: number;
      /** 1-based attempt at THIS round's request; > 1 means the previous
       *  attempt failed transiently and was retried.  Informational — the
       *  driver re-sends the same `messages` either way. */
      attempt: number;
      /** Called by the driver the first time this request puts something
       *  on the bus that cannot be taken back: a content delta, or an
       *  `item.started` announced off the stream.  It is what makes the
       *  no-retry-after-first-delta rule enforceable from in here, where
       *  the loop cannot otherwise see what the driver emitted.  A driver
       *  that never calls it simply never gets a round retried after it
       *  started streaming — the safe direction; one that calls it too
       *  eagerly loses a retry, never duplicates output. */
      onPublished?: () => void;
      /** Called by the driver for every raw chunk its response body
       *  yields (and once when the response headers arrive), parsed into
       *  anything or not.  It is the liveness signal `requestIdleMs` is
       *  measured against: "is the socket still moving", not "did the
       *  model say something new" — keep-alives and reasoning frames a
       *  driver does not surface still count.  A driver that never calls
       *  it is judged on `onPublished` alone, and one that calls neither
       *  gets `requestIdleMs` of total budget per attempt. */
      onChunk?: () => void;
      onUsage?: (usage: TurnUsage) => void;
    },
  ) => Promise<TurnRoundResult>;
  /** Round 1's messages.  The loop appends to this array in place. */
  messages: ChatMessage[];
  toolHost?: TurnToolHost;
  /** The harness's permission broker for this turn — normally
   *  `toolHost.requestApproval`, handed across by the driver.  The loop
   *  wraps it (see `runOneTool`) so the per-tool clock stops while a card
   *  is in front of a person, then passes the wrapper to the host as
   *  `TurnToolRuntime.requestApproval`.  Absent = no broker mounted, and
   *  every ask is fail-closed `"unavailable"`. */
  requestApproval?: (ask: {
    tool: string;
    summary: string;
    signal?: AbortSignal;
  }) => Promise<RequestOutcome>;
  /** The turn's interrupt signal — `interruptTurn`, `stopAll`, `dispose`. */
  signal: AbortSignal;
  /** Tool ids the streaming reader already announced with `item.started`,
   *  shared with the driver so a call is never announced twice. */
  startedToolIds?: Set<string>;
  budget?: Partial<TurnLoopBudget>;
  /** Called inside the `finally`, immediately BEFORE the terminal event.
   *  The driver drops its `active` entry here: a consumer of
   *  `turn.completed` may dispatch the next queued turn synchronously, and
   *  it must not find this thread still busy. */
  onSettled?: (exit: TurnLoopExit) => void;
  /** Turns ONE ROUND's own usage into a dollar cost for that round —
   *  called once per round that reports usage, NOT once at the end with
   *  the turn's cumulative totals.  A provider that tiers its rate by
   *  request size (MiniMax-M3 doubles past 512K input tokens) bills each
   *  REQUEST against its own size; pricing the cumulative totals of a
   *  multi-round turn against one tier would apply the >512K rate to
   *  every token in a turn whose every individual round was actually
   *  billed at the base rate.  The loop sums these per-round costs into
   *  the terminal event's `cost`, on the success path AND every error
   *  path; `usage` on that same event stays the separately-summed
   *  cumulative totals it always was.  Absent (no price table wired up
   *  yet) or a model the driver's table cannot price both make the WHOLE
   *  turn's cost `null` here, never `0` for the priced rounds and never a
   *  partial sum: a hard-coded zero reads as "this turn was free", and a
   *  partial sum reads as a real total when it silently excludes rounds
   *  the driver could not price. */
  computeCost?: (usage: TurnUsage) => number | null;
  now?: () => number;
  /** Multiplier on every retry backoff, for tests only: the
   *  `turn.retrying` event still reports the REAL policy delay, so a test
   *  asserts the policy without paying its seconds.  Production leaves it
   *  at 1. */
  retryDelayScale?: number;
  /** This turn's catalog, as the driver already has it.  The loop reads one
   *  thing from it: a tool's own `timeoutMs`, when the registry declared that
   *  this tool needs longer than the uniform per-tool ceiling.  Absent, or a
   *  tool with no override, keeps `budget.toolTimeoutMs`. */
  tools?: ReadonlyArray<{ name: string; timeoutMs?: number }>;
}

/** A tool's arguments are declared as a JSON object schema; anything else on
 *  the wire is a malformed call, which the host reports back to the model. */
function decodeArguments(raw: unknown): Record<string, unknown> {
  const parsed = parseToolArguments(raw);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

/** Node's setTimeout handle carries `unref`; the DOM's does not, and this
 *  file is typed against both.  A budget nobody is waiting on must never
 *  hold the process open. */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const handle: { unref?: () => void } = timer;
  handle.unref?.();
}

/** Push a pending timer's deadline out by its full delay, in place.  Node's
 *  `Timeout.refresh()` does that without allocating, which matters on a
 *  path that runs once per streamed chunk; where it is missing the caller
 *  re-arms instead. */
function refreshTimer(timer: ReturnType<typeof setTimeout>): boolean {
  const handle: { refresh?: () => unknown } = timer;
  if (typeof handle.refresh !== "function") return false;
  handle.refresh();
  return true;
}

/** Rejects when `signal` aborts, and detaches its listener either way so a
 *  long turn does not accumulate one per race. */
function abortRejection(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let onAbort: () => void = () => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException("aborted", "AbortError"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  // an unobserved rejection is normal here — the race's winner may be the
  // work, not the abort
  promise.catch(() => undefined);
  return { promise, dispose: () => signal.removeEventListener("abort", onAbort) };
}

/**
 * Run one user turn to completion and emit EXACTLY ONE `turn.completed`.
 *
 * Resolves with the exit that produced the terminal event.  Never rejects:
 * an unexpected throw becomes `internal_error`, which is still one terminal
 * event.  The caller detaches it (`void runTurnLoop(...)`) so `sendTurn`
 * still resolves at dispatch, the way every CLI driver's does.
 */
export async function runTurnLoop(deps: TurnLoopDeps): Promise<TurnLoopExit> {
  const budget: TurnLoopBudget = { ...DEFAULT_TURN_LOOP_BUDGET, ...deps.budget };
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const messages = deps.messages;
  const announced = deps.startedToolIds ?? new Set<string>();
  const maxRounds = Math.max(1, deps.toolHost?.maxRounds ?? budget.maxRounds);

  const totals: TurnUsage = { input: 0, output: 0 };
  let sawUsage = false;
  // Summed per-round, from each round's OWN usage — see computeCost's own
  // comment for why this must not be priced from `totals` instead.
  let costSoFar = 0;
  // Once true, `costSoFar` is a partial sum, not a total: some priced
  // round returned `null` (an unpriced/unknown model), so the turn's
  // overall cost must read as unknown rather than as whatever priced
  // rounds happened to add up to.
  let costUnknown = false;
  /** Fold ONE round's own cost into the turn's running total.
   *
   *  Called from the success path AND from the catch: a round that
   *  reported usage through `onUsage` and then rejected mid-stream — a
   *  provider 5xx or a request timeout after several chunks — was really
   *  billed for those tokens, and the catch already folds them into
   *  `totals` and sets `sawUsage`.  Pricing only the successful rounds
   *  would then emit a `cost` that looks authoritative and is too low:
   *  zero for a first-round failure, which is exactly the "this turn was
   *  free" reading the terminal event goes out of its way never to
   *  produce. */
  const priceRound = (usage: TurnUsage): void => {
    if (!deps.computeCost || costUnknown) return;
    const roundCost = deps.computeCost(usage);
    if (roundCost == null) costUnknown = true;
    else costSoFar += roundCost;
  };

  const turnSignal = deps.signal;
  const wall = new AbortController();
  let wallHit = false;
  const wallTimer = setTimeout(() => {
    wallHit = true;
    wall.abort();
  }, budget.wallClockMs);
  // never hold the process open for a budget nobody is waiting on
  unrefTimer(wallTimer);

  let exit: TurnLoopExit = "internal_error";
  let stopReasonOverride: string | null = null;
  let errorMessage: string | null = null;
  // Set only when a round rejects with a `ProviderError` (chat-completions/
  // errors.ts classifyHttpError, thrown by the driver's HTTP call) — a
  // classified failure gets `error:<code>` as its stopReason and, for
  // invalid_credentials, `setup: true` on the runtime.error chip so a
  // revoked key reaches the setup affordance instead of idling behind a
  // red chip.  An unclassified provider_error (a plain Error) leaves this
  // unset and keeps today's bare "error" stopReason.
  let errorSetup = false;

  const retryDelayScale = deps.retryDelayScale ?? 1;

  /** What a rejected round is worth trying again, or `undefined` for "this
   *  is terminal — classify it and end the turn".
   *
   *  Three classifiers, in order of how much they know.  An error built by
   *  errors.ts's `httpErrorFor` carries its real status and its parsed
   *  `Retry-After`, so the policy is read from the status table directly.
   *  An Undici premature close is a known STRUCTURE rather than a status —
   *  recognised by its cause's code, because its message says nothing any
   *  text rule matches.  Anything else — a `fetch failed`, a socket reset,
   *  a stream that died mid-body — goes through the SAME text classifier
   *  drivers/retry.ts already applies to every CLI engine, so a provider
   *  hiccup is judged the same way on both lanes instead of by a second
   *  private policy. */
  const retryPlanFor = (
    error: Error,
    attempt: number,
  ): { delayMs: number; reason: string; maxAttempts: number } | undefined => {
    const failure = httpFailureOf(error);
    let maxAttempts: number;
    let reason: string;
    let retryAfterMs: number | undefined;
    if (failure) {
      const policy = httpRetryPolicy(failure);
      if (!policy) return undefined;
      ({ maxAttempts, reason, retryAfterMs } = policy);
    } else if (isPrematureCloseError(error)) {
      // A 200 whose socket died before the body finished.  It carries no
      // status for the table above and none of the vocabulary the text
      // classifier below looks for, so without this branch the commonest
      // pre-output disconnect there is would read as terminal and skip the
      // retry it most deserves.  Judged on the shape, not the prose — see
      // errors.ts's `isPrematureCloseError`.
      maxAttempts = RETRY_MAX_ATTEMPTS;
      reason = "connection_reset";
    } else {
      const verdict = classifyError(error);
      if (!verdict.transient) return undefined;
      // A rate limit that reached us as bare text — a driver still
      // throwing `new Error("HTTP 429")` instead of going through
      // `httpErrorFor` — carries no cool-down by definition, so it gets
      // the same one polite retry the parsed no-`Retry-After` 429 gets.
      // The policy must not depend on which driver threw it.
      maxAttempts = verdict.reason === "rate_limited" ? UNHINTED_RATE_LIMIT_ATTEMPTS : RETRY_MAX_ATTEMPTS;
      reason = verdict.reason;
    }
    const ceiling = Math.min(maxAttempts, budget.maxRequestAttempts);
    if (attempt >= ceiling) return undefined;
    // The provider's own cool-down wins over our schedule when it named
    // one — it knows when it will serve us and we do not.
    return { delayMs: retryAfterMs ?? computeBackoff(attempt - 1), reason, maxAttempts: ceiling };
  };

  const emitToolStarted = (call: ChatToolCall) => {
    if (!call.id || announced.has(call.id)) return;
    announced.add(call.id);
    deps.emit({
      ...deps.base(),
      type: "item.started",
      itemType: "tool",
      itemId: call.id,
      title: call.function.name || "tool",
      ...toolFields(call.function.name, parseToolArguments(call.function.arguments)),
      arguments: call.function.arguments,
    });
  };

  /** Run one tool.  Resolves with the outcome the model is told about, and
   *  rejects ONLY when the turn itself is over (interrupt or wall clock) —
   *  a tool that fails or times out is information, not an exit. */
  const runOneTool = async (call: ChatToolCall): Promise<TurnToolOutcome> => {
    const host = deps.toolHost;
    const decoded: TurnToolCall = {
      id: call.id,
      name: call.function.name,
      arguments: decodeArguments(call.function.arguments),
    };
    if (!host) {
      return {
        kind: "error",
        content: `Tool ${decoded.name} is not available on this turn — no tool host was attached.`,
        detail: "no tool host",
      };
    }
    const toolAbort = new AbortController();
    let toolTimedOut = false;
    // One ceiling per TOOL, not one per loop.  90s catches a hung shell
    // command; it also used to cut `ask_bot` off mid-peer-turn, well under
    // the three minutes the fleet documents for a peer reply, and report a
    // timeout for a bot that was still working.  The number lives on the
    // tool definition (registry.ts) so it travels with the behaviour that
    // needs it instead of being a special case here.
    const toolTimeoutMs =
      deps.tools?.find((tool) => tool.name === decoded.name)?.timeoutMs ?? budget.toolTimeoutMs;
    // The per-tool clock, and it PAUSES.  The 90s ceiling is there to catch
    // a call that has hung; a card sitting in front of a person is neither
    // hung nor the model's fault, and killing the tool out from under a
    // human who is still reading would make approvals unusable on this
    // lane.  So the clock stops while a card is open and resumes with the
    // time it had left — the tool gets its full budget of RUNNING time,
    // however long the person took.  The whole-turn wall clock deliberately
    // keeps running: something has to bound a turn nobody ever answers, and
    // the watchdog's stall detector is separately exempted for an open card
    // (`setWaitingOnHuman`), which is what makes this pause safe.
    let remainingMs = toolTimeoutMs;
    let clockStartedAt = now();
    let toolTimer: ReturnType<typeof setTimeout> | null = null;
    const startClock = () => {
      if (toolTimer !== null || toolAbort.signal.aborted) return;
      clockStartedAt = now();
      toolTimer = setTimeout(() => {
        toolTimedOut = true;
        toolAbort.abort();
      }, Math.max(0, remainingMs));
      unrefTimer(toolTimer);
    };
    const stopClock = () => {
      if (toolTimer === null) return;
      clearTimeout(toolTimer);
      toolTimer = null;
      remainingMs = Math.max(0, remainingMs - (now() - clockStartedAt));
    };
    startClock();
    const signal = AbortSignal.any([turnSignal, wall.signal, toolAbort.signal]);
    const race = abortRejection(signal);
    /** The host's channel to a person.  The loop owns the clock semantics;
     *  the broker owns the card.  No broker mounted is fail-closed: the
     *  host reads `"unavailable"` as a deny and the tool never runs. */
    const requestApproval = async (ask: { tool: string; summary: string }): Promise<RequestOutcome> => {
      const broker = deps.requestApproval;
      if (!broker) return "unavailable";
      stopClock();
      try {
        // The tool call's own signal travels with the ask, so an interrupt
        // settles the card instead of leaving one nobody can answer.
        return await broker({ ...ask, signal });
      } finally {
        startClock();
      }
    };
    try {
      return await Promise.race([
        // the contract says a host never throws; this normalises the one
        // that does rather than letting it end the turn
        host
          .execute(decoded, { signal, requestApproval })
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e);
            return { kind: "error", content: `Tool ${decoded.name} failed: ${message}`, detail: message } as TurnToolOutcome;
          }),
        race.promise,
      ]);
    } catch (e) {
      // the turn is over — let the loop settle it
      if (turnSignal.aborted || wallHit) throw e;
      if (toolTimedOut) {
        return {
          kind: "error",
          content: `Tool ${decoded.name} did not finish within ${Math.round(toolTimeoutMs / 1000)}s and was stopped.`,
          detail: "timed out",
        };
      }
      throw e;
    } finally {
      stopClock();
      race.dispose();
    }
  };

  /** Run a round's calls with bounded concurrency.  Outcomes come back in
   *  CALL order regardless of completion order, because the provider must
   *  see its tool results in the order it asked for them. */
  const runToolBatch = async (calls: ChatToolCall[]): Promise<TurnToolOutcome[]> => {
    const outcomes: Array<TurnToolOutcome | undefined> = new Array(calls.length);
    let next = 0;
    let failure: unknown = null;
    const worker = async () => {
      for (;;) {
        const index = next++;
        if (index >= calls.length || failure) return;
        const call = calls[index];
        const outcome = await runOneTool(call);
        outcomes[index] = outcome;
        // AFTER the host returned, carrying the host's real verdict — never
        // ok:true for work the driver did not do.
        const row = {
          ...deps.base(),
          type: "item.completed" as const,
          itemType: "tool" as const,
          itemId: call.id,
          ok: outcome.kind !== "error",
          arguments: call.function.arguments,
        };
        deps.emit(outcome.detail ? { ...row, detail: outcome.detail } : row);
      }
    };
    const lanes = Math.max(1, Math.min(budget.toolConcurrency, calls.length));
    await Promise.all(
      Array.from({ length: lanes }, () =>
        worker().catch((reason: Error) => {
          failure ??= reason;
        }),
      ),
    );
    if (failure) {
      // the turn ended mid-batch: close the chips that never settled so the
      // transcript does not keep a tool row spinning forever
      for (let i = 0; i < calls.length; i++) {
        if (outcomes[i]) continue;
        deps.emit({
          ...deps.base(),
          type: "item.completed",
          itemType: "tool",
          itemId: calls[i].id,
          ok: false,
          detail: "the turn ended before this tool finished",
          arguments: calls[i].function.arguments,
        });
      }
      throw failure;
    }
    // SAFETY: every index was filled above; the only path that leaves a hole
    // throws before this line.
    return outcomes as TurnToolOutcome[];
  };

  try {
    rounds: for (let round = 1; round <= maxRounds; round++) {
      if (turnSignal.aborted) {
        exit = "interrupted";
        break;
      }
      if (wallHit || now() - startedAt >= budget.wallClockMs) {
        exit = "wall_clock";
        break;
      }

      const request = new AbortController();
      let requestTimedOut = false;
      // Which of the round's two clocks fired, for the message only: both
      // are the same `request_timeout` exit.
      let idleTimedOut = false;
      const requestTimer = setTimeout(() => {
        requestTimedOut = true;
        request.abort();
      }, budget.requestTimeoutMs);
      unrefTimer(requestTimer);
      // The idle clock.  Split out of the hard ceiling because one number
      // cannot be both: 180s total cut a slow-but-live reasoning round off
      // mid-answer (grok's 120s fetch timer made it worse, racing this one
      // and ending the round as a provider_error that paged), while a
      // ceiling long enough for that round let a dead socket hold the bot
      // for just as long.  Armed per ATTEMPT (a retry is a new request with
      // a new socket) and disarmed across the backoff between attempts.
      const idleEnabled = Number.isFinite(budget.requestIdleMs) && budget.requestIdleMs > 0;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const disarmIdle = () => {
        if (idleTimer !== null) clearTimeout(idleTimer);
        idleTimer = null;
      };
      const armIdle = () => {
        disarmIdle();
        if (!idleEnabled || request.signal.aborted) return;
        idleTimer = setTimeout(() => {
          idleTimer = null;
          requestTimedOut = true;
          idleTimedOut = true;
          request.abort();
        }, budget.requestIdleMs);
        unrefTimer(idleTimer);
      };
      // Progress from the driver.  A no-op once the attempt is over or the
      // clock has fired, so a straggling chunk can never re-arm a timer for
      // a request that already ended.
      const noteProgress = () => {
        if (idleTimer === null || request.signal.aborted) return;
        if (!refreshTimer(idleTimer)) armIdle();
      };
      // The round's hard deadline, shared by EVERY attempt at it rather
      // than re-armed per try: `requestTimeoutMs` is the most a person will
      // wait for this round's answer, and a fresh ceiling per retry would
      // silently triple it.  It is also the ceiling the retry budget guard
      // measures headroom against.
      const roundDeadline = now() + budget.requestTimeoutMs;
      const roundSignal = AbortSignal.any([turnSignal, wall.signal, request.signal]);
      // Set by the driver through `onPublished` the moment this round puts
      // a delta or a streamed tool call on the bus.  From then on the round
      // can never be retried: the person has already read that text, and a
      // replay would show it to them twice.
      let published = false;
      let result: TurnRoundResult;
      try {
        for (let attempt = 1; ; attempt++) {
          // Latest usage this ATTEMPT reported, kept OUTSIDE the
          // `runRound` promise so a later rejection (timeout, mid-stream
          // provider error) does not take it down too — see the `onUsage`
          // doc on `TurnLoopDeps`.  Boxed in an object: a bare `let` here
          // reads back as `never` under strict mode because TS's flow
          // analysis does not follow the reassignment happening inside the
          // callback closure.
          const roundState: { usage: TurnUsage | null } = { usage: null };
          armIdle();
          try {
            result = await deps.runRound(messages, {
              signal: roundSignal,
              round,
              attempt,
              onPublished: () => {
                published = true;
                noteProgress();
              },
              onChunk: noteProgress,
              onUsage: (usage) => {
                roundState.usage = usage;
              },
            });
            break;
          } catch (e) {
            // this attempt is over; the backoff below is not model silence
            disarmIdle();
            const error = e instanceof Error ? e : new Error(String(e));
            // A retry has to be invisible to be correct.  It is only
            // considered when the turn is still live (an interrupt, the
            // wall clock and the round's own deadline each mean stop, not
            // try again), when nothing reached the bus, and when the
            // attempt reported no usage — the last is what keeps
            // "usage from a failed attempt is not summed" true by
            // construction rather than by throwing tokens away: an
            // attempt that got far enough to be billed is one we settle
            // and account for, never one we silently redo.
            const live = !turnSignal.aborted && !wallHit && !requestTimedOut;
            const plan = live && !published && !roundState.usage ? retryPlanFor(error, attempt) : undefined;
            if (plan) {
              // Headroom on the tighter of the two clocks.  Declining here
              // is deliberate: failing now with the provider's real error
              // beats sleeping into a deadline that was already visible.
              const left = Math.min(roundDeadline, startedAt + budget.wallClockMs) - now();
              if (plan.delayMs + RETRY_HEADROOM_MS <= left) {
                // One observability line per retry — the same event every
                // CLI driver already emits, so an HTTP retry is treated
                // exactly as a Claude or Codex one is: the routine receipt
                // stays quiet and keeps the run running, the Sentry span
                // takes a warning breadcrumb, and index.ts renders its
                // standard "retrying — attempt N/3" ACTIVITY chip so the
                // bot stays visibly busy through the backoff instead of
                // looking hung.  No assistant text, no runtime.error, no
                // second terminal event: the turn has not failed yet.
                deps.emit({
                  ...deps.base(),
                  type: "turn.retrying",
                  attempt,
                  delayMs: plan.delayMs,
                  reason: plan.reason,
                  // THIS failure's own ceiling, not the global one: a 429
                  // with no cool-down is worth two attempts, and a chip
                  // reading "attempt 2/3" right before the turn fails
                  // after attempt 2 promises a try that is never coming.
                  maxAttempts: plan.maxAttempts,
                });
                // Abort-aware: Stop, a sweep or the round deadline during
                // the wait resolves it at once, and the classification
                // below then names the real exit instead of launching an
                // attempt nobody is waiting for any more.
                const wait = interruptibleDelay(Math.max(1, Math.round(plan.delayMs * retryDelayScale)), roundSignal);
                const outcome = await wait.promise;
                if (outcome === "elapsed" && !roundSignal.aborted) continue;
              }
            }
            if (roundState.usage) {
              sawUsage = true;
              totals.input += roundState.usage.input;
              totals.output += roundState.usage.output;
              const cached = roundState.usage.cachedInput;
              if (cached !== undefined) totals.cachedInput = (totals.cachedInput ?? 0) + cached;
              // These tokens are in `totals`, so they must be in `costSoFar`
              // too — see priceRound's own comment.
              priceRound(roundState.usage);
            }
            if (turnSignal.aborted) exit = "interrupted";
            else if (wallHit) {
              exit = "wall_clock";
              errorMessage = `the turn ran past its ${Math.round(budget.wallClockMs / 1000)}s budget and was stopped`;
            } else if (requestTimedOut) {
              exit = "request_timeout";
              // Both wordings keep the "the model did not answer within"
              // prefix sentry-ai.ts files as an expected timeout rather
              // than a crash.
              errorMessage = idleTimedOut
                ? `the model did not answer within ${Math.round(budget.requestIdleMs / 1000)}s — the stream went silent`
                : `the model did not answer within ${Math.round(budget.requestTimeoutMs / 1000)}s`;
            } else {
              exit = "provider_error";
              errorMessage = error.message;
              if (error instanceof ProviderError) {
                stopReasonOverride = `error:${error.code}`;
                errorSetup = error.code === "invalid_credentials";
              }
            }
            break rounds;
          }
        }
      } finally {
        clearTimeout(requestTimer);
        disarmIdle();
      }

      if (result.usage) {
        sawUsage = true;
        totals.input += result.usage.input;
        totals.output += result.usage.output;
        const cached = result.usage.cachedInput;
        if (cached !== undefined) totals.cachedInput = (totals.cachedInput ?? 0) + cached;
        // Priced from THIS round's own usage, never the running `totals`
        // — a size-tiered model must see this request's own size, not the
        // turn's cumulative size, or a multi-round turn gets billed as if
        // every round were one giant request.
        priceRound(result.usage);
        // Cumulative, never per-round: this event is a LIVE INDICATOR whose
        // meaning differs per driver and which consumers are told never to
        // sum.  The terminal event carries the authoritative figure.
        const live = { ...deps.base(), type: "thread.token-usage.updated" as const };
        deps.emit(
          totals.cachedInput === undefined
            ? { ...live, input: totals.input, output: totals.output }
            : { ...live, input: totals.input, output: totals.output, cachedInput: totals.cachedInput },
        );
      }
      if (result.text.trim()) {
        deps.emit({ ...deps.base(), type: "item.completed", itemType: "assistant_text", text: result.text });
      }

      const calls = (result.toolCalls ?? []).filter((call) => call.id);
      if (calls.length === 0) {
        exit = "settled";
        break;
      }

      // The prefix the provider already saw is never rewritten — only
      // appended to — which is what keeps prompt caching reachable and what
      // removed the duplicate-replay bug the transcript rebuild had.
      messages.push({ role: "assistant", content: result.text ?? "", tool_calls: calls });

      if (round === maxRounds) {
        for (const call of calls) {
          emitToolStarted(call);
          deps.emit({
            ...deps.base(),
            type: "item.completed",
            itemType: "tool",
            itemId: call.id,
            ok: false,
            detail: `the turn hit its ${maxRounds}-round limit before this tool ran`,
            arguments: call.function.arguments,
          });
        }
        exit = "tool_round_limit";
        errorMessage = `the turn used all ${maxRounds} tool rounds and was stopped`;
        break;
      }

      for (const call of calls) emitToolStarted(call);
      const outcomes = await runToolBatch(calls);
      for (let i = 0; i < calls.length; i++) {
        messages.push({ role: "tool", tool_call_id: calls[i].id, content: outcomes[i].content });
      }

      const suspended = outcomes.find((outcome) => outcome.kind === "suspend");
      if (suspended && suspended.kind === "suspend") {
        exit = "suspended";
        stopReasonOverride = suspended.stopReason;
        break;
      }
    }
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    if (turnSignal.aborted) exit = "interrupted";
    else if (wallHit) {
      exit = "wall_clock";
      errorMessage = `the turn ran past its ${Math.round(budget.wallClockMs / 1000)}s budget and was stopped`;
    } else {
      exit = "internal_error";
      errorMessage = error.message;
    }
  } finally {
    clearTimeout(wallTimer);
    // Drop the driver's active entry BEFORE the terminal event: the fold
    // that handles turn.completed drains queued sends synchronously, and a
    // fresh dispatch must not find this thread still busy.
    deps.onSettled?.(exit);
    // An interrupt is not an error — every other non-ok exit gets a chip
    // saying what happened, because "the bot went idle for no stated
    // reason" is the failure mode this whole file exists to end.
    if (errorMessage && exit !== "interrupted") {
      deps.emit({
        ...deps.base(),
        type: "runtime.error",
        message: errorMessage,
        ...(errorSetup ? { setup: true } : {}),
      });
    }
    const completed = {
      ...deps.base(),
      type: "turn.completed" as const,
      ok: TERMINAL_OK[exit],
      stopReason: stopReasonOverride ?? STOP_REASON[exit],
      // Summed from each round's OWN cost as it happened (see computeCost's
      // comment for why this is not `deps.computeCost?.(totals)`), on the
      // success path and every error path alike — a hard-coded 0 would
      // read as "this turn was free", and a partial sum would read as a
      // real total when some round's cost was actually unknown.
      cost: !deps.computeCost || !sawUsage || costUnknown ? null : costSoFar,
    };
    // The one terminal event.  Nothing else in this file emits this type.
    deps.emit(sawUsage ? { ...completed, usage: { ...totals } } : completed);
  }

  return exit;
}
