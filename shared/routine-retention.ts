interface RetainedRun {
  id: string;
  status: string;
  createdAt: number;
  finishedAt?: number;
  coalescedInto?: string;
  routineId?: string;
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "missed"]);

/** Runs that history bounds must never touch: work still awaiting a result,
 * the owner it folds into, and every run a run-now receipt still points at. */
function protectedRunIds(runs: readonly RetainedRun[], receiptResultIds: Iterable<string>): Set<string> {
  const protectedIds = new Set(receiptResultIds);
  for (const run of runs) {
    if (!TERMINAL.has(run.status)) {
      protectedIds.add(run.id);
      if (run.coalescedInto) protectedIds.add(run.coalescedInto);
    }
  }
  return protectedIds;
}

const settledAt = (run: RetainedRun) => run.finishedAt ?? run.createdAt;

/** Default terminal run history window — seven days at typical webhook volume. */
export const DEFAULT_ROUTINE_RUN_RETENTION_DAYS = 7;
/** Hard cap on evictable terminal runs after the time window (memory / disk bound). */
export const ROUTINE_RUN_TERMINAL_SAFETY_CAP = 30_000;
const MS_PER_DAY = 86_400_000;

/** Parse `BOTFLEET_ROUTINE_RUN_RETENTION_DAYS` (or any day count string). */
export function parseRoutineRunRetentionDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_ROUTINE_RUN_RETENTION_DAYS;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ROUTINE_RUN_RETENTION_DAYS;
  return n;
}

export function routineRunRetentionMaxAgeMs(days: number): number {
  return days * MS_PER_DAY;
}

export type RoutineRunRetentionTime = {
  /** Drop terminal candidates settled before `nowMs - maxAgeMs`. */
  maxAgeMs: number;
  /** Clock for the age cutoff (tests pin this). */
  nowMs?: number;
};

const routineGroupKey = (run: RetainedRun) => run.routineId ?? "";

type CandidateGroup<T extends RetainedRun> = {
  sorted: T[];
  discard: number;
};

function oldestCandidateAt<T extends RetainedRun>(group: CandidateGroup<T>): number {
  return settledAt(group.sorted[group.discard]);
}

function remainingInGroup<T extends RetainedRun>(group: CandidateGroup<T>): number {
  return group.sorted.length - group.discard;
}

/** Drop `excess` oldest terminal candidates fairly across routines: each step removes
 * the oldest run from a routine that currently holds the most evictable terminal runs
 * (ties → the routine whose oldest candidate settled first). Runs without `routineId`
 * share one group. */
function fairDiscardCounts<T extends RetainedRun>(groups: CandidateGroup<T>[], excess: number): void {
  if (excess <= 0) return;
  const order = () =>
    groups
      .map((group, index) => ({ group, index }))
      .filter(({ group }) => remainingInGroup(group) > 0)
      .sort((a, b) => {
        const ra = remainingInGroup(a.group);
        const rb = remainingInGroup(b.group);
        if (rb !== ra) return rb - ra;
        return oldestCandidateAt(a.group) - oldestCandidateAt(b.group);
      });

  let left = excess;
  while (left > 0) {
    const ranked = order();
    if (ranked.length === 0) break;
    const topRem = remainingInGroup(ranked[0]!.group);
    let cohortEnd = 1;
    while (cohortEnd < ranked.length && remainingInGroup(ranked[cohortEnd]!.group) === topRem) {
      cohortEnd += 1;
    }
    const nextRem = cohortEnd < ranked.length ? remainingInGroup(ranked[cohortEnd]!.group) : 0;
    const gap = topRem - nextRem;
    const cohort = cohortEnd;
    const batch = Math.min(left, cohort * gap);
    if (batch === cohort * gap) {
      for (let i = 0; i < cohort; i += 1) ranked[i]!.group.discard += gap;
      left -= batch;
      continue;
    }
    if (cohort === 1) {
      ranked[0]!.group.discard += batch;
      left -= batch;
      continue;
    }
    for (let step = 0; step < batch; step += 1) {
      order()[0]!.group.discard += 1;
    }
    left -= batch;
  }
}

/** Bound terminal history fairly across routines, never the work still awaiting a result.
 * When `time` is set, terminal candidates older than the window go first.  When survivors
 * still exceed `terminalLimit`, the oldest terminal runs go next, but only from the
 * routine(s) that currently hold the most evictable terminal history — so one noisy
 * routine cannot evict another routine's incidents. Protected runs (non-terminal,
 * their coalesced owner, and receipt targets) are never discarded; the input array is not
 * mutated; kept runs stay in their original order. Active groups are bounded by admission
 * policy and leave this tail on settlement. */
