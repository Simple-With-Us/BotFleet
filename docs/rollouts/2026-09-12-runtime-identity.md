# Runtime Build Identity

Issue #265 / audit D2.  Worktree `codex/mac-rollout-20260912`.

The desktop previously attached to a proven data owner without knowing whether its API or static UI matched the installed app.  It now requests an authenticated runtime descriptor after the existing owner challenge succeeds.  An incompatible or unknown API refuses attachment; a compatible server with different source or static assets uses the installed app’s bundled UI through the existing shim.

`GET /api/runtime` requires the private data-owner nonce as a bearer on loopback.  The nonce is never returned, logged, or sent before the health challenge proves the recipient.  Public health remains minimal.  The companion route allowlist remains unchanged, so remote pairing grants no new diagnostic access.

The build writes `server/build-identity.json` in the app resources.  It contains package version, actual source commit, dirty-source flag, API contract version, and static-tree hash.  Source harnesses pin git identity at startup; a later checkout change cannot relabel a running process.  Static files are hashed at startup, so a matching source commit alone does not establish matching UI.  Desktop diagnostics log selected PID, port, commit, API and UI mode.

The authenticated response also includes data-owner PID/port and conservative active-work counts covering turns, completion cleanup, room operations, pending sends/delegations/resumes, computer lifecycle work, routines and provider reloads.  `safeToRestart` is a point-in-time idle check, not an admission lock; the updater must recheck immediately before shutdown.  The first update from legacy binaries needs the separate guarded adoption path in #319.

## Verification

- Seven focused Node regressions pass: private authentication, changed API, dirty/mismatched static files, pinned source identity, failed owner proof, legacy metadata, and refusal to spawn beside an incompatible live owner.
- Existing boot-probe regressions: 29 pass.
- Added readiness counter regressions and packaged-server smoke assertions for actual copied build identity, authentication, owner identity and redaction.
- `pnpm typecheck && pnpm test` passed: 3,512 Vitest tests, 19 skipped; broker 9/9; all chained Electron, packaged-server, configuration and workflow checks passed.  Independent read-only review found no blocker.  Hosted CI is required before merge.

## Deployment

No deployment is implied by this source change.  The owner explicitly authorized the Mac update; #319 stages dependencies and a signed bundle before any live shutdown, and #274 records the actual installation and runtime acceptance.
