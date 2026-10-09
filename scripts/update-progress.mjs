// Progress recording for the transactional Mac updater.
//
// The updater has to run detached — it stops the harness and quits the
// desktop app, so it can be a child of neither — which means the only way
// anything can report on it is a file it writes as it goes.  This module is
// that file's writer.  `scripts/mac-update-transaction.mjs` already names
// every phase as a call on the operations adapter, so the recorder wraps
// that adapter instead of threading a reporter through the coordinator:
// one place to instrument, and no ordering logic duplicated.
//
// The reader is the harness (`server/update-control.ts`), which validates
// everything it reads here rather than trusting the shape.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const UPDATE_PROGRESS_SCHEMA_VERSION = 1;

/** Every operation the transaction calls, in the order a full `update` runs
 * them.  Used for the progress fraction and for nothing else: a step that is
 * called twice (the lock, the two preflights) counts once, and a step that
 * never runs for this sub-command simply never arrives. */
export const UPDATE_STEPS = Object.freeze([
  "acquireLock",
  "resolveTarget",
  "prepareSource",
  "assertStagingSource",
  "installDependencies",
  "buildBundle",
  "validateBundle",
  "smokeTestBundle",
  "persistPrepared",
  "validatePrepared",
  "preflight",
  "capturePrevious",
  "materializeCandidate",
  "fence",
  "quiesce",
  "assertQuiesced",
  "advanceCheckout",
  "installCandidate",
  "prepareCredentials",
  "startHarness",
  "verifyHarness",
  "startApplication",
  "verifySingleOwner",
  "finish",
]);

/** Sentences a person reads while they wait.  A missing entry falls back to
 * the operation name, so adding an operation never breaks the display. */
export const UPDATE_STEP_LABELS = Object.freeze({
  acquireLock: "Taking the update lock",
  resolveTarget: "Finding the newest build",
  prepareSource: "Staging a copy of the new source",
  assertStagingSource: "Checking the staged copy is separate",
  installDependencies: "Installing dependencies",
  buildBundle: "Building and signing the app",
  validateBundle: "Verifying the signature and identity",
  persistPrepared: "Recording the prepared build",
  validatePrepared: "Re-checking the prepared build",
  preflight: "Checking for work in flight",
  capturePrevious: "Snapshotting what is installed now",
  materializeCandidate: "Placing the new build alongside",
  fence: "Holding new work",
  quiesce: "Letting BotFleet finish and stop",
  assertQuiesced: "Confirming BotFleet stopped",
  advanceCheckout: "Advancing the checkout",
  installCandidate: "Installing the new build",
  prepareCredentials: "Preparing credentials",
  startHarness: "Starting the harness",
  verifyHarness: "Verifying the harness",
  startApplication: "Reopening BotFleet",
  verifySingleOwner: "Confirming a single owner",
  finish: "Finishing up",
  rollback: "Rolling back",
  cleanupCandidate: "Cleaning up the staged build",
  releaseSource: "Releasing the staged source",
});

const MAX_RECORDED_STEPS = 200;

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * One run's progress file.  Every transition rewrites the whole record
 * atomically: the reader is a separate process that may read at any moment,
 * and a torn JSON file would look like a crashed updater.
 */
