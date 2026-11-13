# 2026-09-12 — Documentation-Only CI

Issue #318.  Board `34813b74`.  Branch `codex/docs-only-ci-cost-20260912`.

## Behavior

CI now classifies the complete pull-request or main-push diff before starting its protected jobs.  Only `docs/**` and the explicit root documentation files in `scripts/ci-change-scope.mjs` take the lightweight path.  Packaged `LICENSE` and `NOTICE` files and the test-enforced `docs/secrets.md` runbook remain full-gate inputs.  An empty diff, an unavailable base commit, a rename involving an executable path, or any code, test, lockfile, workflow, package, generated, or native input fails closed to the complete matrix.

The six branch-protection contexts remain unchanged: the three platform test jobs, control-plane validation, Linux package smoke, and Swift/iOS build all run a short terminal step for an allowlisted documentation-only diff.  Their full steps remain conditional on the shared classifier output.  If classification fails or produces no output, every protected job still starts and takes the full path.  A weekly Monday 09:17 UTC run and every manual dispatch always execute the complete matrix; the weekly run is registered with the existing Sentry cron reporter and a 45-minute check-in margin.

## Baseline Cost

The documentation-only PR #317 run `34635882853` consumed 1,483 summed job-seconds across the six protected jobs, or 24 minutes 43 seconds.  Its main-push run `34636567571` consumed another 1,560 job-seconds, or 26 minutes.  The combined baseline was 50 minutes 43 seconds before queue time.  Receipt PR #339 run `34687437005` consumed 26 summed protected-job seconds: every required job succeeded through `Documentation-only fast path`, and every full checkout, install, test, package, and build step was skipped.  The observed pull-request saving is 1,457 seconds, or 98.2%; the resulting main-push receipt is recorded in issue #318 after merge.

## Validation

- `pnpm test:ci-scope` covers the allowlist, mixed and empty fail-closed cases, NUL-delimited CLI output, unchanged protected job names, classifier-failure fallback, scheduled/manual full runs, and disabled rename detection.
- Current branch protection was read through the GitHub API before implementation.  It requires the exact six existing job names and remains unchanged.
- This workflow/package/script change is outside the documentation allowlist, so its own pull request and main push must run the complete matrix.
- Post-merge documentation-only validation records the observed pull-request receipt here and the resulting main-push receipt in issue #318.
