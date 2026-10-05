# 2026-10-05 — Pull Request Lint Baseline Ratchet

Board `7d1aca0b`.  Branch `cursor/pr-lint-baseline-ratchet-5dcb`.

## Behavior

`scripts/lint-pr-gate.mjs` still fails a pull request that adds `error anti-slop` findings in files it changes.

`scripts/check-lint-baseline.mjs` now also runs on `pull_request`.  GitHub checks out the merge commit (`refs/pull/<n>/merge`).  The script lints that tree and compares each rule's warning count to `.oxlint-baseline.json` on the base branch (`--baseline-ref`), not to the copy of the file on the head branch.

A branch that is only behind the base stays green when the merge commit does not exceed the base baseline.  It does not need a regenerated baseline.  That is the failure mode that made #842 and #858 rewrite `.oxlint-baseline.json` every time main moved.

Raising a count in `.oxlint-baseline.json` does not make the check pass.  The only opt-in is the pull request label `allow-lint-baseline-increase`.  The Node CI workflow sets `LINT_BASELINE_ALLOW_INCREASE=1` only when that label is present, and it re-runs on `labeled` and `unlabeled`.  With the label, each raised rule must be committed at the measured merge-commit count.  A higher number is headroom and still fails.

`pnpm lint` on a main push is unchanged: it compares the working tree to the baseline file in that commit.

The rule counts in `.oxlint-baseline.json` are not edited here.  The description records the pull-request rule so the next person who opens the file sees it.

## Validation

- `pnpm test:lint-gate` covers the behind-base pass, a warning increase, a JSON bump, a stale low file, the allow path, headroom, and the workflow wiring.
- `node scripts/check-lint-baseline.mjs` on this tree checks that the description edit did not move any rule count.
