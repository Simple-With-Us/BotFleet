# Sentry Review Autofix Caller

## Summary

Refs BF-2487.  Follow-up to #1241 after AFC #657 merged.

The Claude Code Autofix caller now uses AFC `c79c7840d4d3d71bffad08067ce4a1084f0bbb34` for Claude Code Autofix.  The consumed Claude workflow differs from `b718446588a365406cb0eb3aca7feec3a3fe5903` only by adding the exact `sentry` and `sentry[bot]` accounts to its existing bot allowlist.  No wildcard, credential, permission, trigger, concurrency, prompt, turn limit, or verification change is introduced in that workflow.

## Files Changed

- `.github/workflows/claude-code-autofix.yml`: reviewed Sentry-capable immutable reusable pin.
- `scripts/autofix-workflows.node-test.mjs`: regression guard for the pin, inherited actor policy, and same-repository bot trigger.
- This rollout note: scope, verification evidence, and live acceptance.

## Scope

BotFleet changes only its Claude caller pin and adds a regression guard for the reviewed pin, inherited allowlist, and existing same-repository bot-review gate.  The existing manual dispatch remains available.  PR Autofix stays at `00def8545947e21ffe285ea67c1812c7bd321dfc`; its `@autofix`/first change-recommending review policy and `.autofix.yml` are unchanged.  In particular, its first-review path still requires a nonempty review body for COMMENTED reviews, and it only names `sentry[bot]`.  The Claude review-submitted path supplies the Sentry fix without extending that separate loop.

## Verification

Full local application gates are NOT RUN in this isolated connector fixture.  The repository uses pnpm; this list explicitly distinguishes the generic handoff commands from its actual checks:

- `npm run lint`: NOT RUN; the repository's hosted `pnpm lint` check passed on `5f6328ec5cdb0c1a82e5fbe2d3ac124a729680f8`.
- `npx tsc --noEmit`: NOT RUN; BotFleet's actual command is `pnpm typecheck`, which checks both application and server projects.
- `npm test`: NOT RUN; the complete `pnpm test` chain is running in hosted CI on Ubuntu, macOS, and Windows.
- `npm run build`: NOT RUN locally; the hosted package/smoke job passed on the same head, while full matrix jobs are still running.

- `node --test scripts/autofix-workflows.node-test.mjs`: 6/6 pass in an isolated fixture using the exact caller, policy, and test files.
- YAML parsing passes for both callers; existing permissions, secrets, and guard checks pass.
- Exact consumed reusable comparison confirms the Sentry allowlist-only change.  The diagnostics action and reducer exist at AFC `070fdbfacadbd9e90cbb54098123df7d3fef737f`.
- Full local typecheck/test/build are not run in this connector-driven change.  Hosted CI and review on the final head remain the readiness gate.

## Follow-ups

This is a caller/configuration repair, not evidence of a completed live autofix.  A subsequent eligible same-repository Sentry bot review must reach the Claude action beyond actor validation.  Fork and human reviews remain excluded by the caller; identity enforcement remains the pinned action's responsibility.  No manual paid run, merge, new auto-merge, or Sentry project setting change is performed.
