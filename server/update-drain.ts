// Holding new work for an update while the work in flight gets its window.
//
// The updater used to ask for the admission fence (`POST /api/runtime/quiesce`)
// once and give up when anything at all was running.  On a Mac whose bots are
// fed by webhooks, routines and job wakes that is most of the time: an update
// retried every three minutes saw 3, 5, 6, 7, 10 and 11 operations in flight
// and almost never caught an idle moment, and the owner waited hours.
//
// Now the updater asks the harness to HOLD new work first (a drain), so the
// count can only go down, and gives what is running a short grace to finish
// on its own.  Whatever is still running after it is interrupted by the
// forced quiesce, saved to pending-update-resume.json and resumed after the
// restart (scripts/update-botfleet-mac.mjs).  `--wait-for-idle` is the
// opt-in that never interrupts: it waits longer and then lets go.
//
// Held means neither refused nor run:
//
//   - routine, webhook and resource runs stay `queued` in routines.json (the
//     scheduler's `admit` says no), which survives a restart as-is;
//   - a job wake fails its dispatch and puts its notices back (jobs/wake.ts),
//     and jobs.json still carries them as `pending` across a restart;
//   - a person's message waits in the steer queue, exactly as it would for a
//     busy bot, and is committed to its transcript plus this file's carrier
//     when the fence goes up.
//
// Everything else keeps working: every route stays open (approvals, Stop,
// peer comms and webhook deliveries are how work in flight gets to finish),
// and turns a running bot starts for itself (delegations, room rounds) still
// start, because holding them would only deadlock the bot that is waiting on
// them.  When nothing is left in flight the updater converts the drain into
// the ordinary fence without interrupting anything.  When it gives up
// instead, it releases the drain and every held thing runs now.
//
// The harness owns the drain's lifetime.  It carries a deadline past the
// updater's own window, so an updater killed mid-wait can never leave this
// Mac holding work: the lease runs out and the drain releases itself.
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The hold an updater gets when it does not say how long it needs. */
export const UPDATE_DRAIN_DEFAULT_TIMEOUT_MS = 20 * 60_000;
/** Bounds on a requested window: long enough to mean something, short enough
 * that a typo cannot hold a Mac's automations for a day. */
export const UPDATE_DRAIN_MIN_TIMEOUT_MS = 1_000;
export const UPDATE_DRAIN_MAX_TIMEOUT_MS = 6 * 60 * 60_000;
/** How far past the updater's window the harness keeps holding.  The updater
 * releases on its own timeout; this only matters when it never gets to. */
export const UPDATE_DRAIN_LEASE_GRACE_MS = 2 * 60_000;

/** Where held sends wait across the restart.  A file of its own, not a field
 * in pending-update-resume.json: a rollback boots the PREVIOUS build, which
 * reads that file, ignores fields it does not know, and deletes it. */
export const HELD_SENDS_FILE = "update-held-sends.json";
/** A held send older than this is not run at boot.  The usual way a file
 * outlives its update is a rollback to a build that never read it, and an
 * answer arriving hours later to a message the person has moved on from is
 * worse than a visible note saying it was not run.  The words themselves are
 * already in the transcript. */
export const HELD_SENDS_MAX_AGE_MS = 60 * 60_000;

/** A requested drain window in milliseconds, clamped.  Anything unreadable is
 * the default rather than an error: the drain is the safe choice either way. */
export function clampDrainTimeout(value: unknown): number {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) return UPDATE_DRAIN_DEFAULT_TIMEOUT_MS;
  return Math.min(UPDATE_DRAIN_MAX_TIMEOUT_MS, Math.max(UPDATE_DRAIN_MIN_TIMEOUT_MS, Math.round(parsed)));
}

/** The work a drain waits for: the readiness counts minus what is only held.
 *  Held is durable or re-deliverable on its own — queued routine receipts
 *  and the steer queue — so counting it would keep a webhook-fed Mac "busy"
 *  forever.  Everything else is in flight and still counts. */
export function inFlightCounts(
  counts: Readonly<Record<string, number>>,
  held: { queuedRoutineRuns: number },
): Record<string, number> {
  const result: Record<string, number> = { ...counts };
  if ("queuedSends" in result) result.queuedSends = 0;
  if ("routineRuns" in result) result.routineRuns = Math.max(0, result.routineRuns - Math.max(0, held.queuedRoutineRuns));
  return result;
}

export interface UpdateDrainStatus {
  startedAt: number;
  /** When the harness releases the drain by itself. */
  deadline: number;
  timeoutMs: number;
}

export type UpdateDrainRelease = "updater" | "lease-expired";

export interface UpdateDrainTimer {
  cancel(): void;
}

export interface UpdateDrainOptions {
  /** Let held work run: the steer queue, the routine scheduler, job wakes. */
  onRelease(reason: UpdateDrainRelease): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => UpdateDrainTimer;
  graceMs?: number;
  log?: (line: string) => void;
}

function defaultTimer(fn: () => void, ms: number): UpdateDrainTimer {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return { cancel: () => clearTimeout(handle) };
}

