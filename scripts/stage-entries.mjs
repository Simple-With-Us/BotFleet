// The entries a BotFleet update stage is allowed to contain and still be
// swept unattended — defined ONCE, because two copies of this list existed and
// drifted, and the drift is a multi-gigabyte disk leak rather than a cosmetic
// bug.
//
// `scripts/update-botfleet-mac.mjs` has its own sweeper and
// `server/update-control.ts` has another (`pruneUpdateStages`, which is what
// runs on the harness schedule).  Only the server's copy had `hosted`, so every
// stage the default `ci` policy produced — a `hosted/BotFleet.app` and a
// `hosted/node_modules` beside it — was classified as holding files "this
// updater did not write" and kept forever, with a full extra copy of the app
// and a multi-gigabyte dependency tree inside it.  Both copies carried a
// comment claiming parity with the other, which is exactly how a comment
// asserting a fact keeps the fact from being checked.
//
// Anything not listed here was put in a stage directory by a person, and a
// person decides when it goes.

export const KNOWN_STAGE_ENTRIES = Object.freeze([
  "BotFleet.app",
  "node_modules",
  "prepared.json",
  "rollback",
  "source",
  "pending-recovery.json",
  "credential-migration.json",
  // Where a downloaded CI build is unpacked, and where its staged dependency
  // tree lands.  Both are written by the updater itself, on the default path.
  "hosted",
]);

/**
 * A stage holding either of these is load-bearing: `prepared.json` is a build
 * a later `apply` can still install, and `rollback` holds the verified bundle
 * the installed app would be rolled back to.
 */
export const PROTECTED_STAGE_ENTRIES = Object.freeze(["prepared.json", "rollback"]);

/** May this stage be deleted unattended? */
export function stageIsPrunable(names = []) {
  if (names.some((name) => PROTECTED_STAGE_ENTRIES.includes(name))) return false;
  return names.every((name) => KNOWN_STAGE_ENTRIES.includes(name));
}
