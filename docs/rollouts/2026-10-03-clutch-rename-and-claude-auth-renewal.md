# 2026-10-03 — Clutch Naming Transition And Claude Auth Idle Renewal

Board row `7b365ba0ecb7449197f6f8e97ed1b42f`, branch `ag/clutch-rename-and-claude-auth`.  Owner directive: fix Claude frequently reporting signed out in BotFleet, and transition all product and engine references from Harness / DeepSeek Harness to Clutch.

## What Ships

### 1. Claude OAuth Idle Token Renewal And Flapping Prevention
- **Root Cause:** Claude Code stores an 8-hour access token alongside a ~28-day refresh token in macOS Keychain (`Claude Code-credentials`).  When idle past 8 hours, the access token expires.  Probing via `claude auth status --json` inspects only the access token and exits with code 1 (`{"loggedIn":false}`) without attempting refresh.  BotFleet's previous probing logic immediately recorded `lastKnownAuth.record(false)`, marking Claude signed out and causing session authentication flapping.
- **Silent Renewal:** Implemented `renewClaudeAuthToken()` in `server/drivers/claude.ts`.  When `claude auth status --json` exits non-zero and reports `loggedIn: false`, the driver silently runs a zero-token local command: `claude -p --settings '{"disableAllHooks":true}' --strict-mcp-config --no-session-persistence --output-format json "/usage"`.  This forces Claude Code to exchange its valid refresh token for a fresh 8-hour access token.
- **Safety And Throttling:** Added single-flight coalescing (`claudeRenewalInFlight`) and a 10-minute cooldown timer (`CLAUDE_RENEW_COOLDOWN_MS = 10 * 60 * 1000`) so repeated health checks cannot trigger token refresh storms.  If renewal succeeds, `claudeSignedIn()` re-checks status and cleanly records authenticated status.
- **Fake CLI Support:** Enhanced `server/testing/fake-claude-cli.ts` to handle the `-p ... "/usage"` probe cleanly without hanging on stdin.

### 2. Clutch Product And Engine Naming Transition
- **Web UI & Engine Capabilities:** Updated `src/lib/custom-engine.ts` (`DRIVER_DISPLAY_NAME` for `dshAgent`), `src/lib/engine-capabilities.tsx` (`DEEPSEEK_HARNESS_NOTE`, `ENGINE_CAPABILITIES["deepseek-harness"]` `displayName` to `"Clutch"`, and updated capability descriptions).
- **iOS Companion:** Updated `ios/App/ProviderMarkView.swift` and `ios/Sources/CompanionCore/Models.swift` to map `dsh` and `dshAgent` display names to `"Clutch"`.
- **Harness & Driver References:** Added `~/apps/clutch-runtime` to `knownDirs()` in `server/env-path.ts`.  Updated test assertions and documentation comments across `server/deepseek-balance.ts`, `server/drivers/acp/dsh.test.ts`, `server/index.ts`, `src/components/ApiKeys.tsx`, and `shared/model-lineage.ts`.
- **Distinct Internal Scope:** BotFleet's internal server harness (`server/harness/`, LaunchAgent `app.botfleet.server`) remains BotFleet's internal infrastructure and was preserved without modification.

## Files Touched

- `ios/App/ProviderMarkView.swift`: Displays `"Clutch"` mark for `dsh` / `dshAgent`.
- `ios/Sources/CompanionCore/Models.swift`: Maps `dsh` / `dshAgent` `settingsDisplayName` to `"Clutch"`.
- `server/deepseek-balance.ts`: Comment update referencing Clutch.
- `server/drivers/acp/dsh.test.ts`: Engine display name assertion updated to `"Clutch"`.
- `server/drivers/claude-auth.test.ts`: Added unit tests verifying token renewal on `loggedIn: false`, JSON output parsing, and cooldown throttling.
- `server/drivers/claude.ts`: Added `renewClaudeAuthToken()`, 10-minute cooldown, single-flight guard, and `resetClaudeRenewalThrottleForTesting()`.
- `server/env-path.ts`: Added `~/apps/clutch-runtime` to `knownDirs()`.
- `server/index.ts`: Comment cleanup.
- `server/testing/fake-claude-cli.ts`: Added handler for `-p ... "/usage"`.
- `shared/model-lineage.ts`: Updated comments.
- `src/components/ApiKeys.tsx`: Updated comments.
- `src/components/UsageSection.test.tsx`: Updated test descriptions to reference Clutch.
- `src/lib/custom-engine.test.ts`: Updated test assertion for `dshAgent` display name.
- `src/lib/custom-engine.ts`: Mapped `dshAgent` to `"Clutch"`.
- `src/lib/engine-capabilities.test.ts`: Updated test assertions for Clutch.
- `src/lib/engine-capabilities.tsx`: Updated engine note and display name for `deepseek-harness`.

## Verification

- `server/drivers/claude-auth.test.ts`: 9/9 tests pass (token renewal, payload parsing, failure handling, and throttling).
- `server/drivers/claude.test.ts`: 101/101 tests pass, 1 skipped.
- `src/lib/custom-engine.test.ts`: 19/19 tests pass.
- `src/lib/engine-capabilities.test.ts`: 27/27 tests pass.
- `server/drivers/acp/dsh.test.ts`: 74/74 tests pass.
- `cd ios && swift test`: 477/477 tests pass, 0 failures.
- `pnpm typecheck`: Clean across client and server.
- `git diff --check`: Clean, 0 whitespace warnings.
