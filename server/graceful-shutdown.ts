// Stopping the bots that are working, the way the owner asked, and then
// letting the server go down.
//
// The refusal is right as far as it goes.  The server refuses to stop while
// work is in flight, and the Control app reports the refusal and leaves
// everything running (BF-2535 made the refusal say what is blocking it).  But
// the owner asked for the opposite of a refusal:  after the warning and the
// explicit confirmation, the bots that are working are stopped and the server
// then shuts down.
//
// Three things have to be true for that to be safe, and each one is a reason
// this file exists rather than a paragraph in the route:
//
//   * The stop is bounded.  The bots get a window to finish on their own, and
//     a wait with no end is a hang.  When the window closes the server shuts
//     down anyway and says what it could not finish.
//
//   * The work is not left half-written.  The bots that are still working when
//     the window closes are stopped by the harness's own shutdown, which
//     interrupts them the way it always has and records them for the next
//     boot.  The messages queued behind them are carried across the restart
//     by the same carrier the update drain parks work in, so they run the
//     next time the harness comes up.  This file uses those rather than
//     racing them.
//
//   * The report is honest.  Which bots had already finished, which were still
//     working and are being stopped, and what was still running when the
//     window closed.
//
// This file does not interrupt anything itself.  `interruptBot` carries the
// Stop button's meaning:  it cancels the bot's routine runs and snoozes its
// automation, which is right for a person pressing Stop and wrong for a
// server going down.  The harness's own shutdown already knows how to end a
// turn without losing it, and it is the one place that does.
//
// The dependencies are injected, the way reserveSystemShutdown takes them, so
// the sequence can be exercised without a running server.  Nothing here reads
// the store, the filesystem or the network.
import { shutdownRefusal, type BlockingWork } from "./system-control.ts";

/** A bot that is mid-turn. */
export interface GracefulStopBot {
  id: string;
  /** The name a person knows the bot by. */
  name: string;
}

/** What a graceful stop did, in the words the owner reads. */
export interface GracefulStopReport {
  /** Bots that had finished by the time the stop reached them. */
  finished: string[];
  /** Bots that were still working and that the shutdown stops.  Their queued
   *  messages are carried across the restart, and their turn is recorded for
   *  the next boot, so nothing is lost. */
  interrupted: string[];
  /** What was still running when the window closed, named.  The bots still
   *  working are not here:  they are named one by one in `interrupted`. */
  leftRunning: string[];
  /** False when the server must stay up. */
  ok: boolean;
  /** Why the server must stay up, when it must. */
  refusal?: string;
}

export interface GracefulStopOptions {
  /** The bots that are mid-turn right now. */
  busyBots(): GracefulStopBot[];
  /** Work in flight, counted the way the updater counts it:  the work that is
   *  held (queued messages, queued room rounds, queued routine runs) is not
   *  in flight, because it survives the restart or is carried across it. */
  activeWorkCount(): number;
  /** The kinds of work in flight, for a report the owner can act on. */
  blockingWork(): BlockingWork[];
  /** Carry the work that was queued behind the stopped bots across the
   *  restart.  The bots that are being stopped are named, so their queued
   *  sends can be carried uncommitted:  their own turn resumes first at the
   *  next boot.  False when the work could not be saved, which refuses the
   *  stop:  the server stays up rather than losing the messages. */
  parkHeldWork(interrupted: ReadonlySet<string>): boolean;
  /** How long the bots get to finish on their own. */
  deadlineMs: number;
  /** How often the wait re-reads the count. */
  pollMs?: number;
  /** Wait, injected so a fixture does not wait in real time. */
  sleep?(ms: number): Promise<void>;
  /** The clock, injected so a fixture does not depend on the wall clock. */
  now?(): number;
  /** Called when the stop fails with an exception, so the caller can put its
   *  fence back down.
   *
   *  The caller fences the server while the stop runs, and a fence that stays
   *  up after a failure refuses every route of a server that is still running.
   *  The hook is the one place that knows how to lower it, so the two fences
   *  in this server cannot drift apart. */
  onFailure?(): void;
}

/** The work in flight, by kind:  the counters the stop waits on.
 *
 *  A named contract rather than a bare `Record<string, number>`:  the lint
 *  ratchet treats an open dictionary annotation as throwing away known type
 *  evidence, and a named owner keeps the index signature while saying what
 *  the counts hold. */
export interface WorkCounts {
  readonly [kind: string]: number;
}

/** The kind of work the control lock is counted as.
 *
 *  The stop's own fence takes the control lock, and the control lock is
 *  counted as a Local VM change in flight.  It is the stop's own reservation
 *  rather than work in flight, so counting it would mean the work in flight
 *  never reached zero and every stop would wait out the whole window instead
 *  of ending as soon as the bots are done. */
const OWN_CONTROL_LOCK_KIND = "localVmChanges";

/** The work in flight, less the stop's own control lock.
 *
 *  The stop takes the control lock when it fences the server, and that lock
 *  is one of the counters of work in flight.  The lock belongs to the stop,
 *  so it is not work the stop has to wait for:  without this the wait always
 *  ran out the whole window, because the count it watched could never reach
 *  zero. */
