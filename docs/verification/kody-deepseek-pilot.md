# Kody DeepSeek Fix Pilot

This is an opt-in, manual BotFleet pilot.  It proposes corrections in a separate draft PR targeting the original feature branch.  It never changes the original branch, merges, deploys, enables auto-merge, resolves review threads, or repeatedly retries itself.

## Current State

The implementation is prepared for review and is disabled by default.  Merging it does not activate paid calls: the repository variable, protected environment, environment-only key, and explicit per-run approval must all be configured first.  No provider call, credential provisioning, environment configuration, or live workflow dispatch was performed while preparing this change.

## Why A Separate Proposal

BotFleet has multiple concurrent editing seats.  A GitHub concurrency group cannot lock their local worktrees, and the proposed worktree lease engine is not a repository-wide write lock.  This pilot therefore never pushes onto another seat's branch.  It creates a new `codex/kody-fix-pr-<number>-<full-head-sha>` branch with the reviewed head as its only parent, followed by a draft PR against the original feature branch.

A proposal branch is create-only, and an existing proposal for that head prevents another paid attempt.  The source head and review snapshot are checked again before publication.  GitHub reads and writes are not atomic: the source branch can move immediately after the final check.  Every proposal identifies its exact reviewed SHA; if the original PR has advanced, leave the proposal unmerged and review against the new head.  If publication fails after branch creation, inspect that orphan branch instead of blindly rerunning or force-updating it.

## Trust Boundaries

1. The dispatched workflow must be the `main` version.  Every job checks out only the control scripts from the immutable workflow SHA with checkout credentials disabled.
2. The dispatcher and triggering user must have write, maintain, or admin permission.  The source PR must be open, review-ready, human-authored, same-repository, and target `main`.
3. Review threads are fully paginated, with fail-closed pagination limits.  Only unresolved, non-outdated, right-side root findings from the verified Kody bot identity qualify, and both associated and original comment commits must equal the supplied head SHA.
4. At most eight findings across five existing ordinary source files are selected.  Eligible paths are text `.ts`, `.tsx`, `.js`, `.mjs`, and `.css` files beneath `src/` or `server/`; settings/secret inventories, hidden paths, symlinks, gitlinks, executables, binary data, and invalid UTF-8 are refused.  No workflows, dependency files, generated infrastructure, new files, or deletions are proposed.
5. Git blobs and review text are serialized as data.  The model never receives a PR checkout, project settings, hooks, plugins, MCP access, file tools, shell tools, GitHub credentials, or the real provider key.  It runs the pinned Claude Code CLI in an empty temporary home with bare mode and an empty tool set, then removes that temporary home even after failure.  The schema-output tool is the only CLI tool permitted by the structured-output mechanism.
6. A separate trusted process holds the DeepSeek key and proxies only the fixed Anthropic-compatible messages route with the fixed `deepseek-flash` model.  It rejects redirects, unrelated routes, excessive requests, and oversized bodies.  Authentication, payment, permission, and quota refusals stop further upstream requests and log only the fixed key name and status code.  The provider model alias can evolve; it is not a model-weight pin.
7. The publisher is a different job with short-lived `GITHUB_TOKEN` contents/PR write permissions.  It re-fetches the complete selected review snapshot and immutable blobs and independently validates the model response.  Literal replacements must match exactly once, must not overlap, and must stay within 40 lines of a selected finding.  It uses create-only Git/PR APIs, never executes generated code, and never takes PR metadata as a shell command.

Review bodies and source comments can contain prompt injection.  These controls prevent that text from granting execution or publishing authority, but cannot prove a semantically correct or benign code change.  Human review and application tests remain mandatory.

## Cost And Work Bounds

- One explicitly approved dispatch, with workflow reruns refused
- At most three upstream messages requests, including retries
- At most 256,000 request bytes per call and 4,096 requested output tokens per call
- At most 180,000 context bytes, 64,000 bytes per source file, twelve edits, and 24,000 combined old/new replacement bytes
- Four-minute CLI deadline, eight-minute generation job deadline, and five-minute preparation/publication deadlines
- CLI `--max-turns 3` and `--max-budget-usd 0.50` as additional safeguards

The CLI dollar estimate has not been verified against DeepSeek billing and is not a guaranteed $0.50 provider spending cap.  Configure the approved provider-side limit before activation.  The enforced request/token/time bounds are independent of that estimate.  Empty, invalid, failed, oversized, or out-of-scope output stops without a proposal.

