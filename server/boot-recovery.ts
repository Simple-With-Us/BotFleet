// One coordinator for every way a turn can come back after the process
// stopped.  Before this, two independent paths re-dispatched work at boot and
// neither knew what the other had done:
//
//   - `recoverInflightTurn` fired 2.5 s after boot for EVERY bot whose
//     `inflightThreadId` survived, all at once, with no cap — and a graceful
//     SIGTERM was indistinguishable from a crash, so every ordinary restart
//     re-spent a full CLI turn per busy bot (audit HS18);
//   - `resumeInterruptedChatTurns` re-dispatched the turns a forced update had
//     interrupted, from a snapshot written before the restart, and could land
//     on a thread the timer above was about to take (audit HS20).
//
// The rules this module encodes:
//
//   1. The question is not "did the process die mid-turn" — a clean SIGTERM
//      and a crash answer that identically.  It is "can the harness PROVE the
//      provider never saw this prompt", decided by the same classifier the
//      drivers use for a mid-run resume (server/resume-recovery.ts).  Only a
//      `before-accept` turn is sent again; an `after-accept` or `unknown` one
//      continues the provider's own session, or says so in the thread and
//      waits for the person.
//   2. A graceful stop RECORDS what it interrupted, and classifies it while
//      the evidence is freshest, so the next boot acts deliberately instead
//      of inferring from a marker that looks identical to a crash.
//   3. A thread whose last persisted event says the turn already finished is
//      never resumed.  The marker is a crash hint, not evidence.
//   4. A resume that failed terminally is remembered, so the next boot does
//      not retry it forever — only new user input clears it.
//   5. Resumes go out staggered, with a concurrency cap and a total cap that
//      is logged, so a restart never becomes a retry storm (owner ruling,
//      2026-09-22).
//
// The on-disk record is a versioned object, not a bare array, so the work
// that restores a person's queued steer/channel follow-ups across a restart
// (upstream keeps them as `chat_followups` rows) can add its own field here
// without a migration.
//
// Everything here is pure or file-local so it carries tests without booting a
// harness; server/index.ts owns the wiring.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import {
  classifyResumeFailure,
  mayReplay,
  type ResumeAttemptState,
  type ResumeFailureClass,
} from "./resume-recovery.ts";

/** About one resume every two seconds.  Slow enough that a fleet of bots does
 * not hit the provider as one burst, fast enough that a person watching the
 * app sees their work pick up again. */
export const BOOT_RESUME_STAGGER_MS = 2_000;
/** At most this many resumed turns in flight at once. */
export const BOOT_RESUME_CONCURRENCY = 3;
/** Hard ceiling on how many threads ONE boot may resume.  A data directory
 * with more interrupted threads than this is a symptom (a crash loop, a
 * restart storm); resuming all of them would multiply the spend that caused
 * it.  The remainder is skipped and logged, and the user can restart any of
 * them by hand. */
export const BOOT_RESUME_TOTAL_CAP = 8;
/** How much of a thread's event log the outcome probe reads.  A turn's
 * closing events are the last thing written, so the newest 64 KB answers the
 * question without the whole-file read that makes boot expensive (HS11). */
export const EVENT_TAIL_BYTES = 64 * 1024;
/** Remembered resume failures, newest first.  Bounded so the file cannot grow
 * for the life of the install. */
export const MAX_REMEMBERED_FAILURES = 200;

export const INTERRUPTED_TURNS_FILE = "interrupted-turns.json";

/** Why a turn stopped.  `shutdown` is a SIGTERM/SIGINT the harness handled;
 * `update` is the quiesce an updater forced.  Both are deliberate — a crash
 * writes no record at all, which is exactly how the two are told apart. */
export type InterruptReason = "shutdown" | "update";

export interface InterruptedTurnRecord {
  botId: string;
  threadId: string;
  /** When the stop happened, epoch ms. */
  at: number;
  reason: InterruptReason;
  /** Which side of the provider's accept boundary this turn died on, decided
   * at shutdown.  Boot reconciles it with the drained event log; only a
   * `before-accept` turn without contrary evidence may be sent again.
   * Absent on a record written by an older build — the boot re-derives. */
  classification?: ResumeFailureClass;
}