export class UpdateDrain {
  private current: UpdateDrainStatus | null = null;
  private timer: UpdateDrainTimer | null = null;

  constructor(private readonly options: UpdateDrainOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  get active(): boolean {
    return this.current !== null;
  }

  status(): UpdateDrainStatus | null {
    return this.current ? { ...this.current } : null;
  }

  /** Start holding new work, or renew the lease on a drain already running.
   *  A renewal keeps the original start, so "how long has this waited" stays
   *  true across an updater that asks twice. */
  begin(timeoutMs: unknown): UpdateDrainStatus {
    const now = this.now();
    const timeout = clampDrainTimeout(timeoutMs);
    const grace = this.options.graceMs ?? UPDATE_DRAIN_LEASE_GRACE_MS;
    this.current = {
      startedAt: this.current?.startedAt ?? now,
      timeoutMs: timeout,
      deadline: now + timeout + grace,
    };
    this.timer?.cancel();
    const setTimer = this.options.setTimer ?? defaultTimer;
    this.timer = setTimer(() => {
      this.timer = null;
      if (this.release("lease-expired")) {
        this.options.log?.("[update-drain] the updater never came back; released held work");
      }
    }, timeout + grace);
    return { ...this.current };
  }

  /** Stop holding and let held work run now.  False when nothing was held. */
  release(reason: UpdateDrainRelease): boolean {
    if (!this.clear()) return false;
    this.options.onRelease(reason);
    return true;
  }

  /** Stop holding without releasing anything here: the fence took over and a
   *  restart is coming, or the caller releases everything itself.  False
   *  when nothing was held. */
  stop(): boolean {
    return this.clear();
  }

  private clear(): boolean {
    if (!this.current) return false;
    this.current = null;
    this.timer?.cancel();
    this.timer = null;
    return true;
  }
}

/** One held send, committed to its transcript and waiting to run.  The same
 *  arguments `drainQueuedSends` hands `startTurn`, so a send run after the
 *  restart is the turn it would have been without the update. */
export interface HeldSend {
  botId: string;
  threadId: string;
  prompt: string;
  /** The last line committed for this batch; `startTurn` must not append it again. */
  userMessageId: string;
  /** Every line of the batch, kept out of transcript replay because they are in `prompt`. */
  excludeIds: string[];
  linqChatId?: string;
  /** Any line came over a relay, so the turn runs unattended (S8). */
  relayed: boolean;
  heldAt: number;
}

interface HeldSendsFile {
  version: 1;
  sends: HeldSend[];
}

function isHeldSend(value: unknown): value is HeldSend {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.botId === "string" && raw.botId.length > 0 &&
    typeof raw.threadId === "string" && raw.threadId.length > 0 &&
    typeof raw.prompt === "string" &&
    typeof raw.userMessageId === "string" && raw.userMessageId.length > 0 &&
    Array.isArray(raw.excludeIds) && raw.excludeIds.every((id) => typeof id === "string") &&
    (raw.linqChatId === undefined || typeof raw.linqChatId === "string") &&
    typeof raw.relayed === "boolean" &&
    typeof raw.heldAt === "number" && Number.isFinite(raw.heldAt);
}

function readHeldSendsFile(path: string): HeldSend[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<HeldSendsFile>;
  if (parsed?.version !== 1 || !Array.isArray(parsed.sends)) throw new Error("held sends file has an unknown shape");
  return parsed.sends.filter(isHeldSend);
}

/** Add sends to the carrier, keeping any an earlier update left behind.
 *  Throws when it cannot write: the caller must then run the sends instead,
 *  because a send that is neither on disk nor running would be lost. */
export function appendHeldSends(dataDir: string, sends: readonly HeldSend[]): void {
  if (sends.length === 0) return;
  const path = join(dataDir, HELD_SENDS_FILE);
  let existing: HeldSend[] = [];
  try {
    existing = readHeldSendsFile(path);
  } catch {
    // An unreadable leftover is not a reason to lose the sends in hand.
  }
  const file: HeldSendsFile = { version: 1, sends: [...existing, ...sends] };
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Read and remove the carrier.  An unreadable file is removed too (and
 *  reported), so it cannot fail every boot after it. */
export function takeHeldSends(dataDir: string, log?: (line: string) => void): HeldSend[] {
  const path = join(dataDir, HELD_SENDS_FILE);
  if (!existsSync(path)) return [];
  let sends: HeldSend[] = [];
  try {
    sends = readHeldSendsFile(path);
  } catch (error) {
    log?.(`[update-drain] could not read ${HELD_SENDS_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or unremovable; the sends in hand still run.
  }
  return sends;
}

/** Split taken sends into the ones to run and the ones too old to run. */
export function partitionHeldSends(
  sends: readonly HeldSend[],
  now: number,
  maxAgeMs = HELD_SENDS_MAX_AGE_MS,
): { run: HeldSend[]; stale: HeldSend[] } {
  const run: HeldSend[] = [];
  const stale: HeldSend[] = [];
  for (const send of sends) (now - send.heldAt > maxAgeMs ? stale : run).push(send);
  return { run, stale };
}