## Activation Requires A Separate Approval

1. Review and merge this draft through the ordinary protected-branch process only after its normal checks pass.  This document does not authorize merging it.
2. Have an authorized maintainer create the GitHub Environment `kody-autofix-pilot`, restrict deployment branches to `main`, require a human reviewer, and prevent self-review where supported.  An in-file main guard alone cannot protect a repository secret against a modified workflow.
3. Provision `KODY_DEEPSEEK_API_KEY` only in that protected environment from the approved Infisical source.  Do not place that name at repository or organization scope.  BotFleet's application `DEEPSEEK_API_KEY` inventory is not evidence that an Actions secret exists.  Do not mint a PAT, expand an app grant, or copy credentials through chat.  Secret provisioning and any new persistent access require their own approval.
4. Configure an approved provider budget and enable `BOTFLEET_KODY_FIX_PILOT_ENABLED=true` using the authorized configuration process.  Infisical remains the source of truth; Actions contains the approved delivery copy.  Verify the environment restriction/reviewer/key and repository policy allowing `GITHUB_TOKEN` to create PRs before enabling the variable.
5. Coordinate with the original PR's editing owner using the approved fleet process.  Select a small source-only PR with fresh current-head Kody findings.  This change did not contact other editors or reserve shared coordination state.
6. On `main`, dispatch `Kody DeepSeek Fix Pilot` with the PR number, full reviewed head SHA, and the checkbox approving one paid attempt and transmission of the selected source/findings to DeepSeek.  Review the protected-environment approval before allowing it to proceed.
7. Inspect the resulting draft diff.  Approve its CI runs when GitHub requests it, then run the normal BotFleet gates, including `pnpm typecheck && pnpm test`.  This pilot itself never executes application tests with secrets present and does not claim generated fixes are tested.  Resolve findings only after a person verifies the actual correction.

GitHub documents that `GITHUB_TOKEN`-created PR events can create approval-required CI runs, while ordinary token pushes do not start new workflow runs.  No `actions:write`, PAT, workflow dispatch, or automated approval is added to work around that review step.

## Offline Verification

Run the dependency-free fixture suite:

```sh
node --test .github/autofix/kody-pilot.node-test.mjs
```

It covers admission, bot identity, current/original head and right-side findings, pagination, paths and file modes, binary/UTF-8 rejection, bounded literal edits, overlapping text, moved/resolved findings, branch races, create-only draft publication, tool restrictions, and a mock DeepSeek proxy.  The suite is also included in `pnpm test` through `pnpm test:kody-autofix`.

Validate workflow syntax with `actionlint .github/workflows/kody-autofix-pilot.yml`.  To check the real pinned Claude Code CLI with an in-memory synthetic provider response, install the official `@anthropic-ai/claude-code@2.1.289` package and run `node .github/autofix/claude-cli-fixture.mjs`.  That fixture uses a fake key and intercepts the upstream request in memory; it does not call DeepSeek or incur provider charges.

## Preparation Results

Passed in the isolated preparation checkout: all 19 pilot safety tests; the real Claude Code 2.1.289 synthetic-provider fixture; actionlint 1.7.12; `pnpm typecheck`; seven CI-scope tests; five lint-gate tests; and syntax checks for 94 Electron modules.  Targeted oxlint reported six boundary-validation warnings and zero errors.  The follow-up fixtures cover stable error logging, malformed branch refs, credential/quota failure handling, and temporary-home cleanup.

The full `pnpm test` attempt was incomplete: an outbound request to OpenRouter was blocked in the restricted executor, and no retry or alternate provider route was used.  Before it stopped, failures were observed in `server/index.test.ts` (one), `server/drivers/claude.test.ts` (eleven), and `companion/test/proxy.test.ts` (five).  Their causes were not established by a baseline comparison.  The preparation checkout also omitted heavy platform/media assets, so this is not a complete application or platform pass.  No live DeepSeek test was run.

These offline checks do not establish real DeepSeek compatibility, secret availability, protected-environment configuration, GitHub Actions admission, or successful application fixes.  The first live smoke test must be explicitly approved and remains an activation gate.

## References

- [Claude Code CLI flags](https://code.claude.com/docs/en/cli-reference)
- [DeepSeek Anthropic API compatibility](https://api-docs.deepseek.com/guides/anthropic_api/)
- [GitHub token-triggered workflow behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