export interface ResumeFailureRecord {
  botId: string;
  threadId: string;
  at: number;
  error?: string;
}

export interface InterruptedTurnsFile {
  version: 1;
  recordedAt: number;
  turns: InterruptedTurnRecord[];
  /** Resumes that failed terminally on an earlier boot.  Kept ACROSS the
   * consumption of `turns`, because its whole job is to stop the next boot
   * retrying the same doomed thread. */
  failures: ResumeFailureRecord[];
}

export function interruptedTurnsPath(dataDir: string): string {
  return join(dataDir, INTERRUPTED_TURNS_FILE);
}

function emptyFile(): InterruptedTurnsFile {
  return { version: 1, recordedAt: 0, turns: [], failures: [] };
}

/** Never throws: a missing, truncated, or foreign file means "no record",
 * which is the same thing a crash leaves behind and is always safe. */
export function readInterruptedTurns(dataDir: string): InterruptedTurnsFile {
  const path = interruptedTurnsPath(dataDir);
  if (!existsSync(path)) return emptyFile();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<InterruptedTurnsFile>;
    const turns = Array.isArray(parsed.turns)
      ? parsed.turns.filter(
          (turn): turn is InterruptedTurnRecord =>
            Boolean(turn) && typeof turn.botId === "string" && typeof turn.threadId === "string",
        )
      : [];
    const failures = Array.isArray(parsed.failures)
      ? parsed.failures.filter(
          (failure): failure is ResumeFailureRecord =>
            Boolean(failure) && typeof failure.botId === "string" && typeof failure.threadId === "string",
        )
      : [];
    return {
      version: 1,
      recordedAt: typeof parsed.recordedAt === "number" ? parsed.recordedAt : 0,
      turns,
      failures,
    };
  } catch {
    return emptyFile();
  }
}

export function writeInterruptedTurns(dataDir: string, file: InterruptedTurnsFile): void {
  writeFileAtomic(interruptedTurnsPath(dataDir), JSON.stringify(file, null, 2), { mode: 0o600 });
}

/** Record what a graceful stop interrupted, keeping the failure memory that
 * is already on disk.  Called from a signal handler, so it is synchronous and
 * swallows its own errors: a shutdown that cannot write this file must still
 * shut down. */
export function recordInterruptedTurns(
  dataDir: string,
  turns: InterruptedTurnRecord[],
  now = Date.now(),
): boolean {
  try {
    const existing = readInterruptedTurns(dataDir);
    writeInterruptedTurns(dataDir, {
      version: 1,
      recordedAt: now,
      turns,
      failures: existing.failures,
    });
    return true;
  } catch {
    return false;
  }
}

/** Consume the shutdown record: the turns are handed to the caller once, and
 * the file is rewritten with the failure memory alone.  Consuming rather than
 * deleting is the point — a record read twice would resume twice. */
export function takeInterruptedTurns(dataDir: string): InterruptedTurnsFile {
  const file = readInterruptedTurns(dataDir);
  if (file.turns.length === 0 && file.failures.length === 0) return file;
  try {
    if (file.failures.length === 0) unlinkSync(interruptedTurnsPath(dataDir));
    else writeInterruptedTurns(dataDir, { ...file, turns: [], recordedAt: file.recordedAt });
  } catch {
    // A record we could not clear is worse than one we could, but not worth
    // refusing the boot over: the settled-turn check below still stops the
    // same thread being resumed a second time.
  }
  return file;
}

/** Remember a resume that failed terminally, so the next boot leaves it
 * alone.  New user input clears it (`forgetResumeFailure`). */
export function rememberResumeFailure(
  dataDir: string,
  failure: ResumeFailureRecord,
): void {
  try {
    const file = readInterruptedTurns(dataDir);
    const failures = [
      failure,
      ...file.failures.filter((f) => !(f.botId === failure.botId && f.threadId === failure.threadId)),
    ].slice(0, MAX_REMEMBERED_FAILURES);
    writeInterruptedTurns(dataDir, { ...file, failures });
  } catch {
    // Best effort.  Losing the memory costs one wasted resume, not correctness.
  }
}

