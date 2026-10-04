// Types for the plain-JS update coordinator.
//
// server/update-control.test.ts imports PREPARE_STEPS and APPLY_STEPS to assert
// the update card has a sentence for every step the updater can report.  That
// cross-file check is worth keeping, so the module needs declarations rather
// than a ts-expect-error in the test.
//
// This is a hand-maintained mirror of scripts/mac-update-transaction.mjs.  If
// the coordinator grows or changes shape, update it here too — an inaccurate
// declaration is worse than none, because it fails silently instead of loudly.

export class UpdateRefusedError extends Error {
  constructor(message: string);
}

export interface PreparedUpdate {
  targetCommit: string;
  stageDirectory: string;
  bundlePath: string;
  [key: string]: unknown;
}

export interface PreviousState {
  checkoutCommit: string;
  appWasRunning: boolean;
  [key: string]: unknown;
}

export type Readiness = { safe: boolean; reason?: string };

/**
 * Every operation the coordinator may call.  Members are optional because the
 * apply path only reaches `rollback` and `cleanupCandidate` on failure, and the
 * adapter supplies a superset of the prepare path's requirements.
 */
export interface UpdateOperations {
  acquireLock(mode: string): Promise<{ release(): Promise<void> }>;

  resolveTarget(plan: Record<string, unknown>): Promise<string>;
  prepareSource(plan: Record<string, unknown>): Promise<Record<string, unknown>>;
  assertStagingSource(source: Record<string, unknown>, targetCommit: string): Promise<void>;
  installDependencies(source: Record<string, unknown>, targetCommit: string): Promise<void>;
  buildBundle(source: Record<string, unknown>, targetCommit: string): Promise<string>;
  validateBundle(bundle: string, targetCommit: string): Promise<Record<string, unknown>>;
  /** Added with the pre-activation smoke test; see docs/verification/staged-candidate-smoke.md. */
  smokeTestBundle(bundle: string, targetCommit: string): Promise<void>;
  persistPrepared(input: Record<string, unknown>): Promise<PreparedUpdate>;
  releaseSource(source: Record<string, unknown>): Promise<void>;

  validatePrepared(prepared: PreparedUpdate): Promise<void>;
  preflight(prepared: PreparedUpdate): Promise<Readiness>;
  capturePrevious(prepared: PreparedUpdate, options: Record<string, unknown>): Promise<PreviousState>;
  materializeCandidate(prepared: PreparedUpdate, previous: PreviousState): Promise<void>;
  cleanupCandidate?(prepared: PreparedUpdate, previous: PreviousState): Promise<void>;
  fence(prepared: PreparedUpdate, previous: PreviousState): Promise<Readiness>;
  quiesce(previous: PreviousState): Promise<void>;
  assertQuiesced(previous: PreviousState): Promise<void>;
  advanceCheckout(targetCommit: string, previous: PreviousState): Promise<void>;
  installCandidate(prepared: PreparedUpdate, previous: PreviousState): Promise<void>;
  prepareCredentials(prepared: PreparedUpdate, previous: PreviousState): Promise<void>;
  startHarness(prepared: PreparedUpdate, previous: PreviousState): Promise<void>;
  verifyHarness(prepared: PreparedUpdate, previous: PreviousState): Promise<void>;
  startApplication(prepared: PreparedUpdate, previous: PreviousState, options: Record<string, unknown>): Promise<void>;
  verifySingleOwner(prepared: PreparedUpdate, previous: PreviousState): Promise<void>;
  finish(prepared: PreparedUpdate, previous: PreviousState): Promise<void>;
  rollback(prepared: PreparedUpdate, previous: PreviousState, error: unknown): Promise<void>;
}

export declare function prepareUpdate(
  plan: Record<string, unknown>,
  ops: UpdateOperations,
): Promise<PreparedUpdate>;

export declare function applyPreparedUpdate(
  prepared: PreparedUpdate,
  options: Record<string, unknown>,
  ops: UpdateOperations,
): Promise<{ targetCommit: string; previousCommit: string }>;

export declare function runUpdate(
  plan: Record<string, unknown>,
  options: Record<string, unknown>,
  ops: UpdateOperations,
): Promise<{ targetCommit: string; previousCommit: string }>;

/**
 * The step names each phase calls, in order.  `server/update-control.test.ts`
 * asserts UPDATE_STEP_LABELS covers every one of these.
 */
export declare const PREPARE_STEPS: readonly string[];
export declare const APPLY_STEPS: readonly string[];
