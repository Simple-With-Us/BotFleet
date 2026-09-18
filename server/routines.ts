import { boundStalePromptSnapshots, retainRoutineRuns } from "../shared/routine-retention.ts";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DATA_DIR } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";
import type { RoutineRequestOperation } from "../shared/routine-request.ts";
import {
  allowsMultipleBotThreads,
  automationLaneTitle,
  parseConversationMode,
  type ConversationMode,
} from "../shared/conversation-mode.ts";
import { foldPrompts, gapEndsAt, withinGap } from "./trigger-gap.ts";
import { routineFailureCode, routineFailurePhase, type RoutineOutcomeCode, type RoutineFailurePhase } from "../shared/routine-outcomes.ts";
import { canonicalTimeZone, nextZonedOccurrence } from "../shared/time-zone.ts";

export type RoutineSchedule =
  | { type: "once"; at: number }
  | { type: "daily"; time: string; weekdays: number[]; timeZone?: string };

/** `cloud` grants the cloud computer destination.  Box still runs the
 * Computer engine on that VM; a self-hosted VPS is a mount for the
 * provider selected on the bot.  `maus` keeps using that provider and
 * only borrows its configured computer tools, if any. */
export type RoutineRunOn = "maus" | "cloud";

export type RoutineRunTrigger = "schedule" | "manual" | "webhook" | "resource";

/** One shared task per bot for incoming events, one for calendar work. */
export type AutomationLane = "trigger" | "schedule";

export function automationLane(source?: RoutineRunTrigger): AutomationLane {
  return source === "webhook" || source === "resource" ? "trigger" : "schedule";
}

export const AUTOMATION_LANE_TITLE: Record<AutomationLane, string> = {
  trigger: "Triggers",
  schedule: "Routines",
};

/** Which conversation a run belongs in — the identity of the thing that
 * fired it, not the kind of thing it is.
 *
 * A lane put every webhook in one "Webhooks" thread and every schedule in
 * one "Schedules" thread, which is better than a thread per firing but still
 * mixes unrelated work: an uptime alert and a Sentry incident are not the
 * same conversation.  Keying on the webhook, the resource trigger, or the
 * routine gives each one a thread that accumulates — "UptimeRobot Outage &
 * Issue Alerts" is one conversation with a history, the way a person reading
 * it expects.
 *
 * Manual runs share the routine's thread deliberately: "Run now" is the same
 * work as the schedule, done impatiently. */
export function automationThreadKey(run: {
  routineId: string;
  webhookId?: string;
  triggerSource?: RoutineRunTrigger;
}): string {
  if (run.triggerSource === "webhook" && run.webhookId) return `webhook:${run.webhookId}`;
  return `routine:${run.routineId}`;
}

export type RoutineRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "missed";

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  botId: string;
  runOn: RoutineRunOn;
  enabled: boolean;
  schedule: RoutineSchedule;
  /** Whether a daily schedule's client-facing timezone was stored with the
   * recurrence or supplied from the current harness for display only. */
  scheduleTimeZoneSource?: "stored" | "host";
  durationMinutes: number;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  routineName: string;
  /** Snapshot of the work as dispatched, so an edited definition cannot
   * rewrite what a run actually did.  Kept in full on active runs and on the
   * newest settled runs; older settled runs keep a bounded copy of it (see
   * boundStalePromptSnapshots), because these snapshots were 94% of a 35 MB
   * routines.json. */
  prompt?: string;
  durationMinutes?: number;
  botId: string;
  runOn: RoutineRunOn;
  scheduledFor: number;
  status: RoutineRunStatus;
  manual: boolean;
  /** Why this receipt exists. Kept optional so version-1 files migrate in place. */
  triggerSource?: RoutineRunTrigger;
  webhookId?: string;
  deliveryId?: string;
  threadId?: string;
  startedAt?: number;
  finishedAt?: number;
  output?: string;
  error?: string;
  cost?: number | null;
  denials?: string[];
  createdAt: number;
  seenAt?: number;
  coalescedInto?: string;
  outcomeCode?: RoutineOutcomeCode;
  failurePhase?: RoutineFailurePhase;
  engineId?: string;
  driver?: string;
  model?: string;
}

export interface RoutineRequestReceipt {
  requestId: string;
  messageId: string;
  botId: string;
  threadId: string;
  action: RoutineRequestOperation["action"];
  fingerprintVersion: 1;
  /** SHA-256 of the strict normalized operation carried by the card. */
  fingerprint: string;
  resultId: string;
  appliedAt: number;
}

export interface RoutineRequestCommit {
  requestId: string;
  messageId: string;
  botId: string;
  threadId: string;
  action: RoutineRequestOperation["action"];
  fingerprintVersion: 1;
  fingerprint: string;
}

type RoutineRequestCommitFor<Action extends RoutineRequestOperation["action"]> =
  Omit<RoutineRequestCommit, "action"> & { action: Action };

export interface RoutineInput {
  name: string;
  prompt: string;
  botId: string;
  runOn?: RoutineRunOn;
  enabled?: boolean;
  schedule: RoutineSchedule;
  scheduleTimeZoneSource?: "stored" | "host";
  durationMinutes?: number;
}

interface RoutineFile {
  version: 1;
  routines: Routine[];
  runs: RoutineRun[];
  /** Durable commit receipts for cross-file confirmation recovery. */
  routineRequestReceipts?: RoutineRequestReceipt[];
}

export type RoutineRequestOwner = Pick<RoutineRequestReceipt, "requestId" | "messageId" | "botId" | "threadId">;

function routineRequestOwnerKey(owner: RoutineRequestOwner): string {
  return JSON.stringify([owner.requestId, owner.messageId, owner.botId, owner.threadId]);
}