/** New user input on a thread means the person wants it running again —
 * whatever failed last boot is no longer a reason to refuse. */
export function forgetResumeFailure(dataDir: string, botId: string, threadId: string): void {
  try {
    const file = readInterruptedTurns(dataDir);
    if (!file.failures.some((f) => f.botId === botId && f.threadId === threadId)) return;
    writeInterruptedTurns(dataDir, {
      ...file,
      failures: file.failures.filter((f) => !(f.botId === botId && f.threadId === threadId)),
    });
  } catch {
    // Best effort, as above.
  }
}

/** What the thread's own event log says happened last.
 *
 * - `completed` — the newest turn lifecycle event is `turn.completed`.  The
 *   turn finished; a surviving `inflightThreadId` is a stale marker (the
 *   process died between the reply landing and the marker clearing), and
 *   resuming would re-spend a whole turn for work already done.
 * - `failed` — the newest is a setup error, which means the engine could not
 *   start.  Retrying it on the next boot is the retry storm, not a recovery.
 * - `in-flight` — anything else, including a missing or unreadable log.
 *   Treat as genuinely interrupted: that is the crash case this whole path
 *   exists for, and the safe default is the one that does not silently drop
 *   a person's work. */
export type TurnOutcome = "completed" | "failed" | "in-flight";

export interface LastTurnInspection {
  outcome: TurnOutcome;
  /** The three facts `classifyResumeFailure` reads, recovered from the log
   * instead of from live protocol state. */
  state: ResumeAttemptState;
  /** Whether this turn may be REPLAYED — i.e. whether the harness can prove
   * the provider never saw the prompt. */
  classification: ResumeFailureClass;
}

/** One newest-first tail read per interrupted thread, folded into the
 * evidence the classifier wants.
 *
 * Which events prove what, and why it is not simply "did the turn start":
 *
 *   - `turn.started` proves NOTHING about the provider.  Every driver emits
 *     it before the prompt is written (claude.ts:740/1101 emits it, THEN
 *     `writeUser`; openai-compat.ts:424 emits it before the request), so a
 *     turn that reached `turn.started` and died may never have been seen.
 *   - `session.started` with a real session id does: a driver only learns a
 *     session id from the provider, and by then the prompt is already on its
 *     way.  A null session id (openai-compat's placeholder) proves nothing.
 *   - Any turn-scoped output — an item, a token-usage tick — is the strongest
 *     evidence there is, and outranks everything.
 *   - A setup `runtime.error` with nothing after it is the engine failing to
 *     start at all: attempted, rejected, prompt never submitted.  That is the
 *     one shape the harness may safely send again. */
export function inspectLastTurn(
  eventsDir: string,
  threadId: string,
  tailBytes = EVENT_TAIL_BYTES,
): LastTurnInspection {
  const lines = tailLines(join(eventsDir, `${threadId}.ndjson`), tailBytes);
  let outcome: TurnOutcome = "in-flight";
  let attempted = false;
  let rejected = false;
  let promptSubmitted = false;
  let producedOutput = false;
  let sawTurnStart = false;
  let sawTerminal = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    let event: { type?: string; setup?: boolean; sessionId?: string | null; ok?: boolean };
    try {
      event = JSON.parse(line) as { type?: string; setup?: boolean; sessionId?: string | null; ok?: boolean };
    } catch {
      continue;
    }
    // A failed completion may be the terminal event emitted by shutdown's
    // own interrupt.  Keep scanning that turn: output queued *before* the
    // terminal event still proves the provider accepted the prompt.  A
    // successful completion is settled, so no replay decision is needed.
    if (event.type === "turn.completed") {
      if (sawTerminal) break; // Never mix in evidence from an earlier turn.
      sawTerminal = true;
      outcome = event.ok === false ? "failed" : "completed";
      if (event.ok !== false) break;
      continue;
    }
    switch (event.type) {
      case "item.started":
      case "item.completed":
      case "thread.token-usage.updated":
        producedOutput = true;
        break;
      case "session.started":
        if (typeof event.sessionId === "string" && event.sessionId.length > 0) promptSubmitted = true;
        break;
      case "session.exited":
        attempted = true;
        rejected = true;
        break;
      case "runtime.error":
        if (event.setup === true) {
          attempted = true;
          rejected = true;
          if (!producedOutput) outcome = "failed";
        }
        break;
      case "turn.started":
        // The oldest event of the turn in flight: everything this scan needed
        // has been read.
        sawTurnStart = true;
        break;
      default:
        break;
    }
    if (sawTurnStart) break;
  }
  const state: ResumeAttemptState = { attempted, rejected, promptSubmitted, producedOutput };
  return { outcome, state, classification: classifyResumeFailure(state) };
}

