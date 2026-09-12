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
 * or processes.  The concrete adapter owns filesystem and command details;
 * this coordinator keeps the ordering testable.
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
    return await ops.persistPrepared({
      plan,
      source,
      targetCommit,
      builtBundle,
      identity,
    });
  } finally {
    if (source) await ops.releaseSource(source);
    await lock.release();
  }
}

/**
 * Apply one already-validated stage.  There are two readiness checks: one
 * before any install preparation and one immediately before the interruption
 * boundary.  Every failure after that boundary attempts a complete rollback.
 */
export async function applyPreparedUpdate(prepared, options, ops) {
  const lock = await ops.acquireLock("apply");
  let previous;
  let crossedBoundary = false;
  try {
    await ops.validatePrepared(prepared);
    requireSafe(await ops.preflight(prepared), "initial preflight");
    previous = await ops.capturePrevious(prepared, options);
    await ops.materializeCandidate(prepared, previous);
    requireSafe(await ops.preflight(prepared), "install-boundary preflight");

    crossedBoundary = true;
    await ops.quiesce(previous);
    await ops.assertQuiesced(previous);
    await ops.advanceCheckout(prepared.targetCommit, previous);
    await ops.installCandidate(prepared, previous);
    await ops.startHarness(prepared, previous);
    await ops.verifyHarness(prepared, previous);
    await ops.startApplication(prepared, previous, options);
    await ops.verifySingleOwner(prepared, previous);
    await ops.finish(prepared, previous);
    return { targetCommit: prepared.targetCommit, previousCommit: previous.checkoutCommit };
  } catch (error) {
    if (!crossedBoundary) {
      if (previous) {
        try {
          await ops.cleanupCandidate?.(prepared, previous);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `BotFleet update was refused and candidate cleanup also failed: ${cleanupError?.message || cleanupError}`,
          );
        }
      }
      throw error;
    }
    try {
      await ops.rollback(prepared, previous, error);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `BotFleet update failed and rollback also failed: ${rollbackError?.message || rollbackError}`,
      );
    }
    throw error;
  } finally {
    await lock.release();
  }
}

export async function runUpdate(plan, options, ops) {
  const prepared = await prepareUpdate(plan, ops);
  return applyPreparedUpdate(prepared, options, ops);
}