export function createUpdateProgress({
  path,
  runId,
  command = "update",
  target = "origin/main",
  pid = process.pid,
  now = () => new Date(),
  write = atomicWrite,
}) {
  const startedAt = now().toISOString();
  const record = {
    schemaVersion: UPDATE_PROGRESS_SCHEMA_VERSION,
    runId,
    command,
    target,
    pid,
    startedAt,
    updatedAt: startedAt,
    step: null,
    stepIndex: 0,
    stepCount: UPDATE_STEPS.length,
    progress: 0,
    steps: [],
    targetCommit: null,
    receiptPath: null,
    rolledBack: false,
    crossedBoundary: false,
    finishedAt: null,
    outcome: null,
    message: null,
  };
  const reached = new Set();

  const flush = () => {
    record.updatedAt = now().toISOString();
    try {
      write(path, record);
    } catch {
      // Once the run is under way progress IS a courtesy: an unwritable cache
      // directory, or one that fills mid-build, must never be the reason an
      // update stops half-installed.  The first write, below, is the half of
      // this that is not a courtesy.
    }
  };

  // The first write is mandatory, and it happens before the caller has an
  // instrumented adapter to run anything with.
  //
  // A run whose progress file never lands is a run nothing can describe: the
  // harness waits out its launch grace period, settles the job as "never
  // started" and drops the record, while the updater goes on to replace the
  // app, restart the harness and reboot the desktop — and the person is told
  // nothing happened.  Proving the channel first turns that silent divergence
  // into a run that refuses to begin, with the reason in the updater's own
  // log.  The record it writes names the run but no step yet, which is
  // exactly true: the transaction has not started.
  try {
    write(path, record);
  } catch (error) {
    throw new Error(
      `Cannot record update progress at ${path}: ${String(error?.message ?? error)}.`
      + "  Refusing to start an update that nothing could report on.",
    );
  }

  const begin = (name) => {
    record.step = name;
    if (name === "quiesce") record.crossedBoundary = true;
    const position = UPDATE_STEPS.indexOf(name);
    if (position >= 0) {
      reached.add(name);
      record.stepIndex = position + 1;
      record.progress = Math.min(1, reached.size / UPDATE_STEPS.length);
    }
    if (record.steps.length < MAX_RECORDED_STEPS) {
      record.steps.push({ name, startedAt: now().toISOString(), finishedAt: null, ok: null });
    }
    flush();
  };

  const end = (name, ok) => {
    for (let index = record.steps.length - 1; index >= 0; index -= 1) {
      if (record.steps[index].name === name && record.steps[index].finishedAt === null) {
        record.steps[index].finishedAt = now().toISOString();
        record.steps[index].ok = ok;
        break;
      }
    }
    if (ok && name === "rollback") record.rolledBack = true;
    flush();
  };

  return {
    record,
    begin,
    end,
    note(patch) {
      Object.assign(record, patch);
      flush();
    },
    finish(outcome, message) {
      record.finishedAt = now().toISOString();
      record.outcome = outcome;
      record.message = message ?? null;
      record.step = null;
      if (outcome === "verified") record.progress = 1;
      flush();
    },
  };
}

/** Which of the four outcomes the harness should show for a failed run. */
export function outcomeForError(error, { rolledBack = false } = {}) {
  if (rolledBack) return "rolled-back";
  const errors = error instanceof AggregateError ? [error, ...error.errors] : [error];
  return errors.some((one) => one?.name === "UpdateRefusedError") ? "refused" : "failed";
}

/** The first line of a failure, with no path or command echo beyond what the
 * updater already prints to its own log. */
export function outcomeMessage(error) {
  const text = String(error?.message ?? error ?? "The update failed.").trim();
  return (text.split("\n")[0] || "The update failed.").slice(0, 400);
}

/**
 * Wrap the operations adapter so every call it receives is recorded.
 * `acquireLock` returns a releasable handle rather than a value, so its
 * "end" is the release; everything else ends when its promise settles.
 */
export function instrumentOperations(operations, progress) {
  const wrapped = {};
  for (const [name, operation] of Object.entries(operations)) {
    if (typeof operation !== "function") {
      wrapped[name] = operation;
      continue;
    }
    wrapped[name] = async (...args) => {
      progress.begin(name);
      let result;
      try {
        result = await operation(...args);
      } catch (error) {
        progress.end(name, false);
        throw error;
      }
      if (name === "persistPrepared" && result?.manifestPath) {
        progress.note({ receiptPath: result.manifestPath, targetCommit: result.targetCommit ?? null });
      }
      if (name === "resolveTarget" && typeof result === "string") progress.note({ targetCommit: result });
      progress.end(name, true);
      return result;
    };
  }
  return wrapped;
}
