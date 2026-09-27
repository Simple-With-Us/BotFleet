# 2026-09-25 — Deploy seat + PR tagging (Claude, `claude/sentry-deploy-tag`)

## Context

THE BOARD row `1af9e286` (its duplicate `0a4a04ed` was closed pointing here):
add which fleet seat and PR shipped a production Sentry deploy record, so a
deploy in the Sentry UI is traceable back to the agent and PR that produced
it.  This mirrors jaywedgeworth22/Usage-Monitor PR #1536 and its
`docs/rollouts/2026-09-24-deploy-seat-tagging.md`, which documents the same
pattern and its portable recipe for BotFleet, Socratic.Trade, and
Congress.Trade.

## What changed

`.github/workflows/sentry-deploy.yml` — the existing `record-production-deploy`
job (`workflow_run` after `CI` succeeds on a push to `main`, soft-fail,
`npx @sentry/cli@2.58.6 releases deploys "$VERSION" new -e production`) gets
two additions, applied in the same shape as Usage-Monitor's:

1. **A new step, "Derive deploying seat and PR number,"** placed right after
   `actions/checkout` and before the existing "Load the Sentry auth token"
   step.  It calls `gh api repos/<owner>/<repo>/commits/<sha>/pulls` (the
   default `GITHUB_TOKEN`, needing the newly added `permissions:
   pull-requests: read`), reads the first result's PR number and
   `head.ref`, and derives `seat` as the branch prefix up to the first `/`
   (fleet convention: lowercase `<seat>/<slug>`, deliberately not the
   ALL-CAPS Slack/board tag casing, and — since not every BotFleet branch
   prefix is a fleet seat — often just the raw branch prefix, e.g. a bot
   persona like `instinct/` or `fixer/`, rather than a seat name).  Neither
   path fails the build: no PR found (a direct push to `main`) skips the
   `-n`/`--name` tag entirely; a PR found whose `head.ref` has no `/` is a
   degraded case, not a no-op — it still tags the deploy, with `seat`
   recorded as `unknown` and the PR number kept.
2. **The existing deploy step now passes `-n "seat:<seat> pr:#<number>"`** to
   `sentry-cli releases deploys ... new` when a PR was found, omitted
   entirely otherwise.

### Why `--name`, and why this repo's flags were re-checked rather than assumed

Usage-Monitor's doc explains the `--name`-over-alternatives reasoning in full
(no generic tag field on the deploys API; release/version format is owned by
the app's build-time Sentry plugin; `set-commits` is a different piece of
data; raw HTTP to an undocumented field risks silent drops).  That reasoning
carries over unchanged.  Per that doc's own portable recipe, this repo's
pinned `@sentry/cli@2.58.6` was independently re-verified here (`npx --yes
@sentry/cli@2.58.6 releases deploys new --help`) rather than assuming
Usage-Monitor's flag list — same version pin, same `-n/--name` flag, so no
surprises, but the check was still run.

### One shape difference from Usage-Monitor: the Infisical token load

BotFleet's `SENTRY_AUTH_TOKEN` comes from the shared `.github/actions/infisical-secrets`
composite action (with a GitHub-secret fallback during the cutover), not a
bare `secrets.SENTRY_AUTH_TOKEN` the way Usage-Monitor's workflow reads it.
The new PR-lookup step does not need that treatment — it only calls `gh api`
with the workflow's own `GITHUB_TOKEN`, which every `workflow_run` job
already has, so it runs before (and independent of) the Infisical token load.

## Verification performed

- `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/sentry-deploy.yml'))"` — parses clean.
- `actionlint .github/workflows/sentry-deploy.yml` — one shellcheck style
  note (SC2181, `if [ $? -eq 0 ]`) confirmed **pre-existing** on `origin/main`
  before this change (`actionlint` run against the unmodified file gives the
  identical finding at the identical line), not introduced by it.
- `npx --yes @sentry/cli@2.58.6 releases deploys new --help` run directly in
  this repo to confirm the `-n`/`--name` flag on this repo's pinned version.
- No app, server, iOS, or Electron source touched — this is a
  `.github/workflows/**` + `docs/**` change only.  Per `scripts/ci-change-scope.mjs`,
  a workflow-file change is not docs-only, so hosted CI still runs the full
  `pnpm typecheck && pnpm test` gate on this PR; that full run was not
  reproduced locally given the change has no code-path overlap with it.

## Not done here

- **The actual deploy-tagging behavior in a real CI run is unverified.**  A
  GitHub Actions `workflow_run` trigger cannot be dry-run locally; this can
  only be confirmed once this PR merges and a subsequent production deploy
  fires, producing a Sentry deploy record with the `seat:... pr:#...` name
  visible in the Sentry UI for the `botfleet` project.  That confirmation
  also depends on the deploy step itself succeeding — on `main` today the
  `sentry-cli releases deploys ... new` call already fails with "Release not
  found" on a meaningful share of runs (pre-existing, unrelated to this
  change; e.g. runs `36100350406` and `36095012142` vs. success on
  `36099549977`), most likely a release-creation race or a naming mismatch
  with the build-time Sentry plugin.  The seat/PR tag is only visible on
  runs where that call succeeds; a separate board row should track the
  intermittent failure itself.
- Socratic.Trade and Congress.Trade were **not** edited here — out of this
  item's scope (see the umbrella board row `52452cb2e406492a8b240977acdeef23`).
