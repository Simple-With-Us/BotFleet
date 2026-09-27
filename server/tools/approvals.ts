// The harness's in-process permission broker.
//
// WHY THIS FILE EXISTS.  Approvals on the CLI lane are a round trip through
// the engine: the agent emits `request.opened`, the harness folds it into a
// card (or answers it from auto mode), and the person's verdict goes back
// through `adapter.respondToRequest`.  Everything that makes that trip
// trustworthy — auto-approve, always-allow, the destructive and sensitive
// guards, the unattended block, auto-review, the decision log, the
// notification, the watchdog's waiting-on-human exemption — hangs off those
// two events and nothing else.
//
// The HTTP lane had no such round trip.  A chat-completions driver runs its
// own tool rounds in-process, so there was no engine to ask and no
// `request.opened` to fold: a MiniMax bot simply ran whatever the model
// asked for.  This broker is the missing half.  It publishes a REAL
// `request.opened` on the same bus and returns a promise that settles when
// the answer comes back, so every one of those behaviours applies to an
// HTTP bot for the first time — not by reimplementing them here, but by
// reaching the exact fold the CLI lane already reaches.
//
// Three rules hold this together:
//
//   1. ONE indirection at resolution.  `respond()` returns `null` for every
//      requestId this broker does not own, and the caller falls through to
//      `adapter.respondToRequest`.  A CLI request therefore takes the path
//      it always took, byte for byte.
//   2. Every ask settles EXACTLY once.  Approve, deny, interrupt, turn
//      teardown, dispose — whichever arrives first wins and the rest are
//      no-ops.  A pending ask that never settles is a hung turn and an
//      un-answerable card, which is the failure this file is most careful
//      about.
//   3. An abandoned ask is a DENY.  `"unavailable"` means the action never
//      ran, so a stopped turn can never leave behind an approval nobody
//      gave.  Fail-closed is the only safe direction here.

import { newId, type DriverKind, type RequestOutcome, type RuntimeEvent } from "../contracts.ts";

/** Who answered, in the vocabulary `request.resolved` already speaks.  The
 *  fold reads this to decide whether the card shows as clicked by a person
 *  (`"user"`) or quietly dismissed (everything else), so an auto-approval
 *  must not arrive labelled as a human's click. */
export type ApprovalAnswerSource = "user" | "auto" | "peer" | "system";

/** Everything `request.resolved` may say about who decided.  A superset of
 *  `ApprovalAnswerSource`: only the broker itself can report `"unavailable"`
 *  (nobody answered) or `"timeout"`. */
type ResolvedSource = "user" | "auto" | "timeout" | "system" | "unavailable" | "peer";

export interface ApprovalAnswer {
  behavior: "allow" | "deny" | "answer";
  message?: string;
  /** Defaults to `"user"` — the overwhelming majority of answers, and the
   *  one where guessing wrong would put words in a person's mouth. */
  source?: ApprovalAnswerSource;
}

/** Why a pending ask was abandoned.  Recorded only in the log line; all
 *  three settle the ask identically, as `"unavailable"`. */
export type AbandonReason = "interrupted" | "teardown" | "disposed";

export interface ApprovalAsk {
  threadId: string;
  /** The bot whose turn this is.  Baked in by the host at dispatch, never
   *  read from the model's arguments. */
  botId: string;
  provider: DriverKind;
  providerInstanceId?: string;
  tool: string;
  summary: string;
  approvalScope?: "local-computer" | "disposable-computer";
  /** The tool call's own abort signal.  When the turn is interrupted, swept
   *  or torn down this fires, and the ask settles `"unavailable"` rather
   *  than leaving a promise nothing can ever resolve. */
  signal?: AbortSignal;
}

export interface PermissionBroker {
  /** Open a card and wait for the verdict.  Resolves `"allowed-once"` only
   *  when somebody actually allowed it; every other exit is a deny. */
  request(ask: ApprovalAsk): Promise<RequestOutcome>;
  /** Answer an open ask.  `null` means this broker does not own the
   *  request — the caller must fall through to the engine's adapter.  This
   *  is the ONE indirection the whole design gets. */
  respond(threadId: string, requestId: string, answer: ApprovalAnswer): RequestOutcome | null;
  /** Settle every ask open on this thread as `"unavailable"`.  Returns how
   *  many there were, so a caller can log a stopped turn honestly. */
  abandonThread(threadId: string, reason: AbandonReason): number;
  /** Same, for every thread — the fleet is being disposed. */
  abandonAll(reason: AbandonReason): number;
  /** How many asks are open right now.  A test seam and a leak detector:
   *  this must be 0 once every turn has settled. */
  pending(): number;
  /** Whether this exact ask is open.  Test seam. */
  isOpen(threadId: string, requestId: string): boolean;
}

