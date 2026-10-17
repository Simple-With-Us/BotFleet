# Vercel 3h production catch-up

This publisher compares current main with the last actually promoted production SHA.  It does not compare only the latest two incoming commits, so a skipped site change is not lost behind a later docs-only merge.  Hourly reconciliation retries eligible latest main after the 3h window even when nobody pushes again.  CI completion also triggers reconciliation.  Scheduled runs can arrive late; this is a retry cadence, not an exact deployment deadline.

The workflow is off until the repository variable `VERCEL_CATCH_UP_ENABLED` is exactly `true`.  There is no force or cooldown bypass input.  A shared concurrency group serializes main publishing.  A second gate after the local build checks for superseded main, an in-flight production build, and a new provider attempt before uploading once.

## Cutover, after this PR passes review and CI

1. Check the IDs, root directory and watched paths in `vercel-config.json` against the live project.  Stable GitHub repo IDs are used because the provider owner-name fields can lag a repository move.
2. Confirm the CI machine identity can read only the required `VERCEL_TOKEN` from Fleet-OPS production root.  Do not copy token values into code, logs or chat.  Existing authentication loads it into the runner environment.  The pinned CLI reads `VERCEL_TOKEN` from the environment, not a command-line token argument.
3. Disable the provider Git publisher for this project, keeping its Git link, root directory, domains and protection.  Disable any older CLI publisher as well.  The new gate refuses to run unless `gitProviderOptions.createDeployments` is `disabled`; all other provider changes are outside this PR.
4. Enable `VERCEL_CATCH_UP_ENABLED`.  Run the catch-up workflow once on main.  It skips until the last production attempt is at least 10800 seconds old.  Failures and cancellations count too, so repeated failures cannot spend a deployment every hour.  No deploy occurs while one is in flight.
5. Inspect the provider receipt: current project production target, exact checkout SHA, READY state and deployment URL.  A successful CLI exit or a green no-op workflow is not a shipping receipt.  Verify the public site separately.

Keep the workflow disabled if token access, project mapping, deployment metadata or exact-main CI cannot be verified.  Missing data fails closed.  A missing production baseline or a deployed SHA that is not an ancestor of main requires investigation, not a blind redeploy.  The initial cutover does not invent a baseline or overwrite a manual rollback.

## Checks

`node --test scripts/deploy/vercel-catch-up.test.mjs`

The dependency-free unit and entrypoint integration tests cover the 3h boundary, last-skipped-merge catch-up, docs-only later commits, failed/canceled attempts, in-flight builds, binding/root drift, malformed provider data, exact-SHA CI, and deployment receipts.  PR runs execute tests without secrets.  Builds run from the repo root so the Vercel root directory is applied once.  CLI is pinned to 64.5.0.

If upload times out, do not retry the POST blindly.  The next hourly run reads provider history and the current production target before deciding again.  A READY deployment with a mismatched SHA, or a deployment not promoted to production, fails receipt verification.

The old ignore script is retained for rollback reference, but it is not the active publisher's rate gate.  Do not re-enable a competing Git publisher to bypass this workflow.  Rollback or emergency exceptions need a separate owner decision.
