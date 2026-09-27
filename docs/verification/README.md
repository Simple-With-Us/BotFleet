# Verifying BotFleet

Every claim of "it works" points at a recipe that proves it in an isolated fixture.  This document catalogs the verification recipes and their evidence.  Never verify against live user data.

## Launch

Start a fixture in the repository. The packaged server comes with its own runtime dependencies:

```sh
pnpm typecheck && pnpm test
```

Run the complete suite to verify the build is healthy. For targeted recipes, run individual test files or the smoke scripts.

## Drive

Verification uses these isolated fixtures:

- [Chat UI](chat-ui.md) — driven headlessly through the real renderer
- [Routines and webhooks](routines.md) — scheduled task execution and webhook delivery
- [Approvals and the permission broker](approvals.md) — access control and approval workflows
- [iOS companion pairing and stream resume](ios-companion.md) — device pairing and message stream recovery
- [Packaged server smoke test](packaged-server.md) — server start-up and module resolution
- [Model fallback on quota chips](quota-fallback.md) — provider failover when quota is exhausted
- [Mac updater transaction](mac-updater.md) — signed update delivery and application
- [Connector grants](connector-grants.md) — per-bot third-party tool authorization

### Test Fixtures

Many recipes are codified as unit tests or integration tests:

- **Chat UI:** See `src/` for component tests and accessibility verification.
- **Routines:** `server/routines.test.ts` covers execution and scheduling.
- **Approvals:** `server/delegations.test.ts` covers approval chains.
- **iOS:** `ios/BotFleetTests/` contains Xcode UI and integration tests.
- **Packaged server:** `scripts/smoke-packaged-server.mjs` proves the built server starts without repo node_modules.
- **Quota fallback:** `server/turn-tools.test.ts` exercises provider failover.
- **Mac updater:** `scripts/mac-update-transaction.node-test.mjs` simulates signed update delivery.
- **Connector grants:** `server/mcp-server.test.ts` and integration fixtures verify tool authorization per bot.

## Evidence

Every recipe records:

1. **The command:** Exact commands to reproduce the test
2. **Expected output:** What a passing run looks like
3. **Logs:** Server logs and test output paths
4. **Screenshots or snapshots:** For UI verification

Keep all evidence with the test run so a reviewer can spot-check any claim.

## Cleanup

After a test completes, temporary data directories are removed. Server logs remain at the printed path.  Interrupt long-running fixtures with Ctrl-C; the launcher stops its child before cleanup.

## What This Proves And What It Does Not

Each recipe proves a specific user workflow in isolation—never against live data, never in the running app on port 8799, never with the user's real bots or threads.

**Not proven** by this document alone: End-to-end flows across multiple clients, device pairing outside a simulator, settings sync across mobile platforms, and features gated behind feature flags or beta availability.  Use the relevant smoke test and state that limitation.

For UI changes affecting Settings, sidebar, the VM modal, the built-in browser panel, or updater UI, verify through code review and the CI renderer suite (`pnpm test:ci-scope`).  Live screenshots are not required in the PR body.

## Running Verification Before Landing

Before pushing a branch or creating a PR:

```sh
pnpm typecheck
pnpm test
cd ios && swift test
```

If iOS files changed, also run:

```sh
xcodebuild -scheme BotFleet -destination 'platform=iOS Simulator,name=iPhone 15' test
```

The hosted CI suite runs the complete gate plus optional smoke tests.  Documentation-only changes skip typecheck and tests via the fast path in `.github/workflows/ci.yml`.
