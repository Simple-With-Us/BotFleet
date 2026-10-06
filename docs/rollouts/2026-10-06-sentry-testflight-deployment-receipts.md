# Verified TestFlight Deployment Receipts

## What Changes

A successful main CI run is no longer recorded as a production deployment.  `sentry-deploy.yml` is a reusable workflow called by the existing iOS ship workflow only when the exact archived build has passed App Store Connect readiness verification.

The release identifier is Cocoa's existing `app.botfleet@<marketing-version>+<build-number>`, not the workflow's Git SHA.  The receipt checks all three archive identity fields against the requested build and the exact ASC build response, pins the source commit before archive, and rejects a checkout that changed before reporting.  Sentry release metadata and commit refs then associate that runtime identity with `Simple-With-Us/BotFleet` and its source SHA.

Sentry's configured repository still uses `jaywedgeworth22/BotFleet`.  Its external ID matches the current GitHub repository's stable ID (`1349857130`), so commit refs use that configured Sentry name while source links use the current GitHub owner.  No integration rename or permission change is required.

The environment remains `production` to match `ios/App/SentryTelemetry.swift`.  Deployment names explicitly say `ios-testflight:<build-number>`: they mean the build is available for internal TestFlight testing, not that a device installed it or that Apple approved an App Store release.  No Mac installation, harness rollout, or website deployment is inferred from this receipt.

Receipt validation intentionally follows the repository's binding `1.0.N` marketing-version policy and twelve-digit UTC build stamp.  A future version-policy change must update the validator and fixtures rather than silently accepting a different release naming scheme.

The caller's checkout has no `ref` override: push uses its triggering commit, schedule uses the default-branch commit selected for that run, and dispatch uses the selected ref's commit.  The reusable workflow inherits the caller's GitHub context and validates the receipt against that run's `GITHUB_SHA` before loading credentials.  Only main can report; dispatch on another ref cannot create a deploy marker.  Re-running the failed reporting job retains the original ship's SHA and receipt, rather than sampling current main.

## Failure And Retry Behavior

- A skipped, export-only, upload-only, pending, or failed ship produces no confirmed receipt and no Sentry deploy marker.
- The existing exact-build ASC readiness budget and upload throttle remain unchanged.  If ASC is still processing after that budget, the ship emits a warning and no deployment is claimed.  Later availability remains unverified until checked separately; this change does not silently backfill it.
- A confirmed upload is saved to the existing ship state before receipt generation.  A receipt-generation failure cannot cause the same source to be uploaded again merely because reporting failed.
- The reusable reporting job requires the existing Infisical/GitHub-fallback Sentry token.  Missing credentials, release/commit mapping errors, API errors and ambiguous network outcomes make that job fail visibly.
- Re-run only the failed reporting job to retry a confirmed receipt.  It checks the deterministic release/environment/deployment name before creating a marker.  It does not retry uncertain writes inside one invocation or invoke the ship script.
- Sentry response bodies and tokens are never printed.  The reporter sends credentials only to the fixed Sentry API origin and rejects redirects.
- Existing dSYM and Size Analysis uploads still use the same archive.  Their existing best-effort behavior is unchanged; deployment readiness does not prove that debug-file upload succeeded or that a runtime event was received.

## Rollout Boundary

Merging these workflow/script changes invokes the existing path-triggered, rate-limited TestFlight workflow.  No manual dispatch, forced ship, signing change, credential creation or unrelated feature rollout is included.  The normal gates may skip a build.  A skipped build is not proof of deployment.

The former SHA-based markers are historical data and are not deleted or rewritten by this change.  The newly named deployment records distinguish verified iOS distribution receipts from that legacy data.

## Verification

Isolated, credential-free fixtures:

```
node --test scripts/sentry-testflight.node-test.mjs scripts/ios-ship-workflow.node-test.mjs
bash -n scripts/ios-fleet/ship-testflight.sh
git diff --check
```

The new fixture is included in `pnpm test:ios-ship`, already part of the complete `pnpm test` gate.  Coverage includes archive/ASC/source mismatches, Cocoa release formatting, invalid receipts, ASC ready/error/timeout branches exercised through Bash, absent credentials, mismatched existing release refs, idempotent re-reporting, scoped API payloads, redirect rejection and sanitized reporting failures.

Full local typecheck/test and hosted checks must be reported separately from these focused fixtures.  Production acceptance requires a successful normal ship, the matching Sentry release/ref and named deploy, and an independently observed runtime event with the same Cocoa release.  A passing test or merge alone does not establish acceptance.

Cloud validation on October 6: `pnpm typecheck` passed, all 46 combined receipt/iOS/workflow-scope/Infisical/release fixtures passed, and actionlint 1.7.7 passed both changed workflows.  The complete `pnpm test` gate was attempted but blocked by this executor denying temporary Unix-domain sockets (`EPERM`) used by permission-broker fixtures.  The supported per-command escalation still encountered that limit; a separate socket capability probe then failed in the execution wrapper before Node started.  Both full-suite attempts were stopped with exit 130 and are not recorded as passes.  The complete hosted checks remain required before merge.

## API References

- https://docs.sentry.io/api/releases/create-a-new-release-for-an-organization/
- https://docs.sentry.io/api/releases/update-an-organizations-release/
- https://docs.sentry.io/api/releases/create-a-deploy/
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
- https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations
- https://github.com/actions/checkout

Apple Notes were not updated from this cloud Linux executor.
