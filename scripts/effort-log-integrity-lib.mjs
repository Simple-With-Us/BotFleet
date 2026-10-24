// Pure decisions behind scripts/effort-log-integrity.node-test.mjs, kept apart
// so they can be tested without a git history to compare against.

/**
 * What the truncation guard does once it has looked for a comparison point.
 *
 * A missing merge base must be loud on CI.  The guard used to skip there, and
 * the CI `test` job's depth-1 checkout has no `origin/main`, so on every pull
 * request the guard reported "skipped" and checked nothing while the job went
 * green.  A skipped check that nobody reads is worse than no check.  Off CI
 * (a fresh clone, a worktree with no remote) a skip is the honest answer.
 */
export function ledgerBaseOutcome({ base, ci }) {
  if (base) return { kind: "compare", base };
  if (ci) {
    return {
      kind: "fail",
      message:
        "no merge base with origin/main on CI, so the effort ledger truncation guard cannot compare. " +
        "The checkout needs full history (actions/checkout with fetch-depth: 0).",
    };
  }
  return { kind: "skip", message: "no merge base with origin/main to compare against" };
}

/** True when CI is set to anything but an explicit off value. */
export function isCi(env) {
  const value = env.CI;
  return Boolean(value) && value !== "false" && value !== "0";
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Rows a seat has in the ledger.  Both delimiters are in real use ("2026-10-09
 * — CLAUDE —" and "2026-09-27 - CLAUDE -"), and some rows bracket the seat
 * ("[DIRECTOR]"), so the header is matched on the seat token rather than on one
 * delimiter at one position.  Pinning the em dash made the per-seat check read
 * "no em-dash rows left for X" while claiming "no rows left for X".
 */
export function countSeatRows(text, seat) {
  const pattern = new RegExp(
    `^- \\*\\*[0-9]{4}-[0-9]{2}-[0-9]{2} [—-] \\[?${escapeRegExp(seat)}\\]?(?![A-Za-z0-9])`,
    "gm",
  );
  return (text.match(pattern) || []).length;
}
