// The proxy-side half of computer control.  The harness keeps the record of
// who is driving (server/computer-control.ts); the per-turn computer
// processes consult it through this client before acting, because the
// action paths themselves never traverse the harness — a box click goes
// straight to the box's REST API, and a Local VM / VPS click rides a
// transparent stdio bridge into CUA Driver.
//
// Failure posture: CLOSED when configured.  A harness hiccup must not let
// the bot keep driving.  The text of that failure is that the computer
// could not be confirmed free.  It is never "a person has taken control".
// That sentence is reserved for a harness answer with reason "person".
// An unconfigured client remains disengaged because there is no control
// surface to consult.
//
// A busy computer is waited for by the harness, inside one check (up to
// CONTROL_WAIT_MS), so this client waits longer than that.  Giving up
// first is how a slow but honest answer became "a person took control".
//
// The state is cached briefly so a computer_batch of two dozen actions
// doesn't turn into two dozen loopback round trips.

/** The longest the harness holds one check open while the computer is busy
 * — a person driving, another thread named as contended — before it
 * answers.  One computer call waits this long, so a busy desktop costs the
 * model one slow call instead of a refusal that ends its turn.  Under the
 * 60 seconds an engine may give one tool call, with room for the action. */
export const CONTROL_WAIT_MS = 45_000;
/** A call acts only when it got its computer within this of being made.
 * One that waited longer is not performed (CONTROL_WAITED) and the model
 * calls again.  An action started late could outlive a call the engine
 * already gave up on and retried, and happen twice.  The harness counts
 * its own wait; a bridge counts from the moment the call reached it. */
export const CONTROL_ACT_WITHIN_MS = 5_000;
/** Past the harness's longest answer: a check it is still legitimately
 * holding must never be cut off and misread. */
const READ_TIMEOUT_MS = CONTROL_WAIT_MS + 10_000;
const WAIT_WORDS = `${CONTROL_WAIT_MS / 1000} seconds`;

/** What a refused call tells the model while a person holds the computer —
 * and only then.  The harness marks that hold `reason: "person"`. */
export const CONTROL_REFUSAL_PLAIN =
  "A person has taken control of this computer, so this call was NOT performed.  " +
  "Do not act until they hand it back — the screen is changing under their hands.  " +
  `To wait for them, take a screenshot: each computer call waits up to ${WAIT_WORDS} and returns as soon as they hand control back.  ` +
  "Meanwhile you may work on anything that does not need this computer.";

/** A call that waited through a person's hold.  Not forwarded even now:
 * it was composed before their hands moved the screen, and a queued click
 * must never land on whatever is under it after they moved on. */
export const CONTROL_HANDED_BACK =
  "The person has handed this computer back.  This call was NOT performed — the screen may have changed while they had it.  " +
  "Take a fresh screenshot, then continue the task.";

/** The computer came free, but only after this call had waited for it past
 * CONTROL_ACT_WITHIN_MS. */
export const CONTROL_WAITED =
  "This computer is free now, but this call had to wait for it, so it was NOT performed.  " +
  "Call again: the next call goes through at once.  If you meant to click or type from an earlier screenshot, take a fresh one first — the screen may have changed while you waited.";

/** Another turn has the computer and this one is in line for it. */
export const CONTROL_BUSY =
  "Another thread is using this computer.  This call was not performed.  This turn gets the computer as soon as it is free: " +
  `to keep waiting, take a screenshot (each computer call waits up to ${WAIT_WORDS}) instead of ending your turn.`;

/** The check itself failed: timed out, refused, or answered nonsense. */
export const CONTROL_UNCONFIRMED =
  "BotFleet could not confirm that this computer is free, so this call was NOT performed and nothing happened on the screen.  " +
  "Retry in a few seconds.";

export interface ControlState {
  /** This call must not act now; the model is told why (controlRefusal). */
  held: boolean;
  /** A help request the person has neither answered nor dismissed. */
  helpOpen: boolean;
  /** "person" only when the harness says a person holds the computer. */
  reason?: "person";
  /** Any other hold, in the harness's (or this client's) own words. */
  blockedReason?: string;
}

export interface ControlClient {
  /** Current state, cached for `cacheMs`.  `fresh` bypasses the cache.
   * Every gated tools/call asks fresh, and may be held open by the harness
   * for up to CONTROL_WAIT_MS while the computer is busy. */
  state(fresh?: boolean): Promise<ControlState>;
  /** Surface the bot's plea in the app.  Returns its expiry id, or null when
   * the harness could not be told. */
  requestHelp(reason: string): Promise<string | null>;
  /** Close only the unanswered plea opened by this client. */
  expireHelp(requestId: string): Promise<void>;
  readonly configured: boolean;
}

const DISENGAGED: ControlState = { held: false, helpOpen: false };
const UNCONFIRMED: ControlState = { held: true, helpOpen: false, blockedReason: CONTROL_UNCONFIRMED };

/** The text a held state hands the model. */
export function controlRefusal(state: Pick<ControlState, "reason" | "blockedReason">): string {
  return state.blockedReason ?? (state.reason === "person" ? CONTROL_REFUSAL_PLAIN : CONTROL_UNCONFIRMED);
}

export function createControlClient(options?: {
  url?: string;
  token?: string;
  cacheMs?: number;
  /** How long one check may take.  Tests shorten it. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): ControlClient {
  const url = options?.url ?? process.env.OMB_CONTROL_URL ?? "";
  const token = options?.token ?? process.env.OMB_CONTROL_TOKEN ?? "";
  const cacheMs = options?.cacheMs ?? 750;
  const timeoutMs = options?.timeoutMs ?? READ_TIMEOUT_MS;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const configured = Boolean(url && token);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  let cachedAt = 0;
  let cached: ControlState = DISENGAGED;

  async function read(): Promise<ControlState> {
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return UNCONFIRMED;
      const body: any = await res.json().catch(() => null);
      if (typeof body?.held !== "boolean" || typeof body?.helpOpen !== "boolean") return UNCONFIRMED;
      return {
        held: body.held,
        helpOpen: body.helpOpen,
        ...(body.reason === "person" ? { reason: "person" as const } : {}),
        ...(typeof body.blockedReason === "string" && body.blockedReason.trim()
          ? { blockedReason: body.blockedReason }
          : {}),
      };
    } catch {
      return UNCONFIRMED;
    }
  }

  return {
    configured,
    async state(fresh = false): Promise<ControlState> {
      if (!configured) return DISENGAGED;
      const now = Date.now();
      if (!fresh && now - cachedAt < cacheMs) return cached;
      cached = await read();
      cachedAt = Date.now();
      return cached;
    },
    async requestHelp(reason: string): Promise<string | null> {
      if (!configured) return null;
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ reason }),
          signal: AbortSignal.timeout(2_000),
        });
        if (!res.ok) return null;
        const body: any = await res.json().catch(() => null);
        return typeof body?.requestId === "string" && body.requestId ? body.requestId : null;
      } catch {
        return null;
      }
    },
    async expireHelp(requestId: string): Promise<void> {
      if (!configured || !requestId) return;
      try {
        await fetchImpl(url, {
          method: "DELETE",
          headers,
          body: JSON.stringify({ requestId }),
          signal: AbortSignal.timeout(2_000),
        });
      } catch {
        // Best effort: the harness also clears the in-memory request on
        // release/restart, and an unavailable harness cannot show the card.
      }
    },
  };
}
