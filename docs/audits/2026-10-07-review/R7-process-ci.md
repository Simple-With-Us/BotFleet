# R7: Engineering Process, CI and Repo Health

## Headline numbers

| Metric | Value |
|---|---|
| CI runs, 41 h window (Oct 5 6:21pm UTC to Oct 7 11:35am UTC) | 200: 98 success, 87 cancelled (43.5%), 15 failed |
| PR-event CI runs | 162: 76 success, 14 failed, 72 cancelled |
| Push-to-main CI runs | 36: 20 success, 1 failed, 15 cancelled |
| Wall-clock, push-to-main successes | median 26 min, p90 71 min, max 108 min |
| Wall-clock, PR successes | median 36 min, p90 154 min, max 603 min |
| Push-to-main since Oct 6 9:00am UTC | 8 of 8 green, median 18 min |
| One full CI run (#913), job times | ubuntu 16.8 min, macOS 17.8 min, Windows 14.7 min, package+smoke 6 min |
| Vitest | 534 files, 8,646 tests, 881.6 s serial; 96% of the test step |
| Merged PRs, Sep 27 to Oct 7 | 200 (about 20 a day); time-to-merge median 1.1 h, mean 7.9 h, p90 18.6 h |
| Open PRs | 13 (6 drafts); median age 2.4 days, max 6.5 days; no conflicts reported |
| Failing jobs across the 15 failed CI runs | Windows 10, macOS 7, Ubuntu 5, package+smoke 5, Swift 1 |
| Other workflows on main | Node CI 10 of 10 green (median 0.8 min); E2E smoke 10 of 10; Secret scanning 11 of 11 |
| Mac Commit Build on main | 8 success, 3 cancelled; median 7.6 min |

## Findings

### ENG-1 [P1] [NEW] A required check passes without working, and `strict` is false, so green does not mean main was verified
- Evidence:
  - `.github/workflows/ci.yml:235-260`: the required context "Swift tests + iOS build" runs on ubuntu with only `echo` steps when `ios_changed != 'true'` or the PR is docs-only.
  - Ruleset 21771270 has `strict_required_status_checks_policy: false` and no `merge_queue` rule (`gh api repos/Simple-With-Us/BotFleet/rulesets/21771270`).
  - Board rows 68d156d4 and 098d00c7 describe the same two defects.  I confirmed both against the workflow file and the ruleset.
  - The context name is "Swift tests + iOS build", not "Swift tests".
- Impact: A merge can land with a stale green from an older commit, and a server-only PR gets a green iOS check from an echo.  Flipping `strict` alone does not fix it, because the echo job also passes on the merge commit.
- Recommendation: Do not require the path-filter jobs by name.  Either make them real jobs or drop them from the required set and keep one aggregate "gate" job that fails if any scoped job that should have run did not.  Turn on strict or a merge queue (ENG-10).  (Effort: S for the aggregate job, M for the queue)

### ENG-2 [P2] [STILL-OPEN I5] The required "control-plane check + workerd tests + dry run" is a no-op
- Evidence:
  - `ci.yml:141-145` run `pnpm control-plane:check`, `:test` and `:dry-run`, which filter on `@botfleet/control-plane`.
  - `cloudflare/control-plane/` holds only `README.md`; the package was deleted in #657.
  - Running `pnpm --filter @botfleet/control-plane test` prints "No projects matched the filters" and exits 0 (observed `exit=0`).
  - `broker:check` for `cloudflare/composio-broker` is wired into no workflow (grep of `.github/` and `package.json`).
- Impact: A required context that can never fail, plus an untyped Cloudflare Worker.
- Recommendation: Point the job at `broker:check` and `broker:test`, or delete it and remove it from the ruleset.  (Effort: S)

### ENG-3 [P1] [STILL-OPEN I3] The serial test suite is the critical path, and PR wall-clock is dominated by queueing
- Evidence:
  - `vite.config.ts:22` sets `fileParallelism: false`.
  - The Ubuntu log shows `Tests 8637 passed | 9 skipped (8646)` and `Duration 881.56s`.  The step ran 15 min 14 s of a 25-min limit (`ci.yml:85`).
  - The 3-OS matrix is at `ci.yml:74-77`, so the 15-minute suite runs three times per PR, plus 6 min of packaging.
  - The prior audit measured 13.1 to 13.7 min.  It is now 14.7 min.  The timeout was raised to 25 min (partial fix), but the runtime grew and nothing was sharded.
- Impact: Median PR wall-clock is 36 min and p90 is 154 min.  Seats push repeatedly and 72 of 162 PR runs were cancelled.  Every cancellation wastes up to 17 min of runner time and delays the next verdict.
- Recommendation: Shard vitest with `--shard=i/3` on Ubuntu only.  Use `--changed` on PRs and run the full suite on post-merge and nightly.  I estimate about 6 min per shard from 881 s; that figure is not measured.  (Effort: M)

### ENG-4 [P2] [NEW] Push-to-main runs are silently superseded, so many main commits never get a verdict
- Evidence:
  - `ci.yml:16-17` uses `group: ci-${{ github.ref }}` with `cancel-in-progress` false on push.  GitHub keeps one running and one pending run per group and cancels the older pending one.
  - 15 of 36 push runs were cancelled in the window.  All 15 fall between Oct 5 6:00pm UTC and Oct 6 9:00am UTC, when 28 push runs gave 12 success, 15 cancelled and 1 failure.
  - After Oct 6 9:00am UTC, 8 of 8 are green.  The stall behind this was documented in board row 098d00c7.
- Impact: This was fixed by capacity relief (#885 moved fast-path jobs to ubuntu), not by design.  The same shape returns at the next macOS shortage.
- Recommendation: Give push runs a per-SHA group (`ci-${{ github.sha }}`), or use a merge queue.  (Effort: S)

### ENG-5 [P1] [STILL-OPEN A1, worsening] `server/index.ts` is the merge-conflict magnet
- Evidence:
  - `wc -l server/index.ts` gives 15,955 lines.  It was 7,834 on Sep 6, 13,725 on Sep 27 and 12,684 in the Sep 27 audit.  That is about 2x in a month.
  - 166 of 552 commits in 30 days (30%) touch it.  `server/index.test.ts` (9,134 lines) is touched by 57.
  - `server/routes/` holds two files (463 lines) and `index.ts` is still not importable by tests.
- Impact: With about 20 merges a day, two PRs touching the same 16k-line file collide constantly.  The file keeps growing, and the 4,888-line handler flagged in A1 is part of it.
- Recommendation: First add a line-count ratchet, the same trick as the lint baseline: fail any PR that grows `index.ts` past its checked-in size.  Then extract route groups into `server/routes/*` behind a table, with the five largest first.  (Effort: S for the ratchet, L for the split)

### ENG-6 [P1] [STILL-OPEN P4] `docs/EFFORT-LOG.md` is a shared hot file that has already lost data once
- Evidence:
  - It is 749,781 bytes in 1,150 lines (longest line 8,680 chars).  It was 6 KB on Sep 1, 284 KB on Sep 24 and 395 KB on Oct 1.
  - 255 of 552 commits in 30 days (46%) touch it, and 23 of the last 60 merged PRs.  33 commits touch only this file.
  - It is 1.4% of changed lines (4,740 of 349,748) but about 1.5 MB of added bytes after excluding the restore commit.
  - #846 ("707 Of 716 Rows Were Truncated On Main") restored a ledger that an append had truncated.  `.gitattributes:8` (`merge=union`) only landed in #850; its commit message says before that "every PR conflicted by hand".
  - Rows are also kept in the live log `/Users/jay/apps/BOTFLEET-EFFORT-LOG.md` and as board rows.  439 of the 704 open BotFleet board items are source kind `effort-row`.
- Impact: It is a conflict surface on nearly half of all commits, and the file is unreadable in one pass.  At roughly 4 chars per token it is about 187k tokens, which is my inference.  The integrity test now guards against loss but not against conflicts.  I could not verify whether GitHub's server-side merge honors `merge=union`.
- Recommendation: Stop appending to one file in the repo.  Use per-day or per-seat files (`docs/effort/YYYY-MM-DD-<seat>.md`; new files never conflict) and generate the index from the board.  (Effort: M)

### ENG-7 [P2] [STILL-OPEN I4, worse] The test-count floor guards 12% of the suite
- Evidence: `scripts/test-floor.mjs:29` has `TEST_COUNT_FLOOR = 1070`.  CI printed `test-floor: 8646 tests counted, floor is 1070`.  The prior audit measured 5,682 registered tests.
- Impact: Losing about 7,500 tests (87%) would still pass.  The floor's own comment says it was set against "1091 registered tests, 2026-08".
- Recommendation: Set the floor to about 95% of the current count, and add a check that fails when the registered count drops more than 5% from the base branch.  (Effort: S)

### ENG-8 [P2] [NEW] The lint baseline ratchets in only one direction, and it has been re-baselined upward three times
- Evidence:
  - `.oxlint-baseline.json` suppresses 4,890 violations across 28 rules.  Top rules are `require-safety-comment-for-type-assertion` at 1,557, `no-runtime-typeof` at 1,381 and `no-unknown-parameters` at 455.
  - History from `git log -- .oxlint-baseline.json`: 3,878 on Sep 27, then 4,654 (#789, Oct 2), 4,852 (#855, Oct 5), 4,890 (#895, Oct 6).
  - The PR gate (`scripts/lint-pr-gate.mjs`, `node-ci.yml:28-42`) landed Oct 5 (#878).  It stops new growth but accepts the current baseline, which is +26% in nine days.
- Impact: The debt is growing and the "ratchet" is a high-water mark.  Rule `no-runtime-typeof` has 1,381 hits, most likely noise rather than defects.
- Recommendation: Fix or disable the rules that flag correct code, so the baseline can shrink.  Add a per-rule target in the baseline file.  (Effort: M)

### ENG-9 [P2] [STILL-OPEN I9, widened] Four node-test suites run nowhere
- Evidence: `electron/single-instance.node-test.mjs`, `electron/cua-permissions-status.node-test.mjs`, `electron/native-version-probe.node-test.mjs` and `electron/renderer-trust.node-test.mjs` appear in no `package.json` script and no workflow.  The vitest include list (`vite.config.ts:10-18`) matches `*.test.mjs`, not `*.node-test.mjs`.  Two of them pass when run by hand (3 of 3 and 4 of 4).
- Impact: `renderer-trust` guards which Electron renderer may call IPC handlers.  It has no CI coverage and can rot.
- Recommendation: Add a `test:electron` script and chain it into `pnpm test`.  Add a lint that fails on any `*.node-test.*` file not referenced in `package.json`.  (Effort: S)

### ENG-10 [P2] [NEW] There is no merge queue, strict is off, and Windows and macOS legs fail often without telling us why
- Evidence:
  - Of the 15 failed CI runs, 9 failed on exactly one job: Windows only 5, macOS only 2, package+smoke only 2.  Windows is in 10 of the 15.
  - Open board flakes: 4616df22 (package+smoke) and 6697c929 (Windows `attached-ui-shim` test).
  - The ruleset requires all 8 contexts but has no `merge_queue` rule and `strict` is false.
- Impact: I cannot say from this data how many of those failures were real platform bugs and how many were flakes.  What is clear is that the three-OS matrix gates every PR on the slowest, most contended runners.
- Recommendation: Require Ubuntu for PRs.  Run macOS and Windows in a merge queue or post-merge, with an auto-filed board row on failure.  A merge queue should be available for a public org-owned repo, per GitHub's documented eligibility; I did not verify it here.  (Effort: M)

### ENG-11 [P2] [NEW] The local integration tree has diverged, with unpushed owner work under a tree that gets reset
- Evidence: In `/Users/jay/Code/BotFleet`, `git rev-list --left-right --count main...origin/main` gives `3 55`.  The three commits (`02ed8ad15`, `7661f360a`, `99d018ecd`) were made Oct 4 between 4:21am and 4:24am.  The merge base is `9c49b1d3e` (#734).  They touch 8 files (+44/−27).  Every one of those files has 2 to 6 upstream commits since the base.  Upstream already landed header drag-region work as `34afc8ed4` (#839).  `7661f360a`'s own message says it restores files "corrupted by previous commit".
- Impact: These commits will conflict and may duplicate #839.  Memory notes say a daemon resets this tree, which would destroy them.  I did not touch them.
- Recommendation: Push them to a branch from a worktree today, or confirm they are superseded by #839.  (Effort: S)

### ENG-12 [P2] [NEW] Seat attribution is lost in git and on GitHub
- Evidence: 540 of 552 commits in 30 days have author "Jay Wedgeworth".  All 166 commits touching `server/index.ts` do.  All 13 open PRs are authored by `jaywedgeworth22`.  Seats show only in branch prefixes and `Co-Authored-By` trailers.  Those trailers mix model names (Claude Fable 5.1, Opus 5.5, Sonnet 5) with seat names (Instinct, MM, Cursor).
- Impact: Per-seat revert rates, review routing and "who touched index.ts" cannot be computed reliably.  I could not count distinct seats on `index.ts`; the trailers give at least 10 identities.
- Recommendation: Require a `Seat:` trailer or a seat label on every PR, and have CI reject PRs without one.  (Effort: S)

### ENG-13 [P2] [NEW] The board backlog is mostly mirrored ledger rows
- Evidence: `board list --app botfleet --status open,in_progress --json` returns 704 items.  439 are `effort-row`, 179 `agent-report`, 70 `github-issue`, 16 `review-finding`.  254 are in progress, and 75 of those have not been updated in over 7 days.  503 have no severity.  Only 1 P0 is open and 5 P0 are in progress.
- Impact: A backlog of 704 hides the roughly 70 rows that carry a severity.  Stale in-progress rows look like claimed work and block peers.
- Recommendation: Stop mirroring effort rows into the board backlog.  Auto-release in-progress claims after 7 days without a comment.  (Effort: M)

### ENG-14 [P3] [STILL-OPEN I7] The Sentry reporters crowd the run list and still skip three workflows
- Evidence: Of the latest 300 runs on main, 238 (79%) are Sentry CI Report (161, 146 skipped) or Sentry Deploy (77, 64 skipped).  `sentry-ci-report.yml:73-80` watches CI, iOS ship, Package Ubuntu, Validate Desktop Packages, Release and Sentry Deploy.  It does not watch Node CI (the required `lint` job), E2E smoke or Secret scanning.
- Impact: `gh run list` is mostly noise, and a red lint or gitleaks run on main pages nobody.
- Recommendation: Add the three missing workflows.  Gate the reporter at the `workflow_run` trigger so skipped runs are never created.  (Effort: S)

### ENG-15 [P3] [STILL-OPEN I10 and I11] Floating action tags on the required `lint` job, and a stale diff base
- Evidence: `node-ci.yml:18,26` use `actions/checkout@v4` and `setup-node@v4`.  `e2e.yml:24,57,58,69,76` and `gitleaks.yml:16` do the same.  `ci.yml` pins SHAs.  `ci.yml:39` still diffs against `github.event.pull_request.base.sha`, as in I11.
- Impact: Supply-chain drift on a required check, and over-triggering of area jobs.
- Recommendation: Pin the SHAs, set `persist-credentials: false`, and diff the merge commit against its first parent.  (Effort: S)

### ENG-16 [P3] [NEW] AGENTS.md contradicts itself on iOS bundle IDs, and a PR body is committed at repo root
- Evidence:
  - `AGENTS.md:11` says `app.botfleet` became `app.botfleet.ios` and widgets became `app.botfleet.ios.widgets`.  `AGENTS.md:106-107` and `ios/project.yml:42,124` still say `app.botfleet` and `app.botfleet.widgets`.
  - `.pr-body.md` is a tracked file at repo root, added by #837.
  - At HEAD, AGENTS.md line 5 correctly names `Simple-With-Us/BotFleet` (fixed in `6de4b5d7d`).  The `jaywedgeworth22/BotFleet` text you were given came from the lagging session-injected copy.
- Impact: Agents reading line 11 will edit the wrong bundle ID.
- Recommendation: Fix line 11 and delete `.pr-body.md`.  (Effort: S)

## Ruled out or checked and fine
- Cron cost: there are only two crons.  `ci.yml:9` is weekly.  `ios-ship.yml:41` is every 30 min but gates early (about 0.5 min median).
- Dispatch-only workflows (`release.yml`, `package-linux.yml`, `package-win.yml`) cost nothing unless run.
- Dependencies are modest: 19 deps, 19 devDeps, 1,445 lockfile packages, 43 names with multiple majors.  `fs-extra` has 7 versions, `commander` 6 and `undici` 5, but this is not a hotspot.
- Time-to-merge is healthy at a 1.1 h median.  Revert or restore titles are rare: 5 of 200 (#886, #846, #812, #794, #731), and one literal revert.  I cannot attribute fix-ups to other seats from titles.  40% of commit titles (218 of 552) start with "fix".
- #884 and #879 are not stuck now.  Both merged Oct 6 around 5:20am UTC, about 10 h after opening, during the gate stall.
- Why 8 of the 13 open PRs show BLOCKED: I could not determine this.  Required checks or unresolved review threads are the likely causes.

## Fixed Since Prior Audits

| Prior id | What changed | Evidence |
|---|---|---|
| I2 (lint red on every main push) | Per-rule ratchet plus PR gate landed (#789, #878).  Node CI is 10 of 10 green on main. | `node-ci.yml:28-42` |
| I3 (timeout margin) | Timeout raised from 15 to 25 min. | `ci.yml:85` |
| I1 (iOS ship 120 of 120 red) | 72 more red runs on Oct 1 and 2, none since Oct 3, with 27 green runs. | `gh run list --workflow ios-ship.yml` |
| Gate stall (board 098d00c7) | 8 of 8 push runs green since Oct 6 9:00am UTC, after #885. | run list |
| P4 (effort log) | Ledger restored and integrity test added (#846).  Union merge attribute added (#850). | `.gitattributes:8` |
| AGENTS.md owner ref | Moved to the Simple-With-Us org (#837). | `AGENTS.md:5` |

## Course Corrections

1. **Make "green" mean something.**  Aggregate the scoped jobs into one required gate, delete the dead control-plane job, and require a verdict on the merge commit (queue or per-SHA run).  A main that is silently red stops being possible.  This is the cheapest high-value change (about two days).
2. **Stop running the full 3-OS serial suite per PR.**  Shard vitest on Ubuntu, run `--changed` on PRs, and push macOS and Windows to the merge queue or post-merge.  Estimated payoff: PR wall-clock from 36 min (p90 154 min) to about 10 min, and runner demand per PR from about 55 to about 20 runner-minutes.  Treat these as estimates to be measured after the change.
3. **Move the effort log out of the repo's hot path.**  Use per-day files or a board-generated index.  Payoff: a shared file leaves 46% of commits, the truncation class of bug disappears, and agents stop reading a 750 KB file.
4. **Freeze and split `server/index.ts`.**  A growth ratchet now, then route extraction.  Payoff: 30% of commits stop contending for one file, and tests can import the server.
5. **Cut ceremony per unit of work.**  AGENTS.md lines 36 to 38 ask for a claim on the board, the effort log, the GitHub issue and Slack, plus a mirror before every push.  Line 60 asks for a local `pnpm typecheck && pnpm test` that CI repeats three times.  Make the PR the claim, keep Slack for cross-seat handoffs, and run `typecheck` plus affected tests locally with CI as the authority.  I measured the cost only as commits that exist for the ledger: 33 effort-log-only commits and 56 docs-only commits out of 552 (16% together).  I did not measure seat time.

## Summary
- Top findings: ENG-1 (required Swift check is an echo and `strict` is false), ENG-3 (14.7 min serial suite run three times; PR p90 154 min), ENG-5 (`server/index.ts` is 15,955 lines, 30% of commits touch it).
- Also high-value: ENG-6 (the effort log is 750 KB, touched by 46% of commits, and lost 707 rows once).
- Count by severity: P0 0, P1 4, P2 9, P3 3 (16 findings).
- Tags: 7 STILL-OPEN (ENG-2, 3, 5, 6, 7, 9, 14, plus 15 as I10 and I11), 8 NEW.

Related paths:
- `/Users/jay/Code/BotFleet/.claude/worktrees/app-review-optimization-733c14/.github/workflows/ci.yml`
- `/Users/jay/Code/BotFleet/.claude/worktrees/app-review-optimization-733c14/.github/workflows/node-ci.yml`
- `/Users/jay/Code/BotFleet/.claude/worktrees/app-review-optimization-733c14/scripts/test-floor.mjs`
- `/Users/jay/Code/BotFleet/.claude/worktrees/app-review-optimization-733c14/.oxlint-baseline.json`
- `/Users/jay/Code/BotFleet/.claude/worktrees/app-review-optimization-733c14/docs/EFFORT-LOG.md`
- `/Users/jay/Code/BotFleet/.claude/worktrees/app-review-optimization-733c14/server/index.ts`
- `/Users/jay/Code/BotFleet/.claude/worktrees/app-review-optimization-733c14/AGENTS.md`
