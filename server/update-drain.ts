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
//     when the fence goes up;
//   - a room round (a person's room message, or members answering each other)
//     waits in the room queue, as it would for a busy member, and is carried
//     in this file's carrier when the fence goes up.  Nothing in flight waits
//     on a round: a member's mentions run after its own turn has settled.  So
//     a busy room goes quiet after the turn it is on, instead of keeping an
//     update waiting while its bots answer each other.
//
// Everything else keeps working: every route stays open (approvals, Stop,
// peer comms and webhook deliveries are how work in flight gets to finish),
// and delegations a running bot starts still start, because holding them
// could deadlock the bot that is waiting on them.  When nothing is left in
// flight the updater converts the drain into
// the ordinary fence without interrupting anything.  When it gives up
// instead, it releases the drain and every held thing runs now.
//
// The harness owns the drain's lifetime.  It carries a deadline past the
// updater's own window, so an updater killed mid-wait can never leave this
// Mac holding work: the lease runs out and the drain releases itself.
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

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
export type DrainWindowInput = number | string | null | undefined;

export function clampDrainTimeout(value: DrainWindowInput): number {
  const parsed = typeof value === "string" ? (value.trim() ? Number(value) : Number.NaN) : value ?? Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return UPDATE_DRAIN_DEFAULT_TIMEOUT_MS;
  return Math.min(UPDATE_DRAIN_MAX_TIMEOUT_MS, Math.max(UPDATE_DRAIN_MIN_TIMEOUT_MS, Math.round(parsed)));
}

/** The work a drain waits for: the readiness counts minus what is only held.
 *  Held is durable or re-deliverable on its own — queued routine receipts
 *  and the steer queue — so counting it would keep a webhook-fed Mac "busy"
 *  forever.  Everything else is in flight and still counts. */
export function inFlightCounts(
  counts: Readonly<Record<string, number>>,
  held: { queuedRoutineRuns: number },
) {
  const result = { ...counts };
  if ("queuedSends" in result) result.queuedSends = 0;
  // Room rounds waiting in the room queue are held too: carried across the
  // restart (`HeldRoomRound`) or run when the hold lets go.
  if ("queuedRooms" in result) result.queuedRooms = 0;
  if ("routineRuns" in result) result.routineRuns = Math.max(0, result.routineRuns - Math.max(0, held.queuedRoutineRuns));
  return result;
}

export interface UpdateDrainStatus {
  startedAt: number;
  /** When the harness releases the drain by itself. */
  deadline: number;
  timeoutMs: number;
}

/** What a person's screens may know about a hold in progress: the part of
 *  `GET /api/runtime`'s `drain` that matters to them, as `UpdateStatus.drain`.
 *
 *  `/api/runtime` itself stays out of reach of both the app and a paired
 *  phone (loopback plus the harness owner's token, and not on the companion
 *  allowlist), so the view rides on the update status, which both already
 *  read and are pushed.  Counts and times only: no thread ids, no text. */
export interface UpdateDrainView {
  /** When the hold began (epoch milliseconds). */
  startedAt: number;
  /** The latest the updater's own window runs to (epoch milliseconds).  After
   *  this the updater has fenced the harness or let the hold go, so a message
   *  held now waits no longer than this.  It is NOT `deadline`: that adds the
   *  lease slack for an updater that never comes back, which is minutes more
   *  than anyone actually waits. */
  windowEndsAt: number;
  /** When the harness releases the hold by itself (epoch milliseconds). */
  deadline: number;
  /** Bots mid-turn: what the updater tells a person it is waiting for. */
  bots: number;
  /** Live room turns, which an update will not interrupt. */
  rooms: number;
  /** What is waiting rather than running. */
  held: { sends: number; rooms: number; routineRuns: number };
}

/** The readiness numbers a view is built from (`drainRuntimeReadiness`). */
export interface UpdateDrainCounts {
  bots?: number;
  rooms?: number;
  held?: { sends?: number; rooms?: number; routineRuns?: number };
}

const wholeCount = (value: number | undefined): number =>
  value !== undefined && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

/** The view of a hold, or null when nothing is held.  Pure, so the numbers a
 *  screen shows can be tested without a harness. */
