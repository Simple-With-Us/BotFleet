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

/**
 * The step names each phase calls, in order.  `server/update-control.test.ts`
 * asserts UPDATE_STEP_LABELS covers every one of these.
 */
export declare const PREPARE_STEPS: readonly string[];
export declare const APPLY_STEPS: readonly string[];