export interface RoutineManagerOptions {
  file?: string;
  now?: () => number;
  /** Keyed frames only: every payload on this bus is `{ kind, … }`, which
   * is what lets the server number and replay them. */
  emit?: (payload: Record<string, unknown>) => void;
  botState: (botId: string) => "ready" | "busy" | "missing";
  /** Synchronous admission fence used during an update boundary. */
  admit?: () => boolean;
  /** Per-run readiness gate.  False leaves the durable run queued; callers
   * invoke tick() again when the missing runtime prerequisite arrives. */
  canStart?: (botId: string, threadId: string | undefined, runOn: RoutineRunOn) => boolean;
  /** Minutes this run's trigger must stay quiet after it activates.  Absent
   * or 0 runs every delivery as it lands. */
  minGapMinutes?: (run: RoutineRun) => number | undefined;
  /** Live workspace layout.  Absent keeps the historical lane behavior so
   * existing tests (and an older harness wiring) still mint Triggers /
   * Routines tasks. */
  conversationMode?: () => ConversationMode;
  /** The bot's one conversation.  Used in simple mode so automation does
   * not mint extra tasks. */
  defaultThread?: (botId: string) => string | undefined;
  createTask: (
    botId: string,
    title: string,
    activate?: boolean,
    automationKey?: string,
  ) => { threadId: string } | null;
  /** Switch the bot's live chat to this thread (webhook deliveries). */
  activateTask?: (botId: string, threadId: string) => void;
  /** True when this bot still has a task for `threadId`. Used so a later
   * scheduled run of the same routine can keep writing in the previous thread
   * instead of minting a new one every tick. */
  taskExists?: (botId: string, threadId: string) => boolean;
  /** Durable lookup by `automationThreadKey`, independent of run history. */
  taskForKey?: (botId: string, automationKey: string) => string | undefined;
  stampKey?: (botId: string, threadId: string, automationKey: string) => void;
  startTurn: (
    botId: string,
    threadId: string,
    prompt: string,
    runOn: RoutineRunOn,
    triggerSource: RoutineRunTrigger,
    onDispatchError: (message: string) => void,
  ) => Promise<void>;
  interruptTurn?: (botId: string, threadId: string, runOn: RoutineRunOn) => Promise<void>;
  onRunFailed?: (run: RoutineRun) => void;
  /** Is this run's turn still in flight on the harness? Consulted by the
   * periodic sweep for runs stuck in running/waiting: the completion path
   * settles a run on `turn.completed`, but a harness path that settles the
   * bot without one (a stall, a provider reload, a crash) must not leave the
   * receipt `running` forever — that also holds a slot against the webhook
   * and resource-trigger pending caps until the app restarts. */
  turnLive?: (run: RoutineRun) => boolean;
  /** Effective host timezone exposed for legacy recurrences that predate an
   * explicit schedule zone.  Their stored and execution semantics stay local. */
  timeZone?: () => string;
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const CATCH_UP_MS = 12 * 60 * 60_000;
const MAX_RUNS = 2_000;
/** Settled runs that keep their full prompt snapshot.  A webhook run's
 * snapshot carries its whole payload, so 2,000 of them made routines.json
 * 35 MB and turned every save() below into a multi-second main-thread stall
 * (the always-on harness stopped answering health checks under memory
 * pressure).  Older settled runs keep a bounded snapshot — see
 * boundStalePromptSnapshots for exactly what survives. */
const PROMPT_SNAPSHOT_LIMIT = 100;
/** A run is marked running just before its turn is dispatched; give the
 * dispatch this long to mark the bot busy before the sweep may call it an
 * orphan. */
const ORPHAN_GRACE_MS = 30_000;
const ROUTINE_REQUEST_ACTIONS = new Set<RoutineRequestOperation["action"]>([
  "create",
  "update",
  "pause",
  "resume",
  "run_now",
  "delete",
]);

function isRoutineRequestAction(value: unknown): value is RoutineRequestOperation["action"] {
  return typeof value === "string" && ROUTINE_REQUEST_ACTIONS.has(value as RoutineRequestOperation["action"]);
}

function cleanDays(days: unknown): number[] {
  if (!Array.isArray(days)) return ALL_DAYS;
  const out = [...new Set(days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  return out.length ? out : ALL_DAYS;
}

function cleanSchedule(schedule: RoutineSchedule): RoutineSchedule {
  if (schedule?.type === "once") {
    const at = Number(schedule.at);
    if (!Number.isFinite(at)) throw new Error("Choose a valid date and time");
    return { type: "once", at };
  }
  if (schedule?.type === "daily") {
    const time = String(schedule.time ?? "");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Time must use HH:MM");
    const rawTimeZone = typeof schedule.timeZone === "string" ? schedule.timeZone.trim() : "";
    const timeZone = rawTimeZone ? canonicalTimeZone(rawTimeZone) : null;
    if (rawTimeZone && !timeZone) throw new Error("Choose a valid timezone");
    return { type: "daily", time, weekdays: cleanDays(schedule.weekdays), ...(timeZone ? { timeZone } : {}) };
  }
  throw new Error("Choose a supported schedule");
}

/** Next wall-clock occurrence in this computer's timezone, strictly after `after`. */
export function nextOccurrence(schedule: RoutineSchedule, after: number): number | null {
  if (schedule.type === "once") return schedule.at > after ? schedule.at : null;
  if (schedule.timeZone) return nextZonedOccurrence(schedule, after, schedule.timeZone);
  const [hour, minute] = schedule.time.split(":").map(Number);
  const weekdays = new Set(cleanDays(schedule.weekdays));
  for (let offset = 0; offset <= 8; offset++) {
    const d = new Date(after);
    d.setDate(d.getDate() + offset);
    d.setHours(hour, minute, 0, 0);
    if (d.getTime() > after && weekdays.has(d.getDay())) return d.getTime();
  }
  return null;
}

function sanitizeInput(input: RoutineInput): Omit<Routine, "id" | "createdAt" | "updatedAt" | "nextRunAt"> {
  const name = String(input.name ?? "").trim().slice(0, 80);
  const prompt = String(input.prompt ?? "").trim().slice(0, 20_000);
  const botId = String(input.botId ?? "").trim();
  if (!name) throw new Error("Give the routine a name");
  if (!prompt) throw new Error("Tell the bot what to do");
  if (!botId) throw new Error("Choose a bot");
  const runOn = input.runOn ?? "maus";
  if (runOn !== "maus" && runOn !== "cloud") throw new Error("Choose where this routine runs");
  const schedule = input.schedule.type === "daily" && input.scheduleTimeZoneSource === "host"
    ? { type: "daily" as const, time: input.schedule.time, weekdays: input.schedule.weekdays }
    : input.schedule;
  return {
    name,
    prompt,
    botId,
    runOn,
    enabled: input.enabled !== false,
    schedule: cleanSchedule(schedule),
    durationMinutes: Math.min(240, Math.max(15, Math.round(Number(input.durationMinutes) || 30))),
  };
}

export class RoutineManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly options: RoutineManagerOptions;
  private routines: Routine[] = [];
  private runs: RoutineRun[] = [];
  private routineRequestReceipts: RoutineRequestReceipt[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  /** When each trigger last STARTED, keyed by `automationThreadKey`.
   *
   * In memory only: a gap is a rate limit on waking a bot, and after a
   * restart the right thing is to run the next delivery rather than hold it
   * for a quiet period nobody remembers asking for. */
  private readonly lastStartedByKey = new Map<string, number>();
  /** A one-shot timer for the moment a gap closes, so a batch that arrived
   * during the quiet period does not sit until the next periodic tick. */
  private gapWake: ReturnType<typeof setTimeout> | null = null;
  private gapWakeAt = 0;

  constructor(options: RoutineManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "routines.json");
    this.now = options.now ?? Date.now;
    try {
      const disk = JSON.parse(readFileSync(this.file, "utf8")) as Partial<RoutineFile>;
      this.routines = Array.isArray(disk.routines)
        ? disk.routines.map((routine) => ({ ...routine, runOn: routine.runOn ?? "maus" }))
        : [];
      this.runs = Array.isArray(disk.runs)
        ? disk.runs.map((run) => ({ ...run, runOn: run.runOn ?? "maus" }))
        : [];
      this.routineRequestReceipts = Array.isArray(disk.routineRequestReceipts)
        ? disk.routineRequestReceipts.filter((receipt): receipt is RoutineRequestReceipt =>
            typeof receipt?.requestId === "string" &&
            typeof receipt?.messageId === "string" &&
            typeof receipt?.botId === "string" &&
            typeof receipt?.threadId === "string" &&
            isRoutineRequestAction(receipt?.action) &&
            receipt?.fingerprintVersion === 1 &&
            typeof receipt?.fingerprint === "string" && /^[a-f0-9]{64}$/.test(receipt.fingerprint) &&
            typeof receipt?.resultId === "string" &&
            Number.isFinite(receipt?.appliedAt)
          )
        : [];
    } catch {
      this.routines = [];
      this.runs = [];
      this.routineRequestReceipts = [];
    }
    // A local process cannot still own these turns after a full restart.
    const recovered: RoutineRun[] = [];
    for (const run of this.runs) {
      if (run.status === "running" || run.status === "waiting") {
        run.status = "failed";
        run.error = "BotFleet restarted while this routine was running";
        run.outcomeCode = "runtime_restart";
        run.failurePhase = "lifecycle";
        run.finishedAt = this.now();
        recovered.push({ ...run });
      }
    }
    if (recovered.length > 0) {
      this.save();
      for (const run of recovered) if (!run.coalescedInto) this.options.onRunFailed?.(run);
    }
  }

  listRoutines(): Routine[] {
    const effectiveTimeZone = this.options.timeZone?.();
    return this.routines.map((routine) => this.clientRoutine(routine, effectiveTimeZone));
  }

  /** The explicit zone stored for a recurrence, without the client-facing
   * effective host zone added by listRoutines.  Callers that replace a
   * legacy schedule need this distinction so its host-local behavior stays
   * host-local. */
  storedRoutineTimeZone(id: string): string | undefined {
    const schedule = this.routines.find((routine) => routine.id === id)?.schedule;
    return schedule?.type === "daily" ? schedule.timeZone : undefined;
  }

  listRuns(from?: number, to?: number): RoutineRun[] {
    return this.runs
      .filter((r) => (from == null || r.scheduledFor >= from) && (to == null || r.scheduledFor <= to))
      .sort((a, b) => b.scheduledFor - a.scheduledFor)
      .map((r) => ({ ...r }));
  }

  activeRunForBot(botId: string): RoutineRun | null {
    const run = this.runs.find(
      (candidate) => !candidate.coalescedInto && candidate.botId === botId && ["running", "waiting"].includes(candidate.status),
    );
    return run ? { ...run } : null;
  }

  routineRequestReceipt(requestId: string): RoutineRequestReceipt | null {
    const receipt = this.routineRequestReceipts.find((candidate) => candidate.requestId === requestId);
    return receipt ? { ...receipt } : null;
  }

  /** Small startup index used to locate only transcripts that may need
   * cross-file commit recovery. Most launches have no receipts and therefore
   * do not read or cache any transcript for this feature. */
  routineRequestReceiptOwners(): RoutineRequestOwner[] {
    return this.routineRequestReceipts.map(({ requestId, messageId, botId, threadId }) => ({
      requestId,
      messageId,
      botId,
      threadId,
    }));
  }

  /** Once the transcript card is durably settled, its scheduler receipt is
   * redundant. Unsettled receipts are intentionally never count-evicted: an
   * actionable card may survive indefinitely and must retain its exact-once
   * recovery record for the same lifetime. */
  forgetRoutineRequestReceipt(request: RoutineRequestCommit): boolean {
    const receipt = this.matchingRoutineRequestReceipt(request);
    if (!receipt) return false;
    const index = this.routineRequestReceipts.indexOf(receipt);
    this.commitMutation(() => {
      this.routineRequestReceipts.splice(index, 1);
    });
    return true;
  }

  forgetRoutineRequestReceiptsForThread(threadId: string): number {
    const kept = this.routineRequestReceipts.filter((receipt) => receipt.threadId !== threadId);
    const removed = this.routineRequestReceipts.length - kept.length;
    if (removed === 0) return 0;
    this.commitMutation(() => {
      this.routineRequestReceipts = kept;
    });
    return removed;
  }

  /** Drop only receipts whose confirmation transcript no longer exists.
   * Reachable open cards retain exact-once recovery for their full lifetime. */
  reconcileRoutineRequestReceipts(reachable: readonly RoutineRequestOwner[]): number {
    const keys = new Set(reachable.map(routineRequestOwnerKey));
    const kept = this.routineRequestReceipts.filter((receipt) => keys.has(routineRequestOwnerKey(receipt)));
    const removed = this.routineRequestReceipts.length - kept.length;
    if (removed === 0) return 0;
    this.commitMutation(() => {
      this.routineRequestReceipts = kept;
    });
    return removed;
  }

  isActiveThread(threadId: string): boolean {
    return this.runs.some(
      (run) => run.threadId === threadId && ["running", "waiting"].includes(run.status),
    );
  }

  create(input: RoutineInput, request?: RoutineRequestCommitFor<"create">): Routine {
    if (request) {
      const receipt = this.matchingRoutineRequestReceipt(request);
      if (receipt) {
        const committed = this.routines.find((routine) => routine.id === receipt.resultId);
        if (committed) return { ...committed, schedule: { ...committed.schedule } };
        throw new Error("This routine request was already applied");
      }
    }
    const clean = sanitizeInput(input);
    if (this.options.botState(clean.botId) === "missing") throw new Error("That bot no longer exists");
    const at = this.now();
    const routine: Routine = {
      id: randomUUID(),
      ...clean,
      nextRunAt: clean.enabled ? this.initialOccurrence(clean.schedule, at) : null,
      createdAt: at,
      updatedAt: at,
    };
    this.commitMutation(() => {
      this.routines.unshift(routine);
      if (request) this.rememberRoutineRequest(request, routine.id, at);
    });
    this.emitRoutine(routine);
    return { ...routine, schedule: { ...routine.schedule } };
  }

  update(
    id: string,
    patch: Partial<RoutineInput>,
    request?: RoutineRequestCommitFor<"update" | "pause" | "resume">,
  ): Routine | null {
    if (request) {
      const receipt = this.matchingRoutineRequestReceipt(request);
      if (receipt) {
        const committed = this.routines.find((routine) => routine.id === receipt.resultId);
        return committed ? { ...committed, schedule: { ...committed.schedule } } : null;
      }
    }
    const routine = this.routines.find((r) => r.id === id);
    if (!routine) return null;
    const now = this.now();
    const replacementSchedule = patch.schedule?.type === "daily" && patch.scheduleTimeZoneSource === "host"
      ? { type: "daily" as const, time: patch.schedule.time, weekdays: patch.schedule.weekdays }
      : patch.schedule;
    const nextSchedule = replacementSchedule?.type === "daily" &&
        routine.schedule.type === "daily" &&
        replacementSchedule.timeZone === undefined &&
        routine.schedule.timeZone !== undefined
      ? { ...replacementSchedule, timeZone: routine.schedule.timeZone }
      : replacementSchedule ?? routine.schedule;
    const clean = sanitizeInput({
      name: patch.name ?? routine.name,
      prompt: patch.prompt ?? routine.prompt,
      botId: patch.botId ?? routine.botId,
      runOn: patch.runOn ?? routine.runOn,
      enabled: patch.enabled ?? routine.enabled,
      // Older clients replace time/weekdays without sending the newer zone
      // field.  Omission preserves an explicit stored zone; it does not
      // convert the recurrence to the harness clock.  A legacy zone-less
      // routine remains zone-less because there is no zone to carry forward.
      schedule: nextSchedule,
      durationMinutes: patch.durationMinutes ?? routine.durationMinutes,
    });
    if (this.options.botState(clean.botId) === "missing") throw new Error("That bot no longer exists");
    const cancelledRuns: RoutineRun[] = [];
    this.commitMutation(() => {
      Object.assign(routine, clean, {
        nextRunAt: clean.enabled ? this.initialOccurrence(clean.schedule, now) : null,
        // `updatedAt` doubles as the optimistic revision on durable routine
        // confirmation cards. Keep it monotonic even for two writes in one ms.
        updatedAt: Math.max(now, routine.updatedAt + 1),
      });
      if (patch.enabled === false) {
        for (const run of this.runs) {
          if (run.routineId !== routine.id || run.status !== "queued") continue;
          run.status = "cancelled";
          run.finishedAt = this.now();
          run.error = "The routine was paused before this run started";
          cancelledRuns.push(run);
        }
      }
      if (request) this.rememberRoutineRequest(request, routine.id, now);
    });
    for (const run of cancelledRuns) this.emitRun(run);
    this.emitRoutine(routine);
    return { ...routine, schedule: { ...routine.schedule } };
  }

  remove(id: string, request?: RoutineRequestCommitFor<"delete">): boolean {
    if (request) {
      const receipt = this.matchingRoutineRequestReceipt(request);
      if (receipt) {
        return true;
      }
    }
    const at = this.routines.findIndex((r) => r.id === id);
    if (at === -1) return false;
    const cancelledRuns: RoutineRun[] = [];
    this.commitMutation(() => {
      this.routines.splice(at, 1);
      for (const run of this.runs) {
        if (run.routineId !== id || run.status !== "queued") continue;
        run.status = "cancelled";
        run.finishedAt = this.now();
        cancelledRuns.push(run);
      }
      if (request) this.rememberRoutineRequest(request, id, this.now());
    });
    for (const run of cancelledRuns) this.emitRun(run);
    this.options.emit?.({ kind: "routine.deleted", routineId: id });
    return true;
  }

  disableForBot(botId: string) {
    let changed = false;
    for (const routine of this.routines) {
      if (routine.botId !== botId || !routine.enabled) continue;
      routine.enabled = false;
      routine.nextRunAt = null;
      routine.updatedAt = Math.max(this.now(), routine.updatedAt + 1);
      this.emitRoutine(routine);
      changed = true;
    }
    for (const run of this.runs) {
      if (run.botId !== botId || !["queued", "running", "waiting"].includes(run.status)) continue;
      run.status = "cancelled";
      run.finishedAt = this.now();
      run.error = "The assigned bot was deleted";
      this.emitRun(run);
      if (run.threadId) void this.options.interruptTurn?.(run.botId, run.threadId, run.runOn ?? "maus").catch(() => {});
      changed = true;
    }
    if (changed) this.save();
  }

  runNow(id: string, request?: RoutineRequestCommitFor<"run_now">): RoutineRun | null {
    if (request) {
      const receipt = this.matchingRoutineRequestReceipt(request);
      if (receipt) {
        const committed = this.runs.find((run) => run.id === receipt.resultId);
        return committed ? { ...committed } : null;
      }
    }
    const routine = this.routines.find((r) => r.id === id);
    if (!routine) return null;
    let run!: RoutineRun;
    this.commitMutation(() => {
      run = this.newRun(routine, this.now(), true);
      if (request) this.rememberRoutineRequest(request, run.id, this.now());
    });
    this.emitRun(run);
    queueMicrotask(() => void this.tick());
    return { ...run };
  }

  /** Queue an event-driven job without inventing a calendar schedule. Webhook
   * definitions live in their own store; the execution receipt deliberately
   * reuses this manager so busy-bot ordering, task creation and VM routing stay
   * identical for every unattended job. */
  enqueueWebhook(input: {
    webhookId: string;
    webhookName: string;
    prompt: string;
    botId: string;
    runOn: RoutineRunOn;
    deliveryId: string;
    receivedAt: number;
  }): RoutineRun {
    if (this.options.botState(input.botId) === "missing") {
      throw Object.assign(new Error("The assigned MAUS no longer exists"), { status: 410 });
    }
    const run: RoutineRun = {
      id: randomUUID(),
      routineId: input.webhookId,
      routineName: input.webhookName,
      prompt: input.prompt,
      botId: input.botId,
      runOn: input.runOn,
      scheduledFor: input.receivedAt,
      status: "queued",
      manual: false,
      triggerSource: "webhook",
      webhookId: input.webhookId,
      deliveryId: input.deliveryId,
      createdAt: this.now(),
    };
    this.runs.push(run);
    this.save();
    this.emitRun(run);
    queueMicrotask(() => void this.tick());
    return { ...run };
  }

  /** Host disk/RAM/CPU pressure. Same queue as webhooks so a busy Housekeeper
   * is not double-started; receipts stay on the automations calendar. */
  enqueueResource(input: {
    triggerId: string;
    triggerName: string;
    prompt: string;
    botId: string;
    runOn: RoutineRunOn;
    deliveryId: string;
    receivedAt: number;
  }): RoutineRun {
    if (this.options.botState(input.botId) === "missing") {
      throw Object.assign(new Error("The assigned MAUS no longer exists"), { status: 410 });
    }
    const run: RoutineRun = {
      id: randomUUID(),
      routineId: input.triggerId,
      routineName: input.triggerName,
      prompt: input.prompt,
      botId: input.botId,
      runOn: input.runOn,
      scheduledFor: input.receivedAt,
      status: "queued",
      manual: false,
      triggerSource: "resource",
      webhookId: input.triggerId,
      deliveryId: input.deliveryId,
      createdAt: this.now(),
    };
    this.runs.push(run);
    this.save();
    this.emitRun(run);
    queueMicrotask(() => void this.tick());
    return { ...run };
  }

  activeWebhookRunCount(webhookId: string): number {
    return this.runs.filter(
      (run) => run.webhookId === webhookId && ["queued", "running", "waiting"].includes(run.status),
    ).length;
  }

  cancelQueuedWebhook(webhookId: string, message: string): void {
    let changed = false;
    for (const run of this.runs) {
      if (run.webhookId !== webhookId || run.status !== "queued") continue;
      run.status = "cancelled";
      run.finishedAt = this.now();
      run.error = message.slice(0, 500);
      this.emitRun(run);
      changed = true;
    }
    if (changed) this.save();
  }

  async cancelRun(id: string): Promise<RoutineRun | null> {
    let run = this.runs.find((r) => r.id === id);
    if (run?.coalescedInto) run = this.runs.find((r) => r.id === run!.coalescedInto);
    if (!run || !["queued", "running", "waiting"].includes(run.status)) return null;
    run.status = "cancelled";
    run.outcomeCode = "cancelled";
    run.failurePhase = "lifecycle";
    run.finishedAt = this.now();
    this.save();
    this.emitRun(run);
    if (run.threadId) await this.options.interruptTurn?.(run.botId, run.threadId, run.runOn ?? "maus").catch(() => {});
    queueMicrotask(() => void this.tick());
    return { ...run };
  }

  markSeen(id: string): RoutineRun | null {
    const run = this.runs.find((r) => r.id === id);
    if (!run) return null;
    if (!run.seenAt) {
      run.seenAt = this.now();
      this.save();
      this.emitRun(run);
    }
    return { ...run };
  }

  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 10_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.gapWake) clearTimeout(this.gapWake);
    this.gapWake = null;
    this.gapWakeAt = 0;
  }