/** The classification a graceful stop may write BEFORE the canonical event
 * log's queued writer has drained (server/harness/bus.ts).  Accept evidence
 * can still be sitting in that queue, so a `before-accept` reading taken at
 * that moment is only provisional and is written as `unknown`, which never
 * licenses a replay.  `after-accept` needs no drain: later records cannot
 * un-accept a prompt. */
export function provisionalStopClassification(early: ResumeFailureClass): ResumeFailureClass {
  return early === "after-accept" ? "after-accept" : "unknown";
}

/** The classification a stop records once the writer HAS drained: the log is
 * now complete for the turn, so its reading replaces the provisional one —
 * except that an accept already seen is never given back. */
export function settledStopClassification(
  provisional: ResumeFailureClass,
  drained: ResumeFailureClass,
): ResumeFailureClass {
  return provisional === "after-accept" ? "after-accept" : drained;
}

/** Merge a stop's snapshot with the log after its queued writer drained.
 * A positive accept signal always wins. An explicit unknown stop record means
 * the flush may have timed out: a partial log cannot upgrade it to replayable.
 * No record (a crash/older build) uses the inspected log as before. */
export function reconcileRecoveryClassification(
  recorded: ResumeFailureClass | undefined,
  inspected: ResumeFailureClass,
): ResumeFailureClass {
  if (recorded === "after-accept" || inspected === "after-accept") return "after-accept";
  if (recorded === "unknown") return "unknown";
  if (recorded === "before-accept" || inspected === "before-accept") return "before-accept";
  return "unknown";
}

/** The newest whole lines of a file, without reading the whole file.  The
 * first line of the window is dropped when the window did not start at byte
 * zero: it is a record cut in half, not a record. */
