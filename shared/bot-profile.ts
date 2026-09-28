/** Profile input limits shared by every web and server write surface. */
export const BOT_PROFILE_LIMITS = {
  name: 100,
  title: 200,
  description: 4000,
  voice: 200,
} as const;

/** Ceiling for per-bot HTTP tool-loop rounds (Designer 2026-09-25). */
export const MAX_TOOL_ROUNDS = 200;

/** The round budget an HTTP tool-loop turn gets when a bot sets none.
 *
 *  Twelve is the floor that keeps a runaway loop from burning a subscription,
 *  not a sensible budget for the work this fleet actually does: a compile
 *  gate, an incident investigation, or a multi-repo change routinely needs
 *  more than twelve model→tool hops, and these bots run unattended with
 *  auto-approve on, so a ceiling stops a half-finished change with nobody
 *  watching.  It stays deliberately low — a bot that loops should hit a wall
 *  — but it is no longer tight enough to end ordinary work.  Owners who want
 *  a different number set `maxToolRounds` per bot, up to MAX_TOOL_ROUNDS. */
export const DEFAULT_MAX_TOOL_ROUNDS = 40;

/** The owner-facing sentence for the Maximum Tool Rounds control, built from
 *  the constants instead of typed out.
 *
 *  This copy used to be a literal "Per turn.  Empty uses 12.  Cap is 200." in
 *  the desktop panel, the iOS profile view, AND the layout test that asserted
 *  the literal string — so the test pinned the wrong number and the three
 *  places agreed with each other while the bot was actually told a different
 *  budget than the one it was stopped at.  Deriving the sentence means the
 *  number a person reads is the number the loop enforces. */
export function toolRoundsCaption(): string {
  return `Per turn.  Empty uses ${DEFAULT_MAX_TOOL_ROUNDS}.  Cap is ${MAX_TOOL_ROUNDS}.`;
}

/** The budget a turn will actually run under, and whether the owner chose it.
 *
 *  Returns the effective number rather than `undefined` so callers stop
 *  re-deriving "12 because nothing said otherwise" in three separate places
 *  and disagreeing about it. */
export function effectiveToolRounds(
  configured: number | undefined,
): { rounds: number; explicit: boolean } {
  if (typeof configured === "number" && Number.isInteger(configured) && configured >= 1 && configured <= MAX_TOOL_ROUNDS) {
    return { rounds: configured, explicit: true };
  }
  return { rounds: DEFAULT_MAX_TOOL_ROUNDS, explicit: false };
}

/** The one sentence that tells a model how many model→tool rounds it has.
 *
 *  A model that does not know its ceiling spends it badly — one call per
 *  round, no batching — and then discovers the limit on the last round, by
 *  which point the turn is already cut off mid-work.  Naming the number up
 *  front is what turns a hard stop into a plan: the model batches related
 *  calls into one round, reads before it writes, and finishes inside the
 *  budget instead of against it.
 *
 *  Lives beside `effectiveToolRounds` so the number in the prose and the
 *  number in the loop cannot drift apart. */
export function toolBudgetPrompt(budget: { rounds: number; explicit: boolean }): string {
  if (budget.rounds <= 1) return "";
  return (
    `\n\nThis turn has a budget of ${budget.rounds} model→tool rounds` +
    (budget.explicit ? " (set for this bot)." : " (the default for this bot).") +
    " Every round you call tools, you spend one. Batch related calls into a single" +
    " round, read before you write, and finish inside the budget — a turn that reaches" +
    " the limit stops with its remaining work undone and no one watching."
  );
}
