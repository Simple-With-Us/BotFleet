# Sentry Review Autofix Caller

Refs BF-2487.  Follow-up to #1241 after AFC #657 merged.

The Claude Code Autofix caller now uses AFC `c79c7840d4d3d71bffad08067ce4a1084f0bbb34` for Claude Code Autofix.  The consumed Claude workflow differs from `b718446588a365406cb0eb3aca7feec3a3fe5903` only by adding the exact `sentry` and `sentry[bot]` accounts to its existing bot allowlist.  No wildcard, credential, permission, trigger, concurrency, prompt, turn limit, or verification change is introduced in that workflow.

## Scope

BotFleet changes only its Claude caller pin and adds a regression guard for the reviewed pin, inherited allowlist, and existing same-repository bot-review gate.  The existing manual dispatch remains available.  PR Autofix stays at `00def8545947e21ffe285ea67c1812c7bd321dfc`; its `@autofix`/first change-recommending review policy and `.autofix.yml` are unchanged.  In particular, its first-review path still requires a nonempty review body for COMMENTED reviews, and it only names `sentry[bot]`.  The Claude review-submitted path supplies the Sentry fix without extending that separate loop.

## Verification

- `node --test scripts/autofix-workflows.node-test.mjs`: 6/6 pass in an isolated fixture using the exact caller, policy, and test files.
- YAML parsing passes for both callers; existing permissions, secrets, and guard checks pass.
- Exact consumed reusable comparison confirms the Sentry allowlist-only change.  The diagnostics action and reducer exist at AFC `070fdbfacadbd9e90cbb54098123df7d3fef737f`.
- Full local typecheck/test/build are not run in this connector-driven change.  Hosted CI and review on the final head remain the readiness gate.

## Acceptance Boundary

This is a caller/configuration repair, not evidence of a completed live autofix.  A subsequent eligible same-repository Sentry bot review must reach the Claude action beyond actor validation.  Fork and human reviews remain excluded by the caller; identity enforcement remains the pinned action's responsibility.  No manual paid run, merge, new auto-merge, or Sentry project setting change is performed.