export function withoutOwnControlLock(counts: WorkCounts, ownControlLock: boolean): WorkCounts {
  if (!ownControlLock) return counts;
  const held = counts[OWN_CONTROL_LOCK_KIND];
  // A kind that is not counted at all holds nothing to discount, and a count
  // that is not a number is not a count:  neither is a reason to change one.
  if (!Number.isFinite(held) || held <= 0) return counts;
  return { ...counts, [OWN_CONTROL_LOCK_KIND]: held - 1 };
}

/**
 * Let the bots that are working finish what they are doing, and report it.
 *
 * The bots are given a window rather than stopped on the spot:  a turn that
 * ends on its own is finished work, while a turn that is interrupted is work
 * the next boot has to pick up again.  The window is a bound and not a
 * promise:  when it closes the server shuts down anyway and the report names
 * what did not finish.
 *
 * The bots that are still working when the window closes are stopped by the
 * shutdown itself, which interrupts them cleanly and records them for the
 * next boot.  This file does not interrupt anything:  the harness's shutdown
 * already knows how to end a turn without losing it, and it is the one place
 * that does.
 */
export async function gracefulStop(options: GracefulStopOptions): Promise<GracefulStopReport> {
  try {
    return await settleTheBots(options);
  } catch (error) {
    // The caller's fence is up while the stop runs, and a fence that stays up
    // after a failure refuses every route of a server that is still running.
    // The caller is told to lower it before the error travels on.
    options.onFailure?.();
    throw error;
  }
}

/** The stop itself:  let the bots finish, carry the work across, report it. */
async function settleTheBots(options: GracefulStopOptions): Promise<GracefulStopReport> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const pollMs = options.pollMs ?? 250;
  const deadline = now() + options.deadlineMs;

  const working = options.busyBots();

  // The window:  the work in flight gets until the deadline to settle.  The
  // first check is immediate, because a bot whose turn already ended needs no
  // wait at all.
  while (options.activeWorkCount() > 0 && now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }

  const stillWorking = options.busyBots();
  const finished = working.filter((bot) => !stillWorking.some((entry) => entry.id === bot.id)).map((bot) => bot.name);
  const interrupted = stillWorking.map((bot) => bot.name);

  // The messages that were queued behind the bots that are being stopped are
  // carried across the restart.  When they cannot be saved the stop is
  // refused:  the server stays up rather than losing them.
  if (!options.parkHeldWork(new Set(stillWorking.map((bot) => bot.id)))) {
    return {
      ok: false,
      finished,
      // Nothing was stopped:  the server stays up, so the bots that were
      // still working are still working.  Saying they were stopped would be a
      // lie, and this report is what the owner reads.
      interrupted: [],
      // They are named as what is still running instead.
      leftRunning: stillWorking.length
        ? [`${stillWorking.length} bot turn${stillWorking.length === 1 ? "" : "s"}`]
        : [],
      refusal: "the messages waiting behind the stopped bots could not be saved, so the server stays up rather than losing them",
    };
  }

  // What is still running when the window closed is named rather than hidden.
  const leftRunning: string[] = [];
  for (const entry of options.blockingWork()) {
    if (entry.count <= 0) continue;
    leftRunning.push(`${entry.count} ${entry.label}${entry.count === 1 ? "" : "s"}`);
  }

  return { ok: true, finished, interrupted, leftRunning };
}

/** The report as one sentence a person reads. */
export function describeGracefulStop(report: GracefulStopReport): string {
  const parts: string[] = [];
  if (report.finished.length) {
    parts.push(report.finished.length === 1
      ? "1 bot had already finished"
      : `${report.finished.length} bots had already finished`);
  }
  if (report.interrupted.length) {
    parts.push(report.interrupted.length === 1
      ? "1 bot was stopped"
      : `${report.interrupted.length} bots were stopped`);
  }
  if (report.leftRunning.length) parts.push(`still running: ${report.leftRunning.join(", ")}`);
  if (!parts.length) return "nothing was in flight";
  return parts.join("; ");
}

/**
 * Why the server stays up, when the work in flight cannot be carried.
 *
 * A room turn is the case that has to be explained rather than counted:  the
 * shutdown deliberately leaves a room turn alone, because a room turn cannot
 * be resumed without repeating it, so "wait for it to finish" is not the whole
 * of it.  Everything else keeps the count-and-kinds refusal the owner already
 * knows, because there the answer is to wait for the work.
 */
export function gracefulStopRefusal(blockers: BlockingWork[]): string {
  const room = blockers.filter((entry) => entry.label === "room turn");
  if (!room.length) {
    return shutdownRefusal(
      blockers.reduce((total, entry) => total + entry.count, 0),
      blockers,
    );
  }
  const head = "a room turn is in flight, and a room turn cannot be resumed without repeating it, so the server stays up";
  const rest = blockers.filter((entry) => entry.label !== "room turn");
  if (!rest.length) return head;
  const named = rest.map((entry) => `${entry.count} ${entry.label}${entry.count === 1 ? "" : "s"}`).join(", ");
  return `${head}; also in flight: ${named}`;
}