export interface PermissionBrokerDeps {
  /** Where `request.opened` and `request.resolved` go.  The real one is
   *  `bus.publish`; a test passes a recorder. */
  publish(event: RuntimeEvent): void;
  /** Id factories, overridable so a test can assert on stable ids. */
  newRequestId?: () => string;
  newEventId?: () => string;
  now?: () => Date;
}

interface OpenAsk {
  threadId: string;
  requestId: string;
  botId: string;
  tool: string;
  settle(outcome: RequestOutcome, behavior: "allow" | "deny" | "answer", source: ResolvedSource): void;
}

/** An answer's outcome, in the vocabulary the tool host reads back.  Only
 *  `allow` is an approval; `answer` is conversation, not authorization, and
 *  a permission ask that somehow receives one is not thereby granted. */
function outcomeFor(behavior: "allow" | "deny" | "answer"): RequestOutcome {
  if (behavior === "allow") return "allowed-once";
  if (behavior === "answer") return "answered";
  return "rejected";
}

export function createPermissionBroker(deps: PermissionBrokerDeps): PermissionBroker {
  const open = new Map<string, OpenAsk>();
  const newRequestId = deps.newRequestId ?? newId;
  const newEventId = deps.newEventId ?? newId;
  const now = deps.now ?? (() => new Date());
  const keyOf = (threadId: string, requestId: string) => `${threadId}:${requestId}`;

  const abandon = (asks: OpenAsk[], reason: AbandonReason): number => {
    for (const ask of asks) {
      // A deny, from nobody: the tool is told the action never ran, and the
      // card is dismissed rather than left open over a turn that is gone.
      ask.settle("unavailable", "deny", "unavailable");
    }
    if (asks.length > 0) {
      console.error(
        `approvals: settled ${asks.length} pending ask(s) as unavailable (${reason}) — ${asks
          .map((ask) => `${ask.tool}@${ask.threadId.slice(0, 8)}`)
          .join(", ")}`,
      );
    }
    return asks.length;
  };

  return {
    request(ask: ApprovalAsk): Promise<RequestOutcome> {
      // Fail closed before anything is published: a turn that is already
      // over must not put a card in front of a person.
      if (ask.signal?.aborted) return Promise.resolve<RequestOutcome>("unavailable");
      const requestId = newRequestId();
      const key = keyOf(ask.threadId, requestId);
      return new Promise<RequestOutcome>((resolve) => {
        let settled = false;
        let detach: () => void = () => undefined;
        const settle = (
          outcome: RequestOutcome,
          behavior: "allow" | "deny" | "answer",
          source: ResolvedSource,
        ) => {
          if (settled) return;
          settled = true;
          open.delete(key);
          detach();
          // Published on EVERY exit, answered or abandoned.  The watchdog
          // clears waiting-on-human from this event, the fold marks the
          // card answered from it, and the bot goes back to "working" from
          // it — an exit that skipped it would strand all three.
          deps.publish({
            eventId: newEventId(),
            provider: ask.provider,
            providerInstanceId: ask.providerInstanceId,
            threadId: ask.threadId,
            createdAt: now().toISOString(),
            requestId,
            type: "request.resolved",
            behavior,
            source,
          });
          resolve(outcome);
        };
        const onAbort = () => settle("unavailable", "deny", "unavailable");
        if (ask.signal) {
          ask.signal.addEventListener("abort", onAbort, { once: true });
          detach = () => ask.signal?.removeEventListener("abort", onAbort);
        }
        // Registered BEFORE the event goes out: the fold runs synchronously
        // on publish, and auto mode can answer this ask inside the very
        // call below.  A broker that registered afterwards would hand that
        // answer to nobody.
        open.set(key, { threadId: ask.threadId, requestId, botId: ask.botId, tool: ask.tool, settle });
        deps.publish({
          eventId: newEventId(),
          provider: ask.provider,
          providerInstanceId: ask.providerInstanceId,
          threadId: ask.threadId,
          createdAt: now().toISOString(),
          requestId,
          type: "request.opened",
          requestType: "permission",
          tool: ask.tool,
          summary: ask.summary,
          approvalScope: ask.approvalScope,
        });
      });
    },

    respond(threadId, requestId, answer): RequestOutcome | null {
      const ask = open.get(keyOf(threadId, requestId));
      // Not ours.  Every CLI engine's requestId lands here, and the caller
      // falls through to that engine's adapter — which is exactly why the
      // CLI approval path needed no changes at all.
      if (!ask) return null;
      const outcome = outcomeFor(answer.behavior);
      ask.settle(outcome, answer.behavior, answer.source ?? "user");
      return outcome;
    },

    abandonThread(threadId, reason) {
      return abandon(
        [...open.values()].filter((ask) => ask.threadId === threadId),
        reason,
      );
    },

    abandonAll(reason) {
      return abandon([...open.values()], reason);
    },

    pending() {
      return open.size;
    },

    isOpen(threadId, requestId) {
      return open.has(keyOf(threadId, requestId));
    },
  };
}
