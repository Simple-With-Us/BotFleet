// One computer call waits here while its desktop is busy, then answers in
// words that keep the turn going.  A turn told to pause has no tool to
// pause with, so ending the turn on a hold meant nothing resumed it.
//
// BotFleet claims a Local VM or VPS at turn start and will not mount a
// second bridge onto a desktop another turn already owns.  The wait that
// is safe inside a call is the one this turn already holds: a person at
// the screen, or a seat this call was told is contended.  The harness GET
// blocks; the bridge's control client outlasts that wait.

import {
  CONTROL_ACT_WITHIN_MS,
  CONTROL_BUSY,
  CONTROL_HANDED_BACK,
  CONTROL_WAIT_MS,
  CONTROL_WAITED,
  type ControlState,
} from "./control-client.ts";

/** The longest any turn waits for a person who has the computer.  Past it
 * the call is not waited for: the turn is told to stop and say so. */
export const COMPUTER_WAIT_MAX_MS = 30 * 60 * 1000;
const COMPUTER_CALL_POLL_MS = 250;

export interface ComputerCallSnapshot {
  held: boolean;
  helpReason: string | null;
  heldSinceMs: number | null;
}

export function computerPersonAwayText(ceilingMs: number): string {
  const minutes = Math.max(1, Math.round(ceilingMs / 60_000));
  const unit = minutes === 1 ? "minute" : "minutes";
  return (
    `A person has had control of this computer for over ${minutes} ${unit}, so this call was NOT performed and this turn stops waiting for them.  ` +
    "Pause this task: tell the person you are waiting for them to hand control back, and take a fresh screenshot before your next action once they have."
  );
}

function bounded(value: number, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) && value > 0 ? value : fallback));
}

/** Read at call time so a test can shorten the wait without restarting. */
export function computerCallWaitMs(override?: number): number {
  if (override !== undefined) return bounded(override, CONTROL_WAIT_MS, 500, CONTROL_WAIT_MS);
  return bounded(Number(process.env.OMB_COMPUTER_CALL_WAIT_MS), CONTROL_WAIT_MS, 500, CONTROL_WAIT_MS);
}

export function computerCallActWithinMs(override?: number): number {
  if (override !== undefined) return bounded(override, CONTROL_ACT_WITHIN_MS, 100, CONTROL_ACT_WITHIN_MS);
  return bounded(Number(process.env.OMB_COMPUTER_CALL_ACT_WITHIN_MS), CONTROL_ACT_WITHIN_MS, 100, CONTROL_ACT_WITHIN_MS);
}

export function computerPersonAwayMs(override?: number): number {
  if (override !== undefined) return Math.max(1, override);
  const fromEnv = Number(process.env.OMB_COMPUTER_WAIT_MAX_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : COMPUTER_WAIT_MAX_MS;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    if (signal?.aborted) done();
    else signal?.addEventListener("abort", done, { once: true });
  });
}

/** May this computer call act now?  `contended` is for a seat another
 * thread holds; the harness leaves it unset unless it can name that seat
 * without the owner's own bridge waiting on itself. */
export async function waitForComputerCall(input: {
  snapshot: () => ComputerCallSnapshot;
  contended?: () => boolean;
  active?: () => boolean;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  waitMs?: number;
  actWithinMs?: number;
  personAwayMs?: number;
}): Promise<ControlState> {
  const now = input.now ?? Date.now;
  const wait = input.sleep ?? sleep;
  const askedAt = now();
  const deadline = askedAt + computerCallWaitMs(input.waitMs);
  const actWithinMs = computerCallActWithinMs(input.actWithinMs);
  const personAwayMs = computerPersonAwayMs(input.personAwayMs);
  let personHeld = false;

  for (;;) {
    const snapshot = input.snapshot();
    const helpOpen = snapshot.helpReason !== null;
    const active = input.active?.() !== false;
    if (
      snapshot.held &&
      snapshot.heldSinceMs !== null &&
      now() - snapshot.heldSinceMs >= personAwayMs
    ) {
      return { held: true, helpOpen, blockedReason: computerPersonAwayText(personAwayMs) };
    }
    let held: ControlState;
    if (!active && !snapshot.held && !input.contended?.()) {
      return {
        held: true,
        helpOpen,
        blockedReason: "This turn no longer has this computer, so this call was not performed.",
      };
    } else if (snapshot.held) {
      personHeld = true;
      held = { held: true, helpOpen, reason: "person" };
    } else if (input.contended?.()) {
      held = { held: true, helpOpen: false, blockedReason: CONTROL_BUSY };
    } else if (personHeld) {
      return { held: true, helpOpen, blockedReason: CONTROL_HANDED_BACK };
    } else {
      return now() - askedAt > actWithinMs
        ? { held: true, helpOpen, blockedReason: CONTROL_WAITED }
        : { held: false, helpOpen };
    }
    if (now() >= deadline || input.signal?.aborted || input.active?.() === false) return held;
    await wait(Math.min(COMPUTER_CALL_POLL_MS, deadline - now()), input.signal);
  }
}