export function retainRoutineRuns<T extends RetainedRun>(
  runs: T[],
  terminalLimit: number,
  receiptResultIds: Iterable<string> = [],
  time?: RoutineRunRetentionTime,
): T[] {
  if (!Number.isSafeInteger(terminalLimit) || terminalLimit < 1) throw new RangeError("Invalid history limit");
  const protectedIds = protectedRunIds(runs, receiptResultIds);
  const candidates = runs.filter((run) => !protectedIds.has(run.id));
  const discard = new Set<string>();
  const nowMs = time?.nowMs ?? Date.now();
  const ageCutoff = time ? nowMs - time.maxAgeMs : Number.NEGATIVE_INFINITY;
  const survivors: T[] = [];
  for (const run of candidates) {
    if (time && settledAt(run) < ageCutoff) discard.add(run.id);
    else survivors.push(run);
  }
  const excess = survivors.length - terminalLimit;
  if (excess <= 0 && discard.size === 0) return runs;

  if (excess > 0) {
    const byRoutine = new Map<string, T[]>();
    for (const run of survivors) {
      const key = routineGroupKey(run);
      let bucket = byRoutine.get(key);
      if (!bucket) {
        bucket = [];
        byRoutine.set(key, bucket);
      }
      bucket.push(run);
    }

    const groups: CandidateGroup<T>[] = [];
    for (const sorted of byRoutine.values()) {
      sorted.sort((a, b) => settledAt(a) - settledAt(b));
      groups.push({ sorted, discard: 0 });
    }

    fairDiscardCounts(groups, excess);

    for (const group of groups) {
      for (let i = 0; i < group.discard; i += 1) discard.add(group.sorted[i]!.id);
    }
  }
  if (discard.size === 0) return runs;
  return runs.filter((run) => !discard.has(run.id));
}

/** Size bounds for a settled run's prompt snapshot.  `dataChars` is how much of
 * each untrusted event block (`[UNTRUSTED WEBHOOK EVENT DATA] … [/UNTRUSTED
 * WEBHOOK EVENT DATA]`) survives; `maxChars` caps the whole snapshot. */
export interface PromptSnapshotBounds {
  dataChars: number;
  maxChars: number;
}

export const PROMPT_SNAPSHOT_BOUNDS: PromptSnapshotBounds = { dataChars: 500, maxChars: 4_000 };

const UNTRUSTED_BLOCK = /\[(UNTRUSTED [A-Z ]+DATA)\]\n([\s\S]*?)\n\[\/\1\]/g;
const TRIMMED = /\n…\[\d+ more characters not kept in history\]$/;

function trimmed(kept: string, dropped: number): string {
  return `${kept}\n…[${dropped} more characters not kept in history]`;
}

/** Shrink a prompt snapshot for history: every untrusted event block keeps its
 * first `dataChars` characters, then the whole text is capped at `maxChars`.
 * Everything the UI parses stays where it is — the `Event:` line, the
 * user-configured instructions block, and the opening and closing markers of
 * the event block — so the Routines page and the webhook delivery list read a
 * bounded snapshot exactly as they read a full one.  Idempotent: a snapshot
 * that already carries the trim marker is left alone. */
export function boundPromptSnapshot(prompt: string, bounds: PromptSnapshotBounds = PROMPT_SNAPSHOT_BOUNDS): string {
  let out = prompt.replace(UNTRUSTED_BLOCK, (whole, name: string, body: string) =>
    body.length <= bounds.dataChars || TRIMMED.test(body)
      ? whole
      : `[${name}]\n${trimmed(body.slice(0, bounds.dataChars), body.length - bounds.dataChars)}\n[/${name}]`);
  if (out.length > bounds.maxChars && !TRIMMED.test(out)) {
    out = trimmed(out.slice(0, bounds.maxChars), out.length - bounds.maxChars);
  }
  return out;
}

/** Bound the prompt snapshot of settled runs older than the newest `keepNewest`.
 *
 * The snapshot is the bulk of a run receipt — a webhook run carries its whole
 * payload — and 2,000 of them made routines.json 35 MB, which every synchronous
 * save then re-serialized on the harness main thread.  Under memory pressure
 * that stalled the event loop for seconds at a time, the accept backlog filled,
 * and the desktop app's health probes saw resets.  Webhook and resource runs
 * have no routine to fall back to (their `routineId` is the trigger id), so the
 * snapshot is bounded, never dropped.  Protected runs (active, folded-into,
 * receipt-referenced) always keep the full text because dispatch still needs
 * it.  Mutates in place; returns the number of snapshots shortened. */
export function boundStalePromptSnapshots<T extends RetainedRun & { prompt?: string }>(
  runs: T[],
  keepNewest: number,
  receiptResultIds: Iterable<string> = [],
  bounds: PromptSnapshotBounds = PROMPT_SNAPSHOT_BOUNDS,
): number {
  if (!Number.isSafeInteger(keepNewest) || keepNewest < 0) throw new RangeError("Invalid prompt snapshot limit");
  const protectedIds = protectedRunIds(runs, receiptResultIds);
  const settled = runs.filter((run) => !protectedIds.has(run.id) && run.prompt !== undefined);
  settled.sort((a, b) => settledAt(b) - settledAt(a));
  let shortened = 0;
  for (const run of settled.slice(keepNewest)) {
    const bounded = boundPromptSnapshot(run.prompt as string, bounds);
    if (bounded !== run.prompt) {
      run.prompt = bounded;
      shortened += 1;
    }
  }
  return shortened;
}