export function drainViewOf(
  status: UpdateDrainStatus | null,
  counts: UpdateDrainCounts,
  leaseGraceMs: number = UPDATE_DRAIN_LEASE_GRACE_MS,
): UpdateDrainView | null {
  if (!status) return null;
  return {
    startedAt: status.startedAt,
    windowEndsAt: Math.max(status.startedAt, status.deadline - Math.max(0, leaseGraceMs)),
    deadline: status.deadline,
    bots: wholeCount(counts.bots),
    rooms: wholeCount(counts.rooms),
    held: {
      sends: wholeCount(counts.held?.sends),
      rooms: wholeCount(counts.held?.rooms),
      routineRuns: wholeCount(counts.held?.routineRuns),
    },
  };
}

export type UpdateDrainRelease = "updater" | "lease-expired";

export interface UpdateDrainTimer {
  cancel(): void;
}

export interface UpdateDrainOptions {
  /** Let held work run: the steer queue, the routine scheduler, job wakes. */
  onRelease(reason: UpdateDrainRelease): void;
  /** The hold started, was renewed, or ended, however it ended.  Screens read
   *  the hold from the update status, and nothing else tells them it changed:
   *  an updater started from a terminal is not a run the harness watches.
   *  Never allowed to break the hold itself. */
  onChange?(): void;
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
  // A plain field, not a parameter property: the harness runs this file with
  // Node's type stripping, which refuses parameter properties.
  private readonly options: UpdateDrainOptions;

  constructor(options: UpdateDrainOptions) {
    this.options = options;
  }

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
  begin(timeoutMs: DrainWindowInput): UpdateDrainStatus {
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
    this.changed();
    return { ...this.current };
  }

