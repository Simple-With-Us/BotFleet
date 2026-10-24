export class UpdateRefusedError extends Error {
  constructor(message) {
    super(message);
    this.name = "UpdateRefusedError";
  }
}

function requireSafe(snapshot, phase) {
  if (!snapshot?.safe) {
    throw new UpdateRefusedError(
      snapshot?.reason || `BotFleet runtime readiness is ambiguous during ${phase}; refusing to interrupt it`,
    );
  }
}

/**
 * Build and validate a replacement without touching the live checkout, bundle,
 * or processes.  Validation ends with actually running the candidate
 * (`smokeTestBundle`), so a stage is only ever published for an artifact that
 * has been proven to start.  The concrete adapter owns filesystem and command
 * details; this coordinator keeps the ordering testable.
 */
export async function prepareUpdate(plan, ops) {
  const lock = await ops.acquireLock("prepare");
  let source;
  try {
    const targetCommit = await ops.resolveTarget(plan);
    source = await ops.prepareSource({ ...plan, targetCommit });
    await ops.assertStagingSource(source, targetCommit);
    await ops.installDependencies(source, targetCommit);
    const builtBundle = await ops.buildBundle(source, targetCommit);
    const identity = await ops.validateBundle(builtBundle, targetCommit);
    // Prove the candidate actually STARTS before anything is published or
    // installed.  Signature and build-identity checks read files; this one runs
    // the artifact, which is the only check that can catch a bundle that
    // verifies perfectly and dies on launch.  It sits here, inside prepare,
    // because prepare is the last phase that touches nothing live — no
    // capturePrevious, no candidate copy, no launchctl, no /Applications
    // rename — so a failure here costs a staging directory.
    await ops.smokeTestBundle(builtBundle, targetCommit);
    return await ops.persistPrepared({
      plan,
      source,
      targetCommit,
      builtBundle,
      identity,
    });
  } finally {
    try {
      if (source) await ops.releaseSource(source);
    } finally {
      await lock.release();
    }
  }
}

/**
 * Hold SIGINT and SIGTERM from the interruption boundary until the install or
 * its rollback has finished.  Past the boundary BotFleet is stopped, so a
 * signal that killed the updater there left the Mac with no BotFleet at all
 * (2026-10-09: the bots were offline until the owner relaunched the app by
 * hand).  A held signal is reported and the run ends once BotFleet is running
 * again; nothing is skipped to honour it sooner.
 */
function holdSignals(signals) {
  let listeners = [];
  let heldBy = null;
  return {
    hold() {
      if (!signals?.on || listeners.length) return;
      listeners = ["SIGINT", "SIGTERM"].map((signal) => {
        const listener = () => {
          heldBy ??= signal;
          console.error(`${signal} received: finishing the install (or its rollback) first, so BotFleet is not left stopped.`);
        };
        signals.on(signal, listener);
        return [signal, listener];
      });
    },
    release() {
      for (const [signal, listener] of listeners) signals?.off?.(signal, listener);
      listeners = [];
      return heldBy;
    },
  };
}

/**
 * Apply one already-validated stage.  There are two readiness checks: one
 * before any install preparation and one immediately before the interruption
 * boundary.  Every failure after that boundary attempts a complete rollback.
 *
 * Whatever happens, the run ends with BotFleet running (`ensureRunning`): a
 * harness found stopped is started before the first check, and every failure
 * path — refused, rolled back, a rollback that failed or was deferred — makes
 * sure the prior build, or the replacement a deferred rollback kept, is up
 * again.  Past the boundary, signals wait for the transaction to finish.
 */
export async function applyPreparedUpdate(prepared, options, ops) {
  const lock = await ops.acquireLock("apply");
  let previous;
  let crossedBoundary = false;
  const signals = holdSignals(options?.signals);
  try {
    await ops.validatePrepared(prepared);
    // What an earlier run left behind (a candidate bundle or dependency tree
    // whose updater is gone) never blocks this one.
    try {
      await ops.sweepLeftovers?.(prepared);
    } catch (error) {
      console.error(`Could not clear what an earlier update left behind: ${error?.message || error}`);
    }
    // A harness an earlier failure left stopped is started again before it
    // is checked, so a stale owner record is not a reason to refuse forever.
    await ops.ensureRunning?.("before-update");
    requireSafe(await ops.preflight(prepared), "initial preflight");
    previous = await ops.capturePrevious(prepared, options);
    await ops.materializeCandidate(prepared, previous);
    requireSafe(await ops.preflight(prepared), "install-boundary preflight");
    requireSafe(await ops.fence(prepared, previous), "runtime admission fence");

    crossedBoundary = true;
    signals.hold();
    await ops.quiesce(previous);
    await ops.assertQuiesced(previous);
    await ops.advanceCheckout(prepared.targetCommit, previous);
    await ops.installCandidate(prepared, previous);
    await ops.prepareCredentials(prepared, previous);
    await ops.startHarness(prepared, previous);
    await ops.verifyHarness(prepared, previous);
    await ops.startApplication(prepared, previous, options);
    await ops.verifySingleOwner(prepared, previous);
    await ops.finish(prepared, previous);
    return { targetCommit: prepared.targetCommit, previousCommit: previous.checkoutCommit };
  } catch (error) {
    let failure = error;
    if (!crossedBoundary) {
      if (previous) {
        try {
          await ops.cleanupCandidate?.(prepared, previous);
        } catch (cleanupError) {
          failure = new AggregateError(
            [error, cleanupError],
            `BotFleet update was refused and candidate cleanup also failed: ${cleanupError?.message || cleanupError}`,
          );
        }
      }
    } else {
      try {
        await ops.rollback(prepared, previous, error);
      } catch (rollbackError) {
        failure = new AggregateError(
          [error, rollbackError],
          `BotFleet update failed and rollback also failed: ${rollbackError?.message || rollbackError}`,
        );
      }
    }
    // Never end a failed run with BotFleet stopped.  Only a restart that
    // itself fails changes what is reported; a refusal stays a refusal.
    try {
      await ops.ensureRunning?.("after-failure", previous);
    } catch (startError) {
      failure = new AggregateError(
        [failure, startError],
        `${failure?.message || failure}  BotFleet could not be started again: ${startError?.message || startError}`,
      );
    }
    throw failure;
  } finally {
    signals.release();
    await lock.release();
  }
}

export async function runUpdate(plan, options, ops) {
  const prepared = await prepareUpdate(plan, ops);
  return applyPreparedUpdate(prepared, options, ops);
}

/**
 * The step names each phase calls, in order.  Exported so the surface that
 * renders them to a person (server/update-control.ts) can be tested for
 * coverage: a new step that nobody gave a sentence would otherwise show its
 * raw camelCase op name on the Mac and the phone.  Keep in step with the phase
 * bodies above — a test in server/update-control.test.ts fails on drift.
 */
export const PREPARE_STEPS = Object.freeze([
  "resolveTarget",
  "prepareSource",
  "assertStagingSource",
  "installDependencies",
  "buildBundle",
  "validateBundle",
  "smokeTestBundle",
  "persistPrepared",
  "releaseSource",
]);

export const APPLY_STEPS = Object.freeze([
  "validatePrepared",
  "sweepLeftovers",
  "ensureRunning",
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
  "rollback",
  "cleanupCandidate",
]);
