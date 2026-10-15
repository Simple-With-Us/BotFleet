# Kody Review Stop Rule (Per-PR Convergence)

**Date:** Thu, Oct 15, 2026  
**Seat:** CURSOR  
**Linear:** BF-1997 (canonical); BF-1999 is the imported effort-row duplicate  
**Board:** `2d9b337d94bd45049de9c893bc0ee1be`

## Decision

BotFleet treats **Kody findings as advisory**.  A human (or an agent acting with explicit owner
authority on money-path, release-path, or ruleset changes) judges whether a finding is real,
already fixed, or accepted risk.

**Per-PR stop rule (binding for fleet agents triaging Kody threads):**

1. **Round 1** — Classify every unresolved thread against current HEAD (`codex-triage` skill).  Fix
   all **real** findings in one batch commit; reply and resolve addressed and false positives.
2. **Round 2** — Repeat only for threads Kody opened on the round-1 head (or other bots/humans
   that appeared after round 1).  Same batch-fix discipline.
3. **Stop** — Do not chase zero-unresolved as a merge bar.  After round 2, record any remaining
   threads as **accepted risk** with a written rationale (PR comment, board comment, or Apple Note
   for owner-facing decisions).  Then merge or unstick the PR per normal branch protection, without
   infinite re-review ping-pong.

Zero-unresolved is **not** a terminating condition when the reviewer re-scans the full diff on
every push.

## Evidence (2026-10-04 sweep)

Measured on open BotFleet PRs during the MINIMAX Kody sweep (see effort log and fleet recall
contrib `MINIMAX/2026-10-05/613955cb`):

- Kody re-reviews the **whole diff** on each push, so fixed findings can remain open and new
  batches appear on fix commits.
- Example thread counts by commit: #842 → 58 threads / 8 commits; #734 → 71 / 9; #800 → 23 / 3.
  Five real fixes on #842 still left ~26 unresolved.
- Kody is not reliably correct (e.g. #829: proposed ordering fix byte-identical to HEAD, wrong
  direction).  Money-path, auth, execution, policy, and billing findings need adversarial human
  judgment even when labeled critical.

Operational detail for counting rounds: cap GraphQL `reviewThreads(first: 100)` — higher counts can
fail with excessive pagination and return `pullRequest: null`.  Group threads by
`comments.nodes[0].commit.oid` to see which push opened them.

## What this does not change

- Fleet-wide Kody **rules** still live in `Simple-With-Us/Kodus-Config`.  This decision is process
  only.
- `kodus-config.yml` in this repo still controls per-repo review toggles (severity filter,
  request-changes).  Changing GitHub rulesets (e.g. `dismiss_stale_reviews_on_push`) is an owner /
  org decision, not covered here.
- Agents must still **reply** before resolving a thread they understand; never blind-resolve to
  force merge (`codex-triage`, `unstick-pr`).

## Canon

- `.claude/skills/codex-triage/SKILL.md` — thread triage and stop rule  
- `AGENTS.md` — Kody Review Rules  
- `CONTRIBUTING.md` — Kody (automated PR review)  
- Fleet recall: "Kody and other LLM reviewers re-review the whole diff on every push…"