  /** Come back when a gap closes.
   *
   * The periodic tick would find the batch eventually, but "eventually" is a
   * whole interval late for work the person can watch arriving.  One timer is
   * kept — the earliest pending open — because every later gap is covered by
   * the tick that timer causes. */
  private scheduleGapWake(at: number): void {
    if (this.gapWake && this.gapWakeAt <= at) return;
    if (this.gapWake) clearTimeout(this.gapWake);
    this.gapWakeAt = at;
    const delay = Math.max(0, at - this.now());
    this.gapWake = setTimeout(() => {
      this.gapWake = null;
      this.gapWakeAt = 0;
      void this.tick();
    }, delay);
    this.gapWake.unref?.();
  }

  async tick(): Promise<void> {
    if (this.options.admit?.() === false) return;
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      this.reconcileOrphanedRuns(now);
      let changed = false;
      for (const routine of this.routines) {
        if (!routine.enabled || routine.nextRunAt == null || routine.nextRunAt > now) continue;
        const scheduledFor = routine.nextRunAt;
        const late = now - scheduledFor;
        if (late > CATCH_UP_MS) {
          const missed = this.newRun(routine, scheduledFor, false);
          missed.status = "missed";
          missed.finishedAt = now;
          missed.error = "This computer was offline for more than 12 hours after the scheduled time";
          missed.outcomeCode = "missed_offline";
          missed.failurePhase = "schedule";
          this.emitRun(missed);
        } else {
          const run = this.newRun(routine, scheduledFor, false);
          this.emitRun(run);
        }
        routine.nextRunAt =
          routine.schedule.type === "once" ? null : nextOccurrence(routine.schedule, Math.max(now, scheduledFor));
        if (routine.schedule.type === "once") routine.enabled = false;
        routine.updatedAt = Math.max(now, routine.updatedAt + 1);
        this.emitRoutine(routine);
        changed = true;
      }
      if (changed) this.save();

      for (const run of [...this.runs].reverse()) {
        if (run.status !== "queued") continue;
        const state = this.options.botState(run.botId);
        if (state === "busy") continue;
        if (state === "missing") {
          this.failRun(run, "The assigned bot no longer exists");
          continue;
        }
        // A trigger with a minimum gap stays quiet after it runs.  The
        // deliveries that arrive meanwhile are not dropped: they stay queued
        // and the whole batch goes into one turn when the gap closes, which
        // is both cheaper and a better prompt ("these six checks failed"
        // rather than six copies of "a check failed").
        const key = automationThreadKey(run);
        const gapMinutes = this.options.minGapMinutes?.(run);
        if (gapMinutes) {
          const lastStartedAt = this.lastStartedByKey.get(key);
          if (withinGap(lastStartedAt, this.now(), gapMinutes)) {
            const opensAt = gapEndsAt(lastStartedAt, gapMinutes);
            if (opensAt !== null) this.scheduleGapWake(opensAt);
            continue;
          }
        }
        // A bot can only run one thread at a time.  Simple mode writes every
        // event into that bot's one conversation.  Otherwise each SOURCE —
        // this webhook, this routine — gets a thread that accumulates, so
        // "UptimeRobot Outage & Issue Alerts" is one conversation with a
        // history rather than a hundred one-message tasks.  A webhook still
        // becomes the live chat so the incoming event is visible.
        //
        // No conversationMode hook means the source-keyed behavior (what the
        // tests and an older harness wiring expect).  The live server always
        // passes the workspace setting, whose default is Simple, and always
        // supplies defaultThread (the bot's existing conversation).  A wake
        // must append there instead of minting a sibling after mergeThreads.
        const mode = parseConversationMode(this.options.conversationMode?.() ?? "projects");
        // The routine's own name, not the lane's: the person recognises
        // "Fleet PR Health Sweep", not "Schedules".
        const title = run.routineName?.trim() || automationLaneTitle(mode, run.triggerSource);
        // Identity is the source (webhook / routine), not "whatever chat is
        // open".  A keyed task wins so a re-fire cannot mint a sibling.
        // Run history is the fallback for tasks stamped before
        // automationKey existed.  Simple mode is one visible conversation:
        // a leftover Projects-mode extra that still holds the key (Keep
        // Extra Threads Hidden) must not steal the fire or become the
        // live chat.
        const designated = !allowsMultipleBotThreads(mode) ? this.options.defaultThread?.(run.botId) : undefined;
        const acceptReuse = (id: string | undefined): string | undefined => {
          if (!id) return undefined;
          if (designated && id !== designated) return undefined;
          return id;
        };
        let threadId: string | undefined = acceptReuse(this.options.taskForKey?.(run.botId, key));
        let stampResolvedThread = false;
        if (!threadId) {
          const previous = [...this.runs].reverse().find(
            (candidate) =>
              candidate.botId === run.botId &&
              candidate.id !== run.id &&
              Boolean(candidate.threadId) &&
              automationThreadKey(candidate) === key &&
              this.options.taskExists?.(run.botId, candidate.threadId!),
          );
          threadId = acceptReuse(previous?.threadId);
          stampResolvedThread = Boolean(threadId);
        }
        // Prefer the bot's existing conversation over minting.  Live wiring
        // always has defaultThread; tests that omit it still take createTask
        // below so per-source Projects threads keep their coverage.
        if (!threadId) {
          threadId = this.options.defaultThread?.(run.botId);
          if (threadId) stampResolvedThread = true;
        }
        if (!threadId && !allowsMultipleBotThreads(mode)) {
          this.failRun(run, "Could not find this bot's conversation");
          continue;
        }
        // Gate before creating, activating, or stamping a task.  A missing
        // runtime credential may take many scheduler ticks to arrive; those
        // retries must not mint duplicate empty tasks as a side effect.
        if (this.options.canStart?.(run.botId, threadId, run.runOn) === false) continue;
        if (stampResolvedThread && threadId) this.options.stampKey?.(run.botId, threadId, key);
        if (!threadId) {
          const task = this.options.createTask(
            run.botId,
            title,
            run.triggerSource === "webhook" || run.triggerSource === "resource",
            key,
          );
          if (!task) {
            this.failRun(run, "Could not create a task for this run");
            continue;
          }
          threadId = task.threadId;
        } else if (
          allowsMultipleBotThreads(mode) &&
          (run.triggerSource === "webhook" || run.triggerSource === "resource")
        ) {
          this.options.activateTask?.(run.botId, threadId);
        }
        if (
          (run.triggerSource === "webhook" || run.triggerSource === "resource") &&
          !allowsMultipleBotThreads(mode)
        ) {
          this.options.activateTask?.(run.botId, threadId);
        }
        if (!threadId) {
          this.failRun(run, "Could not create a task for this run");
          continue;
        }
        run.threadId = threadId;
        run.startedAt = this.now();
        run.status = "running";
        this.lastStartedByKey.set(key, run.startedAt);
        // Combined deliveries stay pending until this owning turn settles.
        // A dispatch is not evidence that any delivery completed successfully.
        const waiting = this.runs.filter(
          (candidate) =>
            candidate.status === "queued" &&
            candidate.id !== run.id &&
            candidate.botId === run.botId &&
            automationThreadKey(candidate) === key,
        );
        for (const folded of waiting) {
          folded.status = "running";
          folded.coalescedInto = run.id;
          folded.threadId = threadId;
          folded.startedAt = run.startedAt;
          folded.finishedAt = undefined;
          folded.output = undefined;
          this.emitRun(folded);
        }
        this.save();
        this.emitRun(run);
        try {
          const own = run.prompt ?? this.routines.find((r) => r.id === run.routineId)?.prompt;
          if (!own) {
            this.failThread(threadId, "The routine was deleted before it could start");
            continue;
          }
          const prompt = waiting.length
            ? foldPrompts({
                run: { id: run.id, key, scheduledFor: run.scheduledFor, prompt: own },
                folded: waiting.map((candidate) => ({
                  id: candidate.id,
                  key,
                  scheduledFor: candidate.scheduledFor,
                  prompt: candidate.prompt,
                })),
              })
            : own;
          const triggerSource = run.triggerSource ?? (run.manual ? "manual" : "schedule");
          await this.options.startTurn(
            run.botId,
            threadId,
            prompt,
            run.runOn ?? "maus",
            triggerSource,
            (message) => this.failThread(threadId, message, "dispatch_failed"),
          );
        } catch (error) {
          this.failThread(threadId, error instanceof Error ? error.message : String(error), "dispatch_failed");
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  handleRuntimeEvent(event: RuntimeEvent): RoutineRun | null {
    const run = this.runs.find((r) => !r.coalescedInto && r.threadId === event.threadId && ["running", "waiting"].includes(r.status));
    if (!run) return null;
    run.engineId = event.providerInstanceId ?? event.provider;
    run.driver = event.provider;
    if (event.type === "session.started") {
      run.model = event.model ?? undefined;
    } else if (event.type === "request.opened") {
      run.status = "waiting";
    } else if (event.type === "request.resolved") {
      run.status = "running";
    } else if (event.type === "item.completed" && event.itemType === "assistant_text") {
      run.output = event.text.trim().slice(0, 2_000);
    } else if (event.type === "runtime.error") {
      run.error = event.message.slice(0, 500);
      run.outcomeCode = event.setup ? "auth_required" : undefined;
    } else if (event.type === "turn.retrying") {
      // the driver will relaunch this same run; a transient blip is not a
      // receipt-worthy failure, so keep the run running and stay quiet
      return null;
    } else if (event.type === "turn.completed") {
      run.cost = event.cost;
      run.denials = event.denials;
      const reason = event.stopReason ?? run.error;
      const code = routineFailureCode(reason, run.outcomeCode === "auth_required", Boolean(event.denials?.length));
      if (code === "cancelled") {
        run.status = "cancelled";
        run.outcomeCode = "cancelled";
        run.failurePhase = "lifecycle";
        run.finishedAt = this.now();
      } else if (!event.ok) {
        this.failRun(run, reason ?? "The bot did not complete this run", code);
        queueMicrotask(() => void this.tick());
        return { ...run };
      } else {
        run.status = "completed";
        run.outcomeCode = "completed";
        run.failurePhase = undefined;
        run.finishedAt = this.now();
        run.error = undefined;
      }
    } else {
      return null;
    }
    this.save();
    this.emitRun(run);
    if (event.type === "turn.completed") queueMicrotask(() => void this.tick());
    return { ...run };
  }

  failThread(threadId: string, message: string, code = routineFailureCode(message)) {
    const run = this.runs.find((r) => !r.coalescedInto && r.threadId === threadId && ["running", "waiting"].includes(r.status));
    if (!run) return;
    this.failRun(run, message, code);
    queueMicrotask(() => void this.tick());
  }

  /** Fail runs whose turn is no longer in flight. `turnLive` is the harness's
   * view (the bot is busy on this run's thread); a run that only just started
   * gets a grace so the sweep never races the dispatch that marks the bot
   * busy. Returns the receipts it settled. */
  reconcileOrphanedRuns(now = this.now()): RoutineRun[] {
    const live = this.options.turnLive;
    if (!live) return [];
    const orphaned: RoutineRun[] = [];
    for (const run of this.runs) {
      if (run.coalescedInto) continue;
      if (run.status !== "running" && run.status !== "waiting") continue;
      if (!run.threadId || run.startedAt === undefined) continue;
      if (now - run.startedAt < ORPHAN_GRACE_MS) continue;
      if (live(run)) continue;
      this.failRun(run, "The bot stopped before this run finished");
      orphaned.push({ ...run });
    }
    return orphaned;
  }

  private failRun(run: RoutineRun, message: string, code = routineFailureCode(message)) {
    run.status = "failed";
    run.error = message.slice(0, 500);
    run.outcomeCode = code;
    run.failurePhase = routineFailurePhase(code);
    run.finishedAt = this.now();
    this.save();
    this.emitRun(run);
    this.options.onRunFailed?.({ ...run });
  }

  private initialOccurrence(schedule: RoutineSchedule, now: number): number | null {
    // Return the original time, not max(at, now): tick() already decides
    // whether a stale "once" run fires or is recorded as "missed" based on
    // how far past the scheduled time it is. Clamping to now here hides the
    // original schedule from the run receipt (scheduledFor would read "now"
    // instead of the time the user chose) and prevents the 12-hour missed
    // threshold from ever triggering for a "once" routine created late.
    if (schedule.type === "once") return schedule.at;
    return nextOccurrence(schedule, now);
  }

  private newRun(routine: Routine, scheduledFor: number, manual: boolean): RoutineRun {
    const run: RoutineRun = {
      id: randomUUID(),
      routineId: routine.id,
      routineName: routine.name,
      prompt: routine.prompt,
      durationMinutes: routine.durationMinutes,
      botId: routine.botId,
      runOn: routine.runOn ?? "maus",
      scheduledFor,
      status: "queued",
      manual,
      triggerSource: manual ? "manual" : "schedule",
      createdAt: this.now(),
    };
    this.runs.push(run);
    return run;
  }

  private emitRoutine(routine: Routine) {
    this.options.emit?.({ kind: "routine", routine: this.clientRoutine(routine, this.options.timeZone?.()) });
  }

  private clientRoutine(routine: Routine, effectiveTimeZone?: string): Routine {
    if (routine.schedule.type !== "daily") return { ...routine, schedule: { ...routine.schedule } };
    if (routine.schedule.timeZone) {
      return { ...routine, schedule: { ...routine.schedule }, scheduleTimeZoneSource: "stored" };
    }
    const schedule = effectiveTimeZone
      ? { ...routine.schedule, timeZone: effectiveTimeZone }
      : { ...routine.schedule };
    return { ...routine, schedule, scheduleTimeZoneSource: "host" };
  }

  private emitRun(run: RoutineRun) {
    this.options.emit?.({ kind: "routine.run", run: { ...run } });
    if (!run.coalescedInto) {
      for (const child of this.runs) {
        if (child.coalescedInto !== run.id) continue;
        this.copyCombinedOutcome(child, run);
        this.options.emit?.({ kind: "routine.run", run: { ...child } });
      }
    }
  }

  private copyCombinedOutcome(child: RoutineRun, owner: RoutineRun) {
    child.status = owner.status;
    child.finishedAt = owner.finishedAt;
    child.error = owner.error;
    child.outcomeCode = owner.outcomeCode;
    child.failurePhase = owner.failurePhase;
    child.engineId = owner.engineId;
    child.driver = owner.driver;
    child.model = owner.model;
    child.denials = owner.denials ? [...owner.denials] : undefined;
    child.output = owner.status === "completed" ? `Handled together with ${owner.routineName}` : undefined;
    // Only the owning turn is billable; never duplicate its usage charge.
    child.cost = undefined;
  }

  private matchingRoutineRequestReceipt(request: RoutineRequestCommit): RoutineRequestReceipt | null {
    const receipt = this.routineRequestReceipts.find((candidate) => candidate.requestId === request.requestId);
    if (!receipt) return null;
    if (
      receipt.action !== request.action ||
      receipt.messageId !== request.messageId ||
      receipt.botId !== request.botId ||
      receipt.threadId !== request.threadId ||
      receipt.fingerprintVersion !== request.fingerprintVersion ||
      receipt.fingerprint !== request.fingerprint
    ) {
      throw new Error("Routine request receipt does not match this confirmation card");
    }
    return receipt;
  }

  private rememberRoutineRequest(
    request: RoutineRequestCommit,
    resultId: string,
    appliedAt: number,
  ) {
    const existing = this.matchingRoutineRequestReceipt(request);
    if (existing) {
      if (existing.resultId !== resultId) throw new Error("Routine request receipt has another result");
      return;
    }
    this.routineRequestReceipts.unshift({ ...request, resultId, appliedAt });
  }

  /**
   * A confirmation receipt is only true once the scheduler mutation and its
   * receipt reached the same atomic file. Restore the complete in-memory
   * state if writing or renaming that file fails so a retry cannot mistake an
   * uncommitted action for a durable one.
   */
  private commitMutation(mutate: () => void): void {
    const before = {
      routines: this.routines.map((routine) => ({ ...routine, schedule: { ...routine.schedule } })),
      runs: this.runs.map((run) => ({ ...run, denials: run.denials ? [...run.denials] : undefined })),
      receipts: this.routineRequestReceipts.map((receipt) => ({ ...receipt })),
    };
    try {
      mutate();
      this.save();
    } catch (error) {
      this.routines = before.routines;
      this.runs = before.runs;
      this.routineRequestReceipts = before.receipts;
      throw error;
    }
  }

  private save() {
    const byId = new Map(this.runs.map((run) => [run.id, run]));
    for (const run of this.runs) {
      const owner = run.coalescedInto ? byId.get(run.coalescedInto) : undefined;
      if (owner) this.copyCombinedOutcome(run, owner);
    }
    const receiptResultIds = this.routineRequestReceipts
      .filter((receipt) => receipt.action === "run_now")
      .map((receipt) => receipt.resultId);
    this.runs = retainRoutineRuns(this.runs, MAX_RUNS, receiptResultIds);
    boundStalePromptSnapshots(this.runs, PROMPT_SNAPSHOT_LIMIT, receiptResultIds);
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify({
      version: 1,
      routines: this.routines,
      runs: this.runs,
      routineRequestReceipts: this.routineRequestReceipts,
    } satisfies RoutineFile, null, 2));
    renameSync(temp, this.file);
  }
}