function tailLines(path: string, tailBytes: number): string[] {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const length = size - start;
    if (length <= 0) return [];
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

export interface BootRecoveryCandidate {
  botId: string;
  botName: string;
  threadId: string;
  /** A graceful stop recorded this exact turn. */
  recorded: boolean;
  /** What the thread's event log says the turn did last. */
  outcome: TurnOutcome;
  /** Which side of the provider's accept boundary the turn died on. */
  classification: ResumeFailureClass;
  /** The driver kept a native session for this thread, so the turn can be
   * continued where it stopped instead of re-sent. */
  resumableSession: boolean;
  /** An earlier boot already resumed this thread and the resume failed
   * terminally, with no new user input since. */
  failedBefore: boolean;
}

/** What this boot will do with an interrupted thread.
 *
 * - `replay` — the harness can PROVE the provider never saw the prompt, so
 *   sending it once more causes nothing twice.
 * - `continue` — the provider may already have acted.  Resume its own
 *   session with a continuation notice; never re-send the prompt.
 * - `notify` — the provider may already have acted and there is no session
 *   to resume.  Say so in the thread and let the person decide; a guess here
 *   is a duplicate side effect, and a silent drop is a lost turn. */
export type BootRecoveryAction = "replay" | "continue" | "notify";

export type BootRecoverySkipReason = "completed" | "failed" | "failed-before" | "over-cap";

export interface BootRecoveryDispatch {
  candidate: BootRecoveryCandidate;
  action: BootRecoveryAction;
}

export interface BootRecoveryPlan {
  /** Threads that will reach a provider, in dispatch order. */
  resume: BootRecoveryDispatch[];
  /** Threads that get a "turn interrupted" chip and nothing else. */
  notify: BootRecoveryCandidate[];
  skipped: Array<{ candidate: BootRecoveryCandidate; reason: BootRecoverySkipReason }>;
  /** The total cap this plan was built against, so the caller can log it. */
  cap: number;
}

/** Decide what this boot does with each interrupted thread.
 *
 * Resuming after a restart stays the feature it was (PR #514); the question
 * it asks changed.  It used to be "did the process die mid-turn", which a
 * clean SIGTERM and a crash answer identically.  It is now "can the harness
 * prove the provider never saw this prompt" — and only that proof licenses a
 * re-send.  Everything else either continues the provider's own session or
 * tells the person, which is the difference between recovering work and
 * paying for it twice.
 *
 * On top of that: a turn the log says finished is dropped, a resume that
 * already failed terminally is dropped, and what is left is capped.  Recorded
 * stops are ordered first inside the cap, because a graceful stop is the one
 * case where the harness KNOWS the work was mid-flight rather than inferring
 * it from a marker. */
export function planBootRecovery(
  candidates: BootRecoveryCandidate[],
  opts: { totalCap?: number } = {},
): BootRecoveryPlan {
  const cap = opts.totalCap ?? BOOT_RESUME_TOTAL_CAP;
  const resume: BootRecoveryDispatch[] = [];
  const notify: BootRecoveryCandidate[] = [];
  const skipped: BootRecoveryPlan["skipped"] = [];
  const eligible: BootRecoveryCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.outcome === "completed") {
      skipped.push({ candidate, reason: "completed" });
      continue;
    }
    if (candidate.outcome === "failed") {
      skipped.push({ candidate, reason: "failed" });
      continue;
    }
    if (candidate.failedBefore) {
      skipped.push({ candidate, reason: "failed-before" });
      continue;
    }
    if (!mayReplay(candidate.classification) && !candidate.resumableSession) {
      // Nothing to continue and no licence to re-send: a chip costs nothing
      // and is the only honest answer.
      notify.push(candidate);
      continue;
    }
    eligible.push(candidate);
  }
  // Stable within each group: a recorded stop is more certain than a marker,
  // so it wins a slot under the cap first.
  const ordered = [
    ...eligible.filter((candidate) => candidate.recorded),
    ...eligible.filter((candidate) => !candidate.recorded),
  ];
  for (const candidate of ordered) {
    if (resume.length < cap) {
      resume.push({ candidate, action: mayReplay(candidate.classification) ? "replay" : "continue" });
    } else {
      skipped.push({ candidate, reason: "over-cap" });
    }
  }
  return { resume, notify, skipped, cap };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Dispatch resumes one every `staggerMs`, never more than `concurrency` in
 * flight.  Resolves when every dispatch has settled, so a caller can log a
 * single closing line.  `sleep` is injected for tests. */
export async function runStaggeredResumes<T>(
  items: T[],
  opts: {
    dispatch: (item: T, index: number) => Promise<void>;
    staggerMs?: number;
    concurrency?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<void> {
  const staggerMs = opts.staggerMs ?? BOOT_RESUME_STAGGER_MS;
  const concurrency = Math.max(1, opts.concurrency ?? BOOT_RESUME_CONCURRENCY);
  const sleep = opts.sleep ?? defaultSleep;
  const inFlight = new Set<Promise<void>>();
  for (let index = 0; index < items.length; index++) {
    if (index > 0 && staggerMs > 0) await sleep(staggerMs);
    while (inFlight.size >= concurrency) await Promise.race(inFlight);
    const started = opts
      .dispatch(items[index]!, index)
      .catch(() => {})
      .finally(() => inFlight.delete(started));
    inFlight.add(started);
  }
  await Promise.all(inFlight);
}
