// Types for the shared stage-entry allowlist.
//
// `server/update-control.ts` imports KNOWN_STAGE_ENTRIES and
// PROTECTED_STAGE_ENTRIES from this plain-JS module so there is exactly one
// definition.  The updater bootstraps itself by archiving a small fixed graph
// into a temp directory with no node_modules beside it, so that graph cannot
// import a third-party validator — but hand-maintained declarations are fine,
// and this one is checked by a test that compares it against the module's
// actual exports.

export declare const KNOWN_STAGE_ENTRIES: readonly string[];
export declare const PROTECTED_STAGE_ENTRIES: readonly string[];
export declare function stageIsPrunable(names?: string[]): boolean;