  private changed(): void {
    try {
      this.options.onChange?.();
    } catch (error) {
      this.options.log?.(`[update-drain] a change listener failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    this.changed();
    return true;
  }
}

const nonEmpty = z.string().min(1);

/** One held send, committed to its transcript and waiting to run.  The same
 *  arguments `drainQueuedSends` hands `startTurn`, so a send run after the
 *  restart is the turn it would have been without the update. */
const HeldSendSchema = z.object({
  botId: nonEmpty,
  threadId: nonEmpty,
  prompt: z.string(),
  /** The last line committed for this batch; `startTurn` must not append it again. */
  userMessageId: nonEmpty,
  /** Every line of the batch, kept out of transcript replay because they are in `prompt`. */
  excludeIds: z.array(z.string()),
  linqChatId: z.string().optional(),
  /** Any line came over a relay, so the turn runs unattended (S8). */
  relayed: z.boolean(),
  heldAt: z.number().finite(),
});
export type HeldSend = z.infer<typeof HeldSendSchema>;

/** Sends that waited behind a bot the update interrupted, carried exactly as
 *  the steer queue held them: NOT committed to the transcript.  That bot's own
 *  turn resumes after the restart, and boot recovery finds what to resume by
 *  reading the thread, so a committed line would be resumed in its place.
 *  These go back in the queue once recovery has run, and wait their turn. */
const HeldQueueEntrySchema = z.object({
  botId: nonEmpty,
  threadId: nonEmpty,
  heldAt: z.number().finite(),
  items: z.array(z.object({
    messageId: nonEmpty,
    text: z.string(),
    prompt: z.string(),
    replyToId: z.string().optional(),
    linqChatId: z.string().optional(),
    automationSource: z.string().optional(),
    relayed: z.boolean(),
    /** Already in the transcript (an earlier update committed it): it runs
     *  as its own turn with nothing appended (server/steer-queue.ts). */
    committed: z.object({
      userMessageId: nonEmpty,
      excludeIds: z.array(z.string()),
      relayed: z.boolean(),
      heldAt: z.number().finite(),
    }).optional(),
  })).min(1),
});
export type HeldQueueEntry = z.infer<typeof HeldQueueEntrySchema>;

/** A room round an update held (a member asked to speak while new work was
 *  held, or a round waiting on a busy member), carried across the restart.
 *  Nothing of it is in the transcript yet: a round reads the room when it
 *  runs, so it is carried as the request to speak it is. */
const HeldRoomRoundSchema = z.object({
  groupId: nonEmpty,
  threadId: nonEmpty,
  botId: nonEmpty,
  hop: z.number().int().min(0),
  cardContinuation: z.string().optional(),
  turnSelection: z.object({
    instanceId: nonEmpty,
    model: nonEmpty,
    effort: z.string().optional(),
    latest: z.string().optional(),
  }).optional(),
  heldAt: z.number().finite(),
});
export type HeldRoomRound = z.infer<typeof HeldRoomRoundSchema>;

/** Everything one update carries: the shape `appendHeldWork` writes, checked
 *  against its schema before it is written, and the type derived from it. */
const HeldWorkSchema = z.object({
  sends: z.array(HeldSendSchema),
  queued: z.array(HeldQueueEntrySchema),
  rooms: z.array(HeldRoomRoundSchema),
});
export type HeldWork = z.infer<typeof HeldWorkSchema>;

/** The file as written.  Entries are checked one at a time, so one bad entry
 *  costs only itself; a file from before `queued` existed reads as sends only. */
const HeldSendsFileSchema = z.object({
  version: z.literal(1),
  sends: z.array(z.unknown()),
  queued: z.array(z.unknown()).optional(),
  rooms: z.array(z.unknown()).optional(),
});

function keepValid<T>(entries: readonly unknown[], schema: z.ZodType<T>): T[] {
  const kept: T[] = [];
  for (const entry of entries) {
    const parsed = schema.safeParse(entry);
    if (parsed.success) kept.push(parsed.data);
  }
  return kept;
}

function readHeldWorkFile(path: string): HeldWork {
  if (!existsSync(path)) return { sends: [], queued: [], rooms: [] };
  const parsed = HeldSendsFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error("held sends file has an unknown shape");
  return {
    sends: keepValid(parsed.data.sends, HeldSendSchema),
    queued: keepValid(parsed.data.queued ?? [], HeldQueueEntrySchema),
    rooms: keepValid(parsed.data.rooms ?? [], HeldRoomRoundSchema),
  };
}

/** Add held work to the carrier, keeping any an earlier update left behind.
 *  Throws when it cannot write: the caller must then run the work instead,
 *  because a send that is neither on disk nor running would be lost. */
export function appendHeldWork(dataDir: string, work: Partial<HeldWork>): void {
  const sends = work.sends ?? [];
  const queued = work.queued ?? [];
  const rooms = work.rooms ?? [];
  if (sends.length === 0 && queued.length === 0 && rooms.length === 0) return;
  const path = join(dataDir, HELD_SENDS_FILE);
  let existing: HeldWork = { sends: [], queued: [], rooms: [] };
  try {
    existing = readHeldWorkFile(path);
  } catch {
    // An unreadable leftover is not a reason to lose the work in hand.
  }
  // What is written is checked against the same schema the next boot reads
  // with, so a malformed entry fails here, loudly, while the caller can still
  // run the work instead, rather than being dropped silently at boot.
  const file = {
    version: 1,
    ...HeldWorkSchema.parse({
      sends: [...existing.sends, ...sends],
      queued: [...existing.queued, ...queued],
      rooms: [...existing.rooms, ...rooms],
    }),
  };
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Read and remove the carrier.  An unreadable file is removed too (and
 *  reported), so it cannot fail every boot after it. */
export function takeHeldWork(dataDir: string, log?: (line: string) => void): HeldWork {
  const path = join(dataDir, HELD_SENDS_FILE);
  if (!existsSync(path)) return { sends: [], queued: [], rooms: [] };
  let work: HeldWork = { sends: [], queued: [], rooms: [] };
  try {
    work = readHeldWorkFile(path);
  } catch (error) {
    log?.(`[update-drain] could not read ${HELD_SENDS_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or unremovable; the work in hand still runs.
  }
  return work;
}

/** Split taken work into what to run and what waited too long to run. */
export function partitionByAge<T extends { heldAt: number }>(
  items: readonly T[],
  now: number,
  maxAgeMs = HELD_SENDS_MAX_AGE_MS,
) {
  const run: T[] = [];
  const stale: T[] = [];
  for (const item of items) (now - item.heldAt > maxAgeMs ? stale : run).push(item);
  return { run, stale };
}
